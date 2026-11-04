import React, { useState } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { App } from './App';
import { fetchNodeData, withMembersPage, type NodeDataPayload, type MembersPage } from './lib/node-client';
import { NodeDataPagesContext, type NodeDataPagesValue } from './lib/node-data-pages';
import { AncestryTreePanel } from './components/modules/AncestryTreePanel';
import { MembersModule } from './components/modules/MembersModule';

/**
 * The owner console reads the node's members and posts a page at a time (capacity fix 3): POST /api/local/admin/data
 * with `lists: 'none'` is the summary and its counts, and /admin/data/members and /data/posts are the pages. The screens
 * count from the counts, list the pages read so far, and offer the next with Load more. A node from before the pages
 * sends the lists whole, and the console shows them as it always did.
 */

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) });
const key = (i: number) => i.toString(16).padStart(64, '0');
const member = (i: number) => ({ publicKey: key(i), callsign: `Member ${i}`, invitedBy: i === 0 ? 'genesis' : key(0), isTreasury: false, joinedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z` });

const SUMMARY = {
    health: { flags: [] }, reports: [], reportCount: 0, escrowDisputesCount: 0, knockCount: 0,
    tradeTotals: { deals: 3, volume: 12, cancelled: 0 }, commonsBalance: 5,
    counts: { members: 3_500, treasuries: 1, doorMembers: 40, owners: 2, platforms: { ios: 10, android: 20, web: 0, unknown: 3_470 } },
};

function bodyOf(init: unknown): Record<string, unknown> {
    try { return JSON.parse(String((init as { body?: unknown })?.body ?? '{}')); } catch { return {}; }
}

afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
});

describe('the console reads the node a page at a time', () => {
    it('asks for the summary, then the first page of members and of posts, and keeps the cursors', async () => {
        const fetchMock = vi.fn().mockImplementation((url: string, init: unknown) => {
            const u = String(url);
            if (u.endsWith('/api/local/admin/data/members')) return ok({ members: [member(0), member(1)], profiles: [{ publicKey: key(0) }], memberStats: { [key(0)]: { posts: 1, messages: 0 } }, nextCursor: 'm2', total: 3_500 });
            if (u.endsWith('/api/local/admin/data/posts')) return ok({ posts: [{ id: 'p1' }], nextCursor: 'p2' });
            if (u.endsWith('/api/local/admin/data')) return ok(SUMMARY);
            throw new Error(`unexpected ${u} ${JSON.stringify(bodyOf(init))}`);
        });
        vi.stubGlobal('fetch', fetchMock);
        const data = await fetchNodeData('https://node.example');
        const dataCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/local/admin/data'));
        expect(bodyOf(dataCall?.[1]).lists).toBe('none');
        const membersCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/data/members'));
        expect(bodyOf(membersCall?.[1])).toMatchObject({ limit: 200, cursor: null });
        expect(data.members?.map((m) => m.publicKey)).toEqual([key(0), key(1)]);
        expect(data.posts).toEqual([{ id: 'p1' }]);
        expect(data.counts?.members).toBe(3_500);
        expect(data.membersNext).toBe('m2');
        expect(data.postsNext).toBe('p2');
        expect(data.membersTotal).toBe(3_500);
    });

    it('a node from before the pages: its whole lists as they came, counts made from them, nothing more to load', async () => {
        const fetchMock = vi.fn().mockImplementation((url: string) => {
            const u = String(url);
            if (u.endsWith('/api/local/admin/data')) {
                return ok({ ...SUMMARY, counts: undefined, members: [member(0), member(1), { ...member(2), isTreasury: true, invitedBy: 'open:google' }], profiles: [], posts: [{ id: 'p1' }], memberStats: {} });
            }
            throw new Error(`an older node has no ${u}`);
        });
        vi.stubGlobal('fetch', fetchMock);
        const data = await fetchNodeData('https://old-node.example');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(data.members).toHaveLength(3);
        expect(data.counts).toMatchObject({ members: 3, treasuries: 1, doorMembers: 1 });
        expect(data.membersNext).toBeNull();
        expect(data.postsNext).toBeNull();
    });

    it('a walk of the pages holds each member once, even when a page is read twice', () => {
        let data: NodeDataPayload = { members: [], profiles: [], memberStats: {} };
        const page = (from: number, to: number, next: string | null): MembersPage => ({
            members: Array.from({ length: to - from }, (_, i) => ({ publicKey: key(from + i) })),
            profiles: [], memberStats: {}, nextCursor: next, total: 5,
        });
        data = withMembersPage(data, page(0, 2, 'a'));
        data = withMembersPage(data, page(2, 4, 'b'));
        data = withMembersPage(data, page(2, 4, 'b'));
        data = withMembersPage(data, page(4, 5, null));
        expect(data.members?.map((m) => m.publicKey)).toEqual([0, 1, 2, 3, 4].map(key));
        expect(data.membersNext).toBeNull();
    });
});

/** The invite tree with App's paging: Load more appends the next page from `next`, as App does. */
function TreeWithPages({ first, pages }: { first: NodeDataPayload; pages: Record<string, MembersPage> }) {
    const [data, setData] = useState<NodeDataPayload>(first);
    const value: NodeDataPagesValue = {
        members: { loaded: data.members?.length ?? 0, total: data.membersTotal ?? null, more: !!data.membersNext },
        posts: { loaded: 0, more: false },
        busy: { members: false, posts: false },
        error: { members: null, posts: null },
        loadMore: (kind) => { if (kind === 'members' && data.membersNext) setData((d) => withMembersPage(d, pages[d.membersNext as string])); },
    };
    return (
        <NodeDataPagesContext.Provider value={value}>
            <AncestryTreePanel nodeData={data as Record<string, unknown>} activeNode={{ id: 'n1', name: 'Node', url: 'https://node.example' }} />
        </NodeDataPagesContext.Provider>
    );
}

describe('the invite tree pages its members', () => {
    it('says how many it shows of how many, loads the next page, and says nothing once all are shown', async () => {
        const first: NodeDataPayload = { members: [member(0), member(1)], profiles: [], memberStats: {}, reports: [], health: { flags: [] }, membersNext: 'c2', membersTotal: 3, counts: { ...SUMMARY.counts, members: 3 } };
        const pages = { c2: { members: [member(2)], profiles: [], memberStats: {}, nextCursor: null, total: 3 } };
        render(<TreeWithPages first={first} pages={pages} />);
        const row = screen.getByTestId('load-more-members');
        expect(row).toHaveTextContent('Showing 2 of 3 members, oldest joined first.');
        expect(screen.queryByText(/Member 2\b/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Load 200 more' }));
        await waitFor(() => expect(screen.queryByTestId('load-more-members')).toBeNull());
        expect(screen.getAllByText(/Member 2\b/).length).toBeGreaterThan(0);
    });

    it('while a search is typed and more members are on the node, says the search looks only at those shown', () => {
        const first: NodeDataPayload = { members: [member(0)], profiles: [], memberStats: {}, reports: [], health: { flags: [] }, membersNext: 'c2', membersTotal: 9 };
        render(<TreeWithPages first={first} pages={{}} />);
        fireEvent.change(screen.getByPlaceholderText('Search members by callsign or pubkey...'), { target: { value: 'zz' } });
        expect(screen.getByTestId('load-more-members')).toHaveTextContent('The search looks only at the members shown.');
    });
});

describe('Home on a node that pages', () => {
    it('shows the node\'s member count, not the length of the first page', async () => {
        const fetchMock = vi.fn().mockImplementation((url: string) => {
            const u = String(url);
            if (u.includes('/api/local/admin/auth/exchange')) return ok({ success: true, role: 'owner', memberPubkey: 'ab'.repeat(32), csrfToken: 'csrf-link' });
            if (u.includes('/api/local/admin/auth/session')) return ok({ authenticated: false });
            if (u.endsWith('/api/local/admin/data/members')) return ok({ members: [member(0), member(1)], profiles: [], memberStats: {}, nextCursor: 'm2', total: 3_500 });
            if (u.endsWith('/api/local/admin/data/posts')) return ok({ posts: [], nextCursor: null });
            if (u.endsWith('/api/local/admin/data')) return ok(SUMMARY);
            if (u.includes('/api/local/admin/diagnostics')) {
                return ok({ success: true, status: 'online', uptimeSeconds: 1, cpuLoadPercent: 1, memoryUsageMb: 1, totalMemoryMb: 2, dbSizeBytes: 1, walSizeBytes: 0,
                    activeWsConnections: 0, p2pActivePeers: 0, communityName: 'Big', serverAlerts: { count: 0, items: [] } });
            }
            return ok({ success: true, health: { flags: [] }, reports: [] });
        });
        vi.stubGlobal('fetch', fetchMock);
        window.history.replaceState(null, '', `/settings#handoff=${'d'.repeat(64)}&section=home&from=app`);
        await act(async () => {
            render(<App isFleetMode={false} />);
        });
        await waitFor(() => expect(screen.getByRole('button', { name: /Members/ })).toHaveTextContent('3499'));
        expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/api/local/admin/data/members'))).toBe(true);
    });
});

describe("the prune-branch dialog confirms on the node's figures for the whole branch", () => {
    it('on a node bigger than a page, a branch reaching past page 1: the node\'s totals, and Confirm only once they are in', async () => {
        let answer: (body: unknown) => void = () => {};
        const fetchMock = vi.fn().mockImplementation((url: string) => {
            const u = String(url);
            if (u.endsWith(`/api/local/admin/branches/${key(0)}/prune`)) return new Promise((resolve) => { answer = (body) => resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) }); });
            throw new Error(`unexpected ${u}`);
        });
        vi.stubGlobal('fetch', fetchMock);
        // Page 1 of 3,500 holds the root and one member it brought in; the rest of its branch is on later pages.
        const first: NodeDataPayload = { members: [member(0), member(1)], profiles: [], memberStats: {}, reports: [], health: { flags: [] }, membersNext: 'c2', membersTotal: 3_500, counts: SUMMARY.counts };
        render(<TreeWithPages first={first} pages={{}} />);
        fireEvent.click(screen.getAllByText(/Prune Branch/i)[0]);
        expect(screen.getByText('Prune Invite Branch')).toBeInTheDocument();
        expect(screen.getByTestId('prune-figures-loading')).toHaveTextContent('Reading the whole branch from the node…');
        fireEvent.change(document.getElementById('prune-branch-confirm-input') as HTMLInputElement, { target: { value: 'Member 0' } });
        const confirm = document.getElementById('confirm-prune-branch-btn') as HTMLButtonElement;
        expect(confirm).toBeDisabled();
        expect(document.getElementById('prune-members-affected')?.textContent).toBe('…');

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await act(async () => { answer({ members: 2_400, badDebt: 812.5, surplus: 40, net: -772.5 }); });
        await waitFor(() => expect(document.getElementById('prune-members-affected')?.textContent).toBe('2400'));
        expect(document.getElementById('prune-debt-written-off')?.textContent).toBe('812.5 🫘 bad debt');
        expect(document.getElementById('prune-credit-confiscated')?.textContent).toBe('40 🫘 credit');
        expect(document.getElementById('prune-net-impact')?.textContent).toBe('-772.5 🫘');
        expect(confirm).toBeEnabled();
        const asked = fetchMock.mock.calls.find(([u]) => String(u).endsWith(`/branches/${key(0)}/prune`));
        expect((asked?.[1] as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
    });

    it('when the node cannot give them: says so, and Confirm stays off', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden', json: () => Promise.resolve({ error: 'Only an owner of this node can remove a whole invite branch' }) })));
        const first: NodeDataPayload = { members: [member(0), member(1)], profiles: [], memberStats: {}, reports: [], health: { flags: [] }, membersNext: 'c2', membersTotal: 3_500 };
        render(<TreeWithPages first={first} pages={{}} />);
        fireEvent.click(screen.getAllByText(/Prune Branch/i)[0]);
        expect(await screen.findByTestId('prune-figures-error')).toHaveTextContent('Only an owner of this node can remove a whole invite branch');
        fireEvent.change(document.getElementById('prune-branch-confirm-input') as HTMLInputElement, { target: { value: 'Member 0' } });
        expect(document.getElementById('confirm-prune-branch-btn')).toBeDisabled();
    });
});

describe("the member's page counts every owner on the node", () => {
    const anna = { ...member(0), callsign: 'Anna Owner', name: 'Anna Owner', nodeRole: 'owner', status: 'active' };
    const draw = (owners: number) => render(
        <MembersModule
            nodeData={{ members: [anna, member(1)], profiles: [], posts: [], health: { flags: [] }, reports: [], membersNext: 'c2', counts: { ...SUMMARY.counts, owners } } as never}
            nodeDataLoading={false}
            activeNodeUrl="https://node.example"
            onRefresh={() => {}}
        />
    );

    it('a second owner off page 1: this owner is not called the only one', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() => ok({ success: true })));
        draw(2);
        fireEvent.click((await screen.findAllByText('Anna Owner'))[0]);
        expect(await screen.findByText('Revoke owner')).toBeInTheDocument();
        expect(screen.queryByText(/This is the community's only owner/)).toBeNull();
    });

    it('and when the node has one owner, it says so', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() => ok({ success: true })));
        draw(1);
        fireEvent.click((await screen.findAllByText('Anna Owner'))[0]);
        expect(await screen.findByText("This is the community's only owner. Another owner must be added before this one can step down or be removed.")).toBeInTheDocument();
    });
});

describe("a failed Load more's words belong to that read", () => {
    // The two failures tell themselves apart by their status: the page read says the node's HTTP status.
    const busy = () => Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable', json: () => Promise.resolve({}) });
    const gaveUp = () => Promise.resolve({ ok: false, status: 502, statusText: 'Bad Gateway', json: () => Promise.resolve({}) });
    const DIAG = { success: true, status: 'online', uptimeSeconds: 1, cpuLoadPercent: 1, memoryUsageMb: 1, totalMemoryMb: 2, dbSizeBytes: 1, walSizeBytes: 0,
        activeWsConnections: 0, p2pActivePeers: 0, communityName: 'Big', serverAlerts: { count: 0, items: [] } };

    it('Refresh clears it', async () => {
        const fetchMock = vi.fn().mockImplementation((url: string, init: unknown) => {
            const u = String(url);
            if (u.includes('/api/local/admin/auth/exchange')) return ok({ success: true, role: 'owner', memberPubkey: 'ab'.repeat(32), csrfToken: 'csrf-link' });
            if (u.includes('/api/local/admin/auth/session')) return ok({ authenticated: false });
            if (u.endsWith('/api/local/admin/data/members')) {
                return bodyOf(init).cursor === 'm2' ? busy() : ok({ members: [member(0), member(1)], profiles: [], memberStats: {}, nextCursor: 'm2', total: 3_500 });
            }
            if (u.endsWith('/api/local/admin/data/posts')) return ok({ posts: [], nextCursor: null });
            if (u.endsWith('/api/local/admin/data')) return ok(SUMMARY);
            if (u.includes('/api/local/admin/diagnostics')) return ok(DIAG);
            return ok({ success: true, health: { flags: [] }, reports: [] });
        });
        vi.stubGlobal('fetch', fetchMock);
        window.history.replaceState(null, '', `/settings#handoff=${'d'.repeat(64)}&section=home&from=app`);
        await act(async () => {
            render(<App isFleetMode={false} />);
        });
        fireEvent.click(await screen.findByTestId('home-figure-members'));
        // The invite tree, whose Refresh Tree is the Refresh pressed below.
        fireEvent.click(await screen.findByRole('button', { name: /Ancestry Tree/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Load 200 more' }));
        await waitFor(() => expect(screen.getByTestId('load-more-members')).toHaveTextContent("Couldn't load more: HTTP 503: Service Unavailable"));

        const reads = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/local/admin/data')).length;
        fireEvent.click(screen.getByRole('button', { name: /Refresh Tree/ }));
        await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/local/admin/data')).length).toBeGreaterThan(reads));
        await waitFor(() => expect(screen.getByTestId('load-more-members')).not.toHaveTextContent("Couldn't load more"));
        expect(screen.getByRole('button', { name: 'Load 200 more' })).toBeEnabled();
    });

    it('another node never shows it: not one that failed before the switch, nor one that fails after it', async () => {
        let failLate: () => void = () => {};
        const fetchMock = vi.fn().mockImplementation((url: string, init: unknown) => {
            const u = String(url);
            const other = u.includes('other.example.org');
            if (u.endsWith('/api/local/admin/data/members')) {
                const cursor = bodyOf(init).cursor;
                if (!other && cursor === 'm2') return busy();
                return ok(other
                    ? { members: [{ ...member(5), callsign: 'Bravo Member', name: 'Bravo Member' }], profiles: [], memberStats: {}, nextCursor: 'x2', total: 50 }
                    : { members: [member(0), member(1)], profiles: [], memberStats: {}, nextCursor: 'm2', total: 3_500 });
            }
            if (u.endsWith('/api/local/admin/data/posts')) return ok({ posts: [], nextCursor: null });
            if (u.endsWith('/api/local/admin/data')) return ok(SUMMARY);
            if (u.includes('/api/local/admin/diagnostics')) return ok(DIAG);
            return ok({ success: true, health: { flags: [] }, reports: [] });
        });
        vi.stubGlobal('fetch', fetchMock);
        localStorage.setItem('bp_fleet_active_tab', 'members');
        localStorage.setItem('bp_fleet_profiles', JSON.stringify([
            { id: 'local-node', name: 'Node 0', url: 'https://localhost:8443', adminPassword: 'pw' },
            { id: 'node-1', name: 'Node 1', url: 'https://other.example.org', adminPassword: 'pw' },
        ]));
        await act(async () => {
            render(<App isFleetMode={true} />);
        });
        // Node 0: a Load more fails, and says so there.
        fireEvent.click(await screen.findByRole('button', { name: 'Load 200 more' }));
        await waitFor(() => expect(screen.getByTestId('load-more-members')).toHaveTextContent("Couldn't load more: HTTP 503: Service Unavailable"));

        // Node 1: its own pages, and none of Node 0's words.
        await act(async () => { fireEvent.click(screen.getAllByText('Node 1')[0]); });
        await waitFor(() => expect(screen.getAllByText('Bravo Member').length).toBeGreaterThan(0));
        expect(screen.getByTestId('load-more-members')).not.toHaveTextContent("Couldn't load more");
        expect(screen.queryByText(/HTTP 503/)).toBeNull();

        // Back on Node 0, a Load more goes out; the operator moves to Node 1 before it fails.
        await act(async () => { fireEvent.click(screen.getAllByText('Node 0')[0]); });
        await waitFor(() => expect(screen.getByTestId('load-more-members')).toHaveTextContent('Showing 2 of 3,500 members'));
        // From here Node 0's next page is held open, so its failure lands only after the operator has moved on.
        fetchMock.mockImplementation((url: string, init: unknown) => {
            const u = String(url);
            const other = u.includes('other.example.org');
            if (u.endsWith('/api/local/admin/data/members')) {
                const cursor = bodyOf(init).cursor;
                if (!other && cursor === 'm2') return new Promise((resolve) => { failLate = () => resolve(gaveUp()); });
                return ok(other
                    ? { members: [{ ...member(5), callsign: 'Bravo Member', name: 'Bravo Member' }], profiles: [], memberStats: {}, nextCursor: 'x2', total: 50 }
                    : { members: [member(0), member(1)], profiles: [], memberStats: {}, nextCursor: 'm2', total: 3_500 });
            }
            if (u.endsWith('/api/local/admin/data/posts')) return ok({ posts: [], nextCursor: null });
            if (u.endsWith('/api/local/admin/data')) return ok(SUMMARY);
            if (u.includes('/api/local/admin/diagnostics')) return ok(DIAG);
            return ok({ success: true, health: { flags: [] }, reports: [] });
        });
        fireEvent.click(screen.getByRole('button', { name: 'Load 200 more' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled());
        await act(async () => { fireEvent.click(screen.getAllByText('Node 1')[0]); });
        await waitFor(() => expect(screen.getAllByText('Bravo Member').length).toBeGreaterThan(0));
        await act(async () => { failLate(); });
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByText(/HTTP 502/)).toBeNull();
        expect(screen.getByRole('button', { name: 'Load 200 more' })).toBeEnabled();
    });
});
