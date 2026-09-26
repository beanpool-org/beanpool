/**
 * Test Suite: a snapshot is a point in time, and a backup carries the whole node or says what it lacks.
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
 *   5. A missing object makes the backup SHORT, never an error — through the service and through the route,
 *      which answers 200 and says how short in the headers. An UNREADABLE object (EACCES) still fails it:
 *      that is an archive of unknown contents, not a known shortfall.
 *   6. The removed opt-ins are inert: no query parameter can get a database-only or otherwise short-by-
 *      request archive out of this node any more.
 *   7. Pruning a snapshot, and deleting one, take its images with it.
 *   8. The storage-health orphan sweep never touches a snapshot's directory, and unlinking the live copy
 *      leaves the snapshot's bytes intact.
 *   9. A snapshot taken BEFORE this version — a separate database file nothing migrates, whose `post_photos`
 *      still has the pre-PR DDL and no `storage_key` column — still downloads, complete, as `0/0` images.
 *      Every photo in it is inline, so zero referenced objects is the truthful count.
 *  10. A short backup is labelled at every layer: short on the wire, short inside the archive
 *      (`missing-images.json`), and naming exactly the keys that are gone — while carrying every object the
 *      store DID hold.
 *  11. A restore never writes THROUGH a store object's inode: restoring an older `attachments/<id>.bin` over
 *      one a snapshot hard-links leaves the snapshot's bytes exactly as captured.
 *  12. The open door's record travels too: `open_joins` and the node key its hashes are made with
 *      (node_config `openJoinSalt`). Without both, a restored global node would let every sign-in account
 *      join a second time.
 *  13. So does the global node's moderation (G3): a post hidden by reports stays hidden
 *      (`posts.hidden_by_reports_at`), a moderator's takedown still counts (`posts.removed_by_moderator_at`),
 *      and a muted member stays muted (`members.moderation_muted_until`).
 *  14. And a person's coarse area (G4: `members.area_lat`, `area_lng`, `area_updated_at`), so a restored node still
 *      measures the People list from it.
 *  15. And the communities directory (G5): a member's place watch (`place_watches`, with when they last heard and its
 *      replication stamp), so a restored global node still tells them and keeps their quiet day, and `directory_cache`
 *      with each community's first sighting, so a restored node never tells a watcher twice about a community it had
 *      already seen.
 *  16. And the requests to join (G6): an open knock with what the applicant wrote, and a declined one with who declined
 *      it and when, so a restored community still has every request, and a decline still blocks for its 30 days.
 *  17. And the moderation notices kept for the web app (engine/kept-notices.ts): one unseen and one seen, so a restored
 *      node still shows a web member what they have not seen, and not what they have.
 *  18. And the keys a re-key replaced (`invalidated_keys`, engine/member-wizards.ts), with the key that replaced each, so a
 *      restored node still refuses a lost phone's key at every door.
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
/** Read a backup's body to the end: the stream owns its staging directory's cleanup. */
async function drain(body: NodeJS.ReadableStream): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        body.on('data', () => { /* to the bit bucket */ });
        body.on('end', () => resolve());
        body.on('error', reject);
    });
}
/** A photo of a realistic size, deterministic per seed, behind a real JPEG header. */
function makePhoto(seed: string): Buffer {
    const body = crypto.createHash('sha512').update(seed).digest();
    const filler = Buffer.alloc(24 * 1024);
    for (let i = 0; i < filler.length; i += body.length) body.copy(filler, i);
    for (let i = 0; i < filler.length; i++) filler[i] ^= (i * 31 + seed.charCodeAt(0)) & 0xff;
    // A scan with no 0xFF in it, so the metadata strip walks it to EOI and finds nothing to take off: stored exactly
    // as sent. The node refuses a JPEG it cannot walk (G9a-3), and SOI + APP0 + random bytes, which this built before, is one.
    for (let i = 0; i < filler.length; i++) if (filler[i] === 0xff) filler[i] = 0xfe;
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), filler, Buffer.from([0xff, 0xd9])]);
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
        createPlainBackup, createSealedBackup, openSealedFileTo, MISSING_MEMBER,
    } = await import('./services/sealed-backup.js');
    const { getImageStore, imagesDir, attachmentKey } = await import('./storage/image-store.js');
    const { writeMessageTombstone } = await import('./engine/message-tombstone.js');
    const { restoreImages } = await import('./routes/backup.js');
    const { cleanStorageAndCompressLogs, getStorageCleanPreview } = await import('./engine/storage-health.js');
    const { openJoinHash, OPEN_JOIN_KEY_ROW } = await import('./engine/open-join.js');

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

    // A member who came in through the open door, as engine/open-join.ts records one.
    const openJoiner = crypto.randomBytes(32).toString('hex');
    const openJoinHashAtT = openJoinHash('google', 'snapshot-completeness-sub');
    db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, ip_hash) VALUES (?, ?, ?, ?, ?)')
        .run(openJoiner, 'google', openJoinHashAtT, new Date().toISOString(), null);
    const openJoinKeyAtT = (db.prepare('SELECT value FROM node_config WHERE key = ?').get(OPEN_JOIN_KEY_ROW) as any)?.value as string;
    assert(!!openJoinKeyAtT, 'setup: an open join, and the node key its hash was made with');

    // The global node's moderation state (G3), as engine/auto-moderation.ts writes it. The mute is on a member of its
    // own, not the author: a muted author's post takes no edits (engine updatePost), and the author edits one at T+1.
    const hiddenAtT = new Date(Date.now() - 60_000).toISOString();
    const removedAtT = new Date(Date.now() - 120_000).toISOString();
    const mutedAtT = '9999-12-31T23:59:59.999Z';
    const mutedMember = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status) VALUES (?, 'Muted', ?, 'active')`).run(mutedMember, new Date().toISOString());
    db.prepare('UPDATE posts SET hidden_by_reports_at = ?, removed_by_moderator_at = ? WHERE id = ?').run(hiddenAtT, removedAtT, kept!.id);
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(mutedAtT, mutedMember);
    // A person's coarse area (G4), as engine/member-area.ts writes it: already rounded to 0.1°.
    const areaAtT = new Date(Date.now() - 180_000).toISOString();
    db.prepare('UPDATE members SET area_lat = ?, area_lng = ?, area_updated_at = ? WHERE public_key = ?').run(-28.6, 153.5, areaAtT, mutedMember);
    // The communities directory (G5), as engine/place-watches.ts and engine/directory-cache.ts write it.
    const watchAtT = new Date(Date.now() - 240_000).toISOString();
    const watchHeardAtT = new Date(Date.now() - 230_000).toISOString();
    db.prepare('INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at, last_notified_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('watch-at-t', mutedMember, -28.6, 153.6, 50, watchAtT, watchHeardAtT, watchHeardAtT);
    const seenAtT = new Date(Date.now() - 300_000).toISOString();
    db.prepare(`INSERT INTO directory_cache (community_key, listed, name, node_url, lat, lng, radius_km, member_count, first_seen_at, updated_at)
                VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`).run('peer-at-t', 'Snapshot Commons', 'https://snapshot.beanpool.org', -28.55, 153.5, 25, 40, seenAtT, seenAtT);
    // Requests to join (G6), as engine/knocks.ts writes them: one open, one declined by a member.
    const knockedAtT = new Date(Date.now() - 360_000).toISOString();
    const declinedAtT = new Date(Date.now() - 350_000).toISOString();
    const applicant = 'ef'.repeat(32);
    db.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, from_node, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run('knock-open-at-t', applicant, 'Newcomer', 'I grow tomatoes two streets away.', 'global.beanpool.org', knockedAtT, knockedAtT);
    db.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, status, created_at, decided_by, decided_at, updated_at) VALUES (?, ?, ?, ?, 'declined', ?, ?, ?, ?)`)
        .run('knock-declined-at-t', 'fe'.repeat(32), 'Stranger', 'Let me in.', knockedAtT, author, declinedAtT, declinedAtT);
    // Moderation notices kept for a member (engine/kept-notices.ts): one they have not seen, one they have.
    const toldAtT = new Date(Date.now() - 420_000).toISOString();
    const sawAtT = new Date(Date.now() - 410_000).toISOString();
    db.prepare(`INSERT INTO moderation_notices (id, recipient, title, body, data, created_at, seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run('notice-unseen-at-t', mutedMember, '🛡️ Posting paused', 'You can\'t post or send messages here until a moderator lifts this.', '{"kind":"moderation_muted"}', toldAtT, toldAtT);
    db.prepare(`INSERT INTO moderation_notices (id, recipient, title, body, data, created_at, seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('notice-seen-at-t', mutedMember, '🛡️ Your post was removed', 'Your post was removed by the community\'s moderators.', '{"kind":"post_removed"}', toldAtT, sawAtT, sawAtT);

    // A key a completed re-key replaced, and one whose re-key has only started, as engine/member-wizards.ts writes them.
    const replacedAtT = new Date(Date.now() - 480_000).toISOString();
    const replacedKey = 'ab'.repeat(32);
    const replacedBy = 'cd'.repeat(32);
    db.prepare(`INSERT INTO invalidated_keys (public_key, reason, invalidated_at, rekeyed_to) VALUES (?, 'rekeyed', ?, ?), (?, 'rekey_pending', ?, NULL)`)
        .run(replacedKey, replacedAtT, replacedBy, '12'.repeat(32), replacedAtT);

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
    {
        const archived = new Database(path.join(plainDir, 'state.db'), { readonly: true });
        try {
            const row = archived.prepare('SELECT join_hash FROM open_joins WHERE member_pubkey = ?').get(openJoiner) as any;
            const key = (archived.prepare('SELECT value FROM node_config WHERE key = ?').get(OPEN_JOIN_KEY_ROW) as any)?.value;
            assert(row?.join_hash === openJoinHashAtT, 'the archive carries open_joins, so a restored node still knows who joined');
            assert(key === openJoinKeyAtT, 'and the node key those hashes were made with, so the same account still matches');
            const moderated = archived.prepare('SELECT hidden_by_reports_at, removed_by_moderator_at FROM posts WHERE id = ?').get(kept!.id) as any;
            const muted = archived.prepare('SELECT moderation_muted_until FROM members WHERE public_key = ?').get(mutedMember) as any;
            assert(moderated?.hidden_by_reports_at === hiddenAtT && moderated?.removed_by_moderator_at === removedAtT,
                'the archive carries a post hidden by reports, and a moderator\'s takedown, so a restored node keeps both');
            assert(muted?.moderation_muted_until === mutedAtT, 'and a member\'s mute, so a restored node keeps them muted');
            const area = archived.prepare('SELECT area_lat, area_lng, area_updated_at FROM members WHERE public_key = ?').get(mutedMember) as any;
            assert(area?.area_lat === -28.6 && area?.area_lng === 153.5 && area?.area_updated_at === areaAtT,
                'and a person\'s coarse area, so a restored node still measures the People list from it');
            const watch = archived.prepare('SELECT pubkey, lat, lng, radius_km, created_at, last_notified_at, updated_at FROM place_watches WHERE id = ?').get('watch-at-t') as any;
            assert(watch?.pubkey === mutedMember && watch?.lat === -28.6 && watch?.lng === 153.6 && watch?.radius_km === 50 && watch?.created_at === watchAtT,
                'and a member\'s place watch, so a restored global node still tells them when a community starts near it');
            assert(watch?.last_notified_at === watchHeardAtT && watch?.updated_at === watchHeardAtT,
                'with when its member last heard (their quiet day) and its replication stamp');
            const seen = archived.prepare('SELECT listed, name, first_seen_at FROM directory_cache WHERE community_key = ?').get('peer-at-t') as any;
            assert(seen?.listed === 1 && seen?.name === 'Snapshot Commons' && seen?.first_seen_at === seenAtT,
                'and the directory cache with each community\'s first sighting, so a restored node never tells a watcher twice');
            const open = archived.prepare('SELECT pubkey, callsign, message, from_node, status, created_at FROM join_requests WHERE id = ?').get('knock-open-at-t') as any;
            assert(open?.pubkey === applicant && open?.message === 'I grow tomatoes two streets away.' && open?.status === 'pending' && open?.created_at === knockedAtT,
                'and an open request to join with what the applicant wrote, so a restored community can still answer it');
            const declined = archived.prepare('SELECT status, decided_by, decided_at, updated_at FROM join_requests WHERE id = ?').get('knock-declined-at-t') as any;
            assert(declined?.status === 'declined' && declined?.decided_by === author && declined?.decided_at === declinedAtT && declined?.updated_at === declinedAtT,
                'and a declined one with who declined it and when, so the decline still blocks for its 30 days');
            const unseen = archived.prepare('SELECT recipient, title, data, created_at, seen_at FROM moderation_notices WHERE id = ?').get('notice-unseen-at-t') as any;
            const seenNotice = archived.prepare('SELECT recipient, seen_at, updated_at FROM moderation_notices WHERE id = ?').get('notice-seen-at-t') as any;
            assert(unseen?.recipient === mutedMember && unseen?.title === '🛡️ Posting paused' && unseen?.data === '{"kind":"moderation_muted"}'
                && unseen?.created_at === toldAtT && unseen?.seen_at === null,
                'and a moderation notice kept for a member and not yet seen, so a restored node still shows it in the web app');
            assert(seenNotice?.recipient === mutedMember && seenNotice?.seen_at === sawAtT && seenNotice?.updated_at === sawAtT,
                'and one they have seen, with when, so a restored node never shows it again');
            const replacedRows = archived.prepare('SELECT public_key, reason, invalidated_at, rekeyed_to FROM invalidated_keys ORDER BY public_key').all() as any[];
            assert(replacedRows.length === 2 && replacedRows.some((r) => r.public_key === replacedKey && r.reason === 'rekeyed' && r.rekeyed_to === replacedBy && r.invalidated_at === replacedAtT)
                && replacedRows.some((r) => r.reason === 'rekey_pending' && r.rekeyed_to === null),
                'and the keys a re-key replaced, with the key that replaced each, so a restored node still refuses a lost phone\'s key');
        } finally {
            archived.close();
        }
    }

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

    // ── 5. A lost object makes the backup SHORT, and an unreadable one makes it FAIL ───────────
    //
    // This asserted the opposite until confirmation round 4: a single missing object refused the whole
    // backup, with `allowMissing=1` as the way past it. Nothing that ships could send that parameter —
    // neither the Backup tab nor the fleet manager nor any snapshot download — so one object lost for good
    // made the node un-backupable from every screen, permanently, with nothing the operator could click. The
    // refusal is gone. What it was protecting (a short file can never pass for a whole one) is what stayed,
    // and the I/O case below is the one that still fails, because that archive's contents are unknown.
    //
    // A live backup now: the live database references the replacement photo and the kept one.
    const liveKeys = [keptKey, keyOf(replaced!.id)];
    const hostage = path.join(imagesDir(), liveKeys[0]);
    const hostageBytes = fs.readFileSync(hostage);
    fs.unlinkSync(hostage);

    const shortPlain = await createPlainBackup();
    await drain(shortPlain.body);
    assert(shortPlain.images.missing.length === 1 && shortPlain.images.missing[0] === liveKeys[0],
        `a referenced object the store does not hold makes a readable backup SHORT, by exactly that key (${JSON.stringify(shortPlain.images.missing)})`);
    assert(shortPlain.images.staged === liveKeys.length - 1 && shortPlain.images.referenced === liveKeys.length,
        `with counts that cannot pass for whole (${shortPlain.images.staged}/${shortPlain.images.referenced})`);
    const shortSealed = await createSealedBackup();
    await drain(shortSealed.body);
    assert(shortSealed.images.missing.length === 1 && shortSealed.images.missing[0] === liveKeys[0],
        'and a locked one, the same way');

    const anyway = await fetch(`${BASE}/api/local/admin/backup`, {
        method: 'POST', headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' }, body: '{}',
    });
    const anywayBytes = Buffer.from(await anyway.arrayBuffer());
    assert(anyway.status === 200, `the route answers with the backup rather than an error (got ${anyway.status})`);
    assert(anyway.headers.get('x-backup-error') === null,
        'and sets no error header: a node short by one photo is a node with a backup, not a failure');
    assert(anywayBytes.length > 0, 'and there is a file on the wire');
    assert(anyway.headers.get('x-backup-contents') === 'database+images-partial',
        `with the shortfall on the wire (${anyway.headers.get('x-backup-contents')})`);
    assert(anyway.headers.get('x-backup-images') === `${liveKeys.length - 1}/${liveKeys.length}`,
        `as counts a UI can show (${anyway.headers.get('x-backup-images')})`);
    assert(anyway.headers.get('x-backup-missing-images') === '1',
        `and the number missing, so a fleet manager can say which node is short (${anyway.headers.get('x-backup-missing-images')})`);

    // 6. The removed opt-ins are inert: no parameter gets a short-by-request archive out of this node.
    const dbOnlyFile = path.join(work, 'database-only.tar.gz');
    const dbOnly = await download(
        `${BASE}/api/local/admin/snapshots/download?name=${encodeURIComponent(snap.name)}&databaseOnly=1&allowMissing=1`, dbOnlyFile);
    assert(dbOnly.status === 200, 'the parameters that used to shape a backup are simply ignored');
    assert(dbOnly.headers.get('x-backup-contents') === 'database+images',
        `and the snapshot still comes back whole, with its images (${dbOnly.headers.get('x-backup-contents')})`);
    assert(dbOnly.headers.get('x-backup-images') === `${atT.size}/${atT.size}`,
        `— there is no longer any way to ask a node for a database-only archive (${dbOnly.headers.get('x-backup-images')})`);

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
        // The one case that still fails. A missing object is a KNOWN shortfall the archive can state; a read
        // error on an object that IS there means nobody knows what the archive holds, and a file of unknown
        // contents must never be handed over as a backup.
        assert(!!threw, 'an unreadable object (EACCES) makes the backup throw instead of shipping without it');
        assert(!/missing-images|SHORT/i.test(String(threw?.message || '')),
            `and it surfaces as the I/O error it is, not as a known shortfall ("${String(threw?.message || '').slice(0, 90)}")`);
    }
    const whole = await createPlainBackup();
    await drain(whole.body);
    assert(whole.images.staged === whole.images.referenced && whole.images.referenced === liveKeys.length,
        'with the object back, a live backup is complete again');
    assert(whole.images.missing.length === 0, 'and carries no missing keys at all');

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
    assert((await getStorageCleanPreview()).orphanedImageObjects.count >= 1, 'the sweep sees the live copy as reclaimable');
    const swept = await cleanStorageAndCompressLogs();
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

    // ── 10. A labelled short backup, at every layer ───────────────────────────────────────────
    //
    // A labelled short backup beats no backup at all, and since round 4 it is what a node produces by
    // default: an object can be gone for good, and a refusal that never lifts means zero backups from
    // tonight until a human edits the referencing post — which for a member's DM attachment is nobody.
    // Everything below is what makes that safe: the file cannot pass for a whole one at any layer.
    const shortPhoto = makePhoto('the-object-that-is-really-gone');
    const shortPost = createPost('offer', 'food', 'A loaf whose photo the disk lost', 'gone', 1, 'fixed', author,
        undefined, undefined, [dataUrl(shortPhoto)]);
    const lostKey = keyOf(shortPost!.id);
    fs.unlinkSync(path.join(imagesDir(), lostKey));
    assert(store.get(lostKey) === null, 'setup: an object the live database references is gone from the store');
    const stillHeld = keyOf(legacyPost!.id);

    // The route the harvester and both UIs use. No parameter, no opt-in, no retry.
    const shortRes = await fetch(`${BASE}/api/local/admin/backup`, {
        method: 'POST', headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' }, body: '{}',
    });
    const shortBody = Buffer.from(await shortRes.arrayBuffer());
    assert(shortRes.status === 200, `a node with a lost object still produces a backup (got ${shortRes.status})`);
    assert(shortRes.headers.get('x-backup-contents') === 'database+images-partial',
        `and the answer says it is partial (got ${shortRes.headers.get('x-backup-contents')})`);
    const [staged, referenced] = (shortRes.headers.get('x-backup-images') || '0/0').split('/').map(Number);
    assert(referenced > staged && referenced - staged === 1,
        `with counts that do not match, so it cannot pass for whole (${staged}/${referenced})`);
    assert(shortRes.headers.get('x-backup-missing-images') === '1',
        `and the number that is missing (got ${shortRes.headers.get('x-backup-missing-images')})`);

    const shortFile = path.join(work, 'short-backup.bpsealed');
    fs.writeFileSync(shortFile, shortBody);
    const shortOpened = path.join(work, 'short-opened.tar.gz');
    await openSealedFileTo(shortFile, { type: 'code', code: recovery.code }, shortOpened);
    const shortDir = extract(shortOpened, path.join(work, 'short'));
    assert(fs.existsSync(path.join(shortDir, MISSING_MEMBER)),
        `the archive carries ${MISSING_MEMBER} — the label that outlives the HTTP response`);
    const manifest = JSON.parse(fs.readFileSync(path.join(shortDir, MISSING_MEMBER), 'utf8'));
    assert(Array.isArray(manifest.missing) && manifest.missing.length === 1 && manifest.missing[0] === lostKey,
        `naming exactly the key that is gone (${JSON.stringify(manifest.missing)})`);
    assert(manifest.referenced === referenced && manifest.staged === staged,
        'and the same counts the headers gave');
    assert(fs.existsSync(path.join(shortDir, 'state.db')), 'the database is in there in full');
    assert(fs.existsSync(path.join(shortDir, 'images', stillHeld)),
        'and so is every object the store DID hold — this is short by one photo, not by all of them');
    assert(!fs.existsSync(path.join(shortDir, 'images', lostKey)), 'only the lost one is absent');

    // A complete backup carries no manifest at all, so its presence is the label.
    fs.writeFileSync(path.join(imagesDir(), lostKey), shortPhoto);
    const wholeAgain = await createSealedBackup();
    await drain(wholeAgain.body);
    assert(wholeAgain.images.missing.length === 0 && wholeAgain.images.staged === wholeAgain.images.referenced,
        'with the object back, the very same call takes an ordinary complete backup and labels nothing');
    const wholeRes = await fetch(`${BASE}/api/local/admin/backup`, {
        method: 'POST', headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' }, body: '{}',
    });
    await wholeRes.arrayBuffer();
    assert(wholeRes.headers.get('x-backup-contents') === 'database+images'
        && wholeRes.headers.get('x-backup-missing-images') === null,
        `…and the route stops saying partial, so the label tracks the node rather than sticking (${wholeRes.headers.get('x-backup-contents')})`);

    // ── 11. A restore lays objects over the store; it never writes through one ────────────────
    //
    // Everything in this file rests on a store object being written temp-then-rename and afterwards only
    // unlinked, which is what makes a snapshot's hard link a point-in-time copy rather than a live view.
    // `copyFileSync` onto an existing object breaks that: it opens the inode and writes through it, so every
    // snapshot linked to the object is silently rewritten — during a restore, which is when the operator has
    // least to spare. `posts/…` keys are content-addressed so the bytes would match anyway; an attachment is
    // keyed by its message id alone and holds ciphertext, so the same key really is two different objects.
    const restoreMsgId = 'msg-restore-' + crypto.randomBytes(6).toString('hex');
    const restoreConvoId = 'convo-restore-' + crypto.randomBytes(6).toString('hex');
    const capturedCipher = makePhoto('the ciphertext this node holds today');
    const restoreKey = attachmentKey(restoreMsgId);
    store.put(restoreKey, capturedCipher, { mime: 'application/octet-stream' });
    db.prepare(`INSERT INTO conversations (id, type, created_by) VALUES (?, 'direct', ?)`).run(restoreConvoId, author);
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce) VALUES (?, ?, ?, ?, ?)`)
        .run(restoreMsgId, restoreConvoId, author, 'ignored', 'nonce-v1');
    db.prepare(`INSERT INTO message_attachments (message_id, data, nonce, mime, storage_key) VALUES (?, NULL, ?, ?, ?)`)
        .run(restoreMsgId, crypto.randomBytes(24).toString('base64'), 'image/jpeg', restoreKey);

    await nextSecond();
    const linked = createSnapshot();
    const linkedImages = snapshotImagesDir(path.join(SNAPSHOTS_DIR, linked.name));
    const snapshotCopy = path.join(linkedImages, restoreKey);
    const liveCopy = path.join(imagesDir(), restoreKey);
    assert(fs.existsSync(snapshotCopy) && fs.statSync(snapshotCopy).ino === fs.statSync(liveCopy).ino,
        'setup: the snapshot captured the attachment as a hard link — one inode, two names');

    // An older backup being restored onto this node: the same key, genuinely different ciphertext.
    const restoredCipher = makePhoto('the ciphertext inside the backup being restored');
    const restoreTmp = path.join(work, 'restore-extract');
    fs.rmSync(restoreTmp, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(path.join(restoreTmp, 'images', restoreKey)), { recursive: true });
    fs.writeFileSync(path.join(restoreTmp, 'images', restoreKey), restoredCipher);
    const restoredCount = restoreImages(restoreTmp, DATA_DIR).restored;

    assert(restoredCount === 1 && store.get(restoreKey)?.equals(restoredCipher) === true,
        'the restore put the backup\'s bytes in the live store, as it must');
    assert(fs.readFileSync(snapshotCopy).equals(capturedCipher),
        'and the snapshot still holds the bytes it captured, to the byte — the restore did NOT write through the shared inode');
    assert(fs.statSync(snapshotCopy).ino !== fs.statSync(liveCopy).ino,
        'because the restore renamed a NEW inode into place, leaving the snapshot\'s name on the old one');
    assert(!fs.readdirSync(path.dirname(liveCopy)).some((f) => f.includes('.tmp-')),
        'and left no half-written temp file behind');

    console.log(`\n${passed}/${run} passed\n`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
