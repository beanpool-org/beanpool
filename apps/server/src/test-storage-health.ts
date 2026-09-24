/**
 * Test Suite: Storage Health, 3-Way Disk Breakdown, 80% Warning & One-Click Cleanup.
 *
 * Verifies:
 * 1. Disk usage broken down into database / media / logs.
 * 2. Warning flag triggers at >= 80% usage threshold.
 * 3. Clean preview lists orphaned media and compressible logs before performing cleanup.
 * 4. Cleanup deletes orphaned post photos while keeping valid ones.
 * 5. Cleanup removes orphaned pulse thumbnails while keeping valid ones.
 * 6. Cleanup compresses and archives logs exceeding the latest 500 rows to gzip.
 * 7. The orphan sweep runs ON A TIMER, not only when an admin presses Clean: an image-store object past the
 *    grace period is reclaimed by the scheduled job, one inside it is left alone, and a referenced one is
 *    never touched — and a `.tmp-` file a crashed write left behind is reclaimed too, because `list` hides
 *    it from everything else in the node and this sweep is the only thing that can ever find it.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { DiskImageStore } from './storage/image-store.js';
import {
    getDiskHealth,
    getStorageCleanPreview,
    cleanStorageAndCompressLogs,
    setSimulatedDiskUsageForTesting,
    startOrphanObjectSweep,
    stopOrphanObjectSweep,
} from './engine/storage-health.js';

let passed = 0;
let run = 0;

function assert(cond: boolean, msg: string) {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

async function runTests() {
    console.log('\n=== Testing Storage Health & Clean/Compress Operations ===\n');

    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-storage-test-'));
    const dbPath = path.join(testDir, 'state.db');
    const db = new Database(dbPath);

    // Setup required tables
    db.exec(`
        CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE post_photos (id TEXT PRIMARY KEY, post_id TEXT, photo_data BLOB);
        CREATE TABLE pulse_items (id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE system_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, message TEXT, metadata TEXT);
    `);

    // Setup thumbnail dir
    const thumbDir = path.join(testDir, 'cache', 'pulse-thumbnails');
    fs.mkdirSync(thumbDir, { recursive: true });

    // Setup logs dir
    const logsDir = path.join(testDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    // Seed valid post & photo
    db.prepare("INSERT INTO posts VALUES ('post-1', 'Valid Post')").run();
    db.prepare("INSERT INTO post_photos VALUES ('photo-1', 'post-1', 'valid_photo_bytes_data')").run();

    // Seed orphaned photo
    db.prepare("INSERT INTO post_photos VALUES ('photo-orphan', 'deleted-post-99', 'orphaned_bytes_data_12345')").run();

    // Seed valid thumbnail
    db.prepare("INSERT INTO pulse_items VALUES ('pulse-1', 'Valid Pulse')").run();
    fs.writeFileSync(path.join(thumbDir, 'pulse-1.bin'), Buffer.from('pulse_1_thumbnail_bytes'));
    fs.writeFileSync(path.join(thumbDir, 'pulse-1.json'), JSON.stringify({ mime: 'image/jpeg' }));

    // Seed orphaned thumbnail
    fs.writeFileSync(path.join(thumbDir, 'pulse-orphan.bin'), Buffer.from('orphaned_thumbnail_bytes_to_clean'));
    fs.writeFileSync(path.join(thumbDir, 'pulse-orphan.json'), JSON.stringify({ mime: 'image/jpeg' }));

    // Seed 550 log entries (50 compressible)
    const insertLog = db.prepare("INSERT INTO system_logs (timestamp, message, metadata) VALUES (?, ?, ?)");
    for (let i = 1; i <= 550; i++) {
        insertLog.run(`2026-09-01T00:${String(i).padStart(2, '0')}:00.000Z`, `Log event number ${i}`, `metadata-${i}`);
    }

    // 1. Test Disk Health breakdown
    console.log('--- 1. Disk Health & 3-Way Breakdown ---');
    setSimulatedDiskUsageForTesting(45);
    const healthNormal = getDiskHealth({ db, dataDir: testDir });
    assert(healthNormal.warning === false, 'Usage at 45% has warning = false');
    assert(healthNormal.breakdown.database.dbSizeBytes > 0, 'Database size calculated');
    assert(healthNormal.breakdown.media.postPhotosCount === 2, 'Found 2 post photos');
    assert(healthNormal.breakdown.media.pulseThumbnailsCount === 2, 'Found 2 pulse thumbnails');
    assert(healthNormal.breakdown.logs.systemLogsCount === 550, 'Found 550 system logs');

    // 2. Test 80% warning threshold
    console.log('\n--- 2. 80% Safety Warning Threshold ---');
    setSimulatedDiskUsageForTesting(80);
    const healthWarning80 = getDiskHealth({ db, dataDir: testDir });
    assert(healthWarning80.warning === true, 'Usage at 80% triggers warning = true');

    setSimulatedDiskUsageForTesting(92);
    const healthWarning92 = getDiskHealth({ db, dataDir: testDir });
    assert(healthWarning92.warning === true, 'Usage at 92% triggers warning = true');

    // Reset simulation
    setSimulatedDiskUsageForTesting(null);

    // 3. Test Clean Preview
    console.log('\n--- 3. Storage Clean Preview ---');
    const preview = getStorageCleanPreview({ db, dataDir: testDir });
    assert(preview.orphanedPostPhotos.count === 1, 'Preview found 1 orphaned photo');
    assert(preview.orphanedPostPhotos.totalBytes > 0, 'Preview calculated orphaned photo bytes');
    assert(preview.orphanedThumbnails.count === 1, 'Preview found 1 orphaned thumbnail');
    assert(preview.orphanedThumbnails.totalBytes > 0, 'Preview calculated orphaned thumbnail bytes');
    assert(preview.compressibleLogs.count === 50, `Preview found 50 compressible logs (got: ${preview.compressibleLogs.count})`);
    assert(preview.totalReclaimableBytes > 0, 'Total reclaimable bytes calculated');

    // 4. Test Clean and Compress Execution
    console.log('\n--- 4. Clean Storage & Compress Logs Execution ---');
    const cleanResult = cleanStorageAndCompressLogs({ db, dataDir: testDir });
    assert(cleanResult.success === true, 'Cleanup completed successfully');
    assert(cleanResult.removedPhotosCount === 1, 'Removed 1 orphaned photo');
    assert(cleanResult.removedThumbnailsCount === 1, 'Removed 1 orphaned thumbnail');
    assert(cleanResult.compressedLogsCount === 50, 'Compressed and pruned 50 logs');
    assert(cleanResult.totalReclaimedBytes > 0, 'Reclaimed positive bytes');

    // Verify post photos state
    const remainingPhotos = db.prepare('SELECT id FROM post_photos').all() as any[];
    assert(remainingPhotos.length === 1 && remainingPhotos[0].id === 'photo-1', 'Valid photo preserved, orphan removed');

    // Verify thumbnails on disk
    assert(fs.existsSync(path.join(thumbDir, 'pulse-1.bin')), 'Valid thumbnail preserved on disk');
    assert(!fs.existsSync(path.join(thumbDir, 'pulse-orphan.bin')), 'Orphaned thumbnail removed from disk');
    assert(!fs.existsSync(path.join(thumbDir, 'pulse-orphan.json')), 'Orphaned thumbnail metadata removed from disk');

    // Verify logs state in db
    const remainingLogs = db.prepare('SELECT COUNT(*) as c FROM system_logs').get() as any;
    assert(remainingLogs.c === 500, `Remaining logs capped at 500 (got: ${remainingLogs.c})`);

    // Verify compressed archive written
    const archiveDir = path.join(testDir, 'logs', 'archived');
    assert(fs.existsSync(archiveDir), 'Logs archive directory created');
    const archiveFiles = fs.readdirSync(archiveDir);
    assert(archiveFiles.length === 1 && archiveFiles[0].endsWith('.json.gz'), 'Compressed gzip archive file exists');

    // Verify gzip archive contents
    const gzipped = fs.readFileSync(path.join(archiveDir, archiveFiles[0]));
    const decompressed = zlib.gunzipSync(gzipped).toString('utf8');
    const parsedLogs = JSON.parse(decompressed);
    assert(parsedLogs.length === 50, 'Archived gzip contains all 50 pruned logs');
    assert(parsedLogs[0].message === 'Log event number 1', 'First archived log verified');

    // 5. Test SHA-256 hashed thumbnails & soft-deletion (deleted_at)
    console.log('\n--- 5. SHA-256 Hashed Pulse Thumbnails & Soft Deletes ---');
    try {
        db.exec("ALTER TABLE pulse_items ADD COLUMN deleted_at TEXT");
    } catch {}

    const crypto = await import('node:crypto');
    const hash = (id: string) => crypto.createHash('sha256').update(id).digest('hex');

    const validItemId = 'item_curated_valid_123';
    const softDeletedItemId = 'item_curated_soft_del_456';
    const missingItemId = 'item_curated_missing_789';

    db.prepare("INSERT INTO pulse_items (id, title, deleted_at) VALUES (?, ?, NULL)").run(validItemId, 'Active Pulse');
    db.prepare("INSERT INTO pulse_items (id, title, deleted_at) VALUES (?, ?, '2026-09-10T12:00:00Z')").run(softDeletedItemId, 'Deleted Pulse');

    const validHash = hash(validItemId);
    const softDelHash = hash(softDeletedItemId);
    const missingHash = hash(missingItemId);

    fs.writeFileSync(path.join(thumbDir, `${validHash}.bin`), Buffer.from('valid_thumb'));
    fs.writeFileSync(path.join(thumbDir, `${validHash}.json`), JSON.stringify({ itemId: validItemId, mime: 'image/jpeg' }));

    fs.writeFileSync(path.join(thumbDir, `${softDelHash}.bin`), Buffer.from('soft_del_thumb'));
    fs.writeFileSync(path.join(thumbDir, `${softDelHash}.json`), JSON.stringify({ itemId: softDeletedItemId, mime: 'image/jpeg' }));

    fs.writeFileSync(path.join(thumbDir, `${missingHash}.bin`), Buffer.from('missing_thumb'));
    fs.writeFileSync(path.join(thumbDir, `${missingHash}.json`), JSON.stringify({ itemId: missingItemId, mime: 'image/jpeg' }));

    const previewHashed = getStorageCleanPreview({ db, dataDir: testDir });
    // Out of the 3 hashed thumbnails: 1 is valid, 2 are orphans (soft-deleted + missing)
    assert(previewHashed.orphanedThumbnails.count === 2, `Preview identifies 2 orphaned hashed thumbnails (got: ${previewHashed.orphanedThumbnails.count})`);

    const cleanHashed = cleanStorageAndCompressLogs({ db, dataDir: testDir });
    assert(cleanHashed.removedThumbnailsCount === 2, `Cleaned 2 orphaned hashed thumbnails (got: ${cleanHashed.removedThumbnailsCount})`);

    assert(fs.existsSync(path.join(thumbDir, `${validHash}.bin`)), 'Valid hashed thumbnail .bin preserved');
    assert(fs.existsSync(path.join(thumbDir, `${validHash}.json`)), 'Valid hashed thumbnail .json preserved');
    assert(!fs.existsSync(path.join(thumbDir, `${softDelHash}.bin`)), 'Soft-deleted hashed thumbnail .bin removed');
    assert(!fs.existsSync(path.join(thumbDir, `${softDelHash}.json`)), 'Soft-deleted hashed thumbnail .json removed');
    assert(!fs.existsSync(path.join(thumbDir, `${missingHash}.bin`)), 'Missing item hashed thumbnail .bin removed');
    assert(!fs.existsSync(path.join(thumbDir, `${missingHash}.json`)), 'Missing item hashed thumbnail .json removed');

    // 7. The sweep runs by itself.
    //
    // Everything in the image store that is "swept later" used to mean "kept until a human opens Settings →
    // Storage and presses Clean": the objects a rolled-back transaction left, the old object behind an
    // INSERT OR REPLACE on a replica, a post-commit delete that hit an I/O error. Nothing is ever SERVED
    // from them — every serving path reads the row first — but a member's deleted photo sat on the disk
    // indefinitely on a node nobody administers, which is most of them.
    console.log('\n--- 7. The orphan sweep runs on a timer ---');
    const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-sweep-test-'));
    const sweepDb = new Database(path.join(sweepDir, 'state.db'));
    sweepDb.exec(`
        CREATE TABLE post_photos (post_id TEXT, order_num INTEGER, photo_data TEXT, storage_key TEXT);
        CREATE TABLE message_attachments (message_id TEXT PRIMARY KEY, data TEXT, storage_key TEXT);
    `);
    const sweepImages = path.join(sweepDir, 'images', 'posts', 'p1');
    fs.mkdirSync(sweepImages, { recursive: true });
    const objectAt = (name: string) => path.join(sweepImages, name);
    fs.writeFileSync(objectAt('0-referenced.jpg'), Buffer.from('a photo a row still points at'));
    fs.writeFileSync(objectAt('1-oldorphan.jpg'), Buffer.from('a deleted photo, an hour ago'));
    fs.writeFileSync(objectAt('2-neworphan.jpg'), Buffer.from('a photo being written right now'));
    // Half-written objects: a crash mid-`put`, or mid-`copyObjectReplacing` during a restore. `list` skips
    // these by name, so nothing else in the node — totalBytes, the media breakdown, the referenced-key walk
    // — can see them. The old one must go; the fresh one may be a write in flight this second.
    fs.writeFileSync(objectAt('3-crashed.jpg.tmp-a1b2c3d4e5f6'), Buffer.from('half of a photo, from a crash'));
    fs.writeFileSync(objectAt('4-inflight.jpg.tmp-99887766aabb'), Buffer.from('a put happening right now'));
    sweepDb.prepare('INSERT INTO post_photos (post_id, order_num, storage_key) VALUES (?, ?, ?)')
        .run('p1', 0, 'posts/p1/0-referenced.jpg');
    // Past the one-hour grace period. The fresh one keeps today's mtime: it is indistinguishable from a
    // photo whose row is a millisecond away from being written, and deleting it would break that post.
    const threeHoursAgo = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(objectAt('1-oldorphan.jpg'), threeHoursAgo, threeHoursAgo);
    fs.utimesSync(objectAt('3-crashed.jpg.tmp-a1b2c3d4e5f6'), threeHoursAgo, threeHoursAgo);

    // Before the sweep: the preview counts the leftover, and `list` still refuses to show it.
    const previewWithTemp = getStorageCleanPreview({ db: sweepDb, dataDir: sweepDir });
    assert(previewWithTemp.orphanedImageObjects.count === 2,
        `the preview counts the stale orphan AND the crashed write, and neither fresh one (got ${previewWithTemp.orphanedImageObjects.count})`);
    const listed = new DiskImageStore(path.join(sweepDir, 'images')).list('');
    assert(!listed.some((k) => k.includes('.tmp-')),
        `…while list() still hides half-written objects from everything that serves or counts them (${listed.join(', ')})`);

    stopOrphanObjectSweep();
    startOrphanObjectSweep({ firstDelayMs: 40, intervalMs: 60_000, db: sweepDb, dataDir: sweepDir });
    await new Promise((r) => setTimeout(r, 400));
    stopOrphanObjectSweep();

    assert(!fs.existsSync(objectAt('1-oldorphan.jpg')),
        'the scheduled sweep removed an orphan past the grace period — nobody pressed anything');
    assert(fs.existsSync(objectAt('2-neworphan.jpg')),
        'and left the one inside the grace period, which may be a post mid-write');
    assert(fs.existsSync(objectAt('0-referenced.jpg')),
        'and never touched the object a row still points at');
    assert(!fs.existsSync(objectAt('3-crashed.jpg.tmp-a1b2c3d4e5f6')),
        'and reclaimed the half-written file a crash left behind, which nothing else in the node can see');
    assert(fs.existsSync(objectAt('4-inflight.jpg.tmp-99887766aabb')),
        'but not the one inside the grace period, which is a put happening right now');

    // Armed once: a second start must not stack a second timer on the first.
    startOrphanObjectSweep({ firstDelayMs: 40, intervalMs: 60_000, db: sweepDb, dataDir: sweepDir });
    startOrphanObjectSweep({ firstDelayMs: 40, intervalMs: 60_000, db: sweepDb, dataDir: sweepDir });
    stopOrphanObjectSweep();
    assert(true, 'starting the sweep twice arms one timer, and stopping it disarms cleanly');

    sweepDb.close();
    try { fs.rmSync(sweepDir, { recursive: true, force: true }); } catch {}

    // Clean up
    db.close();
    try {
        fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}

    console.log(`\nAll ${passed}/${run} storage health tests passed.`);
    console.log('⭐️ Storage health & cleanup operations PASSED.\n');
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
