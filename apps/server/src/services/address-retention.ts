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
 *   - in every copy of the database, whatever its age: `writeDbSnapshot` (services/snapshot-scheduler.ts), which makes
 *     every snapshot and backup, calls `forgetAddressesInCopy`. A snapshot kept for weeks holds none, and a server
 *     restored from one brings none back.
 * None of the three rows is copied to a standby or carried in the take-over keys (engine/replication-manifest.ts,
 * 'per-server'), so a standby's copy and a take-over bring none back either.
 *
 * The boot run also takes addresses out of log lines written before this version (`forgetAddressesInLogs`): lines
 * written since never have one (logger.ts sanitizes every line).
 */

import Database from 'better-sqlite3';
import { db } from '../db/db.js';
import { logger } from '../logger.js';
import { redactAddresses } from '../sanitize-message.js';

export const ADDRESS_KEEP_DAYS = 7;
export const ADDRESS_KEEP_MS = ADDRESS_KEEP_DAYS * 24 * 60 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;

/** An entry's time, kept when it is on or after `cutoff`. Anything else (missing, not a number) forgets its address. */
const expired = (at: unknown, cutoff: number) => !(typeof at === 'number' && Number.isFinite(at) && at >= cutoff);

/** Clears, in place, each address in `value` (the row's parsed JSON) whose entry is older than `cutoff`. True if any. */
type Forget = (value: any, cutoff: number) => boolean;

const ROWS = {
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
} satisfies Record<string, Forget>;

export type AddressRow = keyof typeof ROWS;
/** The node_config rows that hold an address, for a suite. */
export const ADDRESS_ROWS = Object.keys(ROWS) as AddressRow[];

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
 * Every address out of a copy of the database (a snapshot or a backup's state.db), whatever its age. Never throws: a
 * copy is a recovery point, and one that failed here still holds only what this server keeps anyway (7 days at most),
 * which a server restored from it clears at its first boot. So it is kept, and the log says so.
 */
export function forgetAddressesInCopy(file: string): void {
    let conn: Database.Database | null = null;
    try {
        conn = new Database(file);
        conn.pragma('journal_mode = DELETE'); // no -wal/-shm left beside a snapshot
        forgetIn(conn, Number.POSITIVE_INFINITY);
    } catch (e) {
        try { logger.warn('SYS', `[Addresses] Could not take the internet addresses out of a copy of the database; it keeps those of the last 7 days: ${(e as Error)?.message || e}`); } catch { /* logging never fails a copy */ }
    } finally {
        try { conn?.close(); } catch { /* the copy is written */ }
    }
}

/** Take addresses out of log lines already in system_logs (written before logs were sanitized for them). */
export function forgetAddressesInLogs(): number {
    const rows = db.prepare('SELECT id, message, metadata FROM system_logs').all() as { id: number; message: string | null; metadata: string | null }[];
    const update = db.prepare('UPDATE system_logs SET message = ?, metadata = ? WHERE id = ?');
    let changed = 0;
    db.transaction(() => {
        for (const r of rows) {
            const message = r.message == null ? r.message : redactAddresses(r.message);
            const metadata = r.metadata == null ? r.metadata : redactAddresses(r.metadata);
            if (message !== r.message || metadata !== r.metadata) {
                update.run(message, metadata, r.id);
                changed++;
            }
        }
    })();
    return changed;
}

let sweep: ReturnType<typeof setInterval> | null = null;

/**
 * At boot: clear old addresses and old log lines' addresses now, then old addresses every hour. Every node runs it (a
 * standby, or a server demoted to one, can still hold what it kept as a main server). Calling it again restarts the
 * timer with the new period.
 */
export function startForgettingOldAddresses(everyMs = SWEEP_EVERY_MS): void {
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
}
