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
 * ## How long a snapshot lives (data-at-rest report F3)
 *
 * A snapshot is the whole database, so a member who deletes their account is still in every snapshot taken before,
 * until that snapshot goes. So a snapshot goes on two counts, whichever comes first: when newer ones push it past
 * `keep` (at most {@link MAX_SNAPSHOTS_KEPT}), and when it is {@link SNAPSHOT_MAX_AGE_DAYS} days old. Every server
 * checks both every hour ({@link expireSnapshots}), whatever its role and whether snapshots are on, so one an operator
 * took by hand, one a standby took before it stopped taking them, and the last ones of a server whose schedule was
 * turned off all go too. With the defaults, a deleted member's data is in snapshots for up to 7 days; never more
 * than 14.
 *
 * ## The main server only
 *
 * The scheduler takes snapshots on the main server alone. A standby's database is its main server's, copied; its own
 * snapshots were a second set of the same community's data, on a second machine, kept for a week. So `arm()` reads the
 * role each time it runs (index.ts arms it once the role is loaded, after step 2.6), each tick checks it again, and a
 * role change in this process (config/node-role.ts setNodeRole: a take-over finished at boot) re-arms: a promoted
 * standby starts, a demoted main server stops.
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
 *
 * ## On an S3 node a snapshot is the database only (IMAGE_STORE=s3)
 *
 * There is nothing to hard-link in a bucket, and copying every object out of it daily is the global node's
 * whole photo library through a small server's disk. So an s3 node's snapshot captures no objects: its keys
 * resolve against the bucket, its download says `in-bucket` like any backup from that node, and a photo
 * deleted from the bucket after the snapshot was taken does not come back from it — which the log says each
 * time. A restore measures exactly which of its keys the bucket still holds.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db } from '../db/db.js';
import { logger } from '../logger.js';
import { getNodeRole, onNodeRoleChange } from '../config/node-role.js';
import { assertSafeKey, bucketOf, copyObjectReplacing, getImageStore, imagesDir } from '../storage/image-store.js';
import { referencedStorageKeys } from '../storage/image-columns.js';
import { copyWithoutAddresses } from './address-retention.js';

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

/**
 * The most snapshots a server keeps. The settings route refuses more; a row that says more (written before the cap, or
 * brought back by a restore or a kept community settings record) is read as this.
 */
export const MAX_SNAPSHOTS_KEPT = 14;
export function isAutoSnapshotKeep(v: unknown): v is number {
    return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_SNAPSHOTS_KEPT;
}
/** A number of snapshots to keep, 1 to {@link MAX_SNAPSHOTS_KEPT}. */
const keptCount = (n: number): number => Math.min(MAX_SNAPSHOTS_KEPT, Math.max(1, Math.round(n)));

/** No snapshot is kept past this age, whatever `keep` says. */
export const SNAPSHOT_MAX_AGE_DAYS = 14;
export const SNAPSHOT_MAX_AGE_MS = SNAPSHOT_MAX_AGE_DAYS * 24 * 60 * 60_000;
/** How often every server removes the snapshots past their count or age. */
const EXPIRE_EVERY_MS = 60 * 60_000;

/**
 * How often a snapshot is taken, in whole hours. The scheduler's timer can't wait longer than 2^31 - 1 ms (596 hours):
 * past that, or an interval that rounds to nothing, Node fires it every millisecond, a VACUUM INTO after another until
 * the disk is full. The admin route (routes/backup.ts) and a kept community settings record
 * (config/community-settings.ts) take only this; the Backup tab offers 6 to 48.
 */
export const MAX_AUTOSNAPSHOT_INTERVAL_HOURS = Math.floor((2 ** 31 - 1) / 3_600_000);
export function isAutoSnapshotInterval(v: unknown): v is number {
    return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_AUTOSNAPSHOT_INTERVAL_HOURS;
}
/** A number of hours the timer can hold. A row written before the bound, or brought back by a restore, is read through it. */
const timerHours = (h: number): number => Math.min(MAX_AUTOSNAPSHOT_INTERVAL_HOURS, Math.max(1, Math.round(h)));

let snapshotTimer: ReturnType<typeof setInterval> | null = null;
/** The interval the running timer was armed with, in hours. */
let armedHours: number | null = null;
let creating = false;
/** Scheduled snapshots that failed since the last one that worked (services/alerts.ts tells the owners at two). */
let failuresInARow = 0;

export function snapshotFailuresInARow(): number {
    return failuresInARow;
}
/** The hourly expiry, on every role ({@link expireSnapshots}). */
let expiryTimer: ReturnType<typeof setInterval> | null = null;
/** Set by initSnapshotScheduler: from then on a role change re-arms. */
let initialized = false;

/**
 * Shared helper: write a consistent SQLite snapshot of the live DB to `destPath`
 * using VACUUM INTO. Reused by both the auto-snapshot scheduler and the manual
 * /api/local/admin/backup route so the snapshot mechanism stays in one place.
 */
export function writeDbSnapshot(destPath: string): void {
    // VACUUM INTO writes a fresh, defragmented, crash-consistent copy. The
    // destination must not already exist.
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    // Every snapshot and backup is made here, and none keeps an internet address: a copy can be kept for weeks, and
    // this server keeps an address 7 days at most. The VACUUM INTO is made beside `destPath` and renamed into place
    // once it holds none (services/address-retention.ts).
    copyWithoutAddresses(db, destPath);
}

// ===================== CONFIG =====================

export function getAutoSnapshotConfig(): AutoSnapshotConfig {
    try {
        const row = db.prepare("SELECT value FROM node_config WHERE key='autosnapshot_config'").get() as any;
        const stored = row ? JSON.parse(row.value) : {};
        return {
            enabled: stored.enabled !== undefined ? !!stored.enabled : DEFAULT_AUTOSNAPSHOT_CONFIG.enabled,
            intervalHours: Number.isFinite(stored.intervalHours) && stored.intervalHours > 0
                ? timerHours(stored.intervalHours) : DEFAULT_AUTOSNAPSHOT_CONFIG.intervalHours,
            keep: Number.isFinite(stored.keep) && stored.keep > 0
                ? keptCount(stored.keep) : DEFAULT_AUTOSNAPSHOT_CONFIG.keep,
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
        // Clamp to sane bounds: 1 hour to what the timer can hold, 1 to MAX_SNAPSHOTS_KEPT kept snapshots (the route
        // refuses more; this is for any other caller).
        intervalHours: update.intervalHours !== undefined
            ? timerHours(Number(update.intervalHours) || current.intervalHours)
            : current.intervalHours,
        keep: update.keep !== undefined
            ? keptCount(Number(update.keep) || current.keep)
            : current.keep,
    };
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('autosnapshot_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(next));
    // Re-arm the timer so interval/enabled changes take effect immediately, and keep a lower `keep` at once.
    restartScheduler();
    expireSnapshots();
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
                    // `to` sits beside hard links to live store inodes, and a re-capture over an existing
                    // name would write through one. copyObjectReplacing renames into place instead.
                    copyObjectReplacing(from, to);
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

/**
 * Delete the snapshots beyond the newest `keep`, and every one {@link SNAPSHOT_MAX_AGE_DAYS} days old or more by its file
 * time, which is when it was taken (the address scrub keeps it, services/address-retention.ts). Returns how many.
 */
function prune(keep: number, now = Date.now()): number {
    const all = listSnapshots(); // newest first
    const cutoff = now - SNAPSHOT_MAX_AGE_MS;
    const stale = all.filter((s, i) => i >= keep || s.createdAt <= cutoff);
    let removed = 0;
    for (const s of stale) {
        try {
            const full = path.join(SNAPSHOTS_DIR, s.name);
            // The images first: a directory left behind by a failed unlink would be swept up by nothing,
            // and `listSnapshots` would no longer name the snapshot it belonged to.
            removeSnapshotImages(full);
            fs.unlinkSync(full);
            removed++;
            logger.info('SYS', s.createdAt <= cutoff
                ? `[Snapshots] Removed snapshot ${s.name}: it was ${SNAPSHOT_MAX_AGE_DAYS} days old`
                : `[Snapshots] Pruned old snapshot ${s.name}`);
        } catch (e) {
            logger.warn('SYS', `[Snapshots] Failed to prune ${s.name}: ${(e as any)?.message || e}`);
        }
    }
    return removed;
}

/**
 * Remove the snapshots past their count or their age, now. Every server runs it every hour (initSnapshotScheduler),
 * whatever its role and whether snapshots are on: a standby takes none but may hold some from before, and a server
 * with its schedule off still holds the last ones it took. Never throws. Returns how many went.
 */
export function expireSnapshots(now = Date.now()): number {
    if (creating) return 0; // the snapshot being taken prunes when it is done
    try {
        return prune(getAutoSnapshotConfig().keep, now);
    } catch (e) {
        logger.warn('SYS', `[Snapshots] Could not remove old snapshots: ${(e as any)?.message || e}`);
        return 0;
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
        // An s3 node: the objects stay in the bucket and nothing is captured (see the note at the top).
        const bucket = bucketOf(getImageStore());
        if (bucket) {
            const st = fs.statSync(dest);
            prune(getAutoSnapshotConfig().keep);
            logger.info('SYS', `[Snapshots] Created snapshot ${name} (${st.size} bytes): the database only — its photos and `
                + `attachments stay in ${bucket.where}, and one deleted from there after now does not come back from this snapshot`);
            return { name, sizeBytes: st.size, createdAt: st.mtimeMs, hasImages: false };
        }
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

/**
 * Arm the timer from the schedule row as it is now, replacing any timer already running: a standby promoted by hand
 * installs its community's schedule (config/community-settings.ts) and re-arms inside initStateEngine, before
 * initSnapshotScheduler arms again, and two timers would take every snapshot twice.
 */
function arm(): void {
    if (snapshotTimer) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
    }
    armedHours = null;
    // The main server only (see the note at the top). The schedule row stays as it is: a standby keeps its own, and its
    // main server's in the kept community settings, for the day it takes over.
    if (getNodeRole() !== 'primary') {
        logger.info('SYS', `[Snapshots] This server is a standby: it takes no snapshots (its main server does). `
            + `Any it took before are removed once they are ${SNAPSHOT_MAX_AGE_DAYS} days old.`);
        return;
    }
    const cfg = getAutoSnapshotConfig();
    if (!cfg.enabled) {
        logger.info('SYS', '[Snapshots] Auto-snapshots disabled.');
        return;
    }
    const intervalMs = cfg.intervalHours * 60 * 60 * 1000;
    logger.info('SYS', `[Snapshots] Auto-snapshots enabled — every ${cfg.intervalHours}h, keeping ${cfg.keep}, none older than ${SNAPSHOT_MAX_AGE_DAYS} days.`);
    snapshotTimer = setInterval(() => {
        // A role that changed without setNodeRole's announcement still stops it here, before a snapshot is taken.
        if (getNodeRole() !== 'primary') { arm(); return; }
        try { createSnapshot(); failuresInARow = 0; }
        catch (e) { failuresInARow++; logger.warn('SYS', `[Snapshots] Scheduled snapshot failed: ${(e as any)?.message || e}`); }
    }, intervalMs);
    armedHours = cfg.intervalHours;
}

/**
 * Initialize the scheduler: the snapshot timer for the role as it stands (call it once the role is loaded, after the
 * take-over resumes at boot, index.ts step 2.6), re-armed at every role change after; and, on every role, the hourly
 * expiry, run once now.
 */
export function initSnapshotScheduler(): void {
    ensureDir();
    if (!initialized) {
        initialized = true;
        onNodeRoleChange(() => arm());
    }
    arm();
    expireSnapshots();
    if (expiryTimer) clearInterval(expiryTimer);
    expiryTimer = setInterval(() => { expireSnapshots(); }, EXPIRE_EVERY_MS);
    expiryTimer.unref?.();
}

/** Re-read config and re-arm the timer (used when config changes). */
export function restartScheduler(): void {
    arm();
}

/**
 * How often the running timer takes a snapshot, in hours; null when none is running (snapshots are off, or the
 * scheduler never started). What this server does, which the schedule row alone doesn't say: a row written without a
 * re-arm is not the schedule until the next start.
 */
export function armedSnapshotInterval(): number | null {
    return snapshotTimer ? armedHours : null;
}
