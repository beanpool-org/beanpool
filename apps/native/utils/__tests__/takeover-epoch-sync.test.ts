import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// A phone that synced from the main server before a take-over (scratch/global-node/DESIGN-standby-takeover-gaps-opus.md
// §2 "G7"). The promoted standby never had what the old server wrote after its last copy, so the node's sync reads
// carry its identity epoch (X-BeanPool-Epoch) and a phone that sees it change replaces what it holds with a whole sync
// (services/pillar-sync.ts). performSync runs against a stubbed node, writing the phone's real schema in an in-memory
// SQLite, with AsyncStorage kept in a map so cursors and the stored epoch last from one cycle to the next.

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
const store = new Map<string, string>();
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) store.delete(k); }),
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

import { applyDelta, getDb } from '../db';
import { applyLivePostChange, performSync, resetSyncFingerprints } from '../../services/pillar-sync';
import { livePostChange } from '@beanpool/core';

const ANN = 'a'.repeat(64);
const KEY = (id: string) => `pillar_sync_beanpool_test.beanpool.org.db_${id}`;
const EPOCH_KEY = KEY('identity-epoch');
const LAST_SYNC_KEY = KEY('last-sync');

function listing(id: string, title: string, updatedAt: string, extra: Record<string, unknown> = {}) {
    return {
        id, type: 'offer', category: 'food', title, description: '', credits: 5, priceType: 'fixed',
        authorPublicKey: ANN, createdAt: '2026-09-01T00:00:00.000Z', updatedAt,
        active: true, status: 'active', audienceScope: 'public', ...extra,
    };
}
const A = listing('post-a', 'Spare lemons', '2026-09-20T01:00:00.000Z');
const B = listing('post-b', 'Bike pump', '2026-09-21T01:00:00.000Z');
/** An edit of B made in the tail: the old main server had it, its standby never copied it. */
const B_TAIL = listing('post-b', 'Bike pump (and the tyre levers)', '2026-09-27T09:59:30.000Z');
/** A listing made in the tail: only the old epoch ever had it. */
const T = listing('post-t', 'Firewood, a trailer load', '2026-09-27T09:59:40.000Z');
/** Made on the new main server after the take-over. */
const N = listing('post-n', 'Seedlings', '2026-09-27T10:05:00.000Z');

/** The node as the phone sees it: its epoch header (null: a node from before this) and its two answers. */
const node = { epoch: null as string | null, whole: [] as any[], delta: [] as any[], postsStatus: 200 };
let requests: string[] = [];

function answer(status: number, body: string, epoch: string | null) {
    return {
        ok: status >= 200 && status < 300, status,
        // The name on the wire (apps/server services/identity-epoch.ts), matched as a platform's headers match it.
        headers: { get: (name: string) => (name.toLowerCase() === 'x-beanpool-epoch' ? epoch : null) },
        text: async () => body, json: async () => JSON.parse(body),
    };
}

const fetchMock = vi.fn(async (url: string) => {
    requests.push(url);
    if (url.includes('/api/marketplace/posts')) {
        if (node.postsStatus !== 200) return answer(node.postsStatus, '{"error":"down"}', node.epoch);
        const isDelta = new URL(url).searchParams.has('updatedAfter');
        return answer(200, JSON.stringify(isDelta ? node.delta : node.whole), node.epoch);
    }
    if (url.includes('/api/members')) return answer(200, '[]', null);
    return answer(404, '', null);
});

const titles = () => (sql.prepare('SELECT id, title FROM posts ORDER BY id').all() as any[]).map(r => `${r.id}:${r.title}`);
const postsPulls = () => requests.filter(u => u.includes('/api/marketplace/posts'));
const isDelta = (u: string) => new URL(u).searchParams.has('updatedAfter');

/** One sync cycle, from a clean request log. */
async function sync() {
    requests = [];
    const r = await performSync();
    expect(r.success).toBe(true);
    return r;
}

beforeEach(async () => {
    store.clear();
    store.set('beanpool_anchor_url', ANCHOR);
    resetSyncFingerprints();
    Object.assign(node, { epoch: null, whole: [], delta: [], postsStatus: 200 });
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['posts', 'marketplace_transactions', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
});

/** A phone that synced A and B whole, then the tail (T, and B's edit) as a delta, from a main server at epoch 0. */
async function phoneThatSyncedTheTail() {
    Object.assign(node, { epoch: '0', whole: [B, A] });
    await sync();
    expect(store.get(EPOCH_KEY)).toBe('0');
    Object.assign(node, { delta: [T, B_TAIL] });
    await sync();
    expect(titles()).toEqual(['post-a:Spare lemons', 'post-b:Bike pump (and the tyre levers)', 'post-t:Firewood, a trailer load']);
}

describe('a take-over: the epoch changes, the cursors go, and a whole sync replaces the cache', () => {
    it('drops the tail listing and the tail edit, keeps the rest, and stores the new epoch', async () => {
        await phoneThatSyncedTheTail();

        // The standby took over: it has A and B as it copied them, and a listing made since. Not T, not B's edit.
        Object.assign(node, { epoch: '1', whole: [N, B, A], delta: [N] });
        await sync();

        const pulls = postsPulls();
        expect(pulls).toHaveLength(2);
        expect(isDelta(pulls[0])).toBe(true); // the cycle began as a delta, with the old cursor
        expect(isDelta(pulls[1])).toBe(false); // and pulled the listings whole once it saw the new epoch
        expect(requests.some(u => u.includes('/api/members') && !u.includes('updatedAfter'))).toBe(true); // the whole directory
        expect(titles()).toEqual(['post-a:Spare lemons', 'post-b:Bike pump', 'post-n:Seedlings']);
        expect(store.get(EPOCH_KEY)).toBe('1');

        // The next cycle is a plain delta again.
        Object.assign(node, { delta: [] });
        await sync();
        expect(postsPulls()).toHaveLength(1);
        expect(isDelta(postsPulls()[0])).toBe(true);
        expect(titles()).toEqual(['post-a:Spare lemons', 'post-b:Bike pump', 'post-n:Seedlings']);
    });

    it('a listing past the whole pull\'s page stays: the answer only speaks for what changed after its oldest listing', async () => {
        const OLD = listing('post-old', 'Ladder', '2026-03-01T00:00:00.000Z');
        Object.assign(node, { epoch: '0', whole: [B, A, OLD] });
        await sync();
        Object.assign(node, { delta: [T] });
        await sync();

        // The new server's page ends at A: OLD is older than anything on it, so the answer says nothing about OLD.
        Object.assign(node, { epoch: '1', whole: [B, A], delta: [] });
        await sync();
        expect(titles()).toEqual(['post-a:Spare lemons', 'post-b:Bike pump', 'post-old:Ladder']);
    });

    it('a node that answers no listings at all after the take-over leaves none on the phone', async () => {
        await phoneThatSyncedTheTail();
        Object.assign(node, { epoch: '1', whole: [], delta: [] });
        await sync();
        expect(titles()).toEqual([]);
        expect(store.get(EPOCH_KEY)).toBe('1');
    });

    it('a listing the new server pushes while the whole pull is on its way survives the replace', async () => {
        await phoneThatSyncedTheTail();
        const P = listing('post-p', 'Honey', '2026-09-27T10:06:00.000Z');
        let release!: () => void;
        const held = new Promise<void>(r => { release = r; });
        Object.assign(node, { epoch: '1', whole: [N, B, A], delta: [N] });
        fetchMock.mockImplementationOnce(async (url: string) => { requests.push(url); return answer(200, JSON.stringify(node.delta), node.epoch); });
        fetchMock.mockImplementationOnce(async (url: string) => { requests.push(url); await held; return answer(200, JSON.stringify(node.whole), node.epoch); });

        requests = [];
        const cycle = performSync();
        await new Promise(r => setTimeout(r, 0));
        expect(await applyLivePostChange(livePostChange({ type: 'new_post', post: P as any })!, { anchorUrl: ANCHOR, selfPubkey: null })).toBe(true);
        release();
        expect((await cycle).success).toBe(true);

        expect(titles()).toEqual(['post-a:Spare lemons', 'post-b:Bike pump', 'post-n:Seedlings', 'post-p:Honey']);
    });

    it('when the early write of the whole pull fails, the batch write carries the replace', async () => {
        await phoneThatSyncedTheTail();
        Object.assign(node, { epoch: '1', whole: [N, B, A], delta: [N] });
        adapter.withTransactionAsync.mockImplementationOnce(async () => { throw new Error('database is locked'); });
        await sync();
        expect(titles()).toEqual(['post-a:Spare lemons', 'post-b:Bike pump', 'post-n:Seedlings']);
        expect(store.get(EPOCH_KEY)).toBe('1');
    });

    it('when the whole pull fails, the epoch is not stored, and the next cycle does it again', async () => {
        await phoneThatSyncedTheTail();
        Object.assign(node, { epoch: '1', whole: [N, B, A], delta: [N], postsStatus: 503 });
        requests = [];
        expect((await performSync()).success).toBe(false);
        expect(store.get(EPOCH_KEY)).toBe('0');
        expect(store.has(LAST_SYNC_KEY)).toBe(false); // the old cursor is gone either way

        node.postsStatus = 200;
        await sync();
        expect(titles()).toEqual(['post-a:Spare lemons', 'post-b:Bike pump', 'post-n:Seedlings']);
        expect(store.get(EPOCH_KEY)).toBe('1');
    });
});

describe('the same epoch, or none: nothing changes', () => {
    it('the same epoch → a normal delta: one pull, the cursor kept, nothing dropped', async () => {
        await phoneThatSyncedTheTail();
        const cursorBefore = store.get(LAST_SYNC_KEY);
        Object.assign(node, { epoch: '0', whole: [N, B, A], delta: [N] });
        await sync();

        expect(postsPulls()).toHaveLength(1);
        expect(isDelta(postsPulls()[0])).toBe(true);
        expect(new URL(postsPulls()[0]).searchParams.get('updatedAfter')).toBe(new Date(Number(cursorBefore) - 300_000).toISOString());
        // A delta speaks only for what changed: T and B's edit stay, as they always have.
        expect(titles()).toEqual(['post-a:Spare lemons', 'post-b:Bike pump (and the tyre levers)', 'post-n:Seedlings', 'post-t:Firewood, a trailer load']);
        expect(store.get(EPOCH_KEY)).toBe('0');
    });

    it('no header (a node from before this) → today\'s delta, and no epoch stored', async () => {
        Object.assign(node, { epoch: null, whole: [B, A] });
        await sync();
        Object.assign(node, { delta: [T] });
        await sync();
        Object.assign(node, { whole: [B, A], delta: [] });
        await sync();

        expect(postsPulls()).toHaveLength(1);
        expect(isDelta(postsPulls()[0])).toBe(true);
        expect(titles()).toEqual(['post-a:Spare lemons', 'post-b:Bike pump', 'post-t:Firewood, a trailer load']);
        expect(store.has(EPOCH_KEY)).toBe(false);
    });

    it('a stored epoch and a node that stops sending one (an older server) → a delta, the stored epoch kept', async () => {
        await phoneThatSyncedTheTail();
        Object.assign(node, { epoch: null, whole: [B, A], delta: [] });
        await sync();
        expect(postsPulls()).toHaveLength(1);
        expect(isDelta(postsPulls()[0])).toBe(true);
        expect(titles()).toHaveLength(3);
        expect(store.get(EPOCH_KEY)).toBe('0');
    });

    it('the first epoch a phone sees (a build from before this, cursor and cache in place) is only stored', async () => {
        Object.assign(node, { epoch: null, whole: [B, A] });
        await sync();
        Object.assign(node, { delta: [T] });
        await sync();

        Object.assign(node, { epoch: '1', whole: [B, A], delta: [] });
        await sync();
        expect(postsPulls()).toHaveLength(1);
        expect(isDelta(postsPulls()[0])).toBe(true);
        expect(titles()).toHaveLength(3);
        expect(store.get(EPOCH_KEY)).toBe('1');
    });
});

describe('applyDelta postsReplace: which cached listings the whole pull speaks for', () => {
    const row = (id: string) => sql.prepare('SELECT id FROM posts WHERE id = ?').get(id);

    it('without the flag a whole list removes nothing, as before', async () => {
        await applyDelta({ posts: [A, B, T] });
        await applyDelta({ posts: [A] });
        expect(titles()).toHaveLength(3);
    });

    it('a row the phone wrote itself, with no updated_at yet, is judged by its created_at', async () => {
        await applyDelta({ posts: [A, B] });
        // As createPost leaves them: written once the node accepted them, with no updated_at until a sync brings one.
        await applyDelta({ posts: [
            listing('mine-new', 'Mine, just posted', '', { createdAt: '2026-09-27T09:59:50.000Z' }),
            listing('mine-old', 'Mine, long ago', '', { createdAt: '2026-02-01T00:00:00.000Z' }),
        ] });
        sql.exec(`UPDATE posts SET updated_at = NULL WHERE id IN ('mine-new', 'mine-old')`);
        await applyDelta({ posts: [B, A], postsReplace: true });
        expect(row('mine-new')).toBeUndefined();
        expect(row('mine-old')).toBeTruthy();
        expect(titles()).toEqual(['mine-old:Mine, long ago', 'post-a:Spare lemons', 'post-b:Bike pump']);
    });
});
