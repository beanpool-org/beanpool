// Statements compiled once per database handle.
//
// better-sqlite3 compiles a statement on every `db.prepare`, and the board read (getPosts) prepared the same few
// statements for every post on the page: the author's trust profile alone is six, so a page of 50 compiled about 300
// statements, 40% of a visitor's board read on the global node (scratch/global-node/REPORT-global-load-rehearsal.md §4).
// A statement kept here is compiled once and run with fresh parameters each time.
//
// Only for a statement run with `.get()`, `.all()` or `.run()` and nothing else: one switched to `.pluck()`, `.raw()` or
// `.expand()`, or left mid-`.iterate()`, would change it for every later caller. Keyed by the handle itself, as the trust
// caches are, so the manager's many replica databases never share one; a handle that is closed throws on its cached
// statements exactly as it would on a fresh prepare. SQLite recompiles a cached statement by itself after a schema change.
import type Database from 'better-sqlite3';

type Db = Database.Database;

/** The most statements kept for one handle. Past it the oldest goes: a query whose text varies (an IN list's length) can't fill memory. */
const MAX_PER_HANDLE = 200;

const cache = new WeakMap<Db, Map<string, Database.Statement>>();

/** `db.prepare(sql)`, compiled once per handle and text (see above for which statements may use it). */
export function prepared(db: Db, sql: string): Database.Statement {
    let byText = cache.get(db);
    if (!byText) cache.set(db, byText = new Map());
    let stmt = byText.get(sql);
    if (!stmt) {
        stmt = db.prepare(sql);
        if (byText.size >= MAX_PER_HANDLE) byText.delete(byText.keys().next().value!);
        byText.set(sql, stmt);
    }
    return stmt;
}
