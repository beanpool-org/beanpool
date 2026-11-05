import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// The vouching reset (R0, DESIGN-invites-and-names-list-amend2-fable.md §1.2 item 5): the phone's own copy of the members
// table loses the old vouch's "who vouched" column when the app opens it, and keeps everything else. A build from before
// adds the column back, empty, so going back to it is safe. Real SQL against the phone's real schema (getDb() runs the
// app's own _doInitDB over this in-memory database), device modules stubbed at the boundary as in market-banner-cache.test.ts.

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

import { closeDB, getDb } from '../db';

const OLD_COLUMN = 'elder_vouched_by';
const ROSA = 'a'.repeat(64);
const KOFI = 'b'.repeat(64);
const columns = () => (sql.prepare('PRAGMA table_info(members)').all() as { name: string }[]).map((c) => c.name);

describe("the phone's members table after the vouching reset", () => {
    it('a fresh copy never has the old column', async () => {
        await getDb();
        expect(columns()).toContain('callsign');
        expect(columns()).not.toContain(OLD_COLUMN);
    });

    it('a copy from before the reset loses it on open, and keeps every row and every other column', async () => {
        await getDb();
        // The previous build's table: the same, with the column, and a member someone vouched for.
        await closeDB();
        sql.exec(`ALTER TABLE members ADD COLUMN ${OLD_COLUMN} TEXT`);
        sql.prepare(`INSERT INTO members (public_key, callsign, earned_credit, archetype, ${OLD_COLUMN}) VALUES (?, ?, ?, ?, ?)`)
            .run(KOFI, 'Kofi', 200, 'weaver', ROSA);
        const before = columns();
        await getDb();
        expect(columns()).not.toContain(OLD_COLUMN);
        expect(columns()).toEqual(before.filter((c) => c !== OLD_COLUMN));
        expect(sql.prepare('SELECT public_key, callsign, earned_credit, archetype FROM members WHERE public_key = ?').get(KOFI))
            .toEqual({ public_key: KOFI, callsign: 'Kofi', earned_credit: 200, archetype: 'weaver' });
        // Opened again: the drop finds nothing to drop and the open goes on as before.
        await closeDB();
        await getDb();
        expect(columns()).not.toContain(OLD_COLUMN);
    });

    it('a previous build opens the new table: nothing names the column, and its ADD COLUMN brings it back empty', async () => {
        await getDb();
        const named = sql.prepare(`SELECT name FROM sqlite_master WHERE type IN ('trigger', 'index', 'view') AND sql LIKE '%${OLD_COLUMN}%'`).all();
        expect(named).toEqual([]);
        // What that build runs at its open (its db.ts): the column again, NULL on every row, as on a member nobody vouched for.
        sql.exec(`ALTER TABLE members ADD COLUMN ${OLD_COLUMN} TEXT`);
        expect(columns()).toContain(OLD_COLUMN);
        expect(sql.prepare(`SELECT COUNT(*) AS n FROM members WHERE ${OLD_COLUMN} IS NOT NULL`).get()).toEqual({ n: 0 });
    });
});
