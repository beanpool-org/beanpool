/**
 * What a standby's whole copy is checked against, table by table (design scratch/global-node/DESIGN-standby-takeover-gaps-
 * opus.md §2 G8): each copied table's row count and a hash of its rows, over the columns the replication manifest says a
 * standby holds with the main server's value (engine/replication-manifest.ts `columns`). The main server sends its own with
 * each whole copy (routes/backup.ts, signed with the rest); the standby works out the same on its copy after importing it
 * (services/backup-puller.ts checkWholeCopy). Equal on both, that table is the main server's, row for row.
 *
 * Only what the manifest says is copied today: a column main drops (an `except` with a gap) differs on every standby until
 * its fix PR moves it into `columns`, and would make every copy read as wrong. That PR's move brings it in here too.
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
}

/** What the main server sends with a whole copy (SyncPayload `tableHashes`). */
export interface TableHashes {
    /** How the hashes are made: raise it when that changes, and a standby compares none it doesn't make the same way. */
    v: number;
    tables: Record<string, TableHash>;
}

export const TABLE_HASHES_VERSION = 1;

/**
 * Copied tables left out, and why. Each server prunes its own tombstones on its own daily timer (connector-manager.ts
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
 * Every copied table this server has, with the columns hashed, the order its rows are hashed in, and the condition on the
 * rows that travel when not all do (the manifest's RowRule): the rest are hashed on neither server.
 */
function hashedTables(conn: Database.Database): { table: string; columns: string[]; order: string[]; where: string | null }[] {
    const out: { table: string; columns: string[]; order: string[]; where: string | null }[] = [];
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
        out.push({ table, columns, order, where: travellingRows(table) });
    }
    return out;
}

/**
 * How one table's rows are hashed: the columns selected (a boot-stamped row's stamp, the manifest's BOOT_STAMPED: every
 * server writes it again at its own boot, as a placeholder), what is done with each row, and the table's count and hash
 * once every row went in, in its order.
 */
function tableHasher(table: string, columns: string[], opts: HashOptions): { select: string; add: (row: unknown[]) => void; done: () => TableHash } {
    const leftOut = table === 'post_photos' && opts.photosLeftOut && opts.photosLeftOut.size > 0 ? opts.photosLeftOut : null;
    const [postAt, orderAt] = [columns.indexOf('post_id'), columns.indexOf('order_num')];
    const asCopied = table === 'members' && opts.membersLeftOut && opts.membersLeftOut.size > 0 ? opts.membersLeftOut : null;
    const keyAt = columns.indexOf('public_key');
    const select = columns.map((c) => {
        const stamped = BOOT_STAMPED.filter((b) => b.table === table && b.column === c);
        return stamped.length === 0 ? q(c)
            : `CASE WHEN ${stamped.map((b) => `(${b.where})`).join(' OR ')} THEN '<stamped at boot>' ELSE ${q(c)} END`;
    }).join(', ');
    const h = crypto.createHash('sha256');
    let rows = 0;
    return {
        select,
        add: (row) => {
            if (leftOut && postAt >= 0 && orderAt >= 0 && leftOut.has(`${row[postAt]}|${row[orderAt]}`)) return;
            const copied = asCopied && keyAt >= 0 ? asCopied.get(row[keyAt] as string) : undefined;
            if (copied) {
                for (const [c, v] of Object.entries(copied)) {
                    const at = columns.indexOf(c);
                    if (at >= 0) row[at] = v;
                }
            }
            h.update(JSON.stringify(row.map((v) => (Buffer.isBuffer(v) ? `x'${v.toString('hex')}'` : typeof v === 'bigint' ? v.toString() : v))));
            h.update('\n');
            rows++;
        },
        done: () => ({ rows, hash: h.digest('hex') }),
    };
}

/**
 * This server's copied tables, each as a row count and a hash, on `conn` (this server's database unless another
 * connection is given). Only reads, and nothing else runs between them: better-sqlite3 is synchronous.
 */
export function tableContentHashes(opts: HashOptions = {}, conn: Database.Database = db): TableHashes {
    const tables: Record<string, TableHash> = {};
    for (const { table, columns, order, where } of hashedTables(conn)) {
        if (opts.only && !opts.only.includes(table)) continue;
        const hasher = tableHasher(table, columns, opts);
        const held = where ? ` WHERE (${where})` : '';
        for (const row of conn.prepare(`SELECT ${hasher.select} FROM ${q(table)}${held} ORDER BY ${order.map(q).join(', ')}`).raw().iterate() as Iterable<unknown[]>) {
            hasher.add(row);
        }
        tables[table] = hasher.done();
    }
    return { v: TABLE_HASHES_VERSION, tables };
}

/**
 * The same hashes as tableContentHashes, on `conn`, read `sliceRows` rows at a time in the same order (a keyset, with the
 * table's rowid last so the order is total: rows equal in every column ordered on are equal in every column hashed, or
 * their key, which is among those, tells them apart), awaiting `pause()` between slices: a copy served in pages makes them
 * on its snapshot while it serves pages (engine/copy-pages.ts), so no single step holds the event loop for a whole table.
 * A slice ends at `sliceRows` rows or once its rows add up to `sliceBytes` (keyset.ts rowBytes), whichever first, and never
 * before its first row: rows are read one at a time and hashed as they are read, so a slice of wide rows holds one row in
 * memory and the event loop for about `sliceBytes` of hashing. `except`: tables left for later. Throws what a read
 * throws, and stops when `stopped()` says so.
 */
export async function tableContentHashesInSlices(
    conn: Database.Database,
    opts: HashOptions & { except?: readonly string[] },
    pace: { sliceRows: number; sliceBytes: number; pause: () => Promise<void>; stopped: () => boolean },
): Promise<TableHashes> {
    const tables: Record<string, TableHash> = {};
    for (const { table, columns, order, where } of hashedTables(conn)) {
        if ((opts.only && !opts.only.includes(table)) || opts.except?.includes(table)) continue;
        const hasher = tableHasher(table, columns, opts);
        const walk = [...order, ...rowTiebreak(conn, table, order)];
        const extra = walk.map((c) => sqlColumn(c)).join(', ');
        let last: unknown[] | null = null;
        for (;;) {
            if (pace.stopped()) throw new Error('stopped');
            const after = last ? afterRow(walk, last) : null;
            const conditions = [where ? `(${where})` : null, after?.sql ?? null].filter((c): c is string => c !== null);
            const read = conn.prepare(`SELECT ${hasher.select}, ${extra} FROM ${q(table)}${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''}`
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
    return { v: TABLE_HASHES_VERSION, tables };
}

/** A main server's `tableHashes` as this server can use them, or null: made another way, or not the shape they have. */
export function readTableHashes(raw: unknown): Record<string, TableHash> | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as { v?: unknown; tables?: unknown };
    if (r.v !== TABLE_HASHES_VERSION || !r.tables || typeof r.tables !== 'object') return null;
    const out: Record<string, TableHash> = {};
    for (const [table, th] of Object.entries(r.tables as Record<string, unknown>)) {
        const t = th as { rows?: unknown; hash?: unknown } | null;
        if (!t || !Number.isInteger(t.rows) || typeof t.hash !== 'string' || !/^[0-9a-f]{64}$/.test(t.hash)) return null;
        out[table] = { rows: t.rows as number, hash: t.hash };
    }
    return out;
}

/**
 * This server's copied tables against the main server's: the tables both hash, and those whose count or hash differs.
 * A table only one side hashes (another version's manifest) is not compared. `photosLeftOut`: the photos the main server
 * left out of its hash (the copy's `photosOmitted`), left out of this server's too. `membersLeftOut`: the members values
 * this server's import left out, hashed as the copy's.
 */
export function compareTableHashes(
    theirs: Record<string, TableHash>, opts: Pick<HashOptions, 'photosLeftOut' | 'membersLeftOut'> = {},
): { compared: string[]; differing: { table: string; rows: number; theirRows: number }[] } {
    const mine = tableContentHashes({ photosLeftOut: opts.photosLeftOut, membersLeftOut: opts.membersLeftOut }).tables;
    const compared: string[] = [];
    const differing: { table: string; rows: number; theirRows: number }[] = [];
    for (const [table, t] of Object.entries(theirs)) {
        const m = mine[table];
        if (!m) continue;
        compared.push(table);
        if (m.rows !== t.rows || m.hash !== t.hash) differing.push({ table, rows: m.rows, theirRows: t.rows });
    }
    return { compared: compared.sort(), differing };
}
