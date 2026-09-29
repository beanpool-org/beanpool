/**
 * Reading a table a slice at a time, in a fixed order, from where the last slice ended (a keyset): a copy served in pages
 * (engine/copy-pages.ts) and its table hashes (engine/replica-hashes.ts) read the rows of one snapshot this way. Each slice
 * starts after the last row read, by the values of the order's columns in that row, so the order must be total: it ends
 * with the table's rowid, or its primary key for a table without one (rowTiebreak).
 */

import type Database from 'better-sqlite3';

/** A column as this code puts it into SQL: `rowid` bare, any other name quoted. */
export function sqlColumn(name: string): string {
    return name === 'rowid' ? 'rowid' : `"${name.replace(/"/g, '""')}"`;
}

/**
 * What makes the order of `table`'s rows total, after the columns `order` already names: its rowid, or, for a table without
 * one (WITHOUT ROWID), its primary key's columns, which SQLite holds NOT NULL there.
 */
export function rowTiebreak(conn: Database.Database, table: string, order: readonly string[] = []): string[] {
    let withoutRowid = false;
    try {
        withoutRowid = (conn.prepare('SELECT wr FROM pragma_table_list WHERE name = ?').get(table) as { wr: number } | undefined)?.wr === 1;
    } catch {
        // An SQLite older than pragma_table_list: every table this server makes has a rowid.
    }
    if (!withoutRowid) return order.includes('rowid') ? [] : ['rowid'];
    const key = (conn.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table) as { name: string; pk: number }[])
        .filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    return key.filter((c) => !order.includes(c));
}

/**
 * The rows after `last` in the order `order`, ascending, as SQLite sorts: NULL before any value. `last` holds the order's
 * columns' values in the last row read. With no NULL among them it is a row-value comparison, which an index on the order
 * serves; with one, the comparison is spelt out column by column, since a row value with a NULL compares as NULL.
 */
export function afterRow(order: readonly string[], last: readonly unknown[]): { sql: string; params: unknown[] } {
    const cols = order.map(sqlColumn);
    if (last.every((v) => v !== null && v !== undefined)) {
        return { sql: `(${cols.join(', ')}) > (${cols.map(() => '?').join(', ')})`, params: [...last] };
    }
    const params: unknown[] = [];
    const either: string[] = [];
    for (let i = 0; i < cols.length; i++) {
        const all: string[] = [];
        for (let j = 0; j < i; j++) {
            if (last[j] === null || last[j] === undefined) all.push(`${cols[j]} IS NULL`);
            else { all.push(`${cols[j]} = ?`); params.push(last[j]); }
        }
        if (last[i] === null || last[i] === undefined) all.push(`${cols[i]} IS NOT NULL`);
        else { all.push(`${cols[i]} > ?`); params.push(last[i]); }
        either.push(`(${all.join(' AND ')})`);
    }
    return { sql: `(${either.join(' OR ')})`, params };
}
