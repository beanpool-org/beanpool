import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { prepared } from '../statements.js';

function counted(): { db: Database.Database; compiles: () => number } {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
    let n = 0;
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => { n++; return prepare(sql); };
    return { db, compiles: () => n };
}

describe('prepared: statements compiled once per database handle', () => {
    it('compiles a text once, and each run reads what is there now', () => {
        const { db, compiles } = counted();
        const sql = 'SELECT v FROM t WHERE k = ?';
        expect(prepared(db, sql).get('a')).toBeUndefined();
        db.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', 1);
        expect((prepared(db, sql).get('a') as { v: number }).v).toBe(1);
        db.prepare('UPDATE t SET v = 2 WHERE k = ?').run('a');
        expect((prepared(db, sql).get('a') as { v: number }).v).toBe(2);
        // The SELECT once, the INSERT and the UPDATE once each.
        expect(compiles()).toBe(3);
    });

    it('keeps each handle apart', () => {
        const a = counted(), b = counted();
        a.db.prepare("INSERT INTO t (k, v) VALUES ('x', 1)").run();
        b.db.prepare("INSERT INTO t (k, v) VALUES ('x', 2)").run();
        const sql = "SELECT v FROM t WHERE k = 'x'";
        expect((prepared(a.db, sql).get() as { v: number }).v).toBe(1);
        expect((prepared(b.db, sql).get() as { v: number }).v).toBe(2);
        expect(prepared(a.db, sql)).not.toBe(prepared(b.db, sql));
    });

    it('holds at most 200 texts a handle, the oldest going first', () => {
        const { db, compiles } = counted();
        const text = (i: number) => `SELECT ${i} AS n`;
        for (let i = 0; i < 201; i++) prepared(db, text(i));
        expect(compiles()).toBe(201);
        prepared(db, text(200));
        expect(compiles()).toBe(201);
        // The first went to make room for the 201st, so it is compiled again.
        prepared(db, text(0));
        expect(compiles()).toBe(202);
    });

    it('throws on a closed handle, as a fresh prepare does', () => {
        const { db } = counted();
        const stmt = prepared(db, 'SELECT 1 AS one');
        expect((stmt.get() as { one: number }).one).toBe(1);
        db.close();
        expect(() => prepared(db, 'SELECT 1 AS one').get()).toThrow();
    });
});

// The member checks every signed request runs (the server's signature check, readsAsMember): compiled once per handle
// (load model 2026-10-05, finding 2: `prepare` the top self-time frame), answering exactly what a fresh prepare does.
describe('the per-request member checks use the cached statements', () => {
    function membersDb(): { db: Database.Database; compiles: () => number } {
        const db = new Database(':memory:');
        db.exec(`CREATE TABLE members (public_key TEXT PRIMARY KEY, status TEXT, is_visitor INTEGER);
                 CREATE TABLE invalidated_keys (public_key TEXT PRIMARY KEY);`);
        let n = 0;
        const prepare = db.prepare.bind(db);
        (db as any).prepare = (sql: string) => { n++; return prepare(sql); };
        return { db, compiles: () => n };
    }
    // What isNodeMember and isInvalidatedKey answered before, every statement freshly prepared.
    const reference = (db: Database.Database, k: string | null) => {
        if (!k) return { member: false, invalidated: false };
        const invalidated = !!db.prepare('SELECT 1 FROM invalidated_keys WHERE public_key = ?').get(k.toLowerCase());
        const row = db.prepare('SELECT status, is_visitor FROM members WHERE public_key = ?').get(k) as { status: string | null; is_visitor: number | null } | undefined;
        return { member: !!row && !row.is_visitor && row.status !== 'pruned' && !invalidated, invalidated };
    };
    const keys = ['aa', 'AA', 'bb', 'cc', 'dd', 'ee', '', null];

    it('answers as a fresh prepare does through every state, compiling each statement once', async () => {
        const { isNodeMember, isInvalidatedKey } = await import('../members.js');
        const { db, compiles } = membersDb();
        const states: string[] = [
            '',
            "INSERT INTO members VALUES ('aa', 'active', 0), ('bb', NULL, NULL), ('cc', 'pruned', 0), ('dd', 'active', 1)",
            "INSERT INTO invalidated_keys VALUES ('bb')",
            "UPDATE members SET status = 'pruned' WHERE public_key = 'aa'",
            "UPDATE members SET is_visitor = 0, status = 'active' WHERE public_key = 'dd'",
            "DELETE FROM invalidated_keys; INSERT INTO members VALUES ('ee', 'suspended', 0)",
            'DELETE FROM members',
        ];
        let checks = 0, ours = 0;
        for (const change of states) {
            if (change) db.exec(change);
            for (const k of keys) {
                const want = reference(db, k);
                const before = compiles();
                expect(isNodeMember(db, k)).toBe(want.member);
                expect(isInvalidatedKey(db, k)).toBe(want.invalidated);
                ours += compiles() - before;
                checks++;
            }
        }
        expect(checks).toBe(56);
        // 112 calls, two statements, each compiled once on this handle.
        expect(ours).toBe(2);
    });

    it('a new handle (a restore, a fresh test database) gets its own statements and its own answers', async () => {
        const { isNodeMember } = await import('../members.js');
        const a = membersDb();
        a.db.exec("INSERT INTO members VALUES ('aa', 'active', 0)");
        expect(isNodeMember(a.db, 'aa')).toBe(true);
        a.db.close();
        // The closed handle throws, as a fresh prepare on it would.
        expect(() => isNodeMember(a.db, 'aa')).toThrow();
        const b = membersDb();
        b.db.exec("INSERT INTO members VALUES ('aa', 'active', 0); INSERT INTO invalidated_keys VALUES ('aa')");
        expect(isNodeMember(b.db, 'aa')).toBe(false);
        expect(b.compiles()).toBe(2);
    });
});
