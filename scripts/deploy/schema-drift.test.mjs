/* global process -- a Node script */
// scripts/deploy/schema-drift.mjs, the read-only pre-deploy check: a fixture database holding each case (an old CHECK on an
// empty local table, the same with rows, a copied table's drift, a column IF NOT EXISTS misses, a table written another way
// with a column a boot step adds, an identical one) reads the right line; a boot step is proved against the rows that are
// there (a step the rows refuse reads as drift, the same step on an empty table as OK); it opens the database read-only (a
// write fails) and leaves the file, and a live writer's WAL, byte for byte as they were; its packed copy for `node -` in the
// container prints the same lines from what it carries; the repo's own schema.sql and replication manifest read whole.
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
    createTableParts, sqlTokens, canonical,
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

// db.ts as far as the check reads it: initSchema's boot steps before the schema.sql exec on a line of its own.
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
    assert.deepEqual(steps, { steps: [{ table: 'settings', def: 'shown INTEGER NOT NULL DEFAULT 1 CHECK (shown IN (0, 1))' }], unread: 0, found: true });
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
        assert.ok(build.bootUnread >= 0, "db.ts's initSchema or its schema.sql exec on a line of its own was not found: teach bootSteps where it moved");
        const { results, ok } = checkDrift(Database, db, build);
        assert.equal(results.length, tables.length);
        assert.ok(ok, results.filter((r) => r.status !== 'OK').map(formatResult).join('\n'));
    } finally {
        db.close();
    }
});
