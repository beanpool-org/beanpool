/**
 * How long a community server keeps anyone's internet address: 7 days at most. The privacy policy says "a community
 * server keeps no one's IP address for more than 7 days, and its logs never record one"; this file makes the first half
 * true, and log-address.ts with sanitize-message.ts the second.
 *
 * Addresses are kept in three node_config rows, each so an owner can tell who copies this server, and spot a stranger
 * trying to:
 *   - `replication_access` (state-engine.ts): the address of each pull on the copying routes, and of each refused try;
 *   - `standby_health` (services/standby-health.ts): each standby's address, which tells one standby from another;
 *   - `takeover_envelope_holders` (services/takeover-envelope.ts): which standby, by its address, holds which take-over keys.
 * An entry older than 7 days keeps its time and outcome, and its address becomes null, which the screens show as
 * "address no longer kept". Kept rather than dropped: the counts, times and outcomes are what spot an attacker (refused
 * tries a fortnight ago) or a standby that still holds old keys, and none of them is anyone's.
 *
 * When an address goes:
 *   - on every write of those rows, and in what their readers return (so a screen never shows one past its time between
 *     sweeps): their modules call `withoutOldAddresses`;
 *   - at boot and every hour after (`startForgettingOldAddresses`), so one goes even when nothing writes its row. The
 *     first boot of this version clears the older ones (day zero), and so does the first boot after a restore;
 *   - in every copy of the database, whatever its age. Every snapshot and backup of the live database is made by
 *     `copyWithoutAddresses` (`writeDbSnapshot`, services/snapshot-scheduler.ts); a backup packed from a snapshot
 *     file (services/sealed-backup.ts), and one a fleet harvester receives (services/harvester.ts), goes through
 *     `forgetAddressesInStoredCopy`. A snapshot kept for weeks holds none, and a server restored from one brings none
 *     back. A copy also loses the sign-up and knock limiters' address hashes (`open_joins.ip_hash`,
 *     `join_requests.ip_hash`): their key, `openJoinSalt`, is in the same file, so a hash there gives back the address
 *     to anyone who tries all of IPv4. And it loses every address in its log lines. Nothing is left in the file's free
 *     space or beside it: the copy is a VACUUM INTO (no free space comes along), cleaned with its freed bytes zeroed
 *     and its journal in memory, and renamed into place only then;
 *   - in the copies this server already keeps, made before this version (their addresses are of any age: main never
 *     expired them): the boot run scrubs each snapshot, and each readable backup a fleet harvester holds, in the
 *     background (`forgetAddressesInStoredCopies`). Each keeps its name, mode and times, so the snapshot list and
 *     its rotation are unchanged.
 * None of the three rows is copied to a standby or carried in the take-over keys (engine/replication-manifest.ts,
 * 'per-server'), and nor is an `ip_hash`, so a standby's copy and a take-over bring none back either.
 *
 * The boot run also takes addresses out of log lines written before this version (`forgetAddressesInLogs`): lines
 * written since never have one (logger.ts sanitizes every line). Node's diagnostic reports are cleaned by their own
 * scrub (process-handlers.ts, `stripAddressesFromReport`).
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db } from '../db/db.js';
import { logger } from '../logger.js';
import { redactAddresses } from '../sanitize-message.js';

export const ADDRESS_KEEP_DAYS = 7;
export const ADDRESS_KEEP_MS = ADDRESS_KEEP_DAYS * 24 * 60 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;

/** An entry's time, kept when it is on or after `cutoff`. Anything else (missing, not a number) forgets its address. */
const expired = (at: unknown, cutoff: number) => !(typeof at === 'number' && Number.isFinite(at) && at >= cutoff);

/** The node_config rows that hold an address. A literal, so test-replication-manifest.ts can read each key written. */
export const ADDRESS_ROWS = ['replication_access', 'standby_health', 'takeover_envelope_holders'] as const;
export type AddressRow = typeof ADDRESS_ROWS[number];

/** Clears, in place, each address in `value` (the row's parsed JSON) whose entry is older than `cutoff`. True if any. */
type Forget = (value: any, cutoff: number) => boolean;

const ROWS: Record<AddressRow, Forget> = {
    replication_access: (log, cutoff) => {
        let changed = false;
        if (log.lastPullIp != null && expired(log.lastPullAt, cutoff)) { log.lastPullIp = null; changed = true; }
        if (log.lastRejectedIp != null && expired(log.lastRejectedAt, cutoff)) { log.lastRejectedIp = null; changed = true; }
        for (const ev of Array.isArray(log.recent) ? log.recent : []) {
            if (ev && typeof ev === 'object' && ev.ip != null && expired(ev.at, cutoff)) { ev.ip = null; changed = true; }
        }
        return changed;
    },
    // A standby's address is its latest pull's: `lastPullAt` is when it was seen.
    standby_health: (s, cutoff) => {
        let changed = false;
        for (const x of Array.isArray(s.standbys) ? s.standbys : []) {
            if (x && typeof x === 'object' && x.address != null && expired(x.lastPullAt, cutoff)) { x.address = null; changed = true; }
        }
        return changed;
    },
    takeover_envelope_holders: (list, cutoff) => {
        let changed = false;
        for (const h of Array.isArray(list) ? list : []) {
            if (h && typeof h === 'object' && h.ip != null && expired(h.lastFetchAt, cutoff)) { h.ip = null; changed = true; }
        }
        return changed;
    },
};

/** `value`, the parsed JSON of node_config `key`, with each address older than 7 days (at `now`) removed, in place. */
export function withoutOldAddresses<T>(key: AddressRow, value: T, now = Date.now()): T {
    if (value && typeof value === 'object') ROWS[key](value, now - ADDRESS_KEEP_MS);
    return value;
}

/** Rewrite the rows of `conn` whose addresses are older than `cutoff`. A row that isn't JSON goes: its reader reads it as empty. */
function forgetIn(conn: Database.Database, cutoff: number): number {
    let changed = 0;
    for (const key of ADDRESS_ROWS) {
        const row = conn.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: unknown } | undefined;
        if (!row) continue;
        let value: unknown;
        try { value = JSON.parse(String(row.value)); } catch { value = undefined; }
        if (!value || typeof value !== 'object') {
            conn.prepare('DELETE FROM node_config WHERE key = ?').run(key);
            changed++;
        } else if (ROWS[key](value, cutoff)) {
            conn.prepare('UPDATE node_config SET value = ? WHERE key = ?').run(JSON.stringify(value), key);
            changed++;
        }
    }
    return changed;
}

/** Clear, in this server's database, every address kept longer than 7 days. Returns how many rows changed. */
export function forgetOldAddresses(now = Date.now()): number {
    return forgetIn(db, now - ADDRESS_KEEP_MS);
}

/**
 * The tables whose `ip_hash` is a limiter's keyed hash of an address (engine/open-join.ts, engine/knocks.ts): kept a
 * day in the live database, and never in a copy, which also holds the key.
 */
const ADDRESS_HASH_TABLES = ['open_joins', 'join_requests'] as const;

const hasTable = (conn: Database.Database, table: string) =>
    !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
const hasAddressHash = (conn: Database.Database, table: string) =>
    (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === 'ip_hash');

type LogLine = { id: number; message: string | null; metadata: string | null };

/** The log lines of `conn` that hold an address, each with its addresses already redacted. */
function logLinesWithAddresses(conn: Database.Database): LogLine[] {
    if (!hasTable(conn, 'system_logs')) return [];
    const out: LogLine[] = [];
    for (const r of conn.prepare('SELECT id, message, metadata FROM system_logs').all() as LogLine[]) {
        const message = r.message == null ? r.message : redactAddresses(r.message);
        const metadata = r.metadata == null ? r.metadata : redactAddresses(r.metadata);
        if (message !== r.message || metadata !== r.metadata) out.push({ id: r.id, message, metadata });
    }
    return out;
}

function forgetAddressesInLogsOf(conn: Database.Database): number {
    const lines = logLinesWithAddresses(conn);
    const update = conn.prepare('UPDATE system_logs SET message = ?, metadata = ? WHERE id = ?');
    for (const l of lines) update.run(l.message, l.metadata, l.id);
    return lines.length;
}

/** Whether `conn` holds anything a copy may not: a row's address, a limiter's address hash, an address in a log line. */
function holdsAddresses(conn: Database.Database): boolean {
    for (const key of ADDRESS_ROWS) {
        const row = conn.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: unknown } | undefined;
        if (!row) continue;
        let value: unknown;
        try { value = JSON.parse(String(row.value)); } catch { return true; }
        if (!value || typeof value !== 'object' || ROWS[key](value, Number.POSITIVE_INFINITY)) return true;
    }
    for (const table of ADDRESS_HASH_TABLES) {
        if (hasAddressHash(conn, table) && conn.prepare(`SELECT 1 FROM ${table} WHERE ip_hash IS NOT NULL LIMIT 1`).get()) return true;
    }
    return logLinesWithAddresses(conn).length > 0;
}

/**
 * Every address out of a copy of the database, in place, whatever its age: the three rows', the limiters' address
 * hashes and any in a log line. What it frees is zeroed, but free space the file already had is not touched: make the
 * copy with `copyWithoutAddresses`, which starts from a VACUUM INTO (no free space). True when it is done. Never
 * throws: a copy is a recovery point, and one that failed here still holds only what this server keeps anyway (7 days
 * at most, a day for a hash), which a server restored from it clears at its first boot. So it is kept, and the log
 * says so.
 */
export function forgetAddressesInCopy(file: string): boolean {
    let conn: Database.Database | null = null;
    try {
        conn = new Database(file, { fileMustExist: true });
        // The rollback journal in memory, not in a file beside the copy: a journal is each changed page as it was,
        // address and all. Nor is a -wal or -shm left beside it.
        conn.pragma('journal_mode = MEMORY');
        // Zero what is freed. A new connection has this off (only the live database's turns it on, db/db.ts), and then
        // an UPDATE leaves the old row in the file's free space: SQL shows no address, `strings copy.db` does.
        conn.pragma('secure_delete = ON');
        const copy = conn;
        copy.transaction(() => {
            forgetIn(copy, Number.POSITIVE_INFINITY);
            for (const table of ADDRESS_HASH_TABLES) {
                if (hasAddressHash(copy, table)) copy.prepare(`UPDATE ${table} SET ip_hash = NULL WHERE ip_hash IS NOT NULL`).run();
            }
            forgetAddressesInLogsOf(copy);
        })();
        return true;
    } catch (e) {
        try { logger.warn('SYS', `[Addresses] Could not take the internet addresses out of a copy of the database; it keeps those of the last 7 days: ${(e as Error)?.message || e}`); } catch { /* logging never fails a copy */ }
        return false;
    } finally {
        try { conn?.close(); } catch { /* the copy is written */ }
    }
}

/** Take addresses out of log lines already in system_logs (written before logs were sanitized for them). */
export function forgetAddressesInLogs(): number {
    return db.transaction(() => forgetAddressesInLogsOf(db))();
}

/**
 * A copy being made (`copyWithoutAddresses`) is this file beside its destination until it holds no address, and is then
 * renamed into place. It never ends in `.db`, so nothing lists it as a snapshot or a backup, and one a crash leaves in
 * the snapshots directory is removed at the next boot.
 */
export const ADDRESS_SCRUB_SUFFIX = '.forgetting-addresses.tmp';

/**
 * Write `dest`, a copy of the database `from` (the live connection, or a database file) with no internet address in it.
 * VACUUM INTO first: it writes only live rows, so nothing in `from`'s free space comes along, and it is a consistent
 * copy of a database in use. Then `forgetAddressesInCopy`. All of it as a twin beside `dest`, renamed over `dest` at
 * the end, so `dest` is never half a copy, and never one still being cleaned (`from` may be `dest` itself: it is read
 * whole before the rename). Throws when the copy cannot be made, and leaves nothing behind then. A copy made but not
 * cleaned is kept all the same (a recovery point): the result is false, and the log has said why.
 */
export function copyWithoutAddresses(from: Database.Database | string, dest: string): boolean {
    const twin = `${dest}${ADDRESS_SCRUB_SUFFIX}`;
    try {
        fs.rmSync(twin, { force: true });
        const into = `VACUUM INTO '${twin.replace(/'/g, "''")}'`;
        if (typeof from === 'string') {
            const source = new Database(from, { readonly: true, fileMustExist: true });
            try { source.exec(into); } finally { source.close(); }
        } else {
            from.exec(into);
        }
        const cleaned = forgetAddressesInCopy(twin);
        fs.renameSync(twin, dest);
        return cleaned;
    } catch (e) {
        try { fs.rmSync(twin, { force: true }); } catch { /* nothing was made */ }
        throw e;
    }
}

const dataDir = () => process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

/**
 * The copies of a database this server keeps on disk: its snapshots (services/snapshot-scheduler.ts) and, on a fleet
 * harvester, the readable backups it holds of other servers, the latest and the daily history (services/harvester.ts).
 * A locked backup (.bpsealed) is not among them: nobody here can open one. Also any twin a crash left.
 */
function storedCopies(root: string): { copies: string[]; leftovers: string[] } {
    const copies: string[] = [];
    const leftovers: string[] = [];
    const scan = (dir: string, isCopy: (name: string) => boolean) => {
        let names: string[];
        try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) {
            if (name.endsWith(ADDRESS_SCRUB_SUFFIX)) leftovers.push(path.join(dir, name));
            else if (isCopy(name)) copies.push(path.join(dir, name));
        }
    };
    scan(path.join(root, 'snapshots'), (name) => name.endsWith('.db'));
    let held: string[] = [];
    try { held = fs.readdirSync(path.join(root, 'backups')); } catch { /* not a harvester */ }
    for (const node of held) {
        scan(path.join(root, 'backups', node), (name) => name === 'state.db');
        scan(path.join(root, 'backups', node, 'history'), (name) => name.endsWith('.db'));
    }
    return { copies, leftovers };
}

/**
 * Every address out of a copy that already exists: a snapshot on disk, a backup packed from one, a backup a fleet
 * harvester receives. A copy that holds none (read through SQL) is only read, never written: a snapshot is rewritten
 * once, not at every boot, and a harvester keeps a clean backup byte for byte. That read is enough: every copy an
 * older version made is a VACUUM INTO, which has no free space, so an address in one is in a row. One that holds any
 * is rewritten by `copyWithoutAddresses` (a crash part-way leaves the old file whole) and gets back its mode and
 * times: a snapshot is dated, and rotated, by its mtime (listSnapshots). Synchronous from the first read to the
 * rename, so nothing else in this process (the snapshot rotation, the harvester) can touch the file in between. Never
 * throws. True if it was rewritten without its addresses.
 */
export function forgetAddressesInStoredCopy(file: string): boolean {
    let before: fs.Stats;
    try { before = fs.lstatSync(file); } catch { return false; }
    if (!before.isFile()) return false;
    let holds: boolean;
    let reader: Database.Database | null = null;
    try {
        reader = new Database(file, { readonly: true, fileMustExist: true });
        holds = holdsAddresses(reader);
    } catch (e) {
        try { logger.warn('SYS', `[Addresses] Could not read ${path.basename(file)} to take the internet addresses out of it: ${(e as Error)?.message || e}`); } catch { /* logging never fails a boot */ }
        return false;
    } finally {
        try { reader?.close(); } catch { /* only read */ }
    }
    if (!holds) return false;
    let cleaned: boolean;
    try {
        cleaned = copyWithoutAddresses(file, file);
    } catch (e) {
        try { logger.warn('SYS', `[Addresses] ${path.basename(file)} keeps its internet addresses: ${(e as Error)?.message || e}`); } catch { /* logging never fails a boot */ }
        return false;
    }
    try {
        fs.chmodSync(file, before.mode & 0o7777);
        fs.utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000);
    } catch (e) {
        try { logger.warn('SYS', `[Addresses] ${path.basename(file)} lost its mode or time: ${(e as Error)?.message || e}`); } catch { /* logging never fails a boot */ }
    }
    return cleaned;
}

/**
 * Every address out of each copy this server already keeps (`storedCopies`), one copy per turn of the event loop: a
 * harvester can hold hundreds, and the server is starting. Resolves to how many were rewritten.
 */
export async function forgetAddressesInStoredCopies(root = dataDir()): Promise<number> {
    const { copies, leftovers } = storedCopies(root);
    for (const twin of leftovers) {
        try { fs.rmSync(twin, { force: true }); } catch { /* the next boot tries again */ }
    }
    let rewritten = 0;
    for (const file of copies) {
        await new Promise((resolve) => setImmediate(resolve));
        if (forgetAddressesInStoredCopy(file)) rewritten++;
    }
    if (rewritten > 0) {
        logger.info('SYS', `[Addresses] Took the internet addresses out of ${rewritten} cop${rewritten === 1 ? 'y' : 'ies'} of the database kept on this server (snapshots or backups made before this version).`);
    }
    return rewritten;
}

let sweep: ReturnType<typeof setInterval> | null = null;

/**
 * At boot: clear old addresses and old log lines' addresses now, then old addresses every hour; and, in the background,
 * every address in the copies of the database kept on disk (the promise returned, which resolves to how many were
 * rewritten and never rejects). Every node runs it (a standby, or a server demoted to one, can still hold what it kept
 * as a main server). Calling it again restarts the timer with the new period.
 */
export function startForgettingOldAddresses(everyMs = SWEEP_EVERY_MS): Promise<number> {
    try {
        const rows = forgetOldAddresses();
        const lines = forgetAddressesInLogs();
        if (rows + lines > 0) logger.info('SYS', `[Addresses] Cleared internet addresses older than ${ADDRESS_KEEP_DAYS} days (${rows} record(s)) and every address in older log lines (${lines} line(s)).`);
    } catch (e) {
        console.warn('[Addresses] could not clear old internet addresses at boot:', (e as Error)?.message || e);
    }
    if (sweep) clearInterval(sweep);
    sweep = setInterval(() => {
        try { forgetOldAddresses(); } catch (e) { console.warn('[Addresses] could not clear old internet addresses:', (e as Error)?.message || e); }
    }, everyMs);
    sweep.unref?.();
    return forgetAddressesInStoredCopies().catch((e) => {
        console.warn('[Addresses] could not clear the internet addresses in stored copies of the database:', (e as Error)?.message || e);
        return 0;
    });
}
