/**
 * Test Suite: every table and column of the database, and every community setting, is classified by how a standby
 * holds it (engine/replication-manifest.ts; design scratch/global-node/DESIGN-standby-takeover-gaps-opus.md §4.2, §5.2).
 *
 * No processes, about a second. A fresh database from schema.sql and db.ts:
 *  1. Every table (PRAGMA table_list) is in the manifest, and every table the manifest names exists.
 *  2. Every column (PRAGMA table_info) of a copied table is named once: copied, or not copied with the reason. Every
 *     column the manifest names exists.
 *  3. Every copied table has a watermark column, or is declared a whole set and a delta carries all of it (a row stamped
 *     long ago included), or travels inside its parent's rows (each carries it); a second watermark column is one a delta
 *     finds a row by (a row stamped long ago by the first); its payload key is in the sync payload, a plain table's under
 *     `plainTables` by its own name, and a plain table has a key to match its rows by and both stamping triggers. Every
 *     write to it moves the watermark: a touch trigger
 *     stamps it, or each UPDATE and upsert in the source sets it, or writes only columns the table doesn't copy (a write
 *     that moves nothing reaches a standby only in a whole copy), or clears a column the standby clears itself when the
 *     named tombstone arrives (the importer is read for the clear).
 *  4. Every members column except the declared ones is in `members_touch_updated_at`'s column list (read from
 *     sqlite_master), and each declared one is really missing from it, so the fix that adds one deletes its line.
 *  5. Every field of local-config.json (LocalConfig) and of the `node_config` row (NodeConfig) is classified, and the
 *     community settings record (config/community-settings.ts) carries exactly the ones classified as the community's.
 *  6. Every node_config row key the server's code writes (read from its source: a literal, a constant, a prefix) is
 *     classified in NODE_CONFIG_KEYS, and every write names its key in a way this can read.
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

/** A node_config row key a write names (`x*`: one whose start only is fixed), and where. */
interface ConfigKeyWrite { key: string; at: string }

/**
 * Every node_config row key the .ts files under `roots` write, outside tests: each INSERT, REPLACE or UPDATE of
 * node_config, its key a literal in the SQL or the `?` its `.run(…)` fills. That argument is read through string
 * literals, a constant (declared once in its file, or imported and exported once anywhere), `a + b` and templates (a
 * part that can't be read leaves a prefix: `nodeProfile.*`), and `for (const k of LIST)` over a constant list.
 * `unread`: each write whose key this can't read, so a new kind of write is looked at, never missed.
 */
function nodeConfigKeysWritten(roots: string[], relativeTo: string): { writes: ConfigKeyWrite[]; unread: string[] } {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!['node_modules', 'dist', '__tests__'].includes(e.name)) walk(file);
            } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !/^(test-|bench-)|-test-harness\.ts$|\.test\.ts$/.test(e.name)) {
                files.push(file);
            }
        }
    };
    for (const r of roots) walk(r);
    const sources = files.map((f) => ts.createSourceFile(f, fs.readFileSync(f, 'utf-8'), ts.ScriptTarget.Latest, true));

    // Per file, how often each name is declared (a variable, a destructured name, a parameter), its constants' values,
    // and the names it imports; across files, the exported constants.
    const declared = new Map<ts.SourceFile, Map<string, number>>();
    const consts = new Map<ts.SourceFile, Map<string, ts.Expression>>();
    const imported = new Map<ts.SourceFile, Set<string>>();
    const exported = new Map<string, ts.Expression[]>();
    for (const sf of sources) {
        const count = new Map<string, number>();
        const own = new Map<string, ts.Expression>();
        const names = new Set<string>();
        const visit = (n: ts.Node) => {
            if ((ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isParameter(n)) && ts.isIdentifier(n.name)) {
                count.set(n.name.text, (count.get(n.name.text) ?? 0) + 1);
                if (ts.isVariableDeclaration(n) && n.initializer && ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const)) {
                    own.set(n.name.text, n.initializer);
                    const statement = n.parent.parent;
                    if (ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
                        exported.set(n.name.text, [...(exported.get(n.name.text) ?? []), n.initializer]);
                    }
                }
            }
            if (ts.isImportSpecifier(n)) names.add(n.name.text);
            ts.forEachChild(n, visit);
        };
        visit(sf);
        declared.set(sf, count);
        consts.set(sf, own);
        imported.set(sf, names);
    }

    // The strings an expression can be (`x*`: only its start is known), or null.
    const read = (e: ts.Expression | undefined, seen: Set<ts.Node> = new Set()): string[] | null => {
        if (!e || seen.has(e)) return null;
        seen.add(e);
        if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return read(e.expression, seen);
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
        if (ts.isArrayLiteralExpression(e)) {
            const out: string[] = [];
            for (const el of e.elements) {
                const v = read(el, seen);
                if (!v) return null;
                out.push(...v);
            }
            return out;
        }
        const join = (parts: (string[] | null)[]): string[] => {
            let out = [''];
            for (const p of parts) {
                if (!p) return out.map((s) => (s.endsWith('*') ? s : `${s}*`));
                out = out.flatMap((a) => (a.endsWith('*') ? [a] : p.map((b) => a + b)));
            }
            return out;
        };
        if (ts.isTemplateExpression(e)) return join([[e.head.text], ...e.templateSpans.flatMap((s) => [read(s.expression, seen), [s.literal.text]])]);
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return join([read(e.left, seen), read(e.right, seen)]);
        if (!ts.isIdentifier(e)) return null;
        for (let n: ts.Node = e; n.parent; n = n.parent) {
            const p = n.parent;
            if (!ts.isForOfStatement(p) || n !== p.statement || !ts.isVariableDeclarationList(p.initializer)) continue;
            const d = p.initializer.declarations[0];
            if (d && ts.isIdentifier(d.name) && d.name.text === e.text) return read(p.expression, seen);
        }
        const sf = e.getSourceFile();
        const times = declared.get(sf)?.get(e.text) ?? 0;
        if (times === 1) return consts.get(sf)?.has(e.text) ? read(consts.get(sf)!.get(e.text), seen) : null;
        const other = exported.get(e.text);
        return times === 0 && imported.get(sf)?.has(e.text) && other?.length === 1 ? read(other[0], seen) : null;
    };

    const WRITE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?)\s+node_config\b/i;
    const isCallOf = (n: ts.Node, method: string): n is ts.CallExpression =>
        ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === method;
    const writes: ConfigKeyWrite[] = [];
    const unread: string[] = [];
    for (const sf of sources) {
        const where = (n: ts.Node) => `${path.relative(relativeTo, sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
        const calls: ts.CallExpression[] = [];
        const collect = (n: ts.Node) => {
            if (ts.isCallExpression(n)) calls.push(n);
            ts.forEachChild(n, collect);
        };
        collect(sf);
        // The calls that run a prepared statement: `<prepare>.run(…)`, or `<name>.run(…)` for `const <name> = <prepare>`.
        const runsOf = (prepare: ts.CallExpression): ts.CallExpression[] => {
            const p = prepare.parent;
            if (ts.isPropertyAccessExpression(p) && p.name.text === 'run' && isCallOf(p.parent, 'run')) return [p.parent];
            if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
                const name = p.name.text;
                return calls.filter((c) => isCallOf(c, 'run') && ts.isIdentifier((c.expression as ts.PropertyAccessExpression).expression)
                    && ((c.expression as ts.PropertyAccessExpression).expression as ts.Identifier).text === name);
            }
            return [];
        };
        const visit = (n: ts.Node) => {
            ts.forEachChild(n, visit);
            if (!ts.isStringLiteral(n) && !ts.isNoSubstitutionTemplateLiteral(n) && !ts.isTemplateExpression(n)) return;
            const sql = ts.isTemplateExpression(n) ? n.getText(sf) : n.text;
            if (!WRITE.test(sql)) return;
            const at = where(n);
            const literal = /\bnode_config\s*\(\s*key\s*,[^)]*\)\s*VALUES\s*\(\s*'([^']*)'/i.exec(sql) ?? /\bWHERE\s+key\s*=\s*'([^']*)'/i.exec(sql);
            if (literal) {
                writes.push({ key: literal[1], at });
                return;
            }
            const byKey = ts.isTemplateExpression(n) ? null
                : /\bnode_config\s*\(\s*key\s*,[^)]*\)\s*VALUES\s*\(\s*\?/i.exec(sql) ?? /\bWHERE\s+key\s*=\s*\?/i.exec(sql);
            if (!byKey) {
                unread.push(at);
                return;
            }
            const index = (sql.slice(0, byKey.index + byKey[0].length).match(/\?/g) ?? []).length - 1;
            // The statement is prepared where it is written, or through the constant it is the value of.
            const prepares = isCallOf(n.parent, 'prepare') && n.parent.arguments[0] === n ? [n.parent]
                : ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)
                    ? calls.filter((c) => isCallOf(c, 'prepare') && ts.isIdentifier(c.arguments[0] as ts.Node)
                        && (c.arguments[0] as ts.Identifier).text === (n.parent as ts.VariableDeclaration & { name: ts.Identifier }).name.text)
                    : [];
            const runs = prepares.flatMap(runsOf);
            if (runs.length === 0) unread.push(`${at} (never run with its key)`);
            for (const run of runs) {
                const keys = read(run.arguments[index]);
                if (!keys || keys.some((k) => k === '' || k === '*')) unread.push(`${where(run)} (${run.arguments[index]?.getText(sf) ?? 'no key'})`);
                else for (const key of keys) writes.push({ key, at: where(run) });
            }
        };
        visit(sf);
    }
    return { writes, unread };
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
    const { PLAIN_TABLES, PLAIN_TABLES_PAYLOAD, plainTableTriggers } = manifest;
    // The export as a main server makes it, with the plain tables the manifest names (engine/sync.ts exportSyncState).
    const payload = exportSyncState(db as any, 'manifest-test', null, 0, PLAIN_TABLES) as unknown as Record<string, unknown>;
    // A whole-set table is carried whole by a delta too: a row stamped long ago, planted here, in a delta from now. A
    // whole-set table with no row to plant fails, so the next one gets its check.
    const WHOLE_SET_ROW: Partial<Record<string, () => (x: any) => boolean>> = {
        accounts: () => {
            db.prepare(`INSERT INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch) VALUES ('manifest-whole-set', 1, '2000-01-01T00:00:00.000Z', 0)`).run();
            return (x) => x?.publicKey === 'manifest-whole-set';
        },
        treasury_operators: () => {
            db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_at) VALUES ('manifest-whole-set', 'manifest-keeper', 'keeper', '2000-01-01T00:00:00.000Z')`).run();
            return (x) => x?.treasuryPubkey === 'manifest-whole-set' && x?.memberPubkey === 'manifest-keeper';
        },
    };
    // A row stamped long ago by its watermark and now by its second one: a delta from now finds it by the second.
    const OR_WATERMARK_ROW: Partial<Record<string, () => (x: any) => boolean>> = {
        enterprise_pledges: () => {
            db.prepare(`INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
                        VALUES ('manifest-or-watermark', 'k', 'e', 1, '2000-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 minute'))`).run();
            return (x) => x?.id === 'manifest-or-watermark';
        },
    };
    // A parent row carrying its rows (`inRowOf`): one planted, with one of the rows it carries.
    const IN_ROW_OF: Partial<Record<string, () => (x: any) => boolean>> = {
        member_preferences: () => {
            db.prepare(`INSERT INTO members (public_key, callsign) VALUES ('manifest-in-row', 'Manifest In Row')`).run();
            db.prepare(`INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES ('manifest-in-row', 'notify_chat', 'false')`).run();
            return (x) => x?.publicKey === 'manifest-in-row' && x?.preferences?.notify_chat === 'false';
        },
    };
    const deltaNow = () => exportSyncState(db as any, 'manifest-test', new Date().toISOString(), 0) as unknown as Record<string, unknown>;
    const carries = (p: Record<string, unknown>, key: string, isIt: (x: any) => boolean) => Array.isArray(p[key]) && (p[key] as unknown[]).some(isIt);
    for (const [t, entry] of Object.entries(TABLES)) {
        if (entry.kind !== 'replicated' && entry.kind !== 'replicated-except') continue;
        if (entry.inRowOf) {
            const parent = TABLES[entry.inRowOf.table];
            const plant = IN_ROW_OF[t];
            const isIt = plant?.();
            assert(!!parent && (parent.kind === 'replicated' || parent.kind === 'replicated-except') && parent.payload === entry.payload
                && parent.watermark === entry.watermark && columnsOf(entry.inRowOf.table).includes(entry.watermark),
            `${t}: travels in each copied \`${entry.inRowOf.table}\` row, found by its \`${entry.watermark}\``);
            assert(!!isIt && carries(exportSyncState(db as any, 'manifest-test', null, 0) as any, entry.payload, isIt),
                `${t}: each \`${entry.payload}\` row carries its rows as \`${entry.inRowOf.field}\`${plant ? '' : ' (no row to plant for it here: add one)'}`);
        } else if (entry.watermark === WHOLE_SET) {
            const plant = WHOLE_SET_ROW[t];
            const isIt = plant?.();
            assert(!!isIt && carries(deltaNow(), entry.payload, isIt),
                `${t}: a delta carries the whole set, a row stamped long ago included${plant ? '' : ' (no row to plant for it here: add one)'}`);
        } else {
            assert(tables.includes(t) && columnsOf(t).includes(entry.watermark), `${t}: a delta finds a change by \`${entry.watermark}\``);
        }
        if (entry.orWatermark) {
            const plant = OR_WATERMARK_ROW[t];
            const isIt = plant?.();
            assert(columnsOf(t).includes(entry.orWatermark) && !!isIt && carries(deltaNow(), entry.payload, isIt),
                `${t}: a delta also finds a change by \`${entry.orWatermark}\`, a row stamped long ago by \`${entry.watermark}\` included${plant ? '' : ' (no row to plant for it here: add one)'}`);
        }
        if (entry.plain) {
            const carried = (payload[PLAIN_TABLES_PAYLOAD] ?? {}) as Record<string, unknown>;
            assert(entry.payload === PLAIN_TABLES_PAYLOAD && Array.isArray(carried[t]), `${t}: travels as \`${PLAIN_TABLES_PAYLOAD}.${t}\` in the sync payload`);
            const key = (db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0').all(t) as { name: string }[]).map((c) => c.name);
            const { insert, touch } = plainTableTriggers({ table: t, watermark: entry.watermark, except: [] });
            const made = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)`).all(insert, touch) as { name: string }[]).length;
            assert(key.length > 0 && made === 2 && entry.watermark !== WHOLE_SET,
                `${t}: a plain table has a key the generic path matches its rows by (${key.join(', ') || 'none'}) and both triggers that stamp \`${entry.watermark}\` (${made} of 2)`);
        } else {
            assert(Array.isArray(payload[entry.payload]), `${t}: travels as \`${entry.payload}\` in the sync payload`);
        }
    }
    db.prepare(`DELETE FROM accounts WHERE public_key = 'manifest-whole-set'`).run();
    db.prepare(`DELETE FROM treasury_operators WHERE treasury_pubkey = 'manifest-whole-set'`).run();
    db.prepare(`DELETE FROM enterprise_pledges WHERE id = 'manifest-or-watermark'`).run();
    db.prepare(`DELETE FROM member_preferences WHERE public_key = 'manifest-in-row'`).run();
    db.prepare(`DELETE FROM members WHERE public_key = 'manifest-in-row'`).run();

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
        if (stamps(w.table, entry.watermark) || w.set.includes(entry.watermark) || (!!entry.orWatermark && w.set.includes(entry.orWatermark))) continue;
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
    // The community's own settings travel in one record (config/community-settings.ts): what it carries is what the
    // manifest calls the community's, no more and no less, so a setting added to either is decided in the other too.
    const record = await import('./config/community-settings.js');
    const { NODE_CONFIG_KEYS } = manifest;
    for (const [what, carried, classified] of [
        ['local-config.json', record.COMMUNITY_LOCAL_CONFIG_FIELDS, LOCAL_CONFIG_FIELDS],
        ['node_config', record.COMMUNITY_NODE_CONFIG_KEYS, NODE_CONFIG_KEYS],
        ["the node_config row's object", record.COMMUNITY_DIRECTORY_FIELDS, NODE_CONFIG_BLOB_FIELDS],
    ] as const) {
        const community = Object.entries(classified as Record<string, { kind: string }>).filter(([, e]) => e.kind === 'community-settings').map(([k]) => k);
        const notCarried = community.filter((k) => !(carried as readonly string[]).includes(k));
        const notCommunity = (carried as readonly string[]).filter((k) => !community.includes(k));
        assert(community.length > 0 && notCarried.length === 0 && notCommunity.length === 0,
            `the community settings record carries exactly the ${what} settings the manifest calls the community's (${community.length}; not carried: ${list(notCarried)}; carried but not the community's: ${list(notCommunity)})`);
    }

    console.log('\n— 6. node_config row keys —');
    // node_config is classified key by key (bySetting): a key no entry covers is `setting:unclassified` in the twin
    // suite, but only once a parity run happens to write it. Read every key the server's code writes instead.
    const { nodeConfigKeyEntry } = manifest;
    const repo = path.resolve(here, '../../..');
    const { writes, unread } = nodeConfigKeysWritten([here, path.join(repo, 'packages/beanpool-engine/src')], repo);
    const covered = (key: string) => (key.endsWith('*')
        ? Object.keys(NODE_CONFIG_KEYS).some((k) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))
        : !!nodeConfigKeyEntry(key));
    const keys = new Set(writes.map((w) => w.key));
    console.log(`  keys the server writes: ${list([...keys].sort())}`);
    const notCovered = [...new Set(writes.filter((w) => !covered(w.key)).map((w) => `${w.key} (${w.at})`))];
    assert(keys.size > 20 && keys.has('appAddressStaffSeen') && keys.has('nodeProfile.*') && keys.has('ledger_audit_baseline') && notCovered.length === 0,
        `every node_config row key the server's code writes is classified in NODE_CONFIG_KEYS (${keys.size} keys; unclassified: ${list(notCovered)})`);
    assert(unread.length === 0, `every write to node_config names its key where this check can read it (unread: ${list(unread)})`);

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ Every table, column and setting says how a standby holds it.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e?.message || e);
    process.exit(1);
});
