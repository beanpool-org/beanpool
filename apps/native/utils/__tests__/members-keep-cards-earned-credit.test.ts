import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// A card kept from a New Message search result (utils/members-lookup.ts keepCards, called from app/new-message.tsx) keeps
// the member's earned credit, in whole hundredths, as the node sent it. keepCards hands applyDelta the phone's own held
// rows (asHeldRow), which carry the figure as the copy's earned_credit_c, not the node's earnedCredit; M2 read only the
// node's key, so keeping a card wrote 0 over it and People's "trusted" sort put that member last (review of #3042,
// inline at utils/db.ts:4504; measured 20000 -> 0). Real SQL against the phone's real schema: getDb() runs the app's own
// _doInitDB over this in-memory database, device modules stubbed at the boundary as in members-old-column-drop.test.ts.

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
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? ANCHOR : null)),
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me'.padEnd(64, '0'), privateKey: '11'.repeat(32), callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { applyDelta, getDb } from '../db';
import { asHeldRow, keepCards } from '../members-lookup';

const KOFI = 'b'.repeat(64);
const AMA = 'c'.repeat(64);
const earned = (key: string) =>
    (sql.prepare('SELECT earned_credit_c FROM members WHERE public_key = ?').get(key) as { earned_credit_c: number } | undefined)?.earned_credit_c;

beforeEach(async () => {
    await getDb(); // the phone's schema in place
    sql.exec('DELETE FROM members');
});

describe('a card kept from a search result keeps its earned credit', () => {
    it('a card the phone holds (200 Beans earned) still reads 20000 hundredths after keepCards', async () => {
        // The directory read the phone held the card from: the node's earnedCredit, in hundredths.
        await applyDelta({ members: [{ publicKey: KOFI, callsign: 'Kofi', earnedCredit: 20000 }] });
        expect(earned(KOFI)).toBe(20000);
        // The search answer the New Message screen shows is that row as a held card, and the member starts a DM from it.
        const card = asHeldRow({ publicKey: KOFI, callsign: 'Kofi', earnedCredit: 20000 });
        expect(card).toMatchObject({ public_key: KOFI, earned_credit_c: 20000 });
        expect(card).not.toHaveProperty('earnedCredit');
        await keepCards([card]);
        expect(earned(KOFI)).toBe(20000);
    });

    it('a card the phone never held is kept with the figure the search answered, to the hundredth (1,234.56)', async () => {
        const card = asHeldRow({ publicKey: AMA, callsign: 'Ama', earnedCredit: 123456 });
        await keepCards([card]);
        expect(earned(AMA)).toBe(123456);
    });

    it('a card with no figure is kept at 0, and the node\'s own key still wins over a held row\'s', async () => {
        await keepCards([asHeldRow({ publicKey: AMA, callsign: 'Ama' })]);
        expect(earned(AMA)).toBe(0);
        await applyDelta({ members: [{ publicKey: KOFI, callsign: 'Kofi', earnedCredit: 4925, earned_credit_c: 1 }] });
        expect(earned(KOFI)).toBe(4925);
    });

    it('a figure that is not whole hundredths writes 0, from either key', async () => {
        await applyDelta({ members: [{ publicKey: KOFI, callsign: 'Kofi', earned_credit_c: 12.5 }] });
        expect(earned(KOFI)).toBe(0);
        await applyDelta({ members: [{ publicKey: AMA, callsign: 'Ama', earnedCredit: '200' }] });
        expect(earned(AMA)).toBe(0);
    });
});
