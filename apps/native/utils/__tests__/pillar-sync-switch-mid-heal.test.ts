import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// A sync cycle that read the node's answer and then wrote nothing, because the member switched community during it
// (review of PR #1340 at fe4c27ce, finding 2). The node sends the same answer, byte for byte, to the same cursor (a
// photo heal's page, apps/server engine/photo-keys.ts): the phone's next cycle must write it, and must not move its
// cursor past it. performSync runs against a stubbed node, writing the phone's real schema in an in-memory SQLite, with
// AsyncStorage kept in a map so cursors last from one cycle to the next.

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

const A_URL = 'https://a.beanpool.org';
const B_URL = 'https://b.beanpool.org';
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
// applyDelta as it is, except that the next sync's write can be made to find another community open (its guard: the
// member switched after the cycle's own check, while the write waited for the sync lock), so it writes nothing.
const gate = { switchBeforeNextWrite: false };
vi.mock('../db', async (importOriginal) => {
    const real = await importOriginal<typeof import('../db')>();
    return {
        ...real,
        applyDelta: vi.fn(async (delta: any, expectedDbName?: string) => {
            if (gate.switchBeforeNextWrite && expectedDbName) {
                gate.switchBeforeNextWrite = false;
                return false;
            }
            return real.applyDelta(delta, expectedDbName);
        }),
    };
});

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

import { applyDelta, getDb } from '../db';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';

const ANN = 'a'.repeat(64);
const LAST_SYNC_KEY = 'pillar_sync_beanpool_a.beanpool.org.db_last-sync';
const KEYLESS = (id: string) => `/api/marketplace/posts/${id}/photos/0?v=1790000000000`;
const KEYED = (id: string) => `${KEYLESS(id)}&k=${'K'.repeat(22)}`;

function listing(id: string, photo: string) {
    return {
        id, type: 'offer', category: 'food', title: `Listing ${id}`, description: '', credits: 5, priceType: 'fixed',
        authorPublicKey: ANN, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        active: true, status: 'active', audienceScope: 'public', photos: [photo],
    };
}

// The node: a heal's pages as the server answers one phone on its key. The phone's old cursor gets page 1 (L1 keyed),
// and it again, byte for byte, while that cursor is sent; a newer cursor gets page 2 (L2 keyed).
const node = { firstCursor: '', page1: '', page2: '', switchOnMembers: false, pulls: [] as string[] };
function answer(status: number, body: string) {
    return {
        ok: status >= 200 && status < 300, status,
        headers: { get: (_: string) => null },
        text: async () => body, json: async () => JSON.parse(body),
    };
}
const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/api/marketplace/posts')) {
        const cursor = new URL(url).searchParams.get('updatedAfter') ?? '';
        node.pulls.push(cursor);
        return answer(200, cursor === node.firstCursor ? node.page1 : node.page2);
    }
    if (url.includes('/api/members')) {
        // The member switches community while this cycle is out (Settings, another community's invite).
        if (node.switchOnMembers) store.set('beanpool_anchor_url', B_URL);
        return answer(200, '[]');
    }
    return answer(404, '');
});

const photoOf = (id: string) => JSON.parse((sql.prepare('SELECT photos FROM posts WHERE id = ?').get(id) as any)?.photos ?? '[]')[0];
let t0 = 0;

beforeEach(async () => {
    store.clear();
    store.set('beanpool_anchor_url', A_URL);
    resetSyncFingerprints();
    gate.switchBeforeNextWrite = false;
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['posts', 'marketplace_transactions', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
    // The phone holds both listings with the URLs from before the node keyed its photos, and a cursor from before.
    await applyDelta({ posts: [listing('L1', KEYLESS('L1')), listing('L2', KEYLESS('L2'))] }, 'beanpool_a.beanpool.org.db');
    t0 = Date.now() - 60 * 60 * 1000;
    store.set(LAST_SYNC_KEY, String(t0));
    Object.assign(node, {
        firstCursor: new Date(t0 - 300_000).toISOString(),
        page1: JSON.stringify([listing('L1', KEYED('L1'))]),
        page2: JSON.stringify([listing('L2', KEYED('L2'))]),
        switchOnMembers: false, pulls: [],
    });
});

describe('a heal page read by a cycle that then wrote nothing', () => {
    it('with no switch, both pages land', async () => {
        expect((await performSync()).success).toBe(true);
        expect((await performSync()).success).toBe(true);
        expect(photoOf('L1')).toBe(KEYED('L1'));
        expect(photoOf('L2')).toBe(KEYED('L2'));
    });

    it('a switch found before the write: the next cycle on the community writes the same page again, then the next', async () => {
        node.switchOnMembers = true;
        const r1 = await performSync();
        expect(r1.aborted).toBe(true);
        expect(store.get(LAST_SYNC_KEY)).toBe(String(t0));
        expect(photoOf('L1')).toBe(KEYLESS('L1'));

        // Back on community A: the same cursor, so the node sends the same page byte for byte, and it is written.
        node.switchOnMembers = false;
        store.set('beanpool_anchor_url', A_URL);
        const r2 = await performSync();
        expect(r2.success).toBe(true);
        expect(node.pulls[1]).toBe(node.pulls[0]);
        expect(photoOf('L1')).toBe(KEYED('L1'));

        const r3 = await performSync();
        expect(r3.success).toBe(true);
        expect(node.pulls[2]).not.toBe(node.firstCursor);
        expect(photoOf('L2')).toBe(KEYED('L2'));
    });

    it('a switch that lands between that check and the batch write (applyDelta writes nothing): the cursor stays, and the page is written next', async () => {
        gate.switchBeforeNextWrite = true;
        const r1 = await performSync();
        expect(r1.success).toBe(false);
        expect(r1.aborted).toBe(true);
        expect(store.get(LAST_SYNC_KEY)).toBe(String(t0));
        expect(photoOf('L1')).toBe(KEYLESS('L1'));

        const r2 = await performSync();
        expect(r2.success).toBe(true);
        expect(node.pulls[1]).toBe(node.firstCursor);
        expect(photoOf('L1')).toBe(KEYED('L1'));

        const r3 = await performSync();
        expect(r3.success).toBe(true);
        expect(photoOf('L2')).toBe(KEYED('L2'));
    });

    it('a whole pull whose early write finds another community open: no cursor is set, and the next cycle writes it', async () => {
        // An empty cache and no cursor: the cycle pulls whole and writes the posts early, which the switch skips.
        sql.exec('DELETE FROM posts');
        store.delete(LAST_SYNC_KEY);
        gate.switchBeforeNextWrite = true;
        const r1 = await performSync();
        expect(r1.success).toBe(true);
        expect(store.get(LAST_SYNC_KEY)).toBeUndefined();
        expect(photoOf('L2')).toBeUndefined();

        const r2 = await performSync();
        expect(r2.success).toBe(true);
        expect(node.pulls[1]).toBe('');
        expect(photoOf('L2')).toBe(KEYED('L2'));
        expect(store.get(LAST_SYNC_KEY)).toBeDefined();
    });
});
