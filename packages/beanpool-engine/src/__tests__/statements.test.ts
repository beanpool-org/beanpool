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
