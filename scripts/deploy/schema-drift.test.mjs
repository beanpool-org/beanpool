/* global process, console -- a Node script */
// scripts/deploy/schema-drift.mjs, the read-only pre-deploy check: a fixture database holding each case (an old CHECK on an
// empty local table, the same with rows, a copied table's drift, a column IF NOT EXISTS misses, a table written another way
// with a column a boot step adds, an identical one) reads the right line; a boot step is proved against the rows that are
// there (a step the rows refuse reads as drift, the same step on an empty table as OK, a refused step is never OK); the steps
// replay in the boot's order (a fixture's initSchema run for real on a copy leaves what the replay found, and this checkout's
// db.ts, booted through tsx on a kept 1.4.0 file with a statement trace, runs the replay's statements in the replay's order); a
// step is read only in a shape that runs on its own (one table of shapes x what the table holds, each against a real boot
// of the shape's own code: the read shapes read OK, every other ALTER reads can't prove and exits 1, whatever the table holds);
// it opens the database read-only (a write fails) and leaves the file, and a live writer's WAL, byte for byte as they were;
// its packed copy for `node -` in the container prints the same lines from what it carries; the repo's own schema.sql and
// replication manifest read whole.
// Run by test-all.sh (the `schema_drift` check): node --test scripts/deploy/schema-drift.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
    checkDrift, shapeDiffs, tableShape, manifestKinds, bootSteps, readBuild, loadSqlite, openReadOnly, parseArgs, formatResult,
    createTableParts, sqlTokens, canonical, replayBootSteps, main,
} from './schema-drift.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts/deploy/schema-drift.mjs');
const Database = loadSqlite();

// ── The fixture: the build about to deploy, and a node's database from before it ─────────────────────────────────────

const NEW_SCHEMA = `
-- The build about to deploy.
CREATE TABLE IF NOT EXISTS mail_box (
    id   TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('invite', 'line', 'edit'))
);
CREATE TABLE IF NOT EXISTS mail_sent (
    id   TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('invite', 'line', 'edit'))
);
CREATE TABLE IF NOT EXISTS listings (
    id      TEXT PRIMARY KEY,
    title   TEXT NOT NULL,
    price_c INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notes (
    id   TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    lang TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (length(value) <= 100),
    shown INTEGER NOT NULL DEFAULT 1 CHECK (shown IN (0, 1))
);
CREATE TABLE IF NOT EXISTS seen (
    member TEXT NOT NULL,
    at     INTEGER NOT NULL,
    UNIQUE (member, at)
);
CREATE INDEX IF NOT EXISTS idx_seen_at ON seen(at);
CREATE TABLE IF NOT EXISTS brand_new (id TEXT PRIMARY KEY);
`;

// The node's database: the same tables as an older build made them, a table this build no longer makes, and rows.
const OLD_SCHEMA = `
CREATE TABLE mail_box (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('invite', 'line')));
CREATE TABLE mail_sent (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('invite', 'line')));
CREATE TABLE listings (id TEXT PRIMARY KEY, title TEXT, price_c INTEGER NOT NULL DEFAULT 0);
CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE "Settings" ( -- written another way: case, quotes, spacing, comments
    KEY text primary key,
    "value" TEXT not null /* the rule */ check(LENGTH(value)<=100)
);
CREATE TABLE seen (
    member TEXT NOT NULL,
    at     INTEGER NOT NULL,
    UNIQUE (member, at)
);
CREATE TABLE gone_table (x);
INSERT INTO mail_sent VALUES ('m1', 'line');
INSERT INTO listings VALUES ('l1', 'Bread', 300), ('l2', NULL, 0);
`;

const MANIFEST = `
export const TABLES: Record<string, TableEntry> = {
    mail_box: { kind: 'local', reason: 'held until the devices have it' },
    // a comment line: { kind: 'replicated' }
    mail_sent: { kind: 'local', reason: 'what members sent' },
    listings: {
        kind: 'replicated', payload: 'posts', watermark: 'updated_at',
        columns: cols('id title price_c'),
    },
    notes: { kind: 'local', reason: 'this server only' },
    settings: plain('key value shown'),
    // except: a comment between entries names no exception
    pushes: plain('id token', { rows: MEMBERS_OWN, except: {
        token: { why: 'sealed by each server' },
    } }),
    seen: { kind: 'local', reason: 'this server only' },
    brand_new: { kind: 'local', reason: 'new' },
};

export const OTHER: Record<string, string> = {
    mail_box: { kind: 'replicated' },
};
`;

// db.ts as far as the check reads it: initSchema's boot steps before its top-level schema.sql exec.
const DB_TS = `
export function initSchema() {
    const gate = readSchemaGate(db);
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    if (gate.kind === 'fresh') db.transaction(() => { db.exec(schemaSql); writeSchemaStamp(db, getVersion()); })();
    try { db.prepare(\`ALTER TABLE settings ADD COLUMN shown INTEGER NOT NULL DEFAULT 1 CHECK (shown IN (0, 1))\`).run(); } catch { }
    db.exec(schemaSql);
    try { db.prepare('ALTER TABLE notes ADD COLUMN lang TEXT').run(); } catch { }
}
`;

/** A temp dir with the fixture's build files (or `build`'s) and a node database; `old` is its schema and rows. */
function fixture(old = OLD_SCHEMA, build = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'schema-drift-'));
    const files = { schema: join(dir, 'schema.sql'), manifest: join(dir, 'replication-manifest.ts'), boot: join(dir, 'db.ts'), db: join(dir, 'state.db') };
    writeFileSync(files.schema, build.schema ?? NEW_SCHEMA);
    writeFileSync(files.manifest, build.manifest ?? MANIFEST);
    writeFileSync(files.boot, build.boot ?? DB_TS);
    const d = new Database(files.db);
    d.exec(old);
    d.close();
    return { dir, ...files, args: ['--db', files.db, '--schema', files.schema, '--manifest', files.manifest, '--boot-steps', files.boot] };
}

const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts });
const tableLines = (stdout) => stdout.split('\n').filter((l) => l && !l.startsWith('schema-drift:'));
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
/**
 * The bracket of a table that `n` ALTERs in db.ts name (or name no table) outside the step shapes the check reads, and `m`
 * other texts the boot may run before the exec name (or whose names can't be read).
 */
const cantProve = (n, m = 0) => `can't prove its boot: ${[
    ...(n > 0 ? [`${n} ALTER in db.ts not written as a step the check reads (alone in an empty try at initSchema's top level, before the schema.sql exec)`] : []),
    ...(m > 0 ? [`${m} other text in db.ts the boot may run before the schema.sql exec (in initSchema or what it calls) that names it or whose names can't be read`] : []),
].join('; ')}, so no replay ran`;

const EXPECTED = [
    'DRIFT-REPLICATED listings rows=2 replicated: title: NULL allowed here, NOT NULL in schema.sql',
    "DRIFT-EMPTY-LOCAL mail_box rows=0 local: CHECK only here: kind in ('invite', 'line'); CHECK only in schema.sql: kind in ('invite', 'line', 'edit')",
    "DRIFT-HAS-ROWS mail_sent rows=1 local: CHECK only here: kind in ('invite', 'line'); CHECK only in schema.sql: kind in ('invite', 'line', 'edit')",
    'DRIFT-EMPTY-LOCAL notes rows=0 local: columns only in schema.sql: lang',
    'OK seen local',
    'OK Settings replicated (with the columns a boot step in db.ts adds: shown)',
];

test('each case reads its line: old CHECK empty local, old CHECK with rows, a copied table, a missed column, the same table', () => {
    const f = fixture();
    try {
        const r = run(f.args);
        assert.equal(r.status, 1, r.stderr);
        assert.deepEqual(tableLines(r.stdout), EXPECTED);
        const [head, ...rest] = r.stdout.trim().split('\n');
        const shaOfSchema = createHash('sha256').update(NEW_SCHEMA).digest('hex').slice(0, 12);
        assert.equal(head, `schema-drift: ${f.db} against schema.sql ${shaOfSchema}, read-only`);
        assert.equal(rest.at(-1), 'schema-drift: 6 tables compared, 4 drift; 1 in schema.sql not in this database yet (the deploy makes them); 1 here not in schema.sql (not compared)');
    } finally {
        rmSync(f.dir, { recursive: true, force: true });
    }
});

test('a database the build itself made reads OK everywhere and exits 0', () => {
    const f = fixture(NEW_SCHEMA);
    try {
        const r = run(f.args);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.ok(tableLines(r.stdout).every((l) => l.startsWith('OK ')), r.stdout);
        assert.equal(tableLines(r.stdout).length, 7);
    } finally {
        rmSync(f.dir, { recursive: true, force: true });
    }
});

test('a boot step that is not before the exec counts for nothing: the column reads as missing', () => {
    // notes.lang's ALTER in the fixture's db.ts is AFTER the exec, so it isn't a step this build runs before schema.sql.
    const steps = bootSteps(DB_TS);
    assert.deepEqual(steps, { steps: [{ table: 'settings', def: 'shown INTEGER NOT NULL DEFAULT 1 CHECK (shown IN (0, 1))' }], unread: [], named: [], found: true });
});

test('the database is opened read-only: a write through it fails, and the file is left byte for byte', () => {
    const f = fixture();
    try {
        const db = openReadOnly(Database, f.db);
        assert.throws(() => db.prepare("INSERT INTO notes (id, body) VALUES ('n1', 'x')").run(), /readonly|read-only|query_only|attempt to write/i);
        assert.throws(() => db.exec('DROP TABLE mail_box'), /readonly|read-only|query_only|attempt to write/i);
        db.close();
        assert.throws(() => openReadOnly(Database, join(f.dir, 'no-such.db')), /unable to open|does not exist|no such file/i);

        const before = { sha: sha(f.db), mtime: statSync(f.db).mtimeMs };
        assert.equal(run(f.args).status, 1);
        assert.equal(sha(f.db), before.sha);
        assert.equal(statSync(f.db).mtimeMs, before.mtime);
        const d = new Database(f.db, { readonly: true });
        assert.deepEqual(d.prepare('SELECT COUNT(*) AS n FROM mail_box').get(), { n: 0 }, 'no row written');
        assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'mail_box'").get(), 'nothing dropped');
        d.close();
    } finally {
        rmSync(f.dir, { recursive: true, force: true });
    }
});

test('beside a running server (WAL, a writer holding uncheckpointed writes): it reads them and changes neither file', () => {
    const f = fixture('PRAGMA journal_mode = WAL;');
    const writer = new Database(f.db);
    try {
        writer.pragma('wal_autocheckpoint = 0');
        writer.exec(OLD_SCHEMA);
        writer.exec("INSERT INTO mail_box VALUES ('w1', 'invite')"); // only in the WAL: mail_box now has a row
        const wal = `${f.db}-wal`;
        const before = { db: sha(f.db), wal: sha(wal) };
        const r = run(f.args);
        assert.equal(r.status, 1, r.stderr);
        assert.ok(tableLines(r.stdout).includes(
            "DRIFT-HAS-ROWS mail_box rows=1 local: CHECK only here: kind in ('invite', 'line'); CHECK only in schema.sql: kind in ('invite', 'line', 'edit')"), r.stdout);
        assert.equal(sha(f.db), before.db);
        assert.equal(sha(wal), before.wal);
        assert.deepEqual(writer.prepare('SELECT COUNT(*) AS n FROM mail_box').get(), { n: 1 });
    } finally {
        writer.close();
        rmSync(f.dir, { recursive: true, force: true });
    }
});

test('the packed copy, run as `node --input-type=module -` from the server folder, prints the same from what it carries', () => {
    const f = fixture();
    try {
        const pack = run(['--schema', f.schema, '--manifest', f.manifest, '--boot-steps', f.boot, '--pack']);
        assert.equal(pack.status, 0, pack.stderr);
        assert.match(pack.stdout, /^const PACKED = \{/m);
        assert.doesNotMatch(pack.stdout, /^const PACKED = null;$/m);
        // The build's files are gone: the copy needs only the database.
        rmSync(f.schema); rmSync(f.manifest); rmSync(f.boot);
        const r = spawnSync(process.execPath, ['--input-type=module', '-', '--db', f.db], {
            input: pack.stdout, encoding: 'utf8', cwd: join(ROOT, 'apps/server'),
        });
        assert.equal(r.status, 1, r.stderr);
        assert.deepEqual(tableLines(r.stdout), EXPECTED);
    } finally {
        rmSync(f.dir, { recursive: true, force: true });
    }
});

// ── A boot step is proved against the rows that are there ────────────────────────────────────────────────────────────

// SQLite checks some ADD COLUMN rules only against the rows a table holds: on a kept node with rows, db.ts's try/catch drops
// the refused step without a word and the table keeps its old shape. The build: two tables a boot step each adds a column to.
const ROWS_BUILD = {
    schema: `
CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, b TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS u (id TEXT PRIMARY KEY, c INTEGER DEFAULT 5 CHECK (c < 3));
`,
    manifest: `
export const TABLES: Record<string, TableEntry> = {
    t: plain('id b'),
    u: { kind: 'local', reason: 'this server only' },
};
`,
    boot: `
export function initSchema() {
    try { db.prepare('ALTER TABLE t ADD COLUMN b TEXT NOT NULL').run(); } catch { }
    try { db.prepare('ALTER TABLE u ADD COLUMN c INTEGER DEFAULT 5 CHECK (c < 3)').run(); } catch { }
    db.exec(schemaSql);
}
`,
};
const ROWS_OLD = 'CREATE TABLE t (id TEXT PRIMARY KEY); CREATE TABLE u (id TEXT PRIMARY KEY);';

test('a boot step the rows refuse (NOT NULL with no default, a CHECK the default fails) reads as drift and exits 1; the file is left as it was', () => {
    const f = fixture(`${ROWS_OLD} INSERT INTO t VALUES ('t1'); INSERT INTO u VALUES ('u1');`, ROWS_BUILD);
    try {
        const before = { sha: sha(f.db), mtime: statSync(f.db).mtimeMs };
        const r = run(f.args);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.deepEqual(tableLines(r.stdout), [
            'DRIFT-REPLICATED t rows=1 replicated (boot steps in db.ts refused here: b (Cannot add a NOT NULL column with default value NULL)): columns only in schema.sql: b',
            'DRIFT-HAS-ROWS u rows=1 local (boot steps in db.ts refused here: c (CHECK constraint failed)): columns only in schema.sql: c; CHECK only in schema.sql: c < 3',
        ]);
        assert.equal(sha(f.db), before.sha);
        assert.equal(statSync(f.db).mtimeMs, before.mtime);
        // What the boot itself does on a copy of that file: both steps refused, as the check said.
        const copy = join(f.dir, 'boot-copy.db');
        writeFileSync(copy, readFileSync(f.db));
        const boot = new Database(copy);
        for (const step of ['ALTER TABLE t ADD COLUMN b TEXT NOT NULL', 'ALTER TABLE u ADD COLUMN c INTEGER DEFAULT 5 CHECK (c < 3)']) {
            assert.throws(() => boot.exec(step), /NOT NULL|CHECK/);
        }
        boot.close();
    } finally {
        rmSync(f.dir, { recursive: true, force: true });
    }
});

test('the same steps on empty tables: each takes, every line reads OK and it exits 0', () => {
    const f = fixture(ROWS_OLD, ROWS_BUILD);
    try {
        const r = run(f.args);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.deepEqual(tableLines(r.stdout), [
            'OK t replicated (with the columns a boot step in db.ts adds: b)',
            'OK u local (with the columns a boot step in db.ts adds: c)',
        ]);
    } finally {
        rmSync(f.dir, { recursive: true, force: true });
    }
});

/**
 * Table t's line when the node's t is `columns` (+ `suffix`) holding `rows`, schema.sql's t has `def` as well (or is `fresh`),
 * and the one boot step adds `def`: checked through the read-only handle, which must still refuse a write afterwards.
 */
function lineWithStep({ columns = 'id INTEGER PRIMARY KEY, n INTEGER, x', suffix = '', rows = '', def, fresh = null, kind = 'local', make = null }) {
    const dir = mkdtempSync(join(tmpdir(), 'schema-drift-'));
    try {
        const file = join(dir, 'state.db');
        const w = new Database(file);
        if (make) make(w);
        w.exec(`CREATE TABLE t (${columns})${suffix}; ${rows}`);
        w.close();
        const before = sha(file);
        const db = openReadOnly(Database, file);
        try {
            const build = { schemaSql: fresh ?? `CREATE TABLE t (${columns}, ${def})${suffix}`, kinds: { t: kind }, bootSteps: [{ table: 't', def }] };
            const { results } = checkDrift(Database, db, build);
            assert.throws(() => db.prepare('DELETE FROM t').run(), /readonly|read-only|query_only|attempt to write/i, 'the live handle still refuses a write');
            assert.equal(db.pragma('query_only', { simple: true }), 1);
            return formatResult(results.find((r) => r.table === 't'));
        } finally {
            db.close();
            assert.equal(sha(file), before, 'the node database is left byte for byte');
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('every ADD COLUMN rule SQLite checks only against rows: refused on the rows that are there, taken on an empty table', () => {
    const ROW = 'INSERT INTO t VALUES (1, 2, 7);';
    const cases = [
        { def: 'b TEXT NOT NULL', why: 'Cannot add a NOT NULL column with default value NULL' },
        { def: 'c INTEGER DEFAULT 5 CHECK (c < 3)', why: 'CHECK constraint failed' },
        // A CHECK one row fails by another column's value: no row count alone could tell (see the rows that pass, below).
        { def: 'c INTEGER CHECK (c IS NOT NULL OR n < 10)', rows: 'INSERT INTO t VALUES (1, 2, 7), (2, 50, 7);', n: 2, why: 'CHECK constraint failed' },
        { def: 'd TEXT DEFAULT CURRENT_TIMESTAMP', why: 'Cannot add a column with non-constant default' },
        { def: 'g INTEGER GENERATED ALWAYS AS (n * 2) STORED', why: 'cannot add a STORED column' },
        { def: 'v INTEGER AS (NULLIF(n, 2)) NOT NULL', why: 'NOT NULL constraint failed' },
        // Foreign keys ON in the replay, though the server runs with them OFF: the stricter way, never the other.
        { def: "p TEXT DEFAULT 'x' REFERENCES parent(id)", why: 'Cannot add a REFERENCES column with non-NULL default value' },
        { columns: 'id INTEGER PRIMARY KEY, n INTEGER, x ANY', suffix: ' STRICT', def: "c INTEGER DEFAULT 'abc'", why: 'type mismatch on DEFAULT' },
        // Each value copied with its storage class: an integer past 2^53 stays exact, a real stays real.
        { def: 'f INTEGER CHECK (f IS NOT NULL OR n != 9007199254740993)', rows: 'INSERT INTO t VALUES (1, 9007199254740993, 7);', why: 'CHECK constraint failed' },
        { def: "e INTEGER CHECK (e IS NOT NULL OR typeof(x) != 'real')", rows: 'INSERT INTO t VALUES (1, 2, 1.0);', why: 'CHECK constraint failed' },
    ];
    for (const c of cases) {
        const column = sqlTokens(c.def)[0].text;
        const rows = c.rows ?? ROW;
        // A refused step leaves the drift as read: the node's table against schema.sql's, the column (and its rules) missing.
        const columns = c.columns ?? 'id INTEGER PRIMARY KEY, n INTEGER, x';
        const asRead = diffOf(`CREATE TABLE t (${columns})${c.suffix ?? ''}`, `CREATE TABLE t (${columns}, ${c.def})${c.suffix ?? ''}`);
        assert.equal(asRead[0], `columns only in schema.sql: ${column}`);
        assert.equal(lineWithStep({ ...c, rows }),
            `DRIFT-HAS-ROWS t rows=${c.n ?? 1} local (boot steps in db.ts refused here: ${column} (${c.why})): ${asRead.join('; ')}`, c.def);
        assert.equal(lineWithStep({ ...c, rows: '' }), `OK t local (with the columns a boot step in db.ts adds: ${column})`, `${c.def} on an empty table`);
    }
    // The rows that pass a CHECK by their values: the step takes.
    assert.equal(lineWithStep({ def: 'c INTEGER CHECK (c IS NOT NULL OR n < 10)', rows: 'INSERT INTO t VALUES (1, 2, 7), (2, 9, 7);' }),
        'OK t local (with the columns a boot step in db.ts adds: c)');
    // Every value kept as stored: an integer stays an integer.
    assert.equal(lineWithStep({ def: "e INTEGER CHECK (e IS NOT NULL OR typeof(x) = 'integer')", rows: ROW }),
        'OK t local (with the columns a boot step in db.ts adds: e)');
    // A copied table's line, with rows: drift whatever the kind.
    assert.equal(lineWithStep({ def: 'b TEXT NOT NULL', rows: ROW, kind: 'replicated' }),
        'DRIFT-REPLICATED t rows=1 replicated (boot steps in db.ts refused here: b (Cannot add a NOT NULL column with default value NULL)): columns only in schema.sql: b');
});

test("a table whose boot steps can't be run on a copy of its rows keeps its drift, and the line says why", () => {
    // Its CREATE text calls a function only the server has: the scratch database can't make the table, so nothing is proved.
    const line = lineWithStep({
        columns: 'id INTEGER PRIMARY KEY, n INTEGER CHECK (server_only(n)), x', def: 'b TEXT', rows: 'INSERT INTO t VALUES (1, 2, 7);',
        fresh: 'CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, x, b TEXT)', make: (w) => w.function('server_only', (n) => n ?? 1),
    });
    assert.match(line, /^DRIFT-HAS-ROWS t rows=1 local \(its boot steps in db\.ts could not be run on a copy of its rows \(no such function: server_only\), so the drift stands as read\): /);
    assert.match(line, /columns only in schema\.sql: b/);
});

// ── The steps run in the boot's order ────────────────────────────────────────────────────────────────────────────────

// The order counts: a step can name a column a later step adds, or add a column an earlier one added (the first stands). db.ts
// mixes its forms (a loop at the top, pair loops before literals), so the replay runs them as the boot does: by place.
const ORDER_MANIFEST = `
export const TABLES: Record<string, TableEntry> = {
    t: { kind: 'local', reason: 'this server only' },
};
`;

test('a refused step is never OK, even when schema.sql names no column of it: the line says so and it exits 1', () => {
    const f = fixture("CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('t1');", {
        schema: 'CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, b TEXT);',
        manifest: ORDER_MANIFEST,
        boot: `
export function initSchema() {
    try { db.prepare('ALTER TABLE t ADD COLUMN b TEXT').run(); } catch { }
    try { db.prepare('ALTER TABLE t ADD COLUMN z TEXT NOT NULL').run(); } catch { }
    db.exec(schemaSql);
}
`,
    });
    try {
        const r = run(f.args);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.deepEqual(tableLines(r.stdout), [
            'DRIFT-HAS-ROWS t rows=1 local (with the columns a boot step in db.ts adds: b; boot steps in db.ts refused here: z (Cannot add a NOT NULL column with default value NULL)): nothing else differs',
        ]);
    } finally {
        rmSync(f.dir, { recursive: true, force: true });
    }
});

/**
 * A real boot of a fixture db.ts on a copy of `file`: its initSchema's own JavaScript, run with `db` a connection to the copy,
 * up to its schema.sql exec. So the steps run in the order the code runs them, not as the check reads them. Returns each
 * ALTER it ran, in order, with what became of it, and the shape of `table` it left.
 */
function bootFixture(dbTs, file, table) {
    const copy = `${file}-boot-copy`;
    writeFileSync(copy, readFileSync(file));
    const conn = new Database(copy);
    const ran = [];
    const schemaSql = Symbol('schema.sql');
    const reached = new Error('the schema.sql exec');
    const db = {
        prepare: (sql) => ({
            run: () => {
                const step = { sql, taken: false, error: null };
                ran.push(step);
                try { conn.prepare(sql).run(); step.taken = true; } catch (e) { step.error = e.message; throw e; }
            },
        }),
        exec: (sql) => { if (sql === schemaSql) throw reached; conn.exec(sql); },
    };
    const open = dbTs.indexOf('{', dbTs.indexOf('export function initSchema'));
    let stopped = null;
    try { new Function('db', 'schemaSql', dbTs.slice(open + 1, dbTs.lastIndexOf('}')))(db, schemaSql); } catch (e) { stopped = e; }
    assert.equal(stopped, reached, 'the fixture boot ran to its schema.sql exec');
    const shape = tableShape(conn, table);
    conn.close();
    rmSync(copy);
    return { ran, shape };
}

/** A boot step's statement, as the boot prepares it. */
const statementOf = (s) => `ALTER TABLE ${s.table} ADD COLUMN ${s.def}`;

const ORDER_CASES = [
    {
        name: 'a step names a column a later step adds: a loop at the top, the literal it needs below',
        schema: 'CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, y INTEGER, x INTEGER CHECK (x IS NULL OR x < y));',
        boot: `
export function initSchema() {
    for (const column of ['x INTEGER CHECK (x IS NULL OR x < y)']) {
        try { db.prepare(\`ALTER TABLE t ADD COLUMN \${column}\`).run(); } catch { }
    }
    try { db.prepare('ALTER TABLE t ADD COLUMN y INTEGER').run(); } catch { }
    db.exec(schemaSql);
}
`,
        line: (rows) => `${rows ? 'DRIFT-HAS-ROWS t rows=1' : 'DRIFT-EMPTY-LOCAL t rows=0'} local (with the columns a boot step in db.ts adds: y; boot steps in db.ts refused here: x (error in table t after add column: no such column: y)): columns only in schema.sql: x; CHECK only in schema.sql: x is null or x < y`,
    },
    {
        name: 'the same column twice: a pair loop adds it, a later literal adds it as schema.sql has it, and the first stands',
        schema: "CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, x TEXT NOT NULL DEFAULT '');",
        boot: `
export function initSchema() {
    for (const [table, column] of [['t', 'x TEXT']]) {
        try { db.prepare(\`ALTER TABLE \${table} ADD COLUMN \${column}\`).run(); } catch { }
    }
    try { db.prepare("ALTER TABLE t ADD COLUMN x TEXT NOT NULL DEFAULT ''").run(); } catch { }
    db.exec(schemaSql);
}
`,
        line: (rows) => `${rows ? 'DRIFT-HAS-ROWS t rows=1' : 'DRIFT-EMPTY-LOCAL t rows=0'} local (with the columns a boot step in db.ts adds: x): x: NULL allowed here, NOT NULL in schema.sql; x: default none here, '' in schema.sql`,
    },
    {
        name: "the first case's steps written the other way round: the literal first, and both take",
        schema: 'CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, y INTEGER, x INTEGER CHECK (x IS NULL OR x < y));',
        boot: `
export function initSchema() {
    try { db.prepare('ALTER TABLE t ADD COLUMN y INTEGER').run(); } catch { }
    for (const column of ['x INTEGER CHECK (x IS NULL OR x < y)']) {
        try { db.prepare(\`ALTER TABLE t ADD COLUMN \${column}\`).run(); } catch { }
    }
    db.exec(schemaSql);
}
`,
        line: () => 'OK t local (with the columns a boot step in db.ts adds: y, x)',
    },
];

test("the steps replay in the boot's order: each case reads as a real boot of a copy leaves the table, and exits 1 unless that is schema.sql's shape", () => {
    for (const c of ORDER_CASES) {
        for (const rows of ['', "INSERT INTO t (id) VALUES ('t1');"]) {
            const what = `${c.name}${rows ? ', with a row' : ', empty'}`;
            const f = fixture(`CREATE TABLE t (id TEXT PRIMARY KEY); ${rows}`, { schema: c.schema, manifest: ORDER_MANIFEST, boot: c.boot });
            try {
                const r = run(f.args);
                const ok = c.line(rows).startsWith('OK ');
                assert.deepEqual(tableLines(r.stdout), [c.line(rows)], what);
                assert.equal(r.status, ok ? 0 : 1, `${what}: ${r.stdout}${r.stderr}`);
                // The real boot of a copy, run by the fixture's own code: the same statements in the same order, each taken or
                // refused as the replay found, and the same table left.
                const { steps, unread } = bootSteps(c.boot);
                assert.deepEqual(unread, [], what);
                const boot = bootFixture(c.boot, f.db, 't');
                assert.deepEqual(steps.map(statementOf), boot.ran.map((s) => s.sql), what);
                const db = openReadOnly(Database, f.db);
                try {
                    const replay = replayBootSteps(Database, db, 't', steps);
                    assert.equal(replay.error, null, what);
                    assert.deepEqual(shapeDiffs(replay.shape, boot.shape), [], `${what}: the replay leaves the table a real boot leaves`);
                    const column = (sql) => sqlTokens(sql.replace(/^ALTER TABLE \S+ ADD COLUMN /, ''))[0].text;
                    assert.deepEqual(replay.added, boot.ran.filter((s) => s.taken).map((s) => column(s.sql)), what);
                    assert.deepEqual(replay.refused, boot.ran.filter((s) => !s.taken && !/^duplicate column name/.test(s.error))
                        .map((s) => `${column(s.sql)} (${s.error})`), what);
                } finally {
                    db.close();
                }
            } finally {
                rmSync(f.dir, { recursive: true, force: true });
            }
        }
    }
});

test("an ALTER TABLE the check doesn't read as a step: its table (every table, where it names none) can't be proved and keeps its drift; a step in a comment is no step", () => {
    const bootWith = (extra) => `
export function initSchema() {
    // try { db.prepare('ALTER TABLE t ADD COLUMN x TEXT').run(); } catch { }
    /* try { db.prepare("ALTER TABLE t ADD COLUMN x TEXT").run(); } catch { }
       for (const column of ['x TEXT']) { try { db.prepare(\`ALTER TABLE t ADD COLUMN \${column}\`).run(); } catch { } } */
    const note = 'a string with // in it is no comment' + \`\${'}'}\`;
    ${extra}
    try { db.prepare("ALTER TABLE t ADD COLUMN x TEXT NOT NULL DEFAULT ''").run(); } catch { }
    db.exec(schemaSql);
}
`;
    const schema = "CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, x TEXT NOT NULL DEFAULT '');";
    const freshDb = new Database(':memory:');
    freshDb.exec(schema);
    const fresh = tableShape(freshDb, 't');
    freshDb.close();
    const cases = [
        // The comments run nothing, so the one step stands, and the boot leaves schema.sql's shape.
        { extra: '', unread: [], asBooted: [], line: 'OK t local (with the columns a boot step in db.ts adds: x)' },
        // A form the check doesn't read (db.exec) runs first at boot, and x stays nullable: a replay of the read step alone
        // would say OK. So no replay, and the drift stands.
        { extra: "try { db.exec('ALTER TABLE t ADD COLUMN x TEXT'); } catch { }", unread: ['t'] },
        // The same through a template that names no table: every table's replay is unproved. The loop's 't' names t as well.
        { extra: "for (const name of ['t']) { try { db.exec(`ALTER TABLE ${name} ADD COLUMN x TEXT`); } catch { } }", unread: [null], named: 1 },
    ];
    const NULLABLE = ['x: NULL allowed here, NOT NULL in schema.sql', "x: default none here, '' in schema.sql"];
    for (const c of cases) {
        const f = fixture('CREATE TABLE t (id TEXT PRIMARY KEY);', { schema, manifest: ORDER_MANIFEST, boot: bootWith(c.extra) });
        try {
            const read = bootSteps(bootWith(c.extra));
            assert.deepEqual(read.steps, [{ table: 't', def: "x TEXT NOT NULL DEFAULT ''" }], c.extra);
            assert.deepEqual(read.unread, c.unread, c.extra);
            assert.deepEqual(shapeDiffs(bootFixture(bootWith(c.extra), f.db, 't').shape, fresh), c.asBooted ?? NULLABLE, c.extra);
            const r = run(f.args);
            assert.equal(r.status, c.line ? 0 : 1, r.stdout + r.stderr);
            assert.deepEqual(tableLines(r.stdout), [c.line ?? `DRIFT-EMPTY-LOCAL t rows=0 local (${cantProve(1, c.named ?? 0)}): columns only in schema.sql: x`], c.extra);
        } finally {
            rmSync(f.dir, { recursive: true, force: true });
        }
    }
    // A loop's array holding more than its literals (a name, a spread) runs steps the check can't read: its table is unread
    // (a pair loop's, every table), and the steps it does read keep their places.
    assert.deepEqual(bootSteps(`
export function initSchema() {
    for (const column of [EXTRA, 'y TEXT']) { try { db.prepare(\`ALTER TABLE t ADD COLUMN \${column}\`).run(); } catch { } }
    for (const [table, column] of [...MORE, ['u', 'z TEXT']]) { try { db.prepare(\`ALTER TABLE \${table} ADD COLUMN \${column}\`).run(); } catch { } }
    db.exec(schemaSql);
}
`), { steps: [{ table: 't', def: 'y TEXT' }, { table: 'u', def: 'z TEXT' }], unread: ['t', null], named: [], found: true });
});

// ── A step is read only in a shape that provably runs on its own ─────────────────────────────────────────────────────

// schema.sql's t has a and b. A node's t holds one row and has both already, has a (an earlier release added it) but not b,
// or neither. Each shape is an initSchema meant to add a and b. A step is read only as a statement of initSchema's own top
// level, alone in an empty try, or a loop whose body is exactly that try; any other ALTER makes its table "can't prove":
// never OK, whatever the table holds, and no replay. `misses` names the states where a real boot of the shape's own code
// leaves t short of schema.sql's shape: there, reading each literal as a step (the reader before round 4) said OK.
const SHAPE_SCHEMA = "CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, a TEXT, b TEXT NOT NULL DEFAULT '');";
const SHAPE_STATES = [
    { state: 'has a and b', old: "CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT, b TEXT NOT NULL DEFAULT '')", missing: [] },
    { state: 'has a', old: 'CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT)', missing: ['b'] },
    { state: 'neither', old: 'CREATE TABLE t (id TEXT PRIMARY KEY)', missing: ['a', 'b'] },
];
const A = "db.prepare('ALTER TABLE t ADD COLUMN a TEXT').run()";
const B = 'db.prepare("ALTER TABLE t ADD COLUMN b TEXT NOT NULL DEFAULT \'\'").run()';
const COLUMNS = "['a TEXT', \"b TEXT NOT NULL DEFAULT ''\"]";
const LOOP = 'try { db.prepare(`ALTER TABLE t ADD COLUMN ${column}`).run(); } catch { }';
const UNSET = 'process.env.SCHEMA_DRIFT_FIXTURE_UNSET';
/** The two steps a read shape reads, in order. */
const AB = [{ table: 't', def: 'a TEXT' }, { table: 't', def: "b TEXT NOT NULL DEFAULT ''" }];
/** A rebuild, the form db.ts used for a table change before cutover N1: its CREATE text has drifted from schema.sql's (no b). */
const REBUILD = "try { db.exec('CREATE TABLE t_new (id TEXT PRIMARY KEY, a TEXT); INSERT INTO t_new (id, a) SELECT id, a FROM t; DROP TABLE t; ALTER TABLE t_new RENAME TO t;'); } catch { }";
const SHAPES = [
    // Read: the boot runs each step, on its own, in this order.
    { shape: 'a literal step each, alone in an empty try', code: `try { ${A}; } catch { }\n    try { ${B}; } catch { }` },
    { shape: 'the same, a template with no ${…} and a comment in the catch', code: `try { db.prepare(\`ALTER TABLE t ADD COLUMN a TEXT\`).run(); } catch { /* there already */ }\n    try { ${B}; } catch { }` },
    { shape: "a loop over one table's columns", code: `for (const column of ${COLUMNS}) {\n        ${LOOP}\n    }` },
    { shape: 'a loop over [table, column] pairs', code: `for (const [table, column] of [['t', 'a TEXT'], ['t', "b TEXT NOT NULL DEFAULT ''"]]) {\n        try { db.prepare(\`ALTER TABLE \${table} ADD COLUMN \${column}\`).run(); } catch { }\n    }` },
    // Can't prove: the reviewer's two (round 3), then the rest of the class.
    { shape: 'two steps sharing one try', unread: ['t', 't'], steps: [], misses: ['has a'], code: `try {\n        ${A};\n        ${B};\n    } catch { }` },
    { shape: 'a step behind an if', unread: ['t'], misses: ['has a', 'neither'], code: `try { ${A}; } catch { }\n    if (${UNSET}) try { ${B}; } catch { }` },
    { shape: 'a step in an else', unread: ['t'], misses: [], code: `try { ${A}; } catch { }\n    if (${UNSET}) { } else try { ${B}; } catch { }` },
    { shape: 'a step behind &&', unread: ['t'], misses: ['has a', 'neither'], code: `try { ${A}; } catch { }\n    try { ${UNSET} && ${B}; } catch { }` },
    { shape: 'a step in a ternary', unread: ['t'], misses: ['has a', 'neither'], code: `try { ${A}; } catch { }\n    try { ${UNSET} ? ${B} : null; } catch { }` },
    { shape: 'a step in a non-empty catch', unread: ['t', 't'], steps: [], misses: ['neither'], code: `try { ${A}; } catch { try { ${B}; } catch { } }` },
    { shape: "a loop whose catch isn't empty", unread: ['t'], named: 1, steps: [], misses: ['has a'], code: `for (const column of ${COLUMNS}) {\n        ${LOOP.replace('catch { }', 'catch { break; }')}\n    }` },
    { shape: 'a loop with more in its body', unread: ['t'], named: 1, steps: [], misses: [], code: `for (const column of ${COLUMNS}) {\n        ${LOOP}\n        if (${UNSET}) break;\n    }` },
    { shape: 'a loop behind an if', unread: ['t'], named: 1, steps: [], misses: ['has a', 'neither'], code: `if (${UNSET}) for (const column of ${COLUMNS}) {\n        ${LOOP}\n    }` },
    { shape: 'a step in a function initSchema never calls', unread: ['t'], misses: ['has a', 'neither'], code: `try { ${A}; } catch { }\n    function addB() { try { ${B}; } catch { } }` },
    { shape: 'a step in a callback', unread: ['t'], misses: [], code: `try { ${A}; } catch { }\n    [0].forEach(() => { try { ${B}; } catch { } });` },
    { shape: 'a step in a function declared after the exec (it hoists), called before it', unread: ['t'], misses: [], code: `try { ${A}; } catch { }\n    addB();`, after: `function addB() { try { ${B}; } catch { } }` },
    { shape: 'a template with a ${…}, not a loop', unread: ['t'], named: 1, misses: [], code: `try { ${A}; } catch { }\n    const column = "b TEXT NOT NULL DEFAULT ''";\n    try { db.prepare(\`ALTER TABLE t ADD COLUMN \${column}\`).run(); } catch { }` },
    { shape: 'db.exec', unread: ['t'], misses: [], code: `try { ${A}; } catch { }\n    try { db.exec("ALTER TABLE t ADD COLUMN b TEXT NOT NULL DEFAULT ''"); } catch { }` },
    { shape: 'the statement in a variable', unread: ['t'], named: 1, misses: [], code: `try { ${A}; } catch { }\n    const sql = "ALTER TABLE t ADD COLUMN b TEXT NOT NULL DEFAULT ''";\n    try { db.prepare(sql).run(); } catch { }` },
    { shape: 'a finally', unread: ['t'], misses: [], code: `try { ${A}; } catch { }\n    try { ${B}; } catch { } finally { }` },
    { shape: 'a return before the steps', unread: ['t', 't'], steps: [], misses: [], code: `if (${UNSET}) return;\n    try { ${A}; } catch { }\n    try { ${B}; } catch { }` },
    // Round 5: a table rename names t_new and changes t. It names no table the check may trust (null): every table.
    { shape: 'a rebuild after the steps (… ALTER TABLE t_new RENAME TO t)', unread: [null], steps: AB, misses: ['has a and b', 'has a', 'neither'], code: `try { ${A}; } catch { }\n    try { ${B}; } catch { }\n    ${REBUILD}` },
];

/** main() in this process: its table lines and its exit code. */
function checkLines(args) {
    const out = [];
    const code = main(args, (l) => out.push(l), (l) => out.push(l));
    return { code, lines: tableLines(out.join('\n')) };
}

test("each shape x what the table holds: the read shapes read OK as a real boot leaves it; every other shape reads can't prove, exit 1, whatever the table holds", () => {
    const freshDb = new Database(':memory:');
    freshDb.exec(SHAPE_SCHEMA);
    const fresh = tableShape(freshDb, 't');
    freshDb.close();
    for (const s of SHAPES) {
        const boot = `\nexport function initSchema() {\n    ${s.code}\n    db.exec(schemaSql);\n    ${s.after ?? ''}\n}\n`;
        const read = bootSteps(boot);
        assert.deepEqual(read.unread, s.unread ?? [], s.shape);
        // A template over a value it can't read, or a statement held in a local: that text's names can't be read (every table).
        assert.deepEqual(bootSteps(boot, ['t']).named, Array(s.named ?? 0).fill(null), s.shape);
        // A read shape's two steps; a can't-prove shape's `a` alone in its own try (unless `steps` says what is read).
        assert.deepEqual(read.steps, s.steps ?? (s.unread ? AB.slice(0, 1) : AB), s.shape);
        for (const st of SHAPE_STATES) {
            const what = `${s.shape}, t ${st.state}`;
            const f = fixture(`${st.old}; INSERT INTO t (id) VALUES ('t1');`, { schema: SHAPE_SCHEMA, manifest: ORDER_MANIFEST, boot });
            try {
                const r = checkLines(f.args);
                const real = bootFixture(boot, f.db, 't');
                const short = shapeDiffs(real.shape, fresh);
                if (s.unread) {
                    const rest = st.missing.length > 0 ? `columns only in schema.sql: ${st.missing.join(', ')}` : 'nothing else differs';
                    assert.deepEqual(r.lines, [`DRIFT-HAS-ROWS t rows=1 local (${cantProve(s.unread.length, s.named ?? 0)}): ${rest}`], what);
                    assert.equal(r.code, 1, what);
                    // Where the real boot falls short, an OK would have been a lie.
                    assert.equal(short.length > 0, s.misses.includes(st.state), `${what}: a real boot leaves ${JSON.stringify(short)}`);
                } else {
                    const adds = st.missing.length > 0 ? ` (with the columns a boot step in db.ts adds: ${st.missing.join(', ')})` : '';
                    assert.deepEqual(r.lines, [`OK t local${adds}`], what);
                    assert.equal(r.code, 0, what);
                    // A real boot runs the same statements in the same order and leaves schema.sql's shape.
                    assert.deepEqual(real.ran.map((x) => x.sql), read.steps.map(statementOf), what);
                    assert.deepEqual(short, [], what);
                }
            } finally {
                rmSync(f.dir, { recursive: true, force: true });
            }
        }
    }
});

// An ALTER the check doesn't read as a step names a table only in the forms that change that one table alone: ADD [COLUMN]
// and DROP [COLUMN]. A table rename changes the table it names after TO; a column rename rewrites other tables' REFERENCES
// to the column (SQLite does, whatever foreign_keys says); a form not parsed may do either. Each reads as null: every table
// can't prove. Before round 5 the reader took the first name after ALTER TABLE, and each case below read OK, exit 0.
test("an unread ALTER names its table only for ADD and DROP; a rename or any form not parsed makes every table can't prove, each against a real boot", () => {
    const wrap = (code) => `export function initSchema() {\n    ${code}\n    db.exec(schemaSql);\n}\n`;
    const exec = (sql) => `try { db.exec('${sql}'); } catch { }`;
    for (const [code, unread] of [
        [exec('ALTER TABLE t ADD COLUMN z TEXT'), ['t']],
        [exec('ALTER TABLE t ADD z TEXT'), ['t']],
        [exec('ALTER TABLE t DROP COLUMN z'), ['t']],
        [exec('alter table T drop z'), ['t']],
        [exec('ALTER TABLE t RENAME TO u'), [null]],
        [exec('ALTER TABLE t_new RENAME TO t'), [null]],
        [exec('ALTER TABLE t RENAME COLUMN a TO b'), [null]],
        [exec('ALTER TABLE t RENAME a TO b'), [null]],
        [exec('ALTER TABLE "t" ADD COLUMN z TEXT'), [null]],
        [exec('ALTER TABLE main.t ADD COLUMN z TEXT'), [null]],
        [exec('ALTER TABLE t /* why */ ADD COLUMN z TEXT'), [null]],
        [exec('ALTER TABLE t ADD COLUMN z TEXT; ALTER TABLE u RENAME TO t'), ['t', null]],
        ["console.log('never alter this');", [null]],
    ]) assert.deepEqual(bootSteps(wrap(code)), { steps: [], unread, named: [], found: true }, code);

    const manifest = (...tables) => `export const TABLES: Record<string, TableEntry> = {\n${tables.map((t) => `    ${t}: { kind: 'local', reason: 'this server only' },\n`).join('')}};\n`;
    const cases = [
        {
            name: 'a table renamed to the name schema.sql now gives it, which the node lacks',
            schema: `CREATE TABLE IF NOT EXISTS k (id TEXT PRIMARY KEY); ${SHAPE_SCHEMA}`,
            old: "CREATE TABLE k (id TEXT PRIMARY KEY); CREATE TABLE u (id TEXT PRIMARY KEY); INSERT INTO k VALUES ('k1'); INSERT INTO u VALUES ('u1');",
            manifest: manifest('k', 't'),
            code: "try { db.prepare('ALTER TABLE u RENAME TO t').run(); } catch { }",
            steps: [],
            changed: 't',
            // t isn't here, and the rename may make it before schema.sql does: never "the deploy makes them" (round 6).
            lines: [`DRIFT-HAS-ROWS k rows=1 local (${cantProve(1)}): nothing else differs`,
                `CANT-PROVE-NEW t local (${cantProve(1)}): not in this database yet, and the boot may make it before schema.sql does`],
        },
        {
            name: "a rebuild after t's steps, its CREATE text short of schema.sql's",
            schema: SHAPE_SCHEMA,
            old: "CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('t1');",
            manifest: manifest('t'),
            code: `try { ${A}; } catch { }\n    try { ${B}; } catch { }\n    ${REBUILD}`,
            steps: AB,
            changed: 't',
            lines: [`DRIFT-HAS-ROWS t rows=1 local (${cantProve(1)}): columns only in schema.sql: a, b`],
        },
        {
            name: "a column rename on a table schema.sql doesn't make rewrites c's REFERENCES to it",
            schema: 'CREATE TABLE IF NOT EXISTS c (id TEXT PRIMARY KEY, pa TEXT REFERENCES p(a));',
            old: "CREATE TABLE p (id TEXT PRIMARY KEY, a TEXT UNIQUE); CREATE TABLE c (id TEXT PRIMARY KEY, pa TEXT REFERENCES p(a)); INSERT INTO p VALUES ('p1', 'x'); INSERT INTO c VALUES ('c1', 'x');",
            manifest: manifest('c'),
            code: "try { db.exec('ALTER TABLE p RENAME COLUMN a TO b'); } catch { }",
            steps: [],
            changed: 'c',
            lines: [`DRIFT-HAS-ROWS c rows=1 local (${cantProve(1)}): nothing else differs`],
        },
    ];
    for (const c of cases) {
        const boot = wrap(c.code);
        assert.deepEqual(bootSteps(boot), { steps: c.steps, unread: [null], named: [], found: true }, c.name);
        const f = fixture(c.old, { schema: c.schema, manifest: c.manifest, boot });
        try {
            const r = checkLines(f.args);
            assert.deepEqual(r.lines, c.lines, c.name);
            assert.equal(r.code, 1, c.name);
            // A real boot of the case's own code leaves the table it changed short of schema.sql's shape: an OK was a lie.
            const freshDb = new Database(':memory:');
            freshDb.exec(c.schema);
            const fresh = tableShape(freshDb, c.changed);
            freshDb.close();
            assert.notDeepEqual(shapeDiffs(bootFixture(boot, f.db, c.changed).shape, fresh), [], c.name);
        } finally {
            rmSync(f.dir, { recursive: true, force: true });
        }
    }
});

// ── Any text the boot may run before the exec that names a table schema.sql makes ───────────────────────────────────

/**
 * A real boot of a fixture db.ts, its helpers and its top-level code too, on a copy of `file`: the module's own JavaScript with
 * `db` a connection to the copy, initSchema run up to its schema.sql exec, then schema.sql itself. Returns how `table` then
 * differs from schema.sql's.
 */
function bootThenSchema(dbTs, file, schema, table) {
    const copy = `${file}-boot-copy`;
    writeFileSync(copy, readFileSync(file));
    const conn = new Database(copy);
    const schemaSql = Symbol('schema.sql');
    const reached = new Error('the schema.sql exec');
    const db = {
        prepare: (sql) => { const s = conn.prepare(sql); return { run: (...a) => s.run(...a), get: (...a) => s.get(...a) }; },
        exec: (sql) => { if (sql === schemaSql) throw reached; conn.exec(sql); },
    };
    let stopped = null;
    try { new Function('db', 'schemaSql', `${dbTs.replace(/^export /gm, '')}\nreturn initSchema();`)(db, schemaSql); } catch (e) { stopped = e; }
    assert.equal(stopped, reached, 'the fixture boot ran to its schema.sql exec');
    conn.exec(schema);
    const freshDb = new Database(':memory:');
    freshDb.exec(schema);
    const diffs = shapeDiffs(tableShape(conn, table), tableShape(freshDb, table));
    freshDb.close();
    conn.close();
    rmSync(copy);
    return diffs;
}

// schema.sql makes k, t and photos. The node has k and t (schema.sql's shape, a row each) and no photos, unless a case says.
// Each case is a db.ts whose boot, before the exec, runs one text that names a table (or one whose names can't be read).
const NAMED_SCHEMA = `CREATE TABLE IF NOT EXISTS k (id TEXT PRIMARY KEY);
${SHAPE_SCHEMA}
CREATE TABLE IF NOT EXISTS photos (public_key TEXT PRIMARY KEY, photo TEXT NOT NULL CHECK (length(photo) <= 100));`;
const NAMED_OLD = "CREATE TABLE k (id TEXT PRIMARY KEY); CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT, b TEXT NOT NULL DEFAULT ''); INSERT INTO k VALUES ('k1'); INSERT INTO t (id) VALUES ('t1');";
const NOT_YET = "not in this database yet, and the boot may make it before schema.sql does";
/** The lines when `alter` and `text` count, for each table, the ALTERs and the other texts that name it. */
const namedLines = ({ alter = {}, text = {} }) => ['k', 'photos', 't'].flatMap((name) => {
    const [n, m] = [alter[name] ?? 0, text[name] ?? 0];
    if (name === 'photos') return n + m === 0 ? [] : [`CANT-PROVE-NEW photos local (${cantProve(n, m)}): ${NOT_YET}`];
    return [n + m === 0 ? `OK ${name} local` : `DRIFT-HAS-ROWS ${name} rows=1 local (${cantProve(n, m)}): nothing else differs`];
});
const EVERY = (t = 1) => ({ text: { k: 1, photos: 1, t } }); // one text whose names can't be read (+ t - 1 that name t)
const NAMED_CASES = [
    // The reviewer's three (round 6). Before this round each read OK or "the deploy makes them", exit 0.
    {
        name: 'A: u moved into t with CREATE, INSERT … SELECT and DROP, on a node with no t',
        old: "CREATE TABLE k (id TEXT PRIMARY KEY); CREATE TABLE u (id TEXT PRIMARY KEY); INSERT INTO k VALUES ('k1'); INSERT INTO u VALUES ('u1');",
        code: "try { db.exec('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY); INSERT INTO t (id) SELECT id FROM u; DROP TABLE u;'); } catch { }",
        lines: ['OK k local', `CANT-PROVE-NEW t local (${cantProve(0, 1)}): ${NOT_YET}`],
        lie: 't',
    },
    {
        name: "B: a rebuild after t's steps, without the final RENAME",
        old: "CREATE TABLE k (id TEXT PRIMARY KEY); CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO k VALUES ('k1'); INSERT INTO t VALUES ('t1');",
        code: `try { ${A}; } catch { }\n    try { ${B}; } catch { }\n    try { db.exec('CREATE TEMP TABLE t_keep AS SELECT id, a FROM t; DROP TABLE t; CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT); INSERT INTO t (id, a) SELECT id, a FROM t_keep; DROP TABLE t_keep;'); } catch { }`,
        steps: AB,
        lines: ['OK k local', `DRIFT-HAS-ROWS t rows=1 local (${cantProve(0, 1)}): columns only in schema.sql: a, b`],
        lie: 't',
    },
    {
        name: "C: a helper initSchema calls makes photos in its own words, without schema.sql's CHECK",
        top: "function movePhotos() { db.exec('CREATE TABLE IF NOT EXISTS photos (public_key TEXT PRIMARY KEY, photo TEXT NOT NULL)'); }",
        code: 'try { movePhotos(); } catch { }',
        text: { photos: 1 },
        lie: 'photos',
    },
    // Every verb: what the statement does with the table doesn't count, only that it names it.
    { name: 'INSERT', code: `try { db.prepare("INSERT INTO t (id) VALUES ('x')").run(); } catch { }`, text: { t: 1 } },
    { name: 'UPDATE', code: "try { db.prepare('UPDATE t SET a = NULL').run(); } catch { }", text: { t: 1 } },
    { name: 'DELETE', code: "try { db.prepare('DELETE FROM t').run(); } catch { }", text: { t: 1 } },
    { name: 'DROP', code: "try { db.exec('DROP TABLE t'); } catch { }", text: { t: 1 } },
    { name: 'CREATE TABLE IF NOT EXISTS, on a table the node has', code: "try { db.exec('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)'); } catch { }", text: { t: 1 } },
    { name: 'REPLACE', code: "try { db.exec('REPLACE INTO t (id) VALUES (1)'); } catch { }", text: { t: 1 } },
    { name: 'CREATE TRIGGER', code: "try { db.exec('CREATE TRIGGER tg AFTER INSERT ON t BEGIN SELECT 1; END'); } catch { }", text: { t: 1 } },
    { name: 'CREATE INDEX', code: "try { db.exec('CREATE INDEX IF NOT EXISTS i ON t (a)'); } catch { }", text: { t: 1 } },
    { name: 'a SELECT', code: "try { db.prepare('SELECT COUNT(*) FROM t').get(); } catch { }", text: { t: 1 } },
    { name: 'ALTER (counted as an ALTER, once)', code: "try { db.exec('ALTER TABLE t ADD COLUMN z TEXT'); } catch { }", alter: { t: 1 } },
    // However the name is written.
    { name: 'a double-quoted name', code: `try { db.exec('DELETE FROM "t"'); } catch { }`, text: { t: 1 } },
    { name: 'a bracketed name', code: "try { db.exec('DELETE FROM [t]'); } catch { }", text: { t: 1 } },
    { name: 'a backticked name', code: "try { db.exec('DELETE FROM `t`'); } catch { }", text: { t: 1 } },
    { name: 'main.t', code: "try { db.exec('DELETE FROM main.t'); } catch { }", text: { t: 1 } },
    { name: '"main"."t"', code: `try { db.exec('DELETE FROM "main"."t"'); } catch { }`, text: { t: 1 } },
    { name: "a string as a name, IF EXISTS", code: `try { db.exec("DROP TABLE IF EXISTS 't'"); } catch { }`, text: { t: 1 } },
    { name: 'another case, a comment', code: "try { db.exec('delete /* x */ from T'); } catch { }", text: { t: 1 } },
    // A text read through a top-level const, a `+`, or a name split across two consts.
    { name: 'a ${…} from a top-level const', top: "const TABLE = 't';", code: 'try { db.exec(`DELETE FROM ${TABLE}`); } catch { }', text: { t: 2 } },
    { name: 'a + of a top-level const', top: "const TABLE = 't';", code: "try { db.exec('DELETE FROM ' + TABLE); } catch { }", text: { t: 2 } },
    { name: 'a name split across two consts', top: "const P1 = 'pho';\nconst P2 = 'tos';", code: "try { db.exec('DROP TABLE IF EXISTS ' + P1 + P2); } catch { }", text: { photos: 1 } },
    // A text whose names can't be read: every table, the ones not here included.
    { name: 'a ${…} from a local', code: "const name = 't';\n    try { db.exec(`DELETE FROM ${name}`); } catch { }", ...EVERY(2) },
    { name: 'a statement a function returns', top: "function sqlFor() { return 'DELETE FROM t'; }", code: 'try { db.exec(sqlFor()); } catch { }', ...EVERY(2) },
    { name: 'exec taken as a value', code: "const run = db.exec.bind(db);\n    try { run('DELETE FROM t'); } catch { }", ...EVERY(2) },
    { name: 'a top-level let another function sets', top: "let SQL = '';\nfunction setUp() { SQL = 'DELETE FROM t'; }\nsetUp();", code: 'try { db.exec(SQL); } catch { }', ...EVERY(2) },
    { name: 'a tagged template', code: 'try { db.exec(String.raw`DELETE FROM t`); } catch { }', ...EVERY(1) },
    // A helper's helper.
    { name: 'a helper of a helper initSchema calls', top: "function inner() { db.exec('DELETE FROM t'); }\nfunction outer() { inner(); }", code: 'try { outer(); } catch { }', text: { t: 1 } },
];

test("any text the boot may run before the exec that names a table schema.sql makes, whatever its verb or quoting, makes that table can't prove (every table, where its names can't be read), exit 1, each against a real boot", () => {
    const manifest = `export const TABLES: Record<string, TableEntry> = {\n${['k', 't', 'photos'].map((t) => `    ${t}: { kind: 'local', reason: 'this server only' },\n`).join('')}};\n`;
    for (const c of NAMED_CASES) {
        const boot = `${c.top ?? ''}\nexport function initSchema() {\n    ${c.code}\n    db.exec(schemaSql);\n}\n`;
        const f = fixture(c.old ?? NAMED_OLD, { schema: NAMED_SCHEMA, manifest, boot });
        try {
            const read = bootSteps(boot, ['k', 't', 'photos']);
            assert.deepEqual(read.steps, c.steps ?? [], c.name);
            const r = checkLines(f.args);
            assert.deepEqual(r.lines, c.lines ?? namedLines(c), c.name);
            assert.equal(r.code, 1, c.name);
            // The case's own code, booted for real on a copy and then schema.sql: it runs. For the reviewer's three, the table it
            // makes is short of schema.sql's shape: an OK, or "the deploy makes them", was a lie.
            const left = bootThenSchema(boot, f.db, NAMED_SCHEMA, c.lie ?? 't');
            if (c.lie) assert.notDeepEqual(left, [], `${c.name}: a real boot leaves ${c.lie} short of schema.sql`);
        } finally {
            rmSync(f.dir, { recursive: true, force: true });
        }
    }
});

test("the reader, case by case: a db initSchema declares, an ALTER after the exec, one elsewhere in db.ts, a name that runs on, a syntax error, near misses", () => {
    const wrap = (code, after = '') => `export function initSchema() {\n    ${code}\n    db.exec(schemaSql);\n    ${after}\n}\n`;
    const STEP_A = `try { ${A}; } catch { }`;
    // A db of initSchema's own: no step surely reaches the node's database, so none is proved.
    assert.deepEqual(bootSteps(wrap(`const db = openOther();\n    ${STEP_A}`)), { steps: [], unread: ['t'], named: [], found: true });
    // After the exec, outside a function: it runs after schema.sql, so it is no step and nothing is unread.
    assert.deepEqual(bootSteps(wrap(STEP_A, `try { ${B}; } catch { }`)), { steps: [{ table: 't', def: 'a TEXT' }], unread: [], named: [], found: true });
    // Elsewhere in db.ts (a helper initSchema may call): its table can't be proved.
    assert.deepEqual(bootSteps(`function helper() { db.exec('ALTER TABLE u ADD COLUMN z TEXT'); }\n${wrap(STEP_A)}`),
        { steps: [{ table: 't', def: 'a TEXT' }], unread: ['u'], named: [], found: true });
    // A name that ends where its text does may run on into a ${…} or a +: it names no table for sure.
    assert.deepEqual(bootSteps(wrap("try { db.exec(`ALTER TABLE t${n} ADD COLUMN z TEXT`); } catch { }\n    try { db.exec('ALTER TABLE t' + n + ' ADD COLUMN z TEXT'); } catch { }")).unread, [null, null]);
    // A syntax error: initSchema isn't read at all, so no step counts and a column one adds reads as drift.
    assert.deepEqual(bootSteps(wrap(`${STEP_A} {`)), { steps: [], unread: [], named: [], found: false });
    // Near misses: a catch binding, `?.`, an argument to run, a `let` loop, a loop body with no braces. Each is the table's; a
    // loop not read leaves its template's ${column} a value the reader can't read, so that text names every table (round 6).
    for (const [code, named] of [
        [`try { ${A}; } catch (e) { }`, []],
        ["try { db?.prepare('ALTER TABLE t ADD COLUMN a TEXT').run(); } catch { }", []],
        ["try { db.prepare('ALTER TABLE t ADD COLUMN a TEXT').run(1); } catch { }", []],
        [`for (let column of ${COLUMNS}) {\n        ${LOOP}\n    }`, [null]],
        [`for (const column of ${COLUMNS}) ${LOOP}`, [null]],
    ]) assert.deepEqual(bootSteps(wrap(code)), { steps: [], unread: ['t'], named, found: true }, code);
});

test("a step with a second statement after a `;` is refused, as the boot's db.prepare refuses it", () => {
    assert.equal(lineWithStep({ def: 'b TEXT; SELECT 1', fresh: 'CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, x, b TEXT)' }),
        'DRIFT-EMPTY-LOCAL t rows=0 local (boot steps in db.ts refused here: b (The supplied SQL string contains more than one statement)): columns only in schema.sql: b');
    const conn = new Database(':memory:');
    conn.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    assert.throws(() => conn.prepare('ALTER TABLE t ADD COLUMN b TEXT; SELECT 1').run(), /more than one statement/);
    conn.close();
});

test('the command line: no --db, an unknown flag, a missing database or an unreadable build exit 2', () => {
    const f = fixture();
    try {
        assert.equal(run([]).status, 2);
        assert.match(run([]).stderr, /--db <state\.db> is needed/);
        assert.equal(run(['--db', f.db, '--drop']).status, 2);
        assert.equal(run([...f.args.slice(2), '--db', join(f.dir, 'missing.db')]).status, 2);
        assert.equal(run(['--db', f.db, '--schema', join(f.dir, 'missing.sql')]).status, 2);
        assert.equal(run(['--pack', '--db', f.db]).status, 2);
        assert.equal(run(['--help']).status, 0);
        assert.deepEqual(parseArgs(['--db=/data/state.db']), { pack: false, db: '/data/state.db' });
        assert.ok(!exists(join(f.dir, 'missing.db')), 'a missing database is not made');
    } finally {
        rmSync(f.dir, { recursive: true, force: true });
    }
});

function exists(p) {
    try { statSync(p); return true; } catch { return false; }
}

// ── What counts as a difference ──────────────────────────────────────────────────────────────────────────────────────

/** shapeDiffs of table `t` as `here` makes it against `fresh`. */
function diffOf(here, fresh) {
    const a = new Database(':memory:');
    const b = new Database(':memory:');
    try {
        a.exec(here);
        b.exec(fresh);
        return shapeDiffs(tableShape(a, 't'), tableShape(b, 't'));
    } finally {
        a.close();
        b.close();
    }
}

test('each change IF NOT EXISTS leaves is named', () => {
    const cases = [
        ['CREATE TABLE t (a TEXT, b TEXT)', 'CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a, b))', ['UNIQUE only in schema.sql: (a, b)']],
        ['CREATE TABLE t (a TEXT UNIQUE)', 'CREATE TABLE t (a TEXT)', ['UNIQUE only here: (a)']],
        ['CREATE TABLE t (a TEXT PRIMARY KEY, b TEXT)', 'CREATE TABLE t (a TEXT, b TEXT, PRIMARY KEY (a, b))', ['primary key (a) here, (a, b) in schema.sql']],
        ['CREATE TABLE t (a INTEGER DEFAULT 0)', 'CREATE TABLE t (a INTEGER DEFAULT 1)', ['a: default 0 here, 1 in schema.sql']],
        ['CREATE TABLE t (a TEXT)', 'CREATE TABLE t (a INTEGER)', ['a: type TEXT here, INTEGER in schema.sql']],
        ['CREATE TABLE t (a TEXT)', 'CREATE TABLE t (a TEXT NOT NULL)', ['a: NULL allowed here, NOT NULL in schema.sql']],
        ['CREATE TABLE t (a TEXT)', 'CREATE TABLE t (a TEXT COLLATE NOCASE)', ['a: collate binary here, nocase in schema.sql']],
        ['CREATE TABLE t (a TEXT, b TEXT)', 'CREATE TABLE t (a TEXT)', ['columns only here: b']],
        ['CREATE TABLE t (a TEXT)', 'CREATE TABLE t (a TEXT CHECK (length(a) < 9))', ['CHECK only in schema.sql: length (a) < 9']],
        ['CREATE TABLE t (a TEXT CHECK (a != \'x\'))', 'CREATE TABLE t (a TEXT CHECK (a != \'X\'))', ["CHECK only here: a != 'x'", "CHECK only in schema.sql: a != 'X'"]],
        ['CREATE TABLE p (id TEXT PRIMARY KEY); CREATE TABLE t (a TEXT REFERENCES p(id))', 'CREATE TABLE p (id TEXT PRIMARY KEY); CREATE TABLE t (a TEXT REFERENCES p(id) ON DELETE CASCADE)',
            ['FOREIGN KEY only here: (a) references p(id) on update no action on delete no action', 'FOREIGN KEY only in schema.sql: (a) references p(id) on update no action on delete cascade']],
        // WITHOUT ROWID makes its key NOT NULL too (a rowid table's TEXT key takes a NULL): both are named.
        ['CREATE TABLE t (a TEXT PRIMARY KEY)', 'CREATE TABLE t (a TEXT PRIMARY KEY) WITHOUT ROWID',
            ['a: NULL allowed here, NOT NULL in schema.sql', 'a rowid table here, WITHOUT ROWID in schema.sql']],
        ['CREATE TABLE t (a TEXT)', 'CREATE TABLE t (a TEXT) STRICT', ['not STRICT here, STRICT in schema.sql']],
        ['CREATE TABLE t (id INTEGER PRIMARY KEY)', 'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)', ['no AUTOINCREMENT here, AUTOINCREMENT in schema.sql']],
        ['CREATE TABLE t (a INTEGER, b INTEGER)', 'CREATE TABLE t (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) STORED)', ['b: generated no here, stored in schema.sql']],
        ['CREATE VIRTUAL TABLE t USING fts5(title)', 'CREATE VIRTUAL TABLE t USING fts5(title, body)', ['virtual table: using fts5 (title) here, using fts5 (title, body) in schema.sql']],
    ];
    for (const [here, fresh, want] of cases) assert.deepEqual(diffOf(here, fresh), want, `${here}  vs  ${fresh}`);
});

test('the same table written another way reads the same: spacing, comments, case, quotes, column order, where a CHECK sits', () => {
    const cases = [
        ['CREATE TABLE t (a TEXT NOT NULL CHECK (a IN (\'x\', \'y\')), b INTEGER DEFAULT 0)',
            'CREATE TABLE IF NOT EXISTS "T" ( -- note\n  "B" integer default (0) /* d */, a text not null,\n  CHECK(A in (\'x\',\'y\')) )'],
        ['CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a, b))', 'CREATE TABLE t (b TEXT, a TEXT, CONSTRAINT u UNIQUE (b, a))'],
        ['CREATE TABLE t (a INTEGER CHECK (a <> 1))', 'CREATE TABLE t (a INTEGER CHECK (a != 1))'],
        ['CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)', 'CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)'],
    ];
    for (const [here, fresh] of cases) assert.deepEqual(diffOf(here, fresh), [], `${here}  vs  ${fresh}`);
    // An ALTER-added column lands at the end of the stored text; it is the same column.
    const a = new Database(':memory:');
    a.exec('CREATE TABLE t (a TEXT); ALTER TABLE t ADD COLUMN z INTEGER NOT NULL DEFAULT 1 CHECK (z IN (0, 1))');
    const b = new Database(':memory:');
    b.exec('CREATE TABLE t (z INTEGER NOT NULL DEFAULT 1 CHECK (z IN (0, 1)), a TEXT)');
    assert.deepEqual(shapeDiffs(tableShape(a, 't'), tableShape(b, 't')), []);
    a.close();
    b.close();
});

test('SQL text: strings keep their case and quotes, names and keywords fold, comments go', () => {
    assert.equal(canonical(sqlTokens("Kind IN ('It''s', \"Other\")  -- c\n")), "kind in ('It''s', other)");
    assert.deepEqual(createTableParts('CREATE TABLE t (a TEXT COLLATE NOCASE CHECK (a != \'b\' COLLATE BINARY), CHECK (length(a) > 0))'),
        { checks: ["a != 'b' collate binary", 'length (a) > 0'], collate: new Map([['a', 'nocase']]), autoincrement: false });
});

test('a table the manifest does not name reads as copied: stop and ask, never a drop candidate', () => {
    const db = new Database(':memory:');
    try {
        db.exec("CREATE TABLE mystery (k TEXT CHECK (k IN ('a')))");
        const build = { schemaSql: "CREATE TABLE mystery (k TEXT CHECK (k IN ('a', 'b')))", kinds: {}, bootSteps: [] };
        const { results } = checkDrift(Database, db, build);
        assert.equal(formatResult(results[0]), "DRIFT-REPLICATED mystery rows=0 not in the manifest: CHECK only here: k in ('a'); CHECK only in schema.sql: k in ('a', 'b')");
    } finally {
        db.close();
    }
});

test('the manifest is read whole: an entry by object or by plain(), only inside TABLES', () => {
    assert.deepEqual(manifestKinds(MANIFEST), {
        mail_box: 'local', mail_sent: 'local', listings: 'replicated', notes: 'local', settings: 'replicated', pushes: 'replicated-except',
        seen: 'local', brand_new: 'local',
    });
});

// ── The repo's own build ─────────────────────────────────────────────────────────────────────────────────────────────

test("this checkout: every table schema.sql makes has its kind in the manifest, db.ts's boot steps are found, and its own database reads OK", () => {
    const build = readBuild({
        schema: join(ROOT, 'apps/server/src/db/schema.sql'),
        manifest: join(ROOT, 'apps/server/src/engine/replication-manifest.ts'),
        boot: join(ROOT, 'apps/server/src/db/db.ts'),
    });
    const db = new Database(':memory:');
    try {
        db.exec(build.schemaSql);
        const tables = db.prepare(`SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual')
            AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`).all().map((r) => r.name.toLowerCase());
        const unnamed = tables.filter((t) => !(t in build.kinds));
        assert.deepEqual(unnamed, [], 'a table the manifest reader did not find: a new form of entry in engine/replication-manifest.ts TABLES? Teach manifestKinds it');
        assert.ok(build.bootUnread >= 0, "db.ts's initSchema or its top-level db.exec(schemaSql) was not found, or the parser found a syntax error: teach bootSteps where it moved");
        assert.deepEqual(build.bootNamedTables, [], 'a text the boot may run before the schema.sql exec names a table schema.sql makes (or its names can\'t be read): every table it names is never OK');
        const { results, ok } = checkDrift(Database, db, build);
        assert.equal(results.length, tables.length);
        assert.ok(ok, results.filter((r) => r.status !== 'OK').map(formatResult).join('\n'));
    } finally {
        db.close();
    }
});

/**
 * Run by tsx in a temp data dir (the test below writes it there as a script): a kept 1.4.0 file (kept-node-test-fixture.ts)
 * with one row in each of `tables`, written as stored, copied to before.db; then this checkout's real db.ts initSchema on
 * it, every ALTER TABLE it runs before its schema.sql exec recorded in order, taken or refused. Prints BOOT_TRACE <json>.
 */
async function bootTraceMain(server, tables) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createRequire } = await import('node:module');
    const dir = process.env.BEANPOOL_DATA_DIR;
    const Sqlite = createRequire(path.join(server, 'package.json'))('better-sqlite3');
    const { makeKeptNodeDatabase } = await import(path.join(server, 'src', 'kept-node-test-fixture.ts'));
    const file = path.join(dir, 'state.db');
    const d = new Sqlite(file);
    makeKeptNodeDatabase(d);
    d.pragma('foreign_keys = OFF');
    d.pragma('ignore_check_constraints = ON');
    for (const t of tables) {
        const cols = d.prepare('SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_info(?)').all(t)
            .filter((c) => (c.nn && c.dflt === null) || c.pk);
        if (cols.length === 0) continue;
        d.prepare(`INSERT INTO "${t}" (${cols.map((c) => `"${c.name}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            .run(...cols.map((c) => (/INT|REAL|NUM/i.test(c.type) ? 1 : 'x1')));
    }
    d.close();
    fs.copyFileSync(file, path.join(dir, 'before.db'));
    const { db, initSchema } = await import(path.join(server, 'src', 'db', 'db.ts'));
    const schemaSql = fs.readFileSync(path.join(server, 'src', 'db', 'schema.sql'), 'utf8');
    const trace = [];
    let reached = false;
    const prepare = db.prepare.bind(db);
    const exec = db.exec.bind(db);
    const alter = (sql) => !reached && /\bALTER\s+TABLE\b/i.test(sql);
    const record = (sql, go) => {
        const step = { sql, taken: false, error: null };
        trace.push(step);
        try { const r = go(); step.taken = true; return r; } catch (e) { step.error = e.message; throw e; }
    };
    db.prepare = (sql) => (alter(sql) ? { run: (...a) => record(sql, () => prepare(sql).run(...a)) } : prepare(sql));
    db.exec = (sql) => { if (sql === schemaSql) reached = true; return alter(sql) ? record(sql, () => exec(sql)) : exec(sql); };
    let error = null;
    try { initSchema(); } catch (e) { error = e.message; }
    console.log(`BOOT_TRACE ${JSON.stringify({ reached, error, trace })}`);
}

test("this checkout's db.ts, booted for real on a kept 1.4.0 file with rows: the replay runs the boot's statements in the boot's order, and takes and refuses what that boot did", () => {
    const read = bootSteps(readFileSync(join(ROOT, 'apps/server/src/db/db.ts'), 'utf8'));
    assert.deepEqual(read.unread, [], "every ALTER TABLE before db.ts's schema.sql exec is read in one of the three forms");
    const tables = [...new Set(read.steps.map((s) => s.table))];
    const dir = mkdtempSync(join(tmpdir(), 'schema-drift-boot-'));
    try {
        const server = join(ROOT, 'apps/server');
        const script = join(dir, 'boot-trace.mjs');
        writeFileSync(script, `await (${bootTraceMain.toString()})(${JSON.stringify(server)}, ${JSON.stringify(tables)});\n`);
        const r = spawnSync('pnpm', ['exec', 'tsx', script], {
            cwd: server, encoding: 'utf8', env: { ...process.env, BEANPOOL_DATA_DIR: dir }, timeout: 240_000,
        });
        const out = (r.stdout ?? '').split('\n').find((l) => l.startsWith('BOOT_TRACE '));
        assert.ok(out, `the traced boot printed no trace: ${r.error?.message ?? ''}\n${r.stdout}\n${r.stderr}`);
        const { reached, trace } = JSON.parse(out.slice('BOOT_TRACE '.length));
        assert.ok(reached, 'the boot ran to its schema.sql exec');
        assert.ok(trace.length > 0, 'the boot ran its steps');
        // The invariant: the replay's sequence of statements is the boot's, one for one, in order.
        const parse = (sql) => {
            const m = /^ALTER TABLE\s+(\S+)\s+ADD COLUMN\s+([\s\S]+)$/i.exec(sql);
            return m ? [m[1].toLowerCase(), sqlTokens(m[2])[0].text, sql] : [null, null, sql];
        };
        assert.deepEqual(read.steps.map((s) => [s.table, sqlTokens(s.def)[0].text, statementOf(s)]), trace.map((t) => parse(t.sql)));
        // What each step met: on the same file, the replay takes and refuses what the boot took and refused, table by table.
        const build = readBuild({
            schema: join(server, 'src/db/schema.sql'), manifest: join(server, 'src/engine/replication-manifest.ts'), boot: join(server, 'src/db/db.ts'),
        });
        const db = openReadOnly(Database, join(dir, 'before.db'));
        try {
            const replayed = checkDrift(Database, db, build).results.filter((x) => tables.includes(x.table.toLowerCase()));
            assert.ok(replayed.length > 0, 'a 1.4.0 file holds tables the steps change');
            for (const x of replayed) {
                const mine = trace.filter((t) => parse(t.sql)[0] === x.table.toLowerCase());
                assert.deepEqual(x.bootAdds, mine.filter((t) => t.taken).map((t) => parse(t.sql)[1]), x.table);
                assert.deepEqual(x.bootRefused, mine.filter((t) => !t.taken && !/^duplicate column name/.test(t.error))
                    .map((t) => `${parse(t.sql)[1]} (${t.error})`), x.table);
            }
        } finally {
            db.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
