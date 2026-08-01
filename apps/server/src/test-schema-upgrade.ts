/**
 * Schema upgrade safety — can a node that is ALREADY LIVE boot the current schema?
 *
 * This exists because #104 step 3b shipped a hard boot failure past three review rounds and a full green
 * test suite. `initSchema()` runs `db.exec(schema.sql)` and only THEN applies its guarded `ALTER TABLE`
 * migrations. A new index in schema.sql referenced `settlements.reserved_until`, a column the ALTERs had not
 * added yet — so on any node whose `settlements` table predated the column, `CREATE TABLE IF NOT EXISTS`
 * no-opped against the old shape, the index failed with "no such column", `db.exec` aborted, and the node
 * would not start.
 *
 * Every existing suite passed, because every one of them starts from an EMPTY data dir — where the table is
 * created complete and the ordering never matters. The upgrade path had no coverage at all, which is the
 * gap this closes: the interesting case is not a fresh install, it is the node that already has data.
 *
 * The check is deliberately generic rather than a fixture of one old schema. It replays each historical
 * shape we care about, boots the real `initSchema()` against it, and then asserts the result matches what a
 * fresh install produces — so a future column or index added in the wrong order fails here rather than on
 * somebody's node.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-schema-upgrade.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const columns = (db: Database.Database, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(r => r.name).sort();

const indexes = (db: Database.Database, table: string): string[] =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_%'`)
        .all(table) as any[]).map(r => r.name).sort();

/** Boot the REAL initSchema() against a data dir, in a child process (the db module is a singleton). */
function bootInto(dir: string): { ok: boolean; output: string } {
    const script = path.join(dir, 'boot.mjs');
    fs.writeFileSync(script, `
        import { initSchema } from ${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))};
        initSchema();
        console.log('BOOT_OK');
    `);
    try {
        const out = execFileSync('pnpm', ['exec', 'tsx', script], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, BEANPOOL_DATA_DIR: dir },
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { ok: out.includes('BOOT_OK'), output: out };
    } catch (e: any) {
        return { ok: false, output: `${e?.stdout ?? ''}${e?.stderr ?? ''}` };
    }
}

const tmp = (name: string): string =>
    fs.mkdtempSync(path.join(os.tmpdir(), `beanpool-upgrade-${name}-`));

/**
 * Recreate a historical `settlements` table by taking the CURRENT definition and dropping the columns that
 * did not exist then. Derived from schema.sql rather than pasted, so it keeps working as the table evolves.
 */
function legacySettlementsDdl(withoutColumns: string[]): string {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    const match = schema.match(/CREATE TABLE IF NOT EXISTS settlements \(([\s\S]*?)\n\);/);
    if (!match) throw new Error('Could not find the settlements table in schema.sql');
    const body = match[1]
        .split('\n')
        .filter(line => {
            const col = line.trim().split(/\s+/)[0];
            return !withoutColumns.includes(col);
        })
        .join('\n')
        // A trailing comma before `)` is a syntax error once a column is removed.
        .replace(/,(\s*)$/, '$1');
    return `CREATE TABLE settlements (${body}\n);`;
}

function main() {
    console.log('Running schema upgrade tests...\n');

    // ── 1. A fresh install, for the shape everything else is compared against ────────────────────
    const freshDir = tmp('fresh');
    const fresh = bootInto(freshDir);
    assert(fresh.ok, 'a fresh data dir boots');
    const freshDb = new Database(path.join(freshDir, 'state.db'), { readonly: true });
    const freshColumns = columns(freshDb, 'settlements');
    const freshIndexes = indexes(freshDb, 'settlements');
    assert(freshColumns.includes('reserved_until') && freshColumns.includes('receipt_payload'),
        'and creates the step-3b settlement columns');

    // ── 2. The step-3a shape — the one that actually broke ────────────────────────────────────────
    // 3a is on main, so this is not hypothetical: it is every node that has run main.
    const step3aDir = tmp('step3a');
    const step3aDb = new Database(path.join(step3aDir, 'state.db'));
    step3aDb.exec(legacySettlementsDdl(['seller_pubkey', 'fee', 'reserved_until', 'receipt_payload']));
    assert(!columns(step3aDb, 'settlements').includes('reserved_until'),
        'a step-3a database genuinely lacks reserved_until');
    step3aDb.close();

    const upgraded = bootInto(step3aDir);
    assert(upgraded.ok, 'and a node holding one still BOOTS on the current schema');
    if (!upgraded.ok) console.error(upgraded.output.split('\n').slice(-6).join('\n'));

    const upgradedDb = new Database(path.join(step3aDir, 'state.db'), { readonly: true });
    assert(JSON.stringify(columns(upgradedDb, 'settlements')) === JSON.stringify(freshColumns),
        'ending up with exactly the columns a fresh install has');
    assert(JSON.stringify(indexes(upgradedDb, 'settlements')) === JSON.stringify(freshIndexes),
        'and exactly the same indexes — including the ones defined over the newly added columns');
    upgradedDb.close();

    // ── 3. Partial upgrades, because a node can be at any point in the sequence ───────────────────
    // Each column arrived in a different commit, and a node may have been restarted between any two of
    // them. Dropping them one at a time catches an ordering bug that only bites a specific vintage.
    for (const missing of ['receipt_payload', 'reserved_until', 'fee', 'seller_pubkey']) {
        const dir = tmp(`partial-${missing}`);
        const d = new Database(path.join(dir, 'state.db'));
        d.exec(legacySettlementsDdl([missing]));
        d.close();

        const result = bootInto(dir);
        assert(result.ok, `a database missing only ${missing} boots`);
        if (!result.ok) console.error(result.output.split('\n').slice(-6).join('\n'));

        const check = new Database(path.join(dir, 'state.db'), { readonly: true });
        assert(columns(check, 'settlements').includes(missing), `and gains ${missing}`);
        check.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 4. Booting twice is a no-op, not an error ─────────────────────────────────────────────────
    // Every migration is guarded, so the second run must be silent. A migration that throws on an
    // already-migrated database fails only on the SECOND restart, which is a miserable way to find out.
    assert(bootInto(step3aDir).ok, 'and re-booting an already-upgraded database is a no-op');

    freshDb.close();
    fs.rmSync(freshDir, { recursive: true, force: true });
    fs.rmSync(step3aDir, { recursive: true, force: true });

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Schema upgrade checks PASSED.');
}

main();
