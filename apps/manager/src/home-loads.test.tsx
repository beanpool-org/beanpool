import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from './App';

/**
 * Settings' Home on a real community, as the owner reaches it from the phone's "Needs you" (Marty, 19 Oct, Mullumbimby on
 * 1.2.28): the page signs in with the phone's one-time link, then reads the node's diagnostics and its data. Home must
 * show each figure the node gave, or say it couldn't load: never a 0 for a figure that didn't arrive.
 */

const DATA = '/api/local/admin/data';
const DIAGNOSTICS = '/api/local/admin/diagnostics';

/** A community of 34 members and one enterprise, as /api/local/admin/data answers it. */
function communityData(): Record<string, unknown> {
    const members = Array.from({ length: 34 }, (_, i) => ({ publicKey: `${String(i).padStart(2, '0')}`.repeat(32), callsign: `m${i}`, isTreasury: false }));
    members.push({ publicKey: 'ee'.repeat(32), callsign: 'Bakery', isTreasury: true });
    return {
        members, profiles: [], posts: [], health: { flags: [] }, reports: [], reportCount: 0, escrowDisputesCount: 0,
        memberStats: {}, tradeTotals: { deals: 12, volume: 340.5, cancelled: 1 }, commonsBalance: 87.25,
    };
}

function diagnostics(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        success: true, status: 'online', uptimeSeconds: 100, cpuLoadPercent: 1, memoryUsageMb: 100, totalMemoryMb: 1000,
        dbSizeBytes: 1024, walSizeBytes: 0, activeWsConnections: 3, p2pActivePeers: 0, userCount: 35,
        communityName: 'Mullumbimby', callsign: null, shutdownStatus: null, standbyHealth: null, offboxBackups: null,
        serverAlerts: { count: 0, items: [] }, ...extra,
    };
}

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) });
const refused = (status: number, body: unknown) => Promise.resolve({ ok: false, status, statusText: status === 401 ? 'Unauthorized' : 'Error', json: () => Promise.resolve(body) });
const NOT_SIGNED_IN = { error: 'Not signed in: no admin session or password was sent', sessionExpired: true, notSignedIn: true };

interface NodeStub {
    signedIn: boolean;
    /** What /admin/data answers once signed in. */
    data: () => Promise<unknown>;
    diag: () => Promise<unknown>;
    /** Requests made before the sign-in finished, held until the test lets them answer. */
    held: Array<() => void>;
    hold: boolean;
}

function stubNode(node: NodeStub) {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes('/api/local/admin/auth/exchange')) {
            // Signed in when the node's answer arrives, not when the request leaves: what the page asks meanwhile has no cookie.
            return Promise.resolve().then(() => {
                node.signedIn = true;
                return ok({ success: true, role: 'owner', memberPubkey: 'ab'.repeat(32), csrfToken: 'csrf-link' });
            });
        }
        if (u.includes('/api/local/admin/auth/session')) return ok({ authenticated: false });
        if (!node.signedIn && u.includes('/api/local/admin/')) {
            // An admin request with no session yet: refused at once, or held open as a slow phone connection holds it.
            if (!node.hold) return refused(401, NOT_SIGNED_IN);
            return new Promise((resolve) => { node.held.push(() => resolve(refused(401, NOT_SIGNED_IN) as never)); });
        }
        if (u.includes(DATA)) return node.data();
        if (u.includes(DIAGNOSTICS)) return node.diag();
        return ok({ success: true, health: { flags: [] }, reports: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

async function openFromPhone() {
    window.history.replaceState(null, '', `/settings#handoff=${'d'.repeat(64)}&section=home&from=app`);
    await act(async () => {
        render(<App isFleetMode={false} />);
    });
}

const card = (name: RegExp) => screen.getByRole('button', { name });

describe('Settings Home after the phone link: real figures, or "couldn\'t load", never 0', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
    });

    it('a request made before the phone link signed in, still in flight when it did, never leaves Home on zeros', async () => {
        const node: NodeStub = { signedIn: false, data: () => ok(communityData()), diag: () => ok(diagnostics()), held: [], hold: true };
        const fetchMock = stubNode(node);
        await openFromPhone();
        // Nothing is asked of the node before the sign-in has its session (origin/main asked for everything on mount).
        const askedBeforeSignIn = node.held.length;
        // The refusals of anything asked before the sign-in land only now.
        await act(async () => {
            node.held.splice(0).forEach((answer) => answer());
        });
        expect(askedBeforeSignIn).toBe(0);
        await waitFor(() => expect(card(/Members/)).toHaveTextContent('34'));
        expect(card(/Members/)).not.toHaveTextContent(/^Members👥0/);
        expect(card(/Shared Enterprises/)).toHaveTextContent('1');
        expect(card(/Circulation/)).toHaveTextContent('340.5');
        expect(card(/Commons Pool/)).toHaveTextContent('87.3');
        // Still signed in: a refusal of a request asked before the sign-in is no session ending.
        expect(screen.queryByPlaceholderText('Password')).toBeNull();
        void fetchMock;
    });

    it('a data load that fails says so on each figure, with a retry that loads the real ones; never 0', async () => {
        let fail = true;
        const node: NodeStub = {
            signedIn: false, hold: false, held: [],
            data: () => (fail ? refused(500, { error: 'boom' }) : ok(communityData())),
            diag: () => ok(diagnostics()),
        };
        stubNode(node);
        await openFromPhone();
        await waitFor(() => expect(screen.getAllByText(/couldn.t load/i).length).toBeGreaterThan(0));
        for (const id of ['members', 'pool', 'enterprises', 'circulation']) {
            const c = screen.getByTestId(`home-figure-${id}`);
            expect(c).toHaveTextContent(/couldn.t load/i);
            expect(c).not.toHaveTextContent(/\b0(\.0)?\b/);
        }
        // Nothing is all clear while the reports and disputes are unknown.
        expect(screen.queryByText(/All clear/)).toBeNull();
        fail = false;
        await act(async () => {
            fireEvent.click(screen.getAllByRole('button', { name: /retry/i })[0]);
        });
        await waitFor(() => expect(card(/Members/)).toHaveTextContent('34'));
        expect(screen.queryAllByText(/couldn.t load/i)).toHaveLength(0);
        expect(screen.getByText(/All clear/)).toBeInTheDocument();
    });

    it('a refused data load (403) says it could not load, not 0 members', async () => {
        const node: NodeStub = {
            signedIn: false, hold: false, held: [],
            data: () => refused(403, { error: 'Only an owner or an admin of this node can do this' }),
            diag: () => ok(diagnostics()),
        };
        stubNode(node);
        await openFromPhone();
        const members = await screen.findByTestId('home-figure-members');
        await waitFor(() => expect(members).toHaveTextContent(/couldn.t load/i));
        expect(members).not.toHaveTextContent(/\b0\b/);
    });

    it("diagnostics that fail leave the connections unknown, not 0, and nothing all clear", async () => {
        const node: NodeStub = {
            signedIn: false, hold: false, held: [],
            data: () => ok(communityData()),
            diag: () => refused(500, { error: 'boom' }),
        };
        stubNode(node);
        await openFromPhone();
        await waitFor(() => expect(card(/Members/)).toHaveTextContent('34'));
        await waitFor(() => expect(screen.getByTestId('home-connections')).toHaveTextContent(/couldn.t load/i));
        expect(screen.queryByText(/0 active connections/)).toBeNull();
        expect(screen.queryByText(/All clear/)).toBeNull();
    });

    it('Retry connections asks for the diagnostics again, and not for the full data (a logged look at names)', async () => {
        let diagFails = true;
        const node: NodeStub = {
            signedIn: false, hold: false, held: [],
            data: () => ok(communityData()),
            diag: () => (diagFails ? refused(500, { error: 'boom' }) : ok(diagnostics())),
        };
        const fetchMock = stubNode(node);
        await openFromPhone();
        await waitFor(() => expect(card(/Members/)).toHaveTextContent('34'));
        await waitFor(() => expect(screen.getByTestId('home-connections')).toHaveTextContent(/couldn.t load/i));
        const asked = (path: string) => fetchMock.mock.calls.filter(([u]) => String(u).includes(path)).length;
        const dataReads = asked(DATA);
        const diagReads = asked(DIAGNOSTICS);
        diagFails = false;
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Retry connections' }));
        });
        await waitFor(() => expect(screen.getByTestId('home-connections')).toHaveTextContent('3 active connections'));
        expect(asked(DIAGNOSTICS)).toBeGreaterThan(diagReads);
        expect(asked(DATA)).toBe(dataReads);
        expect(asked('/api/local/admin/alerts-summary')).toBe(0);
    });

    it("the server's alerts the phone counts are listed in Action Required, each linking to the Alerts card", async () => {
        const items = [{ key: 'backups.none', title: 'backups stay on this server', priority: 2, since: Date.now() - 3_600_000, detail: 'Backups stay on this server: no destination and no recovery code.' }];
        const node: NodeStub = {
            signedIn: false, hold: false, held: [],
            data: () => ok(communityData()),
            diag: () => ok(diagnostics({ serverAlerts: { count: 1, items } })),
        };
        stubNode(node);
        await openFromPhone();
        const panel = await screen.findByTestId('home-action-required');
        await waitFor(() => expect(within(panel).getByText(items[0].detail)).toBeInTheDocument());
        expect(within(panel).queryByText(/All clear/)).toBeNull();
        await act(async () => {
            fireEvent.click(within(panel).getByRole('button', { name: new RegExp(items[0].detail.slice(0, 20)) }));
        });
        // The Alerts card, where the alert is listed and marked seen.
        expect(await screen.findByTestId('server-alerts')).toBeInTheDocument();
    });
});
