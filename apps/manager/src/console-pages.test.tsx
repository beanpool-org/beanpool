import React, { useState } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { App } from './App';
import { fetchNodeData, withMembersPage, type NodeDataPayload, type MembersPage } from './lib/node-client';
import { NodeDataPagesContext, type NodeDataPagesValue } from './lib/node-data-pages';
import { AncestryTreePanel } from './components/modules/AncestryTreePanel';

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
