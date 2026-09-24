/**
 * Test Suite: moving a node's images out of state.db, and everything that must not change when it happens.
 *
 * This suite starts from a state.db in the shape a node ALREADY RUNNING carries — `photo_data TEXT NOT NULL`,
 * `data TEXT NOT NULL`, every image inline — because that is what the upgrade ladder and the evacuation job
 * actually meet on mullum and castlemaine. Everything after that is the same node, one version later.
 *
 * Verifies:
 *   1. The upgrade ladder rebuilds post_photos and message_attachments so the inline column may be NULL,
 *      without losing a row or a byte.
 *   2. A NEW photo is written straight to the store: storage_key set, photo_data null, sha256 correct.
 *   3. Serving is byte-identical before and after evacuation, with the same content type and the same
 *      cache headers, on the same URL.
 *   4. The evacuation job nulls a column only after a verified put, is idempotent, and is resumable —
 *      including from the exact state a kill between "put" and "update the row" leaves behind. A store that
 *      stops answering ends the pass without giving up on any row.
 *   5. A sync export is byte-identical for an evacuated photo: the federation payload does not change —
 *      and a photo this node can no longer read is omitted from the payload rather than exported empty,
 *      so a replica holding the only good copy keeps it.
 *   6. The serving route consults the ROW, never the store: a photo whose row has gone 404s while its file
 *      is still on disk, and an object with no row is never served. And a post whose object has vanished is
 *      still editable — the member can replace or remove the broken photo rather than meeting a 500.
 *   7. An attachment's ciphertext and nonce come back unchanged through the store.
 *   8. A backup carries images/ beside state.db, and a backup taken BEFORE this change still restores.
 *   9. storage-health counts the store, and sweeps objects no row points at.
 *  10. The database is measurably smaller afterwards.
 *  11. An import writes a peer's photos to disk BEFORE it opens its write transaction, so a big resync
 *      never holds the write lock across one fsync per photo.
 *  12. A FORCE-RESYNC does not destroy the replica's only good copy. The export omits a row whose object the
 *      primary cannot read, and names it in the payload; `clearReplicatedTables` keeps exactly those rows, so
 *      the row and its object survive the wipe that used to delete both. LAST, because it empties the tables.
 *  13. And it holds at the size that actually happens: a lost images directory omits EVERY evacuated photo,
 *      so a keep list of thousands spares exactly those rows rather than hitting SQLite's expression-depth
 *      limit — and a failure there aborts the resync instead of committing a table that was never cleared.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-image-evacuation.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const PORT = 8571;
const BASE = `https://localhost:${PORT}`;
const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}

/** A photo of a realistic size: ~90 KB of incompressible bytes behind a real JPEG header. */
function makePhoto(seed: string): Buffer {
    const body = crypto.createHash('sha512').update(seed).digest();
    const filler = Buffer.alloc(90 * 1024);
    for (let i = 0; i < filler.length; i += body.length) body.copy(filler, i);
    // Deterministic per seed, and not a run of zeroes, so the fixture's size is honest about a real node.
    for (let i = 0; i < filler.length; i++) filler[i] ^= (i * 31 + seed.charCodeAt(0)) & 0xff;
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), filler, Buffer.from([0xff, 0xd9])]);
}
function dataUrl(buf: Buffer, mime = 'image/jpeg'): string {
    return `data:${mime};base64,${buf.toString('base64')}`;
}
function dbSizeBytes(file: string): number {
    try { return fs.statSync(file).size; } catch { return 0; }
}

/** How many inline photos the fixture carries. Enough for the size measurement to mean something. */
const FIXTURE_PHOTOS = 30;
const FIXTURE_ATTACHMENTS = 10;

/**
 * Build a state.db in the OLD shape, before anything imports db.ts. `CREATE TABLE IF NOT EXISTS` in
 * schema.sql is a no-op on a table that already exists, so this is the only way to exercise the rebuild the
 * live nodes will go through.
 */
function seedLegacyDatabase(): { photos: { postId: string; order: number; value: string }[]; attachments: { id: string; data: string; nonce: string }[] } {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const legacy = new Database(path.join(DATA_DIR, 'state.db'));
    legacy.pragma('journal_mode = WAL');
    // As the node runs (db.ts: an accepted risk, documented there). Without it these two tables cannot even
    // be written to until `posts` and `messages` exist, and creating stubs for them here would make
    // schema.sql's CREATE TABLE IF NOT EXISTS skip the real ones.
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`
        CREATE TABLE IF NOT EXISTS post_photos (
            post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
            photo_data TEXT NOT NULL,
            order_num INTEGER NOT NULL,
            updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            PRIMARY KEY (post_id, order_num)
        );
        CREATE TABLE IF NOT EXISTS message_attachments (
            message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            data TEXT NOT NULL,
            nonce TEXT NOT NULL,
            mime TEXT,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_post_photos_updated_at ON post_photos(updated_at);
        -- A live node has this trigger and this index already, created by an earlier boot's schema.sql.
        -- The rebuild DROPs the table, which takes its trigger and index with it, and schema.sql puts them
        -- back afterwards. Without them here the fixture would rebuild an easier table than the real one.
        CREATE TRIGGER IF NOT EXISTS post_photos_touch_updated_at
        AFTER UPDATE ON post_photos
        FOR EACH ROW
        WHEN NEW.updated_at IS OLD.updated_at
        BEGIN
            UPDATE post_photos SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
        END;
    `);
    const photos: { postId: string; order: number; value: string }[] = [];
    const insertPhoto = legacy.prepare(
        `INSERT INTO post_photos (post_id, photo_data, order_num, updated_at) VALUES (?, ?, ?, ?)`);
    for (let i = 0; i < FIXTURE_PHOTOS; i++) {
        const postId = `legacy-post-${String(i).padStart(3, '0')}`;
        const value = dataUrl(makePhoto(`photo-${i}`));
        insertPhoto.run(postId, value, 0, '2026-01-01T00:00:00.000Z');
        photos.push({ postId, order: 0, value });
    }
    // One photo the store must REFUSE to take: base64 wrapped across lines, which re-encodes differently.
    const wrapped = `data:image/jpeg;base64,${makePhoto('wrapped').toString('base64').replace(/(.{40})/, '$1\n')}`;
    insertPhoto.run('legacy-post-wrapped', wrapped, 0, '2026-01-01T00:00:00.000Z');
    photos.push({ postId: 'legacy-post-wrapped', order: 0, value: wrapped });

    const attachments: { id: string; data: string; nonce: string }[] = [];
    const insertAttachment = legacy.prepare(
        `INSERT INTO message_attachments (message_id, data, nonce, mime) VALUES (?, ?, ?, ?)`);
    for (let i = 0; i < FIXTURE_ATTACHMENTS; i++) {
        const id = `legacy-msg-${String(i).padStart(3, '0')}`;
        const data = makePhoto(`cipher-${i}`).toString('base64');
        const nonce = crypto.randomBytes(24).toString('base64');
        insertAttachment.run(id, data, nonce, 'image/jpeg');
        attachments.push({ id, data, nonce });
    }
    // Fold the WAL back into state.db so the "before" size is the whole database, not the part of it that
    // happens to have been checkpointed.
    legacy.pragma('wal_checkpoint(TRUNCATE)');
    legacy.close();
    return { photos, attachments };
}

async function main(): Promise<void> {
    console.log('\n=== Testing the image evacuation, end to end ===\n');

    const fixture = seedLegacyDatabase();
    const dbFile = path.join(DATA_DIR, 'state.db');
    const sizeBeforeUpgrade = dbSizeBytes(dbFile);

    // Everything below imports db.ts, which opens state.db and runs the upgrade ladder on the file above.
    const { initTls } = await import('./services/tls.js');
    const { db } = await import('./db/db.js');
    const { initStateEngine, exportSyncState, createPost } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const {
        getImageStore, postPhotoKey, sha256Hex, imagesDir, DiskImageStore, ImageStoreUnavailableError, resetImageStoreForTests,
    } = await import('./storage/image-store.js');
    const { evacuateImagesOnce, evacuationPassDidWork, pendingEvacuationCount, resetEvacuationSkipsForTests } = await import('./services/image-evacuation.js');
    const { getDiskHealth, getStorageCleanPreview, cleanStorageAndCompressLogs } = await import('./engine/storage-health.js');
    const { createPlainBackup } = await import('./services/sealed-backup.js');

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);
    const store = getImageStore();

    // The posts the fixture's photos belong to. `posts` is created by schema.sql, so it could not exist in
    // the legacy file above — and without these rows storage-health would rightly read every fixture photo
    // as orphaned media and prune it.
    const authorKey = crypto.randomBytes(32).toString('hex');
    const insertPost = db.prepare(`
        INSERT OR IGNORE INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, active, status)
        VALUES (?, 'offer', 'food', ?, 'from before the upgrade', 1, ?, '2026-01-01T00:00:00.000Z', 1, 'active')
    `);
    for (const p of fixture.photos) insertPost.run(p.postId, `Legacy ${p.postId}`, authorKey);

    // ── 1. the upgrade ladder ──────────────────────────────────────────────────────────────────
    const photoDdl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='post_photos'").get() as any)?.sql as string;
    assert(!/photo_data\s+TEXT\s+NOT\s+NULL/i.test(photoDdl), 'post_photos.photo_data is no longer NOT NULL after the upgrade');
    assert(/storage_key/.test(photoDdl) && /sha256/.test(photoDdl) && /\bbytes\b/.test(photoDdl) && /\bmime\b/.test(photoDdl),
        'post_photos gained storage_key, sha256, bytes and mime');
    const attachDdl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='message_attachments'").get() as any)?.sql as string;
    assert(!/\bdata\s+TEXT\s+NOT\s+NULL/i.test(attachDdl), 'message_attachments.data is no longer NOT NULL');
    assert(/storage_key/.test(attachDdl), 'message_attachments gained storage_key');
    assert(/nonce\s+TEXT\s+NOT\s+NULL/i.test(attachDdl), 'the nonce is still required — it never leaves the row');

    const survived = (db.prepare('SELECT COUNT(*) AS c FROM post_photos').get() as any).c as number;
    assert(survived === fixture.photos.length, `every photo row survived the rebuild (${survived}/${fixture.photos.length})`);
    const sampleAfterUpgrade = (db.prepare('SELECT photo_data FROM post_photos WHERE post_id = ?').get(fixture.photos[0].postId) as any).photo_data;
    assert(sampleAfterUpgrade === fixture.photos[0].value, 'a rebuilt row holds exactly the characters it held before');
    assert((db.prepare('SELECT COUNT(*) AS c FROM message_attachments').get() as any).c === FIXTURE_ATTACHMENTS,
        'every attachment row survived the rebuild');
    assert(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_post_photos_updated_at'").get(),
        'the updated_at index was rebuilt with the table');
    // DROP TABLE takes the table's triggers with it. schema.sql runs after the rebuild and puts this one
    // back; if it did not, `updated_at` would stop being maintained on every edit and the `?v=` in every
    // photo URL would freeze — a photo change nobody would ever see.
    assert(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='post_photos_touch_updated_at'").get(),
        'the touch-updated_at trigger came back after the rebuild');
    {
        // And it still works: an edit that does not name updated_at gets it stamped.
        const probe = fixture.photos[0];
        const was = (db.prepare('SELECT updated_at FROM post_photos WHERE post_id = ?').get(probe.postId) as any).updated_at;
        db.prepare("UPDATE post_photos SET mime = 'image/jpeg' WHERE post_id = ?").run(probe.postId);
        const now = (db.prepare('SELECT updated_at FROM post_photos WHERE post_id = ?').get(probe.postId) as any).updated_at;
        assert(now !== was, 'and it fires on an edit, exactly as it did before the rebuild');
        db.prepare('UPDATE post_photos SET updated_at = ?, mime = NULL WHERE post_id = ?').run(was, probe.postId);
    }

    // ── 2. a new photo goes straight to the store ──────────────────────────────────────────────
    const author = crypto.randomBytes(32).toString('hex');
    // An avatar, because the marketplace gate requires a profile photo before a member may post.
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, avatar_url) VALUES (?, 'Ayla', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`)
        .run(author, dataUrl(makePhoto('avatar')));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(author);
    const freshBytes = makePhoto('fresh');
    const freshValue = dataUrl(freshBytes);
    const fresh = createPost('offer', 'food', 'Sourdough', 'Baked this morning', 3, 'fixed', author, undefined, undefined, [freshValue], true);
    if (!fresh) throw new Error('setup: the post with a photo was not created');
    const freshRow = db.prepare('SELECT * FROM post_photos WHERE post_id = ? AND order_num = 0').get(fresh.id) as any;
    assert(freshRow.photo_data === null, 'a new photo is not written to the database at all');
    assert(typeof freshRow.storage_key === 'string' && freshRow.storage_key.startsWith(`posts/${fresh.id}/`),
        'the row points at an object in the post namespace');
    assert(freshRow.sha256 === sha256Hex(freshBytes), 'the row records the SHA-256 of the image bytes');
    assert(freshRow.bytes === freshBytes.length && freshRow.mime === 'image/jpeg', 'the row records the size and the mime');
    assert(store.get(freshRow.storage_key)!.equals(freshBytes), 'the store holds exactly those bytes');

    // ── 3. serving, before evacuation ──────────────────────────────────────────────────────────
    const legacyUrl = `${BASE}/api/marketplace/posts/${fixture.photos[0].postId}/photos/0`;
    const beforeRes = await fetch(legacyUrl);
    const beforeBytes = Buffer.from(await beforeRes.arrayBuffer());
    assert(beforeRes.status === 200, 'an inline photo still serves 200 before it is evacuated');
    assert(beforeBytes.equals(makePhoto('photo-0')), 'the bytes served are the photo');
    const beforeType = beforeRes.headers.get('content-type');
    const beforeCache = beforeRes.headers.get('cache-control');
    assert(beforeCache === 'public, max-age=31536000, immutable', 'the immutable cache header is what it always was');

    // ── 5a. the sync export, before evacuation ─────────────────────────────────────────────────
    const exportBefore = await exportSyncState('test-node');
    const photosBefore = JSON.stringify((exportBefore as any).photos);
    const watermarksBefore = JSON.stringify(
        db.prepare('SELECT post_id, order_num, updated_at FROM post_photos ORDER BY post_id, order_num').all());

    // ── 7a. the attachment, before evacuation ──────────────────────────────────────────────────
    const attachUrl = `${BASE}/api/messages/${fixture.attachments[0].id}/attachment`;
    const attachBefore = await (await fetch(attachUrl)).json() as any;
    assert(attachBefore.data === fixture.attachments[0].data, 'the ciphertext serves from the row before evacuation');

    // ── 4. the evacuation job ──────────────────────────────────────────────────────────────────
    const pendingAtStart = pendingEvacuationCount();
    assert(pendingAtStart.photos === fixture.photos.length, 'every inline photo is pending');
    assert(pendingAtStart.attachments === FIXTURE_ATTACHMENTS, 'every inline attachment is pending');

    // Resumable from the exact state a kill between "put" and "update the row" leaves: the object is
    // already in the store under its content-addressed key, and the row still holds the bytes.
    const interrupted = fixture.photos[1];
    const interruptedBytes = makePhoto('photo-1');
    const interruptedKey = postPhotoKey(interrupted.postId, 0, sha256Hex(interruptedBytes), 'image/jpeg');
    store.put(interruptedKey, interruptedBytes, { mime: 'image/jpeg' });
    assert((db.prepare('SELECT photo_data FROM post_photos WHERE post_id = ?').get(interrupted.postId) as any).photo_data === interrupted.value,
        'the interrupted row still holds its bytes — nothing has been lost');

    // The store stops answering mid-migration (an R2 outage, the S3 breaker open). That is not the rows' fault:
    // the pass must end with the store's error and give up on nothing, so that once the store is back the very
    // rows it reached are moved. Given up on, the job would find nothing left, call itself done, and vacuum.
    // Checked BEFORE the skip list is reset below, which would otherwise hide a row wrongly skipped here.
    {
        const pendingBeforeOutage = pendingEvacuationCount();
        const reached = (db.prepare(`
            SELECT post_id FROM post_photos
             WHERE storage_key IS NULL AND photo_data IS NOT NULL AND photo_data != ''
             ORDER BY post_id, order_num LIMIT 3
        `).all() as any[]).map((r) => r.post_id as string);
        const down = new Proxy(store, {
            get(target, prop) {
                if (prop === 'put') {
                    return () => { throw new ImageStoreUnavailableError('S3 PUT failed after 2 attempt(s): HTTP 503 SlowDown'); };
                }
                const v = Reflect.get(target, prop, target);
                return typeof v === 'function' ? v.bind(target) : v;
            },
        });
        resetImageStoreForTests(down);
        let outage: unknown = null;
        let duringOutage: ReturnType<typeof evacuateImagesOnce> | null = null;
        try { duringOutage = evacuateImagesOnce(3); } catch (e) { outage = e; }
        resetImageStoreForTests(store);
        assert(outage instanceof ImageStoreUnavailableError,
            `a pass the store does not answer ends with the store's error${duringOutage ? ` (it returned instead, skipping ${duringOutage.photosSkipped})` : ''}`);
        const pendingAfterOutage = pendingEvacuationCount();
        assert(pendingAfterOutage.photos === pendingBeforeOutage.photos && pendingAfterOutage.attachments === pendingBeforeOutage.attachments,
            'and moved nothing');
        const recovered = evacuateImagesOnce(3);
        const movedNow = reached.filter((id) =>
            (db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? AND order_num = 0').get(id) as any)?.storage_key);
        assert(recovered.photosMoved === 3 && recovered.photosSkipped === 0 && movedNow.length === reached.length,
            `once the store answers, the very rows the outage pass reached are moved — none was given up on (${movedNow.length}/${reached.length})`);
    }

    // One pass at a time, killing the job between passes. After every pass, every row must be either
    // wholly inline or wholly evacuated: there is no half state to be caught in.
    resetEvacuationSkipsForTests();
    let passes = 0;
    let halfRows = 0;
    while (passes < 100) {
        if (!evacuationPassDidWork(evacuateImagesOnce(3))) break;
        passes++;
        halfRows += (db.prepare(
            `SELECT COUNT(*) AS c FROM post_photos
              WHERE (photo_data IS NOT NULL AND photo_data != '' AND storage_key IS NOT NULL)
                 OR (photo_data IS NULL AND storage_key IS NULL)`
        ).get() as any).c as number;
        // Serving keeps working with the job half done — some rows inline, some evacuated.
        const mid = await fetch(legacyUrl);
        if (mid.status !== 200) { console.error('✗ serving broke mid-evacuation'); run++; }
    }
    assert(passes > 1, `the job ran in batches, not one pass (${passes} passes)`);
    assert(halfRows === 0, 'no row was ever half-evacuated, at any point between passes');

    const afterCounts = pendingEvacuationCount();
    assert(afterCounts.photos === 1, 'the one photo the store cannot reproduce exactly is left in the database');
    assert(afterCounts.attachments === 0, 'every attachment moved');
    const stillInline = db.prepare(`SELECT post_id FROM post_photos WHERE storage_key IS NULL`).all() as any[];
    assert(stillInline.length === 1 && stillInline[0].post_id === 'legacy-post-wrapped',
        'and it is the wrapped-base64 one, left alone rather than mangled');

    // Nulled only after a verified put: every evacuated row's recorded hash is the hash of the object.
    let hashMismatches = 0;
    for (const row of db.prepare('SELECT storage_key, sha256, bytes FROM post_photos WHERE storage_key IS NOT NULL').all() as any[]) {
        const obj = store.get(row.storage_key);
        if (!obj || sha256Hex(obj) !== row.sha256 || obj.length !== row.bytes) hashMismatches++;
    }
    assert(hashMismatches === 0, 'every evacuated row names an object whose bytes hash to the sha256 it recorded');
    assert(store.get(interruptedKey)!.equals(interruptedBytes), 'the interrupted row finished onto the same content-addressed key');

    // Idempotent: another pass moves nothing and changes nothing.
    const again = evacuateImagesOnce(50);
    assert(again.photosMoved === 0 && again.attachmentsMoved === 0, 'running the job again moves nothing');

    // ── 3b. serving, after evacuation ──────────────────────────────────────────────────────────
    const afterRes = await fetch(legacyUrl);
    const afterBytes = Buffer.from(await afterRes.arrayBuffer());
    assert(afterRes.status === 200, 'the same URL still serves 200 after evacuation');
    assert(afterBytes.equals(beforeBytes), 'the bytes served are BYTE-IDENTICAL after evacuation');
    assert(afterRes.headers.get('content-type') === beforeType, 'the content type is unchanged');
    assert(afterRes.headers.get('cache-control') === beforeCache, 'the cache headers are unchanged');
    const wrappedRes = await fetch(`${BASE}/api/marketplace/posts/legacy-post-wrapped/photos/0`);
    assert(wrappedRes.status === 200, 'the photo that stayed inline still serves');

    // ── 5b. the sync export, after evacuation ──────────────────────────────────────────────────
    const exportAfter = await exportSyncState('test-node');
    assert(JSON.stringify((exportAfter as any).photos) === photosBefore,
        'the sync payload photos are BYTE-IDENTICAL after evacuation — the federation wire did not change');
    // `updated_at` is the delta-sync watermark AND the ?v= clients cache by, and schema.sql's
    // post_photos_touch_updated_at bumps it on ANY update that does not set it. If the evacuation let that
    // happen, every replica would re-pull every photo and every phone would re-download every photo, for a
    // change nothing can see.
    assert(JSON.stringify(db.prepare('SELECT post_id, order_num, updated_at FROM post_photos ORDER BY post_id, order_num').all()) === watermarksBefore,
        'not one photo row had its updated_at watermark disturbed by the evacuation');

    // ── 5c. an object this node cannot read is OMITTED from the export, never exported empty ───
    // The case where the replica's copy is the only good one: this node's images directory has lost an
    // object. If the export shipped the row with an empty photo_data, the replica's INSERT OR REPLACE
    // would overwrite its intact photo with nothing — and the row's updated_at never changed, so no later
    // delta pull would ever put it back. Omitting the row is what lets the replica keep what it has.
    {
        const victim = fixture.photos[1];
        const victimRow = db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? AND order_num = ?')
            .get(victim.postId, victim.order) as any;
        assert(typeof victimRow.storage_key === 'string', 'setup: the photo under test was evacuated to the store');
        const victimBytes = store.get(victimRow.storage_key)!;

        // A replica that already holds the good copy, inline, exactly as a peer of any version would.
        const replicaFile = path.join(DATA_DIR, 'replica-export-test.db');
        fs.rmSync(replicaFile, { force: true });
        const replica = new Database(replicaFile);
        replica.exec(`CREATE TABLE post_photos (
            post_id TEXT NOT NULL, photo_data TEXT, order_num INTEGER NOT NULL,
            storage_key TEXT, sha256 TEXT, bytes INTEGER, mime TEXT,
            PRIMARY KEY (post_id, order_num))`);
        replica.prepare('INSERT INTO post_photos (post_id, photo_data, order_num) VALUES (?, ?, ?)')
            .run(victim.postId, victim.value, victim.order);

        store.delete(victimRow.storage_key);
        const exportDegraded = await exportSyncState('test-node');
        const degradedPhotos = (exportDegraded as any).photos as any[];
        assert(Array.isArray(degradedPhotos) && degradedPhotos.length > 0,
            'one unreadable object does not fail the export — the rest of the payload still ships');
        const victimInPayload = degradedPhotos.find(p => p.post_id === victim.postId && p.order_num === victim.order);
        assert(victimInPayload === undefined,
            'the row whose object has vanished is OMITTED from the payload, not exported with an empty photo_data');
        assert(!degradedPhotos.some(p => typeof p.photo_data !== 'string' || p.photo_data.length === 0),
            'and no row in the payload carries an empty photo_data');

        // What a peer does with the payload: upsert every row it was given. It was not given this one.
        const upsert = replica.prepare(
            `INSERT OR REPLACE INTO post_photos (post_id, photo_data, order_num) VALUES (?, ?, ?)`);
        for (const p of degradedPhotos) upsert.run(p.post_id, p.photo_data, p.order_num);
        const replicaRow = replica.prepare('SELECT photo_data FROM post_photos WHERE post_id = ? AND order_num = ?')
            .get(victim.postId, victim.order) as any;
        assert(replicaRow?.photo_data === victim.value,
            'so the replica still holds the photo, character for character — the export did not destroy the only good copy');
        replica.close();
        fs.rmSync(replicaFile, { force: true });

        // Put the object back: every section after this one expects a node whose store is whole.
        store.put(victimRow.storage_key, victimBytes, { mime: 'image/jpeg' });
        assert(store.get(victimRow.storage_key)!.equals(victimBytes), 'setup: the object was restored for the rest of the suite');
    }

    // ── 7b. the attachment, after evacuation ───────────────────────────────────────────────────
    const attachAfter = await (await fetch(attachUrl)).json() as any;
    assert(attachAfter.data === fixture.attachments[0].data, 'the ciphertext is unchanged, character for character');
    assert(attachAfter.nonce === fixture.attachments[0].nonce, 'the nonce is unchanged');
    assert(attachAfter.mime === attachBefore.mime, 'the mime is unchanged');
    assert((db.prepare('SELECT data FROM message_attachments WHERE message_id = ?').get(fixture.attachments[0].id) as any).data === null,
        'and the ciphertext is no longer in the database');

    // ── 6. the row decides, never the store ────────────────────────────────────────────────────
    const doomed = db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ?').get(fixture.photos[2].postId) as any;
    db.prepare('DELETE FROM post_photos WHERE post_id = ?').run(fixture.photos[2].postId);
    assert(store.get(doomed.storage_key) !== null, 'the file is still on disk (the post-commit delete has not run)');
    const goneRes = await fetch(`${BASE}/api/marketplace/posts/${fixture.photos[2].postId}/photos/0`);
    assert(goneRes.status === 404, 'a deleted photo 404s even though its file lingers — the route reads the row');
    // And the reverse: an object with no row is never reachable.
    const orphanKey = postPhotoKey('no-such-post', 0, sha256Hex(freshBytes), 'image/jpeg');
    store.put(orphanKey, freshBytes, { mime: 'image/jpeg' });
    assert((await fetch(`${BASE}/api/marketplace/posts/no-such-post/photos/0`)).status === 404,
        'an object with no row behind it is not served');

    // A post whose photos are replaced drops the old object once the edit has committed.
    const { updatePost } = await import('./state-engine.js');
    const replacementBytes = makePhoto('replacement');
    const oldKey = freshRow.storage_key as string;
    updatePost(fresh.id, author, { photos: [dataUrl(replacementBytes)] } as any);
    const replacedRow = db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? AND order_num = 0').get(fresh.id) as any;
    assert(replacedRow.storage_key !== oldKey, 'an edited photo takes a new content-addressed key');
    assert(store.get(oldKey) === null, 'and the object it replaced was deleted after the transaction committed');
    assert(store.get(replacedRow.storage_key)!.equals(replacementBytes), 'the new object holds the new bytes');

    // A photo whose object has vanished must not make the post uneditable — including the edit that gets
    // rid of it. Every row of the post is read to rebuild the "unchanged" URLs, so before this was caught
    // per row one lost object 500'd every photo edit and the member could not even remove the broken photo.
    {
        const brokenBytes = makePhoto('broken-object');
        const broken = createPost('offer', 'food', 'Jam', 'Last of the plums', 2, 'fixed', author, undefined, undefined,
            [dataUrl(brokenBytes), dataUrl(makePhoto('broken-second'))], true);
        if (!broken) throw new Error('setup: the two-photo post was not created');
        const brokenRow = db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? AND order_num = 0').get(broken.id) as any;
        const survivorRow = db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? AND order_num = 1').get(broken.id) as any;
        store.delete(brokenRow.storage_key);
        assert(store.get(brokenRow.storage_key) === null, 'setup: order 0 now points at an object that is not there');

        // The client keeps photo 1 by sending back the URL it was given, and replaces the broken photo 0.
        const keptUrl = `${BASE}/api/marketplace/posts/${broken.id}/photos/1`;
        const healBytes = makePhoto('heal');
        let editErr: unknown = null;
        try {
            updatePost(broken.id, author, { photos: [dataUrl(healBytes), keptUrl] } as any);
        } catch (e) { editErr = e; }
        assert(editErr === null, 'an edit that replaces the photo whose object is missing SUCCEEDS');
        const healedRow = db.prepare('SELECT storage_key, photo_data FROM post_photos WHERE post_id = ? AND order_num = 0').get(broken.id) as any;
        assert(healedRow && store.get(healedRow.storage_key)?.equals(healBytes) === true,
            'and order 0 now holds the replacement bytes');
        const keptRow = db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? AND order_num = 1').get(broken.id) as any;
        assert(store.get(keptRow.storage_key)?.equals(makePhoto('broken-second')) === true,
            'the untouched photo came back through its URL unchanged, not as a broken row');
        assert(keptRow.storage_key === survivorRow.storage_key,
            'and it re-stored under the same content-addressed key, so the edit cost nothing');
    }

    // The same post is still editable down to zero photos when the object is missing and NOT replaced.
    {
        const lonelyBytes = makePhoto('lonely');
        const lonely = createPost('offer', 'food', 'Bread', 'One loaf', 1, 'fixed', author, undefined, undefined,
            [dataUrl(lonelyBytes)], true);
        if (!lonely) throw new Error('setup: the one-photo post was not created');
        const lonelyRow = db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? AND order_num = 0').get(lonely.id) as any;
        store.delete(lonelyRow.storage_key);
        let dropErr: unknown = null;
        try { updatePost(lonely.id, author, { photos: [] } as any); } catch (e) { dropErr = e; }
        assert(dropErr === null, 'and an edit that simply DELETES the broken photo succeeds too');
        assert((db.prepare('SELECT COUNT(*) AS c FROM post_photos WHERE post_id = ?').get(lonely.id) as any).c === 0,
            'the post is left with no photos');
    }

    // ── 11. an import puts the bytes on disk BEFORE it opens the write transaction ──────────────
    // `store.put` is a mkdir, a temp write, an fsyncSync and a rename. Doing that per photo while the
    // import's write transaction is open would, on a force-resync or a first full snapshot, stall a
    // 1 vCPU node for one fsync per photo with nothing else able to run. The create and update paths
    // already put before their transaction (`storedPhotoColumns`); this is the same rule on the way in.
    {
        const { signSyncPayload, importRemoteState, setNodeRole } = await import('./state-engine.js');
        const { startP2P } = await import('./p2p.js');
        const { addConnector } = await import('./connector-manager.js');
        const p2pNode = await startP2P(4072, 4073);
        addConnector(`/ip4/127.0.0.1/tcp/4073/p2p/${p2pNode.peerId.toString()}`, 'mirror', 'imgstore-self-test-peer');

        // Watch every put the import makes and record whether a transaction was open at the time.
        const realPut = store.put.bind(store);
        const putsInsideTransaction: string[] = [];
        let putCount = 0;
        (store as any).put = (key: string, bytes: Buffer, meta: any) => {
            putCount++;
            if (db.inTransaction) putsInsideTransaction.push(key);
            return realPut(key, bytes, meta);
        };

        const incomingId = crypto.randomUUID();
        db.prepare(`INSERT OR IGNORE INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, active, status)
                    VALUES (?, 'offer', 'food', 'Imported', 'from a peer', 1, ?, '2026-01-01T00:00:00.000Z', 1, 'active')`)
            .run(incomingId, authorKey);
        const incomingBytes = [makePhoto('import-a'), makePhoto('import-b'), makePhoto('import-c')];
        const base = await exportSyncState('test-node');
        const { signature: _sig, publicKey: _pk, ...unsigned } = base as any;
        const payload = await signSyncPayload({
            ...unsigned,
            posts: [], members: [], photos: incomingBytes.map((b, i) => ({
                post_id: incomingId, order_num: i, photo_data: dataUrl(b),
            })),
        } as any);

        setNodeRole('backup');
        let importErr: unknown = null;
        try { await importRemoteState(payload as any); } catch (e) { importErr = e; }
        setNodeRole('primary');
        (store as any).put = realPut;
        try { await p2pNode.stop(); } catch { /* the suite is finishing anyway */ }

        assert(importErr === null, `an import carrying photos does not throw${importErr ? ': ' + String(importErr) : ''}`);
        assert(putCount >= incomingBytes.length, 'the import put every photo it was given through the store');
        assert(putsInsideTransaction.length === 0,
            `no photo is written to disk while the import transaction is open (${putsInsideTransaction.length} were)`);

        // And the rows still land exactly as before the puts were hoisted out.
        for (let i = 0; i < incomingBytes.length; i++) {
            const row = db.prepare('SELECT photo_data, storage_key, sha256, bytes, mime FROM post_photos WHERE post_id = ? AND order_num = ?')
                .get(incomingId, i) as any;
            assert(row?.photo_data === null && typeof row?.storage_key === 'string',
                `imported photo ${i} is in the store, not in the database`);
            assert(store.get(row.storage_key)?.equals(incomingBytes[i]) === true,
                `imported photo ${i} holds exactly the bytes the peer sent`);
            assert(row.sha256 === sha256Hex(incomingBytes[i]) && row.bytes === incomingBytes[i].length,
                `imported photo ${i} records its digest and size`);
        }
    }

    // ── 9. storage-health ──────────────────────────────────────────────────────────────────────
    const health = getDiskHealth();
    assert(health.breakdown.media.imageStoreCount > 0, 'the disk breakdown counts the image store');
    assert(health.breakdown.media.imageStoreBytes > 0, 'and its bytes');
    assert(health.breakdown.media.totalBytes >= health.breakdown.media.imageStoreBytes, 'media adds the store in');

    // An orphan younger than the grace period is left alone; the same object, aged, is swept.
    const preview = getStorageCleanPreview();
    assert(preview.orphanedImageObjects.count === 0, 'a freshly written orphan is inside the grace period and is not touched');
    const orphanPath = path.join(imagesDir(), orphanKey);
    const old = Date.now() - 3 * 60 * 60 * 1000;
    fs.utimesSync(orphanPath, old / 1000, old / 1000);
    const agedPreview = getStorageCleanPreview();
    assert(agedPreview.orphanedImageObjects.count >= 1, 'an aged object no row points at is reported as reclaimable');
    const cleaned = cleanStorageAndCompressLogs();
    assert(cleaned.removedImageObjectsCount >= 1, 'the clean removes it');
    assert(store.get(orphanKey) === null, 'and it is gone from the store');
    assert(store.get(replacedRow.storage_key) !== null, 'while an object a row still points at is untouched');

    // ── 8. backups ─────────────────────────────────────────────────────────────────────────────
    const backup = await createPlainBackup();
    const backupPath = path.join(DATA_DIR, 'test-backup.tar.gz');
    await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(backupPath);
        backup.body.pipe(out);
        out.on('finish', () => resolve());
        out.on('error', reject);
    });
    const { execFileSync } = await import('node:child_process');
    const listing = execFileSync('tar', ['-tzf', backupPath], { encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
    assert(listing.some(e => e === './state.db'), 'the backup carries state.db');
    const imageMembers = listing.filter(e => e.startsWith('./images/') && !e.endsWith('/'));
    assert(imageMembers.length > 0, `the backup carries images/ beside it (${imageMembers.length} object(s))`);

    const restoreDir = path.join(DATA_DIR, 'restore-check');
    fs.mkdirSync(restoreDir, { recursive: true });
    execFileSync('tar', ['-xzf', backupPath, '-C', restoreDir]);
    const restoredObject = path.join(restoreDir, 'images', replacedRow.storage_key);
    assert(fs.existsSync(restoredObject), 'an object from the store comes back out of the archive at its own key');
    assert(fs.readFileSync(restoredObject).equals(replacementBytes), 'and with exactly its bytes');

    // A backup taken BEFORE this change has no images/ member — and must still restore. The archive check
    // and the state.db copy are what a restore does; `restoreImages` is a no-op when there is nothing there.
    const oldStyle = path.join(DATA_DIR, 'old-style');
    fs.mkdirSync(oldStyle, { recursive: true });
    fs.copyFileSync(path.join(restoreDir, 'state.db'), path.join(oldStyle, 'state.db'));
    fs.writeFileSync(path.join(oldStyle, 'node_config.json'), '{}');
    const oldTar = path.join(DATA_DIR, 'old-style.tar.gz');
    execFileSync('tar', ['-czf', oldTar, '-C', oldStyle, '.']);
    const { checkBackupArchive } = await import('./services/sealed-backup.js');
    let preChangeOk = true;
    try { checkBackupArchive(oldTar, { requireStateDb: true }); } catch { preChangeOk = false; }
    assert(preChangeOk, 'a pre-change backup (state.db and node_config.json only) still passes the archive checks');
    const preChangeMembers = execFileSync('tar', ['-tzf', oldTar], { encoding: 'utf8' });
    assert(!preChangeMembers.includes('images/'), 'and it carries no images/ member, as it did not before this change');

    // ── 10. the size of it ─────────────────────────────────────────────────────────────────────
    // The same two-checkpoint dance reclaimSpaceOnce does, and for the same reason: in WAL mode the
    // VACUUM's rewrite lands in the WAL, so state.db does not shrink until it is folded back.
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const sizeAfter = dbSizeBytes(dbFile);
    const storeBytes = new DiskImageStore(imagesDir()).totalBytes();
    console.log(
        `\n   state.db: ${(sizeBeforeUpgrade / 1024 / 1024).toFixed(2)} MB before → ` +
        `${(sizeAfter / 1024 / 1024).toFixed(2)} MB after, with ${(storeBytes / 1024 / 1024).toFixed(2)} MB now in the image store.\n`
    );
    assert(sizeAfter < sizeBeforeUpgrade / 2, 'the database is less than half the size it was');

    // ── 12. a force-resync keeps the rows the primary could not send ───────────────────────────
    //
    // This is LAST because it empties the replicated tables, and nothing may run after it.
    //
    // "What the importer does not receive it keeps" is true of a delta or a full pull, and FALSE of a
    // force-resync: `pullOnce('resync')` calls `clearReplicatedTables()` — which lists `post_photos` — before
    // importing. So the one case the export's omission exists for (§5: the replica holds the only readable
    // copy) was the case a resync destroyed: the row went, its object became an orphan, and the daily sweep
    // reclaimed the bytes after the grace period. And a resync is the natural thing an operator does when a
    // replica "looks wrong".
    //
    // Here the LOCAL node plays both parts — it exports as the primary would, then clears as the replica
    // does — because `clearReplicatedTables` works on this process's one database handle.
    const { clearReplicatedTables } = await import('./state-engine.js');
    const { referencedStorageKeys } = await import('./storage/image-columns.js');

    const kept = db.prepare('SELECT post_id, order_num, storage_key FROM post_photos WHERE storage_key IS NOT NULL LIMIT 1')
        .get() as { post_id: string; order_num: number; storage_key: string } | undefined;
    assert(!!kept, 'setup: there is an evacuated photo row to lose');
    const keptRowKey = `${kept!.post_id}|${kept!.order_num}`;
    const keptBytes = store.get(kept!.storage_key)!;
    const rowsBefore = (db.prepare('SELECT COUNT(*) AS c FROM post_photos').get() as any).c as number;
    assert(rowsBefore > 1, `setup: and other photo rows a resync SHOULD clear (${rowsBefore} in all)`);

    // The primary cannot read that one object, so the export leaves the row out — and says which.
    store.delete(kept!.storage_key);
    const omitExport = await exportSyncState('test-node');
    assert(Array.isArray(omitExport.photosOmitted) && omitExport.photosOmitted.length === 1
        && omitExport.photosOmitted[0] === keptRowKey,
        `the payload NAMES the row it left out, additively (${JSON.stringify(omitExport.photosOmitted)})`);
    assert(!((omitExport as any).photos as any[]).some(ph => ph.post_id === kept!.post_id && ph.order_num === kept!.order_num),
        'and does not carry it, as §5 requires');

    // The replica's copy is the good one. It has the bytes; the primary does not.
    store.put(kept!.storage_key, keptBytes, { mime: 'image/jpeg' });

    clearReplicatedTables(omitExport.photosOmitted);
    const survivor = db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? AND order_num = ?')
        .get(kept!.post_id, kept!.order_num) as any;
    assert(survivor?.storage_key === kept!.storage_key,
        'a force-resync KEEPS the row the incoming payload could not carry — the only copy of it left');
    assert((db.prepare('SELECT COUNT(*) AS c FROM post_photos').get() as any).c === 1,
        'while every other photo row is cleared, as a resync must, so the import rebuilds them 1:1');
    assert((db.prepare('SELECT COUNT(*) AS c FROM members').get() as any).c === 0,
        'and the rest of the replicated tables are cleared exactly as before');
    assert(store.get(kept!.storage_key)?.equals(keptBytes) === true,
        'the object is still on disk, byte for byte');
    assert(referencedStorageKeys(db).includes(kept!.storage_key),
        'and still REFERENCED, so the daily orphan sweep leaves it alone rather than reclaiming it');

    // Nothing named: the wipe is total, exactly as it was. This is the behaviour a resync needs when the
    // primary CAN read everything, and the line above is the one exception to it.
    clearReplicatedTables();
    assert((db.prepare('SELECT COUNT(*) AS c FROM post_photos').get() as any).c === 0,
        'with nothing named, a resync clears post_photos outright — the exception is only for omitted rows');

    // ── 13. the keep list has no ceiling, and a failure aborts instead of committing half a clear ──
    //
    // §12 spares ONE row, which is the comfortable case. The case this argument exists for is not: a primary
    // whose images directory is lost or unmounted can read none of its evacuated photos, so it omits every
    // one of them — thousands of rows on a live node. Built as one `OR`-ed predicate per spared pair, that
    // statement is parsed left-deep and throws "Expression tree is too large (maximum depth 1000)" from about
    // 999 pairs on; the catch beside it logged and let the transaction COMMIT, so `post_photos` was not
    // cleared at all — every orphan row survived, not only the spared ones — and the log said "KEEPING 0 of
    // N". Self-contained: §12 left both tables empty, so this seeds its own rows.
    const BULK = 5000;
    const insertBulk = db.prepare(
        `INSERT OR REPLACE INTO post_photos (post_id, photo_data, order_num) VALUES (?, ?, ?)`);
    const bulkKeep: string[] = [];
    db.transaction(() => {
        for (let i = 0; i < BULK * 2; i++) {
            const postId = `bulk-post-${String(i).padStart(6, '0')}`;
            insertBulk.run(postId, dataUrl(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), 0);
            if (i % 2 === 0) bulkKeep.push(`${postId}|0`); // spare every other row, so position proves identity
        }
    })();
    assert((db.prepare('SELECT COUNT(*) AS c FROM post_photos').get() as any).c === BULK * 2,
        `setup: ${BULK * 2} photo rows, of which the payload names ${BULK} it could not carry`);

    // Throwing here is the FIXED behaviour for a statement that fails; on the unfixed tree it returns
    // quietly. Either way the assertions below are what report, rather than the run dying.
    try { clearReplicatedTables(bulkKeep); } catch (e: any) { console.error(`  (threw: ${e?.message})`); }
    const survivors = (db.prepare('SELECT post_id FROM post_photos').all() as { post_id: string }[])
        .map(r => Number(r.post_id.slice('bulk-post-'.length)));
    const unnamedSurvivor = survivors.find(n => !Number.isInteger(n) || n % 2 !== 0);
    assert(survivors.length === BULK,
        `a keep list of ${BULK} rows spares exactly that many — the spared-rows filter has no depth ceiling `
        + `(${survivors.length} survived)`);
    assert(unnamedSurvivor === undefined,
        'and the survivors are the NAMED rows, not merely the right number of them'
        + (unnamedSurvivor === undefined ? '' : ` (bulk-post-${String(unnamedSurvivor).padStart(6, '0')} survived)`));

    // A failure in that statement must abort the WHOLE resync. Committing past it is worse than failing:
    // the replica would be left with a table half-cleared of the very rows the payload cannot replace.
    // The trigger fires on the DELETE, so there have to be rows for it to delete: the 5,000 spared ones
    // above are all the table holds now, and a clear that matches nothing would never reach the trigger.
    const DOOMED = 10;
    for (let i = 0; i < DOOMED; i++) {
        insertBulk.run(`abort-extra-${i}`, dataUrl(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), 0);
    }
    db.prepare(`INSERT INTO members (public_key, callsign) VALUES ('abort-canary', 'AbortCanary')`).run();
    db.exec(`CREATE TRIGGER zz_block_photo_delete BEFORE DELETE ON post_photos
             BEGIN SELECT RAISE(ABORT, 'forced failure in the spared-rows clear'); END;`);
    let aborted = false;
    try { clearReplicatedTables(bulkKeep); } catch { aborted = true; }
    db.exec('DROP TRIGGER zz_block_photo_delete');
    assert(aborted, 'a failure clearing the spared rows THROWS, so the caller fails the resync');
    assert((db.prepare('SELECT COUNT(*) AS c FROM post_photos').get() as any).c === BULK + DOOMED,
        'and rolls back: post_photos is exactly as it was, neither cleared nor half-cleared');
    assert((db.prepare(`SELECT COUNT(*) AS c FROM members WHERE public_key = 'abort-canary'`).get() as any).c === 1,
        'along with the tables cleared before it — the whole resync aborted, not just this one table');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Image evacuation tests PASSED.\n');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
