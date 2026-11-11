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
    /** Run at the next read of the address, which is answered a moment later, so whatever this starts reads it first: once. */
    beforeAnchorRead: null as (() => void) | null,
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
                databasePath: name,
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
        getItem: vi.fn(async (k: string) => {
            if (k !== 'beanpool_anchor_url') return h.store.get(k) ?? null;
            const before = h.beforeAnchorRead;
            if (before) {
                h.beforeAnchorRead = null;
                before();
                await new Promise((resolve) => setImmediate(resolve));
            }
            return h.anchor;
        }),
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
    h.beforeAnchorRead = null;
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

/**
 * A copy at this build's number that its schema can't be made over: a cache table of another shape (`posts` without the
 * columns the schema indexes), as a test build that changed a column without raising the number leaves it.
 */
function copyOfAnotherShape(url: string): void {
    const sql = new DatabaseSync(path.join(h.dir, fileOf(url)));
    sql.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL);
        PRAGMA user_version = ${COPY_SCHEMA};
    `);
    sql.exec(TOOL_DOCS_TABLE);
    sql.exec(GROUP_KEY_TABLES_SQL);
    sql.prepare("INSERT INTO posts (id, title) VALUES ('L1', 'Jam')").run();
    sql.prepare("INSERT INTO tool_docs (owner, tool, body, updated_at) VALUES ('me', 'things', '{}', '2026-11-01T00:00:00.000Z')").run();
    sql.close();
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

describe("a copy that can't be made is handed to no one, and the member's clears still make it", () => {
    it("Force Resync (settings.tsx: clearDB, then initDB) never needs the copy made first: it clears and makes one that can't be made at its number", async () => {
        const MEADOW = 'https://meadow.example.org';
        copyOfAnotherShape(MEADOW);
        h.anchor = MEADOW;
        // Its schema can't be made over the posts table it holds: no copy is handed out.
        const opened = await settled(initDB());
        expect(opened).toMatch(/^refused: .*no such column/);
        const resync = await settled(clearDB().then(() => initDB()));
        const disk = onDisk(MEADOW);
        console.log(`can't be made: open ${opened}; Force Resync ${resync}; on disk ${JSON.stringify(disk)}`);
        expect(resync).toBe('made');
        expect(disk.userVersion).toBe(COPY_SCHEMA);
        expect(disk.posts).toBe(0);
        expect(disk.postColumns).toContain('price_c');
        // A re-sync keeps the account's own store.
        expect(disk.toolDocs).toBe(1);
        expect(await (await getDb()).getFirstAsync('SELECT COUNT(*) AS n FROM posts')).toEqual({ n: 0 });
    });

    it("Sign Out's clear (account-leaves-phone.ts, identityLeaves) of a copy that can't be made at its number: its tables go and Sign Out goes on", async () => {
        const MEADOW = 'https://meadow.example.org';
        copyOfAnotherShape(MEADOW);
        h.anchor = MEADOW;
        const cleared = await settled(clearDB({ identityLeaves: true }));
        const disk = onDisk(MEADOW);
        console.log(`Sign Out, can't be made: clearDB ${cleared}; on disk ${JSON.stringify(disk)}`);
        expect(cleared).toBe('made');
        expect(disk.userVersion).toBe(COPY_SCHEMA);
        expect(disk.posts).toBe(0);
        expect(disk.postColumns).toContain('price_c');
        // The account's own store goes as it leaves.
        expect(disk.toolDocs).toBe(0);
    });
});

// The deciding review of #3053 at bfb2b396 (db.ts:161): a writer holding the sync lock asked for the copy (applyDelta, the
// deal and review writers, the ratings reads: each takes the lock, then getDb) during getDb's own swap, the address written
// with no closeDB (a door's key, a claim, welcome, restore-account, the sync's winning address). The swap's open waited for
// that same lock to close the copy left, and the writer waited for the open: neither let go, and every later getDb and lock
// taker queued behind them until the app was killed.
describe('a writer holding the sync lock that asks for the copy during a swap gets it: no open waits for that lock', () => {
    type Db = typeof import('../db');
    let d: Db;
    const X = 'https://x3.example.org';
    const Y = 'https://y3.example.org';
    const OTHER = 'b'.repeat(64);
    const offline = globalThis.fetch;

    /** `p`'s answer, or 'still waiting' when it has none within `ms`: a case that hangs fails, never holds up the run. */
    async function within(p: Promise<unknown>, ms = 3000): Promise<string> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still waiting'), ms); });
        try {
            return await Promise.race([p.then(() => 'answered', (e: unknown) => `refused: ${String((e as Error)?.message ?? e)}`), late]);
        } finally {
            clearTimeout(timer);
        }
    }
    const stillOpen = () => h.connections.filter((c) => !c.closed).map((c) => c.name);

    // Each case in a module of its own: one that hangs keeps its module's lock for good, and fails alone.
    beforeEach(async () => {
        vi.resetModules();
        d = await import('../db');
        h.anchor = X;
        await d.getDb(); // X's copy open and made
    });
    afterEach(async () => {
        globalThis.fetch = offline;
        await within(d.closeDB(), 1000);
    });

    /** Both answer; the screen has Y's copy, made; X's closes once the writer lets go of the lock, and Y's is the only one left. */
    async function expectBothAnswer(row: string, writer: Promise<unknown>, screen: ReturnType<Db['getDb']>) {
        const [w, s] = await Promise.all([within(writer), within(screen)]);
        console.log(`${row}: writer ${w}, screen ${s}; connections open ${JSON.stringify(stillOpen())}`);
        expect({ writer: w, screen: s }).toEqual({ writer: 'answered', screen: 'answered' });
        expect((await screen).databasePath).toBe(fileOf(Y));
        expect(await (await screen).getFirstAsync('SELECT COUNT(*) AS n FROM posts')).toEqual({ n: 0 });
        await vi.waitFor(() => expect(stillOpen()).toEqual([fileOf(Y)]));
    }

    it('row 1: a writer takes the lock, the address changes, a screen asks: both answer, and the page read for X lands in no other copy', async () => {
        const writer = d.applyDelta({}, fileOf(X), undefined); // takes the sync lock, then asks for the copy
        h.anchor = Y; // an address written with no closeDB
        const screen = d.getDb(); // a screen asks: the swap to Y
        await expectBothAnswer('row 1', writer, screen);
        expect(await writer).toBe(false);
    }, 10_000);

    it("row 2: a screen's ask starts the swap, then a writer takes the lock and asks: both answer", async () => {
        h.anchor = Y;
        const screen = d.getDb(); // a screen's ask: the swap to Y
        const writer = d.applyDelta({}, fileOf(X), undefined); // then a writer takes the lock and asks
        await expectBothAnswer('row 2', writer, screen);
        expect(await writer).toBe(false);
    }, 10_000);

    it("row 3 (control): the writer's own ask is the first to see the new address, and a screen asks after it: both answer", async () => {
        h.anchor = Y;
        const writer = d.applyDelta({}, fileOf(X), undefined); // the writer's own getDb starts the swap
        await new Promise((resolve) => setImmediate(resolve));
        const screen = d.getDb();
        await expectBothAnswer('row 3', writer, screen);
        expect(await writer).toBe(false);
    }, 10_000);

    it('closeDB queued behind a writer as a swap leaves the copy it reads: that writer finishes on it, and nothing is left open once closeDB answers', async () => {
        // A writer holds the lock with a read open on X (the ratings it gave, from the copy: the node unreachable).
        const reading = holdRead(/WHERE r\.rater_pubkey = \?/);
        const writer = d.getRatingsGiven(ANA);
        await reading.open;
        let openAtClose: string[] | null = null;
        const closing = d.closeDB().then(() => { openAtClose = stillOpen(); });
        h.anchor = Y;
        // Y's copy is made while the writer still holds the lock: its open never waits for the lock.
        const screen = d.getDb();
        expect(await within(screen)).toBe('answered');
        expect((await screen).databasePath).toBe(fileOf(Y));
        expect(stillOpen()).toEqual([fileOf(X), fileOf(Y)]);
        reading.release();
        expect(await within(writer)).toBe('answered');
        expect(await within(closing)).toBe('answered');
        console.log(`closeDB behind a writer: open as closeDB answered ${JSON.stringify(openAtClose)}`);
        // The copy left is closed by closeDB itself, not later: a caller deletes or carries the files once it answers.
        expect(openAtClose).toEqual([]);
    }, 10_000);

    // The other lock takers the review names: each takes the lock after its request to the node (which answers, or is
    // unreachable for the ratings reads, which then read the copy), then asks for the copy, as applyDelta does. The address
    // is written with no closeDB while the request is out. "Overtaken": a screen's ask reads the new address just before the
    // taker's own and starts the swap (rows 1 and 2). "Its own": the taker's ask is the first to see it (row 3).
    const TX = { id: 'T1', postId: 'L1', buyerPublicKey: ANA, sellerPublicKey: OTHER, status: 'pending', amount_c: 100, createdAt: '2026-11-11T00:00:00.000Z' };
    const TAKERS: { name: string; run: (db: Db) => Promise<unknown>; answer?: unknown }[] = [
        { name: 'acceptMarketplacePost', run: (db) => db.acceptMarketplacePost('L1', ANA, 1), answer: { success: true, transaction: TX } },
        { name: 'completeMarketplaceTransaction', run: (db) => db.completeMarketplaceTransaction('T1', ANA), answer: { success: true, transaction: TX } },
        { name: 'cancelMarketplaceTransaction', run: (db) => db.cancelMarketplaceTransaction('T1', ANA), answer: { success: true } },
        { name: 'requestMarketplacePost', run: (db) => db.requestMarketplacePost('L1', ANA, 1), answer: { success: true, transaction: { ...TX, status: 'requested' } } },
        { name: 'submitRating', run: (db) => db.submitRating(ANA, OTHER, 5, 'Kind', 'T1'), answer: { success: true } },
        { name: 'getMemberRatings', run: (db) => db.getMemberRatings(OTHER) },
        { name: 'getRatingsGiven', run: (db) => db.getRatingsGiven(ANA) },
    ];

    /** The taker's request to the node: as it goes out, the address is written with no closeDB, and `meanwhile` runs. */
    function whileTheRequestIsOut(answer: unknown, meanwhile: () => void): void {
        let first = true;
        globalThis.fetch = vi.fn(async () => {
            if (first) {
                first = false;
                h.anchor = Y;
                meanwhile();
            }
            if (answer === undefined) throw new TypeError('offline');
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => answer, text: async () => JSON.stringify(answer) };
        }) as unknown as typeof fetch;
    }

    describe.each(TAKERS)('$name', ({ name, run, answer }) => {
        it("overtaken: a screen's ask reads the new address just before the taker's own and starts the swap: both answer", async () => {
            const asked: { screen?: ReturnType<Db['getDb']> } = {};
            whileTheRequestIsOut(answer, () => { h.beforeAnchorRead = () => { asked.screen = d.getDb(); }; });
            const t = await within(run(d));
            const s = asked.screen ? await within(asked.screen, 1000) : 'never asked';
            console.log(`${name} overtaken: taker ${t}, screen ${s}; connections open ${JSON.stringify(stillOpen())}`);
            expect({ taker: t, screen: s }).toEqual({ taker: 'answered', screen: 'answered' });
            expect((await asked.screen)?.databasePath).toBe(fileOf(Y));
            await vi.waitFor(() => expect(stillOpen()).toEqual([fileOf(Y)]));
        }, 10_000);

        it("its own: the taker's ask is the first to see the new address, and a screen asks after it: both answer", async () => {
            whileTheRequestIsOut(answer, () => {});
            const t = await within(run(d));
            const screen = d.getDb();
            const s = await within(screen, 1000);
            console.log(`${name} its own: taker ${t}, screen ${s}; connections open ${JSON.stringify(stillOpen())}`);
            expect({ taker: t, screen: s }).toEqual({ taker: 'answered', screen: 'answered' });
            expect((await screen).databasePath).toBe(fileOf(Y));
            await vi.waitFor(() => expect(stillOpen()).toEqual([fileOf(Y)]));
        }, 10_000);
    });
});
