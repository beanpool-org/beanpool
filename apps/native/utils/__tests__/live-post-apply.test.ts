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
import { applyDelta, getDb } from '../db';
import { applyLivePostChange, performSync } from '../../services/pillar-sync';
import { livePostChange } from '@beanpool/core';

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

describe('a catch-up sync already in flight does not undo a push', () => {
    function syncFetch(postsBody: () => Promise<string>) {
        fetchMock.mockImplementation(async (url: string) => {
            if (url.includes('/api/marketplace/posts')) {
                const body = await postsBody();
                return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
            }
            return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
        });
    }

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
