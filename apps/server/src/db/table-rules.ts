/**
 * A table's CHECK rules, read from its own CREATE TABLE text, never guessed: this database's (sqlite_master), the rules its
 * table enforces; or schema.sql's, the rules a fresh install's table has.
 *
 * Why both: a node whose table predates a column got it from db.ts's `ALTER TABLE … ADD COLUMN`, often with no CHECK, so
 * its rows can hold a value a fresh table refuses (members.goal_amount below 0 on a community older than the enterprise
 * unification). A standby copies such a row into a table that refuses it (engine/sync.ts writeMemberStanding asks
 * RowRules), and a node brings its own rows into the fresh rules once (db.ts bringMembersToSchemaRules).
 */
import type Database from 'better-sqlite3';

export interface TableRule {
    /** The rule's expression, SQL over the table's columns, with its comments taken out. */
    expr: string;
    /** The table's columns it names, as the table spells them. */
    columns: string[];
}

/** The index just past a comment or a quoted token that starts at `i`, or `i` itself when none does. */
function skipToken(sql: string, i: number): number {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '-' && n === '-') {
        const end = sql.indexOf('\n', i);
        return end < 0 ? sql.length : end + 1;
    }
    if (c === '/' && n === '*') {
        const end = sql.indexOf('*/', i + 2);
        return end < 0 ? sql.length : end + 2;
    }
    const close = c === "'" ? "'" : c === '"' ? '"' : c === '`' ? '`' : c === '[' ? ']' : null;
    if (!close) return i;
    for (let j = i + 1; ;) {
        const end = sql.indexOf(close, j);
        if (end < 0) return sql.length;
        if (close !== ']' && sql[end + 1] === close) { j = end + 2; continue; } // a doubled quote inside
        return end + 1;
    }
}

/** The index of the `)` that closes the `(` at `open`, skipping comments and quoted tokens; -1 when none does. */
function closingParen(sql: string, open: number): number {
    let depth = 0;
    for (let i = open; i < sql.length;) {
        const past = skipToken(sql, i);
        if (past !== i) { i = past; continue; }
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')' && --depth === 0) return i;
        i++;
    }
    return -1;
}

/** The text with every comment turned into a space, so it can be put inside other SQL on one line. */
function withoutComments(sql: string): string {
    let out = '';
    for (let i = 0; i < sql.length;) {
        const past = skipToken(sql, i);
        if (past === i) { out += sql[i++]; continue; }
        out += sql[i] === '-' || sql[i] === '/' ? ' ' : sql.slice(i, past);
        i = past;
    }
    return out;
}

const WORD_START = /[A-Za-z_]/;
const WORD = /[A-Za-z0-9_$]/;

/** The columns of `columns` an expression names: bare or quoted identifiers, never a word inside a string literal. */
function namedColumns(expr: string, columns: readonly string[]): string[] {
    const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]));
    const found = new Set<string>();
    const note = (name: string) => { const c = byLower.get(name.toLowerCase()); if (c) found.add(c); };
    for (let i = 0; i < expr.length;) {
        const c = expr[i];
        if (c === "'") { i = skipToken(expr, i); continue; }
        if (c === '"' || c === '`' || c === '[') {
            const past = skipToken(expr, i);
            const quote = c === '[' ? ']' : c;
            note(expr.slice(i + 1, past - 1).split(quote + quote).join(quote));
            i = past;
            continue;
        }
        if (WORD_START.test(c) || /[0-9]/.test(c)) {
            let j = i + 1;
            while (j < expr.length && WORD.test(expr[j])) j++;
            if (WORD_START.test(c)) note(expr.slice(i, j));
            i = j;
            continue;
        }
        i++;
    }
    return [...found];
}

/** The body of the first `CREATE TABLE [IF NOT EXISTS] <table> (…)` in `sql` (schema.sql's text), or null. */
export function createTableText(sql: string, table: string): string | null {
    const head = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["\`\\[]?${table}["\`\\]]?\\s*\\(`, 'i');
    for (let i = 0; i < sql.length;) {
        const past = skipToken(sql, i);
        if (past !== i) { i = past; continue; }
        if ((sql[i] !== 'C' && sql[i] !== 'c') || (i > 0 && WORD.test(sql[i - 1]))) { i++; continue; }
        const m = head.exec(sql.slice(i, i + 200));
        if (m && m.index === 0) {
            const open = i + m[0].length - 1;
            const close = closingParen(sql, open);
            return close < 0 ? null : sql.slice(i, close + 1);
        }
        i++;
    }
    return null;
}

/**
 * Every CHECK in a CREATE TABLE text, a column's own or the table's, with the columns it names. A CHECK that names none of
 * `columns` is left out: nothing a row holds can break it.
 */
export function checkRules(createSql: string, columns: readonly string[]): TableRule[] {
    const rules: TableRule[] = [];
    for (let i = 0; i < createSql.length;) {
        const past = skipToken(createSql, i);
        if (past !== i) { i = past; continue; }
        const atWord = WORD_START.test(createSql[i]) && (i === 0 || !WORD.test(createSql[i - 1]));
        if (!atWord) { i++; continue; }
        let j = i + 1;
        while (j < createSql.length && WORD.test(createSql[j])) j++;
        if (createSql.slice(i, j).toUpperCase() !== 'CHECK') { i = j; continue; }
        let open = j;
        for (;;) { // spaces and comments between CHECK and its (
            const skipped = skipToken(createSql, open);
            if (skipped !== open) { open = skipped; continue; }
            if (/\s/.test(createSql[open] ?? '')) { open++; continue; }
            break;
        }
        if (createSql[open] !== '(') { i = j; continue; }
        const close = closingParen(createSql, open);
        if (close < 0) break;
        const expr = withoutComments(createSql.slice(open + 1, close)).replace(/\s+/g, ' ').trim();
        const named = namedColumns(expr, columns);
        if (named.length > 0) rules.push({ expr, columns: named });
        i = close + 1;
    }
    return rules;
}

/** The SQL that says which rules a row breaks: per rule, 1 when it evaluates to 0 (SQLite's CHECK: NULL passes). */
export function brokenRulesSql(rules: readonly TableRule[]): string {
    return rules.map((r, n) => `COALESCE(CAST((${r.expr}) AS NUMERIC) = 0, 0) AS "r${n}"`).join(', ');
}

const quoteName = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * This database's own rules for one table's rows (its CHECKs and NOT NULLs), asked of a row before it is written: which of
 * the values it would write break one. Judged in a TEMP table with the same columns, types and defaults and no rules of its
 * own, so each value is stored with the table's own type affinity before the rule reads it, as the table would store it.
 * For an import's transaction: `open` in it, `close` before it ends.
 */
export class RowRules {
    private readonly rules: TableRule[];
    private readonly ruled: Set<string>;
    private readonly probe: string;
    private readonly inserts = new Map<string, Database.Statement>();
    private judge: Database.Statement | null = null;
    private clear: Database.Statement | null = null;

    constructor(private readonly db: Database.Database, private readonly table: string) {
        const info = db.prepare('SELECT name, type, "notnull" AS not_null, dflt_value FROM pragma_table_info(?)').all(table) as
            { name: string; type: string; not_null: number; dflt_value: string | null }[];
        const createSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string } | undefined)?.sql ?? '';
        const columns = info.map((c) => c.name);
        this.rules = [
            ...checkRules(createSql, columns),
            ...info.filter((c) => c.not_null).map((c) => ({ expr: `${quoteName(c.name)} IS NOT NULL`, columns: [c.name] })),
        ];
        this.ruled = new Set(this.rules.flatMap((r) => r.columns));
        this.probe = `temp.${quoteName(`${table}_rules_probe`)}`;
        const defs = info.filter((c) => this.ruled.has(c.name))
            .map((c) => `${quoteName(c.name)} ${c.type || ''}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ''}`);
        this.db.exec(`DROP TABLE IF EXISTS ${this.probe}`);
        if (defs.length > 0) {
            this.db.exec(`CREATE TEMP TABLE ${quoteName(`${table}_rules_probe`)} (${defs.join(', ')})`);
            this.judge = this.db.prepare(`SELECT ${brokenRulesSql(this.rules)} FROM ${this.probe}`);
            this.clear = this.db.prepare(`DELETE FROM ${this.probe}`);
        }
    }

    /** Drops the probe table. */
    close(): void {
        this.judge = null;
        this.clear = null;
        this.inserts.clear();
        this.db.exec(`DROP TABLE IF EXISTS ${this.probe}`);
    }

    /** The rules a row would break, holding `values` for the columns in `writing` and `existing`'s (or the default) for the rest. */
    private broken(writing: ReadonlySet<string>, values: Record<string, unknown>, existing: Record<string, unknown> | undefined): TableRule[] {
        if (!this.judge || !this.clear) return [];
        const cols: string[] = [];
        const args: unknown[] = [];
        for (const c of this.ruled) {
            if (writing.has(c)) { cols.push(c); args.push(values[c]); } else if (existing) { cols.push(c); args.push(existing[c]); }
        }
        const sql = cols.length > 0
            ? `INSERT INTO ${this.probe} (${cols.map(quoteName).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
            : `INSERT INTO ${this.probe} DEFAULT VALUES`;
        let insert = this.inserts.get(sql);
        if (!insert) this.inserts.set(sql, insert = this.db.prepare(sql));
        insert.run(...args);
        const flags = this.judge.get() as Record<string, number>;
        this.clear.run();
        return this.rules.filter((_r, n) => flags[`r${n}`] === 1);
    }

    /**
     * The columns of `write` this row may be written with: a value that would break one of the table's rules is left out
     * (the row keeps what it holds, or a new row the column's default), and named in `leftOut`. Null when the row breaks a
     * rule whatever is left out (a new row with no value for a NOT NULL column that has no default): it can't be written.
     */
    admit(write: readonly string[], values: Record<string, unknown>, existing: Record<string, unknown> | undefined): { columns: string[]; leftOut: string[] } | null {
        if (existing && !write.some((c) => this.ruled.has(c))) return { columns: [...write], leftOut: [] };
        const writing = new Set(write);
        const leftOut: string[] = [];
        for (let round = 0; round <= this.rules.length; round++) {
            const broken = this.broken(writing, values, existing);
            if (broken.length === 0) return { columns: write.filter((c) => writing.has(c)), leftOut };
            const offenders = [...new Set(broken.flatMap((r) => r.columns))].filter((c) => writing.has(c));
            if (offenders.length === 0) return null;
            for (const c of offenders) { writing.delete(c); leftOut.push(c); }
        }
        return null;
    }
}
