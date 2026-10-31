import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// A listing's tags in the phone's own copy (DESIGN-owner-seeding-tags-fable.md §4.5, §4.7; review of #2663 at 6b3f85b0,
// blocking 1). The phone's Edit opens from this copy, so a row with its tags missing opens a form with none. Every path
// that puts a listing in the copy is walked here for offers, needs, events and an enterprise's listings: the sync (a whole
// read and a delta), the /ws push, opening a listing, the phone's own create and edits, and a copy from before the column.
// Real SQL against the phone's real schema (getDb() runs the app's own _doInitDB over this in-memory database), device
// modules stubbed at the boundary as in market-banner-cache.test.ts; the node is a fetch stub.

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

const ANCHOR = 'https://valley.example.org';
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        // The one-off bp_trust_sync_v3 read is behind this phone: it asks for a sync of its own on open.
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? ANCHOR : k === 'bp_trust_sync_v3' ? 'true' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
        multiRemove: vi.fn(async () => {}),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
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
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
    signData: vi.fn(async (msg: Uint8Array) => msg),
}));

// The screens are told to reload, and the sync is asked for, through require(), which no vi.mock reaches: answered at
// node's loader, as in photo-keys-refresh.test.ts, and each recorded.
const emitted: string[] = [];
const syncsAsked: string[] = [];
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: (name: string) => { emitted.push(name); } } };
    if (request === '../services/pillar-sync') return { requestSync: async () => { syncsAsked.push('sync'); } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

import AsyncStorage from '@react-native-async-storage/async-storage';
import { livePostChange, postTagsOf } from '@beanpool/core';
import { applyDelta, closeDB, createPost, getDb, getMemberPosts, getMyPosts, getPost, getPosts, updateEvent, updatePost } from '../db';
import { syncCursorKeysOf } from '../../services/pillar-sync';
import { eventEditValues } from '../events';

const ME = 'me'.padEnd(64, '0');
const ANN = 'a'.repeat(64);
const ENTERPRISE = 'e'.repeat(64);
const LEMON = 'food.fruit.lemon';
const EGGS = 'food.eggs';
const DAY1 = '2026-10-01T01:00:00.000Z';
const DAY2 = '2026-10-02T01:00:00.000Z';

function listing(id: string, extra: Record<string, unknown> = {}) {
    return {
        id, type: 'offer', category: 'food', title: `Listing ${id}`, description: '', credits: 5, priceType: 'fixed',
        authorPublicKey: ANN, authorCallsign: 'Ann', createdAt: DAY1, updatedAt: DAY1, active: true, status: 'active',
        audienceScope: 'public', photos: [],
        ...extra,
    };
}
const stored = (id: string) => (sql.prepare('SELECT tags FROM posts WHERE id = ?').get(id) as { tags: string } | undefined)?.tags;
const answer = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });

const fetchMock = vi.fn();
/** What the phone asked the node to save, each request's body. */
const edits: Array<Record<string, unknown>> = [];

beforeEach(async () => {
    emitted.length = 0;
    syncsAsked.length = 0;
    edits.length = 0;
    fetchMock.mockReset().mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === 'POST' && url.endsWith('/api/marketplace/posts/update')) {
            const body = JSON.parse(init.body!);
            edits.push(body);
            return answer({ success: true, post: { id: body.id, title: body.title ?? 'A listing', description: '' } });
        }
        return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
    });
    (globalThis as any).fetch = fetchMock;
    await getDb();
    sql.exec('DELETE FROM posts');
});

describe('what the node says about a listing lands in the copy, on each way in', () => {
    it('the sync, for each kind of listing: the ids, space-separated, and handed back with the listing on every read', async () => {
        await applyDelta({ posts: [
            listing('offer-1', { tags: [LEMON, EGGS] }),
            listing('need-1', { type: 'need', tags: [EGGS] }),
            listing('event-1', { type: 'event', tags: [LEMON], eventStartAt: '2026-11-01T01:00:00.000Z' }),
            listing('ent-1', { authorPublicKey: ENTERPRISE, tags: [EGGS] }),
            listing('mine-1', { authorPublicKey: ME, tags: [LEMON] }),
        ] });
        expect(stored('offer-1')).toBe(`${LEMON} ${EGGS}`);
        expect(stored('need-1')).toBe(EGGS);
        expect(stored('event-1')).toBe(LEMON);
        expect(stored('ent-1')).toBe(EGGS);
        // What an edit form opens from: getPost, and the lists a member reaches a listing through.
        expect(postTagsOf((await getPost('offer-1')).tags)).toEqual([LEMON, EGGS]);
        expect(postTagsOf((await getPost('ent-1')).tags)).toEqual([EGGS]);
        expect(eventEditValues(await getPost('event-1')).tags).toEqual([LEMON]);
        expect(postTagsOf(((await getPosts()).find((p: any) => p.id === 'need-1') as any).tags)).toEqual([EGGS]);
        expect(postTagsOf(((await getMyPosts(ME)).find((p: any) => p.id === 'mine-1') as any).tags)).toEqual([LEMON]);
        expect(postTagsOf(((await getMemberPosts(ANN)).find((p: any) => p.id === 'offer-1') as any).tags)).toEqual([LEMON, EGGS]);
    });

    it("a copy with none is the node's word: the node names tags only where there are some, so cleared tags clear", async () => {
        await applyDelta({ posts: [listing('L1', { tags: [LEMON] })] });
        await applyDelta({ posts: [listing('L1', { updatedAt: DAY2 })] });
        expect(stored('L1')).toBe('');
    });

    it('a push over /ws carries them too, and a later one that took them off clears them', async () => {
        const push = (post: unknown) => livePostChange({ type: 'post_updated', post });
        await applyDelta({ liveChanges: [push(listing('L1', { tags: [LEMON, EGGS] }))] });
        expect(stored('L1')).toBe(`${LEMON} ${EGGS}`);
        await applyDelta({ liveChanges: [push(listing('L1', { updatedAt: DAY2 }))] });
        expect(stored('L1')).toBe('');
    });

    it("opening a listing whose tags alone changed stores them and tells the screen to reload (the row's other fields did not move)", async () => {
        await applyDelta({ posts: [listing('L1')] });
        expect(stored('L1')).toBe('');
        emitted.length = 0;
        fetchMock.mockResolvedValue(answer([listing('L1', { tags: [LEMON] })]));
        await getPost('L1');
        await vi.waitFor(() => expect(stored('L1')).toBe(LEMON));
        await vi.waitFor(() => expect(emitted).toContain('sync_data_updated'));
    });

    it('opening one again with nothing new tells no screen: post screens reload on the event and read again, so it would loop', async () => {
        await applyDelta({ posts: [listing('L1', { tags: [LEMON, EGGS] })] });
        emitted.length = 0;
        fetchMock.mockResolvedValue(answer([listing('L1', { tags: [LEMON, EGGS] })]));
        await getPost('L1');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        expect(emitted).not.toContain('sync_data_updated');
    });
});

describe('a copy from before the column', () => {
    /** The previous build's table: the same, without the column. */
    async function reopenedFromBeforeTags() {
        await closeDB();
        sql.exec('ALTER TABLE posts DROP COLUMN tags');
        vi.mocked(AsyncStorage.multiRemove).mockClear();
        await getDb();
    }

    it('gains it on open with its rows kept, and forgets every sync cursor, so the node sends the tags of listings that did not change', async () => {
        await applyDelta({ posts: [listing('L1')] });
        await reopenedFromBeforeTags();
        expect(stored('L1')).toBe('');
        expect((await getPost('L1')).title).toBe('Listing L1');
        // Every cursor: a delta from a kept one would never send a listing that has not changed since.
        expect(vi.mocked(AsyncStorage.multiRemove)).toHaveBeenCalledWith(syncCursorKeysOf('beanpool_valley.example.org.db'));
    });

    it('asks for that read now rather than at the next timer', async () => {
        await applyDelta({ posts: [listing('L1')] });
        await reopenedFromBeforeTags();
        expect(syncsAsked).toEqual(['sync']);
    });

    it('that whole read fills the rows, though no listing changed: the same updatedAt is written over', async () => {
        await applyDelta({ posts: [listing('L1')] });
        await reopenedFromBeforeTags();
        await applyDelta({ posts: [listing('L1', { tags: [LEMON, EGGS] })] });
        expect(stored('L1')).toBe(`${LEMON} ${EGGS}`);
    });

    it('a fresh copy forgets nothing: it has the column and no cursor', async () => {
        await getDb();
        vi.mocked(AsyncStorage.multiRemove).mockClear();
        await closeDB();
        await getDb();
        expect(vi.mocked(AsyncStorage.multiRemove)).not.toHaveBeenCalled();
        expect(syncsAsked).toEqual([]);
    });
});

describe("the phone's own writes", () => {
    const edit = { type: 'offer', category: 'food', title: 'Lemons', description: '', credits: 5, price_type: 'fixed', repeatable: false, photos: null };

    it('a create keeps what the member chose', async () => {
        fetchMock.mockImplementation(async () => answer({ success: true, post: { id: 'new-1' } }));
        await createPost({ id: 'new-1', type: 'offer', category: 'food', title: 'Lemons', description: '', credits: 5, author_pubkey: ME, created_at: DAY1, tags: [LEMON] });
        expect(stored('new-1')).toBe(LEMON);
    });

    it('an edit that names no tags sends none, and the copy keeps them', async () => {
        await applyDelta({ posts: [listing('L1', { tags: [LEMON, EGGS] })] });
        await updatePost('L1', edit);
        expect(edits).toHaveLength(1);
        expect(edits[0]).not.toHaveProperty('tags');
        expect(stored('L1')).toBe(`${LEMON} ${EGGS}`);
    });

    it('an edit that names them sends them and the copy follows; the empty list clears them', async () => {
        await applyDelta({ posts: [listing('L1', { tags: [LEMON, EGGS] })] });
        await updatePost('L1', { ...edit, tags: [EGGS] });
        expect(edits[0].tags).toEqual([EGGS]);
        expect(stored('L1')).toBe(EGGS);
        await updatePost('L1', { ...edit, tags: [] });
        expect(edits[1].tags).toEqual([]);
        expect(stored('L1')).toBe('');
    });

    it("an event's edit that left the tags alone sends none, and the copy keeps them", async () => {
        await applyDelta({ posts: [listing('E1', { type: 'event', tags: [LEMON], eventStartAt: '2026-11-01T01:00:00.000Z' })] });
        await updateEvent('E1', { title: 'New name' });
        expect(edits).toHaveLength(1);
        expect(edits[0]).not.toHaveProperty('tags');
        expect(stored('E1')).toBe(LEMON);
    });

    it("an event's edit that cleared them sends the empty list and the copy clears", async () => {
        await applyDelta({ posts: [listing('E1', { type: 'event', tags: [LEMON], eventStartAt: '2026-11-01T01:00:00.000Z' })] });
        await updateEvent('E1', { tags: [] });
        expect(edits[0].tags).toEqual([]);
        expect(stored('E1')).toBe('');
    });
});
