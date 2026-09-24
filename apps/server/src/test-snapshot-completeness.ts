/**
 * Test Suite: a snapshot is a point in time, and a backup is the whole node or an error.
 *
 * Once the image evacuation has run, a row holds a `storage_key` and no bytes. So neither a `VACUUM INTO`
 * snapshot nor a tar of state.db describes a node any more, and both had a way of looking like they did:
 *
 *   1. A snapshot taken at T was downloaded by staging the LIVE image store, at download time. A photo
 *      replaced at T+1 unlinks the object the snapshot's rows name, so the recovery point restored to a row
 *      pointing at nothing — 503 forever, on the one copy that was meant to be the way back. The unlocked
 *      download was the bare `.db`, with no images at all.
 *   2. The image staging swallowed every error and returned counts both callers discarded, so ENOSPC or
 *      EACCES partway through produced an archive indistinguishable from a complete one. The operator found
 *      out at restore, which is exactly when there is no other copy.
 *
 * Verifies:
 *   1. Creating a snapshot captures every object its OWN database references, beside it, as hard links.
 *   2. After a photo is replaced and an attachment deleted, the live store no longer holds what the snapshot
 *      needs — and the snapshot's download still resolves every row to the bytes that were there at T.
 *   3. The unlocked download is a complete archive (database AND images), not a bare `.db`.
 *   4. The locked download of the same snapshot carries the same images, opened with the recovery code.
 *   5. A missing object, and an unreadable one (EACCES), make a backup FAIL rather than come up short —
 *      through the service and through the route, which answers 500 and says so in the headers.
 *   6. `databaseOnly` is the one way to get a short backup, and it is labelled everywhere it appears.
 *   7. Pruning a snapshot, and deleting one, take its images with it.
 *   8. The storage-health orphan sweep never touches a snapshot's directory, and unlinking the live copy
 *      leaves the snapshot's bytes intact.
 *   9. A snapshot taken BEFORE this version — a separate database file nothing migrates, whose `post_photos`
 *      still has the pre-PR DDL and no `storage_key` column — still downloads, complete, as `0/0` images.
 *      Every photo in it is inline, so zero referenced objects is the truthful count.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-snapshot-completeness.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const PORT = 8583;
const BASE = `https://localhost:${PORT}`;
const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const ADMIN_PW = 'Snapshot-Completeness-Pw-41!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}
async function rejects(fn: () => Promise<unknown>, name: string, msg: string): Promise<void> {
    let caught: any = null;
    try { await fn(); } catch (e) { caught = e; }
    assert(!!caught && (caught.name === name || caught.constructor?.name === name),
        `${msg}${caught ? '' : ' (it did not throw at all)'}${caught && caught.name !== name ? ` (threw ${caught.name})` : ''}`);
}

/** A photo of a realistic size, deterministic per seed, behind a real JPEG header. */
function makePhoto(seed: string): Buffer {
    const body = crypto.createHash('sha512').update(seed).digest();
    const filler = Buffer.alloc(24 * 1024);
    for (let i = 0; i < filler.length; i += body.length) body.copy(filler, i);
    for (let i = 0; i < filler.length; i++) filler[i] ^= (i * 31 + seed.charCodeAt(0)) & 0xff;
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), filler, Buffer.from([0xff, 0xd9])]);
}
const dataUrl = (buf: Buffer, mime = 'image/jpeg') => `data:${mime};base64,${buf.toString('base64')}`;

/**
 * Wait for the wall clock to cross a second.
 *
 * A snapshot is named for the timestamp to the second, so two taken inside the same second are one file
 * under one name — and this suite needs two distinct snapshots to watch one of them be pruned.
 */
async function nextSecond(): Promise<void> {
    const now = () => new Date().toISOString().slice(0, 19);
    const started = now();
    while (now() === started) await new Promise((r) => setTimeout(r, 60));
}

/** Extract a downloaded archive and hand back the directory it landed in. */
function extract(tarPath: string, into: string): string {
    fs.rmSync(into, { recursive: true, force: true });
    fs.mkdirSync(into, { recursive: true });
    execFileSync('tar', ['-xzf', tarPath, '-C', into]);
    return into;
}

/** Download a route to a file, with the headers it answered. */
async function download(url: string, to: string): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const res = await fetch(url, { method: 'GET', headers: { 'X-Admin-Password': ADMIN_PW } });
    const body = Buffer.from(await res.arrayBuffer());
    if (res.ok) fs.writeFileSync(to, body);
    return { status: res.status, headers: res.headers, body };
}

/**
 * Every `storage_key` in a database file, mapped to the bytes the archive beside it carries for that key.
 * This is the restore, in substance: a row resolves, or the photo is gone.
 */
function resolveAll(dbFile: string, imagesRoot: string): Map<string, Buffer | null> {
    const handle = new Database(dbFile, { readonly: true });
    const out = new Map<string, Buffer | null>();
    try {
        for (const table of ['post_photos', 'message_attachments']) {
            for (const row of handle.prepare(`SELECT storage_key FROM ${table} WHERE storage_key IS NOT NULL`).all() as { storage_key: string }[]) {
                const file = path.join(imagesRoot, row.storage_key);
                out.set(row.storage_key, fs.existsSync(file) ? fs.readFileSync(file) : null);
            }
        }
    } finally {
        handle.close();
    }
    return out;
}

/**
 * Rewrite a snapshot's database into the shape a node running origin/main wrote: the pre-PR DDL for both
 * storage-key tables — `photo_data TEXT NOT NULL`, `data TEXT NOT NULL`, and no `storage_key`, `sha256`,
 * `bytes` or `mime` column at all — with every photo back inline where such a node kept it.
 *
 * This is the file every node already has in `data/snapshots/` the moment it boots this version, and nothing
 * migrates it: `initSchema` runs on `state.db` alone. `inline` supplies the bytes for rows that had been
 * evacuated by the time the snapshot was taken.
 */
function makeSnapshotPreUpgrade(snapshotDbFile: string, inline: Map<string, string>): void {
    const handle = new Database(snapshotDbFile);
    try {
        const photos = handle.prepare('SELECT post_id, order_num, photo_data, storage_key, updated_at FROM post_photos').all() as any[];
        const attachments = handle.prepare('SELECT message_id, data, nonce, mime, storage_key, created_at FROM message_attachments').all() as any[];
        handle.exec(`
            DROP TABLE post_photos;
            CREATE TABLE post_photos (
                post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                photo_data TEXT NOT NULL,
                order_num INTEGER NOT NULL,
                updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                PRIMARY KEY (post_id, order_num)
            );
            CREATE INDEX IF NOT EXISTS idx_post_photos_updated_at ON post_photos(updated_at);
            DROP TABLE message_attachments;
            CREATE TABLE message_attachments (
                message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
                data TEXT NOT NULL,
                nonce TEXT NOT NULL,
                mime TEXT,
                created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
        `);
        const insPhoto = handle.prepare('INSERT INTO post_photos (post_id, photo_data, order_num, updated_at) VALUES (?, ?, ?, ?)');
        for (const r of photos) {
            const value = r.photo_data || inline.get(r.storage_key) || '';
            if (value) insPhoto.run(r.post_id, value, r.order_num, r.updated_at);
        }
        const insAttachment = handle.prepare('INSERT INTO message_attachments (message_id, data, nonce, mime, created_at) VALUES (?, ?, ?, ?, ?)');
        for (const r of attachments) {
            const value = r.data || inline.get(r.storage_key) || '';
            if (value) insAttachment.run(r.message_id, value, r.nonce, r.mime, r.created_at);
        }
    } finally {
        handle.close();
    }
}

async function main(): Promise<void> {
    console.log('\n=== Testing snapshot and backup completeness ===\n');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const work = path.join(DATA_DIR, 'work');
    fs.mkdirSync(work, { recursive: true });

    const { initTls } = await import('./services/tls.js');
    const { db } = await import('./db/db.js');
    const { initStateEngine, seedGenesisMember, createPost, updatePost } = await import('./state-engine.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
    const {
        createSnapshot, listSnapshots, snapshotImagesDir, updateAutoSnapshotConfig, SNAPSHOTS_DIR,
    } = await import('./services/snapshot-scheduler.js');
    const {
        createPlainBackup, createSealedBackup, openSealedFileTo, IncompleteBackupError,
    } = await import('./services/sealed-backup.js');
    const { getImageStore, imagesDir, attachmentKey } = await import('./storage/image-store.js');
    const { writeMessageTombstone } = await import('./engine/message-tombstone.js');
    const { cleanStorageAndCompressLogs, getStorageCleanPreview } = await import('./engine/storage-health.js');

    await initTls();
    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(DATA_DIR, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    await startHttpsServer(PORT);
    const store = getImageStore();

    // ── The node at T ──────────────────────────────────────────────────────────────────────────
    const author = crypto.randomBytes(32).toString('hex');
    seedGenesisMember(author, 'Snapper');
    // The marketplace refuses a post from a member with no profile photo, so give them one.
    db.prepare('UPDATE members SET avatar_url = ? WHERE public_key = ?')
        .run(dataUrl(makePhoto('the-author-avatar')), author);

    const keptPhoto = makePhoto('kept');
    const doomedPhoto = makePhoto('doomed-by-a-replacement');
    const kept = createPost('offer', 'food', 'A loaf that stays', 'unchanged', 1, 'fixed', author,
        undefined, undefined, [dataUrl(keptPhoto)]);
    const replaced = createPost('offer', 'food', 'A loaf whose photo changes', 'about to be edited', 1, 'fixed', author,
        undefined, undefined, [dataUrl(doomedPhoto)]);
    assert(!!kept && !!replaced, 'setup: two posts, each with a photo');

    // An attachment, with a conversation and a message under it so the tombstone path is the real one.
    const convoId = 'convo-' + crypto.randomBytes(6).toString('hex');
    const msgId = 'msg-' + crypto.randomBytes(6).toString('hex');
    const cipher = makePhoto('attachment-ciphertext');
    db.prepare(`INSERT INTO conversations (id, type, created_by) VALUES (?, 'direct', ?)`).run(convoId, author);
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce) VALUES (?, ?, ?, ?, ?)`)
        .run(msgId, convoId, author, 'ignored', 'nonce-v1');
    const attachmentStored = store.put(attachmentKey(msgId), cipher, { mime: 'application/octet-stream' });
    db.prepare(`INSERT INTO message_attachments (message_id, data, nonce, mime, storage_key) VALUES (?, NULL, ?, ?, ?)`)
        .run(msgId, crypto.randomBytes(24).toString('base64'), 'image/jpeg', attachmentStored.key);

    const keyOf = (postId: string) => (db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? AND order_num = 0')
        .get(postId) as any)?.storage_key as string;
    const keptKey = keyOf(kept!.id);
    const doomedKey = keyOf(replaced!.id);
    assert(!!keptKey && !!doomedKey, 'setup: both photos went straight to the store');

    /** What every referenced object held at T. The whole suite is about reproducing this map. */
    const atT = new Map<string, Buffer>([
        [keptKey, keptPhoto],
        [doomedKey, doomedPhoto],
        [attachmentStored.key, cipher],
    ]);

    // ── 1. The snapshot captures its own images ────────────────────────────────────────────────
    const snap = createSnapshot();
    const snapPath = path.join(SNAPSHOTS_DIR, snap.name);
    const snapImages = snapshotImagesDir(snapPath);
    assert(fs.existsSync(snapImages) && fs.statSync(snapImages).isDirectory(),
        'a snapshot writes an images directory beside its .db');
    assert(snap.hasImages, 'and says so in the snapshot it reports');
    assert(listSnapshots().find(s => s.name === snap.name)?.hasImages === true, 'as does the list the Backup tab reads');
    for (const [key] of atT) {
        assert(fs.existsSync(path.join(snapImages, key)), `the snapshot captured ${key.split('/')[0]}/…`);
    }
    assert(fs.statSync(path.join(snapImages, keptKey)).nlink >= 2,
        'captured as a hard link, so it costs no disk until the live copy goes');
    assert(fs.statSync(path.join(snapImages, keptKey)).ino === fs.statSync(path.join(imagesDir(), keptKey)).ino,
        'and it is the same inode the live store holds');
    assert(!listSnapshots().some(s => s.name.endsWith('.images')),
        'the images directory is never mistaken for a snapshot of its own');

    // ── 2. T+1: the live store loses what the snapshot needs ───────────────────────────────────
    const replacementPhoto = makePhoto('the-replacement');
    const edited = updatePost(replaced!.id, author, { photos: [dataUrl(replacementPhoto)] });
    assert(!!edited, 'T+1: the member replaces that post\'s photo');
    const tombstoneRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    writeMessageTombstone(msgId, tombstoneRow, author, 'Photo removed');
    // The unlink happens after the transaction commits, on the next tick.
    await new Promise((r) => setTimeout(r, 50));

    assert(store.get(doomedKey) === null, 'T+1: the replaced photo\'s object is gone from the LIVE store');
    assert(store.get(attachmentStored.key) === null, 'T+1: so is the deleted attachment\'s');
    assert(fs.existsSync(path.join(snapImages, doomedKey)) && fs.existsSync(path.join(snapImages, attachmentStored.key)),
        'but the snapshot still holds both: unlinking the live name left the snapshot\'s bytes alone');

    // ── 3. The unlocked download is the whole node, and it is still T ──────────────────────────
    const plainFile = path.join(work, 'snapshot-download.bin');
    const plain = await download(`${BASE}/api/local/admin/snapshots/download?name=${encodeURIComponent(snap.name)}`, plainFile);
    assert(plain.status === 200, 'the snapshot downloads');
    assert(plain.headers.get('x-backup-locked') === 'no', 'unlocked, because this node has no recovery code yet');
    assert(plain.body[0] === 0x1f && plain.body[1] === 0x8b,
        'and it arrives as an archive, NOT the bare .db it used to send');
    assert(plain.headers.get('content-type') === 'application/gzip', 'declared as one');
    assert((plain.headers.get('content-disposition') || '').includes('.tar.gz'),
        'and named as one, so the operator does not save a tar under a .db name');
    assert(plain.headers.get('x-backup-contents') === 'database+images', 'the response says what it carries');
    assert(plain.headers.get('x-backup-images') === `${atT.size}/${atT.size}`,
        `and counts the objects (${atT.size} referenced, all staged)`);

    const plainDir = extract(plainFile, path.join(work, 'plain'));
    assert(fs.existsSync(path.join(plainDir, 'state.db')), 'the archive carries state.db');
    const resolved = resolveAll(path.join(plainDir, 'state.db'), path.join(plainDir, 'images'));
    assert(resolved.size === atT.size, `every row with a storage_key is accounted for (${resolved.size})`);
    let identical = 0;
    for (const [key, bytes] of resolved) {
        const expected = atT.get(key);
        if (expected && bytes && bytes.equals(expected)) identical++;
    }
    assert(identical === atT.size,
        `every row in the snapshot resolves to the bytes it held at T (${identical}/${atT.size})`);
    assert(resolved.get(doomedKey)?.equals(doomedPhoto) === true,
        'including the photo that was replaced AFTER the snapshot — the case the old code lost');
    assert(resolved.get(attachmentStored.key)?.equals(cipher) === true,
        'and the attachment that was deleted after it');
    assert(!resolveAll(path.join(plainDir, 'state.db'), path.join(plainDir, 'images')).has(keyOf(replaced!.id)),
        'while the replacement photo, which did not exist at T, is not in the snapshot');

    // ── 4. Locked: the same snapshot, sealed, carries the same images ──────────────────────────
    const recovery = await makeRecoveryCode();
    const sealedFile = path.join(work, 'snapshot-download.bpsealed');
    const sealed = await download(`${BASE}/api/local/admin/snapshots/download?name=${encodeURIComponent(snap.name)}`, sealedFile);
    assert(sealed.status === 200 && sealed.headers.get('x-backup-locked') === 'yes', 'with a recovery code the snapshot is locked on the way out');
    assert(sealed.headers.get('x-backup-contents') === 'database+images'
        && sealed.headers.get('x-backup-images') === `${atT.size}/${atT.size}`, 'and says it carries the same images');
    const openedTar = path.join(work, 'opened.tar.gz');
    await openSealedFileTo(sealedFile, { type: 'code', code: recovery.code }, openedTar);
    const sealedDir = extract(openedTar, path.join(work, 'sealed'));
    const sealedResolved = resolveAll(path.join(sealedDir, 'state.db'), path.join(sealedDir, 'images'));
    let sealedIdentical = 0;
    for (const [key, bytes] of sealedResolved) {
        const expected = atT.get(key);
        if (expected && bytes && bytes.equals(expected)) sealedIdentical++;
    }
    assert(sealedIdentical === atT.size, `the locked file resolves every row to its T bytes too (${sealedIdentical}/${atT.size})`);

    // ── 5. A short backup is an error, not a file ──────────────────────────────────────────────
    // A live backup now: the live database references the replacement photo and the kept one.
    const liveKeys = [keptKey, keyOf(replaced!.id)];
    const hostage = path.join(imagesDir(), liveKeys[0]);
    const hostageBytes = fs.readFileSync(hostage);
    fs.unlinkSync(hostage);
    await rejects(() => createPlainBackup(), 'IncompleteBackupError',
        'a referenced object the store does not hold makes a readable backup throw');
    await rejects(() => createSealedBackup(), 'IncompleteBackupError',
        'and a locked one');
    const refused = await fetch(`${BASE}/api/local/admin/backup`, {
        method: 'POST', headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' }, body: '{}',
    });
    const refusedBody: any = await refused.json().catch(() => ({}));
    assert(refused.status === 500, 'the route answers with an error rather than a two-thirds backup');
    assert(refused.headers.get('x-backup-error') === 'incomplete-images', 'and names the reason in a header');
    assert(refusedBody?.images?.missing === 1 && refusedBody?.images?.referenced === liveKeys.length,
        'with the counts, so a fleet manager can show which node is short');

    // 6. databaseOnly is the one way past it, and it is labelled.
    const dbOnlyFile = path.join(work, 'database-only.tar.gz');
    const dbOnly = await download(`${BASE}/api/local/admin/snapshots/download?name=${encodeURIComponent(snap.name)}&databaseOnly=1`, dbOnlyFile);
    assert(dbOnly.status === 200, 'a caller may ask for the database alone');
    assert(dbOnly.headers.get('x-backup-contents') === 'database-only', 'and the answer says so');
    assert(dbOnly.headers.get('x-backup-images') === null, 'with no image count to mistake for a complete one');

    // An unreadable object is a caught error, not a quiet shortfall. (Skipped as root, which chmod cannot stop.)
    fs.writeFileSync(hostage, hostageBytes);
    const hostageDir = path.dirname(hostage);
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
        console.log('… running as root: skipping the EACCES case, which no file mode can express here');
    } else {
        const mode = fs.statSync(hostageDir).mode;
        fs.chmodSync(hostageDir, 0o000);
        let threw: any = null;
        try { await createPlainBackup(); } catch (e) { threw = e; }
        fs.chmodSync(hostageDir, mode);
        assert(!!threw, 'an unreadable object (EACCES) makes the backup throw instead of shipping without it');
        assert(!(threw instanceof IncompleteBackupError),
            'and it surfaces as the I/O error it is, not as a silently missing object');
    }
    const whole = await createPlainBackup();
    // Read it to the end rather than abandoning it: the stream owns the staging directory's cleanup.
    await new Promise<void>((resolve, reject) => {
        whole.body.on('data', () => { /* to the bit bucket */ });
        whole.body.on('end', () => resolve());
        whole.body.on('error', reject);
    });
    assert(whole.images?.staged === whole.images?.referenced && (whole.images?.referenced ?? 0) === liveKeys.length,
        'with the object back, a live backup is complete again');

    // ── 7. Pruning and deleting take the images with the snapshot ──────────────────────────────
    updateAutoSnapshotConfig({ keep: 1 });
    await nextSecond();
    const survivor = createSnapshot(); // prunes `snap`
    assert(!fs.existsSync(snapPath), 'pruning removes the old snapshot');
    assert(!fs.existsSync(snapImages), 'and its captured images go with it');
    const survivorImages = snapshotImagesDir(path.join(SNAPSHOTS_DIR, survivor.name));
    assert(fs.existsSync(survivorImages), 'the surviving snapshot keeps its own');

    const deleted = await fetch(`${BASE}/api/local/admin/snapshots/delete`, {
        method: 'POST', headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ADMIN_PW, name: survivor.name }),
    });
    assert(deleted.status === 200, 'the delete route deletes a snapshot');
    assert(!fs.existsSync(survivorImages), 'and takes its images too, rather than orphaning a directory');

    // ── 8. The orphan sweep cannot reach a snapshot ────────────────────────────────────────────
    updateAutoSnapshotConfig({ keep: 7 });
    await nextSecond();
    const guarded = createSnapshot();
    const guardedImages = snapshotImagesDir(path.join(SNAPSHOTS_DIR, guarded.name));
    const guardedKey = keptKey;
    const guardedFile = path.join(guardedImages, guardedKey);
    assert(fs.existsSync(guardedFile), 'setup: the new snapshot captured the kept post\'s photo');

    // Delete the post, so its object is an orphan in the LIVE store — and age it past the grace period.
    // Hard links share an inode, so this ages the snapshot's name for the object as well: the sweep is
    // being given every chance to reach it.
    db.prepare('DELETE FROM post_photos WHERE post_id = ?').run(kept!.id);
    db.prepare('DELETE FROM posts WHERE id = ?').run(kept!.id);
    const aged = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(imagesDir(), guardedKey), aged, aged);
    assert(getStorageCleanPreview().orphanedImageObjects.count >= 1, 'the sweep sees the live copy as reclaimable');
    const swept = cleanStorageAndCompressLogs();
    assert(swept.removedImageObjectsCount >= 1, 'and reclaims it');
    assert(store.get(guardedKey) === null, 'the live object is gone');
    assert(fs.existsSync(guardedImages), 'the snapshot\'s directory is untouched');
    assert(fs.existsSync(guardedFile) && fs.readFileSync(guardedFile).equals(keptPhoto),
        'and the snapshot still holds the bytes, to the byte: the sweep unlinked a name, not an inode');
    const survivingSnapshotObjects = fs.readdirSync(path.join(guardedImages, 'posts'), { recursive: true } as any) as string[];
    assert(survivingSnapshotObjects.length > 0, 'the sweep never walked into data/snapshots at all');

    // ── 9. A snapshot from BEFORE this version still downloads, and downloads complete ────────
    //
    // The file every node already has in data/snapshots/ when it boots this version. Nothing migrates it —
    // initSchema runs on state.db alone — so its post_photos still declares the pre-PR DDL with no
    // storage_key column. Reading the column out of it threw `no such column: storage_key`, and the download
    // route turned that into a 500: on the morning after an upgrade, every recovery point an operator might
    // reach for was unreachable, which is exactly when an upgrade is the thing that might have gone wrong.
    const legacyPhoto = makePhoto('a-node-that-never-upgraded');
    const legacyPost = createPost('offer', 'food', 'A loaf from before the upgrade', 'inline bytes', 1, 'fixed', author,
        undefined, undefined, [dataUrl(legacyPhoto)]);
    assert(!!legacyPost, 'setup: a post whose photo the live node put in the store');
    await nextSecond();
    const legacy = createSnapshot();
    const legacyPath = path.join(SNAPSHOTS_DIR, legacy.name);
    makeSnapshotPreUpgrade(legacyPath, new Map([[keyOf(legacyPost!.id), dataUrl(legacyPhoto)]]));
    // A pre-upgrade node never wrote a captured-images directory either.
    fs.rmSync(snapshotImagesDir(legacyPath), { recursive: true, force: true });
    {
        const handle = new Database(legacyPath, { readonly: true });
        const ddl = (handle.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='post_photos'").get() as any)?.sql as string;
        handle.close();
        assert(!/storage_key/.test(ddl), 'setup: the snapshot\'s post_photos really has no storage_key column');
    }

    const legacyFile = path.join(work, 'legacy-snapshot.bpsealed');
    const legacyGot = await download(`${BASE}/api/local/admin/snapshots/download?name=${encodeURIComponent(legacy.name)}`, legacyFile);
    assert(legacyGot.status === 200,
        `a pre-upgrade snapshot downloads instead of answering 500 (got ${legacyGot.status})`);
    assert(legacyGot.headers.get('x-backup-error') !== 'incomplete-images'
        && !/no such column/.test(JSON.stringify(legacyGot.body.subarray(0, 400).toString('utf8'))),
        'and not with "no such column: storage_key"');
    assert(legacyGot.headers.get('x-backup-contents') === 'database+images',
        'it is a whole backup, not a labelled-short one');
    assert(legacyGot.headers.get('x-backup-images') === '0/0',
        `a database with no storage_key column references no objects (got ${legacyGot.headers.get('x-backup-images')})`);

    const legacyOpened = path.join(work, 'legacy-opened.tar.gz');
    await openSealedFileTo(legacyFile, { type: 'code', code: recovery.code }, legacyOpened);
    const legacyDir = extract(legacyOpened, path.join(work, 'legacy'));
    const legacyHandle = new Database(path.join(legacyDir, 'state.db'), { readonly: true });
    const legacyRow = legacyHandle.prepare('SELECT photo_data FROM post_photos WHERE post_id = ? AND order_num = 0')
        .get(legacyPost!.id) as any;
    legacyHandle.close();
    assert(legacyRow?.photo_data === dataUrl(legacyPhoto),
        'and the archive is COMPLETE: the photo is inline in the row, exactly as that node held it');

    console.log(`\n${passed}/${run} passed\n`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
