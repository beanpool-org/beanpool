/**
 * Test Suite: every table and column of the database, and every community setting, is classified by how a standby
 * holds it (engine/replication-manifest.ts; design scratch/global-node/DESIGN-standby-takeover-gaps-opus.md §4.2, §5.2).
 *
 * No processes, about a second. A fresh database from schema.sql and db.ts:
 *  1. Every table (PRAGMA table_list) is in the manifest, and every table the manifest names exists.
 *  2. Every column (PRAGMA table_info) of a copied table is named once: copied, or not copied with the reason. Every
 *     column the manifest names exists.
 *  3. Every copied table has a watermark column, or is declared a whole set; its payload key is in the sync payload.
 *  4. Every members column except the declared ones is in `members_touch_updated_at`'s column list (read from
 *     sqlite_master), and each declared one is really missing from it, so the fix that adds one deletes its line.
 *  5. Every field of local-config.json (LocalConfig) and of the `node_config` row (NodeConfig) is classified.
 *
 * Adding a table, a column or a setting then fails here until the same PR decides how a standby holds it.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-replication-manifest.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

const list = (xs: Iterable<string>) => [...xs].join(', ') || 'none';

/** The field names of `export interface <name> { … }` in a source file, one level deep. */
function interfaceFields(file: string, name: string): string[] {
    const text = fs.readFileSync(file, 'utf-8');
    const start = text.indexOf(`export interface ${name} {`);
    if (start < 0) throw new Error(`no interface ${name} in ${file}`);
    const body = text.slice(start, text.indexOf('\n}', start));
    return [...body.matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]);
}

async function main(): Promise<void> {
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const { db, initSchema } = await import('./db/db.js');
    const manifest = await import('./engine/replication-manifest.js');
    const { TABLES, WHOLE_SET, MEMBERS_NOT_TOUCHING, LOCAL_CONFIG_FIELDS, NODE_CONFIG_BLOB_FIELDS, isInternalTable } = manifest;
    initSchema();

    console.log('\n— 1. every table —');
    const tables = (db.prepare("SELECT name, type FROM pragma_table_list WHERE schema = 'main'").all() as { name: string; type: string }[])
        .filter((t) => !isInternalTable(t.name, t.type))
        .map((t) => t.name);
    const unclassified = tables.filter((t) => !TABLES[t]);
    const stale = Object.keys(TABLES).filter((t) => !tables.includes(t));
    assert(unclassified.length === 0, `every table of a fresh database is classified (unclassified: ${list(unclassified)})`);
    assert(stale.length === 0, `every table the manifest names exists (stale: ${list(stale)})`);

    console.log('\n— 2. every column —');
    const columnsOf = (t: string) => (db.prepare('SELECT name FROM pragma_table_info(?)').all(t) as { name: string }[]).map((c) => c.name);
    for (const t of tables) {
        const entry = TABLES[t];
        if (!entry) continue;
        const actual = columnsOf(t);
        const except = 'except' in entry ? Object.keys(entry.except ?? {}) : [];
        const key = 'key' in entry ? entry.key ?? [] : [];
        const notAColumn = [...except, ...key].filter((c) => !actual.includes(c));
        if (entry.kind === 'replicated' || entry.kind === 'replicated-except') {
            const named = [...entry.columns, ...except];
            const unnamed = actual.filter((c) => !named.includes(c));
            const twice = named.filter((c, i) => named.indexOf(c) !== i);
            const missing = entry.columns.filter((c) => !actual.includes(c));
            assert(unnamed.length === 0 && twice.length === 0 && missing.length === 0 && notAColumn.length === 0,
                `${t}: every column named once, copied or not (unnamed: ${list(unnamed)}; twice: ${list(twice)}; not a column: ${list([...missing, ...notAColumn])})`);
            if (entry.kind === 'replicated' && except.length > 0) assert(false, `${t}: "replicated" names no exceptions`);
            if (entry.kind === 'replicated-except') assert(except.length > 0, `${t}: "replicated-except" names its exceptions`);
        } else if (notAColumn.length > 0) {
            assert(false, `${t}: the manifest names columns it does not have (${list(notAColumn)})`);
        }
    }
    assert(true, `(${tables.length} tables looked at)`);

    console.log('\n— 3. watermarks and payload keys —');
    const { exportSyncState } = await import('@beanpool/engine');
    const payload = exportSyncState(db as any, 'manifest-test', null, 0) as unknown as Record<string, unknown>;
    for (const [t, entry] of Object.entries(TABLES)) {
        if (entry.kind !== 'replicated' && entry.kind !== 'replicated-except') continue;
        const ok = entry.watermark === WHOLE_SET || (tables.includes(t) && columnsOf(t).includes(entry.watermark));
        assert(ok, `${t}: a delta finds a change by ${entry.watermark === WHOLE_SET ? 'carrying the whole set' : `\`${entry.watermark}\``}`);
        assert(Array.isArray(payload[entry.payload]), `${t}: travels as \`${entry.payload}\` in the sync payload`);
    }

    console.log('\n— 4. the members touch trigger —');
    const trigger = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'members_touch_updated_at'").get() as { sql: string } | undefined)?.sql ?? '';
    const of = /AFTER\s+UPDATE\s+OF([\s\S]*?)\s+ON\s+members\b/i.exec(trigger);
    assert(!!of, 'members_touch_updated_at lists its columns');
    const touching = (of?.[1] ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    const members = columnsOf('members');
    const notTouching = members.filter((c) => !touching.includes(c));
    const undeclared = notTouching.filter((c) => !MEMBERS_NOT_TOUCHING[c]);
    const nowTouching = Object.keys(MEMBERS_NOT_TOUCHING).filter((c) => touching.includes(c));
    const gone = Object.keys(MEMBERS_NOT_TOUCHING).filter((c) => !members.includes(c));
    assert(undeclared.length === 0, `every members column moves updated_at, except the declared ones (not declared: ${list(undeclared)})`);
    assert(nowTouching.length === 0 && gone.length === 0,
        `each declared one is really missing from the trigger, so its fix deletes its line (in the trigger now: ${list(nowTouching)}; not a column: ${list(gone)})`);
    const triggerGaps = Object.entries(MEMBERS_NOT_TOUCHING).filter(([, e]) => e.gap).map(([c, e]) => `${c} (${e.gap})`);
    console.log(`  known gaps in the trigger: ${list(triggerGaps)}`);

    console.log('\n— 5. community settings —');
    const localConfig = interfaceFields(path.join(here, 'config/local-config.ts'), 'LocalConfig');
    const nodeConfig = interfaceFields(path.join(here, 'state-engine.ts'), 'NodeConfig');
    for (const [what, fields, classified] of [
        ['local-config.json (LocalConfig)', localConfig, LOCAL_CONFIG_FIELDS],
        ["the node_config row's object (NodeConfig)", nodeConfig, NODE_CONFIG_BLOB_FIELDS],
    ] as const) {
        const un = fields.filter((f) => !classified[f]);
        const extra = Object.keys(classified).filter((f) => !fields.includes(f));
        assert(fields.length > 5 && un.length === 0 && extra.length === 0,
            `every field of ${what} is classified (${fields.length} fields; unclassified: ${list(un)}; not a field: ${list(extra)})`);
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ Every table, column and setting says how a standby holds it.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e?.message || e);
    process.exit(1);
});
