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
 * 8. On an S3 bucket holding thousands of orphans (an older backup restored), the sweep never holds the event
 *    loop: one pass removes at most the per-pass cap, the longest the loop is held is measured, repeated passes
 *    converge, and the timer carries on in short passes until nothing is left. The admin Clean answers within
 *    its budget and says how many it removed and how many remain. A write racing the sweep's delete of the
 *    same key is never lost, and an object written again after the listing is not deleted on stale news.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { DiskImageStore } from './storage/image-store.js';
import { S3ImageStore } from './storage/s3-image-store.js';
import { startFakeS3 } from './fake-s3-test-harness.js';
// The whole module as well as the names: section 8 reads the per-pass cap and the Clean's budget off it.
import * as health from './engine/storage-health.js';
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
    const preview = await getStorageCleanPreview({ db, dataDir: testDir });
    assert(preview.orphanedPostPhotos.count === 1, 'Preview found 1 orphaned photo');
    assert(preview.orphanedPostPhotos.totalBytes > 0, 'Preview calculated orphaned photo bytes');
    assert(preview.orphanedThumbnails.count === 1, 'Preview found 1 orphaned thumbnail');
    assert(preview.orphanedThumbnails.totalBytes > 0, 'Preview calculated orphaned thumbnail bytes');
    assert(preview.compressibleLogs.count === 50, `Preview found 50 compressible logs (got: ${preview.compressibleLogs.count})`);
    assert(preview.totalReclaimableBytes > 0, 'Total reclaimable bytes calculated');

    // 4. Test Clean and Compress Execution
    console.log('\n--- 4. Clean Storage & Compress Logs Execution ---');
    const cleanResult = await cleanStorageAndCompressLogs({ db, dataDir: testDir });
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

    const previewHashed = await getStorageCleanPreview({ db, dataDir: testDir });
    // Out of the 3 hashed thumbnails: 1 is valid, 2 are orphans (soft-deleted + missing)
    assert(previewHashed.orphanedThumbnails.count === 2, `Preview identifies 2 orphaned hashed thumbnails (got: ${previewHashed.orphanedThumbnails.count})`);

    const cleanHashed = await cleanStorageAndCompressLogs({ db, dataDir: testDir });
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
    const previewWithTemp = await getStorageCleanPreview({ db: sweepDb, dataDir: sweepDir });
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

    await onABucket();

    // Clean up
    db.close();
    try {
        fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}

    console.log(`\nAll ${passed}/${run} storage health tests passed.`);
    console.log('⭐️ Storage health & cleanup operations PASSED.\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (await cond()) return;
        await sleep(10);
    }
    throw new Error(`Timed out waiting for ${what}`);
}

/**
 * The longest the event loop went without running a 2 ms interval while `fn` ran, and how long `fn` took. A
 * blocking round trip to the bucket stops the interval dead, so a sweep that holds the node shows up here as
 * a hold as long as the sweep itself.
 */
async function longestHold<T>(fn: () => Promise<T> | T): Promise<{ value: T; holdMs: number; tookMs: number }> {
    let last = performance.now();
    let longest = 0;
    const tick = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 2);
    const t0 = performance.now();
    try {
        const value = await fn();
        const now = performance.now();
        return { value, holdMs: Math.max(longest, now - last), tookMs: now - t0 };
    } finally {
        clearInterval(tick);
    }
}

/** Far below the ~60 s the host watchdog allows, and far above a healthy loop's jitter on a loaded CI box. */
const HOLD_BOUND_MS = 250;

// 8. On a bucket.
//
// Restoring an older backup onto an s3 node leaves every object written since then with no row, and all of them
// long past the grace period. The sweep used to delete them in one synchronous loop — a blocking HEAD and a
// blocking DELETE per object, and a blocking LIST per thousand — so a few hundred of them held the node for tens
// of seconds, past the ~60 s host watchdog, which restarted it; and the next sweep did the same.
async function onABucket(): Promise<void> {
    console.log('\n--- 8. On an S3 bucket the sweep is bounded and never holds the node ---');
    // Every check here reports and carries on, so a failure shows every way the sweep falls short at once.
    const failures: string[] = [];
    const check = (cond: boolean, msg: string) => {
        run++;
        if (cond) { passed++; console.log(`✓ ${msg}`); } else { failures.push(msg); console.error(`✗ ${msg}`); }
    };
    const fake = await startFakeS3();
    const s3 = new S3ImageStore(fake.config());
    const s3Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-sweep-s3-'));
    const s3Db = new Database(path.join(s3Dir, 'state.db'));
    const makeTables = (d: Database.Database) => d.exec(`
        CREATE TABLE post_photos (post_id TEXT, order_num INTEGER, photo_data TEXT, storage_key TEXT);
        CREATE TABLE message_attachments (message_id TEXT PRIMARY KEY, data TEXT, storage_key TEXT);
    `);
    makeTables(s3Db);
    const photo = Buffer.from('a photo from after the backup that was restored');
    const longAgo = Date.now() - 3 * 60 * 60 * 1000;
    const seedOrphans = async (tag: string, n: number) => {
        for (let i = 0; i < n; i += 200) {
            await Promise.all(Array.from({ length: Math.min(200, n - i) }, (_, j) =>
                fake.seed(`posts/${tag}-${String(i + j).padStart(5, '0')}/0-0a0b0c0d.jpg`, photo, 'image/jpeg', longAgo)));
        }
    };
    const countUnder = async (prefix: string) => [...(await fake.objects()).keys()].filter((k) => k.startsWith(prefix)).length;
    const requests = async (method: string, pathEnd?: string) =>
        (await fake.log()).filter((e) => e.method === method && (!pathEnd || e.path.endsWith(pathEnd))).length;
    const sweep = (db: Database.Database = s3Db) => health.sweepOrphanedImageObjects({ db, store: s3 }) as any;

    const ORPHANS = 1_200;
    await seedOrphans('restored-away', ORPHANS);
    // What must survive every pass: an object a row points at, and a fresh one (a photo being written now).
    await fake.seed('posts/kept/0-11111111.jpg', photo, 'image/jpeg', longAgo);
    s3Db.prepare('INSERT INTO post_photos (post_id, order_num, storage_key) VALUES (?, ?, ?)').run('kept', 0, 'posts/kept/0-11111111.jpg');
    await fake.seed('posts/fresh/0-22222222.jpg', photo, 'image/jpeg');

    const cap = (health as any).ORPHAN_SWEEP_BATCH_S3 as number | undefined;
    check(typeof cap === 'number' && cap > 0 && cap < ORPHANS,
        `a pass on a bucket has a per-pass cap (${cap}), below the ${ORPHANS} orphans waiting`);

    await fake.clearLog();
    const first = await longestHold(() => sweep());
    const firstDeletes = await requests('DELETE');
    check(first.value.removed > 0 && first.value.removed <= (cap ?? 0) && firstDeletes <= (cap ?? 0),
        `one pass removes at most the cap (removed ${first.value.removed}, ${firstDeletes} DELETE request(s))`);
    check(first.value.remaining === ORPHANS - first.value.removed,
        `and says how many it left for the next pass (remaining: ${first.value.remaining})`);
    check(first.holdMs < HOLD_BOUND_MS,
        `the event loop was never held longer than ${HOLD_BOUND_MS} ms during the pass `
        + `(longest: ${first.holdMs.toFixed(0)} ms, over a pass of ${first.tookMs.toFixed(0)} ms)`);

    let passes = 1;
    let removedTotal = first.value.removed;
    let worstHold = first.holdMs;
    while (passes < 10 && (await countUnder('posts/restored-away-')) > 0) {
        const next = await longestHold(() => sweep());
        passes++;
        removedTotal += next.value.removed;
        worstHold = Math.max(worstHold, next.holdMs);
    }
    check((await countUnder('posts/restored-away-')) === 0 && removedTotal === ORPHANS,
        `repeated passes converge: all ${ORPHANS} removed, in ${passes} passes`);
    check(worstHold < HOLD_BOUND_MS, `and no pass held the loop longer than ${HOLD_BOUND_MS} ms (worst: ${worstHold.toFixed(0)} ms)`);
    let survivors = await fake.objects();
    check(survivors.has('posts/kept/0-11111111.jpg'), 'the object a row points at survived every pass');
    check(survivors.has('posts/fresh/0-22222222.jpg'), 'and so did the fresh one, inside the grace period');

    // The admin Clean: within its budget, and honest about what it did not get to.
    const CLEAN_ORPHANS = 1_000;
    await seedOrphans('clean', CLEAN_ORPHANS);
    // A bucket some distance away: every DELETE takes 10 ms to answer.
    await fake.fault({ method: 'DELETE', delayMs: 10, count: 1_000_000 });
    const budget = (health as any).CLEAN_SWEEP_BUDGET_MS as number | undefined;
    check(typeof budget === 'number' && budget > 0 && budget <= 10_000, `the Clean has a time budget for the bucket (${budget} ms)`);
    const clean = await longestHold(() => cleanStorageAndCompressLogs({ db: s3Db, dataDir: s3Dir, store: s3 }));
    await fake.clearFaults();
    const cleaned = clean.value as any;
    check(clean.tookMs < (budget ?? 0) + 2_000,
        `the Clean answered in ${clean.tookMs.toFixed(0)} ms: its budget, not the ${CLEAN_ORPHANS} orphans, decides how long`);
    check(clean.holdMs < HOLD_BOUND_MS,
        `without holding the event loop longer than ${HOLD_BOUND_MS} ms (longest: ${clean.holdMs.toFixed(0)} ms)`);
    check(cleaned.removedImageObjectsCount > 0 && cleaned.removedImageObjectsCount < CLEAN_ORPHANS,
        `it removed some of them (${cleaned.removedImageObjectsCount})`);
    check(cleaned.remainingImageObjectsCount === CLEAN_ORPHANS - cleaned.removedImageObjectsCount,
        `and says how many remain (${cleaned.remainingImageObjectsCount}): "N removed, more remain", never a false "done"`);
    check((await countUnder('posts/clean-')) === cleaned.remainingImageObjectsCount, 'which is exactly what is still in the bucket');
    for (let i = 0; i < 10 && (await countUnder('posts/clean-')) > 0; i++) await sweep();
    check((await countUnder('posts/clean-')) === 0, 'and the sweep takes the rest');

    // A bucket slow to LIST: each listing alone outlasts the whole budget. The budget bounds the deletes, so the
    // Clean still removes some itself rather than answering "0 removed, more remain" every time it is pressed.
    await seedOrphans('slowlist', 50);
    await fake.fault({ method: 'GET', delayMs: (budget ?? 3_000) + 500, count: 1_000_000 });
    const slow = (await cleanStorageAndCompressLogs({ db: s3Db, dataDir: s3Dir, store: s3 })) as any;
    await fake.clearFaults();
    check(slow.removedImageObjectsCount > 0,
        `with every LIST taking longer than the budget, the Clean still removed ${slow.removedImageObjectsCount} itself`);
    for (let i = 0; i < 10 && (await countUnder('posts/slowlist-')) > 0; i++) await sweep();
    check((await countUnder('posts/slowlist-')) === 0, 'and the sweep takes whatever it left');

    // The timer carries on by itself: a pass that stops at the cap schedules the next one soon, not tomorrow.
    const TIMER_ORPHANS = Math.round((cap ?? 500) * 2.5);
    await seedOrphans('timer', TIMER_ORPHANS);
    stopOrphanObjectSweep();
    startOrphanObjectSweep({ firstDelayMs: 20, intervalMs: 24 * 60 * 60 * 1000, continueMs: 30, db: s3Db, store: s3 } as any);
    await waitFor('the scheduled sweep to clear the bucket', async () => (await countUnder('posts/timer-')) === 0, 60_000)
        .catch(() => { /* asserted below */ });
    stopOrphanObjectSweep();
    check((await countUnder('posts/timer-')) === 0,
        `the scheduled sweep carried on in short passes until all ${TIMER_ORPHANS} were gone, rather than one pass a day`);

    // Safe to interrupt: stopped mid-pass, it sends no further deletes, and the next pass finishes the job.
    await seedOrphans('interrupted', cap ?? 500);
    await fake.clearLog();
    await fake.fault({ method: 'DELETE', delayMs: 5, count: 1_000_000 });
    startOrphanObjectSweep({ firstDelayMs: 0, intervalMs: 24 * 60 * 60 * 1000, continueMs: 30, db: s3Db, store: s3 } as any);
    await waitFor('the sweep to be part-way through', async () => (await requests('DELETE')) >= 10).catch(() => {});
    stopOrphanObjectSweep();
    await sleep(100);
    const deletesAtStop = await requests('DELETE');
    await sleep(400);
    const deletesLater = await requests('DELETE');
    await fake.clearFaults();
    const leftAtStop = await countUnder('posts/interrupted-');
    check(deletesLater === deletesAtStop && leftAtStop > 0,
        `stopped part-way, it sent no further deletes (${deletesAtStop} then ${deletesLater}) and left the rest (${leftAtStop}) where they were`);
    for (let i = 0; i < 10 && (await countUnder('posts/interrupted-')) > 0; i++) await sweep();
    check((await countUnder('posts/interrupted-')) === 0, 'and the next pass picked up where it stopped');

    // A write racing the sweep's delete of the SAME key is never lost.
    const raced = 'posts/raced/0-33333333.jpg';
    await fake.seed(raced, photo, 'image/jpeg', longAgo);
    await fake.clearLog();
    await fake.fault({ method: 'DELETE', prefix: `/${fake.bucket}/${raced}`, delayMs: 400, count: 1 });
    const racing = sweep();
    await waitFor('the DELETE of the raced key to reach the bucket', async () => (await requests('DELETE', raced)) > 0);
    let blockingRefused = false;
    try { s3.put(raced, photo, { mime: 'image/jpeg' }); } catch { blockingRefused = true; }
    check(blockingRefused,
        'a blocking write of a key the sweep is deleting that moment is refused (the photo stays in its row), not sent to race the DELETE');
    const lateWrite = s3.putAsync(raced, photo, { mime: 'image/jpeg' });
    await racing;
    await lateWrite;
    check((await fake.objects()).has(raced), 'a non-blocking write of it waits for the delete and lands after it: the photo is in the bucket');

    // An object written again after the listing is judged as it is NOW, not on the listing's word.
    const staleA = 'posts/stale-a/0-44444444.jpg';
    const staleB = 'posts/stale-b/0-55555555.jpg';
    await fake.remove(raced);
    await fake.seed(staleA, photo, 'image/jpeg', longAgo);
    await fake.seed(staleB, photo, 'image/jpeg', longAgo);
    await fake.clearLog();
    await fake.fault({ method: 'HEAD', prefix: `/${fake.bucket}/${staleA}`, delayMs: 300, count: 1 });
    const sweepingStale = sweep();
    await waitFor('the sweep to reach the first of the two', async () => (await requests('HEAD', staleA)) > 0);
    // While it waits on the first, a member re-posts the photo the second one is: written again, and a row made.
    s3.put(staleB, photo, { mime: 'image/jpeg' });
    s3Db.prepare('INSERT INTO post_photos (post_id, order_num, storage_key) VALUES (?, ?, ?)').run('stale-b', 0, staleB);
    await sweepingStale;
    survivors = await fake.objects();
    check(!survivors.has(staleA), 'the aged orphan the listing found went');
    check(survivors.has(staleB), 'the one written again after the listing stayed: it was judged as it is now, not as it was listed');

    // A restore closes the database under a running pass. From then on the pass deletes nothing: what it judged
    // the objects against is the database that just went, and the one replacing it may well name them.
    const swapDb = new Database(path.join(s3Dir, 'swap.db'));
    makeTables(swapDb);
    // Named to come first in the listing. Against this empty database every object in the bucket is an orphan —
    // the kept one and the re-posted one included — so it is the close, and only the close, that saves them.
    const swapA = 'posts/aa-swap-1/0-66666666.jpg';
    const swapB = 'posts/aa-swap-2/0-77777777.jpg';
    await fake.seed(swapA, photo, 'image/jpeg', longAgo);
    await fake.seed(swapB, photo, 'image/jpeg', longAgo);
    await fake.clearLog();
    await fake.fault({ method: 'HEAD', prefix: `/${fake.bucket}/${swapA}`, delayMs: 300, count: 1 });
    const sweepingSwap = sweep(swapDb);
    await waitFor('the sweep to reach the first object', async () => (await requests('HEAD', swapA)) > 0);
    swapDb.close();
    const swapPass = await sweepingSwap;
    survivors = await fake.objects();
    check([swapA, swapB, 'posts/kept/0-11111111.jpg', staleB].every((k) => survivors.has(k)) && swapPass.removed === 0,
        `once the database it judged against is closed, the pass deletes nothing (removed ${swapPass.removed})`);

    await s3.close();
    await fake.stop();
    s3Db.close();
    try { fs.rmSync(s3Dir, { recursive: true, force: true }); } catch {}
    if (failures.length) throw new Error(`${failures.length} check(s) failed in section 8: ${failures.join(' | ')}`);
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
