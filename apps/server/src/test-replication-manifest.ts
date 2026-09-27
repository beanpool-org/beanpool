/**
 * Test Suite: every table and column of the database, and every community setting, is classified by how a standby
 * holds it (engine/replication-manifest.ts; design scratch/global-node/DESIGN-standby-takeover-gaps-opus.md §4.2, §5.2).
 *
 * No processes, about a second. A fresh database from schema.sql and db.ts:
 *  1. Every table (PRAGMA table_list) is in the manifest, and every table the manifest names exists.
 *  2. Every column (PRAGMA table_info) of a copied table is named once: copied, or not copied with the reason. Every
 *     column the manifest names exists.
 *  3. Every copied table has a watermark column, or is declared a whole set and a delta carries all of it (a row stamped
 *     long ago included); its payload key is in the sync payload. Every write to it moves the watermark: a touch trigger
 *     stamps it, or each UPDATE and upsert in the source sets it, or writes only columns the table doesn't copy (a write
 *     that moves nothing reaches a standby only in a whole copy), or clears a column the standby clears itself when the
 *     named tombstone arrives (the importer is read for the clear).
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
import ts from 'typescript';

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

/** A table an UPDATE or an upsert writes, and the columns it sets. */
interface Write { table: string; set: string[]; at: string }

/**
 * Every UPDATE … SET and INSERT … ON CONFLICT DO UPDATE SET in the .ts files under `root`, outside tests. SQL is read
 * from each string and template literal on its own (a template's substitutions as `?`), so a table named at run time
 * is not seen.
 */
function writesIn(root: string, skip: (file: string) => boolean): Write[] {
    const out: Write[] = [];
    const setColumns = (clause: string) => [...clause.matchAll(/(?:^|,)\s*(\w+)\s*=/g)].map((m) => m[1]);
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!['node_modules', 'dist', '__tests__'].includes(e.name)) walk(file);
                continue;
            }
            if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts') || /^(test-|bench-)|-test-harness\.ts$|\.test\.ts$/.test(e.name) || skip(file)) continue;
            const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, false);
            const visit = (n: ts.Node) => {
                const sql = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text
                    : ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((span) => `?${span.literal.text}`).join('') : null;
                if (sql && /\bUPDATE\b/i.test(sql)) {
                    const at = `${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}`;
                    for (const statement of sql.split(';')) {
                        for (const m of statement.matchAll(/\bUPDATE\s+(?:OR\s+\w+\s+)?(\w+)\s+SET\s+([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|$)/gi)) {
                            if (/\bDO\s*$/i.test(statement.slice(0, m.index))) continue; // an upsert's, below
                            out.push({ table: m[1], set: setColumns(m[2]), at });
                        }
                        const upsert = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\b[\s\S]*?\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\s+SET\s+([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|$)/i.exec(statement);
                        if (upsert) out.push({ table: upsert[1], set: setColumns(upsert[2]), at });
                    }
                }
                ts.forEachChild(n, visit);
            };
            visit(source);
        }
    };
    walk(root);
    return out;
}

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
        const cleared = 'clearedByTombstone' in entry ? Object.keys(entry.clearedByTombstone ?? {}) : [];
        const clearedNotCopied = 'columns' in entry ? cleared.filter((c) => !entry.columns.includes(c)) : cleared;
        if (cleared.length > 0) assert(clearedNotCopied.length === 0, `${t}: each column a tombstone clears is a copied one (not: ${list(clearedNotCopied)})`);
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
    console.log(`  ${tables.length} tables looked at`);

    console.log('\n— 3. watermarks and payload keys —');
    const { exportSyncState } = await import('@beanpool/engine');
    const payload = exportSyncState(db as any, 'manifest-test', null, 0) as unknown as Record<string, unknown>;
    // A whole-set table is carried whole by a delta too: a row stamped long ago, planted here, in a delta from now. A
    // whole-set table with no row to plant fails, so the next one gets its check.
    const WHOLE_SET_ROW: Record<string, () => (x: any) => boolean> = {
        accounts: () => {
            db.prepare(`INSERT INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch) VALUES ('manifest-whole-set', 1, '2000-01-01T00:00:00.000Z', 0)`).run();
            return (x) => x?.publicKey === 'manifest-whole-set';
        },
    };
    for (const [t, entry] of Object.entries(TABLES)) {
        if (entry.kind !== 'replicated' && entry.kind !== 'replicated-except') continue;
        if (entry.watermark === WHOLE_SET) {
            const plant = WHOLE_SET_ROW[t];
            const isIt = plant?.();
            const delta = isIt ? exportSyncState(db as any, 'manifest-test', new Date().toISOString(), 0) as unknown as Record<string, unknown> : {};
            const carried = !!isIt && Array.isArray(delta[entry.payload]) && (delta[entry.payload] as unknown[]).some(isIt);
            assert(carried, `${t}: a delta carries the whole set, a row stamped long ago included${plant ? '' : ' (no row to plant for it here: add one)'}`);
        } else {
            assert(tables.includes(t) && columnsOf(t).includes(entry.watermark), `${t}: a delta finds a change by \`${entry.watermark}\``);
        }
        assert(Array.isArray(payload[entry.payload]), `${t}: travels as \`${entry.payload}\` in the sync payload`);
    }
    db.prepare(`DELETE FROM accounts WHERE public_key = 'manifest-whole-set'`).run();

    // A delta finds a change only if the write moved the watermark. A touch trigger that stamps it moves it on every
    // update (members' trigger names its columns: §4). Every other copied table's writes must set it, or write only
    // columns it doesn't copy, or clear one a tombstone carries (the manifest's `clearedByTombstone`, checked in the
    // importer below). The importer (engine/sync.ts) is left out: it writes the main server's rows, stamps and all.
    const triggers = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger'").all() as { sql: string }[]).map((r) => r.sql);
    const stamps = (t: string, watermark: string) => triggers.some((sql) =>
        new RegExp(`AFTER\\s+UPDATE\\b[\\s\\S]*?\\bON\\s+${t}\\b[\\s\\S]*\\bUPDATE\\s+${t}\\s+SET\\s+${watermark}\\b`, 'i').test(sql));
    const engineSrc = path.resolve(here, '../../../packages/beanpool-engine/src');
    const importer = path.join(here, 'engine/sync.ts');
    const serverWrites = writesIn(here, (f) => f === importer);
    const engineWrites = fs.existsSync(engineSrc) ? writesIn(engineSrc, () => false) : [];
    assert(serverWrites.length > 0 && engineWrites.length > 0,
        `the server's and the engine's source are read (${serverWrites.length} and ${engineWrites.length} writes)`);
    const still: string[] = [];
    const notCopiedOnly: string[] = [];
    const tombstoneCleared: string[] = [];
    for (const w of [...serverWrites, ...engineWrites]) {
        const entry = TABLES[w.table];
        if (!entry || (entry.kind !== 'replicated' && entry.kind !== 'replicated-except') || entry.watermark === WHOLE_SET) continue;
        if (stamps(w.table, entry.watermark) || w.set.includes(entry.watermark)) continue;
        const notCopied = entry.kind === 'replicated-except' ? entry.except : {};
        const cleared = entry.clearedByTombstone ?? {};
        if (w.set.length > 0 && w.set.every((c) => notCopied[c])) notCopiedOnly.push(`${w.table}.${w.set.join('+')} (${w.at})`);
        else if (w.set.length > 0 && w.set.every((c) => cleared[c])) tombstoneCleared.push(`${w.table}.${w.set.join('+')} (${w.at})`);
        else still.push(`${w.table} SET ${w.set.join(', ') || '?'} (${w.at})`);
    }
    assert(still.length === 0,
        `every write to a copied table moves its watermark, or writes only columns it doesn't copy or a tombstone clears (moves nothing: ${list(still)})`);
    console.log(`  writes that move no watermark, of columns not copied: ${list(notCopiedOnly)}`);
    console.log(`  writes that move no watermark, of columns a tombstone clears: ${list(tombstoneCleared)}`);
    // The standby makes each such clear itself: the importer's case for that tombstone sets the column to NULL.
    const importerSource = fs.readFileSync(importer, 'utf-8');
    for (const [t, entry] of Object.entries(TABLES)) {
        if (entry.kind !== 'replicated' && entry.kind !== 'replicated-except') continue;
        for (const [c, clear] of Object.entries(entry.clearedByTombstone ?? {})) {
            const at = importerSource.indexOf(`case '${clear.tombstone}': {`);
            const body = at < 0 ? '' : importerSource.slice(at, importerSource.indexOf('\n        case ', at + 1));
            assert(new RegExp(`UPDATE\\s+${t}\\s+SET\\s+${c}\\s*=\\s*NULL\\b`, 'i').test(body),
                `${t}.${c}: the importer clears it when a \`${clear.tombstone}\` tombstone arrives (engine/sync.ts applyTombstoneLocally)`);
        }
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
