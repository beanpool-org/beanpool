/**
 * Moving the images already in the database out to the image store (storage design §7).
 *
 * Every node that upgrades to this version arrives with its photos and attachments inline: 15.3 MB of
 * `post_photos.photo_data` and 8.3 MB of `message_attachments.data` on the test node, out of a 34.1 MB
 * `state.db`. New writes go straight to the store from here on; this job is what deals with the history.
 *
 * ## The shape of it
 *
 * Small batches on a timer, never a single long pass. The node is a 1 vCPU / 1 GB VM serving members while
 * this runs, and better-sqlite3 is synchronous: a loop over ten thousand rows would hold the event loop and
 * the write lock for as long as it took. {@link EVACUATION_BATCH} rows, then back to the event loop.
 *
 * ## Safe to interrupt, safe to re-run
 *
 * One row at a time, in this order:
 *
 *   1. decode and hash the inline value, and check it re-encodes to exactly the characters the row holds
 *      (storage/image-columns.ts — if it does not, the row is LEFT ALONE, counted as skipped, and stays
 *      correct where it is);
 *   2. `put` the bytes under a content-addressed key;
 *   3. read the object back and hash it again — the row is only allowed to forget its copy once the store
 *      has independently produced the same SHA-256;
 *   4. in one transaction, write `storage_key`/`sha256`/`bytes`/`mime` and NULL the inline column.
 *
 * Killed anywhere in 1–3 and nothing has changed: the row is still inline and still authoritative, and the
 * object (if it was written) is the same content-addressed key the next run will write again. Killed between
 * 3 and 4 and the object is simply there early. There is no ordering in which a row forgets bytes the store
 * does not hold.
 *
 * ## Then the space
 *
 * Nulling a column frees SQLite pages inside the file; it does not shrink the file. So once there is nothing
 * left to move, the job checkpoints the WAL and VACUUMs — the same reclamation storage-health does after a
 * prune, and the step that turns "84% of the database was images" into a smaller file on disk. Guarded by a
 * `node_config` marker so a node vacuums once, not on every boot.
 */

import { db } from '../db/db.js';
import { getImageStore, postPhotoKey, attachmentKey, sha256Hex, type ImageStore } from '../storage/image-store.js';
import { prepareStorablePhoto, prepareStorableCiphertext } from '../storage/image-columns.js';

/** Rows per pass. Small enough that a pass is a few hundred milliseconds on the slowest node we run. */
export const EVACUATION_BATCH = 50;

/** Gap between passes, so the job is a background hum rather than a boot-time stall. */
const EVACUATION_INTERVAL_MS = 2_000;

/** How long after boot the first pass runs — well clear of the startup burst. */
const EVACUATION_START_DELAY_MS = 20_000;

const VACUUM_MARKER = 'image_store_evacuation_vacuumed_v1';

export interface EvacuationCounts {
    photosMoved: number;
    photoBytesMoved: number;
    photosSkipped: number;
    attachmentsMoved: number;
    attachmentBytesMoved: number;
    attachmentsSkipped: number;
}

function emptyCounts(): EvacuationCounts {
    return {
        photosMoved: 0, photoBytesMoved: 0, photosSkipped: 0,
        attachmentsMoved: 0, attachmentBytesMoved: 0, attachmentsSkipped: 0,
    };
}

function addCounts(a: EvacuationCounts, b: EvacuationCounts): EvacuationCounts {
    return {
        photosMoved: a.photosMoved + b.photosMoved,
        photoBytesMoved: a.photoBytesMoved + b.photoBytesMoved,
        photosSkipped: a.photosSkipped + b.photosSkipped,
        attachmentsMoved: a.attachmentsMoved + b.attachmentsMoved,
        attachmentBytesMoved: a.attachmentBytesMoved + b.attachmentBytesMoved,
        attachmentsSkipped: a.attachmentsSkipped + b.attachmentsSkipped,
    };
}

/**
 * Rows this pass will not try again.
 *
 * A value that cannot be reproduced exactly is skipped EVERY pass — it is the row's permanent answer, not a
 * transient failure — so without this the job would re-read the same handful of rows forever and never reach
 * the ones behind them. Per-process, so a restart re-examines them once (cheap) in case a fix has shipped.
 */
const skippedPhotos = new Set<string>();
const skippedAttachments = new Set<string>();

/** Test seam: forget which rows were skipped, so a suite can re-run a pass over the same fixture. */
export function resetEvacuationSkipsForTests(): void {
    skippedPhotos.clear();
    skippedAttachments.clear();
}

/**
 * Put the bytes and prove the store has them. Returns the verified size, or null when the store did not
 * come back with the same bytes — in which case the caller must leave the row alone.
 */
function putAndVerify(store: ImageStore, key: string, bytes: Buffer, mime: string, sha256: string): number | null {
    const put = store.put(key, bytes, { mime, sha256 });
    // Read it back rather than trust the write: the row is about to forget the only other copy. This is the
    // one place in the codebase where a re-read is worth its cost, and it happens once per image, ever.
    const back = store.get(put.key);
    if (!back || sha256Hex(back) !== sha256) {
        console.error(`[ImageEvacuation] ${key} did not read back as it was written — leaving the row alone.`);
        return null;
    }
    return put.bytes;
}

/** One pass over at most {@link EVACUATION_BATCH} post photos. */
function evacuatePhotoBatch(store: ImageStore, limit: number): EvacuationCounts {
    const counts = emptyCounts();
    let rows: any[];
    try {
        rows = db.prepare(`
            SELECT post_id, order_num, photo_data
              FROM post_photos
             WHERE storage_key IS NULL AND photo_data IS NOT NULL AND photo_data != ''
             ORDER BY post_id, order_num
             LIMIT ?
        `).all(limit + skippedPhotos.size) as any[];
    } catch (e) {
        console.warn('[ImageEvacuation] Could not read post_photos:', e);
        return counts;
    }

    const update = db.prepare(`
        UPDATE post_photos
           SET photo_data = NULL, storage_key = ?, sha256 = ?, bytes = ?, mime = ?
         WHERE post_id = ? AND order_num = ? AND storage_key IS NULL
    `);

    let done = 0;
    for (const row of rows) {
        if (done >= limit) break;
        const id = `${row.post_id}|${row.order_num}`;
        if (skippedPhotos.has(id)) continue;
        done++;
        const storable = prepareStorablePhoto(row.photo_data);
        if (!storable) {
            // Not a defect: a value the store cannot reproduce character for character stays where it is.
            skippedPhotos.add(id);
            counts.photosSkipped++;
            continue;
        }
        try {
            const key = postPhotoKey(row.post_id, row.order_num, storable.sha256, storable.mime);
            const bytes = putAndVerify(store, key, storable.bytes, storable.mime, storable.sha256);
            if (bytes === null) { skippedPhotos.add(id); counts.photosSkipped++; continue; }
            // `AND storage_key IS NULL` in the UPDATE: if anything else evacuated or replaced this row
            // while the file was being written, that writer wins and this one changes nothing.
            const res = update.run(key, storable.sha256, bytes, storable.mime, row.post_id, row.order_num);
            if (res.changes > 0) {
                counts.photosMoved++;
                counts.photoBytesMoved += row.photo_data.length;
            }
        } catch (e) {
            console.warn(`[ImageEvacuation] Could not move photo ${id}:`, e);
            skippedPhotos.add(id);
            counts.photosSkipped++;
        }
    }
    return counts;
}

/** One pass over at most {@link EVACUATION_BATCH} message attachments. */
function evacuateAttachmentBatch(store: ImageStore, limit: number): EvacuationCounts {
    const counts = emptyCounts();
    let rows: any[];
    try {
        rows = db.prepare(`
            SELECT message_id, data
              FROM message_attachments
             WHERE storage_key IS NULL AND data IS NOT NULL AND data != ''
             ORDER BY message_id
             LIMIT ?
        `).all(limit + skippedAttachments.size) as any[];
    } catch (e) {
        console.warn('[ImageEvacuation] Could not read message_attachments:', e);
        return counts;
    }

    const update = db.prepare(`
        UPDATE message_attachments
           SET data = NULL, storage_key = ?
         WHERE message_id = ? AND storage_key IS NULL
    `);

    let done = 0;
    for (const row of rows) {
        if (done >= limit) break;
        if (skippedAttachments.has(row.message_id)) continue;
        done++;
        const storable = prepareStorableCiphertext(row.data);
        if (!storable) {
            skippedAttachments.add(row.message_id);
            counts.attachmentsSkipped++;
            continue;
        }
        try {
            const key = attachmentKey(row.message_id);
            const bytes = putAndVerify(store, key, storable.bytes, storable.mime, storable.sha256);
            if (bytes === null) { skippedAttachments.add(row.message_id); counts.attachmentsSkipped++; continue; }
            const res = update.run(key, row.message_id);
            if (res.changes > 0) {
                counts.attachmentsMoved++;
                counts.attachmentBytesMoved += row.data.length;
            }
        } catch (e) {
            console.warn(`[ImageEvacuation] Could not move attachment ${row.message_id}:`, e);
            skippedAttachments.add(row.message_id);
            counts.attachmentsSkipped++;
        }
    }
    return counts;
}

/** How many rows still hold bytes the store could take. */
export function pendingEvacuationCount(): { photos: number; attachments: number } {
    const count = (sql: string): number => {
        try { return ((db.prepare(sql).get() as any)?.c as number) || 0; } catch { return 0; }
    };
    return {
        photos: count(`SELECT COUNT(*) AS c FROM post_photos WHERE storage_key IS NULL AND photo_data IS NOT NULL AND photo_data != ''`),
        attachments: count(`SELECT COUNT(*) AS c FROM message_attachments WHERE storage_key IS NULL AND data IS NOT NULL AND data != ''`),
    };
}

/**
 * One batch of work. Exported so a suite can drive the job a pass at a time — and kill it between passes,
 * which is exactly what "safe to interrupt" has to mean.
 */
export function evacuateImagesOnce(limit = EVACUATION_BATCH): EvacuationCounts {
    const store = getImageStore();
    const photos = evacuatePhotoBatch(store, limit);
    // Attachments only once the photos are done: they are the bigger win per row, and doing one table at a
    // time keeps each pass's read set small.
    const remainingPhotos = pendingEvacuationCount().photos;
    const attachments = remainingPhotos === 0 ? evacuateAttachmentBatch(store, limit) : emptyCounts();
    return addCounts(photos, attachments);
}

/**
 * Reclaim the space the nulled columns freed. Once per node: `VACUUM` rewrites the whole file, which is
 * worth doing after 84% of it has been emptied out and not worth doing again on every boot.
 */
function reclaimSpaceOnce(): void {
    try {
        const already = db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(VACUUM_MARKER);
        if (already) return;
    } catch {
        return; // no node_config yet: nothing has been evacuated either
    }
    let before = 0;
    try {
        const pageCount = db.pragma('page_count', { simple: true }) as number;
        const pageSize = db.pragma('page_size', { simple: true }) as number;
        before = pageCount * pageSize;
    } catch { /* the size is a nicety, not the point */ }
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        // VACUUM cannot run inside a transaction, and nothing here opens one.
        db.exec('VACUUM');
    } catch (e) {
        console.warn('[ImageEvacuation] Could not reclaim space (the images are still out of the DB):', e);
        return;
    }
    let after = 0;
    try {
        const pageCount = db.pragma('page_count', { simple: true }) as number;
        const pageSize = db.pragma('page_size', { simple: true }) as number;
        after = pageCount * pageSize;
    } catch { /* as above */ }
    try {
        db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)`)
            .run(VACUUM_MARKER, new Date().toISOString());
    } catch (e) {
        console.warn('[ImageEvacuation] Vacuumed, but could not record it; it may run again next boot:', e);
    }
    console.log(`💾 [ImageEvacuation] Reclaimed space: state.db ${mb(before)} → ${mb(after)}.`);
}

function mb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let total = emptyCounts();

/**
 * Start the job. No-op when there is nothing to move, so a node that has already been through it pays one
 * `COUNT(*)` at boot and nothing else.
 */
export function startImageEvacuation(): void {
    if (timer) return;
    const pending = pendingEvacuationCount();
    if (pending.photos === 0 && pending.attachments === 0) {
        reclaimSpaceOnce();
        return;
    }
    console.log(`🖼️  [ImageEvacuation] Moving ${pending.photos} photo(s) and ${pending.attachments} attachment(s) out of the database...`);
    total = emptyCounts();

    // Each pass schedules the next only once it has finished, so a slow disk can never pile passes up.
    const schedule = (delay: number): void => {
        timer = setTimeout(() => {
            timer = null;
            if (running) { schedule(EVACUATION_INTERVAL_MS); return; }
            running = true;
            try {
                total = addCounts(total, evacuateImagesOnce());
                const left = pendingEvacuationCount();
                if (left.photos === 0 && left.attachments === 0) {
                    console.log(
                        `🖼️  [ImageEvacuation] Done: ${total.photosMoved} photo(s) (${mb(total.photoBytesMoved)}) and ` +
                        `${total.attachmentsMoved} attachment(s) (${mb(total.attachmentBytesMoved)}) moved to the image store` +
                        (total.photosSkipped + total.attachmentsSkipped > 0
                            ? `; ${total.photosSkipped + total.attachmentsSkipped} left in the database (their bytes could not be reproduced exactly).`
                            : '.')
                    );
                    reclaimSpaceOnce();
                    return; // nothing rescheduled: the job is over until the next restart
                }
            } catch (e) {
                console.warn('[ImageEvacuation] Pass failed; trying again shortly:', e);
            } finally {
                running = false;
            }
            schedule(EVACUATION_INTERVAL_MS);
        }, delay);
        timer.unref?.();
    };
    schedule(EVACUATION_START_DELAY_MS);
}

/** Stop the job — for tests and for a clean shutdown. */
export function stopImageEvacuation(): void {
    if (timer) { clearTimeout(timer); timer = null; }
}
