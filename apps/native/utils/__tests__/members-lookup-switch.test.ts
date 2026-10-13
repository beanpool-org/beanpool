import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// A card read by key (the public profile) or kept from a search (New message) on one community is written only into that
// community's copy: when the member switches community while the answer is on its way, nothing lands in the other copy
// (the deciding review of #1859, NB3: a profile opened on global put global's name on mullum's card for that key). Each
// community's copy is its own in-memory SQLite, opened by file name as the phone opens them.
const dbs = new Map<string, DatabaseSync>();
const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
function adapterFor(name: string) {
    let sql = dbs.get(name);
    if (!sql) { sql = new DatabaseSync(':memory:'); dbs.set(name, sql); }
    const s = sql;
    return {
        runAsync: async (q: string, p?: unknown) => { const r = s.prepare(q).run(...params(p)); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
        execAsync: async (q: string) => { s.exec(q); },
        getAllAsync: async (q: string, p?: unknown) => s.prepare(q).all(...params(p)),
        getFirstAsync: async (q: string, p?: unknown) => s.prepare(q).get(...params(p)) ?? null,
        closeAsync: async () => {},
        withTransactionAsync: async (cb: () => Promise<void>) => { await cb(); },
    };
}
const store = new Map<string, string>();
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async (name: string) => adapterFor(name)) }));
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
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/', getInfoAsync: vi.fn().mockResolvedValue({ exists: false }), makeDirectoryAsync: vi.fn().mockResolvedValue(undefined), writeAsStringAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'e'.repeat(64), privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')), addSavedNode: vi.fn(async () => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

import { getDb } from '../db';
import { fetchCardByKey, keepCards, lookUpMembers } from '../members-lookup';

const GLOBAL = 'https://global.example';
const LOCAL = 'https://mullum.example';
const K = '5'.repeat(64);
const callsignIn = (file: string) => (dbs.get(file)!.prepare('SELECT callsign FROM members WHERE public_key = ?').get(K) as any)?.callsign;
const answer = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

beforeEach(async () => {
    store.set('beanpool_anchor_url', GLOBAL);
    await getDb();
    store.set('beanpool_anchor_url', LOCAL);
    const local = await getDb();
    await local.runAsync('DELETE FROM members');
    await local.runAsync('INSERT INTO members (public_key, callsign, joined_at) VALUES (?, ?, ?)', [K, 'KayOnMullum', '2026-01-01T00:00:00.000Z']);
    store.set('beanpool_anchor_url', GLOBAL);
    await (await getDb()).runAsync('DELETE FROM members');
});

describe('a card by key, and the community switched to while it was on its way', () => {
    it('the profile\'s fetch by key writes nothing into the community switched to', async () => {
        (globalThis as any).fetch = vi.fn(async () => {
            // The member switches to the local community while global's answer is on its way (use-communities switchTo).
            store.set('beanpool_anchor_url', LOCAL);
            await getDb();
            return answer([{ publicKey: K, callsign: 'NameOnGlobal', avatarUrl: null, profileUpdatedAt: '2026-10-01T00:00:00.000Z' }]);
        });
        expect(await fetchCardByKey(K)).toBe('unreachable');
        expect(callsignIn('beanpool_mullum.example.db')).toBe('KayOnMullum');
        expect(callsignIn('beanpool_global.example.db')).toBeUndefined();
    });

    it('a card kept from a search on global is not written into the community switched to before the tap', async () => {
        (globalThis as any).fetch = vi.fn(async () => answer([{ publicKey: K, callsign: 'NameOnGlobal', avatarUrl: null }]));
        const rows = await lookUpMembers('/api/members?q=Na&limit=20');
        expect(rows).toHaveLength(1);
        store.set('beanpool_anchor_url', LOCAL);
        await getDb();
        await keepCards(rows!);
        expect(callsignIn('beanpool_mullum.example.db')).toBe('KayOnMullum');
    });

    it('with no switch, both land in the copy they were read for', async () => {
        (globalThis as any).fetch = vi.fn(async () => answer([{ publicKey: K, callsign: 'NameOnGlobal', avatarUrl: null }]));
        expect(await fetchCardByKey(K)).toBe('fetched');
        expect(callsignIn('beanpool_global.example.db')).toBe('NameOnGlobal');
        expect(callsignIn('beanpool_mullum.example.db')).toBe('KayOnMullum');
    });
});
