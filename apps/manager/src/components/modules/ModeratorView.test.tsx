import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../../App';
import { ModeratorView } from './ModeratorView';
import { sectionTargetFor } from '../../lib/key-session';
import { setKeySessionCsrfToken } from '../../lib/node-client';

/**
 * A moderator's Settings: Reports and nothing else (Marty's decision, 2026-09-19).
 * The node refuses their session everywhere else (server: test-moderator-routes.ts); this checks the screen offers
 * only what that session can do, that no link reaches anything else, and that the manual is theirs.
 */

const MOD = 'cd'.repeat(32);
const TOKEN = 'a'.repeat(64);

const REPORTS = [
    {
        id: 'r-post', reason: 'Selling something dodgy', createdAt: '2026-09-19T10:00:00Z', outcome: 'open',
        reporterCallsign: 'Rita', postId: 'p1', postTitle: 'Cheap phones', postDescription: 'No questions asked',
        postAuthorCallsign: 'Oscar', postRemoved: false, pulseItem: null,
    },
    {
        id: 'r-pulse', reason: 'Spam channel', createdAt: '2026-09-19T11:00:00Z', outcome: 'open',
        reporterCallsign: 'Rita', postId: null, pulseItem: { title: 'Buy now', platform: 'youtube', url: 'https://example.com/v', removed: false },
    },
    {
        id: 'r-member', reason: 'Rude in chat', createdAt: '2026-09-19T12:00:00Z', outcome: 'open',
        reporterCallsign: 'Rita', targetCallsign: 'Oscar', postId: null, pulseItem: null,
    },
];

type Call = { url: string; method: string; body: any };
let calls: Call[];

function reply(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers() } as unknown as Response;
}

function mockNode(opts: { role?: 'moderator' | 'admin' } = {}) {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || 'GET').toUpperCase();
        let body: any = undefined;
        try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { /* not json */ }
        calls.push({ url, method, body });
        if (url.includes('/api/local/admin/auth/exchange')) {
            return reply(200, { success: true, memberPubkey: MOD, role: opts.role ?? 'moderator', csrfToken: 'csrf-mod' });
        }
        if (url.includes('/api/local/community-info')) return reply(200, { communityName: 'Mullum' });
        if (url.includes('/api/local/admin/reports?')) {
            const status = new URL(url, 'http://x').searchParams.get('status');
            const list = status === 'open' || status === 'all' ? REPORTS : [];
            return reply(200, { success: true, reports: list, total: list.length, pendingCount: REPORTS.length });
        }
        if (/\/api\/local\/admin\/reports\/[^/]+\/(action|dismiss)/.test(url)) return reply(200, { success: true });
        // Anything else a moderator's screen asked for would be refused by the node.
        return reply(403, { error: 'Moderators can review reports and remove reported posts only', moderator: true });
    }));
}

function setHash(hash: string) {
    window.history.replaceState(null, '', `/settings${hash}`);
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setKeySessionCsrfToken(null);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setHash('');
});

async function renderAppAs(hash: string, role: 'moderator' | 'admin' = 'moderator') {
    mockNode({ role });
    setHash(hash);
    await act(async () => { render(<App isFleetMode={false} />); });
    if (role === 'moderator') await screen.findByTestId('moderator-view');
}

describe('moderator Settings (App)', () => {
    it('signed in as a moderator, Settings shows only Reports, and the top bar says Moderator', async () => {
        await renderAppAs(`#handoff=${TOKEN}`);
        expect(screen.getByText('Moderator')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1, name: /Reports/ })).toBeInTheDocument();
        await waitFor(() => expect(screen.getAllByTestId('moderator-report')).toHaveLength(3));

        // No other section, sub-tab or menu exists — not disabled, absent.
        for (const name of [/home/i, /people & safety/i, /shared projects & economy/i, /bulletin & news/i, /appliance & data/i, /^menu$/i,
            /members/i, /invites/i, /owners & admins/i, /backups/i, /escrow disputes/i, /announcements/i]) {
            expect(screen.queryByRole('button', { name })).toBeNull();
        }
        expect(screen.queryByText(/Prune Stale Posts/i)).toBeNull();
        expect(screen.queryByText(/Action Required/i)).toBeNull();

        // Once signed in, it never asks the node for anything but the reports. (The page's first polls go out as it
        // loads, before the sign-in finishes, with no session at all, as they do for everyone; the node refuses them.)
        const signedInAt = calls.length;
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
        await act(async () => { await new Promise(r => setTimeout(r, 50)); });
        const asked = calls.slice(signedInAt).map(c => new URL(c.url, 'http://x').pathname);
        expect(asked).toContain('/api/local/admin/reports');
        const outside = asked.filter(p => !['/api/local/admin/auth/exchange', '/api/local/community-info', '/api/local/admin/reports'].includes(p));
        expect(outside).toEqual([]);
    });

    it.each(['disputes', 'decisions', 'home', 'moderation'])('a link to section=%s lands on Reports', async (section) => {
        localStorage.setItem('bp_settings_active_tab', 'appliance');
        await renderAppAs(`#handoff=${TOKEN}&section=${section}`);
        expect(screen.getByRole('heading', { level: 1, name: /Reports/ })).toBeInTheDocument();
        expect(screen.queryByText(/Escrow Disputes/i)).toBeNull();
        expect(screen.queryByText(/Backups & Restore/i)).toBeNull();
    });

    it('an admin still gets the full Settings (the moderator view is for moderators only)', async () => {
        await renderAppAs(`#handoff=${TOKEN}`, 'admin');
        await waitFor(() => expect(screen.getAllByRole('button', { name: /people & safety/i }).length).toBeGreaterThan(0));
        expect(screen.queryByTestId('moderator-view')).toBeNull();
    });

    it('the Manual shows the moderator pages only', async () => {
        await renderAppAs(`#handoff=${TOKEN}`);
        fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
        const dialog = await screen.findByRole('dialog', { name: 'Operator manual' });
        const titles = within(dialog).getAllByRole('button').map(b => b.textContent || '');
        expect(titles.some(t => /Reports and takedowns/i.test(t))).toBe(true);
        expect(titles.some(t => /Signing in/i.test(t))).toBe(true);
        expect(titles.some(t => /Backups/i.test(t))).toBe(false);
        expect(titles.some(t => /Disputes/i.test(t))).toBe(false);
        // Search finds nothing outside them either.
        fireEvent.change(within(dialog).getByPlaceholderText('Search the manual'), { target: { value: 'backup' } });
        const results = within(dialog).queryAllByRole('button').map(b => b.textContent || '');
        expect(results.some(t => /Backups and replicas/i.test(t))).toBe(false);
    });
});

describe('sectionTargetFor', () => {
    it('sends a moderator to Reports whatever the link says, and an admin where it says', () => {
        for (const s of ['home', 'moderation', 'disputes', 'decisions', null] as const) {
            expect(sectionTargetFor('moderator', s)).toEqual({ tab: 'people', subTab: 'moderation' });
        }
        expect(sectionTargetFor('admin', 'disputes')).toEqual({ tab: 'economy', subTab: 'disputes' });
        expect(sectionTargetFor('owner', null)).toBeNull();
    });
});

describe('ModeratorView report actions', () => {
    async function renderView() {
        mockNode();
        await act(async () => {
            render(<ModeratorView nodeUrl="https://mullum.example" communityName="Mullum" onLogout={() => {}} />);
        });
        await waitFor(() => expect(screen.getAllByTestId('moderator-report')).toHaveLength(3));
        return screen.getAllByTestId('moderator-report');
    }
    const posted = (suffix: string) => calls.filter(c => c.method === 'POST' && c.url.endsWith(suffix));

    it('takes a reported post down with the reason the author reads', async () => {
        const [postCard] = await renderView();
        expect(within(postCard).getByText('Cheap phones')).toBeInTheDocument();
        expect(within(postCard).getByText('No questions asked')).toBeInTheDocument();
        fireEvent.click(within(postCard).getByRole('button', { name: 'Remove the post' }));
        fireEvent.change(within(postCard).getByRole('combobox'), { target: { value: 'spam' } });
        await act(async () => { fireEvent.click(within(postCard).getByRole('button', { name: 'Remove it' })); });
        const sent = posted('/reports/r-post/action');
        expect(sent).toHaveLength(1);
        expect(sent[0].body).toMatchObject({ deletePost: true, removePulseItem: false, reasonCategory: 'spam' });
        expect(sent[0].body.suspendUser).toBeUndefined();
    });

    it('takes a reported Pulse item off the Pulse', async () => {
        const [, pulseCard] = await renderView();
        await act(async () => { fireEvent.click(within(pulseCard).getByRole('button', { name: 'Remove from the Pulse' })); });
        expect(posted('/reports/r-pulse/action')[0].body).toMatchObject({ deletePost: false, removePulseItem: true });
    });

    it('marks a member report handled, or dismisses a report; never offers to suspend', async () => {
        const [postCard, , memberCard] = await renderView();
        expect(screen.queryByRole('button', { name: /suspend|freeze/i })).toBeNull();
        await act(async () => { fireEvent.click(within(memberCard).getByRole('button', { name: 'Mark handled' })); });
        expect(posted('/reports/r-member/action')[0].body).toMatchObject({ deletePost: false, removePulseItem: false });
        await act(async () => { fireEvent.click(within(postCard).getByRole('button', { name: 'Dismiss (keep the post)' })); });
        expect(posted('/reports/r-post/dismiss')).toHaveLength(1);
    });

    it('filters by outcome and shows the open count', async () => {
        await renderView();
        expect(screen.getByRole('button', { name: 'Open (3)' })).toHaveAttribute('aria-pressed', 'true');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Handled' })); });
        await waitFor(() => expect(calls.some(c => c.url.includes('status=actioned'))).toBe(true));
        expect(await screen.findByText('No reports here.')).toBeInTheDocument();
    });
});
