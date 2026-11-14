/**
 * What a standby's whole copy is checked against, table by table (design scratch/global-node/DESIGN-standby-takeover-gaps-
 * opus.md §2 G8): each copied table's row count and a hash of its rows, over the columns the replication manifest says a
 * standby holds with the main server's value (engine/replication-manifest.ts `columns`). The main server sends its own with
 * each whole copy (routes/backup.ts, signed with the rest); the standby works out the same on its copy after importing it
 * (services/backup-puller.ts checkWholeCopy). Equal on both, that table is the main server's, row for row.
 *
 * Only what the manifest says is copied today: a column main drops (an `except` with a gap) differs on every standby until
 * its fix PR moves it into `columns`, and would make every copy read as wrong. That PR's move brings it in here too.
 *
 * Nothing here is edited for a new table, column, row rule or boot stamp (DECISION-table-hashes-version, 15 Nov 2026): each
 * table's hash carries the fingerprint of how it was made (`d`), and each payload the fingerprint of the definitions it was
 * made from (`def`), and compareTableHashes reads them. What an older importer drops of a new table is said in its
 * manifest entry (engine/replication-manifest.ts), beside the REPLICA_FORMAT reasoning it belongs to.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { db } from '../db/db.js';
import { TABLES, BOOT_STAMPED, travellingRows } from './replication-manifest.js';
import { afterRow, rowBytes, rowTiebreak, sqlColumn } from './keyset.js';

export interface TableHash {
    rows: number;
    /** sha256, hex, of the table's rows in its copied columns, in key order. */
    hash: string;
    /**
     * The fingerprint of how this table was hashed on the server that hashed it (16 hex of sha256): the table, the select
     * list with its boot-stamp cases, the row rule and the order, as tableHasher runs them on that database. Equal on two
     * servers, they hashed the table the same way, by construction, so its count and hash are compared.
     */
    d: string;
}

/**
 * How the hashes are made, as a payload names it: the payload's shape and the bytes a row is turned into (rowLine), nothing
 * else. A table, a column, a row rule or a boot stamp changes no `v`: each table carries its own recipe's fingerprint (`d`),
 * and the payload the fingerprint of the definitions it was made from (`def`). Raise it ('d2', …) only when rowLine's bytes
 * or the payload's shape change: test-replica-hashes pins golden rows for each `v`. A release that reads another `v` (a
 * number, before this one) reads none of the hashes, and gives no content verdict; no conversion code reads the old shape.
 */
export const TABLE_HASHES_VERSION = 'd1';

/** What the main server sends with a whole copy (SyncPayload `tableHashes`). */
export interface TableHashes {
    v: typeof TABLE_HASHES_VERSION;
    /** The definitions the hashes were made from, as that server's code holds them (definitionFingerprint). */
    def: string;
    tables: Record<string, TableHash>;
}

/**
 * Copied tables left out, and why. Each server prunes its own tombstones on its own daily timer (db/db.ts
 * pruneTombstones), so for up to a day one holds rows the other has dropped; a tombstone a copy failed to apply shows up
 * anyway as a row still there in the table it names.
 */
export const NOT_HASHED: Record<string, string> = {
    tombstones: "each server prunes its own on its own daily timer, so they differ for up to a day on a healthy standby",
};

/**
 * Copied columns left out, and why: each server makes its own value from the row's other columns, on its own schedule, so
 * a healthy standby differs there for a while, and a force-resync would mend nothing for long.
 */
export const COLUMNS_NOT_HASHED: Record<string, Record<string, string>> = {
    posts: {
        search_keywords: "this server's own search index: a linked community's listing is cached with none, and each server's "
            + 'boot fills them in (state-engine.ts backfillSearchKeywords), so a standby restarted on its own holds them first',
    },
};

const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
/** 16 hex of sha256 over a value's JSON: a recipe's `d`, the definitions' `def`. */
const fingerprint = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const FINGERPRINT = /^[0-9a-f]{16}$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The tables whose hashes are made: every copied one, but those NOT_HASHED. */
function isHashed(table: string): boolean {
    const entry = TABLES[table];
    return !!entry && (entry.kind === 'replicated' || entry.kind === 'replicated-except') && !NOT_HASHED[table];
}

/**
 * The definitions every table's hash is made from, as this server's code holds them: each hashed table's manifest columns,
 * key, row rule and boot stamps, and the tables and columns left out (NOT_HASHED, COLUMNS_NOT_HASHED). From code alone,
 * never the database: two servers with equal ones run the same definitions, so a table one of them hashes another way, or
 * alone, is that server's schema (compareTableHashes: drift).
 */
export function definitionFingerprint(): string {
    const tables = Object.keys(TABLES).filter(isHashed).sort().map((table) => {
        const entry = TABLES[table] as Extract<(typeof TABLES)[string], { columns: string[] }>;
        const stamps = BOOT_STAMPED.filter((b) => b.table === table).map((b) => [b.column, b.where]);
        return [table, entry.columns, entry.key ?? null, travellingRows(table), stamps];
    });
    const columnsLeftOut = Object.keys(COLUMNS_NOT_HASHED).sort().map((t) => [t, Object.keys(COLUMNS_NOT_HASHED[t]).sort()]);
    return fingerprint([tables, Object.keys(NOT_HASHED).sort(), columnsLeftOut]);
}

export interface HashOptions {
    /** Only these tables. */
    only?: readonly string[];
    /**
     * Listing photos left out of `post_photos`, as `post_id|order_num`: the ones the main server could not read from its own
     * storage, which its copy leaves out and names (SyncPayload `photosOmitted`, engine/sync.ts restoreInlinePhotos). No
     * copy brings them, and a standby may or may not hold its own, so both servers hash the rest without them.
     */
    photosLeftOut?: ReadonlySet<string>;
    /**
     * The values of members rows a standby's import left out because its own table refuses them (engine/sync.ts
     * writeMemberStanding), as the copy names them: the member's `public_key` → column → the main server's value. Hashed as
     * the copy's, so both servers hash what the import copied verbatim: the whole-copy check reports the values left out
     * on their own, and a members row that differs anywhere else still differs here.
     */
    membersLeftOut?: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/**
 * The columns selected for one table's hash: a boot-stamped row's stamp (the manifest's BOOT_STAMPED: every server writes it
 * again at its own boot) as a placeholder, every other column as it is.
 */
function selectOf(table: string, columns: string[]): string {
    return columns.map((c) => {
        const stamped = BOOT_STAMPED.filter((b) => b.table === table && b.column === c);
        return stamped.length === 0 ? q(c)
            : `CASE WHEN ${stamped.map((b) => `(${b.where})`).join(' OR ')} THEN '<stamped at boot>' ELSE ${q(c)} END`;
    }).join(', ');
}

/**
 * Every copied table this server has, with the columns hashed, the order its rows are hashed in, the condition on the rows
 * that travel when not all do (the manifest's RowRule): the rest are hashed on neither server, the select list, and the
 * fingerprint of all four with the table's name (TableHash `d`).
 */
export function hashedTables(conn: Database.Database): { table: string; columns: string[]; order: string[]; where: string | null; select: string; d: string }[] {
    const out: { table: string; columns: string[]; order: string[]; where: string | null; select: string; d: string }[] = [];
    for (const [table, entry] of Object.entries(TABLES)) {
        if ((entry.kind !== 'replicated' && entry.kind !== 'replicated-except') || NOT_HASHED[table]) continue;
        const info = conn.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table) as { name: string; pk: number }[];
        if (info.length === 0) continue;
        const have = new Set(info.map((c) => c.name));
        const columns = entry.columns.filter((c) => have.has(c) && !COLUMNS_NOT_HASHED[table]?.[c]);
        const key = entry.key ?? info.filter((c) => c.pk > 0).sort((x, y) => x.pk - y.pk).map((c) => c.name);
        // By its key when the key is among the columns hashed (a total order); otherwise by every column hashed, so two
        // servers' rows come in the same order whatever local ids they carry.
        const order = key.length > 0 && key.every((c) => columns.includes(c)) ? key : columns;
        const where = travellingRows(table);
        const select = selectOf(table, columns);
        out.push({ table, columns, order, where, select, d: fingerprint([table, select, where, order]) });
    }
    return out;
}

/**
 * One row as its table's hash takes it: its values as JSON, a blob as x'<hex>' and a bigint as its digits, and a newline.
 * Part of TABLE_HASHES_VERSION: a change here is a new `v`, and test-replica-hashes's golden rows say so.
 */
export function rowLine(row: readonly unknown[]): string {
    return `${JSON.stringify(row.map((v) => (Buffer.isBuffer(v) ? `x'${v.toString('hex')}'` : typeof v === 'bigint' ? v.toString() : v)))}\n`;
}

/** How one table's rows are hashed: what is done with each row, and the table's count and hash once every row went in, in its order. */
function tableHasher(table: string, columns: string[], d: string, opts: HashOptions): { add: (row: unknown[]) => void; done: () => TableHash } {
    const leftOut = table === 'post_photos' && opts.photosLeftOut && opts.photosLeftOut.size > 0 ? opts.photosLeftOut : null;
    const [postAt, orderAt] = [columns.indexOf('post_id'), columns.indexOf('order_num')];
    const asCopied = table === 'members' && opts.membersLeftOut && opts.membersLeftOut.size > 0 ? opts.membersLeftOut : null;
    const keyAt = columns.indexOf('public_key');
    const h = crypto.createHash('sha256');
    let rows = 0;
    return {
        add: (row) => {
            if (leftOut && postAt >= 0 && orderAt >= 0 && leftOut.has(`${row[postAt]}|${row[orderAt]}`)) return;
            const copied = asCopied && keyAt >= 0 ? asCopied.get(row[keyAt] as string) : undefined;
            if (copied) {
                for (const [c, v] of Object.entries(copied)) {
                    const at = columns.indexOf(c);
                    if (at >= 0) row[at] = v;
                }
            }
            h.update(rowLine(row));
            rows++;
        },
        done: () => ({ rows, hash: h.digest('hex'), d }),
    };
}

/**
 * This server's copied tables, each as a row count and a hash, on `conn` (this server's database unless another
 * connection is given). Only reads, and nothing else runs between them: better-sqlite3 is synchronous.
 */
export function tableContentHashes(opts: HashOptions = {}, conn: Database.Database = db): TableHashes {
    const tables: Record<string, TableHash> = {};
    for (const { table, columns, order, where, select, d } of hashedTables(conn)) {
        if (opts.only && !opts.only.includes(table)) continue;
        const hasher = tableHasher(table, columns, d, opts);
        const held = where ? ` WHERE (${where})` : '';
        for (const row of conn.prepare(`SELECT ${select} FROM ${q(table)}${held} ORDER BY ${order.map(q).join(', ')}`).raw().iterate() as Iterable<unknown[]>) {
            hasher.add(row);
        }
        tables[table] = hasher.done();
    }
    return { v: TABLE_HASHES_VERSION, def: definitionFingerprint(), tables };
}

/**
 * The same hashes as tableContentHashes, on `conn`, read `sliceRows` rows at a time in the same order (a keyset, with the
 * table's rowid last so the order is total: rows equal in every column ordered on are equal in every column hashed, or
 * their key, which is among those, tells them apart), awaiting `pause()` between slices: a copy served in pages makes them
 * on its snapshot while it serves pages (engine/copy-pages.ts), so no single step holds the event loop for a whole table.
 * A slice ends at `sliceRows` rows or once its rows add up to `sliceBytes` (keyset.ts rowBytes), whichever first, and never
 * before its first row: rows are read one at a time and hashed as they are read, so a slice of wide rows holds one row in
 * memory and the event loop for about `sliceBytes` of hashing. `except`: tables left for later. Throws what a read
 * throws, and stops when `stopped()` says so. The rowid it walks by is no part of a table's `d`: it orders nothing the
 * hash can tell apart.
 */
export async function tableContentHashesInSlices(
    conn: Database.Database,
    opts: HashOptions & { except?: readonly string[] },
    pace: { sliceRows: number; sliceBytes: number; pause: () => Promise<void>; stopped: () => boolean },
): Promise<TableHashes> {
    const tables: Record<string, TableHash> = {};
    for (const { table, columns, order, where, select, d } of hashedTables(conn)) {
        if ((opts.only && !opts.only.includes(table)) || opts.except?.includes(table)) continue;
        const hasher = tableHasher(table, columns, d, opts);
        const walk = [...order, ...rowTiebreak(conn, table, order)];
        const extra = walk.map((c) => sqlColumn(c)).join(', ');
        let last: unknown[] | null = null;
        for (;;) {
            if (pace.stopped()) throw new Error('stopped');
            const after = last ? afterRow(walk, last) : null;
            const conditions = [where ? `(${where})` : null, after?.sql ?? null].filter((c): c is string => c !== null);
            const read = conn.prepare(`SELECT ${select}, ${extra} FROM ${q(table)}${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''}`
                + ` ORDER BY ${walk.map((c) => sqlColumn(c)).join(', ')} LIMIT ?`).raw().iterate(...(after?.params ?? []), pace.sliceRows) as Iterable<unknown[]>;
            let [rows, bytes, cut] = [0, 0, false];
            for (const row of read) {
                last = row.slice(columns.length);
                hasher.add(row.slice(0, columns.length));
                rows++;
                bytes += rowBytes(row);
                // Leaving the loop closes the statement, before the pause lets anything else read on this connection.
                if (rows >= pace.sliceRows || bytes >= pace.sliceBytes) { cut = true; break; }
            }
            if (!cut) break;
            await pace.pause();
        }
        tables[table] = hasher.done();
    }
    return { v: TABLE_HASHES_VERSION, def: definitionFingerprint(), tables };
}

/**
 * A main server's `tableHashes` as this server can use them, or null: made another way (another `v`: an older release's
 * number, with no `d`), or not the shape they have.
 */
export function readTableHashes(raw: unknown): TableHashes | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as { v?: unknown; def?: unknown; tables?: unknown };
    if (r.v !== TABLE_HASHES_VERSION || typeof r.def !== 'string' || !FINGERPRINT.test(r.def)) return null;
    if (!r.tables || typeof r.tables !== 'object' || Array.isArray(r.tables)) return null;
    const tables: Record<string, TableHash> = {};
    for (const [table, th] of Object.entries(r.tables as Record<string, unknown>)) {
        const t = th as { rows?: unknown; hash?: unknown; d?: unknown } | null;
        if (!TABLE_NAME.test(table) || !t || !Number.isInteger(t.rows) || typeof t.hash !== 'string' || !/^[0-9a-f]{64}$/.test(t.hash)
            || typeof t.d !== 'string' || !FINGERPRINT.test(t.d)) return null;
        tables[table] = { rows: t.rows as number, hash: t.hash, d: t.d };
    }
    return { v: TABLE_HASHES_VERSION, def: r.def, tables };
}

/** What compareTableHashes found, table by table: each table either server hashes is in exactly one of the first, third and fourth lists. */
export interface HashComparison {
    /** Hashed the same way on both servers (equal `d`), so compared, row for row. */
    compared: string[];
    /** Of those, each whose count or content differs: a copy gone wrong, which the held force-resync mends. */
    differing: { table: string; rows: number; theirRows: number }[];
    /**
     * The same definitions on both (equal `def`), and the table hashed another way on one, or on one alone: one server's
     * schema isn't its code's (a migration that failed). Not exact, named, and no force-resync: a copy brings rows, never a
     * schema.
     */
    drift: string[];
    /** Other definitions (another release on one side), and the table hashed another way, or on one alone: not compared. */
    otherRelease: string[];
    /** Every table either server hashes was compared, and is equal. */
    exact: boolean;
}

/**
 * The main server's table hashes against this server's (`mine`, made over the same rows: the photos the copy left out, and
 * the members values this server's import left out, as the copy's): the one reading of them, for every check that reads
 * them (services/backup-puller.ts checkWholeCopy and leftOutTablesCurrent, services/stager.ts's closing check). `only`:
 * just these tables, on both sides.
 *
 *   per table                                  same `def`                     other `def` (a rollout)
 *   `d` equal, rows and hash equal             compared                       compared
 *   `d` equal, rows or hash differ             differing (force-resync)       differing (force-resync)
 *   `d` differs, or on one side alone          drift (no force-resync)        otherRelease (not compared)
 */
export function compareTableHashes(theirs: TableHashes, mine: TableHashes, only?: readonly string[]): HashComparison {
    const sameDefinitions = theirs.def === mine.def;
    const out: HashComparison = { compared: [], differing: [], drift: [], otherRelease: [], exact: false };
    const names = new Set([...Object.keys(theirs.tables), ...Object.keys(mine.tables)]);
    for (const table of [...names].filter((t) => !only || only.includes(t)).sort()) {
        const t = Object.hasOwn(theirs.tables, table) ? theirs.tables[table] : undefined;
        const m = Object.hasOwn(mine.tables, table) ? mine.tables[table] : undefined;
        if (t && m && t.d === m.d) {
            out.compared.push(table);
            if (m.rows !== t.rows || m.hash !== t.hash) out.differing.push({ table, rows: m.rows, theirRows: t.rows });
        } else {
            (sameDefinitions ? out.drift : out.otherRelease).push(table);
        }
    }
    out.exact = out.differing.length === 0 && out.drift.length === 0 && out.otherRelease.length === 0;
    return out;
}
