/**
 * Test Suite: the disk image store and the round-trip rule that lets a row forget its bytes.
 *
 * Verifies:
 *   1. put / get / head / delete / list, and that a re-put of the same key is idempotent.
 *   2. A write is atomic: the object appears whole or not at all, and a temp file is never listed.
 *   3. Every shape of key that could escape the store root is refused — `..`, absolute, backslash,
 *      empty segment, NUL — and refused by `get`/`delete` too, not only by `put`.
 *   4. An object over the cap, and an empty one, are refused.
 *   5. `prepareStorablePhoto` accepts a canonical data URL and REFUSES one it cannot reproduce
 *      character for character (wrapped base64, a non-canonical body), which is what keeps a served
 *      photo and a sync payload byte-identical after evacuation.
 *   6. `photoDataOf` / `photoBytesOf` / `attachmentDataOf` read an evacuated row back as its original.
 *   7. A row pointing at a missing object throws rather than silently reading as "no photo".
 *   8. A key builder refuses an id it would have to change (never strips one into another's segment), and
 *      `deleteStoredObjects` keeps an object any row still names, in any case, or when it cannot tell.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-image-store.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
    DiskImageStore, ImageStoreError, MAX_OBJECT_BYTES,
    assertSafeKey, attachmentKey, extensionForMime, isKeySafeId, postPhotoKey, projectPhotoKey, sha256Hex,
} from './storage/image-store.js';
import {
    MissingObjectError, attachmentDataOf, encodeDataUrl, parseDataUrl, photoBytesOf, photoDataOf,
    prepareStorableCiphertext, prepareStorablePhoto, storeAttachmentColumns, storePhotoColumns,
    deleteStoredObjects, storageKeyStillReferenced,
} from './storage/image-columns.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}
function throws(fn: () => unknown, msg: string): void {
    let threw = false;
    try { fn(); } catch { threw = true; }
    assert(threw, msg);
}

/** A tiny but real JPEG, so nothing here depends on bytes that are not an image. */
const JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('not really the rest of a png, but the magic is what is checked'),
]);

function main(): void {
    console.log('\n=== Testing the disk image store ===\n');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-imgstore-'));
    const store = new DiskImageStore(path.join(root, 'images'));

    // ── 1. put / get / head / delete / list ────────────────────────────────────────────────────
    const key = postPhotoKey('post-abc', 0, sha256Hex(JPEG), 'image/jpeg');
    assert(key === `posts/post-abc/0-${sha256Hex(JPEG).slice(0, 8)}.jpg`, 'postPhotoKey is content-addressed inside its namespace');
    assert(attachmentKey('msg-1') === 'attachments/msg-1.bin', 'an attachment key is the message id, as .bin');
    assert(projectPhotoKey('proj-1', 2, sha256Hex(PNG), 'image/png').endsWith('.png'), 'a project photo key takes its extension from the mime');
    assert(extensionForMime('image/jpg') === 'jpg' && extensionForMime('application/octet-stream') === 'bin',
        'extensionForMime maps the raster types and falls back to .bin');

    // An id goes into its key as it is, or there is no key: stripped or cut, `post-abc!`, `post-abc ` and a 129th
    // character would each have been `post-abc`'s directory, and an edit of one deleted the other's photos.
    for (const [what, id] of [['a "!"', 'post-abc!'], ['a space', 'post-abc '], ['a slash', 'post-abc/'], ['a NUL', 'post-abc\0'],
        ['an accent', 'post-abcé'], ['a 129th character', 'p'.repeat(129)], ['a leading dot', '.post-abc'], ['nothing', '']] as const) {
        throws(() => postPhotoKey(id, 0, sha256Hex(JPEG), 'image/jpeg'), `postPhotoKey refuses an id with ${what} rather than stripping it`);
        assert(!isKeySafeId(id), `isKeySafeId says no to an id with ${what}`);
    }
    throws(() => attachmentKey('msg 1'), 'attachmentKey refuses a message id it would have to change');
    throws(() => projectPhotoKey('proj!', 0, sha256Hex(PNG), 'image/png'), 'and projectPhotoKey a project id');
    assert(postPhotoKey('p'.repeat(128), 0, sha256Hex(JPEG), 'image/jpeg').startsWith(`posts/${'p'.repeat(128)}/`),
        'a 128-character id is a key segment as it is');
    assert(postPhotoKey('Post_1.a', 0, sha256Hex(JPEG), 'image/jpeg').startsWith('posts/Post_1.a/'),
        'an id of a segment\'s characters is used unchanged, capitals included (a row from before keeps its key)');

    const put = store.put(key, JPEG, { mime: 'image/jpeg' });
    assert(put.bytes === JPEG.length, 'put reports the byte length');
    assert(put.sha256 === sha256Hex(JPEG), 'put reports the SHA-256 of the bytes');
    assert(store.get(key)!.equals(JPEG), 'get returns exactly the bytes that were put');
    assert(store.head(key)!.bytes === JPEG.length, 'head reports the size without reading the object');
    assert(typeof store.head(key)!.mtimeMs === 'number', 'head reports a last-modified time');
    assert(store.get('posts/post-abc/9-deadbeef.jpg') === null, 'get on a key that is not there is null, not a throw');
    assert(store.head('posts/post-abc/9-deadbeef.jpg') === null, 'head on a key that is not there is null');

    store.put(key, JPEG, { mime: 'image/jpeg' });
    assert(store.get(key)!.equals(JPEG), 'putting the same key and bytes again is idempotent');

    const key2 = postPhotoKey('post-abc', 1, sha256Hex(PNG), 'image/png');
    store.put(key2, PNG, { mime: 'image/png' });
    const listed = store.list('posts/post-abc').sort();
    assert(listed.length === 2 && listed[0] === key && listed[1] === key2, 'list returns every key under a prefix');
    assert(store.list('').length === 2, 'an empty prefix lists the whole store');
    assert(store.list('attachments').length === 0, 'listing a prefix with nothing under it is empty, not a throw');
    assert(store.totalBytes() === JPEG.length + PNG.length, 'totalBytes adds up every object');

    assert(store.delete(key2) === true, 'delete reports that it removed something');
    assert(store.delete(key2) === false, 'deleting the same key again reports that there was nothing to remove');
    assert(store.get(key2) === null, 'a deleted object is gone');

    // put rejects bytes that do not match a hash the caller supplied — the evacuation job relies on this.
    throws(() => store.put('posts/p/0-aaaaaaaa.jpg', JPEG, { mime: 'image/jpeg', sha256: sha256Hex(PNG) }),
        'put refuses bytes that do not match the hash the caller gave');

    // ── 2. atomicity ───────────────────────────────────────────────────────────────────────────
    // The object is written to a temp name and renamed, so nothing partial is ever readable under the
    // real key. A leftover temp file (a crash mid-write) must not be listed or served.
    const dir = path.join(store.root, 'posts', 'post-abc');
    fs.writeFileSync(path.join(dir, '0-deadbeef.jpg.tmp-abcdef012345'), Buffer.from('half a photo'));
    assert(store.list('').length === 1, 'a leftover temp file is not listed as an object');
    assert(store.totalBytes() === JPEG.length, 'a leftover temp file is not counted');

    // ── 3. path traversal ──────────────────────────────────────────────────────────────────────
    const escapes = [
        'posts/../../etc/passwd',
        '../outside.jpg',
        '/etc/passwd',
        'C:/windows/system32',
        'posts\\..\\outside.jpg',
        'posts//double.jpg',
        'posts/./here.jpg',
        '',
        'posts/a/b/c/d/e/f/g/h/i/too-deep.jpg',
    ];
    for (const bad of escapes) {
        throws(() => assertSafeKey(bad), `assertSafeKey refuses ${JSON.stringify(bad)}`);
        throws(() => store.put(bad, JPEG, { mime: 'image/jpeg' }), `put refuses ${JSON.stringify(bad)}`);
    }
    throws(() => assertSafeKey('posts/a\0b.jpg'), 'assertSafeKey refuses a NUL in a key');
    // A read path must refuse too, and without throwing at the caller: a storage_key comes out of a row,
    // and a row can come from a peer or a restored backup.
    assert(store.get('posts/../../etc/passwd') === null, 'get on an escaping key reads as nothing');
    assert(store.head('../outside.jpg') === null, 'head on an escaping key reads as nothing');
    assert(store.delete('../outside.jpg') === false, 'delete on an escaping key removes nothing');
    // And nothing was created outside the root while trying.
    assert(!fs.existsSync(path.join(root, 'outside.jpg')) && !fs.existsSync(path.join(root, 'etc')),
        'no traversal attempt wrote anything outside the store root');

    // ── 4. size limits ─────────────────────────────────────────────────────────────────────────
    throws(() => store.put('posts/p/0-aaaaaaaa.jpg', Buffer.alloc(0), { mime: 'image/jpeg' }),
        'put refuses an empty object');
    throws(() => store.put('posts/p/0-aaaaaaaa.jpg', Buffer.alloc(MAX_OBJECT_BYTES + 1), { mime: 'image/jpeg' }),
        'put refuses an object over the size cap');

    // ── 5. the round-trip rule ─────────────────────────────────────────────────────────────────
    const canonical = encodeDataUrl('image/jpeg', JPEG);
    const storable = prepareStorablePhoto(canonical);
    assert(!!storable && storable.bytes.equals(JPEG), 'a canonical data URL decodes to its bytes');
    assert(!!storable && storable.mime === 'image/jpeg', 'the mime comes off the data URL');
    assert(parseDataUrl(canonical)!.base64 === JPEG.toString('base64'), 'parseDataUrl splits the prefix from the body');

    // The cases that must be REFUSED rather than silently normalised. Each of these, stored and rebuilt,
    // would come back as different characters — a different sync payload for a peer, and for an
    // attachment a ciphertext that no longer decrypts.
    const wrapped = `data:image/jpeg;base64,${JPEG.toString('base64').replace(/(.{4})/, '$1\n')}`;
    assert(prepareStorablePhoto(wrapped) === null, 'base64 wrapped across lines is refused, not normalised');
    assert(prepareStorablePhoto(`data:image/jpeg;base64,${JPEG.toString('base64')}===`) === null,
        'a body with non-canonical padding is refused');
    assert(prepareStorablePhoto('not a data url at all') === null, 'a value that is not a data URL is refused');
    assert(prepareStorablePhoto('data:image/jpeg;base64,') === null, 'an empty body is refused');
    assert(prepareStorableCiphertext(JPEG.toString('base64'))!.bytes.equals(JPEG), 'bare canonical base64 is storable');
    assert(prepareStorableCiphertext(`${JPEG.toString('base64')}\n`) === null, 'ciphertext with a trailing newline is refused');

    // ── 6. reading an evacuated row back ───────────────────────────────────────────────────────
    const cols = storePhotoColumns(store, s => postPhotoKey('post-xyz', 0, s.sha256, s.mime), canonical);
    assert(cols.photo_data === null && !!cols.storage_key, 'a storable photo writes store columns and no inline copy');
    assert(cols.sha256 === sha256Hex(JPEG) && cols.bytes === JPEG.length && cols.mime === 'image/jpeg',
        'the row records the hash, the size and the mime');
    assert(photoDataOf(cols, store) === canonical, 'photoDataOf rebuilds the ORIGINAL data URL, character for character');
    const served = photoBytesOf(cols, store)!;
    assert(served.buffer.equals(JPEG) && served.contentType === 'image/jpeg', 'photoBytesOf serves the original bytes and type');

    // An inline row reads back as itself, including the legacy bare-base64 shape the route still handles.
    const inline = { photo_data: canonical, storage_key: null };
    assert(photoDataOf(inline, store) === canonical, 'an un-evacuated row reads as its inline value');
    assert(photoBytesOf(inline, store)!.buffer.equals(JPEG), 'an un-evacuated row serves its inline bytes');
    const bare = { photo_data: JPEG.toString('base64'), storage_key: null };
    assert(photoBytesOf(bare, store)!.contentType === 'image/jpeg', 'a legacy bare-base64 row still serves as image/jpeg');

    const wrappedCols = storePhotoColumns(store, s => postPhotoKey('post-wrapped', 0, s.sha256, s.mime), wrapped);
    assert(wrappedCols.photo_data === wrapped && wrappedCols.storage_key === null,
        'a photo the store cannot reproduce stays inline instead of being mangled');

    const attach = storeAttachmentColumns(store, attachmentKey('msg-42'), JPEG.toString('base64'));
    assert(attach.data === null && attach.storage_key === 'attachments/msg-42.bin', 'an attachment moves to the store');
    assert(attachmentDataOf({ ...attach, nonce: 'n' }, store) === JPEG.toString('base64'),
        'the ciphertext reads back as exactly the base64 that went in');
    assert(attachmentDataOf({ data: null, storage_key: null }, store) === null, 'a row with neither reads as nothing');

    // ── 7. a row pointing at nothing ───────────────────────────────────────────────────────────
    store.delete(cols.storage_key!);
    let missing: unknown = null;
    try { photoDataOf(cols, store); } catch (e) { missing = e; }
    assert(missing instanceof MissingObjectError, 'a row whose object has vanished throws MissingObjectError, not "no photo"');
    throws(() => photoBytesOf(cols, store), 'the serving read throws for a vanished object too');

    // deleteStoredObjects never throws, whatever it is handed.
    const handle = new Database(':memory:');
    handle.exec(`CREATE TABLE post_photos (post_id TEXT, order_num INTEGER, storage_key TEXT);
                 CREATE TABLE message_attachments (message_id TEXT, storage_key TEXT);`);
    const before = store.list('').length;
    const removed = deleteStoredObjects(handle, ['posts/../../etc/passwd', 'attachments/msg-42.bin', ''], store);
    assert(removed === 1, 'deleteStoredObjects removes what it can and ignores what it cannot');
    assert(store.list('').length === before - 1, 'only the real object went');

    // ── 8. an object a row still names is not this delete's ────────────────────────────────────
    const shared = store.put(postPhotoKey('post-vera', 0, sha256Hex(JPEG), 'image/jpeg'), JPEG, { mime: 'image/jpeg' }).key;
    const sharedAtt = store.put(attachmentKey('msg-vera'), PNG, { mime: 'application/octet-stream' }).key;
    handle.prepare('INSERT INTO post_photos (post_id, order_num, storage_key) VALUES (?, 0, ?)').run('post-vera', shared);
    handle.prepare('INSERT INTO message_attachments (message_id, storage_key) VALUES (?, ?)').run('msg-vera', sharedAtt);
    assert(deleteStoredObjects(handle, [shared, sharedAtt], store) === 0 && !!store.get(shared) && !!store.get(sharedAtt),
        'an object a post_photos or message_attachments row still names is kept');
    assert(storageKeyStillReferenced(handle, shared.toUpperCase()) && storageKeyStillReferenced(handle, shared.replace('post-vera', 'POST-Vera')),
        'a key that differs only in case counts as named: on a disk that folds case it is the same file');
    assert(!storageKeyStillReferenced(handle, 'posts/post-nobody/0-00000000.jpg'), 'a key no row names is not');
    const unanswerable = new Database(':memory:');
    assert(deleteStoredObjects(unanswerable, [shared], store) === 0 && !!store.get(shared),
        'a database that cannot say whether a row names it (no such table) keeps the object');
    handle.prepare('DELETE FROM post_photos WHERE post_id = ?').run('post-vera');
    assert(deleteStoredObjects(handle, [shared], store) === 1 && store.get(shared) === null,
        'once no row names it, it is deleted');
    handle.close();
    unanswerable.close();

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Image store tests PASSED.\n');
}

try { main(); } catch (e) { console.error('❌ Test failed:', e); process.exit(1); }
