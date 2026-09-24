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
import {
    DiskImageStore, ImageStoreUnavailableError, deleteObjectUnless, getImageStore, imagesDir, scanOurObjectsAsync,
    type ImageStore, type ObjectInfo,
} from '../storage/image-store.js';

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
    /**
     * Orphaned store objects this Clean found and did not get to: it stops at {@link CLEAN_SWEEP_BUDGET_MS} or
     * the per-pass cap rather than keep the operator waiting. The background sweep carries on with them (it is
     * brought forward when any remain), so a non-zero number here means "more remain", never "done".
     */
    remainingImageObjectsCount: number;
    remainingImageObjectsBytes: number;
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
    //
    // THIS disk's store, whatever IMAGE_STORE says. This report is about the disk the node runs on — the 80%
    // warning exists to stop an SD card filling — and objects in an S3 bucket take none of it. Nor does this
    // list a bucket: it is refreshed every minute by an open admin page, and a bucket listing on the blocking
    // path would hold the node for a round trip per thousand objects to report bytes that are not here.
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
 * deletes: `deleteObjectUnless` is handed the live store and can only unlink inside it, and unlinking a live
 * object leaves a snapshot's hard link to the same inode holding the bytes.
 *
 * ## Half-written objects count as orphans
 *
 * A `<key>.tmp-<hex>` left behind by a crash mid-`put`, or mid-`copyObjectReplacing` during a restore, is
 * invisible to everything else in the node: `list` skips it on purpose, so `totalBytes`, the media breakdown
 * and the referenced-key walk never see it, and nothing else walks the store. This sweep is the only thing
 * that can ever reclaim one. No row can point at it — the object is written before the row, and under a name
 * no row would ever hold — so the only question is age, and the same grace period answers it: a `put` in
 * flight right now looks exactly like a leftover.
 */
const ORPHAN_OBJECT_GRACE_MS = 60 * 60 * 1000;

/**
 * The store the sweep judges and deletes from: the node's own (`IMAGE_STORE`: disk, or the S3 bucket) — or, for
 * a caller that names a data directory (the suites, which point at their own fixture), that directory's disk
 * store, as before.
 *
 * On S3 the sweep lists the bucket once per thousand objects, with each object's size and upload time in the
 * listing itself, rather than a HEAD per object; and only this node's namespaces (`posts/`, `attachments/`),
 * so anything else an operator keeps in the same bucket is never listed, let alone deleted.
 */
function sweepStore(options?: { dataDir?: string; store?: ImageStore }): ImageStore {
    if (options?.store) return options.store;
    if (options?.dataDir) return new DiskImageStore(imagesDir(options.dataDir));
    return getImageStore();
}

/**
 * Orphans one pass removes from a disk store. An unlink each, with a yield to the event loop after every one,
 * so the cap is about how much a single pass takes on rather than about holding the loop.
 */
export const ORPHAN_SWEEP_BATCH = 2_000;

/**
 * Orphans one pass removes from an S3 bucket. Each is a HEAD and a DELETE, neither of which holds the event loop
 * (the sweep uses the store's async path), so this bounds how long a pass runs and how hard it leans on the
 * bucket: at 50-100 ms a round trip, a minute or two. After an older backup is restored every object written
 * since is an orphan; the passes that follow take them a batch at a time, ORPHAN_SWEEP_CONTINUE_MS apart.
 */
export const ORPHAN_SWEEP_BATCH_S3 = 500;

/**
 * How long the admin Clean spends deleting orphaned objects before it answers. An operator is waiting on the
 * page; what the Clean does not get to, it reports as remaining, and the background sweep carries on with it.
 */
export const CLEAN_SWEEP_BUDGET_MS = 3_000;

/** Gap between passes while orphans remain, instead of a day. */
const ORPHAN_SWEEP_CONTINUE_MS = 60_000;

function sweepBatchFor(store: ImageStore): number {
    return store.kind === 's3' ? ORPHAN_SWEEP_BATCH_S3 : ORPHAN_SWEEP_BATCH;
}

/**
 * Every orphan in the store: an object of ours no row points at, older than the grace period, in listing order.
 *
 * Non-blocking on S3 (the listing is the store's async one). The rows are read AFTER the listing, so a row
 * written while it was being taken is seen; an object written while it was being taken is either not listed or
 * listed fresh, and the grace period passes over it.
 */
async function findOrphanedImageObjects(db: any, options: { dataDir?: string; store?: ImageStore } | undefined, nowMs = Date.now()):
    Promise<{ objects: ObjectInfo[]; totalBytes: number }> {
    const out = { objects: [] as ObjectInfo[], totalBytes: 0 };
    let store: ImageStore;
    try {
        store = sweepStore(options);
    } catch {
        return out;
    }
    let listed: ObjectInfo[];
    try { listed = await scanOurObjectsAsync(store); } catch { return out; }
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
    for (const o of listed) {
        if (referenced.has(o.key)) continue;
        if (nowMs - o.mtimeMs < ORPHAN_OBJECT_GRACE_MS) continue;
        out.objects.push(o);
        out.totalBytes += o.bytes;
    }
    // Leftovers of a crashed write, which `list` above will never return. No row can reference one, so
    // there is nothing to check them against — only their age. A store whose write is one atomic request
    // (S3) has none, and does not implement this.
    try {
        for (const t of store.listTemporary?.() ?? []) {
            if (nowMs - t.mtimeMs < ORPHAN_OBJECT_GRACE_MS) continue;
            out.objects.push(t);
            out.totalBytes += t.bytes;
        }
    } catch {
        // The objects found above are still worth reclaiming; the temp walk retries tomorrow.
    }
    return out;
}

/** better-sqlite3 marks a closed handle `open: false`. A restore closes the node's before replacing the file. */
function stillOpen(db: any): boolean {
    return db?.open !== false;
}

/** What one pass of the sweep did. */
export interface OrphanSweepPass {
    removed: number;
    bytes: number;
    /**
     * Orphans the pass found and did not remove: past its cap or its time budget, stopped, or failed to delete.
     * The next pass lists the store afresh and takes them from there.
     */
    remaining: number;
    remainingBytes: number;
}

/**
 * One pass: find the orphans, then delete up to `max` of them, one at a time, back to the event loop after each.
 *
 * ## Bounded, yielding, and safe to stop anywhere
 *
 * Nothing here holds the event loop for more than one local step: on S3 the listing and every HEAD and DELETE go
 * through the store's async path, and on disk each unlink is followed by a yield. The pass stops at `max`
 * deletes, at `budgetMs` from its start, when `shouldStop` says so, or when the store stops answering — and
 * whatever it did not reach is still an orphan the next pass will find. There is no state between passes to go
 * stale: each one lists afresh, and a delete is idempotent, so a node killed half-way loses nothing.
 *
 * ## Judged again at the moment of each delete
 *
 * Yielding means the world moves between the listing and a delete. So each object is judged as the store has it
 * right then ({@link deleteObjectUnless}): if it was written again in the meantime — a re-post of the same photo
 * is the same content-addressed key, and every writer puts the object before it writes the row — it is inside
 * the grace period again and stays. And once the database the orphans were judged against has been closed —
 * a restore, which replaces it with one that may well name them — nothing more is deleted at all. On S3 the store
 * also keeps a write and a delete of the same key from overlapping (s3-image-store.ts).
 */
async function sweepOnce(
    db: any,
    options: { dataDir?: string; store?: ImageStore; nowMs?: number } | undefined,
    limits: { max?: number; budgetMs?: number; shouldStop?: () => boolean } = {},
): Promise<OrphanSweepPass & { storeFailed: boolean }> {
    const pass = { removed: 0, bytes: 0, remaining: 0, remainingBytes: 0, storeFailed: false };
    let store: ImageStore;
    try { store = sweepStore(options); } catch { return pass; }
    const found = await findOrphanedImageObjects(db, options, options?.nowMs ?? Date.now());
    // The budget bounds the deletes, not the listing: on a bucket slow to list, a clock started before it would
    // spend the whole budget there, and the Clean would remove nothing itself however often it was pressed.
    const started = Date.now();
    const max = limits.max ?? sweepBatchFor(store);
    const clock = () => options?.nowMs ?? Date.now();
    const keep = (now: ObjectInfo) => !stillOpen(db) || clock() - now.mtimeMs < ORPHAN_OBJECT_GRACE_MS;
    let reached = 0;
    let failures = 0;
    for (const o of found.objects) {
        if (reached >= max || !stillOpen(db) || limits.shouldStop?.()) break;
        if (limits.budgetMs !== undefined && Date.now() - started >= limits.budgetMs) break;
        reached++;
        try {
            if (await deleteObjectUnless(store, o.key, keep)) {
                pass.removed++;
                pass.bytes += o.bytes;
            }
        } catch (e) {
            pass.remaining++;
            pass.remainingBytes += o.bytes;
            if (e instanceof ImageStoreUnavailableError) {
                // The store is down or refusing this node: every other delete would fail the same way.
                pass.storeFailed = true;
                console.warn(`[StorageHealth] The image store stopped answering the orphan sweep; the rest wait for the next pass: ${e.message}`);
                break;
            }
            if (++failures <= 3) console.warn(`[StorageHealth] Could not delete orphaned image object ${o.key}:`, e);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const o of found.objects.slice(reached)) {
        pass.remaining++;
        pass.remainingBytes += o.bytes;
    }
    return pass;
}

/**
 * Previews what orphaned media and compressible logs will be removed before actually cleaning.
 */
export async function getStorageCleanPreview(options?: { db?: any; dataDir?: string; store?: ImageStore }): Promise<StorageCleanPreview> {
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

    // 1b. Orphaned image-store objects (no row points at them). Every one of them, not a pass's worth: this is
    // what there is to reclaim, and the Clean says how much of it one press got to.
    const orphanedObjects = await findOrphanedImageObjects(db, options);

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
            count: orphanedObjects.objects.length,
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
 *
 * Async, and bounded where it touches the image store: see step 1b.
 */
export async function cleanStorageAndCompressLogs(options?: { db?: any; dataDir?: string; store?: ImageStore }): Promise<StorageCleanResult> {
    const db = options?.db || defaultDb;
    const dataDir = options?.dataDir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

    const preview = await getStorageCleanPreview({ db, dataDir: options?.dataDir, store: options?.store });

    // 1. Delete orphaned post photo ROWS. Their objects are orphans the moment this commits, and step 1b
    // reclaims them the way it reclaims any other: after the rows are gone (storage design §7: the row first,
    // so the serving route — which reads the row first — can never serve a photo whose row is gone), and past
    // the same grace period. Not deleted here one by one: on a bucket that was a blocking HEAD and DELETE per
    // photo with no bound, and after the grace period step 1b takes every one of them anyway.
    let removedPhotosCount = 0;
    try {
        const delRes = db.prepare(`
            DELETE FROM post_photos
            WHERE post_id NOT IN (SELECT id FROM posts)
        `).run();
        removedPhotosCount = delRes.changes || 0;
    } catch {}

    // 1b. Delete store objects nothing points at: one pass of the same sweep the timer runs, re-finding them
    // rather than taking the preview's list, so an object that acquired a row between the two calls is not
    // deleted out from under it. Bounded by the pass's cap AND by CLEAN_SWEEP_BUDGET_MS, because an operator
    // is waiting on the answer: after an older backup is restored onto an s3 node the bucket can hold thousands
    // of orphans, which are minutes of round trips. What it does not get to it reports as remaining, and the
    // background sweep is brought forward to carry on with them.
    let orphanPass: OrphanSweepPass = { removed: 0, bytes: 0, remaining: 0, remainingBytes: 0 };
    try {
        orphanPass = await sweepOnce(db, options, { budgetMs: CLEAN_SWEEP_BUDGET_MS });
        if (orphanPass.remaining > 0) nudgeOrphanSweep();
    } catch (e) {
        console.warn('[StorageHealth] Could not sweep orphaned image objects:', e);
    }
    const removedImageObjectsCount = orphanPass.removed;
    const removedImageObjectsBytes = orphanPass.bytes;

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
        remainingImageObjectsCount: orphanPass.remaining,
        remainingImageObjectsBytes: orphanPass.remainingBytes,
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
 * It is exactly {@link findOrphanedImageObjects} plus {@link deleteObjectUnless} ({@link sweepOnce}), the same
 * pass the Clean button runs, with the same one-hour grace period — which is what makes the sweep safe at any
 * moment, including in the middle of a post being written. It walks `<data>/images` only, so a snapshot's
 * captured objects under `<data>/snapshots/<name>.db.images` are out of reach by construction, and it unlinks a
 * name rather than an inode, so a snapshot's hard link keeps the bytes. It touches no rows at all.
 *
 * ## Why it never holds the node
 *
 * A pass is capped ({@link ORPHAN_SWEEP_BATCH_S3} on a bucket, {@link ORPHAN_SWEEP_BATCH} on disk) and yields to
 * the event loop between deletes; on S3 nothing in it blocks at all. When a pass stops at its cap, the next one
 * comes ORPHAN_SWEEP_CONTINUE_MS later rather than a day later, until none remain. Before this, the sweep was
 * one synchronous loop of blocking round trips: after a restore left a few hundred orphans in a bucket it held
 * the node past the ~60 s host watchdog, which restarted it — and the next sweep did the same again.
 */
const ORPHAN_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Well clear of the boot burst, and of the evacuation job's first passes. */
const ORPHAN_SWEEP_FIRST_DELAY_MS = 15 * 60 * 1000;

let orphanSweepTimer: NodeJS.Timeout | null = null;

/** Bumped by every start and stop, so a pass or a timer from an earlier arming knows it has been called off. */
let orphanSweepGeneration = 0;

/** The armed sweep: when it fires next, whether a pass is running, and how to bring it forward. */
let orphanSweepArmed: { continueMs: number; nextAt: number; running: boolean; schedule: (delayMs: number) => void } | null = null;

/**
 * One pass. Never throws: a sweep that cannot read the store is a warning and a retry later, not a process that
 * falls over. Returns what it removed and what it left, so a caller (and the test) can see it.
 */
export async function sweepOrphanedImageObjects(options?: { db?: any; dataDir?: string; store?: ImageStore; nowMs?: number }):
    Promise<OrphanSweepPass> {
    const { storeFailed: _storeFailed, ...pass } = await runSweepPass(options);
    return pass;
}

async function runSweepPass(
    options: { db?: any; dataDir?: string; store?: ImageStore; nowMs?: number } | undefined,
    shouldStop?: () => boolean,
): Promise<OrphanSweepPass & { storeFailed: boolean }> {
    const db = options?.db || defaultDb;
    try {
        const pass = await sweepOnce(db, options, { shouldStop });
        if (pass.removed > 0 || pass.remaining > 0) {
            console.log(
                `🧹 [StorageHealth] Orphan sweep: removed ${pass.removed} orphaned image object(s) `
                + `(${(pass.bytes / 1024).toFixed(1)} KB) that no row points at`
                + (pass.remaining > 0 ? `; ${pass.remaining} more left for the next pass.` : '.'),
            );
        }
        return pass;
    } catch (e) {
        console.warn('[StorageHealth] Orphan sweep failed; trying again later:', e);
        return { removed: 0, bytes: 0, remaining: 0, remainingBytes: 0, storeFailed: true };
    }
}

/**
 * Arm the daily sweep. Call once at boot, with no arguments.
 *
 * Every argument is a test seam — `intervalMs`/`firstDelayMs`/`continueMs` so a suite can prove the schedule
 * actually fires (and carries on while orphans remain) rather than only that the function works, and
 * `db`/`dataDir`/`store` so it fires against the suite's own fixture, the same set every other entry point in
 * this module takes.
 */
export function startOrphanObjectSweep(opts?: {
    intervalMs?: number; firstDelayMs?: number; continueMs?: number; db?: any; dataDir?: string; store?: ImageStore;
}): void {
    if (orphanSweepArmed) return;
    const generation = ++orphanSweepGeneration;
    const calledOff = () => orphanSweepGeneration !== generation;
    const interval = opts?.intervalMs ?? ORPHAN_SWEEP_INTERVAL_MS;
    const first = opts?.firstDelayMs ?? ORPHAN_SWEEP_FIRST_DELAY_MS;
    const armed = {
        continueMs: opts?.continueMs ?? ORPHAN_SWEEP_CONTINUE_MS,
        nextAt: 0,
        running: false,
        schedule: (delayMs: number): void => {
            if (orphanSweepTimer) clearTimeout(orphanSweepTimer);
            armed.nextAt = Date.now() + delayMs;
            orphanSweepTimer = setTimeout(async () => {
                orphanSweepTimer = null;
                armed.running = true;
                let pass: OrphanSweepPass & { storeFailed: boolean };
                try {
                    pass = await runSweepPass({ db: opts?.db, dataDir: opts?.dataDir, store: opts?.store }, calledOff);
                } finally {
                    armed.running = false;
                }
                if (calledOff()) return;
                // Orphans left at the cap: the next batch soon. Left because the store stopped answering: the
                // usual interval, rather than knocking on a bucket that is down every minute.
                armed.schedule(pass.remaining > 0 && !pass.storeFailed ? armed.continueMs : interval);
            }, delayMs);
            // Never a reason to hold the process open: a sweep missed at shutdown runs at the next boot.
            orphanSweepTimer.unref?.();
        },
    };
    orphanSweepArmed = armed;
    armed.schedule(first);
}

/**
 * Bring the next pass forward to ORPHAN_SWEEP_CONTINUE_MS from now, when it was due later: the admin Clean left
 * orphans behind and the background carries on with them. A pass already running decides for itself by what it
 * left; a sweep that was never armed (a suite) is left alone.
 */
function nudgeOrphanSweep(): void {
    const armed = orphanSweepArmed;
    if (!armed || armed.running) return;
    if (armed.nextAt - Date.now() > armed.continueMs) armed.schedule(armed.continueMs);
}

/**
 * Stop it — for tests and for a clean shutdown. A pass that is running stops before its next delete; the one it
 * has already sent completes, and everything it did not reach waits for the next pass as an orphan.
 */
export function stopOrphanObjectSweep(): void {
    orphanSweepGeneration++;
    orphanSweepArmed = null;
    if (orphanSweepTimer) { clearTimeout(orphanSweepTimer); orphanSweepTimer = null; }
}
