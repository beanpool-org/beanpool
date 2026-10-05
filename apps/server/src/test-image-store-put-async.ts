/**
 * The disk store's non-blocking write (DiskImageStore.putAsync) against its blocking one (put): every refusal is the same
 * error with the same words, nothing is written for a refused object, and a stored object is the same result and the same
 * bytes on disk, under the same mode. writeObject reaches putAsync on disk now, so this is what keeps the move off the event
 * loop from changing what a write does.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiskImageStore, ImageStoreError, MAX_OBJECT_BYTES, sha256Hex, writeObject } from './storage/image-store.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}

const JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const PNG = Buffer.from('\x89PNG\r\n\x1a\nnot really the rest of a png');

function syncError(fn: () => unknown): Error | null {
    try { fn(); } catch (e) { return e as Error; }
    return null;
}
async function asyncError(fn: () => Promise<unknown>): Promise<Error | null> {
    try { await fn(); } catch (e) { return e as Error; }
    return null;
}
/** Every file under `dir`, relative, sorted: what a write left on disk. */
function filesUnder(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return (fs.readdirSync(dir, { recursive: true }) as string[])
        .filter(f => fs.statSync(path.join(dir, f)).isFile()).sort();
}

async function main(): Promise<void> {
    console.log('\n=== The disk store writes off the event loop, and refuses exactly as before ===\n');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-putasync-'));
    const blocking = new DiskImageStore(path.join(root, 'sync'));
    const nonBlocking = new DiskImageStore(path.join(root, 'async'));

    const refused: [string, string, Buffer, { mime: string; sha256?: string }][] = [
        ['bytes that do not match the hash the caller gave', 'posts/p/0-aaaaaaaa.jpg', JPEG, { mime: 'image/jpeg', sha256: sha256Hex(PNG) }],
        ['an empty object', 'posts/p/0-aaaaaaaa.jpg', Buffer.alloc(0), { mime: 'image/jpeg' }],
        ['an object over the size cap', 'posts/p/0-aaaaaaaa.jpg', Buffer.alloc(MAX_OBJECT_BYTES + 1), { mime: 'image/jpeg' }],
        ['something that is not a Buffer', 'posts/p/0-aaaaaaaa.jpg', 'a string' as unknown as Buffer, { mime: 'image/jpeg' }],
        ['a key that climbs out of the store', 'posts/../../etc/passwd', JPEG, { mime: 'image/jpeg' }],
        ['an absolute key', '/etc/passwd', JPEG, { mime: 'image/jpeg' }],
        ['an empty key', '', JPEG, { mime: 'image/jpeg' }],
        ['a key with a NUL', 'posts/a\0b.jpg', JPEG, { mime: 'image/jpeg' }],
        ['a key too deep', 'posts/a/b/c/d/e/f/g/h/i/too-deep.jpg', JPEG, { mime: 'image/jpeg' }],
    ];
    for (const [what, key, bytes, options] of refused) {
        const before = syncError(() => blocking.put(key, bytes, options));
        const after = await asyncError(() => nonBlocking.putAsync(key, bytes, options));
        assert(!!before && !!after && before.constructor === after.constructor && before.message === after.message,
            `putAsync refuses ${what} with put's own error (${before?.constructor.name}: ${JSON.stringify(before?.message)})`);
        const viaWrite = await asyncError(() => writeObject(nonBlocking, key, bytes, options));
        assert(!!viaWrite && viaWrite.message === before?.message, `writeObject on disk refuses ${what} the same way`);
    }
    assert(filesUnder(path.join(root, 'async')).length === 0 && filesUnder(path.join(root, 'sync')).length === 0,
        'a refused write leaves nothing on disk, either way');
    assert(!fs.existsSync(path.join(root, 'etc')) && !fs.existsSync('/etc/passwd.tmp'), 'no refused key wrote outside the store');

    const key = `posts/post-abc/0-${sha256Hex(JPEG).slice(0, 16)}.jpg`;
    const want = blocking.put(key, JPEG, { mime: 'image/jpeg', sha256: sha256Hex(JPEG).toUpperCase() });
    const got = await nonBlocking.putAsync(key, JPEG, { mime: 'image/jpeg', sha256: sha256Hex(JPEG).toUpperCase() });
    assert(JSON.stringify(got) === JSON.stringify(want), 'a stored object is the same result');
    assert(nonBlocking.get(key)!.equals(JPEG), 'and the same bytes on disk');
    assert(JSON.stringify(filesUnder(path.join(root, 'async'))) === JSON.stringify(filesUnder(path.join(root, 'sync'))),
        'under the same path, with no temp file left behind');
    const mode = (s: DiskImageStore) => (fs.statSync(path.join(s.root, key)).mode & 0o777).toString(8);
    const dirMode = (s: DiskImageStore) => (fs.statSync(path.join(s.root, 'posts')).mode & 0o777).toString(8);
    assert(mode(nonBlocking) === mode(blocking) && mode(blocking) === '600', `the object is 0o600 either way (${mode(nonBlocking)})`);
    assert(dirMode(nonBlocking) === dirMode(blocking), `its directory has the same mode either way (${dirMode(nonBlocking)})`);
    const again = await nonBlocking.putAsync(key, JPEG, { mime: 'image/jpeg' });
    assert(JSON.stringify(again) === JSON.stringify(want) && nonBlocking.get(key)!.equals(JPEG), 'writing the same object again replaces it in place');

    // Off the loop: many writes at once all land, each its own object, while timers keep firing.
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    const many = await Promise.all(Array.from({ length: 40 }, (_, i) => {
        const bytes = Buffer.concat([JPEG, Buffer.from(String(i))]);
        return writeObject(nonBlocking, `posts/many-${i}/0-${sha256Hex(bytes).slice(0, 16)}.jpg`, bytes, { mime: 'image/jpeg' });
    }));
    clearInterval(timer);
    assert(many.every((m, i) => nonBlocking.get(m.key)!.equals(Buffer.concat([JPEG, Buffer.from(String(i))]))),
        '40 writes at once each land whole');
    assert(ticks > 0, `the event loop ran while they were written (${ticks} timer ticks)`);
    assert(!filesUnder(nonBlocking.root).some(f => f.includes('.tmp-')), 'no temp file is left behind');
    assert(ImageStoreError.name === 'ImageStoreError', 'refusals are ImageStoreError, as before');

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Image store putAsync tests PASSED.\n');
}

main().catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
