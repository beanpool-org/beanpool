/**
 * Test Suite: the S3/R2 image store, and the contract it shares with the disk store.
 *
 * No network: every S3 request goes to an in-process stand-in (fake-s3-test-harness.ts) on loopback, which
 * re-derives and checks the SigV4 signature of each request with its own implementation.
 *
 * Verifies:
 *   1. The signer reproduces the four worked examples in the S3 SigV4 documentation, signature for signature.
 *   2. `IMAGE_STORE=s3` is a backend the factory builds (on origin/main it throws), and the settings are
 *      checked: each missing one is named, a malformed one is refused, and no value is ever printed.
 *   3. THE SAME CONTRACT over DiskImageStore and S3ImageStore — put/get/head/delete/list/scan/totalBytes, the
 *      unsafe-key and size refusals, the async readers, and the image-columns round trip — so the two cannot
 *      drift apart.
 *   4. S3 specifics: every request signed; a bad signature is a 403 and a failed put keeps the photo in its
 *      row; retries on 5xx and on no answer, never on a 4xx; a timeout is bounded; the circuit breaker stops
 *      the blocking path from waiting on a bucket that just failed, then closes; listing paginates; keys that
 *      are not ours are never listed; a GET streams; a missing bucket is an error, not a missing photo.
 *   5. The boot check refuses with each missing setting, a bucket these credentials cannot reach, a missing
 *      bucket, an unreachable endpoint, a standby role, and photos still on the node's disk — and passes a
 *      good configuration.
 *   6. The secret access key appears in no log line, no error message, and no serialisation of the store.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-image-store-s3.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
    DiskImageStore, MAX_OBJECT_BYTES, STORE_NAMESPACES,
    checkImageStoreAtBoot, configuredImageStoreKind, getImageStore, headObject, openObject, postPhotoKey,
    attachmentKey, readObject, resetImageStoreForTests, scanObjects, scanObjectsAsync, scanOurObjects,
    scanOurObjectsAsync, sha256Hex, type ImageStore, type ObjectInfo,
} from './storage/image-store.js';
import { S3ImageStore, s3ConfigFromEnv, S3_ENV } from './storage/s3-image-store.js';
import { EMPTY_PAYLOAD_SHA256, signRequest } from './storage/s3-sigv4.js';
import {
    MissingObjectError, attachmentDataOf, attachmentDataOfAsync, deleteStoredObjects, encodeDataUrl, openPhotoOf,
    photoDataOf, photoDataOfAsync, storeAttachmentColumns, storePhotoColumns, storePhotoColumnsAsync,
} from './storage/image-columns.js';
import { startFakeS3 } from './fake-s3-test-harness.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}
function throws(fn: () => unknown, re: RegExp | null, msg: string): string {
    try { fn(); } catch (e: any) {
        const text = String(e?.message || e);
        assert(re ? re.test(text) : true, `${msg}${re && !re.test(text) ? ` (threw: ${text})` : ''}`);
        return text;
    }
    assert(false, `${msg} (did not throw)`);
    return '';
}
async function rejects(fn: () => Promise<unknown>, re: RegExp | null, msg: string): Promise<string> {
    try { await fn(); } catch (e: any) {
        const text = String(e?.message || e);
        assert(re ? re.test(text) : true, `${msg}${re && !re.test(text) ? ` (threw: ${text})` : ''}`);
        return text;
    }
    assert(false, `${msg} (did not throw)`);
    return '';
}

// Every console line this process writes, so section 6 can prove the secret is never in one.
const captured: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    (console as any)[level] = (...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 6 }))).join(' '));
        original(...args);
    };
}
// And every error message the suite saw, for the same check.
const errorTexts: string[] = [];

const JPEG = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
    crypto.createHash('sha512').update('a photo').digest(),
    Buffer.from([0xff, 0xd9]),
]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')]);

async function streamBytes(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
}

// ── 3. The contract ────────────────────────────────────────────────────────────────────────────

async function contract(name: string, store: ImageStore): Promise<void> {
    console.log(`\n--- 3. The contract: ${name} ---`);
    const key = postPhotoKey('post-abc', 0, sha256Hex(JPEG), 'image/jpeg');
    const put = store.put(key, JPEG, { mime: 'image/jpeg' });
    assert(put.key === key && put.bytes === JPEG.length && put.sha256 === sha256Hex(JPEG) && put.mime === 'image/jpeg',
        `${name}: put reports the key, size, SHA-256 and mime`);
    assert(store.get(key)!.equals(JPEG), `${name}: get returns exactly the bytes that were put`);
    const h = store.head(key)!;
    assert(h.key === key && h.bytes === JPEG.length && h.mtimeMs > Date.now() - 60_000,
        `${name}: head reports the size and a recent last-modified time`);
    assert(store.get('posts/post-abc/9-deadbeef.jpg') === null, `${name}: get of a key that is not there is null`);
    assert(store.head('posts/post-abc/9-deadbeef.jpg') === null, `${name}: head of a key that is not there is null`);
    store.put(key, JPEG, { mime: 'image/jpeg' });
    assert(store.get(key)!.equals(JPEG), `${name}: putting the same key and bytes again is idempotent`);

    const key2 = postPhotoKey('post-abc', 1, sha256Hex(PNG), 'image/png');
    store.put(key2, PNG, { mime: 'image/png' });
    // A sibling whose id STARTS with the first one's: a directory listing must not include it.
    const sibling = postPhotoKey('post-abcdef', 0, sha256Hex(PNG), 'image/png');
    store.put(sibling, PNG, { mime: 'image/png' });
    const att = attachmentKey('msg-1');
    store.put(att, JPEG, { mime: 'application/octet-stream' });
    // A key outside this node's namespaces: legal as a key, never "ours" to sweep.
    store.put('elsewhere/readme.bin', PNG, { mime: 'application/octet-stream' });

    assert(JSON.stringify(store.list('posts/post-abc').sort()) === JSON.stringify([key, key2].sort()),
        `${name}: list(prefix) is a directory — posts/post-abc does not list posts/post-abcdef`);
    assert(JSON.stringify(store.list('posts/post-abc/').sort()) === JSON.stringify([key, key2].sort()),
        `${name}: a trailing slash on the prefix means the same`);
    assert(store.list('posts/nothing-here').length === 0, `${name}: list of an empty prefix is empty, not a throw`);
    const all = store.list('').sort();
    assert(JSON.stringify(all) === JSON.stringify([att, 'elsewhere/readme.bin', key, key2, sibling].sort()),
        `${name}: list('') returns every object`);
    const scanned = scanObjects(store, 'posts');
    assert(scanned.length === 3 && scanned.every((o) => o.bytes === (o.key === key ? JPEG.length : PNG.length)),
        `${name}: scanObjects reports each object's size`);
    const ours = scanOurObjects(store).map((o) => o.key).sort();
    assert(!ours.includes('elsewhere/readme.bin') && ours.length === 4,
        `${name}: scanOurObjects covers ${STORE_NAMESPACES.join('/')} and never a key outside them`);
    assert(store.totalBytes() === JPEG.length * 2 + PNG.length * 3, `${name}: totalBytes sums every object`);

    // The async readers every already-async caller uses.
    assert((await readObject(store, key))!.equals(JPEG), `${name}: readObject returns the bytes`);
    assert((await readObject(store, 'posts/none/0-00000000.jpg')) === null, `${name}: readObject of a missing key is null`);
    assert((await headObject(store, key2))?.bytes === PNG.length, `${name}: headObject reports the size`);
    const opened = await openObject(store, key);
    assert(!!opened && (await streamBytes(opened.stream)).equals(JPEG) && (opened.bytes === null || opened.bytes === JPEG.length),
        `${name}: openObject streams exactly the bytes`);
    assert((await openObject(store, 'posts/none/0-00000000.jpg')) === null, `${name}: openObject of a missing key is null`);
    const scannedAsync = (await scanObjectsAsync(store, 'posts')).map((o) => `${o.key}:${o.bytes}`).sort();
    assert(JSON.stringify(scannedAsync) === JSON.stringify(scanned.map((o) => `${o.key}:${o.bytes}`).sort()),
        `${name}: scanObjectsAsync agrees with scanObjects`);

    // Unsafe keys: refused by put, and simply "not there" to every reader — never a path or a URL built from one.
    for (const bad of ['../etc/passwd', 'posts/../../x.jpg', '/abs.jpg', 'posts//x.jpg', 'posts/x\\y.jpg', 'posts/sp ace.jpg', '']) {
        throws(() => store.put(bad, JPEG, { mime: 'image/jpeg' }), /Unsafe|non-empty/, `${name}: put refuses the key ${JSON.stringify(bad)}`);
        assert(store.get(bad) === null && store.head(bad) === null && store.delete(bad) === false,
            `${name}: get/head/delete treat ${JSON.stringify(bad)} as absent`);
    }
    throws(() => store.put('posts/p/0-empty.jpg', Buffer.alloc(0), { mime: 'image/jpeg' }), /empty/, `${name}: an empty object is refused`);
    throws(() => store.put('posts/p/0-huge.jpg', Buffer.alloc(MAX_OBJECT_BYTES + 1), { mime: 'image/jpeg' }), /over the/,
        `${name}: an object over the cap is refused`);
    throws(() => store.put('posts/p/0-bad.jpg', JPEG, { mime: 'image/jpeg', sha256: '0'.repeat(64) }), /do not match/,
        `${name}: bytes that do not match the caller's hash are refused`);
    assert(store.get('posts/p/0-bad.jpg') === null, `${name}: and nothing was written for the refused put`);

    // The image-columns round trip — the rule that a row's bytes come back character for character.
    const dataUrl = encodeDataUrl('image/jpeg', JPEG);
    const cols = storePhotoColumns(store, (s) => postPhotoKey('post-cols', 0, s.sha256, s.mime), dataUrl);
    assert(cols.photo_data === null && !!cols.storage_key && cols.sha256 === sha256Hex(JPEG) && cols.bytes === JPEG.length,
        `${name}: storePhotoColumns moves the photo out of the row`);
    assert(photoDataOf(cols, store) === dataUrl, `${name}: photoDataOf rebuilds the exact data URL`);
    assert((await photoDataOfAsync(cols, store)) === dataUrl, `${name}: photoDataOfAsync rebuilds the exact data URL`);
    const colsAsync = await storePhotoColumnsAsync(store, (s) => postPhotoKey('post-cols-async', 0, s.sha256, s.mime), dataUrl);
    assert(colsAsync.photo_data === null && colsAsync.storage_key === postPhotoKey('post-cols-async', 0, sha256Hex(JPEG), 'image/jpeg')
        && store.get(colsAsync.storage_key!)!.equals(JPEG),
        `${name}: storePhotoColumnsAsync (the federation importer's write) gives the same columns and the same object`);
    const served = await openPhotoOf(cols, store);
    const servedBytes = served!.body instanceof Readable ? await streamBytes(served!.body) : served!.body as Buffer;
    assert(servedBytes.equals(JPEG) && served!.contentType === 'image/jpeg', `${name}: openPhotoOf serves the bytes and the type`);
    const cipher = crypto.randomBytes(300).toString('base64');
    const acols = storeAttachmentColumns(store, attachmentKey('msg-cols'), cipher);
    assert(acols.data === null && acols.storage_key === 'attachments/msg-cols.bin', `${name}: an attachment's ciphertext leaves the row`);
    assert(attachmentDataOf(acols, store) === cipher && (await attachmentDataOfAsync(acols, store)) === cipher,
        `${name}: the ciphertext comes back exactly, sync and async`);
    const ghost = { photo_data: null, storage_key: 'posts/ghost/0-00000000.jpg', mime: 'image/jpeg' };
    throws(() => photoDataOf(ghost, store), /missing/, `${name}: a row naming a missing object throws MissingObjectError`);
    let asyncMissing = false;
    try { await photoDataOfAsync(ghost, store); } catch (e) { asyncMissing = e instanceof MissingObjectError; }
    assert(asyncMissing, `${name}: and so does the async reader`);

    // Deletes.
    assert(store.delete(key2) === true && store.get(key2) === null, `${name}: delete of a present key is true, and it is gone`);
    assert(store.delete(key2) === false, `${name}: delete of an absent key is false`);
    const removed = deleteStoredObjects([key, 'posts/none/0-00000000.jpg', att], store);
    assert(removed === 2 && store.get(key) === null && store.get(att) === null,
        `${name}: deleteStoredObjects counts what it actually removed`);
}

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'imgstore-s3-'));
    process.env.BEANPOOL_DATA_DIR = dataDir;
    const fake = await startFakeS3();
    const stores: S3ImageStore[] = [];
    const track = (s: S3ImageStore) => { stores.push(s); return s; };

    // ── 1. SigV4 against the documentation ─────────────────────────────────────────────────────
    console.log('\n--- 1. SigV4 against the S3 documentation\'s worked examples ---');
    {
        const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
        const now = new Date('2013-05-24T00:00:00Z');
        const sig = (method: string, url: string, headers: Record<string, string>, payload = EMPTY_PAYLOAD_SHA256) =>
            signRequest({ method, url: new URL(url), headers, payloadSha256: payload, region: 'us-east-1', now }, creds).signature;
        assert(sig('GET', 'https://examplebucket.s3.amazonaws.com/test.txt', { Range: 'bytes=0-9' })
            === 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41', 'GET Object example');
        assert(sig('PUT', 'https://examplebucket.s3.amazonaws.com/test$file.text',
            { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
            '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072')
            === '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd', 'PUT Object example');
        assert(sig('GET', 'https://examplebucket.s3.amazonaws.com/?lifecycle', {})
            === 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543', 'GET Bucket Lifecycle example');
        assert(sig('GET', 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J', {})
            === '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7', 'GET Bucket (List Objects) example');
    }

    // ── 2. Configuration and the factory ───────────────────────────────────────────────────────
    console.log('\n--- 2. Configuration and the factory ---');
    const goodEnv = fake.env();
    {
        const cfg = s3ConfigFromEnv(goodEnv);
        assert(cfg.endpoint === fake.endpoint && cfg.bucket === fake.bucket && cfg.region === 'auto',
            'a complete set of settings is accepted as given');
        for (const name of Object.values(S3_ENV)) {
            const env = { ...goodEnv };
            delete env[name];
            const text = throws(() => s3ConfigFromEnv(env), new RegExp(`missing: .*${name}`), `a missing ${name} is refused, by name`);
            errorTexts.push(text);
        }
        const none = throws(() => s3ConfigFromEnv({ IMAGE_STORE: 's3' }), null, 'nothing set at all is refused');
        assert(Object.values(S3_ENV).every((n) => none.includes(n)), 'and the refusal names all five settings at once');
        errorTexts.push(none);
        errorTexts.push(throws(() => s3ConfigFromEnv({ ...goodEnv, IMAGE_S3_ENDPOINT: 'http://photos.example.com' }), /must be https/,
            'plain http to anything but loopback is refused'));
        errorTexts.push(throws(() => s3ConfigFromEnv({ ...goodEnv, IMAGE_S3_ENDPOINT: `${fake.endpoint}/${fake.bucket}` }), /bare endpoint/,
            'an endpoint with the bucket in its path is refused, and says where the bucket goes'));
        errorTexts.push(throws(() => s3ConfigFromEnv({ ...goodEnv, IMAGE_S3_BUCKET: 'Bad_Bucket' }), /not a bucket name/, 'a malformed bucket name is refused'));
        errorTexts.push(throws(() => s3ConfigFromEnv({ ...goodEnv, IMAGE_S3_REGION: 'Auto!' }), /not a region name/, 'a malformed region is refused'));
        errorTexts.push(throws(() => s3ConfigFromEnv({ ...goodEnv, IMAGE_S3_SECRET_ACCESS_KEY: ` ${fake.secretAccessKey} ` }), /whitespace/,
            'a secret with stray whitespace is refused (a pasted newline would sign every request wrong)'));
        assert(configuredImageStoreKind({}) === 'disk', 'IMAGE_STORE unset is the disk store');
        throws(() => configuredImageStoreKind({ IMAGE_STORE: 'ftp' }), /not a backend/, 'an unknown IMAGE_STORE is a hard error');

        // The factory — on origin/main this throws "IMAGE_STORE=s3 is not a backend this version has".
        Object.assign(process.env, goodEnv);
        resetImageStoreForTests();
        const built = getImageStore();
        assert(built.kind === 's3' && built instanceof S3ImageStore, 'IMAGE_STORE=s3 builds an S3ImageStore');
        track(built as S3ImageStore);
        delete process.env.IMAGE_S3_BUCKET;
        resetImageStoreForTests();
        errorTexts.push(throws(() => getImageStore(), /missing: IMAGE_S3_BUCKET/, 'and with a setting missing it refuses rather than fall back to disk'));
        for (const k of Object.keys(goodEnv)) delete process.env[k];
        resetImageStoreForTests();
        assert(getImageStore().kind === 'disk', 'with IMAGE_STORE unset the factory builds the disk store, as before');
        resetImageStoreForTests();
    }

    // ── 3. One contract, both backends ─────────────────────────────────────────────────────────
    const diskRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imgstore-contract-'));
    await contract('disk', new DiskImageStore(path.join(diskRoot, 'images')));
    const s3 = track(new S3ImageStore(fake.config()));
    await contract('s3', s3);

    // ── 4. S3 specifics ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. S3 specifics ---');
    {
        const log = await fake.log();
        const refused = log.filter((e) => !e.authOk || e.error);
        assert(log.length >= 30, `the contract really went to the bucket (${log.length} requests)`);
        assert(refused.length === 0,
            `every one of those requests carried a signature the stand-in re-derived and accepted (${refused.length} refused)`);
        const objects = await fake.objects();
        const photo = [...objects.entries()].find(([k]) => k.startsWith('posts/post-cols/'));
        assert(!!photo && photo[1].mime === 'image/jpeg' && photo[1].meta === sha256Hex(JPEG),
            'an uploaded object carries its content type and its SHA-256 as metadata');

        // A bad signature: the bucket refuses it, and a new photo stays in its row instead of being lost.
        const wrong = track(new S3ImageStore(fake.config({ secretAccessKey: 'not-the-secret-WRONGSECRET' })));
        await fake.clearLog();
        errorTexts.push(throws(() => wrong.put('posts/w/0-aaaaaaaa.jpg', JPEG, { mime: 'image/jpeg' }), /403.*SignatureDoesNotMatch/,
            'a request signed with the wrong secret is refused 403 SignatureDoesNotMatch'));
        assert((await fake.log()).filter((e) => e.method === 'PUT').length === 1, 'and a 403 is not retried');
        const kept = storePhotoColumns(wrong, (s) => postPhotoKey('post-w', 0, s.sha256, s.mime), encodeDataUrl('image/jpeg', JPEG));
        assert(kept.photo_data === encodeDataUrl('image/jpeg', JPEG) && kept.storage_key === null,
            'a photo the bucket refuses stays in its row (the evacuation job moves it later) — never a failed post');

        // Retries: a 503, then success.
        await fake.clearLog();
        await fake.fault({ method: 'PUT', status: 503, code: 'SlowDown', count: 1 });
        const k503 = postPhotoKey('post-retry', 0, sha256Hex(PNG), 'image/png');
        s3.put(k503, PNG, { mime: 'image/png' });
        assert((await fake.log()).filter((e) => e.method === 'PUT').length === 2 && s3.get(k503)!.equals(PNG),
            'a 503 is retried, and the second attempt lands the object');
        // No answer at all, then success.
        await fake.clearLog();
        await fake.fault({ method: 'GET', network: true, count: 1 });
        assert(s3.get(k503)!.equals(PNG), 'a dropped connection is retried');
        assert((await fake.log()).filter((e) => e.method === 'GET').length === 2, 'with exactly one retry');
        // A 403 injected on a GET is not retried either.
        await fake.clearLog();
        await fake.fault({ method: 'GET', status: 403, code: 'AccessDenied', count: 1 });
        errorTexts.push(throws(() => s3.get(k503), /403.*AccessDenied/, 'a 403 on a read is an error'));
        assert((await fake.log()).filter((e) => e.method === 'GET').length === 1, 'and is not retried');

        // Timeouts and the breaker, with short settings so the suite is quick.
        const quick = track(new S3ImageStore(fake.config(), { syncAttemptTimeoutMs: 300, syncAttempts: 2, backoffMs: 50, breakerMs: 1_500 }));
        await fake.clearLog();
        await fake.fault({ method: 'GET', delayMs: 2_000, count: 2 });
        let t = Date.now();
        errorTexts.push(throws(() => quick.get(k503), /failed after 2 attempt\(s\): no answer within 300 ms/,
            'a bucket that does not answer times out, after the bounded number of attempts'));
        const waited = Date.now() - t;
        assert(waited < 2_000, `and the node was held for ${waited} ms — bounded by attempts × timeout, not by the bucket`);
        const before = (await fake.log()).length;
        t = Date.now();
        errorTexts.push(throws(() => quick.put('posts/b/0-bbbbbbbb.jpg', JPEG, { mime: 'image/jpeg' }), /not attempted/,
            'straight after, the breaker is open: a blocking call fails at once'));
        assert(Date.now() - t < 100 && (await fake.log()).length === before,
            'without waiting and without sending a request');
        const inline = storePhotoColumns(quick, (s) => postPhotoKey('post-b', 0, s.sha256, s.mime), encodeDataUrl('image/jpeg', JPEG));
        assert(inline.photo_data !== null && inline.storage_key === null, 'a post written while the breaker is open keeps its photo in the row');
        await new Promise((r) => setTimeout(r, 1_600));
        await fake.clearFaults();
        quick.put('posts/b/0-bbbbbbbb.jpg', JPEG, { mime: 'image/jpeg' });
        assert(quick.get('posts/b/0-bbbbbbbb.jpg')!.equals(JPEG), 'once the breaker has timed out, the blocking path works again');

        // The async path retries too, and never touches the blocking worker.
        await fake.clearLog();
        await fake.fault({ method: 'GET', status: 500, count: 2 });
        assert((await s3.getAsync(k503))!.equals(PNG), 'the async path retries a 500 twice and then reads the object');
        assert((await fake.log()).filter((e) => e.method === 'GET').length === 3, 'in three attempts');
        assert((await s3.getAsync('posts/none/0-00000000.jpg')) === null, 'the async path reads a missing object as null');

        // A missing BUCKET is not a missing photo.
        const noBucket = track(new S3ImageStore(fake.config({ bucket: 'no-such-bucket-here' })));
        errorTexts.push(throws(() => noBucket.get(k503), /404.*NoSuchBucket/, 'a GET against a bucket that does not exist is an error, not "no such photo"'));
        errorTexts.push(await rejects(() => noBucket.getAsync(k503), /404.*NoSuchBucket/, 'on the async path too'));

        // A slow body: the deadline covers the bucket's answer, not a phone's download.
        const slow = track(new S3ImageStore(fake.config(), { asyncAttemptTimeoutMs: 300, asyncAttempts: 1 }));
        await fake.fault({ method: 'GET', slowBodyMs: 800, count: 1 });
        const slowOpen = await slow.openRead(k503);
        assert(!!slowOpen && (await streamBytes(slowOpen.stream)).equals(PNG),
            'a streamed photo whose body takes longer than the attempt timeout still arrives whole');
        await fake.fault({ method: 'GET', slowBodyMs: 800, count: 1 });
        errorTexts.push(await rejects(() => slow.getAsync(k503), /did not arrive/,
            'while a buffered read keeps its deadline for the body, and says so'));

        // Streaming.
        const streamed = await s3.openRead(k503);
        assert(!!streamed && streamed.bytes === PNG.length && (await streamBytes(streamed.stream)).equals(PNG),
            'openRead streams the object with its length');

        // Pagination and keys that are not ours.
        const paged = await startFakeS3({ maxKeys: 2 });
        const pagedStore = track(new S3ImageStore(paged.config()));
        for (let i = 0; i < 5; i++) await paged.seed(`posts/pg/${i}-0000000${i}.jpg`, PNG, 'image/png');
        await paged.seed('posts/pg/has space.jpg', PNG);
        await paged.seed('backups/state.db', PNG);
        const listed = pagedStore.list('posts/pg');
        assert(listed.length === 5, `a listing that spans three pages returns all five objects (got ${listed.length})`);
        assert(!listed.includes('posts/pg/has space.jpg'), 'a key that could not be ours (unsafe as a key) is never listed');
        assert((await pagedStore.scanAsync('posts/pg')).length === 5, 'and the async listing paginates the same way');
        assert(!scanOurObjects(pagedStore).some((o) => o.key.startsWith('backups/')), 'nothing outside our namespaces is scanned for the sweep');
        const pages = (await paged.log()).filter((e) => e.method === 'GET' && e.query.includes('list-type=2') && e.query.includes('prefix=posts%2Fpg%2F'));
        assert(pages.length >= 6, `the listings really were paged (${pages.length} page requests for two listings)`);
        await paged.stop();

        // A large node: more objects in one namespace than V8 accepts as the arguments of one call. The backup,
        // the restore check and the shortfall count all go through scanOurObjectsAsync, so a spread here would
        // make a big node un-backupable with "Maximum call stack size exceeded".
        const many: ObjectInfo[] = Array.from({ length: 300_000 }, (_, i) => ({ key: `posts/big/${i}-00000000.jpg`, bytes: 1, mtimeMs: 0 }));
        const bigStore = { scanAsync: async (prefix: string) => (prefix === 'posts' ? many : []) } as unknown as ImageStore;
        let big: ObjectInfo[] | null = null;
        let bigError = '';
        try { big = await scanOurObjectsAsync(bigStore); } catch (e: any) { bigError = String(e?.message || e); }
        assert(big !== null && big.length === many.length,
            `scanOurObjectsAsync returns all ${many.length} objects of a large namespace${bigError ? ` (threw: ${bigError})` : ''}`);

        // The async paths never start the blocking worker: a fresh store used only through them has none.
        const asyncOnly = track(new S3ImageStore(fake.config()));
        const viaAsync = await storePhotoColumnsAsync(asyncOnly, (s) => postPhotoKey('post-async', 0, s.sha256, s.mime), encodeDataUrl('image/jpeg', JPEG));
        assert(!!viaAsync.storage_key && (await fake.objects()).get(viaAsync.storage_key!)?.bytes.equals(JPEG) === true,
            'a non-blocking write lands the photo in the bucket');
        await asyncOnly.getAsync(viaAsync.storage_key!);
        await asyncOnly.headAsync(viaAsync.storage_key!);
        await asyncOnly.scanAsync('posts');
        const o = await asyncOnly.openRead(viaAsync.storage_key!);
        if (o) await streamBytes(o.stream);
        assert((asyncOnly as any).fetcher.worker === null,
            'and put/get/head/list/stream on the async path never started the blocking worker — the event loop was never held');

        // What an operator can print about a store.
        const shown = [util.inspect(s3), JSON.stringify(s3), String(s3.describe()), util.inspect({ nested: { s3 } }, { depth: 5 })].join('\n');
        assert(!shown.includes(fake.secretAccessKey) && shown.includes(fake.bucket),
            'inspecting or serialising the store shows the bucket and never the secret');
    }

    // ── 5. The boot check ──────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. The boot check ---');
    {
        const setEnv = (env: Record<string, string | undefined>) => {
            for (const k of ['IMAGE_STORE', ...Object.values(S3_ENV)]) delete process.env[k];
            for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
            resetImageStoreForTests();
        };
        setEnv({});
        assert((await checkImageStoreAtBoot({ role: 'primary', dataDir })).startsWith('disk'), 'IMAGE_STORE unset: the disk store, nothing to check');
        for (const name of Object.values(S3_ENV)) {
            setEnv({ ...goodEnv, [name]: undefined });
            errorTexts.push(await rejects(() => checkImageStoreAtBoot({ role: 'primary', dataDir }), new RegExp(name),
                `boot refuses IMAGE_STORE=s3 without ${name}, and names it`));
        }
        setEnv({ ...goodEnv, IMAGE_S3_SECRET_ACCESS_KEY: 'wrong-SECRET-at-boot' });
        errorTexts.push(await rejects(() => checkImageStoreAtBoot({ role: 'primary', dataDir }), /refused these credentials \(HTTP 403\)/,
            'boot refuses when the bucket refuses the credentials'));
        setEnv({ ...goodEnv, IMAGE_S3_BUCKET: 'some-other-bucket' });
        errorTexts.push(await rejects(() => checkImageStoreAtBoot({ role: 'primary', dataDir }), /no such bucket/,
            'boot refuses a bucket that does not exist'));
        setEnv({ ...goodEnv, IMAGE_S3_ENDPOINT: 'http://127.0.0.1:1' });
        (getImageStore() as S3ImageStore);
        resetImageStoreForTests(track(new S3ImageStore(s3ConfigFromEnv(process.env), { asyncAttempts: 2, backoffMs: 10, asyncAttemptTimeoutMs: 1_000 })));
        errorTexts.push(await rejects(() => checkImageStoreAtBoot({ role: 'primary', dataDir }), /Could not reach/,
            'boot refuses an endpoint nothing answers on'));
        setEnv(goodEnv);
        errorTexts.push(await rejects(() => checkImageStoreAtBoot({ role: 'backup', dataDir }), /not supported on a standby/,
            'boot refuses s3 on a standby, whose sweep would delete the main server\'s objects from a shared bucket'));
        const local = path.join(dataDir, 'images', 'posts', 'old-post');
        fs.mkdirSync(local, { recursive: true });
        fs.writeFileSync(path.join(local, '0-abcdef12.jpg'), JPEG);
        setEnv(goodEnv);
        errorTexts.push(await rejects(() => checkImageStoreAtBoot({ role: 'primary', dataDir }), /keeps 1 photo\(s\).*migration tool/,
            'boot refuses s3 on a node whose photos are still on its own disk, and says why'));
        fs.rmSync(path.join(dataDir, 'images'), { recursive: true, force: true });
        setEnv(goodEnv);
        const ok = await checkImageStoreAtBoot({ role: 'primary', dataDir });
        assert(ok.includes(fake.bucket) && !ok.includes(fake.secretAccessKey), `a good configuration boots: "${ok}"`);
        track(getImageStore() as S3ImageStore);
        setEnv({});
    }

    // ── 6. The secret is never printed ─────────────────────────────────────────────────────────
    console.log('\n--- 6. The secret is never printed ---');
    {
        const secrets = [fake.secretAccessKey, 'not-the-secret-WRONGSECRET', 'wrong-SECRET-at-boot'];
        const everything = captured.join('\n') + '\n' + errorTexts.join('\n');
        assert(captured.length > 100, `the suite captured ${captured.length} log line(s) to check`);
        assert(secrets.every((s) => !everything.includes(s)),
            'no secret access key appears in any log line or error message this suite produced');
    }

    for (const s of stores) await s.close();
    await fake.stop();
    fs.rmSync(diskRoot, { recursive: true, force: true });
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ S3 image store tests PASSED.');
    process.exit(0);
}

main().catch((e) => {
    console.error('Suite crashed:', e);
    process.exit(1);
});
