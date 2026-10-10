/**
 * Unclean Shutdown Diagnostic & Recovery Manager.
 *
 * Tracks node uptime sentinel to detect power loss or sudden crashes.
 * On boot after an unclean shutdown:
 * 1. Runs SQLite `PRAGMA integrity_check` to verify database health.
 * 2. Emits a plain-language status:
 *    - Reassurance card when verified ("Recovered from power loss at 04:12. Database verified, no corruption.")
 *    - Loud critical warning when corruption is detected.
 * 3. Persists recovery state until acknowledged by the node operator.
 */

import fs from 'node:fs';
import { writeFileAtomic } from '../write-file-atomic.js';
import path from 'node:path';
import { db as defaultDb, closeDbDataVersionProbe } from '../db/db.js';
import { closeOpenCopies } from './open-copies.js';

export interface ShutdownStatus {
    uncleanShutdown: boolean;
    recovered?: boolean;
    ok?: boolean;
    powerLossAt?: string;
    powerLossTimestamp?: string;
    message?: string;
    error?: string;
    checkedAt?: string;
    acknowledged?: boolean;
}

interface SentinelFile {
    running: boolean;
    startedAt: string;
    lastHeartbeat: string;
    pid?: number;
    stoppedAt?: string;
}

let activeShutdownStatus: ShutdownStatus = { uncleanShutdown: false };
/** Whether this start found the last run's sentinel still saying running (not an old, unacknowledged report). */
let thisStartFollowedUncleanStop = false;
let heartbeatTimer: NodeJS.Timeout | null = null;
let currentDataDir: string = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
let cleanShutdownRegistered = false;

function formatPowerLossTime(isoTimestamp?: string): string {
    if (!isoTimestamp) {
        const now = new Date();
        return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
    const match = isoTimestamp.match(/T(\d{2}:\d{2})/);
    if (match) {
        return match[1];
    }
    const d = new Date(isoTimestamp);
    if (isNaN(d.getTime())) {
        return '04:12';
    }
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

export function getShutdownSentinelPath(dataDir: string): string {
    return path.join(dataDir, 'shutdown-sentinel.json');
}

export function getShutdownReportPath(dataDir: string): string {
    return path.join(dataDir, 'last-shutdown-report.json');
}

/**
 * Initialize shutdown recovery detection and begin heartbeat monitoring.
 */
export function initShutdownRecovery(options?: {
    db?: any;
    dataDir?: string;
    heartbeatIntervalMs?: number;
}): ShutdownStatus {
    const db = options?.db || defaultDb;
    currentDataDir = options?.dataDir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

    try {
        if (!fs.existsSync(currentDataDir)) {
            fs.mkdirSync(currentDataDir, { recursive: true });
        }
    } catch {}

    const sentinelPath = getShutdownSentinelPath(currentDataDir);
    const reportPath = getShutdownReportPath(currentDataDir);

    let priorSentinel: SentinelFile | null = null;
    if (fs.existsSync(sentinelPath)) {
        try {
            priorSentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        } catch {}
    }

    thisStartFollowedUncleanStop = !!(priorSentinel && priorSentinel.running === true);
    if (priorSentinel && priorSentinel.running === true) {
        // Unclean shutdown occurred! (Power loss, SIGKILL, crash)
        const powerLossTime = formatPowerLossTime(priorSentinel.lastHeartbeat);

        let checkResult: any[] = [];
        try {
            checkResult = db.pragma('integrity_check') as any[];
        } catch (e: any) {
            checkResult = [{ integrity_check: e?.message || 'PRAGMA integrity_check failed' }];
        }

        const isOk = Array.isArray(checkResult) && checkResult.length === 1 && checkResult[0]?.integrity_check === 'ok';

        if (isOk) {
            activeShutdownStatus = {
                uncleanShutdown: true,
                recovered: true,
                ok: true,
                powerLossAt: powerLossTime,
                powerLossTimestamp: priorSentinel.lastHeartbeat,
                message: `Recovered from power loss at ${powerLossTime}. Database verified, no corruption.`,
                checkedAt: new Date().toISOString(),
                acknowledged: false,
            };
        } else {
            const errorStr = Array.isArray(checkResult)
                ? checkResult.map((r) => r?.integrity_check || JSON.stringify(r)).join('; ')
                : 'Integrity check error';
            activeShutdownStatus = {
                uncleanShutdown: true,
                recovered: false,
                ok: false,
                powerLossAt: powerLossTime,
                powerLossTimestamp: priorSentinel.lastHeartbeat,
                error: errorStr,
                message: `Database corruption detected after power loss at ${powerLossTime}! Corruption details: ${errorStr}`,
                checkedAt: new Date().toISOString(),
                acknowledged: false,
            };
        }

        try {
            writeFileAtomic(reportPath, JSON.stringify(activeShutdownStatus, null, 2));
        } catch {}
    } else {
        // Previous stop was clean. Check if an unacknowledged report remains.
        if (fs.existsSync(reportPath)) {
            try {
                const savedReport = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as ShutdownStatus;
                if (savedReport && savedReport.uncleanShutdown && !savedReport.acknowledged) {
                    activeShutdownStatus = savedReport;
                } else {
                    activeShutdownStatus = { uncleanShutdown: false };
                }
            } catch {
                activeShutdownStatus = { uncleanShutdown: false };
            }
        } else {
            activeShutdownStatus = { uncleanShutdown: false };
        }
    }

    // Write fresh active sentinel
    const freshSentinel: SentinelFile = {
        running: true,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        pid: process.pid,
    };
    try {
        writeFileAtomic(sentinelPath, JSON.stringify(freshSentinel, null, 2));
    } catch {}

    // Start heartbeat
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const interval = options?.heartbeatIntervalMs ?? 15_000;
    heartbeatTimer = setInterval(() => {
        try {
            if (fs.existsSync(sentinelPath)) {
                const current = JSON.parse(fs.readFileSync(sentinelPath, 'utf8')) as SentinelFile;
                current.lastHeartbeat = new Date().toISOString();
                writeFileAtomic(sentinelPath, JSON.stringify(current, null, 2));
            }
        } catch {}
    }, interval);
    heartbeatTimer.unref();

    currentDb = db;
    if (!cleanShutdownRegistered) {
        cleanShutdownRegistered = true;
        const onExit = (code: number) => {
            if (code === 0 && !stopLeftUnclean) {
                markCleanShutdown();
            }
        };
        process.once('exit', onExit);
        // `on`, not `once`: in a container the node is PID 1, and PID 1 ignores a signal it has no handler for, so a second
        // signal after a `once` would do nothing at all.
        process.on('SIGINT', () => stopOnSignal('SIGINT'));
        process.on('SIGTERM', () => stopOnSignal('SIGTERM'));
    }

    return activeShutdownStatus;
}

let currentDb: any = null;
let stopping = false;
let stopLeftUnclean = false;

/**
 * A stop asked for (docker stop, docker compose up recreating the container, Ctrl-C): close the database, then mark the
 * stop clean, then exit. Everything here is synchronous, so no request or timer runs in between and the stop takes
 * milliseconds (measured: 13 ms on a fresh node), well inside Docker's 10 s before it kills. The checkpoint at close waits
 * for a lock at most STOP_BUSY_TIMEOUT_MS; past that SQLite leaves the WAL for the next open, which is still a clean stop.
 * A database that does not close leaves the sentinel saying running, so the next start checks it and the owners are told.
 * A second signal while a stop is under way exits at once.
 */
const STOP_BUSY_TIMEOUT_MS = 1000;
function stopOnSignal(signal: NodeJS.Signals): void {
    if (stopping) {
        console.warn(`🛑 ${signal} again while stopping: exiting now.`);
        stopLeftUnclean = true;
        process.exit(signal === 'SIGINT' ? 130 : 143);
    }
    stopping = true;
    const startedAt = Date.now();
    console.log(`🛑 ${signal}: closing the database, then stopping.`);
    const closed = closeDatabaseForStop();
    if (closed) {
        markCleanShutdown();
        console.log(`🛑 Stopped cleanly in ${Date.now() - startedAt} ms.`);
        process.exit(0);
    }
    stopLeftUnclean = true;
    console.error(`🛑 The database did not close (${Date.now() - startedAt} ms); the next start checks it.`);
    process.exit(1);
}

/** True once the database is closed: copies being served and the change probe first, so the main connection's close is the last one and folds the WAL in. */
function closeDatabaseForStop(): boolean {
    const db = currentDb;
    if (!db || db.open === false) return true;
    try { closeOpenCopies('the server is stopping'); } catch { /* the close below still runs */ }
    closeDbDataVersionProbe();
    try {
        if (db.inTransaction) console.warn('🛑 A write was still open; it is rolled back, as a kill would.');
        try { db.pragma(`busy_timeout = ${STOP_BUSY_TIMEOUT_MS}`); } catch { /* the close below still runs */ }
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e: any) { console.warn(`🛑 Checkpoint skipped: ${e?.message ?? e}`); }
        db.close();
        return true;
    } catch (e: any) {
        console.error(`🛑 Closing the database failed: ${e?.message ?? e}`);
        return false;
    }
}

/**
 * Mark shutdown as clean so next boot knows no power loss occurred.
 */
export function markCleanShutdown(dataDir?: string): void {
    const dir = dataDir || currentDataDir;
    const sentinelPath = getShutdownSentinelPath(dir);
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    try {
        if (fs.existsSync(sentinelPath)) {
            const current = JSON.parse(fs.readFileSync(sentinelPath, 'utf8')) as SentinelFile;
            current.running = false;
            current.stoppedAt = new Date().toISOString();
            writeFileAtomic(sentinelPath, JSON.stringify(current, null, 2));
        } else {
            const cleanSentinel: SentinelFile = {
                running: false,
                startedAt: new Date().toISOString(),
                lastHeartbeat: new Date().toISOString(),
                stoppedAt: new Date().toISOString(),
                pid: process.pid,
            };
            writeFileAtomic(sentinelPath, JSON.stringify(cleanSentinel, null, 2));
        }
    } catch {}
}

/**
 * Get current shutdown/recovery status.
 */
export function getShutdownStatus(): ShutdownStatus {
    return activeShutdownStatus;
}

/**
 * Whether this start came after a stop that was not clean (a crash, a kill, power): the alerts' crash-loop row counts
 * only these, so `docker compose up -d` three times in a row is no crash loop. An unclean stop already acknowledged,
 * or reported at an earlier start, is not this start's.
 */
export function startFollowedUncleanStop(): boolean {
    return thisStartFollowedUncleanStop;
}

/**
 * Acknowledge an unclean shutdown notification.
 */
export function acknowledgeShutdownRecovery(dataDir?: string): ShutdownStatus {
    const dir = dataDir || currentDataDir;
    const reportPath = getShutdownReportPath(dir);
    activeShutdownStatus = {
        ...activeShutdownStatus,
        acknowledged: true,
    };
    try {
        writeFileAtomic(reportPath, JSON.stringify(activeShutdownStatus, null, 2));
    } catch {}
    return activeShutdownStatus;
}

/**
 * Set simulated recovery status (useful for unit/integration tests).
 */
export function setShutdownStatusForTesting(status: ShutdownStatus): void {
    activeShutdownStatus = status;
}
