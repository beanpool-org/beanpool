import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 1.4.0 on Android, 11 Nov 09:26: opening a community whose copy a 1.3 build made (user_version 3) put up "DB Error —
// Call to function 'NativeDatabase.execAsync' has been rejected. Caused by: database table is locked" over Home. The open
// of a copy below COPY_SCHEMA drops its cache tables (utils/db.ts _doInitDB), and SQLite refuses a DROP TABLE while another
// statement of the same connection is still open (SQLITE_LOCKED). getDb handed the connection out as soon as it was open,
// before its copy was made, so Home's reads (and the socket's, a sync's, a switch's) held statements on it as the drops
// ran: the clear stopped part way and the copy was left half made.
//
// Real SQL here: the phone's own getDb/_doInitDB/clearDB over node:sqlite, one file per community and one connection per
// open, as expo-sqlite's useNewConnection. A read keeps its statement open between its step and its finalize, while the
// caller's awaits run, as expo-sqlite's getFirstAsync/getAllAsync do (prepareAsync, executeAsync, ..., finalizeAsync): a
// held read (holdRead) is a screen's read caught at that point.

const h = vi.hoisted(() => ({
    dir: '',
    anchor: '',
    store: new Map<string, string>(),
    /** Reads whose statement stays open, once stepped, until their `until` settles. */
    holds: [] as { match: RegExp; until: Promise<void>; opened: () => void; release?: () => void }[],
    /** A statement run through execAsync that throws instead (the disk full, the app closing): once. */
    failExec: null as RegExp | null,
    /** Every connection the app opened, by file, and whether it has been closed. */
    connections: [] as { name: string; closed: boolean }[],
}));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as SQLInputValue[];
    return {
        openDatabaseAsync: vi.fn(async (name: string) => {
            const sql = new Sqlite(join(h.dir, name));
            const connection = { name, closed: false };
            h.connections.push(connection);
            /** One read: stepped, then (the caller's awaits) finalized; the statement is open in between. */
            const read = async (q: string, p: unknown, all: boolean) => {
                const it = sql.prepare(q).iterate(...params(p));
                try {
                    const first = it.next();
                    const hold = h.holds.find((x) => x.match.test(q));
                    if (hold) {
                        hold.opened();
                        await hold.until;
                    } else {
                        await new Promise((resolve) => setImmediate(resolve));
                    }
                    if (first.done) return all ? [] : null;
                    if (!all) return first.value;
                    const rows = [first.value];
                    for (let n = it.next(); !n.done; n = it.next()) rows.push(n.value);
                    return rows;
                } finally {
                    try { it.return?.(); } catch { /* its connection closed under it */ }
                }
            };
            const exec = async (q: string) => {
                if (h.failExec?.test(q)) {
                    h.failExec = null;
                    throw new Error('database or disk is full');
                }
                sql.exec(q);
            };
            return {
                execAsync: exec,
                getFirstAsync: (q: string, p?: unknown) => read(q, p, false),
                getAllAsync: (q: string, p?: unknown) => read(q, p, true),
                runAsync: async (q: string, p?: unknown) => {
                    const r = sql.prepare(q).run(...params(p));
                    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
                },
                // As expo-sqlite's: BEGIN, the task, COMMIT, or ROLLBACK and the error.
                withTransactionAsync: async (task: () => Promise<void>) => {
                    await exec('BEGIN');
                    try {
                        await task();
                        await exec('COMMIT');
                    } catch (e) {
                        await exec('ROLLBACK');
                        throw e;
                    }
                },
                closeAsync: async () => {
                    connection.closed = true;
                    sql.close();
                },
            };
        }),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? h.anchor : h.store.get(k) ?? null)),
        setItem: vi.fn(async (k: string, v: string) => { h.store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { for (const k of keys) h.store.delete(k); }),
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

import { clearDB, closeDB, COPY_SCHEMA, getDb, initDB } from '../db';
import { TOOL_DOCS_TABLE } from '../../tools/schema';
import { GROUP_KEY_TABLES_SQL } from '../group-chat-store';

// Nothing here reaches a network.
globalThis.fetch = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-copy-clear-lock-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let phoneN = 0;
beforeEach(() => {
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir, { recursive: true });
    h.store.clear();
    h.holds = [];
    h.failExec = null;
    h.connections = [];
});
afterEach(async () => {
    for (const hold of h.holds) hold.release?.();
    h.holds = [];
    await closeDB();
});

const ANA = 'a'.repeat(64);
const fileOf = (url: string) => `beanpool_${new URL(url).hostname}.db`;

/** The copy as a 1.3 build left it for `url`: user_version 3, Beans as REAL, a member, a listing, and the account's own stores. */
function oldCopy(url: string): void {
    const sql = new DatabaseSync(path.join(h.dir, fileOf(url)));
    sql.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE members (public_key TEXT PRIMARY KEY, callsign TEXT NOT NULL, earned_credit REAL DEFAULT 0, archetype TEXT);
        CREATE TABLE accounts (public_key TEXT PRIMARY KEY, balance REAL DEFAULT 0.0);
        CREATE TABLE posts (id TEXT PRIMARY KEY, type TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, credits REAL NOT NULL DEFAULT 0, author_pubkey TEXT NOT NULL, status TEXT DEFAULT 'active', created_at DATETIME);
        CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, post_id TEXT, post_credits REAL);
        PRAGMA user_version = 3;
    `);
    sql.exec(TOOL_DOCS_TABLE);
    sql.exec(GROUP_KEY_TABLES_SQL);
    sql.prepare('INSERT INTO members (public_key, callsign, earned_credit) VALUES (?, ?, ?)').run(ANA, 'Ana', 200);
    sql.prepare("INSERT INTO posts (id, type, category, title, description, credits, author_pubkey) VALUES ('L1', 'offer', 'food', 'Jam', '', 12.5, ?)").run(ANA);
    sql.prepare("INSERT INTO tool_docs (owner, tool, body, updated_at) VALUES ('me', 'things', '{}', '2026-11-01T00:00:00.000Z')").run();
    sql.close();
    h.store.set(`pillar_sync_${fileOf(url)}_members_last_sync`, '1762800000000');
    h.store.set(`pillar_sync_${fileOf(url)}_last-sync`, '1762800000000');
}

/** What `url`'s copy holds on disk, read through a connection of the test's own. */
function onDisk(url: string) {
    const sql = new DatabaseSync(path.join(h.dir, fileOf(url)));
    try {
        const tables = (sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
        const columns = (table: string) => (sql.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
        const count = (table: string) => (tables.includes(table) ? (sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n : null);
        return {
            userVersion: (sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
            tables,
            members: count('members'),
            posts: count('posts'),
            toolDocs: count('tool_docs'),
            postColumns: tables.includes('posts') ? columns('posts') : [],
        };
    } finally {
        sql.close();
    }
}

/** A screen's read caught between its step and its finalize: its statement stays open until `release()`. */
function holdRead(match: RegExp) {
    let release!: () => void;
    const until = new Promise<void>((resolve) => { release = resolve; });
    let opened!: () => void;
    const open = new Promise<void>((resolve) => { opened = resolve; });
    h.holds.push({ match, until, opened: () => { opened(); }, release });
    return { release, open };
}

const settled = (p: Promise<unknown>) => p.then(() => 'made', (e: unknown) => `refused: ${String((e as Error)?.message ?? e)}`);
const CURSORS_OF = (url: string) => [...h.store.keys()].filter((k) => k.startsWith(`pillar_sync_${fileOf(url)}_`));

describe("a copy below the schema number is cleared and made again before anything reads it (1.4.0's 'database table is locked')", () => {
    it("cold start, in the root layout's order: Home's read open on the copy as its 1.3 tables go never stops the clear", async () => {
        const VALLEY = 'https://valley.example.org';
        oldCopy(VALLEY);
        h.anchor = VALLEY;
        const home = holdRead(/FROM members/);
        // app/_layout.tsx: the socket starts, then initDB(); Home's cards read as the copy opens.
        const init = settled(initDB());
        const homeRead = getDb().then((d) => d.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM members'));
        const initAnswer = await init;
        home.release();
        const read = await homeRead;
        console.log(`cold start: initDB ${initAnswer}; Home read ${JSON.stringify(read)}; on disk ${JSON.stringify(onDisk(VALLEY))}`);
        expect(initAnswer).toBe('made');
        const disk = onDisk(VALLEY);
        expect(disk.userVersion).toBe(COPY_SCHEMA);
        // Home read the copy as made, never the 1.3 one mid-clear.
        expect(read).toEqual({ n: 0 });
        expect(disk.members).toBe(0);
        expect(disk.posts).toBe(0);
        expect(disk.postColumns).toContain('price_c');
        expect(disk.postColumns).not.toContain('credits');
        // The account's own store stays; the copy is read whole again (its cursors forgotten).
        expect(disk.toolDocs).toBe(1);
        expect(CURSORS_OF(VALLEY)).toEqual([]);
    });

    it('a read that asks while the copy is being made waits for it: no statement is open on it as its tables go', async () => {
        const RIVER = 'https://river.example.org';
        oldCopy(RIVER);
        h.anchor = RIVER;
        // The window: the open has its connection and reads the copy's number; meanwhile the sync's read asks for the copy.
        // Held until the sync's read has its statement open on the copy, or for 50 ms when it can't have one (it waits).
        const sync = holdRead(/FROM posts/);
        let syncRead: Promise<{ id: string }[]> | null = null;
        let readerAsked!: () => void;
        const asked = new Promise<void>((resolve) => { readerAsked = resolve; });
        h.holds.push({
            match: /^PRAGMA user_version$/,
            until: Promise.race([sync.open, asked.then(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))]),
            opened: () => {
                readerAsked();
                syncRead = getDb().then((d) => d.getAllAsync<{ id: string }>('SELECT id FROM posts'));
            },
        });
        const opened = await settled(getDb());
        sync.release();
        const rows = await syncRead!;
        console.log(`read asking mid-make: open ${opened}; sync read ${JSON.stringify(rows)}; on disk ${JSON.stringify(onDisk(RIVER))}`);
        expect(opened).toBe('made');
        expect(rows).toEqual([]);
        expect(onDisk(RIVER).userVersion).toBe(COPY_SCHEMA);
        expect(onDisk(RIVER).posts).toBe(0);
    });

    it('a clear that stops part way leaves the copy as it was, hands nothing out, and the next open finishes it', async () => {
        const HILL = 'https://hill.example.org';
        oldCopy(HILL);
        h.anchor = HILL;
        // The schema step refused (the disk full) after the drops ran.
        h.failExec = /CREATE TABLE IF NOT EXISTS posts/;
        const first = await settled(initDB());
        const after = onDisk(HILL);
        console.log(`part way: first open ${first}; on disk ${JSON.stringify(after)}`);
        // Never a copy without its tables, nor one at the number that was never made: as it was, rows and all.
        expect(after.userVersion).toBe(3);
        expect(after.members).toBe(1);
        expect(after.posts).toBe(1);
        // And not handed out: a copy below the number is no copy this build reads.
        expect(first).toBe('refused: database or disk is full');
        // The next ask opens it again and the clear finishes.
        const second = await settled(initDB());
        const made = onDisk(HILL);
        expect(second).toBe('made');
        expect(made.userVersion).toBe(COPY_SCHEMA);
        expect(made.members).toBe(0);
        expect(made.posts).toBe(0);
        expect(made.postColumns).toContain('price_c');
        expect(made.toolDocs).toBe(1);
        const read = await (await getDb()).getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM posts');
        expect(read).toEqual({ n: 0 });
    });

    it("a community switch to a 1.3 copy while a read runs on it: the switch's open makes it first (use-communities switchCommunity)", async () => {
        const HOME = 'https://home.example.org';
        const AWAY = 'https://away.example.org';
        h.anchor = HOME;
        await initDB();
        expect(onDisk(HOME).userVersion).toBe(COPY_SCHEMA);
        oldCopy(AWAY);
        const away = holdRead(/FROM members/);
        // switchCommunity: closeDB, the anchor written, initDB; the screens still mounted read the new community at once.
        await closeDB();
        h.anchor = AWAY;
        const init = settled(initDB());
        const screenRead = getDb().then((d) => d.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM members'));
        const initAnswer = await init;
        away.release();
        const read = await screenRead;
        console.log(`switch: initDB ${initAnswer}; read ${JSON.stringify(read)}; away on disk ${JSON.stringify(onDisk(AWAY))}`);
        expect(initAnswer).toBe('made');
        expect(read).toEqual({ n: 0 });
        expect(onDisk(AWAY).userVersion).toBe(COPY_SCHEMA);
        expect(onDisk(AWAY).members).toBe(0);
        // The community left is untouched.
        expect(onDisk(HOME).userVersion).toBe(COPY_SCHEMA);
    });

    it('a Force Resync (clearDB) while a read holds a statement on the open copy: the copy is cleared and made again all the same', async () => {
        const LAKE = 'https://lake.example.org';
        h.anchor = LAKE;
        const database = await getDb();
        await database.runAsync("INSERT INTO members (public_key, callsign) VALUES (?, 'Ana')", [ANA]);
        await database.runAsync("INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey) VALUES ('L1', 'offer', 'food', 'Jam', '', 1250, ?)", [ANA]);
        const reader = holdRead(/FROM members/);
        const held = database.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM members').catch((e: Error) => e.message);
        await reader.open;
        const cleared = await settled(clearDB());
        reader.release();
        await held;
        const disk = onDisk(LAKE);
        console.log(`Force Resync with a read open: clearDB ${cleared}; on disk ${JSON.stringify(disk)}`);
        expect(cleared).toBe('made');
        expect(disk.userVersion).toBe(COPY_SCHEMA);
        expect(disk.members).toBe(0);
        expect(disk.posts).toBe(0);
        expect(disk.postColumns).toContain('price_c');
        expect(await (await getDb()).getFirstAsync('SELECT COUNT(*) AS n FROM posts')).toEqual({ n: 0 });
    });

    it('the address changes while a 1.3 copy is still being made: the copy asked for last is the one handed out, and no other connection stays open', async () => {
        const LEFT = 'https://left.example.org';
        const NOW = 'https://now.example.org';
        oldCopy(LEFT);
        h.anchor = LEFT;
        // LEFT's open caught as it reads its copy's number.
        let reached!: () => void;
        const atNumber = new Promise<void>((resolve) => { reached = resolve; });
        let letGo!: () => void;
        const held = new Promise<void>((resolve) => { letGo = resolve; });
        h.holds.push({ match: /^PRAGMA user_version$/, until: held, opened: () => reached(), release: () => letGo() });
        const first = settled(getDb().then((d) => d.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'nearby_held'")));
        await atNumber;
        // The address changes with no closeDB first (a door's key, the sync's winning address: getDb's own swap).
        h.holds = [];
        h.anchor = NOW;
        const nowCopy = await getDb();
        letGo();
        const firstAnswer = await first;
        const open = h.connections.filter((c) => !c.closed).map((c) => c.name);
        console.log(`address changed mid-make: the first ask ${firstAnswer}; connections still open ${JSON.stringify(open)}; left on disk ${JSON.stringify(onDisk(LEFT))}`);
        // The first ask gets the copy the phone is on now, made; LEFT's own connection is closed, never left beside it.
        expect(firstAnswer).toBe('made');
        expect(open).toEqual([fileOf(NOW)]);
        expect(await getDb()).toBe(nowCopy);
        // LEFT's clear, done before the address changed, stays done: a whole copy at the number.
        expect(onDisk(LEFT).userVersion).toBe(COPY_SCHEMA);
        expect(onDisk(LEFT).members).toBe(0);
    });
});
