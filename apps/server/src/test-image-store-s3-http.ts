/**
 * Test Suite: a node with IMAGE_STORE=s3, through the real HTTP stack, end to end.
 *
 * The bucket is an in-process stand-in (fake-s3-test-harness.ts) on loopback that checks every SigV4
 * signature; no real bucket and no BeanPool node is contacted. Restores run in a fresh-server child process,
 * as test-sealed-backups does, because a restore closes the database and restarts.
 *
 * Verifies:
 *   1. The boot check passes a good configuration.
 *   2. A new post's photo goes to the bucket — not the database, not the local disk — and is served on the
 *      same URL with the same bytes, type and immutable caching; the row is read first.
 *   3. A replaced photo takes a new key and the old object leaves the bucket after the commit; a removed
 *      photo 404s; a row gone while its object remains 404s; an object gone while its row remains is a 503.
 *   4. A message attachment's ciphertext goes to the bucket and comes back exactly.
 *   5. The sync export rebuilds each photo from the bucket byte for byte, and omits (and names) one it
 *      cannot read, so a replica keeps its own copy.
 *   6. The orphan sweep judges the BUCKET: an aged orphan goes, a fresh one and a referenced one stay, and an
 *      object outside this node's namespaces is never touched.
 *   7. A backup says the photos are in the bucket (`X-Backup-Images: in-bucket`), carries no `images/`,
 *      carries `images-in-bucket.json` naming the bucket, lists what the bucket was missing, and holds no
 *      secret anywhere in the archive.
 *   8. A snapshot is the database only, and its download carries the same label.
 *   9. The harvester keeps that label beside its copy, and the manager's download of the copy repeats it.
 *  10. Restore: an s3 backup onto an s3 node comes back complete, measured against the bucket; a short one
 *      says which; onto a DISK node it says plainly that the photos stay in the bucket; and a disk backup
 *      carrying images/ is REFUSED by an s3 node before anything is touched.
 *  11. The secret access key appears in no log line of this process or of any child.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-image-store-s3-http.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeS3, type FakeS3 } from './fake-s3-test-harness.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}

const captured: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    (console as any)[level] = (...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 6 }))).join(' '));
        original(...args);
    };
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** A photo-sized, incompressible, deterministic body behind a real JPEG header. */
function makePhoto(seed: string): Buffer {
    const block = crypto.createHash('sha512').update(seed).digest();
    const filler = Buffer.alloc(24 * 1024);
    for (let i = 0; i < filler.length; i += block.length) block.copy(filler, i);
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), filler, Buffer.from([0xff, 0xd9])]);
}
const dataUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString('base64')}`;

function listFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string, rel: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(d, e.name), r);
            else if (e.isFile()) out.push(r);
        }
    };
    walk(dir, '');
    return out.sort();
}

function untar(file: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-backup-x-'));
    execFileSync('tar', ['-xzf', file, '-C', dir]);
    return dir;
}

// ── The fresh server (child process) ───────────────────────────────────────────────────────

async function child(): Promise<void> {
    const [, , , mode, file] = process.argv;
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    const { initStateEngine } = await import('./state-engine.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { checkImageStoreAtBoot } = await import('./storage/image-store.js');
    const { db } = await import('./db/db.js');

    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const pw = 'Fresh-S3-Server-Pw-551!';
    const { hash, salt } = hashPassword(pw);
    updateLocalConfig({ adminHash: hash, salt });
    const boot = await checkImageStoreAtBoot({ role: 'primary', dataDir });
    const membersBefore = (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c;

    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { setRestoreRestartForTests } = await import('./routes/backup.js');
    setRestoreRestartForTests(() => { /* the test inspects the data dir instead of restarting */ });
    await initTls();
    const port = await startHttpsServer(0);
    resetAdminAuthTarpit();
    const res = await fetch(`https://localhost:${port}/api/local/admin/restore`, {
        method: 'POST',
        headers: { 'X-Admin-Password': pw, 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(fs.readFileSync(file)),
    });
    const body = await res.json();

    let marker = false;
    let dbStillOpen: boolean | null = null;
    if (res.status === 200) {
        const Database = (await import('better-sqlite3')).default;
        const restored = new Database(path.join(dataDir, 'state.db'), { readonly: true });
        marker = !!restored.prepare("SELECT 1 FROM members WHERE callsign = 'S3RoundTripMarker'").get();
        restored.close();
    } else {
        // Refused: the live database must be exactly as it was, and still open.
        try {
            dbStillOpen = (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c === membersBefore;
            marker = !!db.prepare("SELECT 1 FROM members WHERE callsign = 'S3RoundTripMarker'").get();
        } catch { dbStillOpen = false; }
    }
    console.log('CHILD_RESULT ' + JSON.stringify({
        status: res.status, body, boot, marker, dbStillOpen, localImages: listFiles(path.join(dataDir, 'images')),
    }));
    process.exit(0);
}

function runChild(mode: 's3' | 'disk', file: string, fake: FakeS3): { result: any; output: string } {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-restore-fresh-'));
    const env: Record<string, string> = { ...process.env as Record<string, string>, BEANPOOL_DATA_DIR: freshDir };
    for (const k of Object.keys(fake.env())) delete env[k];
    if (mode === 's3') Object.assign(env, fake.env());
    try {
        // spawnSync blocks this thread; the stand-in bucket runs on its own worker thread and keeps answering.
        const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--child', mode, file], {
            env, encoding: 'utf-8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
        });
        const output = `${r.stdout || ''}\n${r.stderr || ''}`;
        const line = (r.stdout || '').split('\n').find((l) => l.startsWith('CHILD_RESULT '));
        if (!line) {
            console.error(r.stdout?.slice(-3000), r.stderr?.slice(-3000));
            throw new Error(`the fresh-server child printed no result (exit ${r.status})`);
        }
        return { result: JSON.parse(line.slice('CHILD_RESULT '.length)), output };
    } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
    }
}

// ── The s3 node (this process) ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 's3-http-'));
    const fake = await startFakeS3();
    Object.assign(process.env, fake.env());
    const childOutputs: string[] = [];

    const { initTls } = await import('./services/tls.js');
    const { db } = await import('./db/db.js');
    const { initStateEngine, createPost, updatePost, exportSyncState, createConversation } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { getImageStore, checkImageStoreAtBoot, imagesDir } = await import('./storage/image-store.js');
    const { getStorageCleanPreview, sweepOrphanedImageObjects } = await import('./engine/storage-health.js');
    const { createSnapshot, snapshotImagesDir, SNAPSHOTS_DIR } = await import('./services/snapshot-scheduler.js');
    const { pullBackupForNode, inBucketLabelFor, imagesDirFor } = await import('./services/harvester.js');
    const { writeDbSnapshot } = await import('./services/snapshot-scheduler.js');

    await initTls();
    initStateEngine();
    await ensureGenesis();
    const pw = 'S3-Node-Admin-Pw-773!';
    const { hash, salt } = hashPassword(pw);
    updateLocalConfig({ adminHash: hash, salt });

    // ── 1. boot ────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 1. Boot ---');
    const bootLine = await checkImageStoreAtBoot({ role: 'primary', dataDir });
    assert(bootLine.includes(fake.bucket), `the boot check passes and names the bucket: "${bootLine}"`);
    const store = getImageStore();
    assert(store.kind === 's3', 'the node\'s image store is the S3 store');
    const port = await startHttpsServer(0);
    const BASE = `https://localhost:${port}`;
    const adminFetch = async (p: string, init: RequestInit = {}) => {
        resetAdminAuthTarpit();
        return fetch(`${BASE}${p}`, { ...init, headers: { 'X-Admin-Password': pw, ...(init.headers as any || {}) } });
    };

    // ── 2. a photo in, and out ─────────────────────────────────────────────────────────────────
    console.log('\n--- 2. A photo goes to the bucket and is served from it ---');
    const author = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, avatar_url) VALUES (?, 'S3RoundTripMarker', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`)
        .run(author, dataUrl(makePhoto('avatar')));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(author);
    const photoA = makePhoto('a');
    const photoB = makePhoto('b');
    const post = createPost('offer', 'food', 'Sourdough', 'Baked this morning', 3, 'fixed', author, undefined, undefined,
        [dataUrl(photoA), dataUrl(photoB)], true);
    if (!post) throw new Error('setup: the post was not created');
    const rowA = db.prepare('SELECT * FROM post_photos WHERE post_id = ? AND order_num = 0').get(post.id) as any;
    const rowB = db.prepare('SELECT * FROM post_photos WHERE post_id = ? AND order_num = 1').get(post.id) as any;
    assert(rowA.photo_data === null && rowA.storage_key?.startsWith(`posts/${post.id}/`) && rowA.sha256 === sha(photoA),
        'the row keeps the key and the hash, not the bytes');
    let bucket = await fake.objects();
    assert(bucket.get(rowA.storage_key)?.bytes.equals(photoA) === true && bucket.get(rowB.storage_key)?.bytes.equals(photoB) === true,
        'the bucket holds exactly the photo bytes');
    assert(listFiles(imagesDir(dataDir)).length === 0, 'and nothing was written to the node\'s own disk');

    const urlA = `${BASE}/api/marketplace/posts/${post.id}/photos/0`;
    const resA = await fetch(urlA);
    const servedA = Buffer.from(await resA.arrayBuffer());
    assert(resA.status === 200 && servedA.equals(photoA), 'the photo URL serves the exact bytes, streamed from the bucket');
    assert(resA.headers.get('content-type') === 'image/jpeg', 'with the content type the row recorded');
    assert(/immutable/.test(resA.headers.get('cache-control') || ''), 'and the same immutable caching');
    assert(Number(resA.headers.get('content-length')) === photoA.length, 'with its length');
    assert((await fetch(`${BASE}/api/marketplace/posts/no-such-post/photos/0`)).status === 404, 'a photo with no row is a 404');

    // ── 3. replace, remove, and the row-first rule ─────────────────────────────────────────────
    console.log('\n--- 3. Replace, remove, and the row first ---');
    const photoC = makePhoto('c');
    const keptUrl = `${BASE}/api/marketplace/posts/${post.id}/photos/1`;
    updatePost(post.id, author, { photos: [dataUrl(photoC), keptUrl] } as any);
    const rowC = db.prepare('SELECT * FROM post_photos WHERE post_id = ? AND order_num = 0').get(post.id) as any;
    const rowB2 = db.prepare('SELECT * FROM post_photos WHERE post_id = ? AND order_num = 1').get(post.id) as any;
    bucket = await fake.objects();
    assert(rowC.storage_key !== rowA.storage_key && bucket.get(rowC.storage_key)?.bytes.equals(photoC) === true,
        'an edited photo takes a new key and its bytes are in the bucket');
    assert(!bucket.has(rowA.storage_key), 'the object it replaced left the bucket after the commit');
    assert(rowB2.storage_key === rowB.storage_key && bucket.has(rowB.storage_key),
        'the photo the client kept (by URL, read back from the bucket) is unchanged and still there');

    // A second post, used for the remove path.
    const photoD = makePhoto('d');
    const post2 = createPost('offer', 'food', 'Jam', 'Plum', 2, 'fixed', author, undefined, undefined, [dataUrl(photoD)], true)!;
    const rowD = db.prepare('SELECT * FROM post_photos WHERE post_id = ? AND order_num = 0').get(post2.id) as any;
    updatePost(post2.id, author, { photos: [] } as any);
    assert(!(await fake.objects()).has(rowD.storage_key), 'removing a post\'s last photo removes its object from the bucket');
    assert((await fetch(`${BASE}/api/marketplace/posts/${post2.id}/photos/0`)).status === 404, 'and its URL is a 404');

    // The row decides, never the bucket: a row gone while its object lingers is never served.
    const photoE = makePhoto('e');
    const post3 = createPost('offer', 'food', 'Eggs', 'A dozen', 2, 'fixed', author, undefined, undefined, [dataUrl(photoE)], true)!;
    const rowE = db.prepare('SELECT * FROM post_photos WHERE post_id = ? AND order_num = 0').get(post3.id) as any;
    db.prepare('DELETE FROM post_photos WHERE post_id = ?').run(post3.id);
    assert((await fake.objects()).has(rowE.storage_key), 'setup: the object is still in the bucket with its row gone');
    assert((await fetch(`${BASE}/api/marketplace/posts/${post3.id}/photos/0`)).status === 404,
        'a photo whose row is gone is a 404 even though the bucket still has it');

    // ── 4. an attachment ───────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. An attachment ---');
    const bob = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, 'Bob', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(bob);
    const conv = createConversation('dm', [author, bob], author);
    if (!conv) throw new Error('setup: no conversation');
    const { sendMessage } = await import('./state-engine.js');
    const cipher = crypto.randomBytes(900).toString('base64');
    const msg = sendMessage(conv.id, author, 'encrypted-text', 'text-nonce', 'image', { data: cipher, nonce: 'att-nonce', mime: 'image/png' })!;
    const attRow = db.prepare('SELECT * FROM message_attachments WHERE message_id = ?').get(msg?.id) as any;
    assert(!!attRow && attRow.data === null && attRow.storage_key === `attachments/${msg.id}.bin`,
        'an attachment\'s ciphertext leaves the row for the bucket');
    assert((await fake.objects()).get(attRow.storage_key)?.bytes.toString('base64') === cipher, 'the bucket holds the ciphertext exactly');
    const attRes = await fetch(`${BASE}/api/messages/${msg.id}/attachment`);
    const attJson = await attRes.json() as any;
    assert(attRes.status === 200 && attJson.data === cipher && attJson.nonce === 'att-nonce' && attJson.mime === 'image/png',
        'the attachment route returns the ciphertext, nonce and mime unchanged');

    // ── 5. the sync export ─────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. The sync export ---');
    {
        const exported = await exportSyncState('test-node') as any;
        const expC = exported.photos.find((p: any) => p.post_id === post.id && p.order_num === 0);
        const expB = exported.photos.find((p: any) => p.post_id === post.id && p.order_num === 1);
        assert(expC?.photo_data === dataUrl(photoC) && expB?.photo_data === dataUrl(photoB),
            'each photo is rebuilt from the bucket into exactly the data URL a peer has always received');
        assert(!('storage_key' in (expC || {})) && !('sha256' in (expC || {})), 'the payload carries no store columns');
        // Lose an object behind the node's back.
        await fake.remove(rowB.storage_key);
        const degraded = await exportSyncState('test-node') as any;
        assert(!degraded.photos.some((p: any) => p.post_id === post.id && p.order_num === 1)
            && degraded.photosOmitted?.includes(`${post.id}|1`),
            'a photo the bucket no longer has is omitted and named, so a replica keeps its own copy');
        assert((await fetch(keptUrl)).status === 503, 'and its URL is a 503 — the row says it exists and the bucket does not have it');
    }

    // ── 6. the orphan sweep, on the bucket ─────────────────────────────────────────────────────
    console.log('\n--- 6. The orphan sweep judges the bucket ---');
    {
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        await fake.seed('posts/orphan-post/0-0a0a0a0a.jpg', makePhoto('orphan-old'), 'image/jpeg', twoHoursAgo);
        await fake.seed('posts/orphan-post/1-0b0b0b0b.jpg', makePhoto('orphan-new'), 'image/jpeg');
        await fake.seed('backups/not-ours.tar.gz', makePhoto('not ours'), 'application/gzip', twoHoursAgo);
        await fake.setMtime(rowE.storage_key, twoHoursAgo); // rowless since section 3, now aged too
        const preview = getStorageCleanPreview();
        assert(preview.orphanedImageObjects.count === 2,
            `the preview counts the two aged orphans in the bucket and nothing else (got ${preview.orphanedImageObjects.count})`);
        const swept = sweepOrphanedImageObjects();
        const after = await fake.objects();
        assert(swept.removed === 2 && !after.has('posts/orphan-post/0-0a0a0a0a.jpg') && !after.has(rowE.storage_key),
            'the sweep removed both aged orphans from the bucket');
        assert(after.has('posts/orphan-post/1-0b0b0b0b.jpg'), 'a fresh orphan (a photo being written right now) is left alone');
        assert(after.has(rowC.storage_key) && after.has(attRow.storage_key), 'referenced objects are left alone');
        assert(after.has('backups/not-ours.tar.gz'), 'an object outside this node\'s namespaces is never touched');
    }

    // ── 7. a backup ────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 7. A backup from an s3 node ---');
    const takeBackup = async (label: string) => {
        const res = await adminFetch('/api/local/admin/backup', { method: 'POST' });
        const file = path.join(work, `${label}.tar.gz`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        return { res, file };
    };
    // Put the lost object back first, so the first backup is whole.
    await fake.seed(rowB.storage_key, photoB, 'image/jpeg');
    const whole = await takeBackup('whole');
    const referenced = (db.prepare('SELECT COUNT(*) AS c FROM post_photos WHERE storage_key IS NOT NULL').get() as any).c
        + (db.prepare('SELECT COUNT(*) AS c FROM message_attachments WHERE storage_key IS NOT NULL').get() as any).c;
    {
        const h = whole.res.headers;
        assert(whole.res.status === 200, 'the backup is a 200');
        assert(h.get('x-backup-contents') === 'database+images-in-bucket' && h.get('x-backup-images') === 'in-bucket',
            'labelled database+images-in-bucket, X-Backup-Images: in-bucket — not a count of objects in the file');
        assert(h.get('x-backup-images-bucket') === fake.bucket && h.get('x-backup-images-referenced') === String(referenced),
            `naming the bucket and the ${referenced} object(s) its database references`);
        assert(h.get('x-backup-images-checked') === 'yes' && !h.get('x-backup-missing-images'), 'checked against the bucket, nothing missing');
        const x = untar(whole.file);
        const members = listFiles(x);
        assert(members.includes('state.db') && !members.some((m) => m.startsWith('images/')),
            'the archive holds the database and no images/ at all');
        const label = JSON.parse(fs.readFileSync(path.join(x, 'images-in-bucket.json'), 'utf8'));
        assert(label.bucket === fake.bucket && label.endpoint === fake.endpoint && label.referenced === referenced && label.checked === true,
            'images-in-bucket.json names the bucket and the endpoint and says it was checked');
        assert(/NOT in this file/.test(label.note), 'and says in words that the photos are not in the file');
        assert(!members.includes('missing-images.json'), 'a whole backup carries no missing-images manifest');
        const raw = zlibGunzip(fs.readFileSync(whole.file));
        assert(!raw.includes(Buffer.from(fake.secretAccessKey)) && !raw.includes(Buffer.from(fake.accessKeyId)),
            'no credential appears anywhere in the archive');
        fs.rmSync(x, { recursive: true, force: true });
    }
    await fake.remove(rowB.storage_key);
    const short = await takeBackup('short');
    {
        const h = short.res.headers;
        assert(short.res.status === 200 && h.get('x-backup-images') === 'in-bucket' && h.get('x-backup-missing-images') === '1',
            'a key the bucket does not hold makes the backup SHORT by one — still a 200, and counted');
        const x = untar(short.file);
        const manifest = JSON.parse(fs.readFileSync(path.join(x, 'missing-images.json'), 'utf8'));
        assert(manifest.missing.length === 1 && manifest.missing[0] === rowB.storage_key, 'missing-images.json names the missing key');
        fs.rmSync(x, { recursive: true, force: true });
    }

    // ── 8. a snapshot ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. A snapshot ---');
    {
        const snap = createSnapshot();
        const snapPath = path.join(SNAPSHOTS_DIR, snap.name);
        assert(fs.existsSync(snapPath) && !fs.existsSync(snapshotImagesDir(snapPath)),
            'an s3 node\'s snapshot is the database only — nothing captured beside it');
        const res = await adminFetch(`/api/local/admin/snapshots/download?name=${encodeURIComponent(snap.name)}`);
        await res.arrayBuffer();
        assert(res.status === 200 && res.headers.get('x-backup-images') === 'in-bucket' && res.headers.get('x-backup-missing-images') === '1',
            'its download carries the in-bucket label and the bucket\'s shortfall');
    }

    // ── 9. the harvester and the manager ───────────────────────────────────────────────────────
    console.log('\n--- 9. The harvester\'s kept copy and the manager\'s download of it ---');
    {
        const node = { id: 'local-node', name: 'S3 node', url: BASE, adminPassword: pw };
        resetAdminAuthTarpit();
        const pulled = await pullBackupForNode(node as any);
        assert(pulled.kind === 'plain', 'the harvester pulled a readable backup from the s3 node');
        const kept = path.join(dataDir, 'backups', 'local-node', 'state.db');
        assert(fs.existsSync(kept) && fs.existsSync(inBucketLabelFor(kept)), 'it kept the database AND the in-bucket label beside it');
        assert(listFiles(imagesDirFor(kept)).length === 0, 'with no images beside it, by design');
        const res = await adminFetch('/api/manager/backups/download-db?nodeId=local-node');
        const file = path.join(work, 'manager-copy.tar.gz');
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        assert(res.status === 200 && res.headers.get('x-backup-images') === 'in-bucket'
            && res.headers.get('x-backup-contents') === 'database+images-in-bucket',
            'the manager\'s download of the kept copy says the photos are in the bucket — not "short by every photo"');
        const x = untar(file);
        assert(fs.existsSync(path.join(x, 'images-in-bucket.json')), 'and the archive it serves carries the label');
        fs.rmSync(x, { recursive: true, force: true });
    }

    // ── 10. restore ────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 10. Restore ---');
    await fake.seed(rowB.storage_key, photoB, 'image/jpeg'); // the bucket is whole again for the whole backup
    {
        const { result, output } = runChild('s3', whole.file, fake);
        childOutputs.push(output);
        assert(result.status === 200 && result.body.success === true && result.marker === true, 's3 → s3: the database is restored');
        assert(result.body.complete === true && result.body.images.missing === 0 && result.body.images.referenced === referenced,
            `complete: every one of the ${referenced} key(s) was found in the bucket (measured, not read off the label)`);
        assert(result.body.images.store?.kind === 's3' && result.body.images.inBucket?.bucket === fake.bucket,
            'the answer says where the photos are');
        assert(result.localImages.length === 0, 'nothing was laid on the s3 node\'s own disk');
    }
    await fake.remove(rowB.storage_key);
    {
        const { result, output } = runChild('s3', short.file, fake);
        childOutputs.push(output);
        assert(result.status === 200 && result.body.complete === false && result.body.images.missing === 1,
            's3 → s3, with a key the bucket lacks: not complete, short by exactly one');
        assert(new RegExp(`1 of the ${referenced} it references are not in s3 bucket "${fake.bucket}"`).test(result.body.warning || ''),
            `and the warning says so: "${result.body.warning}"`);
    }
    {
        const { result, output } = runChild('disk', whole.file, fake);
        childOutputs.push(output);
        assert(result.status === 200 && result.body.success === true && result.marker === true, 's3 backup → DISK node: the database is restored');
        assert(result.body.complete === false, 'but it is not called complete');
        assert(new RegExp(`not in this file: they stay in the S3 bucket "${fake.bucket}"`).test(result.body.warning || ''),
            `and the answer says plainly the photos stay in the bucket: "${result.body.warning}"`);
        assert(result.body.images.inBucket?.bucket === fake.bucket && result.body.images.store?.kind === 'disk',
            'naming the bucket, and that this node keeps photos on disk');
    }
    {
        // A backup from a DISK node, with its photos inside it, offered to an s3 node.
        const stage = path.join(work, 'disk-backup');
        fs.mkdirSync(path.join(stage, 'images', 'posts', 'disk-post'), { recursive: true });
        writeDbSnapshot(path.join(stage, 'state.db'));
        fs.writeFileSync(path.join(stage, 'images', 'posts', 'disk-post', '0-12345678.jpg'), makePhoto('disk'));
        const diskFile = path.join(work, 'disk-backup.tar.gz');
        execFileSync('tar', ['-czf', diskFile, '-C', stage, '.']);
        const { result, output } = runChild('s3', diskFile, fake);
        childOutputs.push(output);
        assert(result.status === 409, `a disk backup carrying images/ is refused by an s3 node (HTTP ${result.status})`);
        assert(/carries its photos and attachments inside it.*migration tool.*Nothing was changed/.test(result.body.error || ''),
            `with a message that says why and what to do: "${result.body.error}"`);
        assert(result.dbStillOpen === true && result.marker === false, 'and the node\'s own database was not touched');
        assert(result.localImages.length === 0, 'nor its disk');
    }

    // ── 11. no secret anywhere ─────────────────────────────────────────────────────────────────
    console.log('\n--- 11. The secret is never printed ---');
    {
        const everything = captured.join('\n') + '\n' + childOutputs.join('\n');
        assert(captured.length > 20 && childOutputs.length === 4, `checked ${captured.length} line(s) here and 4 child logs`);
        assert(!everything.includes(fake.secretAccessKey), 'the secret access key appears in no log line of this node or of any child');
    }

    await fake.stop();
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ S3 image store HTTP tests PASSED.');
    process.exit(0);
}

function zlibGunzip(b: Buffer): Buffer {
    return zlib.gunzipSync(b);
}

if (process.argv[2] === '--child') {
    child().catch((e) => { console.error('child crashed:', e); process.exit(1); });
} else {
    main().catch((e) => { console.error('Suite crashed:', e); process.exit(1); });
}
