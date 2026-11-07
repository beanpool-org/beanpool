// Statements compiled once per database handle.
//
// better-sqlite3 compiles a statement on every `db.prepare`, and the board read (getPosts) prepared the same few
// statements for every post on the page: the author's trust profile alone is six, so a page of 50 compiled about 300
// statements, 40% of a visitor's board read on the global node (scratch/global-node/REPORT-global-load-rehearsal.md §4).
// A statement kept here is compiled once and run with fresh parameters each time.
//
// For the statements a read runs once per row (the trust profile per author, the host test per event), where compiling
// is the cost. A read's own queries, run once each, stay `db.prepare` unless they are among the shapes below
// (`preparedShape`): suites watch which of them ran by wrapping `db.prepare` (the nearest-first circles, a sync's delta
// read), and a shape cache prepares through a wrapped handle, so those suites still see every statement.
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

// ── Statements by shape ──────────────────────────────────────────────────────────────────────────────────────────
// The reads whose text is built from the filter (the ranking SQL of a board or map read, an IN list of one page's ids) and
// the per-request lists (a member's chats and groups) compiled their statement on every call: `Statement` was 15.8% of the
// launch mix's busy time on the global node (scratch/global-node/REPORT-global-load-rehearsal-2026-11-07.md §7). The SQL
// text is the shape: the same filter builds the same text, and the values travel as parameters, so a statement kept by its
// text answers a new call exactly as a fresh prepare would.
//
// Apart from `prepared` above (a statement a read runs once per row, on a short fixed list): a shape cache is LRU, so a
// flood of one-off texts (an IN list's length is a different text for each length) pushes out the texts nobody has asked
// for, not the hot ones, and holds at most MAX_SHAPES_PER_HANDLE texts of at most MAX_SHAPE_TEXT characters; a longer text
// is prepared fresh each time, as before. Run with `.get()`, `.all()` or `.run()` only, as for `prepared`.
//
// A handle whose `prepare` has been replaced (an own property: better-sqlite3's is on its prototype, a suite that wraps it
// to see which statements ran, or count them, sets one) is being WATCHED: every statement is prepared through it, as it
// always was, and none is kept, so the watcher sees what it saw before and no later read runs a statement it patched.
const MAX_SHAPES_PER_HANDLE = 128;
const MAX_SHAPE_TEXT = 16_384;

const shapes = new WeakMap<Db, Map<string, Database.Statement>>();

/** `db.prepare(sql)` for a text built from a filter or a list, compiled once per handle while it stays among the 128 most recently asked for. */
export function preparedShape(db: Db, sql: string): Database.Statement {
    if (sql.length > MAX_SHAPE_TEXT || Object.prototype.hasOwnProperty.call(db, 'prepare')) return db.prepare(sql);
    let byText = shapes.get(db);
    if (!byText) shapes.set(db, byText = new Map());
    const kept = byText.get(sql);
    if (kept) {
        // Most recent last: the first key is the one to push out.
        byText.delete(sql);
        byText.set(sql, kept);
        return kept;
    }
    const stmt = db.prepare(sql);
    if (byText.size >= MAX_SHAPES_PER_HANDLE) byText.delete(byText.keys().next().value!);
    byText.set(sql, stmt);
    return stmt;
}

/** How many texts are kept for this handle (for suites). */
export function preparedShapeCount(db: Db): number {
    return shapes.get(db)?.size ?? 0;
}

// ── What the database has committed since ────────────────────────────────────────────────────────────────────────
// A value read from `node_config` (the profile's switch overrides) was read from the table on every call, for every
// listing of a page. It is kept here while NOTHING has been written to the database since it was read, by whoever wrote:
//   - `total_changes()` counts every row this connection has inserted, changed or deleted (a trigger's and a cascade's
//     too), so a write through any path in this process moves it: the owner console, an MCP tool, a standby's copy, a test's
//     raw SQL;
//   - `PRAGMA data_version` moves when ANOTHER connection commits, which is how a command run on the server (the CLI) is seen.
// Any write anywhere moves one of them, so a kept value is never older than the last write. A write to some other table
// moves them too and costs one more read, nothing worse. The two together cost about 0.9 microseconds against 2.2 for the
// overrides' own read (on a copy of the load rehearsal's database; the combined `pragma_data_version` table form is 1.3).
//
// Not while a transaction is open: what it has written is not committed, and a ROLLBACK moves neither number, so a value
// read inside it could outlive the rows it was read from. Inside one, every call reads the table.
const tokenStatements = new WeakMap<Db, { changes: Database.Statement; version: Database.Statement }>();
const heldValues = new WeakMap<Db, Map<string, { changes: unknown; version: unknown; value: unknown }>>();

/**
 * `load()`, run again only after the database has been written since the last call (see above). `slot` names the value;
 * `load` reads what it needs from `db` and returns something nobody mutates (a caller that hands it on copies it).
 * The two counters are read BEFORE `load` runs: a write from another connection between the two moves them again, and the
 * next call reads afresh (the other order could keep an old value under a new token). A handle that is watched (see
 * above) or on which they can't be read (a closed one) reads through every time.
 */
export function readWhileUnchanged<T>(db: Db, slot: string, load: () => T): T {
    if (db.inTransaction || Object.prototype.hasOwnProperty.call(db, 'prepare')) return load();
    let changes: unknown, version: unknown;
    try {
        let st = tokenStatements.get(db);
        if (!st) {
            tokenStatements.set(db, st = {
                changes: db.prepare('SELECT total_changes()').pluck(),
                version: db.prepare('PRAGMA data_version').pluck(),
            });
        }
        changes = st.changes.get();
        version = st.version.get();
    } catch {
        return load();
    }
    let slots = heldValues.get(db);
    if (!slots) heldValues.set(db, slots = new Map());
    const have = slots.get(slot);
    if (have && have.changes === changes && have.version === version) return have.value as T;
    const value = load();
    slots.set(slot, { changes, version, value });
    return value;
}
