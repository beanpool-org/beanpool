import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { WebSocket } from 'ws';
import { db, afterTransactionCommit } from './db/db.js';
import { sanitizeMessage } from './sanitize-message.js';

// Re-exported so `import { sanitizeMessage } from './logger.js'` keeps working. The function itself moved
// to a database-free file so the process-level error net can redact without importing the database.
export { sanitizeMessage };

export const logClients = new Set<WebSocket>();

export function addLogClient(ws: WebSocket) {
    logClients.add(ws);
}

export function removeLogClient(ws: WebSocket) {
    logClients.delete(ws);
}

/**
 * Formats a log entry beautifully for the standard terminal output.
 */
function formatConsoleLog(entry: { timestamp: string; level: string; category: string; message: string }): string {
    const { timestamp, level, category, message } = entry;
    const colors = {
        reset: '\x1b[0m',
        blue: '\x1b[36m',
        yellow: '\x1b[33m',
        red: '\x1b[31m',
        purple: '\x1b[35m',
        green: '\x1b[32m',
        gray: '\x1b[90m'
    };

    let levelColor = colors.blue;
    if (level === 'WARN') levelColor = colors.yellow;
    if (level === 'ERROR') levelColor = colors.red;
    if (level === 'SECURITY') levelColor = colors.purple;
    if (level === 'SYNC') levelColor = colors.green;

    return `${colors.gray}[${timestamp}]${colors.reset} ${levelColor}[${level}]${colors.reset} ${colors.gray}[${category}]${colors.reset} ${message}`;
}

/**
 * Write a sanitized log message to SQLite and broadcast via WebSockets.
 */
export function writeLog(
    level: 'INFO' | 'WARN' | 'ERROR' | 'SECURITY' | 'SYNC',
    category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS',
    message: string,
    metadata?: any
) {
    const sanitizedMessage = sanitizeMessage(message);
    const sanitizedMetadata = metadata ? sanitizeMessage(JSON.stringify(metadata)) : null;

    try {
        // Insert log entry
        const stmt = db.prepare(`
            INSERT INTO system_logs (level, category, message, metadata)
            VALUES (?, ?, ?, ?)
        `);
        const result = stmt.run(level, category, sanitizedMessage, sanitizedMetadata);
        const insertId = result.lastInsertRowid;

        // Bounded database: the newest LOG_KEEP_ROWS, none older than LOG_KEEP_DAYS (every 100 insertions, and every hour
        // on a quiet server: startSystemLogRetention).
        if (typeof insertId === 'number' && insertId % 100 === 0) pruneSystemLogs();

        // Get the newly written log (so timestamp matches SQLite's default)
        const logEntry = db.prepare('SELECT * FROM system_logs WHERE id = ?').get(insertId) as any;

        if (logEntry) {
            // Log to local console output
            console.log(formatConsoleLog(logEntry));

            // Stream in real-time to active WebSocket dashboard connections
            const payload = JSON.stringify({ type: 'log', data: logEntry });
            for (const client of logClients) {
                if (client.readyState === 1) { // OPEN
                    client.send(payload);
                }
            }
        }
    } catch (err: any) {
        console.error('Failed to write administrative log:', err.message);
    }
}

// ── How long a log line lasts (data-at-rest report F5) ──────────────────────────────────────────

/**
 * system_logs keeps the newest LOG_KEEP_ROWS lines, and none older than LOG_KEEP_DAYS. Count alone let a quiet server keep
 * months of lines, with members' names and the start of their keys in them. Each server keeps its own (a standby copies
 * none, engine/replication-manifest.ts), and a snapshot or backup holds the lines of the day it was made until it goes.
 */
export const LOG_KEEP_DAYS = 30;
export const LOG_KEEP_ROWS = 2500;
const LOG_KEEP_MS = LOG_KEEP_DAYS * 24 * 60 * 60_000;

/**
 * Delete the log lines past LOG_KEEP_ROWS or older than LOG_KEEP_DAYS at `now`. A line whose time can't be read is kept
 * until the count takes it. Never throws. Returns how many went.
 */
export function pruneSystemLogs(now = Date.now()): number {
    try {
        const cutoff = new Date(now - LOG_KEEP_MS).toISOString();
        const byAge = db.prepare('DELETE FROM system_logs WHERE julianday(timestamp) < julianday(?)').run(cutoff).changes;
        const byCount = db.prepare(`
            DELETE FROM system_logs
            WHERE id < (SELECT id FROM system_logs ORDER BY id DESC LIMIT 1 OFFSET ${LOG_KEEP_ROWS - 1})
        `).run().changes;
        return byAge + byCount;
    } catch (err: any) {
        console.error('Failed to prune administrative log:', err.message);
        return 0;
    }
}

/**
 * Where Settings' Clean storage (engine/storage-health.ts cleanStorageAndCompressLogs) moves the log lines past the newest
 * 500: each file a gzipped JSON array of system_logs rows. They keep the same 30 days, and lose a deleted member the same
 * way, as the lines still in the table.
 */
export function archivedLogsDir(dataDir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data')): string {
    return path.join(dataDir, 'logs', 'archived');
}

type ArchivedLogRow = { timestamp?: unknown; message?: unknown; metadata?: unknown };

/**
 * Put each archive of log lines through `edit`: one left with no line is deleted, one changed is written beside it and
 * renamed over it, one unchanged is left as it is. Never throws (a file that can't be read or written is left, and the
 * warning names it). Returns how many archives changed or went.
 */
function editLogArchives(edit: (rows: ArchivedLogRow[]) => ArchivedLogRow[], dir = archivedLogsDir()): number {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let touched = 0;
    for (const name of names) {
        if (!name.endsWith('.json.gz')) continue;
        const file = path.join(dir, name);
        try {
            const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
            if (!Array.isArray(rows)) continue;
            const kept = edit(rows);
            if (kept.length === 0) {
                fs.rmSync(file, { force: true });
                touched++;
                continue;
            }
            const after = JSON.stringify(kept);
            if (after === JSON.stringify(rows)) continue;
            const twin = `${file}.tmp`;
            fs.writeFileSync(twin, zlib.gzipSync(Buffer.from(after, 'utf8')), { mode: 0o600 });
            fs.renameSync(twin, file);
            touched++;
        } catch (err: any) {
            console.error(`Failed to tidy the archived log ${name}:`, err?.message || err);
        }
    }
    return touched;
}

/** The archived lines older than LOG_KEEP_DAYS at `now` go, and an archive left empty with them. Returns how many archives changed. */
export function pruneArchivedLogs(now = Date.now(), dir = archivedLogsDir()): number {
    const cutoff = now - LOG_KEEP_MS;
    return editLogArchives((rows) => rows.filter((r) => {
        const at = typeof r?.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
        return !(Number.isFinite(at) && at < cutoff);
    }), dir);
}

let logPruneTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Prune now and every hour after, on every server: a quiet server writes no hundredth line for weeks. The archived lines
 * too. Calling it again restarts the timer.
 */
export function startSystemLogRetention(everyMs = 60 * 60_000): void {
    const sweep = () => { pruneSystemLogs(); pruneArchivedLogs(); };
    sweep();
    if (logPruneTimer) clearInterval(logPruneTimer);
    logPruneTimer = setInterval(sweep, everyMs);
    logPruneTimer.unref?.();
}

/** What a deleted member's name and key read as in a log line (scrubMemberFromLogs). */
export const DELETED_MEMBER_IN_LOGS = 'a deleted member';

/** A hex run long enough to be the start or end of a key as a log line shows one (8, 10, 12 or 16 characters). */
const HEX_RUN = /[0-9a-f]{8,}/gi;
/** What sits either side of a name standing alone: not a letter, digit or underscore, in any script. */
const NAME_EDGE_BEFORE = '(?<![\\p{L}\\p{N}_])';
const NAME_EDGE_AFTER = '(?![\\p{L}\\p{N}_])';
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A name is looked for only if it has a letter in it: one made of digits and punctuation (`12`, `-`) mostly hits dates and counts. */
const HAS_LETTER = /\p{L}/u;

/**
 * Finds a member's name and keys in text and takes them out (what scrubMemberFromLogs does to a log line, and what the
 * purge does to the push notices kept for other members). `text` is for free text; `json` is for a JSON document kept as
 * text: it replaces only inside string values (a callsign `True`, `null` or `12` must not turn a bare JSON literal or number
 * into words), and falls back to `text` only when the document does not parse. `none` is true when there is nothing to look for.
 */
export function makeMemberScrubber(callsign: string | null | undefined, keys: readonly string[], replacement: string = DELETED_MEMBER_IN_LOGS) {
    const name = typeof callsign === 'string' ? callsign.trim() : '';
    const keysLower = keys.filter((k) => typeof k === 'string' && k.length >= 8).map((k) => k.toLowerCase());
    const names = name.length >= 2 && HAS_LETTER.test(name) ? [...new Set([name, JSON.stringify(name).slice(1, -1)])] : [];
    const namePattern = names.length > 0
        ? new RegExp(`${NAME_EDGE_BEFORE}(?:${names.map(escapeRegExp).join('|')})${NAME_EDGE_AFTER}`, 'giu')
        : null;
    const isKeyPart = (run: string) => {
        const r = run.toLowerCase();
        return keysLower.some((k) => k.startsWith(r) || k.endsWith(r));
    };
    // The name first: the words that replace it hold no hex run, and a name like "member" would otherwise be found again
    // inside them.
    const text = (t: string | null): string | null => {
        if (t == null) return t;
        let out = namePattern ? t.replace(namePattern, replacement) : t;
        if (keysLower.length > 0) out = out.replace(HEX_RUN, (run) => (isKeyPart(run) ? replacement : run));
        return out;
    };
    const walk = (v: unknown): unknown => {
        if (typeof v === 'string') return text(v);
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const o: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x);
            return o;
        }
        return v;
    };
    const json = (t: string | null): string | null => {
        if (t == null || t === '') return t;
        let parsed: unknown;
        try { parsed = JSON.parse(t); } catch { return text(t); }
        const out = JSON.stringify(walk(parsed));
        // Nothing found: keep the stored text exactly (JSON.stringify may spell it differently).
        return out === JSON.stringify(parsed) ? t : out;
    };
    return { text, json, none: names.length === 0 && keysLower.length === 0 };
}

/**
 * Delete account (data-at-rest report F5): take a member's name and keys out of every line in system_logs, in place. Each
 * becomes DELETED_MEMBER_IN_LOGS:
 *   - the name, standing alone (not inside a longer word), any case, as written or as JSON writes it in metadata;
 *   - any run of 8 or more hex characters that starts or ends one of `keys` (a line shows a key's first 8, 10, 12 or 16
 *     characters; sanitizeMessage already takes out a whole one). Pass the key and the keys a re-key replaced.
 * Inside the caller's transaction, so the lines change with the account or not at all, and the WAL the purge empties
 * after holds them too. A name shorter than 2 characters is not looked for: it would take letters out of every line.
 * A name that is also an ordinary word takes that word out of older lines too: a line that reads oddly is the price.
 * Every line is read (LOG_KEEP_ROWS, about a hundred more between prunes): a LIKE would miss a name in another script
 * written in another case. The lines Clean storage archived (archivedLogsDir) lose them too, once the caller's transaction
 * has committed. Docker's own log of the server is out of reach (docker-compose.yml rotates it). Returns how many lines
 * of the table changed.
 */
export function scrubMemberFromLogs(callsign: string | null | undefined, keys: readonly string[]): number {
    const scrubber = makeMemberScrubber(callsign, keys);
    if (scrubber.none) return 0;
    const scrub = scrubber.text;
    const scrubJson = scrubber.json;
    const rows = db.prepare('SELECT id, message, metadata FROM system_logs').all() as
        { id: number; message: string; metadata: string | null }[];
    const update = db.prepare('UPDATE system_logs SET message = ?, metadata = ? WHERE id = ?');
    let changed = 0;
    for (const r of rows) {
        const message = scrub(r.message) ?? '';
        const metadata = scrubJson(r.metadata);
        if (message !== r.message || metadata !== r.metadata) {
            update.run(message, metadata, r.id);
            changed++;
        }
    }
    // The lines Clean storage moved out of the table, once the purge has committed: files are no part of its transaction.
    afterTransactionCommit(() => {
        editLogArchives((archived) => archived.map((r) => {
            if (!r || typeof r !== 'object') return r;
            const message = typeof r.message === 'string' ? scrub(r.message) : r.message;
            const metadata = typeof r.metadata === 'string' ? scrubJson(r.metadata) : r.metadata;
            return message === r.message && metadata === r.metadata ? r : { ...r, message, metadata };
        }));
    });
    return changed;
}

export const logger = {
    info: (category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS', message: string, metadata?: any) => writeLog('INFO', category, message, metadata),
    warn: (category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS', message: string, metadata?: any) => writeLog('WARN', category, message, metadata),
    error: (category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS', message: string, metadata?: any) => writeLog('ERROR', category, message, metadata),
    security: (category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS', message: string, metadata?: any) => writeLog('SECURITY', category, message, metadata),
    sync: (category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS', message: string, metadata?: any) => writeLog('SYNC', category, message, metadata),
};
