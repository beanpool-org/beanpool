import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// A phone told "busy" on its members read (review of PR #1656, r4186464776). Since then a members delta from a cursor
// older than the node's avatarKeysSince is answered with the whole directory (the faces heal: apps/server
// engine/avatar-keys.ts) under the heavy-read cap, which answers 503 `heavy_read_busy` when there is no room. The phone
// applied nothing and still moved its cursor at the end of the cycle, so its next members delta came from after
// avatarKeysSince and got a plain delta: the faces it held stayed broken until the hourly whole read. A members read that
// did not land now leaves the members cursor where that read asked from, and the next sync asks again from there. The
// posts cursor (kLastSync) moves as before: a photo heal's next page (engine/photo-keys.ts) is not held back by the
// members read. performSync runs against a stubbed node, writing the phone's real schema in an in-memory SQLite, with
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
// applyDelta as it is, except that the next early write can be made to find another community open (the member switched
// while it waited for the sync lock), so it writes nothing: the posts-unwritten case, whose cursor already stays.
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { applyDelta, getDb } from '../db';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';

const DB = 'beanpool_a.beanpool.org.db';
const KEY = (id: string) => `pillar_sync_${DB}_${id}`;
const LAST_SYNC_KEY = KEY('last-sync');
const MEMBERS_LAST_SYNC_KEY = KEY('members_last_sync');
/** When the last cycle completed, for display only (pillar-sync getLastSyncTime): written by every cycle that lands. */
const LAST_CYCLE_KEY = KEY('last-cycle');
const ANN = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const OPEN_FACE = (pk: string) => `/api/avatar/${pk}?v=1790000000000`;
const KEYED_FACE = (pk: string) => `${OPEN_FACE(pk)}&k=${'K'.repeat(22)}`;
const cursorOf = (ms: number) => new Date(Math.max(0, ms - 300_000)).toISOString();

function listing(id: string) {
    return {
        id, type: 'offer', category: 'food', title: `Listing ${id}`, description: '', credits: 5, priceType: 'fixed',
        authorPublicKey: ANN, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        active: true, status: 'active', audienceScope: 'public', photos: [],
    };
}

// The node, a few minutes after a restart that keyed its faces: a members delta from before avatarKeysSince is the
// whole directory with the keyed URLs (the heal), or 503 heavy_read_busy while the cap has no room; a newer one is
// a plain delta (nothing changed). `members` says how the next members reads go: 'busy', 'offline' (the request throws),
// 'garbled' (200 with a body that is no list), or 'ok'.
const node = {
    avatarKeysSince: '',
    members: 'ok' as 'ok' | 'busy' | 'offline' | 'garbled',
    wholeMembers: 'ok' as 'ok' | 'busy',
    postsPulls: [] as string[],
    membersDeltas: [] as string[],
    wholeReads: 0,
    calls: 0,
};
function answer(status: number, body: string, headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300, status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        text: async () => body, json: async () => JSON.parse(body),
    };
}
const busy = () => answer(503, JSON.stringify({ error: 'This community is busy right now. Please try again in a moment.', code: 'heavy_read_busy' }), { 'retry-after': '10' });
const directory = () => JSON.stringify([
    { publicKey: ANN, callsign: 'Ann', avatarUrl: KEYED_FACE(ANN) },
    { publicKey: BOB, callsign: 'Bob', avatarUrl: KEYED_FACE(BOB) },
]);
const fetchMock = vi.fn(async (url: string) => {
    node.calls++;
    if (url.includes('/api/marketplace/posts')) {
        node.postsPulls.push(new URL(url).searchParams.get('updatedAfter') ?? '');
        return answer(200, JSON.stringify([listing('L1')]));
    }
    if (url.includes('/api/members')) {
        const after = new URL(url).searchParams.get('updatedAfter');
        if (after === null) {
            node.wholeReads++;
            return node.wholeMembers === 'busy' ? busy() : answer(200, directory());
        }
        node.membersDeltas.push(after);
        if (node.members === 'busy') return busy();
        if (node.members === 'offline') throw new TypeError('Network request failed');
        if (node.members === 'garbled') return answer(200, JSON.stringify({ error: 'not a list' }));
        return answer(200, after < node.avatarKeysSince ? directory() : '[]');
    }
    return answer(404, '');
});

const faceOf = (pk: string) => (sql.prepare('SELECT avatar_url FROM members WHERE public_key = ?').get(pk) as any)?.avatar_url;
let t0 = 0;

beforeEach(async () => {
    store.clear();
    store.set('beanpool_anchor_url', A_URL);
    resetSyncFingerprints();
    gate.switchBeforeNextWrite = false;
    vi.mocked(AsyncStorage.setItem).mockClear();
    vi.mocked(AsyncStorage.removeItem).mockClear();
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['posts', 'marketplace_transactions', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
    // The phone holds a listing and both members with their faces as they were before the node keyed them. It last
    // synced 20 minutes ago and read the whole directory 30 minutes ago, so this cycle reads the members delta.
    await applyDelta({ posts: [listing('L1')], members: [
        { publicKey: ANN, callsign: 'Ann', avatarUrl: OPEN_FACE(ANN) },
        { publicKey: BOB, callsign: 'Bob', avatarUrl: OPEN_FACE(BOB) },
    ] }, DB);
    t0 = Date.now() - 20 * 60_000;
    store.set(LAST_SYNC_KEY, String(t0));
    store.set(MEMBERS_LAST_SYNC_KEY, String(Date.now() - 30 * 60_000));
    Object.assign(node, {
        // The restart that keyed the faces: 10 minutes ago, after the phone's last sync.
        avatarKeysSince: new Date(Date.now() - 10 * 60_000).toISOString(),
        members: 'ok', wholeMembers: 'ok', postsPulls: [], membersDeltas: [], wholeReads: 0, calls: 0,
    });
});

describe('a members delta the node answered busy', () => {
    it('the next sync asks again from the same cursor, gets the heal, and the faces open', async () => {
        node.members = 'busy';
        const r1 = await performSync();
        expect(r1.success).toBe(true);
        expect(node.membersDeltas).toEqual([cursorOf(t0)]);
        expect(faceOf(ANN)).toBe(OPEN_FACE(ANN));

        node.members = 'ok';
        const r2 = await performSync();
        expect(r2.success).toBe(true);
        // The same cursor as the busy read, from before avatarKeysSince: the node answers it with the whole directory.
        expect(node.membersDeltas[1]).toBe(cursorOf(t0));
        expect(faceOf(ANN)).toBe(KEYED_FACE(ANN));
        expect(faceOf(BOB)).toBe(KEYED_FACE(BOB));
    });

    it('the posts cursor (kLastSync) moves as before: only the members read is asked again', async () => {
        node.members = 'busy';
        const before = Date.now();
        await performSync();
        const moved = Number(store.get(LAST_SYNC_KEY));
        expect(moved).toBeGreaterThanOrEqual(before);

        await performSync();
        expect(node.postsPulls).toEqual([cursorOf(t0), cursorOf(moved)]);
        expect(node.membersDeltas).toEqual([cursorOf(t0), cursorOf(t0)]);
    });

    it('busy on every sync: held at the first busy read, never further back, and the same requests each cycle', async () => {
        node.members = 'busy';
        const counts: number[] = [];
        for (let i = 0; i < 3; i++) {
            const callsBefore = node.calls;
            expect((await performSync()).success).toBe(true);
            counts.push(node.calls - callsBefore);
        }
        expect(node.membersDeltas).toEqual([cursorOf(t0), cursorOf(t0), cursorOf(t0)]);
        expect(node.wholeReads).toBe(0);

        // A cycle whose members read lands makes the same requests as one told busy: holding asks again, never more.
        node.members = 'ok';
        const callsBefore = node.calls;
        expect((await performSync()).success).toBe(true);
        counts.push(node.calls - callsBefore);
        expect(new Set(counts).size).toBe(1);
        expect(faceOf(ANN)).toBe(KEYED_FACE(ANN));
    });

    it('once the held read lands, the hold goes: the next delta comes from the cursor of the last sync', async () => {
        node.members = 'busy';
        await performSync();
        node.members = 'ok';
        await performSync();
        const landedAt = Number(store.get(LAST_SYNC_KEY));
        await performSync();
        expect(node.membersDeltas).toEqual([cursorOf(t0), cursorOf(t0), cursorOf(landedAt)]);
        expect([...store.keys()].filter(k => k.startsWith(`pillar_sync_${DB}_`)).sort())
            .toEqual([LAST_SYNC_KEY, MEMBERS_LAST_SYNC_KEY, LAST_CYCLE_KEY].sort());
    });
});

describe('other members reads that did not land hold the same way', () => {
    it('a network error on the members delta', async () => {
        node.members = 'offline';
        expect((await performSync()).success).toBe(true);
        node.members = 'ok';
        expect((await performSync()).success).toBe(true);
        expect(node.membersDeltas).toEqual([cursorOf(t0), cursorOf(t0)]);
        expect(faceOf(ANN)).toBe(KEYED_FACE(ANN));
    });

    it('an answer the phone could not apply (200 with no list in it), even when the next answer is the same bytes', async () => {
        node.members = 'garbled';
        expect((await performSync()).success).toBe(true);
        expect((await performSync()).success).toBe(true);
        node.members = 'ok';
        expect((await performSync()).success).toBe(true);
        expect(node.membersDeltas).toEqual([cursorOf(t0), cursorOf(t0), cursorOf(t0)]);
        expect(faceOf(ANN)).toBe(KEYED_FACE(ANN));
    });

    it('the hourly whole directory answered busy: its own clock stays, and the next sync reads it whole again', async () => {
        store.set(MEMBERS_LAST_SYNC_KEY, String(Date.now() - 2 * 60 * 60_000));
        const heldClock = store.get(MEMBERS_LAST_SYNC_KEY);
        node.wholeMembers = 'busy';
        expect((await performSync()).success).toBe(true);
        expect(store.get(MEMBERS_LAST_SYNC_KEY)).toBe(heldClock);
        node.wholeMembers = 'ok';
        expect((await performSync()).success).toBe(true);
        expect(node.wholeReads).toBe(2);
        expect(node.membersDeltas).toEqual([]);
        expect(faceOf(ANN)).toBe(KEYED_FACE(ANN));
    });

    it('a busy delta, then the whole directory read that lands: the hold goes with it', async () => {
        node.members = 'busy';
        await performSync();
        // An hour on: the hourly whole read is due, and it lands.
        store.set(MEMBERS_LAST_SYNC_KEY, String(Date.now() - 2 * 60 * 60_000));
        node.members = 'ok';
        await performSync();
        expect(node.wholeReads).toBe(1);
        expect(faceOf(ANN)).toBe(KEYED_FACE(ANN));
        const landedAt = Number(store.get(LAST_SYNC_KEY));
        await performSync();
        expect(node.membersDeltas).toEqual([cursorOf(t0), cursorOf(landedAt)]);
    });
});

describe('a members read that lands, as on main', () => {
    it('kLastSync moves to the end of the cycle, the delta asks from the cursor of the last sync, and no other cursor is written', async () => {
        const before = Date.now();
        expect((await performSync()).success).toBe(true);
        const after = Date.now();
        expect(node.membersDeltas).toEqual([cursorOf(t0)]);
        const moved = Number(store.get(LAST_SYNC_KEY));
        expect(moved).toBeGreaterThanOrEqual(before);
        expect(moved).toBeLessThanOrEqual(after);
        expect(faceOf(ANN)).toBe(KEYED_FACE(ANN));
        // What the cycle wrote and removed in AsyncStorage: the cursor and the checkpoint, as on main, and the time shown.
        const written = vi.mocked(AsyncStorage.setItem).mock.calls.map(([k]) => k).filter(k => k.startsWith('pillar_sync_'));
        const removed = vi.mocked(AsyncStorage.removeItem).mock.calls.map(([k]) => k).filter(k => k.startsWith('pillar_sync_'));
        expect(written).toEqual([LAST_SYNC_KEY, LAST_CYCLE_KEY]);
        expect(removed).toEqual([KEY('checkpoint')]);

        await performSync();
        expect(node.membersDeltas).toEqual([cursorOf(t0), cursorOf(moved)]);
    });
});

describe('posts unwritten and the members read busy, in the same cycle', () => {
    it('both cursors stay: the next sync pulls the posts whole again and asks for the members from the same cursor', async () => {
        // An empty listings cache with a cursor: the posts are pulled whole and written early, which the switch skips.
        sql.exec('DELETE FROM posts');
        gate.switchBeforeNextWrite = true;
        node.members = 'busy';
        expect((await performSync()).success).toBe(true);
        expect(store.get(LAST_SYNC_KEY)).toBe(String(t0));

        node.members = 'ok';
        expect((await performSync()).success).toBe(true);
        expect(node.postsPulls).toEqual(['', '']);
        expect(node.membersDeltas).toEqual([cursorOf(t0), cursorOf(t0)]);
        expect(faceOf(ANN)).toBe(KEYED_FACE(ANN));
        expect((sql.prepare('SELECT COUNT(*) AS n FROM posts').get() as any).n).toBe(1);
    });
});
