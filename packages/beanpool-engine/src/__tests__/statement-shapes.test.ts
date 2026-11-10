import { afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { preparedShape, preparedShapeCount, readWhileUnchanged } from '../statements.js';
import { getPosts, type PostFilter } from '../posts.js';
import { getConversationsByMember } from '../messaging.js';
import { registerGeoFunctions } from '../geo.js';
import { CREDIT_CAP_DEFAULT } from '@beanpool/core';
import { configureKnownFloorBeans, confirmationDialOn, creditCap, knownFloor, savedCreditCap, CONFIRMATION_DIAL_KEY, CREDIT_CAP_KEY, KNOWN_FLOOR_KEY } from '../known-floor.js';

/**
 * Statements by shape, and values kept while the database is unchanged (statements.ts), from the global node's load
 * rehearsal of 7 Nov 2026 (scratch/global-node/REPORT-global-load-rehearsal-2026-11-07.md §7-8, fixes 3 and 5).
 *
 * What these pin: a kept statement or value answers EXACTLY what a fresh prepare or a fresh read answers, after a write by
 * anyone (this connection, another connection, a rolled-back or committed transaction), and what is kept is bounded.
 */

/** Counts the compiles on a handle WITHOUT watching it: the count is on better-sqlite3's own prototype, so the handle keeps no `prepare` of its own. */
function countCompiles<T>(db: Database.Database, body: () => T): { result: T; compiles: string[] } {
    const proto = Object.getPrototypeOf(db) as { prepare: (sql: string) => Database.Statement };
    const real = proto.prepare;
    const compiles: string[] = [];
    proto.prepare = function (this: Database.Database, sql: string) { compiles.push(sql); return real.call(this, sql); };
    try {
        return { result: body(), compiles };
    } finally {
        proto.prepare = real;
    }
}

const dirs: string[] = [];
afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
/** Two connections to one database file (the second is "the command line"). */
function twoConnections(): { a: Database.Database; b: Database.Database } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapes-'));
    dirs.push(dir);
    const file = path.join(dir, 'state.db');
    const a = new Database(file);
    a.pragma('journal_mode = WAL');
    a.exec('CREATE TABLE node_config (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE other (x INTEGER)');
    return { a, b: new Database(file) };
}

describe('preparedShape: a statement kept by its text', () => {
    it('compiles a text once per handle and runs it with each call\'s own values', () => {
        const db = new Database(':memory:');
        db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
        db.prepare('INSERT INTO t VALUES (?, ?)').run('a', 1);
        db.prepare('INSERT INTO t VALUES (?, ?)').run('b', 2);
        const sql = 'SELECT v FROM t WHERE k = ?';
        const { result, compiles } = countCompiles(db, () => [
            (preparedShape(db, sql).get('a') as { v: number }).v,
            (preparedShape(db, sql).get('b') as { v: number }).v,
            (preparedShape(db, sql).get('a') as { v: number }).v,
            preparedShape(db, sql).get('nobody'),
        ]);
        expect(result).toEqual([1, 2, 1, undefined]);
        expect(compiles).toEqual([sql]);
    });

    it('answers what a fresh prepare answers after the table changes', () => {
        const db = new Database(':memory:');
        db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
        const sql = 'SELECT v FROM t WHERE k = ?';
        expect(preparedShape(db, sql).get('a')).toBeUndefined();
        db.prepare('INSERT INTO t VALUES (?, ?)').run('a', 1);
        expect((preparedShape(db, sql).get('a') as { v: number }).v).toBe(1);
        db.exec('ALTER TABLE t ADD COLUMN w INTEGER DEFAULT 7');
        expect((preparedShape(db, sql).get('a') as { v: number }).v).toBe(1);
        expect((preparedShape(db, 'SELECT w FROM t WHERE k = ?').get('a') as { w: number }).w).toBe(7);
    });

    it('keeps each handle apart', () => {
        const a = new Database(':memory:'), b = new Database(':memory:');
        for (const [db, v] of [[a, 1], [b, 2]] as const) db.exec(`CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (${v})`);
        const sql = 'SELECT v FROM t';
        expect((preparedShape(a, sql).get() as { v: number }).v).toBe(1);
        expect((preparedShape(b, sql).get() as { v: number }).v).toBe(2);
        expect(preparedShape(a, sql)).not.toBe(preparedShape(b, sql));
    });

    it('holds at most 128 texts a handle, pushing out the one asked for longest ago, not the one asked for most', () => {
        const db = new Database(':memory:');
        const text = (i: number) => `SELECT ${i} AS n`;
        const { compiles } = countCompiles(db, () => {
            for (let i = 0; i < 128; i++) preparedShape(db, text(i));
            // Text 0 is the oldest; asking for it again makes it the newest, so the 129th pushes out text 1.
            preparedShape(db, text(0));
            preparedShape(db, text(128));
            expect(preparedShapeCount(db)).toBe(128);
            preparedShape(db, text(0));
            preparedShape(db, text(1));
        });
        // 129 texts compiled; text 0 stayed; text 1 was compiled again.
        expect(compiles.length).toBe(130);
        expect(compiles.filter(s => s === text(0)).length).toBe(1);
        expect(compiles.filter(s => s === text(1)).length).toBe(2);
        expect(preparedShapeCount(db)).toBe(128);
    });

    it('a flood of one-off texts (an IN list of every length) never holds more than the bound', () => {
        const db = new Database(':memory:');
        for (let n = 1; n <= 500; n++) preparedShape(db, `SELECT ${Array.from({ length: n }, () => '?').join(' + ')} AS s`);
        expect(preparedShapeCount(db)).toBe(128);
    });

    it('does not keep a very long text', () => {
        const db = new Database(':memory:');
        const long = `SELECT 1 AS one /* ${'x'.repeat(20_000)} */`;
        const { compiles } = countCompiles(db, () => { preparedShape(db, long); preparedShape(db, long); });
        expect(compiles.length).toBe(2);
        expect(preparedShapeCount(db)).toBe(0);
    });

    it('throws on a closed handle, as a fresh prepare does', () => {
        const db = new Database(':memory:');
        expect((preparedShape(db, 'SELECT 1 AS one').get() as { one: number }).one).toBe(1);
        db.close();
        expect(() => preparedShape(db, 'SELECT 1 AS one').get()).toThrow();
    });

    it('prepares through a handle whose `prepare` is wrapped, and keeps nothing: a watcher sees every statement, and no kept one is left patched', () => {
        const db = new Database(':memory:');
        const sql = 'SELECT 1 AS one';
        preparedShape(db, sql); // kept before the watcher came
        const seen: string[] = [];
        const real = db.prepare.bind(db);
        (db as any).prepare = (s: string) => { seen.push(s); return real(s); };
        try {
            preparedShape(db, sql);
            preparedShape(db, sql);
            preparedShape(db, 'SELECT 2 AS two');
        } finally {
            delete (db as any).prepare;
        }
        expect(seen).toEqual([sql, sql, 'SELECT 2 AS two']);
        // Back to normal: the text kept before is still the one kept; the watched calls added nothing.
        expect(preparedShapeCount(db)).toBe(1);
        const { compiles } = countCompiles(db, () => preparedShape(db, sql));
        expect(compiles).toEqual([]);
    });
});

describe('readWhileUnchanged: a value kept until the database is written', () => {
    it('loads once for any number of reads', () => {
        const { a } = twoConnections();
        let loads = 0;
        const read = () => readWhileUnchanged(a, 'v', () => { loads++; return (a.prepare("SELECT value FROM node_config WHERE key = 'k'").get() as { value: string } | undefined)?.value ?? null; });
        expect(read()).toBeNull();
        expect(read()).toBeNull();
        expect(read()).toBeNull();
        expect(loads).toBe(1);
    });

    it('reads again after a write on this connection, to any table, by whatever statement', () => {
        const { a } = twoConnections();
        let loads = 0;
        const read = () => readWhileUnchanged(a, 'v', () => { loads++; return (a.prepare("SELECT value FROM node_config WHERE key = 'k'").get() as { value: string } | undefined)?.value ?? null; });
        expect(read()).toBeNull();
        a.prepare("INSERT INTO node_config VALUES ('k', 'one')").run();
        expect(read()).toBe('one');
        a.prepare("INSERT INTO node_config VALUES ('k', 'two') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
        expect(read()).toBe('two');
        a.prepare("INSERT OR REPLACE INTO node_config VALUES ('k', 'three')").run();
        expect(read()).toBe('three');
        a.exec("UPDATE node_config SET value = 'four' WHERE key = 'k'");
        expect(read()).toBe('four');
        a.prepare('DELETE FROM node_config').run();
        expect(read()).toBeNull();
        const before = loads;
        a.prepare('INSERT INTO other VALUES (1)').run(); // another table: one more read, the same answer
        expect(read()).toBeNull();
        expect(loads).toBe(before + 1);
    });

    it('reads again after ANOTHER connection commits (the command line), and not before', () => {
        const { a, b } = twoConnections();
        let loads = 0;
        const read = () => readWhileUnchanged(a, 'v', () => { loads++; return (a.prepare("SELECT value FROM node_config WHERE key = 'k'").get() as { value: string } | undefined)?.value ?? null; });
        expect(read()).toBeNull();
        expect(read()).toBeNull();
        expect(loads).toBe(1);
        b.prepare("INSERT INTO node_config VALUES ('k', 'from the command line')").run();
        expect(read()).toBe('from the command line');
        b.prepare("UPDATE node_config SET value = 'again' WHERE key = 'k'").run();
        expect(read()).toBe('again');
        b.prepare("DELETE FROM node_config WHERE key = 'k'").run();
        expect(read()).toBeNull();
        expect(loads).toBe(4);
    });

    it('reads the table inside a transaction, and a rollback leaves no value that was only ever inside it', () => {
        const { a } = twoConnections();
        a.prepare("INSERT INTO node_config VALUES ('k', 'committed')").run();
        let loads = 0;
        const read = () => readWhileUnchanged(a, 'v', () => { loads++; return (a.prepare("SELECT value FROM node_config WHERE key = 'k'").get() as { value: string }).value; });
        expect(read()).toBe('committed');
        a.exec('BEGIN');
        a.prepare("UPDATE node_config SET value = 'uncommitted' WHERE key = 'k'").run();
        expect(read()).toBe('uncommitted');
        expect(read()).toBe('uncommitted');
        a.exec('ROLLBACK');
        // `total_changes` does not go back with a rollback: a value kept from inside the transaction would be served here.
        expect(read()).toBe('committed');
        expect(read()).toBe('committed');
        // And a commit.
        a.exec('BEGIN');
        a.prepare("UPDATE node_config SET value = 'second' WHERE key = 'k'").run();
        expect(read()).toBe('second');
        a.exec('COMMIT');
        expect(read()).toBe('second');
        // A transaction that writes nothing to the table, rolled back, changes nothing.
        a.exec('BEGIN');
        expect(read()).toBe('second');
        a.exec('ROLLBACK');
        expect(read()).toBe('second');
        // db.transaction() is a transaction too.
        const inTxn = a.transaction(() => {
            a.prepare("UPDATE node_config SET value = 'in a function' WHERE key = 'k'").run();
            const seen = read();
            throw Object.assign(new Error('refused'), { seen });
        });
        let seen = '';
        try { inTxn(); } catch (e) { seen = (e as { seen: string }).seen; }
        expect(seen).toBe('in a function');
        expect(read()).toBe('second');
        expect(loads).toBeGreaterThan(1);
    });

    it('keeps each handle and each slot apart', () => {
        const x = twoConnections().a, y = twoConnections().a;
        x.prepare("INSERT INTO node_config VALUES ('k', 'x')").run();
        y.prepare("INSERT INTO node_config VALUES ('k', 'y')").run();
        const get = (db: Database.Database, slot: string) => readWhileUnchanged(db, slot, () => (db.prepare("SELECT value FROM node_config WHERE key = 'k'").get() as { value: string }).value + slot);
        expect([get(x, 's1'), get(y, 's1'), get(x, 's2'), get(y, 's2')]).toEqual(['xs1', 'ys1', 'xs2', 'ys2']);
    });

    it('reads through every time on a handle that is being watched, and on a closed one throws as a read does', () => {
        const { a } = twoConnections();
        let loads = 0;
        const load = () => { loads++; return 1; };
        (a as any).prepare = a.prepare.bind(a);
        readWhileUnchanged(a, 'v', load);
        readWhileUnchanged(a, 'v', load);
        delete (a as any).prepare;
        expect(loads).toBe(2);
        a.close();
        expect(() => readWhileUnchanged(a, 'v', () => a.prepare('SELECT 1').get())).toThrow();
    });
});

// ── The reads that use them answer what they answered ─────────────────────────────────────────────────────────────────

const SCHEMA = readFileSync(fileURLToPath(new URL('../../../../apps/server/src/db/schema.sql', import.meta.url)), 'utf8');

function node(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec(SCHEMA);
    registerGeoFunctions(db);
    const member = db.prepare("INSERT INTO members (public_key, callsign, joined_at) VALUES (?, ?, '2026-11-01')");
    for (const pk of ['alice', 'bob', 'cleo']) member.run(pk, pk);
    const post = db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, created_at, updated_at, lat, lng)
                             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`);
    const rows: Array<[string, string, string, string, string, string, number, number]> = [
        ['p1', 'offer', 'food', 'Eggs', 'Free range', 'alice', -37.81, 144.96],
        ['p2', 'need', 'tools', 'A ladder', 'For a day', 'bob', -37.82, 144.97],
        ['p3', 'offer', 'tools', 'Spade', 'Good', 'alice', -37.9, 145.1],
        ['p4', 'offer', 'food', 'Honey', 'Local', 'cleo', -33.87, 151.2],
        ['p5', 'offer', 'food', 'Bread', 'Sourdough', 'bob', -37.8, 144.95],
        ['p6', 'need', 'food', 'Lemons', 'Any', 'cleo', -37.79, 144.94],
    ];
    rows.forEach(([id, type, cat, title, desc, author, lat, lng], i) => {
        const at = `2026-11-0${i + 1}T10:00:00.000Z`;
        post.run(id, type, cat, title, desc, author, at, at, lat, lng);
    });
    return db;
}

const HUB = { lat: -37.81, lng: 144.96 };
const FILTERS: Array<[string, PostFilter]> = [
    ['the board', {}],
    ['a page', { limit: 2, offset: 1 }],
    ['one type', { type: 'offer' }],
    ['two types', { types: ['offer', 'need'] }],
    ['a category', { category: 'food' }],
    ['one author', { authorPubkey: 'alice', viewerPubkey: 'alice' }],
    ['nearest first', { near: HUB, sortByDistance: true }],
    ['nearest first, a page', { near: HUB, sortByDistance: true, limit: 2 }],
    ['a radius', { near: { ...HUB, radiusKm: 30 }, sortByDistance: true }],
    ['a radius, newest first', { near: { ...HUB, radiusKm: 30 } }],
    ['a measured pass', { near: { ...HUB, radiusKm: 30 }, sortByDistance: true, measureAtMost: 4 }],
    ['ids', { ids: ['p1', 'p4', 'p6'] }],
];

describe('the reads that keep their statements answer what a fresh prepare answers', () => {
    it('getPosts: every shape of board and map read, run again with other values, is the same as with nothing kept', () => {
        const db = node();
        const run = () => FILTERS.map(([name, f]) => [name, getPosts(db, f).map(p => [p.id, (p as any).distanceKm ?? null])] as const);
        const first = run();
        const second = run();
        expect(second).toEqual(first);
        expect(preparedShapeCount(db)).toBeGreaterThan(3);

        // The other values of the same shapes: a point elsewhere, another author, another page.
        const other: Array<[string, PostFilter]> = [
            ['nearest first, elsewhere', { near: { lat: -33.87, lng: 151.2 }, sortByDistance: true }],
            ['one author, another', { authorPubkey: 'bob', viewerPubkey: 'bob' }],
            ['a page, another', { limit: 2, offset: 3 }],
        ];
        const runOther = () => other.map(([name, f]) => [name, getPosts(db, f).map(p => p.id)] as const);
        const keptOther = runOther();
        const keptAgain = runOther();

        // The same reads on a handle that is watched: nothing is kept, every statement is prepared fresh.
        const real = db.prepare.bind(db);
        (db as any).prepare = (s: string) => real(s);
        try {
            expect(run()).toEqual(first);
            expect(runOther()).toEqual(keptOther);
        } finally {
            delete (db as any).prepare;
        }
        expect(keptAgain).toEqual(keptOther);
        expect(keptOther[0][1][0]).toBe('p4'); // the point moved: Sydney's honey is first
    });

    it('a warm board read compiles nothing', () => {
        const db = node();
        for (const [, f] of FILTERS) getPosts(db, f);
        const { compiles } = countCompiles(db, () => { for (const [, f] of FILTERS) getPosts(db, f); });
        // The ranking and page statements, and the id lists, are kept. What a read still compiles is the handful of its own
        // single-use reads (they stay `db.prepare` on purpose, statements.ts), none of them the ranking SQL.
        expect(compiles.filter(s => /FROM posts/.test(s) && /ORDER BY/.test(s))).toEqual([]);
        expect(compiles.filter(s => /post_photos WHERE post_id IN/.test(s))).toEqual([]);
    });

    it('getConversationsByMember: the same list after new conversations and messages, with the statement kept', () => {
        const db = node();
        db.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES ('c1', 'direct', 'alice', '2026-11-01')").run();
        for (const k of ['alice', 'bob']) db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run('c1', k);
        const names = (k: string) => getConversationsByMember(db, k).map(c => [c.id, c.participants.slice().sort()]);
        expect(names('alice')).toEqual([['c1', ['alice', 'bob']]]);
        expect(names('cleo')).toEqual([]);
        db.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES ('c2', 'direct', 'alice', '2026-11-02')").run();
        for (const k of ['alice', 'cleo']) db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run('c2', k);
        expect(names('alice').map(r => r[0]).sort()).toEqual(['c1', 'c2']);
        expect(names('cleo')).toEqual([['c2', ['alice', 'cleo']]]);
        const { compiles } = countCompiles(db, () => { names('alice'); names('bob'); });
        expect(compiles.filter(s => /FROM conversations c/.test(s))).toEqual([]);
    });
});

describe('the known floor\'s dial', () => {
    function configured(rows: Record<string, string> = {}): Database.Database {
        const db = new Database(':memory:');
        db.exec('CREATE TABLE node_config (key TEXT PRIMARY KEY, value TEXT)');
        for (const [k, v] of Object.entries(rows)) db.prepare('INSERT INTO node_config VALUES (?, ?)').run(k, v);
        return db;
    }
    afterEach(() => configureKnownFloorBeans(null));

    it('is the owner\'s switch on a node with Beans, and a write by anyone is the next read\'s', () => {
        const db = configured();
        configureKnownFloorBeans(() => true);
        expect(confirmationDialOn(db)).toBe(true);
        db.prepare("INSERT INTO node_config VALUES (?, 'off')").run(CONFIRMATION_DIAL_KEY);
        expect(confirmationDialOn(db)).toBe(false);
        db.prepare('DELETE FROM node_config WHERE key = ?').run(CONFIRMATION_DIAL_KEY);
        expect(confirmationDialOn(db)).toBe(true);
        db.prepare("INSERT INTO node_config VALUES (?, '3000')").run(CREDIT_CAP_KEY);
        db.prepare("INSERT INTO node_config VALUES (?, '1500')").run(KNOWN_FLOOR_KEY);
        expect([savedCreditCap(db), creditCap(db), knownFloor(db)]).toEqual([3000, 3000, 1500]);
        db.prepare("UPDATE node_config SET value = '2500' WHERE key = ?").run(KNOWN_FLOOR_KEY);
        db.prepare("UPDATE node_config SET value = '2000' WHERE key = ?").run(CREDIT_CAP_KEY);
        expect([savedCreditCap(db), creditCap(db), knownFloor(db)]).toEqual([2000, 2000, 2000]); // a floor is never above the cap
        db.prepare("INSERT INTO node_config VALUES (?, 'off')").run(CONFIRMATION_DIAL_KEY);
        expect([confirmationDialOn(db), creditCap(db)]).toEqual([false, CREDIT_CAP_DEFAULT]);
    });

    it('reads off on a node without Beans whatever its row says, and does not read the row', () => {
        const db = configured({});
        configureKnownFloorBeans(() => false);
        const { result, compiles } = countCompiles(db, () => [confirmationDialOn(db), confirmationDialOn(db)]);
        expect(result).toEqual([false, false]);
        expect(compiles).toEqual([]);
        db.prepare("INSERT INTO node_config VALUES (?, 'on')").run(CONFIRMATION_DIAL_KEY);
        expect(confirmationDialOn(db)).toBe(false);
        // The same answers as the row-first order gave, for every row and both kinds of node.
        for (const row of [null, 'off', 'on', 'garbage']) {
            for (const beans of [true, false]) {
                const d = configured(row === null ? {} : { [CONFIRMATION_DIAL_KEY]: row });
                configureKnownFloorBeans(() => beans);
                expect(confirmationDialOn(d), `row ${row}, beans ${beans}`).toBe(row !== 'off' && beans);
            }
        }
        configureKnownFloorBeans(null);
        expect(confirmationDialOn(configured({}))).toBe(true);
        expect(confirmationDialOn(configured({ [CONFIRMATION_DIAL_KEY]: 'off' }))).toBe(false);
    });
});
