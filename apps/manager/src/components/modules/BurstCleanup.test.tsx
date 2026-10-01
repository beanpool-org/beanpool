import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BurstDigestCard, BurstPanel } from './BurstCleanup';
import { ModeratorView } from './ModeratorView';
import { PeopleSafetySection } from './PeopleSafetySection';
import { setKeySessionCsrfToken } from '../../lib/node-client';

/**
 * Clean-up by burst (server: engine/burst-cleanup.ts, test-burst-cleanup.ts). The screen's half of the guard: each
 * account's standing shown, established accounts and role holders left out to start with, the count and standing said
 * again before anything happens, a removal only once the number is typed, and exactly the ticked accounts sent.
 */

const ANCHOR = 'a1'.repeat(32), NEW2 = 'b2'.repeat(32), NEW3 = 'c3'.repeat(32), OLD = 'd4'.repeat(32), MOD = 'e5'.repeat(32);

const account = (publicKey: string, callsign: string, standing: number, extra: Record<string, unknown> = {}) => ({
    publicKey, callsign, joinedAt: '2026-10-01T10:00:00Z', status: 'active', standing,
    standingParts: { weeks: 0, keptPosts: standing, dealPartners: 0 }, established: standing >= 4, postsUp: 1, postsHidden: 0,
    openReports: 0, holdsRole: false, ...extra,
});

const BURST = {
    success: true,
    account: account(ANCHOR, 'Spammy', 1, { openReports: 2 }),
    joinedThroughDoor: true,
    others: [account(NEW2, 'Newt', 0), account(NEW3, 'Nell', 2), account(OLD, 'Olga', 6), account(MOD, 'Mona', 5, { holdsRole: true })],
    count: 4,
    removedAlready: 1,
    establishedStanding: 4,
};

const DIGEST = {
    success: true,
    bursts: [{ accounts: 6, stillHere: 5, removed: 1, reported: 1, postsHidden: 0, firstJoinAt: '2026-10-01T10:00:00Z', lastJoinAt: '2026-10-01T12:00:00Z', open: { publicKey: ANCHOR, callsign: 'Spammy' } }],
    actions: [
        { id: 'act-hide', kind: 'hide', at: '2026-10-01T13:00:00Z', by: 'moderator', accounts: 3, posts: 4, undoneAt: null, account: { publicKey: ANCHOR, callsign: 'Spammy' } },
        { id: 'act-rm', kind: 'remove', at: '2026-10-01T12:30:00Z', by: 'admin', accounts: 1, posts: 0, undoneAt: null, account: null },
    ],
    minAccounts: 5,
    days: 7,
};

type Call = { url: string; method: string; body: any };
let calls: Call[];

function reply(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body, headers: new Headers() } as unknown as Response;
}

function mockNode(opts: { digest?: number } = {}) {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || 'GET').toUpperCase();
        let body: any = undefined;
        try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { /* not json */ }
        calls.push({ url, method, body });
        const path = new URL(url, 'http://x').pathname;
        if (path.endsWith('/api/local/admin/bursts')) return opts.digest && opts.digest !== 200 ? reply(opts.digest, { error: 'Not Found' }) : reply(200, DIGEST);
        if (path.endsWith('/burst') && method === 'GET') return reply(200, BURST);
        if (path.endsWith('/burst/hide')) return reply(200, { success: true, action: { id: 'new', kind: 'hide', accounts: body.count, posts: body.count } });
        if (path.endsWith('/burst/remove')) return reply(200, { success: true, removed: body.count, failed: [] });
        if (path.endsWith('/undo')) return reply(200, { success: true, restored: 3, keptHidden: 1 });
        if (path.endsWith('/api/local/admin/reports')) {
            return reply(200, { success: true, reports: [{ id: 'r1', reason: 'Spam', outcome: 'open', targetPubkey: ANCHOR, postId: 'p1', postTitle: 'Cheap watches', postAuthorCallsign: 'Spammy', postRemoved: false }], total: 1, pendingCount: 1 });
        }
        return reply(403, { error: 'Moderators can review reports and remove reported posts only', moderator: true });
    }));
}

beforeEach(() => { setKeySessionCsrfToken(null); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const sent = (suffix: string) => calls.filter(c => c.method === 'POST' && new URL(c.url, 'http://x').pathname.endsWith(suffix));

async function openPanel(canRemove: boolean) {
    mockNode();
    await act(async () => {
        render(<BurstPanel nodeUrl="https://global.example" anchor={ANCHOR} canRemove={canRemove} onClose={() => {}} />);
    });
    await waitFor(() => expect(screen.getAllByTestId('burst-account')).toHaveLength(5));
    return screen.getAllByTestId('burst-account');
}
const box = (row: HTMLElement) => within(row).getByRole('checkbox') as HTMLInputElement;

describe('BurstPanel', () => {
    it('shows each account with its standing, and leaves the established and role holders out to start with', async () => {
        const [anchor, newt, nell, olga, mona] = await openPanel(false);
        expect(screen.getByRole('heading', { name: /Joined from the same connection within a day as Spammy/ })).toBeInTheDocument();
        expect(screen.getByText(/4 accounts joined from the same connection within a day as Spammy\. 1 more was removed already/)).toBeInTheDocument();
        expect(within(nell).getByText(/standing 2 \(0 weeks, 2 kept posts, 0 deals\)/)).toBeInTheDocument();
        expect(within(anchor).getByText(/2 open reports/)).toBeInTheDocument();
        expect([anchor, newt, nell].map(r => box(r).checked)).toEqual([true, true, true]);
        expect(box(olga).checked).toBe(false);
        expect(within(olga).getByText(/Established/)).toBeInTheDocument();
        expect(box(mona).checked).toBe(false);
        expect(box(mona).disabled).toBe(true);
        expect(screen.getByTestId('burst-summary')).toHaveTextContent('3 accounts ticked, standing 0 to 2.');
        // Nothing about the connection itself, only that they shared one.
        expect(document.body.textContent).not.toMatch(/\b(IP|address|cohort|label|hash)\b/i);
    });

    it('a moderator hides their posts: the count and standing said again, exactly the ticked accounts sent, no removal offered', async () => {
        await openPanel(false);
        expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Hide their posts' }));
        expect(screen.getByTestId('burst-confirm')).toHaveTextContent('Hide every post of 3 accounts, standing 0 to 2?');
        expect(sent('/burst/hide')).toHaveLength(0);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Hide the posts of 3 accounts' })); });
        const [hide] = sent('/burst/hide');
        expect(hide.body).toEqual({ members: [ANCHOR, NEW2, NEW3], count: 3 });
        expect(hide.url).toContain(`/members/${ANCHOR}/burst/hide`);
        expect(await screen.findByText(/Hid 3 posts of 3 accounts/)).toBeInTheDocument();
    });

    it('ticking an established account says so, and only then tells the node', async () => {
        const [, , , olga] = await openPanel(false);
        fireEvent.click(box(olga));
        expect(screen.getByTestId('burst-summary')).toHaveTextContent('4 accounts ticked, standing 0 to 6, 1 established.');
        fireEvent.click(screen.getByRole('button', { name: 'Hide their posts' }));
        expect(screen.getByTestId('burst-confirm')).toHaveTextContent('One is established: Olga (6).');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Hide the posts of 4 accounts' })); });
        expect(sent('/burst/hide')[0].body).toEqual({ members: [ANCHOR, NEW2, NEW3, OLD], count: 4, includeEstablished: true });
    });

    it('an owner or admin removes them only after typing how many', async () => {
        const [, newt] = await openPanel(true);
        fireEvent.click(box(newt));
        fireEvent.click(screen.getByRole('button', { name: 'Remove them' }));
        expect(screen.getByTestId('burst-confirm')).toHaveTextContent('Remove 2 accounts, standing 1 to 2, for good?');
        const go = screen.getByRole('button', { name: 'Remove 2 accounts' });
        expect(go).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/Type 2 to confirm/), { target: { value: '3' } });
        expect(go).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/Type 2 to confirm/), { target: { value: '2' } });
        await act(async () => { fireEvent.click(go); });
        expect(sent('/burst/remove')[0].body).toEqual({ members: [ANCHOR, NEW3], count: 2 });
    });
});

describe('BurstDigestCard', () => {
    it('shows nothing where the node has no bursts (a local community answers 404)', async () => {
        mockNode({ digest: 404 });
        const seen: boolean[] = [];
        await act(async () => {
            render(<BurstDigestCard nodeUrl="https://local.example" onOpen={() => {}} onAvailability={(a) => seen.push(a)} />);
        });
        await waitFor(() => expect(seen).toEqual([false]));
        expect(screen.queryByTestId('burst-digest')).toBeNull();
    });

    it('lists each burst and each action, opens a burst, and undoes a hide', async () => {
        mockNode();
        const opened: string[] = [];
        await act(async () => {
            render(<BurstDigestCard nodeUrl="https://global.example" onOpen={(pk) => opened.push(pk)} />);
        });
        const line = await screen.findByTestId('burst-line');
        expect(line).toHaveTextContent('6 accounts joined from the same connection within a day');
        expect(line).toHaveTextContent('1 reported.');
        fireEvent.click(within(line).getByRole('button', { name: 'See them' }));
        expect(opened).toEqual([ANCHOR]);
        const [hide, removal] = screen.getAllByTestId('burst-action');
        expect(hide).toHaveTextContent('Hid 4 posts of 3 accounts that joined with Spammy, by a moderator');
        expect(within(removal).queryByRole('button', { name: 'Undo' })).toBeNull();
        await act(async () => { fireEvent.click(within(hide).getByRole('button', { name: 'Undo' })); });
        expect(sent('/bursts/act-hide/undo')).toHaveLength(1);
        expect(await screen.findByText(/3 posts back\. 1 post stays hidden/)).toBeInTheDocument();
    });
});

describe('ModeratorView with bursts', () => {
    it('on the global community a report offers the accounts that joined with its author, to hide and never to remove', async () => {
        mockNode();
        await act(async () => {
            render(<ModeratorView nodeUrl="https://global.example" communityName="Global" onLogout={() => {}} />);
        });
        const card = await screen.findByTestId('moderator-report');
        await act(async () => { fireEvent.click(await within(card).findByRole('button', { name: 'Who joined with them' })); });
        await waitFor(() => expect(screen.getAllByTestId('burst-account')).toHaveLength(5));
        expect(screen.getByRole('button', { name: 'Hide their posts' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Remove them' })).toBeNull();
    });

    it('on a local community it offers nothing of it', async () => {
        mockNode({ digest: 404 });
        await act(async () => {
            render(<ModeratorView nodeUrl="https://mullum.example" communityName="Mullum" onLogout={() => {}} />);
        });
        const card = await screen.findByTestId('moderator-report');
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(within(card).queryByRole('button', { name: 'Who joined with them' })).toBeNull();
        expect(screen.queryByTestId('burst-digest')).toBeNull();
    });
});

describe('Triage & Moderation (owners and admins) with bursts', () => {
    const triage = (invitedBy: string) => render(
        <PeopleSafetySection
            activeNode={{ id: 'global', name: 'Global', url: 'https://global.example', adminPassword: 'pw' }}
            nodeData={{
                reports: [{ id: 'r1', targetPubkey: ANCHOR, reason: 'Spam', status: 'pending', outcome: 'open' }],
                members: [{ publicKey: ANCHOR, callsign: 'Spammy', invitedBy, nodeRole: null }],
            }}
            nodeDataLoading={false}
            onRefresh={vi.fn()}
            onFreezeUser={vi.fn()}
            onPruneUser={vi.fn()}
            onUpdateTier={vi.fn()}
            onToggleVoucher={vi.fn()}
            onToggleOperator={vi.fn()}
            initialSubTab="moderation"
        />,
    );

    it('where members joined through the open door, it lists bursts and opens one with removal offered', async () => {
        mockNode();
        await act(async () => { triage('open:google'); });
        expect(await screen.findByTestId('burst-digest')).toBeInTheDocument();
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Who joined with them' })); });
        await waitFor(() => expect(screen.getAllByTestId('burst-account')).toHaveLength(5));
        expect(screen.getByRole('button', { name: 'Remove them' })).toBeInTheDocument();
        const digest = calls.find(c => c.url.endsWith('/api/local/admin/bursts'));
        expect(digest).toBeTruthy();
    });

    it('on a community nobody joined through the door, it asks the node nothing about bursts', async () => {
        mockNode();
        await act(async () => { triage('a'.repeat(64)); });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(calls.some(c => c.url.includes('burst'))).toBe(false);
        expect(screen.queryByRole('button', { name: 'Who joined with them' })).toBeNull();
    });
});
