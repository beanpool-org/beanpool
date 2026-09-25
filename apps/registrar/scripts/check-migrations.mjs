// Proves, on LOCAL throwaway databases only (every wrangler call here is `--local --persist-to <tmp>`), that:
//   1. `wrangler d1 migrations apply` builds exactly the schema and policy seed that applying migrations/ in order by
//      hand builds (`wrangler d1 execute --file`, the way the live database got them), and that the tests' in-memory
//      database (node:sqlite, test/harness.js) builds;
//   2. scripts/bootstrap-d1-migrations.sql, run on a database at ANY stage of that hand path, records exactly the
//      migrations it has, so `migrations apply` then adds only the rest — never re-running 0001 (proved by a
//      name_policy row deleted beforehand, as the live table dropped `test`, staying deleted) — and ends at the same
//      schema;
//   3. the deploy workflow's guard (deploy-checks.mjs `bootstrapped`) refuses a database that was never bootstrapped,
//      including one whose empty d1_migrations table a `wrangler d1 migrations list` created.
// Run by the registrar deploy workflow's dry-run job: node scripts/check-migrations.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { bootstrapProblems } from './deploy-checks.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const BOOTSTRAP = 'scripts/bootstrap-d1-migrations.sql';
const DB = 'beanpool-registrar';
const TMP = mkdtempSync(join(tmpdir(), 'registrar-migrations-'));
let failed = 0;

function wrangler(dir, ...args) {
    return execFileSync('npx', ['--no-install', 'wrangler', 'd1', ...args, '--local', '--persist-to', join(TMP, dir)], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        // Every call is --local. The credentials are deliberately unusable, so a remote call could never succeed either.
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: 'check-migrations-is-local-only', CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) },
    });
}
const rows = (dir, sql) => JSON.parse(wrangler(dir, 'execute', DB, '--json', '--command', sql)).flatMap((r) => r.results);
const execFile = (dir, file) => wrangler(dir, 'execute', DB, '--file', file);
const recorded = (dir) => rows(dir, 'SELECT name FROM d1_migrations ORDER BY id').map((r) => r.name);
// Every table, index and trigger but wrangler's own bookkeeping. wrangler strips `--` comments from SQL before it
// runs it, so the CREATE text it stores has none, and it reports a NULL `sql` (an automatic index) as "null": the
// comparison drops comments and reads "null" as NULL, and compares everything else — names, columns, types,
// constraints — as SQLite stores it.
const SCHEMA_SQL = `SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name NOT IN ('d1_migrations', 'sqlite_sequence') AND tbl_name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type, name`;
const POLICY_SQL = 'SELECT pattern, tier FROM name_policy ORDER BY pattern';
const ddl = (r) => ({ ...r, sql: r.sql == null || r.sql === 'null' ? null : r.sql.replace(/--[^\n]*/g, '') });
const schema = (dir) => rows(dir, SCHEMA_SQL).map(ddl);
const policy = (dir) => rows(dir, POLICY_SQL);

function check(ok, what, detail) {
    console.log(`${ok ? '✓' : '✗'} ${what}`);
    if (!ok) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); }
}
// Rows in `got` and not in `want`, and the other way round: what a failed comparison prints.
function diff(got, want) {
    const s = (rs) => new Set(rs.map((r) => JSON.stringify(r)));
    const g = s(got), w = s(want);
    return { extra: [...g].filter((r) => !w.has(r)), missing: [...w].filter((r) => !g.has(r)) };
}
const same = (got, what) => check(isDeepStrictEqual(got, want), what, {
    schema: diff(got.schema, want.schema), policy: diff(got.policy, want.policy),
});
let want;

try {
    // 1. Three ways to build a new database.
    wrangler('by-wrangler', 'migrations', 'apply', DB);
    want = { schema: schema('by-wrangler'), policy: policy('by-wrangler') };
    check(isDeepStrictEqual(recorded('by-wrangler'), MIGRATIONS), `wrangler applied and recorded ${MIGRATIONS.join(', ')}`);

    for (const m of MIGRATIONS) execFile('by-hand', `migrations/${m}`);
    const byHand = { schema: schema('by-hand'), policy: policy('by-hand') };
    same(byHand, 'by hand (d1 execute --file, in order): the same schema and policy seed');

    const sqlite = new DatabaseSync(':memory:');
    for (const m of MIGRATIONS) sqlite.exec(readFileSync(join(ROOT, 'migrations', m), 'utf8'));
    const inTests = { schema: sqlite.prepare(SCHEMA_SQL).all().map(ddl), policy: sqlite.prepare(POLICY_SQL).all().map((r) => ({ ...r })) };
    same(inTests, "the tests' database (node:sqlite, test/harness.js): the same schema and policy seed");
    console.log(`  (${want.schema.length} schema objects, ${want.policy.length} policy rows)`);

    // 2 + 3. A database that went by hand up to each migration, then the bootstrap, then `migrations apply`.
    for (let k = 0; k <= MIGRATIONS.length; k++) {
        const dir = `stage-${k}`;
        const had = MIGRATIONS.slice(0, k);
        for (const m of had) execFile(dir, `migrations/${m}`);
        console.log(`— a database with ${k ? had.join(', ') : 'nothing'} applied by hand`);
        // What the workflow's guard says of this database (it reads d1_migrations exactly like this, remotely).
        const guard = () => bootstrapProblems(wrangler(dir, 'execute', DB, '--json', '--command', 'SELECT name FROM d1_migrations ORDER BY id'));
        if (k === 0) {
            execFile(dir, BOOTSTRAP);
            check(isDeepStrictEqual(recorded(dir), []), 'bootstrap on an empty database records nothing');
            check(guard().length > 0, 'the workflow guard refuses it');
            continue;
        }
        rows(dir, "DELETE FROM name_policy WHERE pattern = 'test'");   // the live table dropped `test`; 0001 re-adds it
        if (k === MIGRATIONS.length) {
            // Listing (or applying) makes an empty d1_migrations; the guard must not take that for a bootstrap.
            wrangler(dir, 'migrations', 'list', DB);
            check(guard().length > 0, 'after a `migrations list` made an empty d1_migrations, the workflow guard still refuses it');
        }
        execFile(dir, BOOTSTRAP);
        check(isDeepStrictEqual(recorded(dir), had), `bootstrap records exactly ${had.join(', ')}`, recorded(dir));
        check(guard().length === 0, 'the workflow guard lets it through');
        execFile(dir, BOOTSTRAP);
        check(isDeepStrictEqual(recorded(dir), had), 'bootstrap again: nothing changes');
        wrangler(dir, 'migrations', 'apply', DB);
        check(isDeepStrictEqual(recorded(dir), MIGRATIONS), `migrations apply adds ${MIGRATIONS.slice(k).join(', ') || 'nothing'}`, recorded(dir));
        const got = schema(dir);
        check(isDeepStrictEqual(got, want.schema), 'the same schema as a new database', diff(got, want.schema));
        const p = policy(dir);
        check(!p.some((r) => r.pattern === 'test') && isDeepStrictEqual(p, want.policy.filter((r) => r.pattern !== 'test')),
            '0001 did not run again: the policy row deleted beforehand is still gone, nothing else changed', p);
    }
} finally {
    rmSync(TMP, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall migration checks passed');
process.exit(failed ? 1 : 0);
