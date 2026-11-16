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
 * <kind> is the table's entry in engine/replication-manifest.ts TABLES. Compared: the column set, each column's type,
 * NOT NULL, default, collation and generated form, the primary key, CHECKs, UNIQUEs, foreign keys, WITHOUT ROWID, STRICT
 * and AUTOINCREMENT, and a virtual table's whole definition. Not compared: indexes and triggers (CREATE ... IF NOT EXISTS keeps an old
 * one of the same name too), and tables schema.sql doesn't make. A column a boot step in db.ts adds before the schema.sql
 * exec (initSchema's ALTER TABLE ... ADD COLUMN) counts as there only when the step, run on a copy of the table with its
 * rows, in the order the boot runs the steps, takes: the line names it. A step those rows refuse is named with SQLite's
 * reason, its column reads as missing, and the table is never OK. A table an ALTER TABLE before the exec names that the
 * check can't read in the boot's order keeps its drift as read ("can't prove").
 *
 * Exit 0 only when every table compared is OK (proved against the rows that are there); 1 on any drift, a boot step
 * refused, or one it could not prove; 2 when it could not run.
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

/**
 * `text` (JavaScript) with its comments blanked, a space for each character and every line break kept, so every offset
 * stays where it was and a step in a comment, which no boot runs, isn't read as one. Strings and template literals, with
 * their `${…}`, are kept as written.
 */
export function withoutComments(text) {
    const out = text.split('');
    const stack = ['code']; // 'code', or the quote of the string it is in; a template's `${` opens a 'code' of its own
    const braces = [0]; // one count per 'code' on the stack: the `}` that closes a template's `${` is the one at 0
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const top = stack[stack.length - 1];
        if (top !== 'code') {
            if (c === '\\') i++;
            else if (c === top) stack.pop();
            else if (top === '`' && c === '$' && text[i + 1] === '{') { stack.push('code'); braces.push(0); i++; }
            continue;
        }
        if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            const line = text[i + 1] === '/';
            const end = line ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
            const stop = end < 0 ? text.length : line ? end : end + 2;
            for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' ';
            i--;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') stack.push(c);
        else if (c === '{') braces[braces.length - 1]++;
        else if (c === '}' && stack.length > 1 && braces[braces.length - 1] === 0) { stack.pop(); braces.pop(); }
        else if (c === '}') braces[braces.length - 1]--;
    }
    return out.join('');
}

/**
 * The columns db.ts's initSchema adds before the schema.sql exec (ALTER TABLE ... ADD COLUMN, each in its own try): what a
 * kept node's tables hold once the new build has booted, schema.sql aside. Read from the text in its three forms: a literal
 * statement, a loop over one table's column definitions, a loop over [table, column] pairs.
 *
 * `steps` are in the order the boot runs them: by where each sits in initSchema, a loop's in the loop's order at the loop's
 * place. The order counts: a step can name a column a later one adds, or add a column an earlier one added (the first
 * stands), so a replay in any other order can take what the boot refuses.
 *
 * `unread` names the table of each ALTER TABLE outside a comment in none of those forms, and of each loop whose array holds
 * more than its literals (null where the text doesn't name one): where in the order it runs, and what it does, is not
 * known, so a table it names (every table, for a null) can't be proved by a replay and keeps its drift as read (the safe
 * way round). Comments are found as JavaScript's (withoutComments): a regex literal holding a quote would mislead that;
 * initSchema has none, and the test that boots this checkout's db.ts holds the real file to what its boot runs.
 */
export function bootSteps(dbTs) {
    const start = dbTs.indexOf('export function initSchema');
    // The exec on a line of its own: the one every boot runs (a fresh install's, in its transaction, comes first).
    const blanked = start < 0 ? '' : withoutComments(dbTs.slice(start));
    const exec = start < 0 ? null : /^[ \t]+db\.exec\(schemaSql\);/m.exec(blanked);
    if (!exec) return { steps: [], unread: [], found: false };
    const text = blanked.slice(0, exec.index);
    const steps = []; // { table, def, at: where its statement or loop starts, k: its place in that loop }
    const spans = []; // the text each read form covers
    const unread = [];
    const STRING = /(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;
    const PAIR = /\[\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\s*,\s*(['"`])((?:(?!\3)[^\\]|\\.)*)\3\s*\]/g;
    // A loop's array holding anything but its literals (a name, a spread) runs steps this can't read: its table is unread.
    const whole = (array, form) => array.replace(form, '').replace(/[\s,]/g, '') === '';
    for (const m of text.matchAll(/db\.prepare\((['"`])ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN\s+((?:(?!\1)[^$\\])+)\1\s*\)/g)) {
        steps.push({ table: m[2].toLowerCase(), def: m[3], at: m.index, k: 0 });
        spans.push([m.index, m.index + m[0].length]);
    }
    for (const m of text.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+\[((?:(?!for\s*\()[\s\S])*?)\]\s*\)\s*\{\s*try\s*\{\s*db\.prepare\(`ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN\s+\$\{\1\}`\)/g)) {
        [...m[2].matchAll(STRING)].forEach((s, k) => steps.push({ table: m[3].toLowerCase(), def: s[2], at: m.index, k }));
        spans.push([m.index, m.index + m[0].length]);
        if (!whole(m[2], STRING)) unread.push(m[3].toLowerCase());
    }
    for (const m of text.matchAll(/for\s*\(\s*const\s+\[\s*(\w+)\s*,\s*(\w+)\s*\]\s+of\s+\[((?:(?!for\s*\()[\s\S])*?)\]\s*\)\s*\{\s*try\s*\{\s*db\.prepare\(`ALTER TABLE\s+\$\{\1\}\s+ADD COLUMN\s+\$\{\2\}`\)/g)) {
        [...m[3].matchAll(PAIR)].forEach((pair, k) => steps.push({ table: pair[2].toLowerCase(), def: pair[4], at: m.index, k }));
        spans.push([m.index, m.index + m[0].length]);
        if (!whole(m[3], PAIR)) unread.push(null);
    }
    steps.sort((a, b) => a.at - b.at || a.k - b.k);
    for (const m of text.matchAll(/\bALTER\s+TABLE\b/gi)) {
        if (spans.some(([from, to]) => m.index >= from && m.index < to)) continue;
        const named = /^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_$.])/i.exec(text.slice(m.index, m.index + 200));
        unread.push(named ? named[1].toLowerCase() : null);
    }
    return { steps: steps.map(({ table, def }) => ({ table, def })), unread, found: true };
}

/** What the check compares against, read from the checkout (or from the packed copy). */
export function readBuild({ schema, manifest, boot }) {
    const schemaSql = readFileSync(schema, 'utf8');
    const boots = bootSteps(readFileSync(boot, 'utf8'));
    return {
        schemaSql,
        schemaSha: createHash('sha256').update(schemaSql).digest('hex').slice(0, 12),
        kinds: manifestKinds(readFileSync(manifest, 'utf8')),
        bootSteps: boots.steps,
        bootUnread: boots.found ? boots.unread.length : -1,
        bootUnreadTables: boots.unread,
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
 * copied in as stored, then the boot's ADD COLUMNs run in db.ts's order, each on its own as initSchema runs them. SQLite
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
                scratch.exec(`ALTER TABLE ${quoteName(name)} ADD COLUMN ${s.def}`);
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
        for (const [key, f] of [...freshTables].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
            const h = hereTables.get(key);
            if (!h) continue;
            const kind = build.kinds[key] ?? 'not in the manifest';
            const freshShape = tableShape(fresh, f.name);
            let diffs = shapeDiffs(tableShape(db, h.name), freshShape);
            let replay = { added: [], refused: [], error: null };
            const steps = build.bootSteps.filter((s) => s.table === key);
            // An ALTER TABLE db.ts runs on it (or on a table it doesn't name) that the reader couldn't place in the boot's order.
            const unread = (build.bootUnreadTables ?? []).filter((t) => t === key || t === null).length;
            const unproved = diffs.length > 0 && unread > 0 ? unread : 0;
            if (diffs.length > 0 && steps.length > 0 && h.type === 'table' && unproved === 0) {
                // Only ever turns a drift into OK when the boot's steps, run on the table's own rows in the boot's order, give
                // schema.sql's shape; a step the rows refuse, or a replay that can't be made, leaves the drift as read.
                replay = replayBootSteps(Database, db, h.name, steps);
                if (replay.added.length > 0) diffs = shapeDiffs(replay.shape, freshShape);
            }
            let status = 'OK';
            let rows = null;
            // A refused step is never OK, whatever its column: the boot drops it without a word on this node.
            if (diffs.length > 0 || replay.refused.length > 0) {
                rows = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteName(h.name)}`).get().n;
                status = kind !== 'local' ? 'DRIFT-REPLICATED' : rows > 0 ? 'DRIFT-HAS-ROWS' : 'DRIFT-EMPTY-LOCAL';
            }
            results.push({ status, table: h.name, kind, rows, diffs, bootAdds: replay.added, bootRefused: replay.refused, replayError: replay.error, bootUnproved: unproved });
        }
        return {
            results,
            ok: results.every((r) => r.status === 'OK'),
            onlyInSchema: [...freshTables.keys()].filter((k) => !hereTables.has(k)).length,
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
    if (r.bootUnproved > 0) notes.push(`can't prove its boot: ${r.bootUnproved} ALTER TABLE in db.ts before the schema.sql exec not read in the boot's order, so the drift stands as read`);
    const boot = notes.length > 0 ? ` (${notes.join('; ')})` : '';
    if (r.status === 'OK') return `OK ${r.table} ${r.kind}${boot}`;
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
        out(`schema-drift: note: ${build.bootUnread < 0 ? "db.ts's initSchema was not found; a column a boot step adds reads as drift here" : `${build.bootUnread} ALTER TABLE in db.ts before the schema.sql exec not read; a table it names (every table, where it names none) can't be proved by its boot steps and keeps its drift as read`}`);
    }
    for (const r of result.results) out(formatResult(r));
    const drift = result.results.filter((r) => r.status !== 'OK').length;
    out(`schema-drift: ${result.results.length} tables compared, ${drift} drift; ${result.onlyInSchema} in schema.sql not in this database yet (the deploy makes them); ${result.onlyHere} here not in schema.sql (not compared)`);
    return result.ok ? 0 : 1;
}

// Runs as a command (a file, or a packed copy on stdin); imported by its test, it runs nothing.
const asCommand = PACKED !== null || process.argv[1] === '-' || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (asCommand) process.exitCode = main(process.argv.slice(2));
