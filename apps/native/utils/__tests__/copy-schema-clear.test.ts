import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// The copy's schema number (utils/db.ts COPY_SCHEMA, DESIGN-atomic-beans-fable.md M2): money is whole hundredths of a Bean,
// so every money column of the phone's copy is an INTEGER `*_c`, as the node's are. A copy made before (user_version 3, its
// Beans held as REAL: posts.credits, accounts.balance, ...) is a cache: its cache tables are dropped and made again, and the
// sync reads it whole, as a Force Resync's clearDB does. Nothing in it is read or converted. The tables that are not a copy
// of the node's (the tools' documents, the group keys) stay. Real SQL against the phone's real schema (getDb() runs the app's
// own _doInitDB over this in-memory database), device modules stubbed at the boundary as in members-old-column-drop.test.ts.

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
const removed: string[][] = [];
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? ANCHOR : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
        multiRemove: vi.fn(async (keys: string[]) => { removed.push(keys); }),
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

import { closeDB, getDb, getPosts, getBalance } from '../db';
import { TOOL_DOCS_TABLE } from '../../tools/schema';
import { GROUP_KEY_TABLES_SQL } from '../group-chat-store';

const ME = 'me'.padEnd(64, '0');
const ANA = 'a'.repeat(64);
const FILE = 'beanpool_valley.example.org.db';
const columnsOf = (table: string) => (sql.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]);
const count = (table: string) => (sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const userVersion = () => (sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

/** The copy a 1.3 build left: user_version 3, Beans as REAL, a priced listing, a balance, a send; and the two kept stores. */
function oldCopy(): void {
    sql.exec(`
        CREATE TABLE members (public_key TEXT PRIMARY KEY, callsign TEXT NOT NULL, earned_credit REAL DEFAULT 0, archetype TEXT);
        CREATE TABLE accounts (public_key TEXT PRIMARY KEY, balance REAL DEFAULT 0.0, last_updated_at DATETIME, last_demurrage_epoch INTEGER DEFAULT 0);
        CREATE TABLE transactions (id TEXT PRIMARY KEY, from_pubkey TEXT NOT NULL, to_pubkey TEXT NOT NULL, amount REAL NOT NULL CHECK (amount > 0), tax_fee REAL DEFAULT 0.0, memo TEXT, timestamp DATETIME);
        CREATE TABLE posts (id TEXT PRIMARY KEY, type TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, credits REAL NOT NULL DEFAULT 0, author_pubkey TEXT NOT NULL, status TEXT DEFAULT 'active', active INTEGER DEFAULT 1, audience_scope TEXT DEFAULT 'public', created_at DATETIME);
        CREATE TABLE marketplace_transactions (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, buyer_pubkey TEXT NOT NULL, seller_pubkey TEXT NOT NULL, credits REAL NOT NULL, hours REAL, status TEXT DEFAULT 'pending');
        CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, post_id TEXT, post_credits REAL);
        PRAGMA user_version = 3;
    `);
    sql.exec(TOOL_DOCS_TABLE);
    sql.exec(GROUP_KEY_TABLES_SQL);
    sql.prepare('INSERT INTO members (public_key, callsign, earned_credit) VALUES (?, ?, ?)').run(ANA, 'Ana', 200);
    sql.prepare('INSERT INTO accounts (public_key, balance) VALUES (?, ?)').run(ME, 49.25);
    sql.prepare("INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES ('t1', ?, ?, 12.5, 0, 'jam', '2026-11-01T00:00:00.000Z')").run(ANA, ME);
    sql.prepare("INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at) VALUES ('L1', 'offer', 'food', 'Jam', '', 12.5, ?, '2026-11-01T00:00:00.000Z')").run(ANA);
    sql.prepare("INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits) VALUES ('d1', 'L1', ?, ?, 12.5)").run(ME, ANA);
    sql.prepare("INSERT INTO conversations (id, type, post_id, post_credits) VALUES ('c1', 'dm', NULL, 12.5)").run();
    sql.prepare("INSERT INTO tool_docs (owner, tool, body, updated_at) VALUES (?, 'things', '{\"kept\":true}', '2026-11-01T00:00:00.000Z')").run(ME);
    sql.prepare("INSERT INTO group_chat_epochs (group_id, epoch, record, wrap) VALUES ('g1', 1, 'record', 'wrap')").run();
}

/** Every column of the cache tables whose name says money. */
const MONEY_COLUMN = /^(\w*_c|balance|amount|tax_fee|fee|credits|post_credits|earned_credit|goal_amount|current_amount)$/;
const CACHE_TABLES = ['members', 'accounts', 'transactions', 'posts', 'marketplace_transactions', 'conversations', 'projects'];

describe("the phone's copy and its schema number (COPY_SCHEMA 4: whole hundredths)", () => {
    it('a 1.3 copy (user_version 3, Beans as REAL) loses its cache and every old figure, keeps the tools and group keys, and is read whole again', async () => {
        oldCopy();
        await getDb();
        expect(userVersion()).toBe(4);
        // Dropped, not converted: no row of the old copy is carried, so no old figure can be read as hundredths.
        for (const table of ['members', 'accounts', 'transactions', 'posts', 'marketplace_transactions', 'conversations']) expect(count(table), table).toBe(0);
        expect(await getPosts()).toEqual([]);
        expect((await getBalance(ME)).balance_c).toBe(0);
        // Made again with today's columns: every money column an INTEGER `*_c`, none of the old REAL ones left.
        for (const table of CACHE_TABLES) {
            const money = columnsOf(table).filter((c) => MONEY_COLUMN.test(c.name));
            expect(money.length, table).toBeGreaterThan(0);
            for (const c of money) {
                expect(c.name, `${table}.${c.name}`).toMatch(/_c$/);
                expect(c.type, `${table}.${c.name}`).toBe('INTEGER');
            }
        }
        // The account's own stores stay: they are not a copy of the node's.
        expect(sql.prepare('SELECT body FROM tool_docs WHERE owner = ?').get(ME)).toEqual({ body: '{"kept":true}' });
        expect(count('group_chat_epochs')).toBe(1);
        // The copy is read whole: this community's sync cursors are forgotten.
        expect(removed.flat()).toContain(`pillar_sync_${FILE}_members_last_sync`);
    });

    it('a copy already at the number keeps every row when it opens again', async () => {
        sql.prepare("INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, created_at) VALUES ('L2', 'offer', 'food', 'Bread', '', 4925, ?, '2026-11-02T00:00:00.000Z')").run(ANA);
        removed.length = 0;
        await closeDB();
        await getDb();
        expect(userVersion()).toBe(4);
        expect(sql.prepare("SELECT price_c FROM posts WHERE id = 'L2'").get()).toEqual({ price_c: 4925 });
        expect(removed).toEqual([]);
    });
});
