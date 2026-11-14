/**
 * getBalance's `lineKnown` (utils/db.ts; round 2 of #3134): whether the node's figures for the member's credit line are on
 * this phone. Without them getBalance answers floor 0, which is "not known yet", never "no credit line": the Ledger's card
 * waits for the node (or says it couldn't be read) instead of telling a member with a line that they have none. Real SQL
 * against the phone's real schema, device modules stubbed at the boundary as in copy-schema-clear.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

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
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { for (const k of keys) store.delete(k); }),
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me'.padEnd(64, '0'), privateKey: '11'.repeat(32), callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { getBalance } from '../db';

// Nothing here reaches a network: getBalance's own read of the node finds the phone offline, so only the cache counts.
(globalThis as any).fetch = vi.fn(async () => { throw new TypeError('offline'); });

const ME = 'me'.padEnd(64, '0');

beforeEach(() => {
    store.clear();
    store.set('beanpool_anchor_url', ANCHOR);
});

describe('getBalance says whether the member\'s line is known on this phone', () => {
    it('a first open, nothing from the node kept yet: floor 0, and the line is not known', async () => {
        const answer = await getBalance(ME);
        expect(answer.floor_c).toBe(0);
        expect(answer.lineKnown).toBe(false);
    });

    it('the node\'s figures kept (refreshBalanceFromServer\'s cache): the line is known, a line of 0 included', async () => {
        store.set(`bp_tier_${ME}`, JSON.stringify({ tier: { name: 'Newcomer', emoji: '🌱' }, floor_c: -50000, usableFloor_c: -50000, roomHeld_c: 50000, liveOffers: 1 }));
        expect(await getBalance(ME)).toMatchObject({ floor_c: -50000, lineKnown: true });
        store.set(`bp_tier_${ME}`, JSON.stringify({ tier: { name: 'Newcomer', emoji: '🌱' }, floor_c: 0 }));
        expect(await getBalance(ME)).toMatchObject({ floor_c: 0, lineKnown: true });
    });

    it('a cache from before hundredths (no floor_c) or one that can\'t be read: not known, never "no line"', async () => {
        store.set(`bp_tier_${ME}`, JSON.stringify({ tier: { name: 'Resident', emoji: '🏠' }, floor: -500 }));
        expect(await getBalance(ME)).toMatchObject({ floor_c: 0, lineKnown: false });
        store.set(`bp_tier_${ME}`, '{not json');
        expect((await getBalance(ME)).lineKnown).toBe(false);
    });
});
