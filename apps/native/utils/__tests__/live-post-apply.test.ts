import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// A listing the node pushed over /ws, written into the phone's own cache (services/pillar-sync.ts
// applyLivePostChange → utils/db.ts applyDelta), as real SQL against the phone's real schema: getDb() runs the
// app's own _doInitDB over this in-memory database. Device modules are stubbed at the boundary as in
// apply-delta.test.ts.

const sql = new DatabaseSync(':memory:');
const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
const adapter = {
    runAsync: vi.fn(async (q: string, p?: unknown) => {
        const r = sql.prepare(q).run(...params(p));
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    }),
    execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
    getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...params(p))),
    getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null),
    closeAsync: vi.fn(async () => {}),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
};

const ANCHOR = 'https://test.beanpool.org';
let activeAnchor: string | null = ANCHOR;
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? activeAnchor : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
        multiRemove: vi.fn(async () => {}),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me'.padEnd(64, '0'), privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { applyDelta, getDb, getPost, getPosts } from '../db';
import { applyLivePostChange, performSync } from '../../services/pillar-sync';
import { livePostChange } from '@beanpool/core';
import { marketFeedQuery, type MarketTypeFilter } from '../market-filters';

const ME = 'me'.padEnd(64, '0');
const ANN = 'a'.repeat(64);

function offer(extra: Record<string, unknown> = {}) {
    return {
        id: 'post-1', type: 'offer', category: 'food', title: 'Spare lemons', description: 'A bag', credits: 5,
        priceType: 'fixed', authorPublicKey: ANN, authorCallsign: 'Ann',
        createdAt: '2026-09-24T01:00:00.000Z', updatedAt: '2026-09-24T01:00:00.000Z',
        active: true, status: 'active', audienceScope: 'public', lat: -28.5, lng: 153.4,
        photos: ['/api/marketplace/posts/post-1/photos/0?v=0'], authorEnergyCycled: 12, authorFoundingNeeded: false,
        ...extra,
    };
}
const upsert = (post: any, created = false) => livePostChange({ type: created ? 'new_post' : 'post_updated', post })!;
const removal = (id = 'post-1') => livePostChange({ type: 'post_removed', id, audienceScope: 'public' })!;
const ctx = { anchorUrl: ANCHOR, selfPubkey: ME };
const row = (id = 'post-1') => sql.prepare('SELECT * FROM posts WHERE id = ?').get(id) as any;
const rowCount = (id = 'post-1') => (sql.prepare('SELECT COUNT(*) AS c FROM posts WHERE id = ?').get(id) as any).c;
const cursorWrites = () => vi.mocked(AsyncStorage.setItem).mock.calls.filter(([k]) => String(k).includes('last-sync'));

const fetchMock = vi.fn();

beforeEach(async () => {
    activeAnchor = ANCHOR;
    vi.mocked(AsyncStorage.setItem).mockClear();
    fetchMock.mockReset().mockResolvedValue({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    (globalThis as any).fetch = fetchMock;
    await getDb(); // schema in place
    for (const t of ['posts', 'marketplace_transactions', 'conversations']) sql.exec(`DELETE FROM ${t}`);
});

describe('applyDelta liveChanges: a pushed listing goes through the delta sync\'s own row writer', () => {
    it('writes the same row a delta sync writes for the same listing', async () => {
        const p = offer();
        await applyDelta({ posts: [p] });
        const synced = row();
        sql.exec('DELETE FROM posts');
        await applyDelta({ liveChanges: [upsert(p, true)] });
        expect(row()).toEqual(synced);
        expect(row().title).toBe('Spare lemons');
    });

    it('a later delta sync that returns the same listing does not duplicate it', async () => {
        await applyDelta({ liveChanges: [upsert(offer(), true)] });
        await applyDelta({ posts: [offer({ description: 'A bag, from the tree out the back' })] });
        expect(rowCount()).toBe(1);
        expect(row().description).toBe('A bag, from the tree out the back');
    });

    it('a late push never moves a listing backwards', async () => {
        await applyDelta({ posts: [offer({ title: 'v3', updatedAt: '2026-09-24T03:00:00.000Z' })] });
        await applyDelta({ liveChanges: [upsert(offer({ title: 'v2', updatedAt: '2026-09-24T02:00:00.000Z' }))] });
        expect(row().title).toBe('v3');
        // Same instant applies: the push may carry a change that did not move updatedAt.
        await applyDelta({ liveChanges: [upsert(offer({ title: 'v3b', updatedAt: '2026-09-24T03:00:00.000Z' }))] });
        expect(row().title).toBe('v3b');
    });

    it('a removal cancels the cached row the way the node\'s tombstone does, and creates nothing', async () => {
        await applyDelta({ posts: [offer()] });
        await applyDelta({ liveChanges: [removal()] });
        expect(row()).toMatchObject({ status: 'cancelled', active: 0 });
        await applyDelta({ liveChanges: [removal('never-seen')] });
        expect(rowCount('never-seen')).toBe(0);
    });

    it('changes apply in order: an edit then a removal ends removed', async () => {
        await applyDelta({ posts: [offer()] });
        await applyDelta({ liveChanges: [upsert(offer({ title: 'edited', updatedAt: '2026-09-24T02:00:00.000Z' })), removal()] });
        expect(row()).toMatchObject({ title: 'edited', status: 'cancelled', active: 0 });
    });
});

describe('applyLivePostChange: written locally, no request to the node, cursor untouched', () => {
    it('another member\'s new public offer is written, with no fetch and no cursor move', async () => {
        expect(await applyLivePostChange(upsert(offer(), true), ctx)).toBe(true);
        expect(row()).toMatchObject({ id: 'post-1', title: 'Spare lemons', status: 'active', active: 1 });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(cursorWrites()).toEqual([]);
    });

    it('a removal of another member\'s offer tombstones it', async () => {
        await applyDelta({ posts: [offer()] });
        expect(await applyLivePostChange(removal(), ctx)).toBe(true);
        expect(row()).toMatchObject({ status: 'cancelled', active: 0 });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // Each of these is one member, not a crowd, and their app has more to refresh than the listing: their deals,
    // their chats about it, their own offer gate. They keep the full catch-up sync.
    it('my own listing is left to the catch-up sync', async () => {
        expect(await applyLivePostChange(upsert(offer({ authorPublicKey: ME }), true), ctx)).toBe(false);
        expect(rowCount()).toBe(0);
        await applyDelta({ posts: [offer({ authorPublicKey: ME })] });
        expect(await applyLivePostChange(removal(), ctx)).toBe(false);
        expect(row().status).toBe('active');
    });

    it('a listing I have accepted is left to the catch-up sync', async () => {
        expect(await applyLivePostChange(upsert(offer({ acceptedBy: ME, status: 'pending' })), ctx)).toBe(false);
        expect(rowCount()).toBe(0);
    });

    it.each(['requested', 'pending'])('a listing I have a %s deal on is left to the catch-up sync', async (status) => {
        await applyDelta({ posts: [offer()] });
        sql.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES ('tx1', 'post-1', ?, ?, 5, ?)`).run(ME, ANN, status);
        expect(await applyLivePostChange(upsert(offer({ title: 'edited', updatedAt: '2026-09-24T02:00:00.000Z' })), ctx)).toBe(false);
        expect(await applyLivePostChange(removal(), ctx)).toBe(false);
        expect(row()).toMatchObject({ title: 'Spare lemons', status: 'active' });
    });

    it('a finished deal does not tie me to the listing', async () => {
        sql.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES ('tx1', 'post-1', ?, ?, 5, 'completed')`).run(ME, ANN);
        expect(await applyLivePostChange(upsert(offer(), true), ctx)).toBe(true);
    });

    it('a listing I have a conversation about is left to the catch-up sync (the chat caches its title and status)', async () => {
        await applyDelta({ posts: [offer()] });
        sql.prepare(`INSERT INTO conversations (id, type, post_id, post_title) VALUES ('c1', 'dm', 'post-1', 'Spare lemons')`).run();
        expect(await applyLivePostChange(upsert(offer({ title: 'edited', updatedAt: '2026-09-24T02:00:00.000Z' })), ctx)).toBe(false);
        expect(await applyLivePostChange(removal(), ctx)).toBe(false);
        expect(row().title).toBe('Spare lemons');
    });

    it.each(['event', 'poll'])('removing a cached %s is left to the catch-up sync', async (type) => {
        await applyDelta({ posts: [offer({ type })] });
        expect(await applyLivePostChange(removal(), ctx)).toBe(false);
        expect(row().status).toBe('active');
    });

    it('a change from a node the phone has since switched away from is not written here', async () => {
        activeAnchor = 'https://other.beanpool.org';
        expect(await applyLivePostChange(upsert(offer(), true), ctx)).toBe(false);
        activeAnchor = ANCHOR;
        expect(rowCount()).toBe(0);
    });

    it('with no socket node to pin to, nothing is written', async () => {
        expect(await applyLivePostChange(upsert(offer(), true), { anchorUrl: null, selfPubkey: ME })).toBe(false);
        expect(rowCount()).toBe(0);
    });
});

/** The node's posts pull answers with this body; every other request 404s. */
function syncFetch(postsBody: () => Promise<string>) {
    fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/api/marketplace/posts')) {
            const body = await postsBody();
            return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });
}

describe('a catch-up sync already in flight does not undo a push', () => {
    it('an edit pushed while the sync\'s older copy was on its way survives the sync', async () => {
        await applyDelta({ posts: [offer({ title: 'v1' })] });
        let release!: () => void;
        const fetched = new Promise<void>(r => { release = r; });
        // The node answered the posts pull before the edit, so the sync carries v1.
        syncFetch(async () => { await fetched; return JSON.stringify([offer({ title: 'v1' })]); });

        const sync = performSync();
        await new Promise(r => setTimeout(r, 0));
        expect(await applyLivePostChange(upsert(offer({ title: 'v2', updatedAt: '2026-09-24T02:00:00.000Z' })), ctx)).toBe(true);
        expect(row().title).toBe('v2');
        release();
        const result = await sync;

        expect(result.success).toBe(true);
        expect(row().title).toBe('v2');
    });

    it('a removal pushed during the sync stays removed', async () => {
        await applyDelta({ posts: [offer()] });
        let release!: () => void;
        const fetched = new Promise<void>(r => { release = r; });
        syncFetch(async () => { await fetched; return JSON.stringify([offer({ description: 'still here, says the stale copy' })]); });

        const sync = performSync();
        await new Promise(r => setTimeout(r, 0));
        expect(await applyLivePostChange(removal(), ctx)).toBe(true);
        release();
        await sync;

        expect(row()).toMatchObject({ status: 'cancelled', active: 0 });
    });

    it('a push from before the sync began is not replayed over what the sync brought', async () => {
        await applyDelta({ posts: [offer({ title: 'v1' })] });
        expect(await applyLivePostChange(upsert(offer({ title: 'v2', updatedAt: '2026-09-24T02:00:00.000Z' })), ctx)).toBe(true);
        syncFetch(async () => JSON.stringify([offer({ title: 'v3', updatedAt: '2026-09-24T03:00:00.000Z' })]));
        await performSync();
        expect(row().title).toBe('v3');
    });
});

// The row writer used to name 32 of the posts table's 40 columns, and INSERT OR REPLACE does not keep a column it
// leaves out: it resets it to the table's default. So every sync put the 💸 marker back to 0, and a group or direct
// listing back to 'public' with no group or recipient, which moved it onto the public Market and off its group's.
describe('every column the node sends survives the write, on a sync and on a push', () => {
    const BOB = 'b'.repeat(64);
    const LATER = '2026-09-24T02:00:00.000Z';

    /** A group listing as `getPosts` sends it to a member of the group (packages/beanpool-engine/src/posts.ts `rowToPost`). */
    function groupOffer(extra: Record<string, unknown> = {}) {
        return offer({
            id: 'post-g', category: 'tools', title: 'Box trailer for the working bee', credits: 20, priceType: 'daily',
            repeatable: true, cashAlsoNeeded: true, status: 'pending', acceptedBy: BOB, acceptedByCallsign: 'Bob',
            acceptedAt: '2026-09-24T01:30:00.000Z', pendingTransactionId: 'tx-9', originNode: 'test.beanpool.org',
            photos: ['/api/marketplace/posts/post-g/photos/0?v=0'], reach: 'local',
            audienceScope: 'group', targetGroupId: 'g1', targetGroupName: 'Repair group',
            ...extra,
        });
    }
    /** The whole cached row for `groupOffer()`: every column of the phone's posts table. */
    const GROUP_ROW = {
        id: 'post-g', type: 'offer', category: 'tools', title: 'Box trailer for the working bee', description: 'A bag',
        credits: 20, author_pubkey: ANN, created_at: '2026-09-24T01:00:00.000Z', updated_at: '2026-09-24T01:00:00.000Z',
        active: 1, status: 'pending', price_type: 'daily', repeatable: 1, cash_also_needed: 1,
        accepted_by: BOB, accepted_by_callsign: 'Bob', accepted_at: '2026-09-24T01:30:00.000Z',
        pending_transaction_id: 'tx-9', completed_at: null, lat: -28.5, lng: 153.4, origin_node: 'test.beanpool.org',
        photos: '["/api/marketplace/posts/post-g/photos/0?v=0"]', reach: 'local', reach_peers: null,
        author_energy_cycled: 12, author_founding_needed: 0, poll_options: null, poll_closes_at: null,
        audience_scope: 'group', target_group_id: 'g1', target_pubkey: null, assigned_to: null,
        target_archetypes: null, // dormant: the node never sends it and nothing reads it
        event_start_at: null, event_end_at: null, event_place_name: null, event_state: null,
        event_going_count: 0, event_interested_count: 0,
    };
    const directNeed = (extra: Record<string, unknown> = {}) => offer({
        id: 'post-d', type: 'need', title: 'Lift to the station', audienceScope: 'direct', targetPubkey: ME, assignedTo: ME, ...extra,
    });

    beforeEach(() => {
        sql.exec('DELETE FROM groups');
        sql.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES ('g1', 'Repair group', 'repair-group', ?)`).run(ANN);
    });

    it('a delta sync writes the whole row: the 💸 marker, the audience and the group', async () => {
        await applyDelta({ posts: [groupOffer()] });
        expect(row('post-g')).toEqual(GROUP_ROW);
    });

    it('a later delta sync of an edit changes the edit and nothing else', async () => {
        await applyDelta({ posts: [groupOffer()] });
        await applyDelta({ posts: [groupOffer({ title: 'Box trailer (caged)', updatedAt: LATER })] });
        expect(row('post-g')).toEqual({ ...GROUP_ROW, title: 'Box trailer (caged)', updated_at: LATER });
    });

    it('a direct listing keeps who it is for', async () => {
        await applyDelta({ posts: [directNeed()] });
        expect(row('post-d')).toMatchObject({ audience_scope: 'direct', target_pubkey: ME, assigned_to: ME, target_group_id: null });
    });

    it('a pushed change is written by the same writer, so it keeps every column too', async () => {
        await applyDelta({ liveChanges: [{ kind: 'upsert', post: groupOffer() as any, created: true }] });
        expect(row('post-g')).toEqual(GROUP_ROW);
    });

    it("a group listing's broadcast rings the doorbell, and the catch-up sync it rings keeps the listing in its group", async () => {
        await applyDelta({ posts: [groupOffer()] });
        const edited = groupOffer({ title: 'Box trailer (caged)', updatedAt: LATER });
        expect(livePostChange({ type: 'post_updated', post: edited })).toBeNull();
        syncFetch(async () => JSON.stringify([edited]));
        expect((await performSync()).success).toBe(true);
        expect(row('post-g')).toEqual({ ...GROUP_ROW, title: 'Box trailer (caged)', updated_at: LATER });
    });

    it("a public offer's 💸 marker survives a sync and a push, and the Market reads it off the cache", async () => {
        await applyDelta({ posts: [offer({ cashAlsoNeeded: true })] });
        expect(row().cash_also_needed).toBe(1);
        expect(await applyLivePostChange(upsert(offer({ cashAlsoNeeded: true, title: 'Meyer lemons', updatedAt: LATER })), ctx)).toBe(true);
        expect(row()).toMatchObject({ title: 'Meyer lemons', cash_also_needed: 1 });
        const [card] = await getPosts();
        expect(card).toMatchObject({ id: 'post-1', cash_also_needed: 1 });
    });

    it("the public list (the map's) shows no group or direct listing; the group filter shows the group's, after a sync and a push", async () => {
        await applyDelta({ posts: [offer(), groupOffer(), directNeed()] });
        expect(await applyLivePostChange(upsert(offer({ id: 'post-2', title: 'Seedlings' }), true), ctx)).toBe(true);

        expect((await getPosts()).map(p => p.id).sort()).toEqual(['post-1', 'post-2']);
        const inGroup = await getPosts({ targetGroupId: 'g1' });
        expect(inGroup.map(p => p.id)).toEqual(['post-g']);
        expect(inGroup[0]).toMatchObject({ audienceScope: 'group', targetGroupId: 'g1', targetGroupName: 'Repair group', cash_also_needed: 1 });
    });

    it('the deals counters read every audience, so a deal on a group listing is still counted', async () => {
        await applyDelta({ posts: [offer(), groupOffer()] });
        const all = await getPosts({ allScopes: true });
        expect(all.map(p => p.id).sort()).toEqual(['post-1', 'post-g']);
        expect(all.find(p => p.id === 'post-g')).toMatchObject({ audienceScope: 'group', targetGroupId: 'g1' });
    });

    it('opening a listing refreshes it through the same writer, so it stays in its group and keeps its 💸 marker', async () => {
        await applyDelta({ posts: [groupOffer()] });
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [groupOffer({ title: 'v2', updatedAt: LATER })] });
        await getPost('post-g');
        await vi.waitFor(() => expect(row('post-g').title).toBe('v2'));
        expect(row('post-g')).toEqual({ ...GROUP_ROW, title: 'v2', updated_at: LATER });
    });

    describe('reach_peers: the node sends it to the author alone and never in a broadcast', () => {
        const mine = (extra: Record<string, unknown> = {}) =>
            offer({ id: 'post-m', authorPublicKey: ME, reach: 'peers', reachPeers: ['peer-a', 'peer-b'], ...extra });

        it("is stored from the author's own read, kept when a copy arrives without it, and cleared when reach leaves 'peers'", async () => {
            await applyDelta({ posts: [mine()] });
            expect(row('post-m')).toMatchObject({ reach: 'peers', reach_peers: '["peer-a","peer-b"]' });

            // The copy every socket gets has the list taken off (publicBroadcastPost): it says nothing about the list.
            const broadcast: Record<string, unknown> = mine({ title: 'edited', updatedAt: LATER });
            delete broadcast.reachPeers;
            await applyDelta({ liveChanges: [{ kind: 'upsert', post: broadcast as any, created: false }] });
            expect(row('post-m')).toMatchObject({ title: 'edited', reach: 'peers', reach_peers: '["peer-a","peer-b"]' });

            await applyDelta({ posts: [mine({ reach: 'local', reachPeers: [], updatedAt: '2026-09-24T03:00:00.000Z' })] });
            expect(row('post-m')).toMatchObject({ reach: 'local', reach_peers: null });
        });

        it("another member's 'peers' listing is stored with its reach and no list", async () => {
            await applyDelta({ posts: [offer({ reach: 'peers' })] });
            expect(row()).toMatchObject({ reach: 'peers', reach_peers: null });
        });
    });

    // The default chip reads "All Groups & Public", as the node's own feed for a signed member is. The groups are the
    // ones this member is active in by the cached memberships: leaving a group takes away only the membership row
    // (the group's listings stay cached), and they must leave the feed with it.
    describe("the Market feed with no group chip: public listings plus the groups I am in", () => {
        const feed = (type: MarketTypeFilter = 'all', groupId = 'all') => getPosts(marketFeedQuery(type, groupId, ME));
        const ids = (posts: { id: string }[]) => posts.map(p => p.id).sort();
        const member = (groupId: string, pubkey: string, status: string) =>
            sql.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', ?)`).run(groupId, pubkey, status);
        const groupEvent = offer({
            id: 'event-g', type: 'event', category: 'community', title: 'Working bee', credits: 0,
            eventStartAt: '2099-10-04T09:00:00.000Z', eventEndAt: '2099-10-04T12:00:00.000Z', eventPlaceName: 'The shed',
            audienceScope: 'group', targetGroupId: 'g1',
        });

        beforeEach(() => {
            sql.exec('DELETE FROM group_members');
            sql.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES ('g2', 'Choir', 'choir', ?)`).run(ANN);
            member('g1', ME, 'active');
        });

        it("shows a public listing and a listing for a group I am in, which carries what its badge reads", async () => {
            await applyDelta({ posts: [offer(), groupOffer()] });
            const posts = await feed();
            expect(ids(posts)).toEqual(['post-1', 'post-g']);
            expect(posts.find(p => p.id === 'post-g')).toMatchObject({ audienceScope: 'group', targetGroupId: 'g1', targetGroupName: 'Repair group' });
        });

        it('the Events pill and For You read the same audience', async () => {
            await applyDelta({ posts: [offer(), groupOffer(), groupEvent] });
            expect(ids(await feed('events'))).toEqual(['event-g']);
            expect(ids(await feed('for-you'))).toEqual(['event-g', 'post-1', 'post-g']);
        });

        it("hides a group I am not in: no membership row, a membership that is not active, or someone else's", async () => {
            await applyDelta({ posts: [offer(), groupOffer({ id: 'post-g2', targetGroupId: 'g2' })] });
            expect(ids(await feed())).toEqual(['post-1']);
            member('g2', ME, 'invited');
            expect(ids(await feed())).toEqual(['post-1']);
            sql.exec('DELETE FROM group_members');
            member('g2', BOB, 'active');
            expect(ids(await feed())).toEqual(['post-1']);
        });

        it("a group's listings leave the feed when I leave it, though the phone still holds them", async () => {
            await applyDelta({ posts: [offer(), groupOffer()] });
            expect(ids(await feed())).toEqual(['post-1', 'post-g']);
            // What leaveGroupApi and fetchGroups do on the phone: the membership row goes, the listing stays cached.
            sql.prepare('DELETE FROM group_members WHERE group_id = ? AND member_pubkey = ?').run('g1', ME);
            expect(ids(await feed())).toEqual(['post-1']);
            expect(rowCount('post-g')).toBe(1);
        });

        it('hides a direct listing for someone else', async () => {
            await applyDelta({ posts: [offer(), directNeed({ targetPubkey: BOB, assignedTo: BOB })] });
            expect(ids(await feed())).toEqual(['post-1']);
        });

        it("a group chip still shows only that group's listings", async () => {
            member('g2', ME, 'active');
            await applyDelta({ posts: [offer(), groupOffer(), groupOffer({ id: 'post-g2', targetGroupId: 'g2' })] });
            expect(ids(await feed('all', 'g1'))).toEqual(['post-g']);
            expect(ids(await feed('all', 'g2'))).toEqual(['post-g2']);
            expect(ids(await feed())).toEqual(['post-1', 'post-g', 'post-g2']);
        });

        it('the 💸 marker reaches the feed after a sync and a push', async () => {
            await applyDelta({ posts: [offer({ cashAlsoNeeded: true }), groupOffer()] });
            expect(await applyLivePostChange(upsert(offer({ cashAlsoNeeded: true, title: 'Meyer lemons', updatedAt: LATER })), ctx)).toBe(true);
            const posts = await feed();
            expect(posts.find(p => p.id === 'post-1')).toMatchObject({ title: 'Meyer lemons', cash_also_needed: 1 });
            expect(posts.find(p => p.id === 'post-g')).toMatchObject({ cash_also_needed: 1 });
        });

        it('with nobody signed in it reads public listings only', async () => {
            await applyDelta({ posts: [offer(), groupOffer()] });
            expect(ids(await getPosts(marketFeedQuery('all', 'all', null)))).toEqual(['post-1']);
        });
    });
});
