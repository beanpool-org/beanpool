/**
 * A new post's photos are written off the event loop (engine/posts.ts prestorePostPhotos, through the disk store's
 * putAsync) before the synchronous createPost, which then writes none of them. Over REAL HTTPS through the real
 * signature middleware, on the global profile (probation on):
 *
 *   1. a post with photos: createPost calls the blocking `put` for none of them, `putAsync` once each; the rows name
 *      objects that are on disk, keyed and sized as the blocking path keys and sizes them, and the photo route serves
 *      the bytes that were sent
 *   2. a words member (2 posts a day) refused by the cap with photos: the same 429 words, and no new file
 *   3. eight posts with photos at once from a words member with none yet: exactly 2 are made, the other 6 refused by
 *      the cap, and the only new files are the made posts' photos
 *   4. an event refused inside createPost's transaction (5 upcoming at a time) after its photos were written: the same
 *      words, and no new file (the blocking path left these for the daily orphan sweep)
 *   5. refusals in main's words: a photo that is not a JPEG/PNG/WebP, a Need with no Offer from a member who sent
 *      photos (a non-photo refusal inside createPost, after they were written), a post id that is taken
 *
 * Run: through scripts/run-server-suites.mjs (test-post-photos-prestore).
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, createPost } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { installPhotoKeysAtBoot } from './engine/photo-keys.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { DiskImageStore, imagesDir } from './storage/image-store.js';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let BASE = '';

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
function member(name: string, daysAgo: number): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, ?, 'TEST', 'active')`).run(id.pk, name, ago(daysAgo * DAY), owner.pk);
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}
/** Off probation: two months in, 3 posts that stayed up, written before any window. */
function establishedMember(name: string): Id {
    const id = member(name, 60);
    for (let i = 0; i < 3; i++) {
        const p = createPost('offer', 'other', `${name} kept ${i}`, 'kept', 0, 'fixed', id.pk)!;
        db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(ago(2 * DAY), p.id);
    }
    return id;
}
/** A member who came in through the 12-words door: 2 posts a day on probation (engine/probation.ts WORDS_PROBATION). */
function wordsMember(name: string): Id {
    const id = member(name, 0);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, updated_at, join_cohort) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id.pk, 'words', crypto.randomBytes(16).toString('hex'), now, now, 'test');
    return id;
}

interface Res { status: number; body: any; raw: string }
async function call(method: 'GET' | 'POST', id: Id | null, p: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${p}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let parsed: any = buf;
    try { parsed = JSON.parse(text); } catch { /* bytes */ }
    return { status: res.status, body: parsed, raw: text };
}

/** A JPEG the metadata strip walks and leaves as sent (test-global-moderation's). */
function jpegBytes(seed: string): Buffer {
    const scan = crypto.createHash('sha512').update(seed).digest().map(b => (b === 0xff ? 0xfe : b));
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), scan, Buffer.from([0xff, 0xd9])]);
}
const photo = (seed: string) => `data:image/jpeg;base64,${jpegBytes(seed).toString('base64')}`;
let n = 0;
const offer = (id: Id, extra: Record<string, unknown> = {}) =>
    call('POST', id, '/api/marketplace/posts', { type: 'offer', category: 'other', title: `${id.name} offer ${++n}`, description: 'An offer', credits: 0, authorPublicKey: id.pk, ...extra });

/** Every file under the store's directory, temp files included. */
function filesOnDisk(): Set<string> {
    const out = new Set<string>();
    const root = imagesDir();
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full); else out.add(path.relative(root, full));
        }
    };
    walk(root);
    return out;
}
const added = (before: Set<string>) => [...filesOnDisk()].filter(f => !before.has(f));
const keysOf = (postId: string) =>
    (db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? ORDER BY order_num').all(postId) as any[]).map(r => r.storage_key as string);

const calls = { put: 0, putAsync: 0 };
const origPut = DiskImageStore.prototype.put;
const origPutAsync = DiskImageStore.prototype.putAsync;
DiskImageStore.prototype.put = function (this: DiskImageStore, ...a: Parameters<typeof origPut>) { calls.put++; return origPut.apply(this, a); };
DiskImageStore.prototype.putAsync = function (this: DiskImageStore, ...a: Parameters<typeof origPutAsync>) { calls.putAsync++; return origPutAsync.apply(this, a); };
const resetCalls = () => { calls.put = 0; calls.putAsync = 0; };

async function main(): Promise<void> {
    console.log('\n=== A new post\'s photos are written before createPost, off the event loop ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    installPhotoKeysAtBoot();
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');

    // ── 1. a post with photos ────────────────────────────────────────────────────────────────────
    console.log('── 1. a post with photos ──');
    const est = establishedMember('Esther');
    let before = filesOnDisk();
    resetCalls();
    const one = await offer(est, { photos: [photo('a1'), photo('a2')] });
    assert(one.status === 200 && one.body?.success === true, `a post with 2 photos is made (got ${one.status} ${one.raw.slice(0, 120)})`);
    assert(calls.put === 0, `the blocking put wrote none of its photos (got ${calls.put})`);
    assert(calls.putAsync === 2, `putAsync wrote each photo once (got ${calls.putAsync})`);
    const id1 = one.body?.post?.id as string;
    const k1 = keysOf(id1);
    assert(k1.length === 2 && k1.every(k => !!k && fs.existsSync(path.join(imagesDir(), k))), `its rows name 2 objects that are on disk (got ${JSON.stringify(k1)})`);
    assert(added(before).sort().join() === [...k1].sort().join(), `and those are the only new files (got ${JSON.stringify(added(before))})`);
    // The same photos through the blocking path (createPost straight from the engine, no route): the same columns but the id.
    const sync = createPost('offer', 'other', 'sync twin', 'x', 0, 'fixed', est.pk, undefined, undefined, [photo('a1'), photo('a2')])!;
    const cols = (pid: string) => (db.prepare('SELECT order_num, photo_data, sha256, bytes, mime, storage_key FROM post_photos WHERE post_id = ? ORDER BY order_num').all(pid) as any[])
        .map(r => ({ ...r, storage_key: String(r.storage_key).replace(pid, '<id>') }));
    assert(JSON.stringify(cols(id1)) === JSON.stringify(cols(sync.id)),
        `its columns are the blocking path's for the same photos (got ${JSON.stringify(cols(id1))} vs ${JSON.stringify(cols(sync.id))})`);
    const served = await call('GET', est, `/api/marketplace/posts/${id1}/photos/1`);
    assert(served.status === 200 && Buffer.isBuffer(served.body) && served.body.equals(jpegBytes('a2')), `the photo route serves the bytes that were sent (got ${served.status})`);

    // ── 2. refused by the cap ────────────────────────────────────────────────────────────────────
    console.log('── 2. a words member at the cap ──');
    const w = wordsMember('Wren');
    assert((await offer(w, { photos: [photo('w1')] })).status === 200, 'a words member\'s 1st post is made');
    assert((await offer(w, { photos: [photo('w2')] })).status === 200, 'and the 2nd');
    before = filesOnDisk();
    resetCalls();
    const third = await offer(w, { photos: [photo('w3'), photo('w4')] });
    assert(third.status === 429 && third.body?.code === 'probation_limit' && third.body?.limit === 'posts',
        `the 3rd is refused by the cap: 429 probation_limit posts (got ${third.status} ${third.raw.slice(0, 160)})`);
    assert(added(before).length === 0, `and leaves no file (got ${JSON.stringify(added(before))})`);
    assert(calls.put + calls.putAsync === 0, `nothing was written for it (put ${calls.put}, putAsync ${calls.putAsync})`);

    // ── 3. eight at once at the cap ─────────────────────────────────────────────────────────────
    console.log('── 3. eight at once ──');
    const r = wordsMember('Rush');
    before = filesOnDisk();
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => offer(r, { photos: [photo(`r${i}a`), photo(`r${i}b`)] })));
    const made = burst.filter(b => b.status === 200);
    const capped = burst.filter(b => b.status === 429 && b.body?.code === 'probation_limit' && b.body?.limit === 'posts');
    assert(made.length === 2, `exactly 2 of 8 are made (got ${made.length}: ${burst.map(b => b.status).join(',')})`);
    assert(capped.length === 6, `the other 6 are refused by the cap (got ${capped.length})`);
    const rowsNow = (db.prepare('SELECT COUNT(*) AS c FROM posts WHERE author_pubkey = ?').get(r.pk) as any).c;
    assert(rowsNow === 2, `and 2 posts are stored (got ${rowsNow})`);
    const madeKeys = made.flatMap(m => keysOf(m.body.post.id));
    assert(madeKeys.length === 4 && added(before).sort().join() === madeKeys.sort().join(),
        `the only new files are the made posts' 4 photos (got ${added(before).length} new, ${madeKeys.length} named)`);

    // ── 4. refused inside createPost's transaction ──────────────────────────────────────────────
    console.log('── 4. an event past the upcoming cap ──');
    const host = establishedMember('Hal');
    const start = new Date(Date.now() + 3 * DAY).toISOString();
    const event = (i: number, photos?: string[]) => call('POST', host, '/api/marketplace/posts',
        { type: 'event', title: `Hal event ${i}`, authorPublicKey: host.pk, eventStartAt: start, lat: -28.5, lng: 153.5, ...(photos ? { photos } : {}) });
    for (let i = 0; i < 5; i++) assert((await event(i)).status === 200, `upcoming event ${i + 1} of 5 is made`);
    before = filesOnDisk();
    const sixth = await event(5, [photo('e1'), photo('e2')]);
    assert(sixth.status === 400 && sixth.raw === JSON.stringify({ error: 'Limit reached: 5 upcoming events at a time' }),
        `a 6th, with photos, gets the same words (got ${sixth.status} ${sixth.raw})`);
    assert(added(before).length === 0, `and leaves no file (got ${JSON.stringify(added(before))})`);

    // ── 5. refusals in main's words ─────────────────────────────────────────────────────────────
    console.log('── 5. refusals ──');
    const v = establishedMember('Val');
    before = filesOnDisk();
    const notJpeg = `data:image/jpeg;base64,${Buffer.from('not a jpeg at all, just text').toString('base64')}`;
    const bad = await offer(v, { photos: [photo('v1'), notJpeg] });
    assert(bad.status === 400 && bad.raw === JSON.stringify({ error: 'Each photo must be a JPEG, PNG or WebP image' }),
        `a photo that is not a JPEG/PNG/WebP: 400 in the same words (got ${bad.status} ${bad.raw})`);
    assert(added(before).length === 0, `and no file, not even the good photo beside it (got ${JSON.stringify(added(before))})`);
    // A Need from a member with no listed Offer: refused inside createPost, after the photos were written.
    const needy = member('Nell', 60);
    before = filesOnDisk();
    const need = await call('POST', needy, '/api/marketplace/posts', { type: 'need', category: 'other', title: 'Nell need', authorPublicKey: needy.pk, photos: [photo('n1')] });
    assert(need.status === 400 && typeof need.body?.error === 'string' && /offer/i.test(need.body.error),
        `a Need with no Offer is refused in createPost's words (got ${need.status} ${need.raw.slice(0, 200)})`);
    assert(added(before).length === 0, `and leaves no file (got ${JSON.stringify(added(before))})`);
    // A post id that is taken: refused before anything is written, and the other post's photos are untouched.
    const keysBefore = keysOf(id1);
    before = filesOnDisk();
    const taken = await offer(est, { id: id1, photos: [photo('a1'), photo('zz')] });
    assert(taken.status === 400 && taken.raw === JSON.stringify({ error: 'A new post needs an id nothing else has. Send it without one and this community makes one.' }),
        `a taken post id: 400 in the same words (got ${taken.status} ${taken.raw})`);
    assert(added(before).length === 0 && keysBefore.every(k => fs.existsSync(path.join(imagesDir(), k))),
        `no new file, and the other post's photos are still there (got ${JSON.stringify(added(before))})`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) throw new Error(`${run - passed} failed`);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
