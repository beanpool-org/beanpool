/**
 * The plain tables on a standby: in-flight money and governance, its main server's rows verbatim (design
 * scratch/global-node/DESIGN-standby-takeover-gaps-opus.md G3, §4.1, §4.2; engine/replication-manifest.ts
 * PLAIN_TABLES_PAYLOAD). One generic path for every table the manifest marks `plain`, so the next table is one line there.
 *
 * The main server sends each table's rows `SELECT *` (engine sync.ts exportPlainTables): a delta the rows its watermark
 * moved past the cursor, a whole copy every row. Here each row is written as it is, the main server's stamp included, and
 * never judged by a stamp of this server's: the main server is a standby's only writer of these tables
 * (config/node-role.ts assertPlainTablesWritable), and the puller refuses a copy older than the last one. So a row that
 * differs in any column is the main server's newer one. A whole copy names every row the main server holds, and one here
 * it doesn't name is deleted. A row the main server deleted between two deltas comes as its tombstone (engine/sync.ts
 * applyTombstoneLocally, deletePlainRow).
 *
 * A copy never puts a name into SQL unchecked: only this table's own columns (PRAGMA table_info) are written. And one
 * bad value never wedges copying: a value this table's own rules refuse (its CHECKs and NOT NULLs, db/table-rules.ts) is
 * left out of the write, and a row its unique indexes refuse is tried again after the rest and, if still refused, left
 * out; each is reported, and the whole-copy check counts the rows (engine audit.ts getReplicaConsistency).
 */
import type Database from 'better-sqlite3';
import { db } from '../db/db.js';
import { RowRules } from '../db/table-rules.js';
import { PLAIN_TABLES, type PlainTable } from './replication-manifest.js';

export interface PlainImportResult {
    /** Rows written or deleted. */
    changes: number;
    /** Rows not written: malformed, refused by the table's rules whatever is left out, or by its unique indexes. */
    skipped: number;
    /**
     * `<table>:<key>.<column>` for each value this table's rules refuse, left out of its row's write (the row keeps what it
     * holds here, or a new row the column's default); `<table>:<key>` for a row not written at all.
     */
    leftOut: string[];
}

interface Shape {
    columns: string[];
    /** The primary key's columns, in its order. */
    key: string[];
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** This database's own columns and key for a table; null when it has no such table, or one with no key. */
function shapeOf(table: string): Shape | null {
    const info = db.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table) as { name: string; pk: number }[];
    const key = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    return info.length > 0 && key.length > 0 ? { columns: info.map((c) => c.name), key } : null;
}

/** A value SQLite stores as the main server held it: text, a finite number, or null. */
function isColumnValue(v: unknown): v is string | number | null {
    return v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A row's key as a tombstone of its table names it: the key's values joined with `|` (db.ts writeTombstone). */
export function plainRowKey(values: readonly unknown[]): string {
    return values.map((v) => String(v)).join('|');
}

/** A tombstone's row key as the key's values: one column's is the whole key, a compound one's split at `|`. */
function keyValues(shape: Shape, rowKey: string): string[] | null {
    if (shape.key.length === 1) return [rowKey];
    const parts = rowKey.split('|');
    return parts.length === shape.key.length ? parts : null;
}

function plainTable(name: string): { spec: PlainTable; shape: Shape } | null {
    const spec = PLAIN_TABLES.find((t) => t.table === name);
    const shape = spec ? shapeOf(spec.table) : null;
    return spec && shape ? { spec, shape } : null;
}

/**
 * The main server's delete of a plain table's row, from its tombstone: null when `table` is no plain table (the caller's
 * to handle), else whether a row went.
 */
export function deletePlainRow(table: string, rowKey: string): boolean | null {
    const t = plainTable(table);
    if (!t) return null;
    const key = keyValues(t.shape, rowKey);
    if (!key) return false;
    const where = t.shape.key.map((c) => `${q(c)} = ?`).join(' AND ');
    return db.prepare(`DELETE FROM ${q(t.spec.table)} WHERE ${where}`).run(...key).changes > 0;
}

/**
 * A plain table's row's stamp here, which a tombstone older than it leaves alone (a row the main server deleted and made
 * again): undefined when `table` is no plain table, null when there is no such row.
 */
export function plainRowStamp(table: string, rowKey: string): string | null | undefined {
    const t = plainTable(table);
    if (!t) return undefined;
    const key = keyValues(t.shape, rowKey);
    if (!key) return null;
    const where = t.shape.key.map((c) => `${q(c)} = ?`).join(' AND ');
    const row = db.prepare(`SELECT ${q(t.spec.watermark)} AS ts FROM ${q(t.spec.table)} WHERE ${where}`).get(...key) as { ts: unknown } | undefined;
    return typeof row?.ts === 'string' ? row.ts : null;
}

/** A write SQLite refused for one of the table's constraints (a unique index, most likely): the row, not the copy. */
function isConstraintError(e: unknown): boolean {
    return typeof (e as { code?: unknown })?.code === 'string' && (e as { code: string }).code.startsWith('SQLITE_CONSTRAINT');
}

/**
 * Every plain table the copy carries (`remote.plainTables`), inside the import's transaction, with the tables' touch
 * triggers set aside (engine/sync.ts IMPORT_KEEPS_STAMPS). A table the copy doesn't carry (a main server older than its
 * line in the manifest) is left as it is here. `whole`: the copy is a whole one (the puller's snapshot), so it names every
 * row of each table it carries.
 */
export function importPlainTables(incoming: unknown, whole: boolean): PlainImportResult {
    const result: PlainImportResult = { changes: 0, skipped: 0, leftOut: [] };
    if (!isPlainObject(incoming)) return result;
    for (const spec of PLAIN_TABLES) {
        const rows = incoming[spec.table];
        if (!Array.isArray(rows)) continue;
        const shape = shapeOf(spec.table);
        if (!shape) {
            console.warn(`[Sync] The copy carries ${spec.table}, which this database has no table with a key for: left out`);
            continue;
        }
        importTable(spec, shape, rows, whole, result);
    }
    return result;
}

function importTable(spec: PlainTable, shape: Shape, rows: unknown[], whole: boolean, result: PlainImportResult): void {
    const table = q(spec.table);
    // Only this table's own columns, and never one the manifest keeps off the path (a copy that names one anyway).
    const writable = new Set(shape.columns.filter((c) => !spec.except.includes(c)));
    const where = shape.key.map((c) => `${q(c)} = ?`).join(' AND ');
    const select = db.prepare(`SELECT * FROM ${table} WHERE ${where}`);
    const statements = new Map<string, Database.Statement>();
    const statement = (sql: string) => {
        let s = statements.get(sql);
        if (!s) statements.set(sql, s = db.prepare(sql));
        return s;
    };

    // The rows the copy names: each an object with a value for every column of the key.
    const named: { key: (string | number)[]; row: Record<string, unknown> }[] = [];
    for (const raw of rows) {
        const key = isPlainObject(raw) ? shape.key.map((c) => raw[c]) : [];
        if (!isPlainObject(raw) || key.some((v) => v === null || !isColumnValue(v))) {
            result.skipped++;
            continue;
        }
        named.push({ key: key as (string | number)[], row: raw });
    }

    // A whole copy's deletes first: a row here the main server doesn't hold can't then stand in a unique index's way of
    // one it does (a pending request here it has since answered and a new one it holds).
    if (whole) {
        const keep = new Set(named.map((n) => plainRowKey(n.key)));
        const drop = db.prepare(`DELETE FROM ${table} WHERE ${where}`);
        for (const here of db.prepare(`SELECT ${shape.key.map(q).join(', ')} FROM ${table}`).raw().all() as unknown[][]) {
            if (!keep.has(plainRowKey(here))) result.changes += drop.run(...here).changes;
        }
    }

    const rules = new RowRules(db, spec.table);
    try {
        const write = (key: (string | number)[], row: Record<string, unknown>): void => {
            const label = `${spec.table}:${plainRowKey(key).slice(0, 40)}`;
            const offered = Object.keys(row).filter((c) => writable.has(c) && isColumnValue(row[c])).sort();
            for (const c of Object.keys(row)) {
                if (writable.has(c) && row[c] !== undefined && !isColumnValue(row[c])) result.leftOut.push(`${label}.${c}`);
            }
            const existing = select.get(...key) as Record<string, unknown> | undefined;
            if (existing && offered.every((c) => existing[c] === row[c])) return; // already the main server's
            const admitted = rules.admit(offered, row, existing);
            if (!admitted || admitted.leftOut.some((c) => shape.key.includes(c))) {
                result.skipped++;
                result.leftOut.push(label);
                console.warn(`[Sync] A row of ${spec.table} this table's rules refuse whatever is left out, not written: ${label}`);
                return;
            }
            for (const c of admitted.leftOut) result.leftOut.push(`${label}.${c}`);
            const columns = admitted.columns;
            // A row that differs only in a value left out is written once, not again with every copy.
            if (existing && columns.every((c) => existing[c] === row[c])) return;
            const values = columns.map((c) => row[c] as string | number | null);
            if (!existing) {
                statement(`INSERT INTO ${table} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
            } else {
                statement(`UPDATE ${table} SET ${columns.map((c) => `${q(c)} = ?`).join(', ')} WHERE ${where}`).run(...values, ...key);
            }
            result.changes++;
        };

        // In the order sent, the main server's order of writes. A row a unique index refuses is tried again once the rest
        // are in, which may have moved the row in its way (a Decision closed before its author's next one opened); one
        // still refused when a pass writes nothing more is left out, never the copy.
        let pending = named;
        while (pending.length > 0) {
            const refused: typeof pending = [];
            for (const n of pending) {
                try {
                    write(n.key, n.row);
                } catch (e) {
                    if (!isConstraintError(e)) throw e;
                    refused.push(n);
                }
            }
            if (refused.length === pending.length) {
                for (const n of refused) {
                    result.skipped++;
                    result.leftOut.push(`${spec.table}:${plainRowKey(n.key).slice(0, 40)}`);
                }
                console.warn(`[Sync] ${refused.length} row(s) of ${spec.table} this table's unique indexes refuse, not written: `
                    + refused.slice(0, 3).map((n) => plainRowKey(n.key).slice(0, 24)).join(', '));
                break;
            }
            pending = refused;
        }
    } finally {
        rules.close();
    }
}
