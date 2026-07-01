/**
 * Snapshot Scheduler — automatic on-disk DB snapshots (Backup tab)
 *
 * Periodically writes a consistent SQLite snapshot of the live database into
 * `data/snapshots/` with a timestamped filename, pruning to the most recent N.
 * This is a LOCAL point-in-time archive (separate from the one-directional live
 * backup puller and the manual Download Backup tar) — it lets an operator roll
 * back to a recent good state from the machine itself.
 *
 * The snapshot uses SQLite `VACUUM INTO` for a crash-consistent copy with no WAL
 * corruption risk — the same mechanism the manual /api/local/admin/backup route
 * uses (see `writeDbSnapshot` below, shared with that handler).
 *
 * Config is persisted in the `node_config` table under the key
 * `autosnapshot_config` = { enabled, intervalHours, keep }. Defaults:
 * enabled=true, intervalHours=24 (daily), keep=7.
 *
 * IMPORTANT: snapshots live UNDER data/ but the manual backup tar deliberately
 * excludes data/snapshots/ (it snapshots state.db via VACUUM INTO a temp dir and
 * tars only that), so backups never recursively swallow prior snapshots.
 */

import fs from 'node:fs';
import path from 'node:path';
import { db } from './db/db.js';
import { logger } from './logger.js';

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
export const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
const SNAPSHOT_PREFIX = 'snapshot-';
const SNAPSHOT_EXT = '.db';

export interface AutoSnapshotConfig {
    enabled: boolean;
    intervalHours: number;
    keep: number;
}

export const DEFAULT_AUTOSNAPSHOT_CONFIG: AutoSnapshotConfig = {
    enabled: true,
    intervalHours: 24,
    keep: 7,
};

let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let creating = false;

/**
 * Shared helper: write a consistent SQLite snapshot of the live DB to `destPath`
 * using VACUUM INTO. Reused by both the auto-snapshot scheduler and the manual
 * /api/local/admin/backup route so the snapshot mechanism stays in one place.
 */
export function writeDbSnapshot(destPath: string): void {
    // VACUUM INTO writes a fresh, defragmented, crash-consistent copy. The
    // destination must not already exist.
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

// ===================== CONFIG =====================

export function getAutoSnapshotConfig(): AutoSnapshotConfig {
    try {
        const row = db.prepare("SELECT value FROM node_config WHERE key='autosnapshot_config'").get() as any;
        const stored = row ? JSON.parse(row.value) : {};
        return {
            enabled: stored.enabled !== undefined ? !!stored.enabled : DEFAULT_AUTOSNAPSHOT_CONFIG.enabled,
            intervalHours: Number.isFinite(stored.intervalHours) && stored.intervalHours > 0
                ? Math.round(stored.intervalHours) : DEFAULT_AUTOSNAPSHOT_CONFIG.intervalHours,
            keep: Number.isFinite(stored.keep) && stored.keep > 0
                ? Math.round(stored.keep) : DEFAULT_AUTOSNAPSHOT_CONFIG.keep,
        };
    } catch (e) {
        logger.warn('SYS', `[Snapshots] Failed to read autosnapshot_config: ${(e as any)?.message || e}`);
        return { ...DEFAULT_AUTOSNAPSHOT_CONFIG };
    }
}

export function updateAutoSnapshotConfig(update: Partial<AutoSnapshotConfig>): AutoSnapshotConfig {
    const current = getAutoSnapshotConfig();
    const next: AutoSnapshotConfig = {
        enabled: update.enabled !== undefined ? !!update.enabled : current.enabled,
        // Clamp to sane bounds: at least 1 hour, at least 1 kept snapshot.
        intervalHours: update.intervalHours !== undefined
            ? Math.max(1, Math.round(Number(update.intervalHours) || current.intervalHours))
            : current.intervalHours,
        keep: update.keep !== undefined
            ? Math.max(1, Math.round(Number(update.keep) || current.keep))
            : current.keep,
    };
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('autosnapshot_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(next));
    // Re-arm the timer so interval/enabled changes take effect immediately.
    restartScheduler();
    return next;
}

// ===================== SNAPSHOT FILES =====================

export interface SnapshotInfo {
    name: string;
    sizeBytes: number;
    createdAt: number; // epoch ms (file mtime)
}

function ensureDir(): void {
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
        fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
}

/**
 * Resolve a caller-supplied snapshot name to an absolute path INSIDE
 * SNAPSHOTS_DIR, or return null if it would traverse outside (path-traversal
 * defence). Only a bare basename ending in our extension is accepted.
 */
export function resolveSnapshotPath(name: string): string | null {
    if (typeof name !== 'string' || !name) return null;
    // Reject anything that isn't a plain basename (no separators, no '..').
    if (name !== path.basename(name)) return null;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
    if (!name.endsWith(SNAPSHOT_EXT)) return null;
    const resolved = path.resolve(SNAPSHOTS_DIR, name);
    // Belt-and-braces: the resolved path must sit directly inside SNAPSHOTS_DIR.
    if (path.dirname(resolved) !== path.resolve(SNAPSHOTS_DIR)) return null;
    return resolved;
}

export function listSnapshots(): SnapshotInfo[] {
    ensureDir();
    try {
        return fs.readdirSync(SNAPSHOTS_DIR)
            .filter(f => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith(SNAPSHOT_EXT))
            .map(name => {
                const st = fs.statSync(path.join(SNAPSHOTS_DIR, name));
                return { name, sizeBytes: st.size, createdAt: st.mtimeMs };
            })
            .sort((a, b) => b.createdAt - a.createdAt); // newest first
    } catch (e) {
        logger.warn('SYS', `[Snapshots] Failed to list: ${(e as any)?.message || e}`);
        return [];
    }
}

/** Delete snapshots beyond the configured `keep` count (oldest first). */
function prune(keep: number): void {
    const all = listSnapshots(); // newest first
    const stale = all.slice(keep);
    for (const s of stale) {
        try {
            fs.unlinkSync(path.join(SNAPSHOTS_DIR, s.name));
            logger.info('SYS', `[Snapshots] Pruned old snapshot ${s.name}`);
        } catch (e) {
            logger.warn('SYS', `[Snapshots] Failed to prune ${s.name}: ${(e as any)?.message || e}`);
        }
    }
}

/**
 * Create a single timestamped snapshot now and prune to `keep`. Returns the new
 * snapshot's filename. Never overlaps with a concurrent create.
 */
export function createSnapshot(): SnapshotInfo {
    if (creating) throw new Error('A snapshot is already being created');
    creating = true;
    try {
        ensureDir();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const name = `${SNAPSHOT_PREFIX}${timestamp}${SNAPSHOT_EXT}`;
        const dest = path.join(SNAPSHOTS_DIR, name);
        writeDbSnapshot(dest);
        const st = fs.statSync(dest);
        prune(getAutoSnapshotConfig().keep);
        logger.info('SYS', `[Snapshots] Created snapshot ${name} (${st.size} bytes)`);
        return { name, sizeBytes: st.size, createdAt: st.mtimeMs };
    } finally {
        creating = false;
    }
}

// ===================== SCHEDULER =====================

function arm(): void {
    const cfg = getAutoSnapshotConfig();
    if (!cfg.enabled) {
        logger.info('SYS', '[Snapshots] Auto-snapshots disabled.');
        return;
    }
    const intervalMs = cfg.intervalHours * 60 * 60 * 1000;
    logger.info('SYS', `[Snapshots] Auto-snapshots enabled — every ${cfg.intervalHours}h, keeping ${cfg.keep}.`);
    snapshotTimer = setInterval(() => {
        try { createSnapshot(); }
        catch (e) { logger.warn('SYS', `[Snapshots] Scheduled snapshot failed: ${(e as any)?.message || e}`); }
    }, intervalMs);
}

/** Initialize the scheduler. Call once after initStateEngine(). */
export function initSnapshotScheduler(): void {
    ensureDir();
    arm();
}

/** Re-read config and re-arm the timer (used when config changes). */
export function restartScheduler(): void {
    if (snapshotTimer) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
    }
    arm();
}
