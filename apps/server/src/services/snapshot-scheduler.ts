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
 *
 * ## A snapshot carries its own images (storage design §7)
 *
 * Once the image evacuation has run, a row holds a `storage_key` and no bytes, so `VACUUM INTO` alone no
 * longer describes a node: the snapshot would resolve its keys against whatever the LIVE store happened to
 * hold on the day somebody downloaded it. A photo replaced at 05:00 unlinks the object a 02:00 snapshot
 * needs, and the recovery point quietly stops being one.
 *
 * So every snapshot captures the objects its own database references, into `<snapshot>.images/`, in the same
 * breath as the VACUUM. Store objects are content-addressed and written temp-then-rename, so a file is never
 * rewritten in place and a **hard link** is a true point-in-time copy of it: near-zero disk until the live
 * copy is unlinked, and nothing the live node does afterwards can reach it. Where a link cannot be made (a
 * different filesystem) the bytes are copied instead; if neither works the snapshot fails rather than
 * pretending. A snapshot's image directory is deleted with the snapshot, by pruning and by the delete route.
 *
 * The directory is a SIBLING of the `.db` file, named `<snapshot>.images`, so it never ends in `.db`:
 * {@link listSnapshots} and {@link resolveSnapshotPath} keep seeing snapshots and nothing else.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db } from '../db/db.js';
import { logger } from '../logger.js';
import { assertSafeKey, imagesDir } from '../storage/image-store.js';
import { referencedStorageKeys } from '../storage/image-columns.js';

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
    /** Whether this snapshot carries its own copy of the image store. False for one taken before that landed. */
    hasImages: boolean;
}

/** What a snapshot's image capture did, for the log and for the caller that has to decide it was enough. */
export interface SnapshotImages {
    /** Objects the snapshot's own database references. */
    referenced: number;
    /** Objects now in `<snapshot>.images/`. */
    captured: number;
    /** Of those, how many were hard links rather than copies — the cheap case. */
    linked: number;
    bytes: number;
    /** Referenced keys the LIVE store no longer held: data already lost before this snapshot was taken. */
    missing: string[];
}

function ensureDir(): void {
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
        fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
}

/** Where a snapshot keeps the objects its own database references. A sibling of the `.db`, never inside it. */
export function snapshotImagesDir(snapshotPath: string): string {
    return `${snapshotPath}.images`;
}

/**
 * Capture, beside `snapshotDbPath`, every store object that snapshot's database references.
 *
 * Hard link first: an object is content-addressed and written temp-then-rename, so its inode is never
 * rewritten and a second name for it is a true point-in-time copy for no disk at all. `EXDEV` (a store on a
 * different filesystem), `EPERM` (a filesystem that will not link) and `EMLINK` (out of link slots) fall back
 * to copying the bytes. Anything else — EACCES, ENOSPC, a store root that cannot be read — throws, and the
 * caller destroys the half-made snapshot rather than keeping one that is quietly short.
 *
 * A referenced key the live store does NOT hold is reported in `missing` and does not throw. Those bytes were
 * already gone before this snapshot started; refusing to take it would remove the ledger, the members and the
 * posts from the operator's reach as well, over a photo no snapshot can bring back.
 */
export function captureSnapshotImages(snapshotDbPath: string, storeRoot = imagesDir(DATA_DIR)): SnapshotImages {
    const out: SnapshotImages = { referenced: 0, captured: 0, linked: 0, bytes: 0, missing: [] };
    const snapDb = new Database(snapshotDbPath, { readonly: true });
    let keys: string[];
    try {
        keys = referencedStorageKeys(snapDb);
    } finally {
        try { snapDb.close(); } catch { /* the read is done */ }
    }
    out.referenced = keys.length;
    if (keys.length === 0) return out;

    const dest = snapshotImagesDir(snapshotDbPath);
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const key of keys) {
        // A storage_key comes out of a row, and rows arrive from federation peers and restored backups, so
        // it is checked before it is ever turned into a path — the same rule the store itself applies.
        try { assertSafeKey(key); } catch { out.missing.push(key); continue; }
        const from = path.join(storeRoot, key);
        const to = path.join(dest, key);
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        let linked = true;
        try {
            fs.linkSync(from, to);
        } catch (e: any) {
            if (e?.code === 'ENOENT') { out.missing.push(key); continue; }
            if (e?.code === 'EEXIST') { /* a re-run over the same snapshot: already captured */ }
            else if (e?.code === 'EXDEV' || e?.code === 'EPERM' || e?.code === 'EMLINK' || e?.code === 'ENOSYS') {
                linked = false;
                try {
                    fs.copyFileSync(from, to);
                } catch (copyErr: any) {
                    if (copyErr?.code === 'ENOENT') { out.missing.push(key); continue; }
                    throw copyErr;
                }
            } else {
                throw e;
            }
        }
        out.captured++;
        if (linked) out.linked++;
        try { out.bytes += fs.statSync(to).size; } catch { /* the count is the part that matters */ }
    }
    return out;
}

/** Remove a snapshot's captured images. Best effort: a snapshot with no image directory is the old shape. */
function removeSnapshotImages(snapshotPath: string): void {
    try {
        fs.rmSync(snapshotImagesDir(snapshotPath), { recursive: true, force: true });
    } catch (e) {
        logger.warn('SYS', `[Snapshots] Could not remove the images beside ${path.basename(snapshotPath)}: ${(e as any)?.message || e}`);
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
                const full = path.join(SNAPSHOTS_DIR, name);
                const st = fs.statSync(full);
                return { name, sizeBytes: st.size, createdAt: st.mtimeMs, hasImages: fs.existsSync(snapshotImagesDir(full)) };
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
            const full = path.join(SNAPSHOTS_DIR, s.name);
            // The images first: a directory left behind by a failed unlink would be swept up by nothing,
            // and `listSnapshots` would no longer name the snapshot it belonged to.
            removeSnapshotImages(full);
            fs.unlinkSync(full);
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
        // The name is the timestamp to the second, so a second create inside the same second writes over the
        // first. `writeDbSnapshot` unlinks the old .db; its captured images have to go the same way, or the
        // new snapshot would inherit objects belonging to a database it is replacing.
        removeSnapshotImages(dest);
        writeDbSnapshot(dest);
        // Immediately, and inside the same `creating` guard: the snapshot is a recovery point only if the
        // objects its rows name are captured before anything can unlink them (see the note at the top).
        let images: SnapshotImages;
        try {
            images = captureSnapshotImages(dest);
        } catch (e) {
            removeSnapshotImages(dest);
            try { fs.unlinkSync(dest); } catch { /* it may already be gone */ }
            throw new Error(`Snapshot failed: the image store could not be captured, so this would not be a recovery point (${(e as any)?.message || e})`);
        }
        const st = fs.statSync(dest);
        prune(getAutoSnapshotConfig().keep);
        logger.info('SYS', `[Snapshots] Created snapshot ${name} (${st.size} bytes) with ${images.captured}/${images.referenced} image object(s), ${images.linked} hard-linked`);
        if (images.missing.length > 0) {
            // Loud: these bytes were gone before the snapshot started, so every earlier backup is short too.
            logger.warn('SYS', `[Snapshots] ${name} references ${images.missing.length} object(s) the store no longer holds — `
                + `those photos or attachments are already lost. First: ${images.missing.slice(0, 3).join(', ')}`);
        }
        return { name, sizeBytes: st.size, createdAt: st.mtimeMs, hasImages: images.referenced > 0 };
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
