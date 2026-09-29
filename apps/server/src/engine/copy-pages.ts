/**
 * A copy of this server served in pages from one snapshot (design scratch/global-node/DESIGN-paged-copies-fable.md §3 and
 * §5, PR P1), so a copy of any size is a number of pages, and no page holds the event loop or the heap for a whole table.
 * The routes are routes/backup.ts `POST /api/local/admin/sync-copy` and `GET /api/local/admin/sync-copy/<copyId>/<n>`.
 *
 * **The snapshot.** A copy opens a second connection to state.db, read-only, and one read transaction on it: in WAL mode
 * that connection sees the database as it was at its first read for as long as the transaction lasts, whatever this
 * server writes meanwhile on its own connection. Every page, the counts, the listing hash and the table hashes are read in
 * it, so they are one consistent cut, and `cursor` (the time just before that first read) is where the next delta starts:
 * a row written after it is in that delta, never in this copy. While it is open, checkpoints can't pass its mark, so the WAL
 * keeps what is written meanwhile; readers and writers are never held up.
 *
 * **The pages.** The opening page (n 0, the POST's answer) carries what today's payload carries beside the tables (the
 * copy's id, `cursor`, `generatedAt`, `since`, `stateHash`, `commonsBalance`, the node_config records, the community's
 * settings), the keepers (`treasuryOperators`, a whole set the importer applies as a difference, so in one piece) and how
 * many rows each category and plain table of this copy holds (`rowCounts`). Then every page, the opening one included,
 * carries the next rows: the payload's categories in the payload's order (engine sync.ts EXPORT_CATEGORIES), the plain
 * tables under `plainTables` in the manifest's order, the tombstones last; each row shaped by the code the whole export
 * shapes it with, the photos' bytes put back from the image store as the export puts them back. A page ends at
 * SYNC_PAGE_BYTES of rows' JSON or SYNC_PAGE_ROWS rows, whichever first, never inside a row and never before its first:
 * one row bigger than the bound is a page of its own. The page where the rows end says `last: true` and carries the
 * closing fields: how many pages, the rows sent per category, the photo rows left out because this server can't read
 * their objects (`photosOmitted`), and for a whole copy the table hashes (engine/replica-hashes.ts), read in the same
 * snapshot, so they always match the rows and always go. A small copy is one page: the POST's answer, one round trip, as
 * the whole payload was.
 *
 * Each table is read in a fixed order a slice at a time from where the last slice ended (engine/keyset.ts): a whole copy by
 * rowid, the order the table lies in; a delta by its watermark, then rowid, on the watermark's index; the plain tables by
 * their watermark, then key, as exportPlainTables orders them, with their row rule (`where`). In one snapshot the order
 * never moves, so each row is read once. Between slices the event loop is let go.
 *
 * **Signed.** Every page is signed as a payload is (engine/sync.ts signSyncBody): over its JSON without `signature` and
 * `publicKey`, which the importer checks the same way. The copy's id and the page's number are inside what is signed, so
 * a page replayed from another copy, or as another number, is told apart by the standby.
 *
 * **One at a time, in order, for a while.** One copy's snapshot is open at a time: a second POST while one is answers 409
 * `busy`. Pages must be asked in order: the next one, or the last one again (a retry after a timeout gets the same bytes);
 * any other number answers 409. A copy closes when its last page is served (its snapshot at once; the last page stays
 * for a retry until the copy is idle), when no page was asked for COPY_IDLE_MS, COPY_MAX_MS after it opened, and when
 * something needs the database to itself (engine/open-copies.ts closeOpenCopies). A copy lives in memory only: after a
 * restart every copy id answers 404, and the standby asks for a new copy.
 */

import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { db } from '../db/db.js';
import { EXPORT_CATEGORIES, exportTreasuryOperators, getStateHash, plainTableRead, type ExportCategory } from '@beanpool/engine';
import { PLAIN_TABLES, TABLES } from './replication-manifest.js';
import { payloadRecords, restorePhotoRows, warnPhotosOmitted } from './sync.js';
import { tableContentHashesInSlices, type TableHashes } from './replica-hashes.js';
import { afterRow, rowTiebreak, sqlColumn } from './keyset.js';
import { noteCopyClosed, noteCopyOpen } from './open-copies.js';

/** A page ends at this many bytes of its rows' JSON (SYNC_PAGE_BYTES), or at SYNC_PAGE_ROWS rows, whichever first. */
export const SYNC_PAGE_BYTES = 8 * 1024 * 1024;
export const SYNC_PAGE_ROWS = 25_000;
/** A copy no page was asked of for this long closes (SYNC_COPY_IDLE_MS). */
export const COPY_IDLE_MS = 2 * 60_000;
/** Any copy closes this long after it opened (SYNC_COPY_MAX_MS). */
export const COPY_MAX_MS = 60 * 60_000;
/** Rows read from the snapshot at once; between slices the event loop is let go. */
const SLICE_ROWS = 1000;
/** Photo rows read at once: each one's bytes come back from the image store, so a slice is at most a few past a full page. */
const PHOTO_SLICE_ROWS = 16;
/** Rows hashed at once for the closing page's table hashes. */
const HASH_SLICE_ROWS = 5000;

/** The key a signature is made with, as signSyncBody answers: null when this server has none yet. */
export type CopySigner = (text: string) => Promise<{ signature: string; publicKey: string } | null>;

/** What a route answers: a page's text, or an error. */
export type CopyAnswer = { status: 200; page: string } | { status: 404 | 409 | 500 | 503; error: Record<string, unknown> };

/** What a page carries beside its rows. Every page: `copyId`, `n`, `nodeId`, `last`; the opening page and the last add theirs. */
export interface CopyPageHeader {
    copyId: string;
    n: number;
    nodeId: string;
    last: boolean;
    // The opening page (n 0).
    cursor?: string;
    generatedAt?: string;
    since?: string | null;
    stateHash?: string;
    commonsBalance?: number;
    rowCounts?: CopyRowCounts;
    pageBytes?: number;
    pageRows?: number;
    // The last page.
    pages?: number;
    rowsSent?: CopyRowCounts;
    photosOmitted?: string[];
    tableHashes?: TableHashes;
    signature?: string;
    publicKey?: string;
}

/** Rows per payload category, and per plain table under `plainTables`. */
export type CopyRowCounts = Record<string, number> & { plainTables?: Record<string, number> };

/** One table this copy reads: a payload category, or a plain table. */
interface Step {
    /** The payload's key, or, for a plain table, its name under `plainTables`. */
    key: string;
    plain: boolean;
    table: string;
    /** Which rows this copy carries (a delta's condition, a row rule), or every row; and the values for its `?`s. */
    where: string | null;
    params: unknown[];
    /** The order the rows are read in, total: the keyset's columns. */
    order: string[];
    shape: (conn: Database.Database, rows: any[]) => unknown[];
    photos: boolean;
}

interface Copy {
    id: string;
    since: string | null;
    nodeId: string;
    conn: Database.Database;
    sign: CopySigner;
    openedAt: number;
    pageBytes: number;
    pageRows: number;
    idleMs: number;
    steps: Step[];
    /** The step being read, and the keyset values of the last row read of it (null: from its start). */
    at: number;
    after: unknown[] | null;
    counts: Map<string, number>;
    sent: Map<string, number>;
    photosOmitted: string[];
    /** The opening page's own fields, as JSON, in order. */
    opening: [string, string][];
    /** A whole copy's table hashes but the photos', made a slice at a time from the opening. */
    hashing: Promise<{ hashes: TableHashes } | { error: unknown }> | null;
    /** The last page served, as it was sent: the one a retry gets. */
    lastN: number;
    lastPage: string;
    building: { n: number; promise: Promise<string> } | null;
    /** Its last page was served. */
    finished: boolean;
    /** Its snapshot is closed. */
    closed: boolean;
    idleTimer: NodeJS.Timeout | null;
    maxTimer: NodeJS.Timeout | null;
}

/** The copy this server is serving, or the last one it finished, kept for a retry of its last page until it is idle. */
let current: Copy | null = null;

class CopyClosed extends Error {
    constructor() { super('the copy was closed'); }
}

function envCount(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

const letLoopGo = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function stillOpen(copy: Copy): void {
    if (copy.closed) throw new CopyClosed();
}

/** The tables this copy reads, in the payload's order, each with the rows it carries and the order it reads them in. */
function stepsOf(conn: Database.Database, since: string | null): Step[] {
    const has = (table: string) => (conn.prepare('SELECT COUNT(*) AS n FROM pragma_table_info(?)').get(table) as { n: number }).n > 0;
    const ofCategory = (c: ExportCategory): Step | null => {
        // A table this database doesn't have (an older schema) is left out of the copy, never sent empty.
        if (!has(c.table)) return null;
        let where: string | null = null;
        let params: unknown[] = [];
        let order: string[] = [];
        if (since && c.delta !== 'whole') {
            if ('watermark' in c.delta) {
                where = `${sqlColumn(c.delta.watermark)} >= ?`;
                params = [since];
                order = [c.delta.watermark];
            } else {
                where = `(${c.delta.where})`;
                params = Array.from({ length: c.delta.sinceParams }, () => since);
            }
        }
        return {
            key: c.key, plain: false, table: c.table, where, params, order: [...order, ...rowTiebreak(conn, c.table, order)],
            shape: c.shape, photos: c.key === 'photos',
        };
    };
    const steps: Step[] = [];
    for (const c of EXPORT_CATEGORIES) {
        if (c.key === 'tombstones') continue;
        const step = ofCategory(c);
        if (step) steps.push(step);
    }
    // The plain tables, where the payload has them: after the categories, before the tombstones.
    for (const spec of PLAIN_TABLES) {
        const read = plainTableRead(conn, spec);
        if (!read) continue;
        const conditions = [since ? `${sqlColumn(read.watermark)} >= ?` : null, read.where ? `(${read.where})` : null]
            .filter((c): c is string => c !== null);
        const order = [read.watermark, ...read.key];
        steps.push({
            key: read.table, plain: true, table: read.table, where: conditions.length > 0 ? conditions.join(' AND ') : null,
            params: since ? [since] : [], order: [...order, ...rowTiebreak(conn, read.table, order)],
            shape: (_conn, rows) => rows.map(read.sent), photos: false,
        });
    }
    const tombstones = EXPORT_CATEGORIES.find((c) => c.key === 'tombstones');
    const last = tombstones ? ofCategory(tombstones) : null;
    if (last) steps.push(last);
    return steps;
}

/** Up to `limit` rows of `step` after `after`, `SELECT *`, and each one's keyset values. */
function readSlice(conn: Database.Database, step: Step, after: unknown[] | null, limit: number): { rows: any[]; keys: unknown[][] } {
    const past = after ? afterRow(step.order, after) : null;
    const conditions = [step.where, past?.sql ?? null].filter((c): c is string => c !== null);
    const keyed = step.order.map((c, i) => `${sqlColumn(c)} AS "__copy_key_${i}"`).join(', ');
    const rows = conn.prepare(`SELECT *, ${keyed} FROM ${quote(step.table)}${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''}`
        + ` ORDER BY ${step.order.map(sqlColumn).join(', ')} LIMIT ?`).all(...step.params, ...(past?.params ?? []), limit) as any[];
    const keys = rows.map((row) => step.order.map((_c, i) => {
        const v = row[`__copy_key_${i}`];
        delete row[`__copy_key_${i}`];
        return v;
    }));
    return { rows, keys };
}

/** Whether any row of this copy is left to send; moves past the tables that have none. */
function rowsLeft(copy: Copy): boolean {
    while (copy.at < copy.steps.length) {
        if (readSlice(copy.conn, copy.steps[copy.at], copy.after, 1).rows.length > 0) return true;
        copy.at++;
        copy.after = null;
    }
    return false;
}

/** A category's or table's rows as a JSON array, from each row's JSON. */
const jsonArray = (rows: string[]): string => `[${rows.join(',')}]`;

/** An object's JSON from its fields' JSON, in order: exactly what JSON.stringify makes of it. */
const jsonObject = (fields: [string, string][]): string => `{${fields.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}`;

/** Rows per category, with the plain tables' under `plainTables`, as a page carries them. */
function countsJson(copy: Copy, of: Map<string, number>): string {
    const out: CopyRowCounts = {};
    for (const step of copy.steps) {
        const n = of.get(step.key) ?? 0;
        if (step.plain) (out.plainTables ??= {})[step.key] = n;
        else out[step.key] = n;
    }
    return JSON.stringify(out);
}

/** Page `n`: its rows from where the last page ended, and, when they end in it, the closing fields. Signed. */
async function buildPage(copy: Copy, n: number): Promise<{ page: string; last: boolean }> {
    const parts = new Map<string, { plain: boolean; rows: string[] }>();
    let rows = 0;
    let bytes = 0;
    let full = false;
    while (!full && copy.at < copy.steps.length && rows < copy.pageRows && bytes < copy.pageBytes) {
        const step = copy.steps[copy.at];
        const limit = Math.min(copy.pageRows - rows, step.photos ? PHOTO_SLICE_ROWS : SLICE_ROWS);
        const slice = readSlice(copy.conn, step, copy.after, limit);
        const shaped: ({ row: unknown } | { omitted: string })[] = step.photos
            ? await restorePhotoRows(slice.rows)
            : step.shape(copy.conn, slice.rows).map((row) => ({ row }));
        stillOpen(copy);
        for (let i = 0; i < shaped.length; i++) {
            const r = shaped[i];
            if ('omitted' in r) {
                // A photo whose object this server can't read: not sent, and named in the last page (engine/sync.ts
                // restoreInlinePhotos), so a standby keeps its own copy.
                copy.photosOmitted.push(r.omitted);
                copy.after = slice.keys[i];
                continue;
            }
            const json = JSON.stringify(r.row);
            const size = Buffer.byteLength(json);
            if (rows > 0 && bytes + size > copy.pageBytes) {
                full = true;
                break;
            }
            let part = parts.get(step.key);
            if (!part) parts.set(step.key, part = { plain: step.plain, rows: [] });
            part.rows.push(json);
            rows++;
            bytes += size;
            copy.sent.set(step.key, (copy.sent.get(step.key) ?? 0) + 1);
            copy.after = slice.keys[i];
        }
        if (!full && slice.rows.length < limit) {
            copy.at++;
            copy.after = null;
        }
        await letLoopGo();
        stillOpen(copy);
    }
    const last = !rowsLeft(copy);

    const fields: [string, string][] = [['copyId', JSON.stringify(copy.id)], ['n', String(n)], ['nodeId', JSON.stringify(copy.nodeId)]];
    if (n === 0) fields.push(...copy.opening);
    const plain: string[] = [];
    for (const [key, part] of parts) {
        if (!part.plain) {
            fields.push([key, jsonArray(part.rows)]);
            continue;
        }
        if (plain.length === 0) fields.push(['plainTables', '']);
        plain.push(`${JSON.stringify(key)}:${jsonArray(part.rows)}`);
    }
    if (plain.length > 0) fields[fields.findIndex(([k]) => k === 'plainTables')][1] = `{${plain.join(',')}}`;
    fields.push(['last', last ? 'true' : 'false']);
    if (last) {
        fields.push(['pages', String(n + 1)], ['rowsSent', countsJson(copy, copy.sent)]);
        if (copy.photosOmitted.length > 0) {
            fields.push(['photosOmitted', JSON.stringify(copy.photosOmitted)]);
            warnPhotosOmitted(copy.photosOmitted);
        }
        if (copy.hashing) fields.push(['tableHashes', JSON.stringify(await closingHashes(copy))]);
    }
    stillOpen(copy);
    const text = jsonObject(fields);
    const signed = await copy.sign(text);
    if (!signed) throw new SigningUnavailable();
    return { page: `${text.slice(0, -1)},"signature":${JSON.stringify(signed.signature)},"publicKey":${JSON.stringify(signed.publicKey)}}`, last };
}

class SigningUnavailable extends Error {
    constructor() { super('node signing identity not ready'); }
}

/**
 * A whole copy's table hashes, as the whole payload carries them (routes/backup.ts sync-snapshot): every copied table's,
 * the listing photos' last, without the rows this copy left out (`photosOmitted`), as the standby hashes its own.
 */
async function closingHashes(copy: Copy): Promise<TableHashes> {
    const made = await copy.hashing!;
    if ('error' in made) throw made.error;
    const photos = await tableContentHashesInSlices(copy.conn, { only: ['post_photos'], photosLeftOut: new Set(copy.photosOmitted) }, pace(copy));
    const all = { ...made.hashes.tables, ...photos.tables };
    // In the manifest's order, as tableContentHashes lists them.
    const tables: TableHashes['tables'] = {};
    for (const table of Object.keys(TABLES)) if (all[table]) tables[table] = all[table];
    return { v: made.hashes.v, tables };
}

function pace(copy: Copy) {
    return { sliceRows: HASH_SLICE_ROWS, pause: letLoopGo, stopped: () => copy.closed };
}

/** Close the copy's snapshot. Its last page stays for a retry while the copy is current. */
function closeSnapshot(copy: Copy, why: string): void {
    if (copy.closed) return;
    copy.closed = true;
    noteCopyClosed(copy.id);
    if (copy.maxTimer) clearTimeout(copy.maxTimer);
    copy.maxTimer = null;
    try { copy.conn.exec('COMMIT'); } catch { /* closing ends it */ }
    try { copy.conn.close(); } catch (e) { console.warn(`[Copy] ${copy.id.slice(0, 8)}: closing its snapshot failed:`, (e as Error)?.message || e); }
    const secs = ((Date.now() - copy.openedAt) / 1000).toFixed(1);
    if (copy.finished) console.log(`[Copy] ${copy.id.slice(0, 8)} served in ${copy.lastN + 1} page(s), ${[...copy.sent.values()].reduce((a, b) => a + b, 0)} rows, ${secs} s`);
    else console.log(`[Copy] ${copy.id.slice(0, 8)} closed after ${secs} s: ${why}`);
}

/** The copy is gone: its snapshot closed, and its id answers 404 from now on. */
function dropCopy(copy: Copy, why: string): void {
    closeSnapshot(copy, why);
    if (copy.idleTimer) clearTimeout(copy.idleTimer);
    copy.idleTimer = null;
    if (current === copy) current = null;
}

function touch(copy: Copy): void {
    if (copy.idleTimer) clearTimeout(copy.idleTimer);
    copy.idleTimer = setTimeout(() => dropCopy(copy, `no page was asked for in ${Math.round(copy.idleMs / 1000)} s`), copy.idleMs);
    copy.idleTimer.unref();
}

/** Serve page `n` of the copy: build it, keep it for a retry, and close the snapshot when it is the last. */
function advance(copy: Copy, n: number): Promise<string> {
    const promise = (async () => {
        const { page, last } = await buildPage(copy, n);
        copy.lastN = n;
        copy.lastPage = page;
        if (last) {
            copy.finished = true;
            closeSnapshot(copy, 'its last page was served');
        }
        return page;
    })();
    copy.building = { n, promise };
    promise.then(() => {}, () => {}).finally(() => {
        if (copy.building?.promise === promise) copy.building = null;
    });
    return promise;
}

/** What went wrong building a page, as the route answers it; a copy that failed is dropped. */
function failed(copy: Copy, e: unknown): CopyAnswer {
    if (e instanceof SigningUnavailable) {
        dropCopy(copy, 'this server could not sign a page');
        return { status: 503, error: { error: 'Copy unavailable: node signing identity not ready' } };
    }
    if (copy.closed && !copy.finished) {
        dropCopy(copy, 'closed while a page was being read');
        return { status: 404, error: { error: 'no such copy' } };
    }
    console.error(`[Copy] ${copy.id.slice(0, 8)}: reading a page failed:`, e);
    dropCopy(copy, 'reading a page failed');
    return { status: 500, error: { error: 'Copy export failed' } };
}

/**
 * Open a copy from a new snapshot and answer its opening page: a whole copy, or a delta of the rows written at or after
 * `since` (a cursor from an earlier copy or payload). `commonsBalance` is read in the same step as the snapshot's first
 * read, as the whole export reads it beside its rows. 409 while another copy's snapshot is open.
 */
export async function openCopy(opts: { nodeId: string; since: string | null; commonsBalance: () => number; sign: CopySigner }): Promise<CopyAnswer> {
    if (current && !current.closed) {
        return { status: 409, error: { error: 'busy', why: 'another copy of this server is being served; ask again at the next pull' } };
    }
    if (current) dropCopy(current, 'a new copy opened');
    const conn = new Database(db.name, { readonly: true, fileMustExist: true });
    const copy: Copy = {
        id: crypto.randomUUID(),
        since: opts.since,
        nodeId: opts.nodeId,
        conn,
        sign: opts.sign,
        openedAt: Date.now(),
        pageBytes: envCount('SYNC_PAGE_BYTES', SYNC_PAGE_BYTES),
        pageRows: envCount('SYNC_PAGE_ROWS', SYNC_PAGE_ROWS),
        idleMs: envCount('SYNC_COPY_IDLE_MS', COPY_IDLE_MS),
        steps: [],
        at: 0,
        after: null,
        counts: new Map(),
        sent: new Map(),
        photosOmitted: [],
        opening: [],
        hashing: null,
        lastN: -1,
        lastPage: '',
        building: null,
        finished: false,
        closed: false,
        idleTimer: null,
        maxTimer: null,
    };
    current = copy;
    noteCopyOpen(copy.id, (why) => dropCopy(copy, why));
    touch(copy);
    copy.maxTimer = setTimeout(() => dropCopy(copy, `open for ${Math.round(envCount('SYNC_COPY_MAX_MS', COPY_MAX_MS) / 60_000)} min`),
        envCount('SYNC_COPY_MAX_MS', COPY_MAX_MS));
    copy.maxTimer.unref();

    let commonsBalance: number;
    let records: ReturnType<typeof payloadRecords>;
    let cursor: string;
    try {
        // The snapshot, and what the payload carries beside the tables, in one synchronous step: nothing this server writes
        // can come between them. The cursor is taken before the first read, as the whole export takes it: a row written
        // at the same moment is sent again by the next delta, never missed.
        cursor = new Date().toISOString();
        conn.exec('BEGIN');
        conn.prepare('SELECT COUNT(*) FROM sqlite_master').get();
        commonsBalance = opts.commonsBalance();
        records = payloadRecords();
    } catch (e) {
        dropCopy(copy, 'its snapshot could not be opened');
        throw e;
    }
    try {
        const generatedAt = new Date().toISOString();
        const stateHash = getStateHash(conn);
        const treasuryOperators = exportTreasuryOperators(conn);
        copy.steps = stepsOf(conn, opts.since);
        for (const step of copy.steps) {
            const where = step.where ? ` WHERE ${step.where}` : '';
            copy.counts.set(step.key, (conn.prepare(`SELECT COUNT(*) AS n FROM ${quote(step.table)}${where}`).get(...step.params) as { n: number }).n);
            await letLoopGo();
            stillOpen(copy);
        }
        const opening: [string, unknown][] = [
            ['cursor', cursor], ['generatedAt', generatedAt], ['since', opts.since], ['stateHash', stateHash],
            // EXACT, not rounded (engine sync.ts exportSyncState).
            ['commonsBalance', commonsBalance],
            ...Object.entries(records), ['treasuryOperators', treasuryOperators],
        ];
        copy.opening = opening.filter(([, v]) => v !== undefined).map(([k, v]) => [k, JSON.stringify(v)]);
        copy.opening.push(['rowCounts', countsJson(copy, copy.counts)], ['pageBytes', String(copy.pageBytes)], ['pageRows', String(copy.pageRows)]);
        // A whole copy's table hashes, made while its pages are served: every table's but the photos', which wait for the
        // rows this copy leaves out (closingHashes).
        if (!opts.since) {
            copy.hashing = tableContentHashesInSlices(conn, { except: ['post_photos'] }, pace(copy))
                .then((hashes) => ({ hashes }), (error) => ({ error }));
        }
        const rows = [...copy.counts.values()].reduce((a, b) => a + b, 0);
        console.log(`[Copy] ${copy.id.slice(0, 8)} opened: ${opts.since ? `the rows written since ${opts.since}` : 'a whole copy'}, `
            + `${rows} rows in ${copy.steps.length} tables, pages of ${copy.pageRows} rows or ${copy.pageBytes} bytes`);
        await advance(copy, 0);
    } catch (e) {
        return failed(copy, e);
    }
    return { status: 200, page: copy.lastPage };
}

/** Page `n` of copy `copyId`: the next page, or the last one again. */
export async function copyPage(copyId: string, n: number): Promise<CopyAnswer> {
    const copy = current;
    if (!copy || copy.id !== copyId) return { status: 404, error: { error: 'no such copy' } };
    touch(copy);
    if (copy.building) {
        if (copy.building.n !== n) return { status: 409, error: { error: 'out of order', expected: copy.building.n } };
        try {
            return { status: 200, page: await copy.building.promise };
        } catch (e) {
            return failed(copy, e);
        }
    }
    if (n === copy.lastN) return { status: 200, page: copy.lastPage };
    if (copy.finished || n !== copy.lastN + 1) {
        return { status: 409, error: { error: 'out of order', expected: copy.finished ? null : copy.lastN + 1, last: copy.lastN } };
    }
    try {
        return { status: 200, page: await advance(copy, n) };
    } catch (e) {
        return failed(copy, e);
    }
}
