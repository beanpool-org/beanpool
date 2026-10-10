/**
 * The node gzips its /api answers for a reader that asks (api-compression.ts).
 *
 * The global load test (REPORT-geosync-load-A, 10 Oct) found every /api answer sent raw, even to a reader sending
 * `Accept-Encoding: gzip`: a first sync at 20,000 listings was 26.6 MB on the wire against 4.2 MB gzipped.
 *
 * Boots the real server on port 0 and reads it over TLS with node:https (which sends no Accept-Encoding of its own and
 * decodes nothing, so every header and byte here is what the node sent):
 *   1. the listings sync read, asked with gzip: gzipped, Vary: Accept-Encoding, a weak ETag, and the same JSON once
 *      gunzipped; asked without (or with gzip;q=0): plain, with Vary too
 *   2. 304 with the ETag either answer gave, asked either way, and no body or encoding on it
 *   3. the shared directory snapshot (a heavy read with its own gzip copy): gzipped once, not twice
 *   4. a heavy read built per reader (the web app's directory): sent plain, and the heavy-read cap learns its raw size,
 *      as before this change
 *   5. a member's photo: its bytes as stored, never encoded, though they compress to nothing
 *   6. HEAD, a range request and a small answer: never encoded
 * With API_GZIP=off (the operator's switch; its own run in scripts/server-suites.mjs), sections 1-6 give way to: every
 * answer as the route made it, no Vary of the middleware's, the route's own ETag; the snapshots' own gzip copy stays.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-api-compression.ts
 *      (and again with API_GZIP=off)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import https from 'node:https';
import { gunzipSync } from 'node:zlib';

let PORT = 0;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
type Answer = { status: number; headers: Record<string, string | string[] | undefined>; bytes: Buffer };

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

/** One request as the node answers it: no Accept-Encoding but `headers`', nothing decoded. */
function ask(path: string, id: Id | null, headers: Record<string, string> = {}, method = 'GET'): Promise<Answer> {
    const h: Record<string, string> = { ...headers };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n`;
        h['X-Public-Key'] = id.pubKeyHex;
        h['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    return new Promise((resolve, reject) => {
        const req = https.request({ host: 'localhost', port: PORT, path, method, headers: h, agent: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

const varies = (a: Answer) => String(a.headers.vary ?? '').toLowerCase().split(',').map((s) => s.trim()).includes('accept-encoding');
const encoding = (a: Answer) => a.headers['content-encoding'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A real 1×1 PNG, then 8 KB of zeros: gzip would shrink it to almost nothing, so an encoded photo couldn't hide.
const PNG_PADDED = Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
    Buffer.alloc(8192),
]);

async function main() {
    console.log('/api answers are gzipped for a reader that asks...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const heavy = await import('./heavy-reads.js');
    const { apiGzipFromEnv } = await import('./api-compression.js');

    await initTls();
    se.initStateEngine();
    PORT = await startHttpsServer(0);

    const member = (callsign: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?)`).run(id.pubKeyHex, callsign, `INV-${callsign}`);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        setMemberPhoto(db as any, id.pubKeyHex, `data:image/png;base64,${PNG_PADDED.toString('base64')}`);
        return id;
    };
    const alice = member('alice');
    for (let i = 0; i < 40; i++) member(`neighbour${i}`);
    for (let i = 0; i < 60; i++) {
        se.createPost('offer', 'food', `Sourdough loaf ${i}`, `A loaf of sourdough, baked this morning, number ${i} of the batch.`, 5, 'fixed', alice.pubKeyHex)!;
    }

    const SYNC = '/api/marketplace/posts?sync=1';
    console.log('── 0. the operator\'s switch, API_GZIP ──');
    for (const [raw, on] of [['', true], [' on ', true], ['1', true], ['yes', true], ['off', false], ['OFF', false], [' off ', false], ['0', false], ['false', false], ['no', false], ['maybe', true]] as const) {
        assert(apiGzipFromEnv(raw) === on, `API_GZIP=${JSON.stringify(raw)} reads as ${on ? 'on' : 'off'}`);
    }
    if (process.env.API_GZIP === 'off') {
        await switchedOff(alice, SYNC);
        finish();
    }

    console.log('\n── 1. the listings sync read ──');
    const zipped = await ask(SYNC, alice, { 'Accept-Encoding': 'gzip, deflate, br' });
    const plain = await ask(SYNC, alice);
    assert(zipped.status === 200 && plain.status === 200, `both reads are 200 (got ${zipped.status}, ${plain.status})`);
    assert(encoding(zipped) === 'gzip', `asked with gzip, it is gzipped (Content-Encoding: ${encoding(zipped)})`);
    assert(encoding(plain) === undefined, `asked without, it is plain (Content-Encoding: ${encoding(plain)})`);
    assert(varies(zipped) && varies(plain), `both say Vary: Accept-Encoding (got "${zipped.headers.vary}", "${plain.headers.vary}")`);
    let unzipped: Buffer = Buffer.alloc(0);
    try { unzipped = gunzipSync(zipped.bytes); } catch { /* not gzip: the check below says so */ }
    assert(unzipped.length > 0 && unzipped.equals(plain.bytes), `gunzipped, it is the plain answer byte for byte (${unzipped.length} = ${plain.bytes.length} bytes)`);
    const listed = JSON.parse(plain.bytes.toString());
    const rows = Array.isArray(listed) ? listed : listed.posts;
    assert(Array.isArray(rows) && rows.length >= 40 && rows.every((p: any) => /^Sourdough loaf /.test(p.title)), `the plain answer is a page of the listings (${Array.isArray(rows) ? rows.length : typeof listed})`);
    assert(zipped.bytes.length * 3 < plain.bytes.length, `gzip is under a third of it (${zipped.bytes.length} of ${plain.bytes.length} bytes)`);
    assert(Number(zipped.headers['content-length']) === zipped.bytes.length, `the gzipped answer's Content-Length is its own (${zipped.headers['content-length']})`);
    const tagZipped = String(zipped.headers.etag ?? '');
    const tagPlain = String(plain.headers.etag ?? '');
    assert(tagZipped.startsWith('W/"') && tagPlain !== '', `the gzipped answer's ETag is weak (${tagZipped}; plain ${tagPlain})`);
    const off = await ask(SYNC, alice, { 'Accept-Encoding': 'gzip;q=0, identity' });
    assert(off.status === 200 && encoding(off) === undefined && varies(off), `gzip;q=0 is answered plain, with Vary (${encoding(off)})`);

    console.log('\n── 2. 304 with either ETag, asked either way ──');
    for (const [tagName, tag] of [['gzipped', tagZipped], ['plain', tagPlain]] as const) {
        for (const [how, enc] of [['with gzip', { 'Accept-Encoding': 'gzip' }], ['without', {}]] as const) {
            const again = await ask(SYNC, alice, { ...enc, 'If-None-Match': tag });
            assert(again.status === 304 && again.bytes.length === 0 && encoding(again) === undefined,
                `the ${tagName} answer's ETag, asked ${how}: 304, no body, no encoding (got ${again.status}, ${again.bytes.length} bytes, ${encoding(again)})`);
        }
    }

    console.log('\n── 3. the shared directory snapshot is gzipped once ──');
    const dirZipped = await ask('/api/members', alice, { 'Accept-Encoding': 'gzip' });
    const dirPlain = await ask('/api/members', alice);
    assert(dirZipped.status === 200 && dirPlain.status === 200, `both directory reads are 200 (got ${dirZipped.status}, ${dirPlain.status})`);
    assert(encoding(dirZipped) === 'gzip', `the snapshot says one gzip, not two (Content-Encoding: ${encoding(dirZipped)})`);
    let dirOnce: Buffer = Buffer.alloc(0);
    try { dirOnce = gunzipSync(dirZipped.bytes); } catch { /* the check below says so */ }
    assert(dirOnce.equals(dirPlain.bytes) && dirOnce[0] !== 0x1f, `gunzipped once, it is the plain directory, not more gzip (${dirOnce.length} = ${dirPlain.bytes.length} bytes)`);
    assert(varies(dirZipped), 'the snapshot says Vary: Accept-Encoding');

    console.log('\n── 4. a heavy read built per reader keeps its bytes and the cap its accounting ──');
    const web = await ask('/api/community/members', alice, { 'Accept-Encoding': 'gzip' });
    await sleep(100); // the cap learns the size on 'finish'
    assert(web.status === 200 && web.bytes.length > 1024, `the web app's directory is 200, over the floor (${web.status}, ${web.bytes.length} bytes)`);
    assert(encoding(web) === undefined, `it is sent plain under the heavy-read cap (Content-Encoding: ${encoding(web)})`);
    const learned = heavy.heavyReadWeight('community-members');
    assert(learned === web.bytes.length, `the cap learned its raw size, as before (${learned} = ${web.bytes.length})`);

    console.log('\n── 5. a photo goes out as stored ──');
    const photo = await ask(`/api/avatar/${alice.pubKeyHex}`, null, { 'Accept-Encoding': 'gzip' });
    assert(photo.status === 200 && String(photo.headers['content-type']).startsWith('image/'), `the photo is 200, an image (${photo.status}, ${photo.headers['content-type']})`);
    assert(encoding(photo) === undefined && photo.bytes.equals(PNG_PADDED), `its bytes are the stored ones, not encoded (${photo.bytes.length} = ${PNG_PADDED.length}, ${encoding(photo)})`);

    console.log('\n── 6. HEAD, a range and a small answer are never encoded ──');
    const head = await ask(SYNC, alice, { 'Accept-Encoding': 'gzip' }, 'HEAD');
    assert(head.status === 200 && encoding(head) === undefined, `HEAD: ${head.status}, no encoding (${encoding(head)})`);
    const ranged = await ask(SYNC, alice, { 'Accept-Encoding': 'gzip', Range: 'bytes=0-99' });
    assert(encoding(ranged) === undefined, `a range request is not encoded (${ranged.status}, ${encoding(ranged)})`);
    const small = await ask('/api/community/info', null, { 'Accept-Encoding': 'gzip' });
    assert(small.status === 200 && small.bytes.length < 1024 && encoding(small) === undefined,
        `a small answer stays plain (${small.status}, ${small.bytes.length} bytes, ${encoding(small)})`);

    finish();
}

/** API_GZIP=off (the variant run): the middleware isn't there, so every answer is the route's own, as before #1764. */
async function switchedOff(alice: Id, SYNC: string): Promise<void> {
    console.log('\n── API_GZIP=off: answers go out as the routes made them ──');
    for (const path of [SYNC, '/api/activity/feed', '/api/home']) {
        const zipped = await ask(path, alice, { 'Accept-Encoding': 'gzip, deflate, br' });
        const plain = await ask(path, alice);
        assert(zipped.status === 200 && plain.status === 200 && zipped.bytes.length > 1024,
            `${path}: both reads 200, over the floor (got ${zipped.status}, ${plain.status}; ${zipped.bytes.length} bytes)`);
        // Home's answer says when it was made (generatedAt), so two reads match as JSON without it; the others byte for byte.
        const same = path === '/api/home'
            ? withoutGeneratedAt(zipped.bytes) === withoutGeneratedAt(plain.bytes)
            : zipped.bytes.equals(plain.bytes);
        assert(encoding(zipped) === undefined && same,
            `${path}: asked with gzip, it is the plain answer (Content-Encoding: ${encoding(zipped)}; ${zipped.bytes.length} and ${plain.bytes.length} bytes)`);
        assert(!varies(zipped) && !varies(plain), `${path}: no Vary: Accept-Encoding (got "${zipped.headers.vary}", "${plain.headers.vary}")`);
        assert(zipped.headers.etag === plain.headers.etag, `${path}: the route's own ETag, not made weak (${zipped.headers.etag} = ${plain.headers.etag})`);
    }
    // The shared snapshots' gzip copy is the route's, made once for every reader: the switch leaves it.
    const dir = await ask('/api/members', alice, { 'Accept-Encoding': 'gzip' });
    assert(dir.status === 200 && encoding(dir) === 'gzip' && dir.bytes[0] === 0x1f,
        `the directory snapshot still sends its own gzip copy (${dir.status}, Content-Encoding: ${encoding(dir)})`);
}

function withoutGeneratedAt(bytes: Buffer): string {
    try { const { generatedAt: _, ...rest } = JSON.parse(bytes.toString()); return JSON.stringify(rest); } catch { return 'not JSON'; }
}

function finish(): never {
    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
