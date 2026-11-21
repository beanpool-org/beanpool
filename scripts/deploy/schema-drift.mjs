#!/usr/bin/env node
/* global process, console -- a Node script */
/**
 * Schema drift, before a deploy: which tables a node's database already holds in a shape the new build's schema.sql would
 * not give it. schema.sql makes each table with CREATE TABLE IF NOT EXISTS, which never touches a table that is there, so a
 * CHECK edited in place (day zero), a column added, a NOT NULL, a key or a UNIQUE changed reaches a fresh install and never
 * a kept node. It happened twice on 16 Nov 2026: group_guest_outbox and group_guest_mail (#3233), relay_mail and
 * relay_outbox (#3244), each already on a live node under the old CHECK. docs/schema-drift-check.md is the operators' page.
 *
 * READ-ONLY. The database is opened read-only (and query_only); nothing in it is written or dropped. To prove a boot step
 * against the rows that are there, a table one changes is copied into a scratch database of SQLite's own (a temporary file,
 * gone when it closes) and the step runs on the copy. The director acts on the lines it prints.
 *
 *   node scripts/deploy/schema-drift.mjs --db <state.db> [--schema <schema.sql>] [--manifest <replication-manifest.ts>]
 *       [--boot-steps <db.ts>]
 *   node scripts/deploy/schema-drift.mjs --pack [same three] | ssh <host> 'sudo docker exec -i -w /app/apps/server <container>
 *       node --input-type=module - --db /data/state.db'
 *
 * --schema, --manifest and --boot-steps default to this checkout's apps/server/src/db/schema.sql,
 * apps/server/src/engine/replication-manifest.ts and apps/server/src/db/db.ts: check out the build about to deploy first.
 * --pack prints this script with those three read into it, for `node -` inside the node container, whose files are the
 * running build's (better-sqlite3 is found from the working directory, /app/apps/server there).
 *
 * One line per table that is in the database and in schema.sql:
 *   OK <table> <kind>
 *   DRIFT-EMPTY-LOCAL <table> rows=0 local: <what differs>   never copied to a standby, and empty: a candidate to drop so the
 *                                                            new build makes it again
 *   DRIFT-HAS-ROWS <table> rows=<n> local: <what differs>    stop and ask
 *   DRIFT-REPLICATED <table> rows=<n> <kind>: <what differs> copied to standbys or carried by a take-over (or not found in
 *                                                            the manifest), whatever its rows: stop and ask
 * and one per table schema.sql makes that isn't in the database, when db.ts's boot may make it first (below):
 *   CANT-PROVE-NEW <table> <kind> (…): not in this database yet, …   stop and ask
 * <kind> is the table's entry in engine/replication-manifest.ts TABLES. Compared: the column set, each column's type,
 * NOT NULL, default, collation and generated form, the primary key, CHECKs, UNIQUEs, foreign keys, WITHOUT ROWID, STRICT
 * and AUTOINCREMENT, and a virtual table's whole definition. Not compared: indexes and triggers (CREATE ... IF NOT EXISTS keeps an old
 * one of the same name too), and tables schema.sql doesn't make. A column a boot step in db.ts adds before the schema.sql
 * exec (initSchema's ALTER TABLE ... ADD COLUMN) counts as there only when the step, run on a copy of the table with its
 * rows, in the order the boot runs the steps, takes: the line names it. A step those rows refuse is named with SQLite's
 * reason, its column reads as missing, and the table is never OK. A step is read only in the shapes bootSteps proves run
 * on their own (db.ts parsed with TypeScript's parser); a table any other ALTER in db.ts adds or drops a column of is never
 * OK ("can't prove"), whatever it reads as, and no replay runs on it; any other ALTER (a rename, a form not parsed) makes
 * every table can't prove. So does any other text the boot may run before the exec (in initSchema, or in what it calls in
 * db.ts) that names a table schema.sql makes, whatever it does with it (CREATE, INSERT … SELECT, DROP, UPDATE, DELETE, …):
 * that table can't prove, and when the node hasn't got it, it gets a CANT-PROVE-NEW line, not "the deploy makes them". A
 * text whose names can't be read (a `${…}` or a `+` not of top-level consts, a statement from a call) makes every table
 * can't prove. Other modules (an import initSchema calls) aren't read.
 *
 * Exit 0 only when every table compared is OK (proved against the rows that are there); 1 on any drift, a boot step
 * refused, or a table it could not prove; 2 when it could not run.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --pack replaces this one line with what it read, so the copy needs no file but the database.
const PACKED = null;

const USAGE = 'usage: node scripts/deploy/schema-drift.mjs --db <state.db> [--schema <schema.sql>] [--manifest <replication-manifest.ts>] [--boot-steps <db.ts>]\n'
    + '       node scripts/deploy/schema-drift.mjs --pack [--schema ...] [--manifest ...] [--boot-steps ...]   (a copy for `node --input-type=module - --db <state.db>`)';

/** The checkout this file is in, when it runs from a file (not as a packed copy on stdin). */
function repoRoot() {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// ── SQL text ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const TWO_CHAR_OPS = new Set(['||', '<=', '>=', '<>', '!=', '==', '<<', '>>', '->']);
const SAME_OP = { '<>': '!=', '==': '=' };

/**
 * SQL text as tokens, comments and spaces left out: `id` (a keyword or a name, lower case; a quoted name unquoted), `str` (a
 * string literal's value), `num` and `op`.
 */
export function sqlTokens(sql) {
    const out = [];
    const n = sql.length;
    const quoted = (i, close) => {
        let value = '';
        for (let j = i + 1; ;) {
            const end = sql.indexOf(close, j);
            if (end < 0) return [value + sql.slice(j), n];
            value += sql.slice(j, end);
            if (close !== ']' && sql[end + 1] === close) { value += close; j = end + 2; continue; }
            return [value, end + 1];
        }
    };
    for (let i = 0; i < n;) {
        const c = sql[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '-' && sql[i + 1] === '-') { const end = sql.indexOf('\n', i); i = end < 0 ? n : end + 1; continue; }
        if (c === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
        if (c === "'") { const [value, past] = quoted(i, "'"); out.push({ kind: 'str', text: value }); i = past; continue; }
        if (c === '"' || c === '`' || c === '[') {
            const [value, past] = quoted(i, c === '[' ? ']' : c);
            out.push({ kind: 'id', text: value.toLowerCase(), quoted: true });
            i = past;
            continue;
        }
        if (/[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127) {
            let j = i + 1;
            while (j < n && (/[A-Za-z0-9_$]/.test(sql[j]) || sql.charCodeAt(j) > 127)) j++;
            out.push({ kind: 'id', text: sql.slice(i, j).toLowerCase() });
            i = j;
            continue;
        }
        const num = /^(?:0x[0-9a-f]+|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?)/i.exec(sql.slice(i, i + 64));
        if (num) { out.push({ kind: 'num', text: num[0].toLowerCase() }); i += num[0].length; continue; }
        const two = sql.slice(i, i + 2);
        const op = TWO_CHAR_OPS.has(two) ? two : c;
        out.push({ kind: 'op', text: SAME_OP[op] ?? op });
        i += op.length;
    }
    return out;
}

const isOp = (t, text) => t?.kind === 'op' && t.text === text;
const isWord = (t, text) => t?.kind === 'id' && !t.quoted && t.text === text;

/** Tokens as one canonical line: the same SQL however it is spaced, commented, cased or quoted reads the same. */
export function canonical(tokens) {
    let out = '';
    let prev = null;
    for (const t of tokens) {
        const text = t.kind === 'str' ? `'${t.text.replace(/'/g, "''")}'` : t.text;
        const tight = prev === null || isOp(prev, '(') || (t.kind === 'op' && (t.text === ')' || t.text === ','));
        out += (tight ? '' : ' ') + text;
        prev = t;
    }
    return out;
}

/** The index of the `)` that closes the `(` at `open`; -1 when none does. */
function closing(tokens, open) {
    let depth = 0;
    for (let k = open; k < tokens.length; k++) {
        if (isOp(tokens[k], '(')) depth++;
        else if (isOp(tokens[k], ')') && --depth === 0) return k;
    }
    return -1;
}

const TABLE_CONSTRAINT = new Set(['constraint', 'primary', 'unique', 'check', 'foreign']);

/**
 * What a CREATE TABLE text says that SQLite's pragmas don't: every CHECK, a column's own or the table's (the same rule
 * either way), canonical; each column's COLLATE; and whether its key is AUTOINCREMENT.
 */
export function createTableParts(sql) {
    const tokens = sqlTokens(sql);
    const open = tokens.findIndex((t) => isOp(t, '('));
    const close = open < 0 ? -1 : closing(tokens, open);
    const checks = [];
    const collate = new Map();
    const autoincrement = tokens.some((t) => isWord(t, 'autoincrement'));
    if (close < 0) return { checks, collate, autoincrement };
    const items = [[]];
    let depth = 0;
    for (const t of tokens.slice(open + 1, close)) {
        if (isOp(t, '(')) depth++;
        if (isOp(t, ')')) depth--;
        if (depth === 0 && isOp(t, ',')) { items.push([]); continue; }
        items[items.length - 1].push(t);
    }
    for (const item of items) {
        if (item.length === 0) continue;
        const column = item[0].quoted || !TABLE_CONSTRAINT.has(item[0].text) ? item[0].text : null;
        for (let k = column === null ? 0 : 1, d = 0; k < item.length; k++) {
            const t = item[k];
            if (d === 0 && isWord(t, 'check') && isOp(item[k + 1], '(')) {
                const end = closing(item, k + 1);
                if (end < 0) break;
                checks.push(canonical(item.slice(k + 2, end)));
                k = end;
                continue;
            }
            if (d === 0 && column !== null && isWord(t, 'collate') && item[k + 1]) collate.set(column, item[k + 1].text);
            if (isOp(t, '(')) d++;
            if (isOp(t, ')')) d--;
        }
    }
    return { checks, collate, autoincrement };
}

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const quoteName = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** The tables of a database, by lower-case name: plain and virtual (a virtual table's shadow tables are its own). */
function tablesOf(db) {
    const rows = db.prepare(`SELECT name, type, wr, strict FROM pragma_table_list
        WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`).all();
    return new Map(rows.map((r) => [r.name.toLowerCase(), r]));
}

/** One table's shape, as SQLite reads it from the table's own CREATE text: everything IF NOT EXISTS leaves as it is. */
export function tableShape(db, name) {
    const info = db.prepare("SELECT type, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ? COLLATE NOCASE").get(name);
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE").get(name)?.sql ?? '';
    if (info?.type === 'virtual') {
        const tokens = sqlTokens(sql);
        return { virtual: canonical(tokens.slice(tokens.findIndex((t) => isWord(t, 'using')))) };
    }
    const parts = createTableParts(sql);
    const columns = new Map();
    for (const c of db.prepare('SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk, hidden FROM pragma_table_xinfo(?)').all(name)) {
        const key = c.name.toLowerCase();
        columns.set(key, {
            type: String(c.type ?? '').replace(/\s+/g, ' ').trim().toUpperCase(),
            notnull: c.nn ? 'NOT NULL' : 'NULL allowed',
            dflt: c.dflt === null ? 'none' : canonical(sqlTokens(String(c.dflt))),
            collate: parts.collate.get(key) ?? 'binary',
            generated: ['no', 'hidden', 'virtual', 'stored'][c.hidden] ?? String(c.hidden),
            pk: c.pk,
        });
    }
    const pk = [...columns].filter(([, c]) => c.pk > 0).sort((a, b) => a[1].pk - b[1].pk).map(([n]) => n);
    const uniques = db.prepare("SELECT name FROM pragma_index_list(?) WHERE origin = 'u'").all(name)
        .map((ix) => `(${db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(ix.name)
            .map((r) => String(r.name).toLowerCase()).sort().join(', ')})`);
    const fkById = new Map();
    for (const f of db.prepare('SELECT id, "table" AS parent, "from" AS f, "to" AS t, on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq').all(name)) {
        const fk = fkById.get(f.id) ?? { parent: f.parent.toLowerCase(), from: [], to: [], rule: `on update ${f.on_update} on delete ${f.on_delete}`.toLowerCase() };
        fk.from.push(String(f.f).toLowerCase());
        fk.to.push(f.t === null ? '' : String(f.t).toLowerCase());
        fkById.set(f.id, fk);
    }
    const fks = [...fkById.values()].map((f) => `(${f.from.join(', ')}) references ${f.parent}(${f.to.join(', ')}) ${f.rule}`);
    return {
        columns, pk, checks: parts.checks, uniques, fks,
        withoutRowid: info?.wr ? 'WITHOUT ROWID' : 'a rowid table',
        strict: info?.strict ? 'STRICT' : 'not STRICT',
        autoincrement: parts.autoincrement ? 'AUTOINCREMENT' : 'no AUTOINCREMENT',
    };
}

/** What is in `a` and not in `b`, counting repeats. */
function bagMinus(a, b) {
    const left = [...b];
    return a.filter((x) => { const k = left.indexOf(x); if (k < 0) return true; left.splice(k, 1); return false; });
}

/** Every way this database's table (`here`) differs from schema.sql's (`fresh`), in words; [] when none. */
export function shapeDiffs(here, fresh) {
    const d = [];
    if ('virtual' in here || 'virtual' in fresh) {
        if (here.virtual !== fresh.virtual) d.push(`virtual table: ${here.virtual ?? 'a plain table'} here, ${fresh.virtual ?? 'a plain table'} in schema.sql`);
        return d;
    }
    const missing = [...fresh.columns.keys()].filter((k) => !here.columns.has(k));
    const extra = [...here.columns.keys()].filter((k) => !fresh.columns.has(k));
    if (missing.length) d.push(`columns only in schema.sql: ${missing.join(', ')}`);
    if (extra.length) d.push(`columns only here: ${extra.join(', ')}`);
    for (const [name, f] of fresh.columns) {
        const h = here.columns.get(name);
        if (!h) continue;
        for (const [key, label] of [['type', 'type'], ['notnull', ''], ['dflt', 'default'], ['collate', 'collate'], ['generated', 'generated']]) {
            if (h[key] !== f[key]) d.push(`${name}: ${label ? `${label} ` : ''}${h[key] || "''"} here, ${f[key] || "''"} in schema.sql`);
        }
    }
    if (here.pk.join() !== fresh.pk.join()) d.push(`primary key (${here.pk.join(', ')}) here, (${fresh.pk.join(', ')}) in schema.sql`);
    for (const key of ['withoutRowid', 'strict', 'autoincrement']) if (here[key] !== fresh[key]) d.push(`${here[key]} here, ${fresh[key]} in schema.sql`);
    for (const [key, label] of [['checks', 'CHECK'], ['uniques', 'UNIQUE'], ['fks', 'FOREIGN KEY']]) {
        for (const x of bagMinus(here[key], fresh[key])) d.push(`${label} only here: ${x}`);
        for (const x of bagMinus(fresh[key], here[key])) d.push(`${label} only in schema.sql: ${x}`);
    }
    return d;
}

// ── What the build about to deploy says ──────────────────────────────────────────────────────────────────────────────

/**
 * Each table's kind in engine/replication-manifest.ts TABLES (`local`, `replicated`, `replicated-except`,
 * `takeover-bundle`), by lower-case name, read from its text: every entry starts at four spaces, `<table>: {` with its
 * `kind` first, or `<table>: plain(` (a plain table, copied: `replicated`, or `replicated-except` when the call, up to the
 * next entry, gives an `except`). A table not found reads as not local.
 */
export function manifestKinds(manifestTs) {
    const start = manifestTs.indexOf('export const TABLES');
    const end = start < 0 ? -1 : manifestTs.indexOf('\n};', start);
    const kinds = {};
    if (end < 0) return kinds;
    const body = manifestTs.slice(start, end);
    const entries = [...body.matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:\{\s*kind:\s*'([a-z-]+)'|(plain)\()/gm)];
    entries.forEach((m, i) => {
        const call = m[3] ? body.slice(m.index, entries[i + 1]?.index ?? body.length).replace(/\/\/[^\n]*/g, '') : '';
        kinds[m[1].toLowerCase()] = m[2] ?? (/\bexcept\s*:/.test(call) ? 'replicated-except' : 'replicated');
    });
    return kinds;
}

const STEP = /^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+(\S[\s\S]*)$/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The columns db.ts's initSchema adds before the schema.sql exec: what a kept node's tables hold once the new build has
 * booted, schema.sql aside. db.ts is read with TypeScript's own parser (the repo's `typescript`), and a step is read ONLY in
 * a shape that provably runs on its own, every boot, in the place it is written: a statement of initSchema's own, at its top
 * level, before its top-level `db.exec(schemaSql);`, that is exactly
 *   try { db.prepare(<one string literal>).run(); } catch { }
 * or a `for (const column of [<string literals>]) { <that try, on `ALTER TABLE <table> ADD COLUMN ${column}`> }`, or a
 * `for (const [table, column] of [[<literal>, <literal>], …]) { <that try, on `ALTER TABLE ${table} ADD COLUMN ${column}`> }`,
 * the try the loop body's only statement. Nothing else in the try, no catch binding, nothing in the catch (a comment is
 * nothing), no finally.
 *
 * `steps` are in the order the boot runs them: the statements' order, a loop's in the loop's order at the loop's place. The
 * order counts: a step can name a column a later one adds, or add a column an earlier one added (the first stands).
 *
 * `unread` names the table of every other ALTER in db.ts, where it is `ALTER TABLE <table> ADD|DROP …`, the forms that
 * change that one table alone; any other ALTER is null (every table): a table rename (`ALTER TABLE t_new RENAME TO t`
 * changes t, not t_new), a column rename (it rewrites other tables' REFERENCES to the column), a form not parsed, a
 * name that may run on into a `${…}` or a `+`, and the word ALTER in any string. The shapes: two steps sharing a try, a
 * step behind an if, an else, a ternary or `&&`, a non-empty catch, inside a function or a callback (a function declared
 * after the exec too: it hoists), a template, db.exec, a variable, a loop in any other shape, and each item of a loop's
 * list that isn't its literals. What the boot does with those isn't known, so the table they name (every table, for a
 * null) is never OK and no replay runs on it. A `return` before the exec (a step
 * may never run) or a `db` initSchema declares itself (a step may not reach the node's database) moves every step there.
 * An ALTER in initSchema after the exec, outside a function, runs after schema.sql and is no step. Comments are not code,
 * so a step in one is nothing. A db.ts the parser finds a syntax error in reads as having no initSchema (`found: false`).
 *
 * `named` lists, for each other text the boot may run before the exec, each of `tables` (schema.sql's) it names, or null
 * when its names can't be read: see bootNamed.
 */
export function bootSteps(dbTs, tables = []) {
    const ts = createRequire(import.meta.url)('typescript');
    const file = ts.createSourceFile('/db.ts', dbTs, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const none = { steps: [], unread: [], named: [], found: false };
    if ((file.parseDiagnostics ?? []).length > 0) return none;
    const init = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'initSchema' && s.body);
    if (!init) return none;
    const body = init.body.statements;
    const literal = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null);
    const named = (n, text) => ts.isIdentifier(n) && n.text === text;
    // `<object>.<method>(…)` with `args` arguments, plain: no `?.`, no type arguments.
    const call = (n, method, args) => ts.isCallExpression(n) && !n.questionDotToken && !n.typeArguments && n.arguments.length === args
        && ts.isPropertyAccessExpression(n.expression) && !n.expression.questionDotToken && named(n.expression.name, method);
    const onDb = (n, method, args) => call(n, method, args) && named(n.expression.expression, 'db');
    const execAt = body.findIndex((s) => ts.isExpressionStatement(s) && onDb(s.expression, 'exec', 1) && named(s.expression.arguments[0], 'schemaSql'));
    if (execAt < 0) return none;
    // `try { db.prepare(<x>).run(); } catch { }` and nothing else: its <x>, else null.
    const loneStep = (s) => {
        if (!ts.isTryStatement(s) || s.finallyBlock || !s.catchClause || s.catchClause.variableDeclaration) return null;
        if (s.catchClause.block.statements.length > 0 || s.tryBlock.statements.length !== 1) return null;
        const only = s.tryBlock.statements[0];
        if (!ts.isExpressionStatement(only) || !call(only.expression, 'run', 0)) return null;
        const prepare = only.expression.expression.expression;
        return onDb(prepare, 'prepare', 1) ? prepare.arguments[0] : null;
    };
    // `for (const <name> of [<elements>]) { <a lone step on a template> }`, else null.
    const loopStep = (s) => {
        if (!ts.isForOfStatement(s) || s.awaitModifier || !ts.isVariableDeclarationList(s.initializer)) return null;
        const list = s.initializer;
        if (!(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1 || list.declarations[0].initializer) return null;
        if (!ts.isArrayLiteralExpression(s.expression) || !ts.isBlock(s.statement) || s.statement.statements.length !== 1) return null;
        const arg = loneStep(s.statement.statements[0]);
        return arg && ts.isTemplateExpression(arg) ? { name: list.declarations[0].name, elements: s.expression.elements, template: arg } : null;
    };
    const binding = (e) => (ts.isBindingElement(e) && !e.dotDotDotToken && !e.propertyName && !e.initializer && ts.isIdentifier(e.name) ? e.name.text : null);

    const steps = [];
    const unread = [];
    const read = new Set(); // the statements read as steps: an ALTER inside one is accounted for
    for (const s of body.slice(0, execAt)) {
        const arg = loneStep(s);
        const one = arg === null ? null : STEP.exec(literal(arg) ?? '');
        if (one) {
            steps.push({ table: one[1].toLowerCase(), def: one[2] });
            read.add(s);
            continue;
        }
        const loop = loopStep(s);
        if (!loop) continue;
        const { head, templateSpans: spans } = loop.template;
        // One table's columns: `ALTER TABLE <table> ADD COLUMN ${column}`.
        const table = /^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+$/i.exec(head.text);
        if (table && ts.isIdentifier(loop.name) && spans.length === 1 && named(spans[0].expression, loop.name.text) && spans[0].literal.text === '') {
            const t = table[1].toLowerCase();
            for (const e of loop.elements) {
                if (literal(e) === null) unread.push(t); // a name, a spread, a hole: steps this can't read
                else steps.push({ table: t, def: literal(e) });
            }
            read.add(s);
            continue;
        }
        // [table, column] pairs: `ALTER TABLE ${table} ADD COLUMN ${column}`.
        const pair = ts.isArrayBindingPattern(loop.name) && loop.name.elements.length === 2 ? loop.name.elements.map(binding) : null;
        if (pair && pair[0] && pair[1] && pair[0] !== pair[1] && /^ALTER\s+TABLE\s+$/i.test(head.text) && spans.length === 2
            && named(spans[0].expression, pair[0]) && /^\s+ADD\s+COLUMN\s+$/i.test(spans[0].literal.text)
            && named(spans[1].expression, pair[1]) && spans[1].literal.text === '') {
            for (const e of loop.elements) {
                const [t, def] = ts.isArrayLiteralExpression(e) && e.elements.length === 2 ? e.elements.map(literal) : [null, null];
                if (t === null || def === null || !NAME.test(t)) unread.push(null);
                else steps.push({ table: t.toLowerCase(), def });
            }
            read.add(s);
        }
    }

    // Every other ALTER in db.ts, in a string or a template's text (comments aren't nodes), in the file's order.
    const alterOf = new Map(); // each string node an ALTER was counted in: the table (or null) each ALTER there names
    const after = new Set(body.slice(execAt + 1));
    const counted = (n) => {
        // Inside a step read above: accounted for. In initSchema after the exec, outside any function: runs after schema.sql.
        let inFunction = false;
        for (let p = n.parent; p; p = p.parent) {
            if (read.has(p)) return false;
            if (p === init) return true;
            if (ts.isFunctionLike(p)) inFunction = true; // before `after`: a function declared after the exec hoists
            if (after.has(p)) return inFunction;
        }
        return true;
    };
    let shadowed = false;
    const inInit = (n) => init.pos <= n.pos && n.end <= init.end;
    const visit = (n) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
            const alters = [...n.text.matchAll(/\bALTER\b/gi)];
            if (alters.length > 0 && counted(n)) {
                const here = [];
                for (const m of alters) {
                    // A table only for the forms that change that table alone: ADD [COLUMN] and DROP [COLUMN]. Anything
                    // else is null (every table): a table rename changes the table it names after TO, a column rename
                    // rewrites other tables' REFERENCES to the column, and a form not parsed here may do either. A name
                    // that runs on into a `${…}` or a `+` (no space before ADD or DROP) is null too.
                    const one = /^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:ADD|DROP)\b/i.exec(n.text.slice(m.index));
                    here.push(one ? one[1].toLowerCase() : null);
                }
                unread.push(...here);
                alterOf.set(n, here);
            }
        }
        if (n !== init && inInit(n) && n.name && named(n.name, 'db') && (ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isParameter(n)
            || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n))) shadowed = true;
        ts.forEachChild(n, visit);
    };
    visit(file);
    // A `return` before the exec, outside a function (a step may never run), or a `db` initSchema declares itself (a step may
    // not reach the node's database): no step is proved, and the table each names can't be.
    const returns = (n) => !ts.isFunctionLike(n) && (ts.isReturnStatement(n) || ts.forEachChild(n, returns) === true);
    const texts = bootNamed(ts, file, init, body.slice(0, execAt).filter((s) => !read.has(s)), alterOf, tables);
    if (shadowed || body.slice(0, execAt).some(returns)) return { steps: [], unread: [...unread, ...steps.map((s) => s.table)], named: texts, found: true };
    return { steps, unread, named: texts, found: true };
}

const SQL_METHODS = new Set(['exec', 'prepare', 'pragma']);

/**
 * Every table of `tables` (schema.sql's, lower case) that a text db.ts's boot may run before the schema.sql exec names, other
 * than a step bootSteps reads, whatever the statement does with it (CREATE, INSERT … SELECT, DROP, UPDATE, DELETE, ALTER,
 * anything); null (every table) for a text whose names can't be read. Without this, a boot that makes or rebuilds a table
 * schema.sql makes, in its own words, reads OK: schema.sql's CREATE TABLE IF NOT EXISTS then keeps the boot's shape.
 *
 * Where: `region` (initSchema's statements before the exec, its read steps left out), and, followed through TypeScript's
 * checker, every declaration in db.ts that code there names: a function it calls (its whole body, callbacks and all), a
 * variable (and each assignment to it, when it isn't const), a class; and what code there names, in turn. An import is
 * another module's: not read.
 * A text: a string, a template or a `+` of them, read as the text it always has: a `${…}` or an operand of the `+` is
 * resolved only from a top-level `const X = <string or number>` (and its own `${…}`, `+` and consts), so today's
 * `${PLAIN_PUSH_TOKENS}` reads as push_tokens_plain; anything else (a parameter, a local, a call, a tagged template) can't
 * be read: null. So is the argument of any exec, prepare or pragma call there that isn't such a text (db.exec(schemaSql)
 * aside: schema.sql's own text), and an exec, prepare or pragma taken as a value without being called.
 * A name: every word the text holds as SQLite reads words (sqlTokens: "t", `t`, [t] and 't' unquoted, any case, main.t and
 * temp.t naming t), so IF [NOT] EXISTS, a quote or a schema name can't hide one. Each text counts once per table. A table
 * an ALTER counted in the same text (bootSteps' `unread`) already names is left out here, and a text an ALTER counted as
 * null (every table) adds nothing.
 */
function bootNamed(ts, file, init, region, alterOf, tables) {
    const known = new Set([...tables].map((t) => String(t).toLowerCase()));
    const host = {
        getSourceFile: (name) => (name === file.fileName ? file : undefined),
        getDefaultLibFileName: () => 'lib.d.ts',
        writeFile: () => { },
        getCurrentDirectory: () => '/',
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        fileExists: (name) => name === file.fileName,
        readFile: (name) => (name === file.fileName ? file.text : undefined),
        directoryExists: () => true,
        getDirectories: () => [],
    };
    const checker = ts.createProgram({ rootNames: [file.fileName], options: { noLib: true, noResolve: true, types: [] }, host }).getTypeChecker();
    const symbolOf = (id) => {
        const s = checker.getSymbolAtLocation(id);
        return s && !(s.flags & ts.SymbolFlags.Alias) ? s : null;
    };
    const constOf = (d) => d && ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0;

    // Every identifier in the file, by its symbol: for the assignments to a variable that isn't const.
    let refs = null;
    const refsOf = (symbol) => {
        if (!refs) {
            refs = new Map();
            const index = (n) => {
                if (ts.isIdentifier(n)) {
                    const s = checker.getSymbolAtLocation(n);
                    if (s) refs.set(s, [...(refs.get(s) ?? []), n]);
                }
                ts.forEachChild(n, index);
            };
            index(file);
        }
        return refs.get(symbol) ?? [];
    };
    const ASSIGN = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken]);

    // The region, and every declaration code in it names, in turn.
    const scope = [];
    const inScope = new Set();
    const add = (n) => { if (n && n !== init && !inScope.has(n)) { inScope.add(n); scope.push(n); } };
    region.forEach(add);
    for (let k = 0; k < scope.length; k++) {
        const walk = (n) => {
            if (ts.isIdentifier(n)) {
                const symbol = symbolOf(n);
                for (const d of symbol?.declarations ?? []) {
                    if (ts.isParameter(d)) continue; // its value comes from a call, which is in the region or followed
                    let decl = d;
                    while (ts.isBindingElement(decl) || ts.isObjectBindingPattern(decl) || ts.isArrayBindingPattern(decl)) decl = decl.parent;
                    if (ts.isParameter(decl)) continue;
                    add(decl);
                    if (ts.isVariableDeclaration(decl) && !constOf(decl)) {
                        for (const r of refsOf(symbol)) {
                            const p = r.parent;
                            if ((ts.isBinaryExpression(p) && p.left === r && ASSIGN.has(p.operatorToken.kind))) add(p);
                        }
                    }
                }
            }
            ts.forEachChild(n, walk);
        };
        walk(scope[k]);
    }

    const skipParens = (n) => { while (ts.isParenthesizedExpression(n)) n = n.expression; return n; };
    const isPlus = (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
    const isPiece = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);
    // A top-level `const X = …`: its initializer, else null.
    const topConst = (id) => {
        const d = symbolOf(id)?.valueDeclaration;
        return constOf(d) && ts.isIdentifier(d.name) && ts.isVariableStatement(d.parent.parent) && d.parent.parent.parent === file ? d.initializer ?? null : null;
    };
    // The text an expression always has, or null.
    const textOf = (n, seen = new Set()) => {
        n = skipParens(n);
        if (seen.has(n)) return null; // a const that reads itself
        seen.add(n);
        try { return textOfOnce(n, seen); } finally { seen.delete(n); }
    };
    const textOfOnce = (n, seen) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) {
            return ts.isTaggedTemplateExpression(n.parent) ? null : n.text;
        }
        if (ts.isTemplateExpression(n)) {
            if (ts.isTaggedTemplateExpression(n.parent)) return null;
            let text = n.head.text;
            for (const span of n.templateSpans) {
                const value = textOf(span.expression, seen);
                if (value === null) return null;
                text += value + span.literal.text;
            }
            return text;
        }
        if (isPlus(n)) {
            const [a, b] = [textOf(n.left, seen), textOf(n.right, seen)];
            return a === null || b === null ? null : a + b;
        }
        if (ts.isIdentifier(n)) {
            const value = topConst(n);
            return value ? textOf(value, seen) : null;
        }
        return null;
    };
    // initSchema's own `const schemaSql = …`: schema.sql's text.
    const isSchemaSql = (n) => {
        const d = ts.isIdentifier(n) ? symbolOf(n)?.valueDeclaration : null;
        return !!d && constOf(d) && ts.isIdentifier(d.name) && d.name.text === 'schemaSql' && d.parent.parent.parent === init.body;
    };

    const named = [];
    const done = new Set();
    // One text: its names (the ALTERs counted in it aside), or null.
    const count = (root) => {
        if (done.has(root)) return;
        done.add(root);
        const alters = [];
        const pieces = (n) => {
            if (alterOf.has(n)) alters.push(...alterOf.get(n));
            ts.forEachChild(n, pieces);
        };
        pieces(root);
        if (alters.includes(null)) return; // every table already
        const text = textOf(root);
        if (text === null) { named.push(null); return; }
        const names = new Set(sqlTokens(text).filter((t) => t.kind === 'id' || t.kind === 'str').map((t) => t.text.toLowerCase()));
        for (const t of [...names].filter((x) => known.has(x) && !alters.includes(x)).sort()) named.push(t);
    };
    for (const node of scope) {
        const visit = (n) => {
            if (isPiece(n)) {
                let root = n;
                for (let p = root.parent; p && (ts.isParenthesizedExpression(p) || isPlus(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isTaggedTemplateExpression(p)); p = p.parent) {
                    root = p;
                }
                count(ts.isTemplateSpan(root) ? root.parent : root);
            }
            // A method by a key that can't be read (`db[m](…)`), or exec, prepare or pragma taken out by name
            // (`const { exec } = db`): any text may reach it.
            if (ts.isElementAccessExpression(n) && !ts.isStringLiteralLike(n.argumentExpression) && textOf(n.argumentExpression) === null && !done.has(n)) {
                done.add(n);
                named.push(null);
            }
            if (ts.isBindingElement(n) && SQL_METHODS.has((n.propertyName ?? n.name).text ?? '') && !done.has(n)) {
                done.add(n);
                named.push(null);
            }
            const method = ts.isPropertyAccessExpression(n) ? n.name.text
                : ts.isElementAccessExpression(n) ? (ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : textOf(n.argumentExpression)) : null;
            if (method !== null && SQL_METHODS.has(method) && !done.has(n)) {
                done.add(n); // a declaration in the region is walked again as its own: each call counts once
                let callee = n;
                while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent;
                const c = callee.parent;
                if (!(ts.isCallExpression(c) && c.expression === callee)) named.push(null); // taken as a value: any text may reach it
                else if (c.arguments.length > 0 && !isSchemaSql(skipParens(c.arguments[0]))) {
                    // A text is counted where it is written (a top-level const's in its declaration, followed above); a
                    // `+` of names here, whole, so a name split across two consts is read too; anything else can't be read.
                    const arg = skipParens(c.arguments[0]);
                    if (isPiece(arg) || isPlus(arg) || ts.isTaggedTemplateExpression(arg)) count(arg);
                    else if (textOf(arg) === null) named.push(null);
                }
            }
            ts.forEachChild(n, visit);
        };
        visit(node);
    }
    return named;
}

/** What the check compares against, read from the checkout (or from the packed copy). */
export function readBuild({ schema, manifest, boot }) {
    const schemaSql = readFileSync(schema, 'utf8');
    // The tables schema.sql makes, as SQLite makes them: the names a text in db.ts's boot is read for.
    const Database = loadSqlite();
    const mem = new Database(':memory:');
    let tables;
    try {
        mem.exec(schemaSql);
        tables = [...tablesOf(mem).keys()];
    } finally {
        mem.close();
    }
    const boots = bootSteps(readFileSync(boot, 'utf8'), tables);
    return {
        schemaSql,
        schemaSha: createHash('sha256').update(schemaSql).digest('hex').slice(0, 12),
        kinds: manifestKinds(readFileSync(manifest, 'utf8')),
        bootSteps: boots.steps,
        bootUnread: boots.found ? boots.unread.length : -1,
        bootUnreadTables: boots.unread,
        bootNamedTables: boots.named,
    };
}

// ── The check ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** better-sqlite3, from the working directory first (in the node container: /app/apps/server), else from this checkout. */
export function loadSqlite() {
    const from = [join(process.cwd(), 'noop.js'), fileURLToPath(import.meta.url)];
    if (PACKED === null) from.push(join(repoRoot(), 'apps', 'server', 'package.json'));
    for (const base of from) {
        try { return createRequire(base)('better-sqlite3'); } catch { /* the next place */ }
    }
    throw new Error('better-sqlite3 not found: run it from apps/server (in the node container: docker exec -w /app/apps/server)');
}

/** The database, opened so that no statement can write it: read-only, the file must exist, and query_only. */
export function openReadOnly(Database, path) {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    return db;
}

/**
 * Table `name` as the new build's boot leaves it before the schema.sql exec, proved against the rows the node holds: its
 * CREATE text in a scratch database of SQLite's own (`new Database('')`: a temporary file, gone when it closes), every row
 * copied in as stored, then the boot's ADD COLUMNs run in db.ts's order, each on its own as initSchema runs them (bootSteps
 * reads a step only where the boot does run it so). SQLite
 * checks some ADD COLUMN rules only against the rows that are there (NOT NULL with no default, a CHECK a row or the default
 * fails, a non-constant default, a STORED column, a generated NOT NULL, a STRICT type, REFERENCES with a default), so a step
 * that every fresh install takes can be refused on a kept node: on an empty copy it would read as taken. `db` is only read.
 *
 * Returns the scratch table's shape, the columns added and the steps refused (the column already there is no refusal), or
 * `error` when the copy could not be made (a CREATE text that won't run without the server, a row that won't copy): then
 * nothing counts as added, and the drift stands as read.
 */
export function replayBootSteps(Database, db, name, steps) {
    const scratch = new Database('');
    try {
        const create = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql;
        if (!create) throw new Error('its CREATE text was not found');
        // The copy: each row as the node stores it, so no rule may refuse one here (the parents of a foreign key aren't copied;
        // a CHECK the rows were written under is the node's own). Integers as BigInt and reals as doubles: each value keeps
        // its storage class, so a rule that reads one (typeof, a value past 2^53) sees what the boot will see.
        scratch.pragma('foreign_keys = OFF');
        scratch.pragma('ignore_check_constraints = ON');
        scratch.exec(create);
        const columns = db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden NOT IN (2, 3)').all(name).map((c) => quoteName(c.name));
        const read = db.prepare(`SELECT ${columns.join(', ')} FROM ${quoteName(name)}`).raw(true).safeIntegers(true);
        const write = scratch.prepare(`INSERT INTO ${quoteName(name)} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
        let copied = 0;
        scratch.transaction(() => { for (const row of read.iterate()) { write.run(row); copied++; } })();
        if (scratch.prepare(`SELECT COUNT(*) AS n FROM ${quoteName(name)}`).get().n !== copied) throw new Error('the copy lost rows');
        // The steps, as the boot runs them: every CHECK enforced, and foreign keys ON. The server runs with them OFF (db.ts), so
        // a REFERENCES step with a default reads as refused here where that boot takes it: the stricter way, never the other.
        scratch.pragma('ignore_check_constraints = OFF');
        scratch.pragma('foreign_keys = ON');
        const added = [];
        const refused = [];
        for (const s of steps) {
            const column = sqlTokens(s.def)[0]?.text ?? s.def;
            try {
                // prepare + run, as the boot's db.prepare(…).run(): one statement only, so a second one after a `;` is refused here as there.
                scratch.prepare(`ALTER TABLE ${quoteName(name)} ADD COLUMN ${s.def}`).run();
                added.push(column);
            } catch (e) {
                // As db.ts: refused in its own try. A column that is there already is every later boot's case, not news.
                if (!/^duplicate column name/i.test(e.message)) refused.push(`${column} (${e.message})`);
            }
        }
        return { shape: tableShape(scratch, name), added, refused, error: null };
    } catch (e) {
        return { added: [], refused: [], error: e.message };
    } finally {
        scratch.close();
    }
}

/**
 * Compares each table the database `db` holds with the one schema.sql makes. Returns one result per table in both (sorted by
 * name), and counts of the tables in only one. Reads `db` only (a table a boot step changes is copied to a scratch database).
 */
export function checkDrift(Database, db, build) {
    const fresh = new Database(':memory:');
    try {
        fresh.exec(build.schemaSql);
        const freshTables = tablesOf(fresh);
        const hereTables = tablesOf(db);
        const results = [];
        let notYet = 0;
        for (const [key, f] of [...freshTables].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
            const h = hereTables.get(key);
            const kind = build.kinds[key] ?? 'not in the manifest';
            // Each ALTER in db.ts naming it (or no table) that isn't a step the reader can prove runs on its own, and each other
            // text the boot may run before the exec that names it (or whose names can't be read): what the boot does to this
            // table isn't known, so it is never OK, even when it reads as schema.sql's shape now, and no replay runs.
            const unproved = (build.bootUnreadTables ?? []).filter((t) => t === key || t === null).length;
            const namedBy = (build.bootNamedTables ?? []).filter((t) => t === key || t === null).length;
            if (!h) {
                // Not here: schema.sql makes it at the deploy, unless the boot may make it first, in a shape of its own.
                if (unproved === 0 && namedBy === 0) notYet++;
                else results.push({ status: 'CANT-PROVE-NEW', table: f.name, kind, rows: null, diffs: [], bootAdds: [], bootRefused: [], replayError: null, bootUnproved: unproved, bootNamed: namedBy });
                continue;
            }
            const freshShape = tableShape(fresh, f.name);
            let diffs = shapeDiffs(tableShape(db, h.name), freshShape);
            let replay = { added: [], refused: [], error: null };
            const steps = build.bootSteps.filter((s) => s.table === key);
            if (diffs.length > 0 && steps.length > 0 && h.type === 'table' && unproved === 0 && namedBy === 0) {
                // Only ever turns a drift into OK when the boot's steps, run on the table's own rows in the boot's order, give
                // schema.sql's shape; a step the rows refuse, or a replay that can't be made, leaves the drift as read.
                replay = replayBootSteps(Database, db, h.name, steps);
                if (replay.added.length > 0) diffs = shapeDiffs(replay.shape, freshShape);
            }
            let status = 'OK';
            let rows = null;
            // A refused step is never OK, whatever its column: the boot drops it without a word on this node. Nor is a boot the
            // reader can't prove.
            if (diffs.length > 0 || replay.refused.length > 0 || unproved > 0 || namedBy > 0) {
                rows = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteName(h.name)}`).get().n;
                status = kind !== 'local' ? 'DRIFT-REPLICATED' : rows > 0 ? 'DRIFT-HAS-ROWS' : 'DRIFT-EMPTY-LOCAL';
            }
            results.push({ status, table: h.name, kind, rows, diffs, bootAdds: replay.added, bootRefused: replay.refused, replayError: replay.error, bootUnproved: unproved, bootNamed: namedBy });
        }
        return {
            results,
            ok: results.every((r) => r.status === 'OK'),
            onlyInSchema: notYet,
            onlyHere: [...hereTables.keys()].filter((k) => !freshTables.has(k)).length,
        };
    } finally {
        fresh.close();
    }
}

/** One line per result, as the header of this file says. */
export function formatResult(r) {
    const notes = [];
    if (r.bootAdds.length > 0) notes.push(`with the columns a boot step in db.ts adds: ${r.bootAdds.join(', ')}`);
    if (r.bootRefused?.length > 0) notes.push(`boot steps in db.ts refused here: ${r.bootRefused.join(', ')}`);
    if (r.replayError) notes.push(`its boot steps in db.ts could not be run on a copy of its rows (${r.replayError}), so the drift stands as read`);
    const why = [];
    if (r.bootUnproved > 0) why.push(`${r.bootUnproved} ALTER in db.ts not written as a step the check reads (alone in an empty try at initSchema's top level, before the schema.sql exec)`);
    if (r.bootNamed > 0) why.push(`${r.bootNamed} other text in db.ts the boot may run before the schema.sql exec (in initSchema or what it calls) that names it or whose names can't be read`);
    if (why.length > 0) notes.push(`can't prove its boot: ${why.join('; ')}, so no replay ran`);
    const boot = notes.length > 0 ? ` (${notes.join('; ')})` : '';
    if (r.status === 'OK') return `OK ${r.table} ${r.kind}${boot}`;
    if (r.status === 'CANT-PROVE-NEW') return `CANT-PROVE-NEW ${r.table} ${r.kind}${boot}: not in this database yet, and the boot may make it before schema.sql does`;
    return `${r.status} ${r.table} rows=${r.rows} ${r.kind}${boot}: ${r.diffs.length > 0 ? r.diffs.join('; ') : 'nothing else differs'}`;
}

/** The command line; `{ error }` when it can't be read. */
export function parseArgs(argv) {
    const opts = { pack: false };
    const names = { '--db': 'db', '--schema': 'schema', '--manifest': 'manifest', '--boot-steps': 'boot' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--pack') { opts.pack = true; continue; }
        if (a === '--help' || a === '-h') return { help: true };
        const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
        if (!(flag in names)) return { error: `unknown argument: ${a}` };
        const value = inline ?? argv[++i];
        if (!value) return { error: `${flag} needs a value` };
        opts[names[flag]] = value;
    }
    if (!opts.pack && !opts.db) return { error: '--db <state.db> is needed' };
    if (opts.pack && opts.db) return { error: '--pack prints a copy to run elsewhere; give --db to that copy' };
    return opts;
}

/** Prints the copy for `node -`: this file with what it read in place of its PACKED line. */
export function packed(build) {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const line = /^const PACKED = null;$/m;
    if (!line.test(self)) throw new Error('this file has no PACKED line to fill');
    return self.replace(line, () => `const PACKED = ${JSON.stringify(build)};`);
}

export function main(argv, out = console.log, err = console.error) {
    const opts = parseArgs(argv);
    if (opts.help) { out(USAGE); return 0; }
    if (opts.error) { err(`schema-drift: ${opts.error}\n${USAGE}`); return 2; }
    let build = PACKED;
    if (build === null) {
        const root = repoRoot();
        try {
            build = readBuild({
                schema: opts.schema ?? join(root, 'apps/server/src/db/schema.sql'),
                manifest: opts.manifest ?? join(root, 'apps/server/src/engine/replication-manifest.ts'),
                boot: opts.boot ?? join(root, 'apps/server/src/db/db.ts'),
            });
        } catch (e) {
            err(`schema-drift: could not read the build: ${e.message}`);
            return 2;
        }
    }
    if (opts.pack) { out(packed(build)); return 0; }
    let Database;
    let db;
    try {
        Database = loadSqlite();
        db = openReadOnly(Database, opts.db);
    } catch (e) {
        err(`schema-drift: could not open ${opts.db} read-only: ${e.message}`);
        return 2;
    }
    let result;
    try {
        result = checkDrift(Database, db, build);
    } catch (e) {
        err(`schema-drift: could not compare: ${e.message}`);
        return 2;
    } finally {
        db.close();
    }
    out(`schema-drift: ${opts.db} against schema.sql ${build.schemaSha}, read-only`);
    if (build.bootUnread !== 0) {
        out(`schema-drift: note: ${build.bootUnread < 0 ? "db.ts's initSchema was not found; a column a boot step adds reads as drift here" : `${build.bootUnread} ALTER in db.ts not written as a step the check reads; the table it adds or drops a column of (every table, for any other form: a rename, one not parsed) can't be proved and is never OK`}`);
    }
    const named = build.bootNamedTables ?? [];
    if (named.length > 0) {
        out(`schema-drift: note: ${named.length} text in db.ts the boot may run before the schema.sql exec names a table schema.sql makes, outside a step the check reads (${[...new Set(named.map((t) => t ?? "every table: its names can't be read"))].join(', ')}); that table can't be proved and is never OK`);
    }
    for (const r of result.results) out(formatResult(r));
    const compared = result.results.filter((r) => r.status !== 'CANT-PROVE-NEW');
    const cantNew = result.results.length - compared.length;
    const drift = compared.filter((r) => r.status !== 'OK').length;
    out(`schema-drift: ${compared.length} tables compared, ${drift} drift; ${result.onlyInSchema} in schema.sql not in this database yet (the deploy makes them); ${cantNew > 0 ? `${cantNew} not here that the boot may make first (can't prove); ` : ''}${result.onlyHere} here not in schema.sql (not compared)`);
    return result.ok ? 0 : 1;
}

// Runs as a command (a file, or a packed copy on stdin); imported by its test, it runs nothing.
const asCommand = PACKED !== null || process.argv[1] === '-' || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (asCommand) process.exitCode = main(process.argv.slice(2));
