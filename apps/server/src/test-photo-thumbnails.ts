/**
 * Lists show a listing photo's small copy (Marty, board, 9 Oct: "~200 px / ~10 KB copy for lists").
 *
 * A Market page of 20 rows downloaded 20 full photos. Now the photo route answers `size=thumb` with a ~200 px copy of
 * the photo, kept in the image store beside it (storage/photo-thumbnails.ts), behind exactly the gates the photo has.
 *
 * Every run is the real server over TLS through the real middleware, reads signed, in its own process on its own data
 * dir: `disk` (the default store) and `s3` (IMAGE_STORE=s3 against the in-process stand-in bucket, fake-s3-test-harness.ts:
 * no real bucket and no BeanPool node is contacted).
 *
 *  1. Made at upload: a listing with a real JPEG, WebP, PNG and a PNG with transparency (src/__fixtures__/photos). Each
 *     photo's small copy is in the store beside it, its longest side 200 px, the same format, the PNG's transparency
 *     kept, each at most 10 KB; served at the URL the listing read hands out with `&size=thumb`, the same type and the
 *     same cache header as the photo, the photo itself unchanged at its own URL.
 *  2. Made on first request, then kept: a photo stored before this (its small copy not there) is answered with one,
 *     which is then in the store, and the next request is served from the store (its bytes, marked, come back).
 *  3. A photo kept in its row (not in the store) has no small copy: `size=thumb` serves the photo itself.
 *  4. The gates: for each case the photo route refuses or allows (no key, a wrong key, a listing taken off, one hidden by
 *     reports, its rows gone), the small copy gets the same status and the same cache header, for every reader.
 *  5. Nothing in state.db: no row, column or byte of a small copy in the database file.
 *  6. The orphan sweep keeps a small copy while its photo is named and removes one whose photo no row names; replacing a
 *     listing's photos removes the old photos' small copies with them.
 *
 * Run: node scripts/run-server-suites.mjs with SERVER_SUITES_ONLY=test-photo-thumbnails
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.CF_API_TOKEN;
delete process.env.CF_ZONE_ID;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_PROFILE;
delete process.env.PRIVATE_PREVIEW;
type Mode = 'disk' | 's3';
const MODE_NAME: Mode = (process.env.THUMB_MODE as Mode | undefined) || 'disk';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { setMemberPhoto } from '@beanpool/engine';

const MODE = `[${MODE_NAME}]`;
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
}
const DAY = 24 * 60 * 60 * 1000;
const THUMB_MAX_BYTES = 10 * 1024;
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'photos');
const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));
const dataUrl = (mime: string, bytes: Buffer): string => `data:${mime};base64,${bytes.toString('base64')}`;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

type Id = { pk: string; privateKey: crypto.KeyObject };
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n`;
    return {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

let beforeCall: () => void = () => {};
type Res = { status: number; bytes: Buffer; body: any; cache: string | null; type: string | null };
async function get(p: string, id?: Id): Promise<Res> {
    beforeCall();
    const res = await fetch(`${BASE}${p}`, { headers: id ? signedHeaders('GET', p, id) : {} });
    const bytes = Buffer.from(await res.arrayBuffer());
    let body: any;
    try { body = JSON.parse(bytes.toString('utf8')); } catch { /* an image */ }
    return { status: res.status, bytes, body, cache: res.headers.get('cache-control'), type: res.headers.get('content-type') };
}
const thumbOf = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}size=thumb`;

async function main(): Promise<void> {
    console.log(`\n=== Lists show a listing photo's small copy ${MODE} ===\n`);
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    let fake: Awaited<ReturnType<typeof import('./fake-s3-test-harness.js')['startFakeS3']>> | null = null;
    if (MODE_NAME === 's3') {
        const { startFakeS3 } = await import('./fake-s3-test-harness.js');
        fake = await startFakeS3();
        Object.assign(process.env, fake.env());
    }
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { getImageStore, readObject, writeObject, headObject, postPhotoKey, sha256Hex, imagesDir } = await import('./storage/image-store.js');
    const { sweepOrphanedImageObjects } = await import('./engine/storage-health.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    // Absent on a build without small copies (the fail-first run): the checks then fail rather than the suite crashing.
    const thumbs = await import('./storage/photo-thumbnails.js').catch(() => null);
    const settled = async (): Promise<void> => { if (thumbs) await thumbs.thumbnailsSettled(); else await new Promise(r => setTimeout(r, 300)); };
    const thumbKeyOf = (key: string): string => key.replace(/\.(jpg|png|webp)$/, '-t.$1');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const store = getImageStore();
    assert(store.kind === MODE_NAME, `setup: the node's image store is ${MODE_NAME} (got ${store.kind})`);

    const member = (callsign: string): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', ?, 'seed', ?)`)
            .run(id.pk, callsign, new Date(Date.now() - 60 * DAY).toISOString(), `INV-${callsign.toUpperCase()}`);
        setMemberPhoto(db, id.pk, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const alice = member('ThumbAlice');
    const carol = member('ThumbCarol');
    const mo = member('ThumbMo');
    db.prepare("INSERT INTO node_roles (member_pubkey, role) VALUES (?, 'admin')").run(mo.pk);
    const outsider = newId();

    const make = (title: string, photos: string[]): string => {
        const p = se.createPost('offer', 'food', title, `${title}, described`, 0, 'fixed', alice.pk, -28.55, 153.5, photos, false)!;
        return p.id as string;
    };
    /** The listing's photo URLs, as its author's read by id hands them out. */
    const urlsOf = async (postId: string): Promise<string[]> => {
        const r = await get(`/api/marketplace/posts?id=${postId}&types=offer,need,poll,event`, alice);
        const urls = Array.isArray(r.body) ? r.body[0]?.photos : undefined;
        if (!Array.isArray(urls) || urls.length === 0) throw new Error(`no photo URLs for ${postId} (${r.status})`);
        return urls;
    };
    const rowOf = (postId: string, n: number) =>
        db.prepare('SELECT storage_key, photo_data, mime FROM post_photos WHERE post_id = ? AND order_num = ?').get(postId, n) as
            { storage_key: string | null; photo_data: string | null; mime: string | null };

    // ── 1. made at upload ─────────────────────────────────────────────────────────────────────
    console.log('\n── 1. made when the photo is stored ──');
    const fixtures = [
        { name: 'listing-800.jpg', mime: 'image/jpeg', format: 'jpeg', alpha: false },
        { name: 'listing-800.webp', mime: 'image/webp', format: 'webp', alpha: false },
        { name: 'listing-400.png', mime: 'image/png', format: 'png', alpha: false },
        { name: 'listing-300-alpha.png', mime: 'image/png', format: 'png', alpha: true },
    ];
    const originals = fixtures.map(f => fixture(f.name));
    const shelf = make('Thumb shelf, four photos', fixtures.map((f, i) => dataUrl(f.mime, originals[i])));
    await settled();
    const shelfUrls = await urlsOf(shelf);
    const sizes: string[] = [];
    for (const [i, f] of fixtures.entries()) {
        const row = rowOf(shelf, i);
        const thumbKey = row.storage_key ? thumbKeyOf(row.storage_key) : '';
        const kept = row.storage_key ? await readObject(store, thumbKey) : null;
        assert(!!kept, `${f.name}: its small copy is in the store beside it (${thumbKey})`);
        const meta = kept ? await sharp(kept).metadata() : null;
        assert(!!meta && Math.max(meta.width ?? 0, meta.height ?? 0) === 200 && meta.format === f.format && !!meta.hasAlpha === f.alpha,
            `${f.name}: 200 px on its longest side, ${f.format}${f.alpha ? ', its transparency kept' : ''} (got ${meta?.width}x${meta?.height} ${meta?.format} alpha ${meta?.hasAlpha})`);
        assert(!!kept && kept.length <= THUMB_MAX_BYTES, `${f.name}: ${kept?.length} bytes, at most ${THUMB_MAX_BYTES} (the photo is ${originals[i].length})`);
        const full = await get(shelfUrls[i], carol);
        const small = await get(thumbOf(shelfUrls[i]), carol);
        assert(full.status === 200 && full.bytes.length > 0 && small.status === 200 && !!kept && small.bytes.equals(kept),
            `${f.name}: &size=thumb serves the small copy (${full.status} ${full.bytes.length} B → ${small.status} ${small.bytes.length} B)`);
        assert(small.type === full.type && small.type === f.mime && small.cache === full.cache,
            `${f.name}: the same type and cache header as the photo (${small.type} "${small.cache}" vs ${full.type} "${full.cache}")`);
        sizes.push(`${f.name} ${full.bytes.length} → ${small.bytes.length} B`);
    }
    {
        const full = await get(shelfUrls[0], carol);
        assert(full.bytes.length > THUMB_MAX_BYTES && !!rowOf(shelf, 0).storage_key && full.bytes.equals((await readObject(store, rowOf(shelf, 0).storage_key!))!),
            `the photo's own URL still serves the 800 px photo, unchanged (${full.bytes.length} B)`);
    }
    console.log(`   sizes: ${sizes.join('; ')}`);

    // ── 2. made on first request, then kept ─────────────────────────────────────────────────────
    console.log('\n── 2. a photo stored before this: made on its first request, then served from the store ──');
    {
        // A listing whose photo went to the store before small copies existed: the object and the row, nothing else.
        const old = make('Thumb kettle, from before', [TINY_PNG]);
        const bytes = fixture('listing-800.jpg');
        const key = postPhotoKey(old, 0, sha256Hex(bytes), 'image/jpeg');
        await writeObject(store, key, bytes, { mime: 'image/jpeg' });
        db.prepare('UPDATE post_photos SET photo_data = NULL, storage_key = ?, sha256 = ?, bytes = ?, mime = ? WHERE post_id = ? AND order_num = 0')
            .run(key, sha256Hex(bytes), bytes.length, 'image/jpeg', old);
        const thumbKey = thumbKeyOf(key);
        assert(!(await headObject(store, thumbKey)), 'setup: the old photo has no small copy');
        const [url] = await urlsOf(old);
        const first = await get(thumbOf(url), carol);
        const meta = first.status === 200 ? await sharp(first.bytes).metadata().catch(() => null) : null;
        assert(first.status === 200 && meta?.width === 200 && first.bytes.length <= THUMB_MAX_BYTES,
            `the first request is answered with a small copy (${first.status}, ${meta?.width}x${meta?.height}, ${first.bytes.length} B)`);
        await settled();
        const kept = await readObject(store, thumbKey);
        assert(!!kept && kept.equals(first.bytes), '…which is then kept in the store');
        // Mark the kept copy: a second request that reads the store returns the mark; one that made it again would not.
        const marked = Buffer.concat([kept ?? Buffer.alloc(0), Buffer.from('served-from-the-store')]);
        await writeObject(store, thumbKey, marked, { mime: 'image/jpeg' });
        const second = await get(thumbOf(url), carol);
        assert(second.status === 200 && second.bytes.equals(marked), 'the next request is served from the store, not made again');
    }

    // ── 3. a photo kept in its row ──────────────────────────────────────────────────────────────
    console.log('\n── 3. a photo kept in its row: the photo itself ──');
    {
        const inline = make('Thumb teapot, in its row', [TINY_PNG]);
        const bytes = fixture('listing-400.png');
        db.prepare('UPDATE post_photos SET photo_data = ?, storage_key = NULL, sha256 = NULL, bytes = NULL, mime = NULL WHERE post_id = ? AND order_num = 0')
            .run(dataUrl('image/png', bytes), inline);
        const [url] = await urlsOf(inline);
        const r = await get(thumbOf(url), carol);
        assert(r.status === 200 && r.bytes.equals(bytes) && r.type === 'image/png', `size=thumb serves the photo from the row as it is (${r.status} ${r.bytes.length} B)`);
    }

    // ── 4. the gates ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the small copy is refused exactly when the photo is ──');
    const jpg = fixture('listing-800.jpg');
    const live = make('Thumb lamp, live', [dataUrl('image/jpeg', jpg)]);
    const cancelled = make('Thumb drum, cancelled', [dataUrl('image/jpeg', jpg)]);
    const hidden = make('Thumb clock, hidden by reports', [dataUrl('image/jpeg', jpg)]);
    const gone = make('Thumb scarf, deleted', [dataUrl('image/jpeg', jpg)]);
    await settled();
    const url: Record<string, string> = {};
    for (const id of [live, cancelled, hidden, gone]) url[id] = (await urlsOf(id))[0];
    assert(se.removePost(cancelled, alice.pk), 'setup: Alice cancels one listing');
    db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), hidden);
    db.prepare('DELETE FROM posts WHERE id = ?').run(gone);
    const noKey = url[live].replace(/&k=[^&]+/, '');
    const wrongKey = url[live].replace(/k=[^&]+/, 'k=AAAAAAAAAAAAAAAAAAAAAA');
    assert(/[?&]k=/.test(url[live]) && noKey !== url[live], `setup: a listing's photo URL carries its key here (${url[live]})`);
    const readers: [string, Id | undefined][] = [
        ['the stranger (unsigned)', undefined], ['the outsider (signed, no member)', outsider], ['Carol', carol], ['Alice (author)', alice], ['Mo (admin)', mo],
    ];
    const cases: [string, string][] = [
        ['the live listing', url[live]], ['no key', noKey], ['a wrong key', wrongKey],
        ['the cancelled listing', url[cancelled]], ['the listing hidden by reports', url[hidden]], ['the deleted listing', url[gone]],
    ];
    const seen = new Set<string>();
    for (const [what, u] of cases) {
        for (const [who, reader] of readers) {
            const full = await get(u, reader);
            const small = await get(thumbOf(u), reader);
            seen.add(`${full.status}`);
            assert(small.status === full.status && small.cache === full.cache && (full.status !== 200 || small.bytes.length < full.bytes.length),
                `${what}, ${who}: the small copy ${small.status} "${small.cache}", the photo ${full.status} "${full.cache}"`);
        }
    }
    assert(seen.has('200') && seen.has('404'), `setup: the sweep met both answers (${[...seen].join(', ')})`);

    // ── 5. nothing in state.db ──────────────────────────────────────────────────────────────────
    console.log('\n── 5. no small copy in state.db ──');
    {
        const sample = await readObject(store, thumbKeyOf(rowOf(shelf, 0).storage_key ?? ''));
        const cols = (db.prepare("SELECT name FROM pragma_table_info('post_photos')").all() as { name: string }[]).map(c => c.name);
        assert(!cols.some(c => /thumb/i.test(c)), `post_photos has no column for it (${cols.join(', ')})`);
        const keyRows = db.prepare("SELECT COUNT(*) AS n FROM post_photos WHERE storage_key LIKE '%-t.%'").get() as { n: number };
        assert(keyRows.n === 0, `no row names a small copy (${keyRows.n})`);
        db.pragma('wal_checkpoint(TRUNCATE)');
        const dbFile = fs.readFileSync(path.join(dataDir, 'state.db'));
        assert(!!sample && dbFile.indexOf(sample) < 0 && dbFile.indexOf(Buffer.from(sample.toString('base64').slice(0, 64))) < 0,
            `the database file holds none of its bytes, raw or base64 (${dbFile.length} B searched)`);
        if (MODE_NAME === 's3') {
            const onDisk = fs.existsSync(imagesDir(dataDir)) ? fs.readdirSync(imagesDir(dataDir), { recursive: true }).length : 0;
            assert(onDisk === 0, `an s3 node keeps them in the bucket, nothing on its disk (${onDisk} entries)`);
        }
    }

    // ── 6. the orphan sweep and a replaced photo ─────────────────────────────────────────────────
    console.log('\n── 6. kept while its photo is, gone with it ──');
    {
        const age = async (key: string): Promise<void> => {
            const old = Date.now() - 3 * 60 * 60 * 1000;
            if (fake) { await fake.setMtime(key, old); return; }
            const file = path.join(imagesDir(dataDir), key);
            fs.utimesSync(file, old / 1000, old / 1000);
        };
        const keptThumb = thumbKeyOf(rowOf(live, 0).storage_key!);
        await age(keptThumb);
        // A small copy whose photo no row names: an old listing's, left behind.
        const strayPhoto = postPhotoKey('thumb-stray-listing', 0, sha256Hex(Buffer.from('stray')), 'image/jpeg');
        const stray = thumbKeyOf(strayPhoto);
        await writeObject(store, stray, jpg.subarray(0, 2000), { mime: 'image/jpeg' });
        await age(stray);
        await sweepOrphanedImageObjects({ db, dataDir, store });
        assert(!!(await headObject(store, keptThumb)), "the sweep keeps an aged small copy while a row names its photo");
        assert(!(await headObject(store, stray)), 'and removes an aged one whose photo no row names');

        const before = thumbKeyOf(rowOf(live, 0).storage_key!);
        const png = fixture('listing-400.png');
        se.updatePost(live, alice.pk, { photos: [dataUrl('image/png', png)] } as any);
        await settled();
        const after = rowOf(live, 0).storage_key!;
        assert(after !== null && thumbKeyOf(after) !== before && !!(await headObject(store, thumbKeyOf(after))),
            `a replaced photo has its own small copy (${thumbKeyOf(after)})`);
        assert(!(await headObject(store, before)), "and the old photo's small copy went with the old photo");
    }

    if (fake) await fake.stop();
    console.log(`\n${MODE} ${passed}/${run} passed`);
}

async function parent(): Promise<void> {
    let ok = true;
    try {
        await main();
    } catch (e) {
        console.error(`✗ ${MODE} threw:`, e);
        ok = false;
    }
    ok &&= passed === run;
    if (process.env.THUMB_CHILD === '1') process.exit(ok ? 0 : 1);
    console.log('\n── the s3 run, in a fresh process ──');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-thumbs-s3-'));
    const env: NodeJS.ProcessEnv = { ...process.env, THUMB_MODE: 's3', THUMB_CHILD: '1', BEANPOOL_DATA_DIR: dataDir };
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    const status = await new Promise<number | null>(resolve => {
        child.on('exit', code => resolve(code));
        child.on('error', () => resolve(null));
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
    run++;
    if (status === 0) { passed++; console.log('✓ the s3 run passed'); } else { ok = false; console.error(`✗ the s3 run failed (exit ${status})`); }
    console.log(`\n${ok ? 'PASS' : 'FAIL'}: test-photo-thumbnails (${passed}/${run})`);
    process.exit(ok ? 0 : 1);
}

parent();
