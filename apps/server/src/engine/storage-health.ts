/**
 * Storage Health, Disk Breakdown & Pruning Service.
 *
 * Implements docs/settings-ia.md §5 item 3:
 * 1. Disk usage breakdown: database vs media vs logs.
 * 2. 80% safety warning threshold to prevent SD card runaway.
 * 3. One-click "clean orphaned media & compress logs" that previews
 *    what it will remove before performing the deletion.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { db as defaultDb } from '../db/db.js';
import { DiskImageStore, imagesDir, type ImageStore } from '../storage/image-store.js';
import { deleteStoredObjects } from '../storage/image-columns.js';

export interface DiskBreakdownItem {
    dbSizeBytes: number;
    walSizeBytes: number;
    shmSizeBytes: number;
    snapshotsSizeBytes: number;
    totalBytes: number;
}

export interface MediaBreakdownItem {
    /** Post photos still inline in `post_photos.photo_data`. Shrinks to 0 as the evacuation job runs. */
    postPhotosBytes: number;
    postPhotosCount: number;
    pulseThumbnailsBytes: number;
    pulseThumbnailsCount: number;
    /** Objects in the image store under `<data>/images` — where post photos and attachments live now. */
    imageStoreBytes: number;
    imageStoreCount: number;
    totalBytes: number;
}

export interface LogsBreakdownItem {
    systemLogsBytes: number;
    systemLogsCount: number;
    logFilesBytes: number;
    totalBytes: number;
}

export interface DiskHealth {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    warning: boolean; // true if usedPercent >= 80
    databaseBytes: number;
    mediaBytes: number;
    logsBytes: number;
    breakdown: {
        database: DiskBreakdownItem;
        media: MediaBreakdownItem;
        logs: LogsBreakdownItem;
    };
}

export interface StorageCleanPreview {
    orphanedPostPhotos: {
        count: number;
        totalBytes: number;
    };
    /** Store objects no row points at: a rolled-back write, or a row deleted while the disk was unavailable. */
    orphanedImageObjects: {
        count: number;
        totalBytes: number;
    };
    orphanedThumbnails: {
        count: number;
        totalBytes: number;
    };
    compressibleLogs: {
        count: number;
        totalBytes: number;
        oldestTimestamp?: string;
        newestTimestamp?: string;
    };
    totalReclaimableBytes: number;
}

export interface StorageCleanResult {
    success: boolean;
    removedPhotosCount: number;
    removedPhotosBytes: number;
    removedImageObjectsCount: number;
    removedImageObjectsBytes: number;
    removedThumbnailsCount: number;
    removedThumbnailsBytes: number;
    compressedLogsCount: number;
    compressedLogsBytes: number;
    totalReclaimedBytes: number;
}

let simulatedDiskUsagePercent: number | null = null;

export function setSimulatedDiskUsageForTesting(percent: number | null): void {
    simulatedDiskUsagePercent = percent;
}

/**
 * Calculates disk breakdown and capacity utilization for the community node.
 */
export function getDiskHealth(options?: { db?: any; dataDir?: string }): DiskHealth {
    const db = options?.db || defaultDb;
    const dataDir = options?.dataDir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

    // 1. Filesystem capacity via statfs
    let totalBytes = 64 * 1024 * 1024 * 1024; // Default 64 GB fallback
    let freeBytes = 32 * 1024 * 1024 * 1024;  // Default 32 GB fallback
    try {
        if (typeof fs.statfsSync === 'function') {
            const statfs = fs.statfsSync(dataDir);
            const bsize = statfs.bsize || 4096;
            totalBytes = Number(statfs.blocks) * bsize;
            freeBytes = Number(statfs.bavail) * bsize;
        }
    } catch {}

    let usedBytes = Math.max(0, totalBytes - freeBytes);
    let usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

    if (simulatedDiskUsagePercent !== null) {
        usedPercent = simulatedDiskUsagePercent;
        usedBytes = Math.round((totalBytes * usedPercent) / 100);
        freeBytes = totalBytes - usedBytes;
    }

    const warning = usedPercent >= 80;

    // 2. Database Breakdown
    const dbFile = path.join(dataDir, 'state.db');
    const walFile = `${dbFile}-wal`;
    const shmFile = `${dbFile}-shm`;
    const snapshotsDir = path.join(dataDir, 'snapshots');

    let dbSizeBytes = 0;
    let walSizeBytes = 0;
    let shmSizeBytes = 0;
    let snapshotsSizeBytes = 0;

    try {
        if (fs.existsSync(dbFile)) dbSizeBytes = fs.statSync(dbFile).size;
        if (fs.existsSync(walFile)) walSizeBytes = fs.statSync(walFile).size;
        if (fs.existsSync(shmFile)) shmSizeBytes = fs.statSync(shmFile).size;
        if (fs.existsSync(snapshotsDir)) {
            // The `.db` files only. A snapshot's `<name>.db.images/` beside them is a tree of hard links to
            // objects already counted under `imageStoreBytes`, so walking it would report the same bytes
            // twice — and once the live copy is unlinked they are the store's bytes still, just held by the
            // snapshot rather than by a row.
            for (const f of fs.readdirSync(snapshotsDir)) {
                try {
                    const snapPath = path.join(snapshotsDir, f);
                    const st = fs.statSync(snapPath);
                    if (st.isFile()) snapshotsSizeBytes += st.size;
                } catch {}
            }
        }
    } catch {}

    const databaseTotal = dbSizeBytes + walSizeBytes + shmSizeBytes + snapshotsSizeBytes;

    // 3. Media Breakdown
    let postPhotosBytes = 0;
    let postPhotosCount = 0;
    try {
        const row = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(LENGTH(photo_data)), 0) as bytes FROM post_photos').get() as any;
        postPhotosCount = row?.c || 0;
        postPhotosBytes = row?.bytes || 0;
    } catch {}

    // The image store: post photos and message attachments, once the evacuation job has moved them out of
    // the database. They are exactly the same media as `postPhotosBytes` above, counted where they now live,
    // so the two together are the node's media whatever stage of the migration it is at.
    let imageStoreBytes = 0;
    let imageStoreCount = 0;
    try {
        const store = new DiskImageStore(imagesDir(dataDir));
        for (const key of store.list('')) {
            const h = store.head(key);
            if (h) { imageStoreCount++; imageStoreBytes += h.bytes; }
        }
    } catch (e) {
        console.warn('[StorageHealth] Could not measure the image store:', e);
    }

    let pulseThumbnailsBytes = 0;
    let pulseThumbnailsCount = 0;
    const thumbDir = path.join(dataDir, 'cache', 'pulse-thumbnails');
    if (fs.existsSync(thumbDir)) {
        try {
            for (const f of fs.readdirSync(thumbDir)) {
                try {
                    const st = fs.statSync(path.join(thumbDir, f));
                    if (st.isFile()) {
                        if (f.endsWith('.bin')) {
                            pulseThumbnailsCount++;
                        }
                        pulseThumbnailsBytes += st.size;
                    }
                } catch {}
            }
        } catch {}
    }

    const mediaTotal = postPhotosBytes + pulseThumbnailsBytes + imageStoreBytes;

    // 4. Logs Breakdown
    let systemLogsCount = 0;
    let systemLogsBytes = 0;
    try {
        const row = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(LENGTH(message) + LENGTH(COALESCE(metadata, ''))), 0) as bytes FROM system_logs").get() as any;
        systemLogsCount = row?.c || 0;
        systemLogsBytes = row?.bytes || 0;
    } catch {}

    let logFilesBytes = 0;
    const logsDir = path.join(dataDir, 'logs');
    if (fs.existsSync(logsDir)) {
        try {
            for (const f of fs.readdirSync(logsDir)) {
                try {
                    logFilesBytes += fs.statSync(path.join(logsDir, f)).size;
                } catch {}
            }
        } catch {}
    }

    const logsTotal = systemLogsBytes + logFilesBytes;

    return {
        totalBytes,
        freeBytes,
        usedBytes,
        usedPercent,
        warning,
        databaseBytes: databaseTotal,
        mediaBytes: mediaTotal,
        logsBytes: logsTotal,
        breakdown: {
            database: {
                dbSizeBytes,
                walSizeBytes,
                shmSizeBytes,
                snapshotsSizeBytes,
                totalBytes: databaseTotal,
            },
            media: {
                postPhotosBytes,
                postPhotosCount,
                pulseThumbnailsBytes,
                pulseThumbnailsCount,
                imageStoreBytes,
                imageStoreCount,
                totalBytes: mediaTotal,
            },
            logs: {
                systemLogsBytes,
                systemLogsCount,
                logFilesBytes,
                totalBytes: logsTotal,
            },
        },
    };
}


/**
 * Store objects no row points at, older than a grace period.
 *
 * Two things make one: a `put` whose transaction then rolled back (the store is written before the row, so
 * that the reverse — a row pointing at bytes that were never written — is impossible), and a row deleted
 * while the disk was unavailable to the post-commit hook. Both are harmless; both waste disk.
 *
 * The grace period is what makes the sweep safe to run at any moment: a photo being written RIGHT NOW has no
 * row yet either, and deleting it would break the post being created. An hour is far longer than any write
 * path holds an object rowless, and an orphan is in no hurry.
 *
 * ## Snapshots are out of reach, by construction
 *
 * The sweep judges orphans against the LIVE database, so it must never be able to see a snapshot's captured
 * objects: those answer to the snapshot's database, and a row deleted yesterday is exactly what a recovery
 * point is for. It cannot. It walks one directory — `<data>/images`, the live store — while a snapshot keeps
 * its objects under `<data>/snapshots/<name>.db.images`, which is not below it. The same holds for the
 * deletes: `deleteStoredObjects` is handed the live store and can only unlink inside it, and unlinking a live
 * object leaves a snapshot's hard link to the same inode holding the bytes.
 */
const ORPHAN_OBJECT_GRACE_MS = 60 * 60 * 1000;

function findOrphanedImageObjects(db: any, dataDir: string, nowMs = Date.now()):
    { keys: string[]; totalBytes: number } {
    const out = { keys: [] as string[], totalBytes: 0 };
    let store: ImageStore;
    try {
        store = new DiskImageStore(imagesDir(dataDir));
    } catch {
        return out;
    }
    const referenced = new Set<string>();
    for (const sql of [
        'SELECT storage_key FROM post_photos WHERE storage_key IS NOT NULL',
        'SELECT storage_key FROM message_attachments WHERE storage_key IS NOT NULL',
    ]) {
        try {
            for (const r of db.prepare(sql).all() as any[]) referenced.add(r.storage_key as string);
        } catch {
            // A table this build does not have cannot be holding references. But it could equally be a
            // transient read failure, and deleting objects on the strength of a failed read is how a sweep
            // eats live data — so nothing is reported orphaned unless BOTH reads succeeded.
            return out;
        }
    }
    let keys: string[];
    try { keys = store.list(''); } catch { return out; }
    for (const key of keys) {
        if (referenced.has(key)) continue;
        const h = store.head(key);
        if (!h) continue;
        if (nowMs - h.mtimeMs < ORPHAN_OBJECT_GRACE_MS) continue;
        out.keys.push(key);
        out.totalBytes += h.bytes;
    }
    return out;
}

/**
 * Previews what orphaned media and compressible logs will be removed before actually cleaning.
 */
export function getStorageCleanPreview(options?: { db?: any; dataDir?: string }): StorageCleanPreview {
    const db = options?.db || defaultDb;
    const dataDir = options?.dataDir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

    // 1. Orphaned Post Photos (photos whose post no longer exists in posts table)
    let orphanedPhotosCount = 0;
    let orphanedPhotosBytes = 0;
    try {
        const row = db.prepare(`
            SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(photo_data)), 0) as totalBytes
            FROM post_photos
            WHERE post_id NOT IN (SELECT id FROM posts)
        `).get() as any;
        orphanedPhotosCount = row?.count || 0;
        orphanedPhotosBytes = row?.totalBytes || 0;
    } catch {}

    // 1b. Orphaned image-store objects (no row points at them).
    const orphanedObjects = findOrphanedImageObjects(db, dataDir);

    // 2. Orphaned Pulse Thumbnails (cached thumbnails whose item no longer exists in pulse_items)
    let orphanedThumbnailsCount = 0;
    let orphanedThumbnailsBytes = 0;
    const thumbDir = path.join(dataDir, 'cache', 'pulse-thumbnails');
    if (fs.existsSync(thumbDir)) {
        try {
            for (const f of fs.readdirSync(thumbDir)) {
                if (f.endsWith('.bin')) {
                    const fileBase = f.slice(0, -4);
                    const metaFile = path.join(thumbDir, `${fileBase}.json`);
                    let actualItemId: string | null = null;
                    if (fs.existsSync(metaFile)) {
                        try {
                            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
                            if (meta?.itemId) actualItemId = meta.itemId;
                        } catch {}
                    }
                    const lookupId = actualItemId || fileBase;
                    try {
                        let exists = null;
                        try {
                            exists = db.prepare('SELECT 1 FROM pulse_items WHERE id = ? AND deleted_at IS NULL').get(lookupId);
                        } catch {
                            exists = db.prepare('SELECT 1 FROM pulse_items WHERE id = ?').get(lookupId);
                        }
                        if (!exists) {
                            orphanedThumbnailsCount++;
                            orphanedThumbnailsBytes += fs.statSync(path.join(thumbDir, f)).size;
                            if (fs.existsSync(metaFile)) {
                                orphanedThumbnailsBytes += fs.statSync(metaFile).size;
                            }
                        }
                    } catch {}
                }
            }
        } catch {}
    }

    // 3. Compressible Logs (system_logs older than 7 days or beyond the latest 500 rows)
    let compressibleLogsCount = 0;
    let compressibleLogsBytes = 0;
    let oldestTimestamp: string | undefined;
    let newestTimestamp: string | undefined;

    try {
        const countRow = db.prepare('SELECT COUNT(*) as count FROM system_logs').get() as any;
        const totalLogs = countRow?.count || 0;
        if (totalLogs > 500) {
            const pruneRow = db.prepare(`
                SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(message) + LENGTH(COALESCE(metadata, ''))), 0) as totalBytes,
                       MIN(timestamp) as oldest, MAX(timestamp) as newest
                FROM system_logs
                WHERE id < (SELECT id FROM system_logs ORDER BY id DESC LIMIT 1 OFFSET 499)
            `).get() as any;
            compressibleLogsCount = pruneRow?.count || 0;
            compressibleLogsBytes = pruneRow?.totalBytes || 0;
            oldestTimestamp = pruneRow?.oldest;
            newestTimestamp = pruneRow?.newest;
        }
    } catch {}

    const totalReclaimableBytes = orphanedPhotosBytes + orphanedThumbnailsBytes + compressibleLogsBytes
        + orphanedObjects.totalBytes;

    return {
        orphanedPostPhotos: {
            count: orphanedPhotosCount,
            totalBytes: orphanedPhotosBytes,
        },
        orphanedImageObjects: {
            count: orphanedObjects.keys.length,
            totalBytes: orphanedObjects.totalBytes,
        },
        orphanedThumbnails: {
            count: orphanedThumbnailsCount,
            totalBytes: orphanedThumbnailsBytes,
        },
        compressibleLogs: {
            count: compressibleLogsCount,
            totalBytes: compressibleLogsBytes,
            oldestTimestamp,
            newestTimestamp,
        },
        totalReclaimableBytes,
    };
}

/**
 * Executes cleanup of orphaned media and compresses/prunes old logs.
 */
export function cleanStorageAndCompressLogs(options?: { db?: any; dataDir?: string }): StorageCleanResult {
    const db = options?.db || defaultDb;
    const dataDir = options?.dataDir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

    const preview = getStorageCleanPreview({ db, dataDir });

    // 1. Delete orphaned post photos — the rows, and then the objects they pointed at.
    //
    // Same order as every other delete path (storage design §7): the row goes inside a transaction and the
    // object only after it has committed, so the serving route — which reads the row first — can never be
    // caught serving a photo whose row this sweep has already removed.
    let removedPhotosCount = 0;
    try {
        let doomed: string[] = [];
        db.transaction(() => {
            // In its OWN try: a schema without `storage_key` (a node whose upgrade could not add the
            // column, or a caller-supplied handle) must still have its orphaned photo ROWS pruned. Letting
            // this read throw into the outer catch would silently turn the whole sweep off, and the only
            // symptom would be a node that quietly stopped reclaiming anything.
            try {
                doomed = (db.prepare(`
                    SELECT storage_key FROM post_photos
                    WHERE post_id NOT IN (SELECT id FROM posts) AND storage_key IS NOT NULL
                `).all() as any[]).map((r: any) => r.storage_key as string);
            } catch { doomed = []; }
            const delRes = db.prepare(`
                DELETE FROM post_photos
                WHERE post_id NOT IN (SELECT id FROM posts)
            `).run();
            removedPhotosCount = delRes.changes || 0;
        })();
        // After the transaction has RETURNED, which is after it committed. Deliberately not
        // `afterTransactionCommit`: this function accepts a caller-supplied `db` handle, and that hook is
        // wired to the process-wide one — it would fire at the wrong moment for any other handle.
        if (doomed.length > 0) deleteStoredObjects(doomed, new DiskImageStore(imagesDir(dataDir)));
    } catch {}

    // 1b. Delete store objects nothing points at (see findOrphanedImageObjects). No rows are involved, so
    // there is no transaction to wait for — but they are re-found here rather than taken from the preview,
    // so an object that acquired a row between the two calls is not deleted out from under it.
    let removedImageObjectsCount = 0;
    let removedImageObjectsBytes = 0;
    try {
        const orphans = findOrphanedImageObjects(db, dataDir);
        if (orphans.keys.length > 0) {
            removedImageObjectsCount = deleteStoredObjects(orphans.keys, new DiskImageStore(imagesDir(dataDir)));
            removedImageObjectsBytes = orphans.totalBytes;
        }
    } catch (e) {
        console.warn('[StorageHealth] Could not sweep orphaned image objects:', e);
    }

    // 2. Delete orphaned pulse thumbnails
    let removedThumbnailsCount = 0;
    const thumbDir = path.join(dataDir, 'cache', 'pulse-thumbnails');
    if (fs.existsSync(thumbDir)) {
        try {
            for (const f of fs.readdirSync(thumbDir)) {
                if (f.endsWith('.bin')) {
                    const fileBase = f.slice(0, -4);
                    const metaFile = path.join(thumbDir, `${fileBase}.json`);
                    let actualItemId: string | null = null;
                    if (fs.existsSync(metaFile)) {
                        try {
                            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
                            if (meta?.itemId) actualItemId = meta.itemId;
                        } catch {}
                    }
                    const lookupId = actualItemId || fileBase;
                    try {
                        let exists = null;
                        try {
                            exists = db.prepare('SELECT 1 FROM pulse_items WHERE id = ? AND deleted_at IS NULL').get(lookupId);
                        } catch {
                            exists = db.prepare('SELECT 1 FROM pulse_items WHERE id = ?').get(lookupId);
                        }
                        if (!exists) {
                            try { fs.unlinkSync(path.join(thumbDir, f)); } catch {}
                            try { if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile); } catch {}
                            removedThumbnailsCount++;
                        }
                    } catch {}
                }
            }
        } catch {}
    }

    // 3. Compress / prune old logs
    let compressedLogsCount = 0;

    try {
        const countRow = db.prepare('SELECT COUNT(*) as count FROM system_logs').get() as any;
        const totalLogs = countRow?.count || 0;
        if (totalLogs > 500) {
            // Read rows to archive
            const rowsToArchive = db.prepare(`
                SELECT * FROM system_logs
                WHERE id < (SELECT id FROM system_logs ORDER BY id DESC LIMIT 1 OFFSET 499)
                ORDER BY id ASC
            `).all() as any[];

            if (rowsToArchive.length > 0) {
                const logsArchiveDir = path.join(dataDir, 'logs', 'archived');
                let archiveWritten = false;
                try {
                    if (!fs.existsSync(logsArchiveDir)) {
                        fs.mkdirSync(logsArchiveDir, { recursive: true });
                    }
                    const archiveFile = path.join(logsArchiveDir, `logs-${Date.now()}.json.gz`);
                    const jsonStr = JSON.stringify(rowsToArchive);
                    const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
                    fs.writeFileSync(archiveFile, compressed);
                    archiveWritten = true;
                } catch (err) {
                    console.error('[StorageHealth] Failed to write compressed log archive:', err);
                }

                if (archiveWritten) {
                    const maxArchivedId = rowsToArchive[rowsToArchive.length - 1].id;
                    const delLogs = db.prepare(`
                        DELETE FROM system_logs
                        WHERE id <= ?
                    `).run(maxArchivedId);
                    compressedLogsCount = delLogs.changes || rowsToArchive.length;
                }
            }
        }

        // Checkpoint WAL and truncate to immediately reclaim filesystem space
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
            const autoVacuumMode = db.pragma('auto_vacuum', { simple: true });
            if (autoVacuumMode === 2) {
                db.pragma('incremental_vacuum');
            }
        } catch (err) {
            console.error('[StorageHealth] WAL checkpoint / vacuum failed:', err);
        }
    } catch {}

    const effectiveRemovedPhotosBytes = removedPhotosCount > 0 ? preview.orphanedPostPhotos.totalBytes : 0;
    const effectiveRemovedThumbnailsBytes = removedThumbnailsCount > 0 ? preview.orphanedThumbnails.totalBytes : 0;
    const effectiveCompressedLogsBytes = compressedLogsCount > 0 ? preview.compressibleLogs.totalBytes : 0;
    const totalReclaimedBytes = effectiveRemovedPhotosBytes + effectiveRemovedThumbnailsBytes
        + effectiveCompressedLogsBytes + removedImageObjectsBytes;

    return {
        success: true,
        removedPhotosCount,
        removedPhotosBytes: effectiveRemovedPhotosBytes,
        removedImageObjectsCount,
        removedImageObjectsBytes,
        removedThumbnailsCount,
        removedThumbnailsBytes: effectiveRemovedThumbnailsBytes,
        compressedLogsCount,
        compressedLogsBytes: effectiveCompressedLogsBytes,
        totalReclaimedBytes,
    };
}

// ── The sweep, on a timer ──────────────────────────────────────────────────────────────────────

/**
 * Reclaim store objects nothing points at, daily, without anybody pressing anything.
 *
 * ## Why this has to be scheduled
 *
 * Until now the orphan sweep ran only when an admin opened Settings → Storage and pressed *Clean*
 * (`routes/admin.ts`). Every path in the image store that says an object is "swept later" therefore meant
 * "kept until a human clicks": the objects a rolled-back `createPost`/`updatePost`/import transaction left
 * behind, the old object behind an `INSERT OR REPLACE` on a replica, what `clearReplicatedTables` leaves
 * after a force-resync, and any post-commit `deleteStoredObjects` that hit an I/O error.
 *
 * None of those is ever served — every serving path reads the row first, and the row is gone — so this is
 * not data leaking out of the node. It is a member's deleted photo still ON the disk, indefinitely, on a
 * node nobody administers. Most BeanPool installs are a stranger's download running for their own
 * community; "delete" has to mean the bytes go, whether or not anyone ever opens the admin panel.
 *
 * ## Why it is safe to run unattended
 *
 * It is exactly {@link findOrphanedImageObjects} plus {@link deleteStoredObjects}, the same pair the Clean
 * button runs, with the same one-hour grace period — which is what makes the sweep safe at any moment,
 * including in the middle of a post being written. It walks `<data>/images` only, so a snapshot's captured
 * objects under `<data>/snapshots/<name>.db.images` are out of reach by construction, and it unlinks a name
 * rather than an inode, so a snapshot's hard link keeps the bytes. It touches no rows at all.
 */
const ORPHAN_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Well clear of the boot burst, and of the evacuation job's first passes. */
const ORPHAN_SWEEP_FIRST_DELAY_MS = 15 * 60 * 1000;

let orphanSweepTimer: NodeJS.Timeout | null = null;

/**
 * One pass. Never throws: a sweep that cannot read the store is a warning and a retry tomorrow, not a
 * process that falls over. Returns what it removed so a caller (and the test) can see it.
 */
export function sweepOrphanedImageObjects(options?: { db?: any; dataDir?: string; nowMs?: number }):
    { removed: number; bytes: number } {
    const db = options?.db || defaultDb;
    const dataDir = options?.dataDir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    try {
        const orphans = findOrphanedImageObjects(db, dataDir, options?.nowMs ?? Date.now());
        if (orphans.keys.length === 0) return { removed: 0, bytes: 0 };
        const removed = deleteStoredObjects(orphans.keys, new DiskImageStore(imagesDir(dataDir)));
        console.log(
            `🧹 [StorageHealth] Daily sweep: removed ${removed} orphaned image object(s) `
            + `(${(orphans.totalBytes / 1024).toFixed(1)} KB) that no row points at. `
            + `First: ${orphans.keys.slice(0, 3).join(', ')}`,
        );
        return { removed, bytes: orphans.totalBytes };
    } catch (e) {
        console.warn('[StorageHealth] Daily orphan sweep failed; trying again tomorrow:', e);
        return { removed: 0, bytes: 0 };
    }
}

/**
 * Arm the daily sweep. Call once at boot, with no arguments.
 *
 * Every argument is a test seam — `intervalMs`/`firstDelayMs` so a suite can prove the schedule actually
 * fires rather than only that the function works, and `db`/`dataDir` so it fires against the suite's own
 * fixture, the same pair every other entry point in this module takes.
 */
export function startOrphanObjectSweep(opts?: { intervalMs?: number; firstDelayMs?: number; db?: any; dataDir?: string }): void {
    if (orphanSweepTimer) return;
    const interval = opts?.intervalMs ?? ORPHAN_SWEEP_INTERVAL_MS;
    const first = opts?.firstDelayMs ?? ORPHAN_SWEEP_FIRST_DELAY_MS;
    const tick = (delay: number): void => {
        orphanSweepTimer = setTimeout(() => {
            sweepOrphanedImageObjects({ db: opts?.db, dataDir: opts?.dataDir });
            tick(interval);
        }, delay);
        // Never a reason to hold the process open: a sweep missed at shutdown runs at the next boot.
        orphanSweepTimer.unref?.();
    };
    tick(first);
}

/** Stop it — for tests and for a clean shutdown. */
export function stopOrphanObjectSweep(): void {
    if (orphanSweepTimer) { clearTimeout(orphanSweepTimer); orphanSweepTimer = null; }
}
