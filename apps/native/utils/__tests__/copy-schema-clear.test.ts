import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
// The identity lives in the secure store, never in the copy. Only loadIdentity is here: any other identity call the clear made
// (a wipe, a removal) would throw, so "the clear leaves the identity alone" is checked, not assumed.
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me'.padEnd(64, '0'), privateKey: '11'.repeat(32), callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { closeDB, getDb, getPosts, getBalance } from '../db';
import { TOOL_DOCS_TABLE } from '../../tools/schema';
import { GROUP_KEY_TABLES_SQL } from '../group-chat-store';
import { OUTSIDE_CHAT_TABLES_SQL } from '../outside-chat-store';

// Nothing here reaches a network: getBalance's own read of the node finds the phone offline.
(globalThis as any).fetch = vi.fn(async () => { throw new TypeError('offline'); });

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
    sql.exec(OUTSIDE_CHAT_TABLES_SQL);
    sql.prepare('INSERT INTO members (public_key, callsign, earned_credit) VALUES (?, ?, ?)').run(ANA, 'Ana', 200);
    sql.prepare('INSERT INTO accounts (public_key, balance) VALUES (?, ?)').run(ME, 49.25);
    sql.prepare("INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES ('t1', ?, ?, 12.5, 0, 'jam', '2026-11-01T00:00:00.000Z')").run(ANA, ME);
    sql.prepare("INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at) VALUES ('L1', 'offer', 'food', 'Jam', '', 12.5, ?, '2026-11-01T00:00:00.000Z')").run(ANA);
    sql.prepare("INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits) VALUES ('d1', 'L1', ?, ?, 12.5)").run(ME, ANA);
    sql.prepare("INSERT INTO conversations (id, type, post_id, post_credits) VALUES ('c1', 'dm', NULL, 12.5)").run();
    sql.prepare("INSERT INTO tool_docs (owner, tool, body, updated_at) VALUES (?, 'things', '{\"kept\":true}', '2026-11-01T00:00:00.000Z')").run(ME);
    sql.prepare("INSERT INTO group_chat_epochs (group_id, epoch, record, wrap) VALUES ('g1', 1, 'record', 'wrap')").run();
    sql.prepare("INSERT INTO group_chat_key_state (group_id, highest, after) VALUES ('g1', 1, 0)").run();
    sql.prepare("INSERT INTO group_line_verdicts (group_id, k) VALUES ('g1', 'v1')").run();
    sql.prepare("INSERT INTO group_line_signers (group_id, message_id, signer) VALUES ('g1', 'm1', ?)").run(ANA);
    // A chat with someone in another community, kept on this phone only: no node holds it to read again.
    sql.prepare("INSERT INTO outside_chats (id, me, peer_key, peer_home, state, created_at, updated_at) VALUES ('o1', ?, ?, 'a.example', 'open', 1, 1)").run(ME, ANA);
    sql.prepare("INSERT INTO outside_lines (id, chat_id, author, text, at) VALUES ('ol1', 'o1', ?, 'kept here only', 1)").run(ANA);
    sql.prepare("INSERT INTO outside_meta (k, v) VALUES ('door', 'open')").run();
    // A receipt still owed for a line this phone has: its sender's server deleted the line, so only this row remembers it.
    sql.prepare("INSERT INTO outside_receipts (id, me, peer_key, peer_home, owed_at) VALUES ('ol1', ?, ?, 'a.example', 1)").run(ME, ANA);
}

/** The tables that are not a copy of the node's: never cleared by a schema number, only by the account leaving. */
const KEPT_TABLES = ['tool_docs', 'group_chat_epochs', 'group_chat_key_state', 'group_line_verdicts', 'group_line_signers', 'outside_chats', 'outside_lines', 'outside_meta', 'outside_receipts'];

/**
 * Columns that older builds added to an open copy one ALTER TABLE at a time (audit C2), now in the schema itself: a copy
 * cleared below the number, and a fresh one, both have them.
 */
const LATE_COLUMNS: Record<string, string[]> = {
    members: ['card_fetched_at', 'archetype', 'profile_updated_at'],
    marketplace_transactions: ['rated_by_buyer', 'rated_by_seller', 'standing_id', 'period_no', 'standing', 'cover_image', 'post_title', 'item_option'],
    messages: ['edited_at'],
    conversations: ['listed', 'request', 'post_title', 'post_status', 'post_photo'],
    posts: ['carried_banner', 'carried_callsign', 'carried_avatar', 'tags', 'free_tags', 'pinned_until', 'pinned_at', 'shown_from', 'lendable', 'event_repeat_skips', 'units_left', 'lot_price_c', 'lot_units'],
};

/** Every column of the cache tables whose name says money. */
const MONEY_COLUMN = /^(\w*_c|balance|amount|tax_fee|fee|credits|post_credits|earned_credit|goal_amount|current_amount)$/;
const CACHE_TABLES = ['members', 'accounts', 'transactions', 'posts', 'marketplace_transactions', 'conversations', 'projects'];

// The number is 8 since the forum on the phone (F3: the new cache table forum_kept), 7 since per-item prices P3 (item_option on marketplace_transactions), 6 since P2 (three columns on posts, utils/db.ts
// COPY_SCHEMA), 5 since Learn (slice K2: the new cache table knowledge_posts); 4 was the whole-hundredths cutover this file is about,
// and a copy of 4, 5 or 6 is now cleared and read again like a 1.3 one (utils/__tests__/learn-copy-sync.test.ts).
describe("the phone's copy and its schema number (whole hundredths since 4; COPY_SCHEMA 8)", () => {
    it('a 1.3 copy (user_version 3, Beans as REAL) loses its cache and every old figure, keeps the tools and group keys, and is read whole again', async () => {
        oldCopy();
        await getDb();
        expect(userVersion()).toBe(8);
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
        // The account's own stores stay, all five: they are not a copy of the node's.
        expect(sql.prepare('SELECT body FROM tool_docs WHERE owner = ?').get(ME)).toEqual({ body: '{"kept":true}' });
        for (const table of KEPT_TABLES) expect(count(table), table).toBe(1);
        // Every column today's build reads is there, made by the schema, not added on open.
        for (const [table, columns] of Object.entries(LATE_COLUMNS)) {
            const have = columnsOf(table).map((c) => c.name);
            for (const column of columns) expect(have, `${table}.${column}`).toContain(column);
        }
        for (const index of ['idx_marketplace_transactions_post_id', 'idx_conversations_post_id']) {
            expect(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index), index).toEqual({ name: index });
        }
        // The copy is read whole: this community's sync cursors are forgotten.
        expect(removed.flat()).toContain(`pillar_sync_${FILE}_members_last_sync`);
        // And only the cursors: no identity key of the phone's is forgotten with them.
        expect(removed.flat().filter((k) => !k.startsWith(`pillar_sync_${FILE}`))).toEqual([]);
    });

    it('a copy at 5, made before per-item prices, is cleared and made again with the three per-item columns (nothing altered on open)', async () => {
        // The copy a build at 5 left: today's shape without the three columns, a priced listing in it.
        await closeDB();
        sql.exec(`
            DROP TABLE posts;
            CREATE TABLE posts (id TEXT PRIMARY KEY, type TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, price_c INTEGER DEFAULT 0, author_pubkey TEXT NOT NULL, price_type TEXT DEFAULT 'fixed');
            PRAGMA user_version = 5;
        `);
        sql.prepare("INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, price_type) VALUES ('P5', 'offer', 'tools', 'Solar panels', '', 30000, ?, 'fixed')").run(ANA);
        expect(columnsOf('posts').map((c) => c.name)).not.toContain('units_left');
        await getDb();
        expect(userVersion()).toBe(8);
        // Cleared, not converted: the listing is read again from the node, with its count.
        expect(count('posts')).toBe(0);
        const have = columnsOf('posts');
        for (const name of ['units_left', 'lot_price_c', 'lot_units']) expect(have.find((c) => c.name === name)?.type, name).toBe('INTEGER');
    });

    it('a copy at 6, made before per-item deals said which way they were taken up, is cleared and made again with item_option (nothing altered on open)', async () => {
        // The copy a build at 6 left: its deal table without the column, a deal in it.
        await closeDB();
        sql.exec(`
            DROP TABLE marketplace_transactions;
            CREATE TABLE marketplace_transactions (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, buyer_pubkey TEXT NOT NULL, seller_pubkey TEXT NOT NULL, amount_c INTEGER, hours REAL, status TEXT DEFAULT 'pending');
            PRAGMA user_version = 6;
        `);
        sql.prepare("INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, hours) VALUES ('T6', 'P6', ?, 'seller', 90000, 3)").run(ME);
        expect(columnsOf('marketplace_transactions').map((c) => c.name)).not.toContain('item_option');
        await getDb();
        expect(userVersion()).toBe(8);
        // Cleared, not converted: the deal is read again from the node, with its way.
        expect(count('marketplace_transactions')).toBe(0);
        expect(columnsOf('marketplace_transactions').find((c) => c.name === 'item_option')?.type).toBe('TEXT');
    });

    it('a copy at 7, made before the forum on the phone, is cleared and made again with forum_kept (a cache table, nothing altered on open)', async () => {
        await closeDB();
        sql.exec('DROP TABLE IF EXISTS forum_kept; PRAGMA user_version = 7;');
        sql.prepare("INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey) VALUES ('P7', 'offer', 'food', 'Jam', '', 500, ?)").run(ANA);
        await getDb();
        expect(userVersion()).toBe(8);
        expect(count('posts')).toBe(0);
        expect(columnsOf('forum_kept').map((c) => c.name)).toEqual(['me', 'k', 'kind', 'following', 'body', 'kept_at']);
        // The account's own stores stay, as for every number.
        for (const table of KEPT_TABLES) expect(count(table), table).toBe(1);
    });

    it('a copy already at the number keeps every row when it opens again, and nothing alters it on the way', async () => {
        sql.prepare("INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, created_at) VALUES ('L2', 'offer', 'food', 'Bread', '', 4925, ?, '2026-11-02T00:00:00.000Z')").run(ANA);
        removed.length = 0;
        await closeDB();
        adapter.execAsync.mockClear();
        await getDb();
        expect(userVersion()).toBe(8);
        expect(sql.prepare("SELECT price_c FROM posts WHERE id = 'L2'").get()).toEqual({ price_c: 4925 });
        expect(removed).toEqual([]);
        // The standing rule: the schema is the whole shape, so opening a copy at the number runs no ALTER TABLE and drops nothing.
        const ran = adapter.execAsync.mock.calls.map(([q]) => String(q)).join('\n');
        expect(ran).not.toMatch(/ALTER\s+TABLE/i);
        expect(ran).not.toMatch(/DROP\s+TABLE/i);
        for (const table of KEPT_TABLES) expect(count(table), table).toBe(1);
    });

    it('the source holds to it: no column is added to an open copy, and no one-off pass keyed on a flag runs at open', () => {
        const src = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        expect(src).not.toMatch(/ADD\s+COLUMN/i);
        expect(src).not.toMatch(/DROP\s+COLUMN/i);
        expect(src).not.toMatch(/bp_trust_sync_v3|bp_legacy_post_conv_cleaned_v1/);
    });
});
