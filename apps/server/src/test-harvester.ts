/**
 * Harvester service unit/integration test.
 *
 * Tests node slug generation, fleet node config load/save persistence,
 * and harvest state load/save in isolated temporary data directory.
 * Then harvests a real (in-process, local HTTP) node (sealed keys slice 3, sealed-keys.md §6.3–6.4, seal review
 * round 1: never produce a backup that no shipped tool can open):
 * - no recovery code (no owner; then an owner) → the node sends its readable backup, the harvester keeps it as it
 *   always did (state.db + history/), the status says "not locked yet", and the seal-old pass deletes NOTHING;
 *   locking to owners only is refused outright, touching nothing;
 * - a recovery code but no pinned node key, or a pin that does not match → nothing deleted, and why;
 * - a seal that fails → the readable originals stay;
 * - a recovery code and a pin → the node's backup is stored locked, the code opens it, and the seal-old pass locks
 *   every readable file, deleting each only after its locked copy was read back and opened (sealFileVerified
 *   refuses a tar without state.db, and anything without a code stanza);
 * - a failing node is backed off, not pulled every minute; an old node's readable archive is kept, pulled once.
 * - a readable backup is kept WHOLE at every hop (round 3): the `images/` the archive carries survives the pull,
 *   the daily copy (hard-linked), the seal-old envelope and the fleet manager's two downloads, and what comes
 *   back out is byte-identical to what the node sent. A SHORT backup's `missing-images.json` rides along with
 *   it, because the manifest's presence is the label that outlives the response headers.
 * - a node refusing every backup because an object it references is gone from its image store: refused three
 *   times running, then pulled with allowMissing, so the node ends up with a labelled short backup instead of
 *   none at all — and a node that answers normally never gets the opt-in.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-harvester.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromString, peerIdFromPrivateKey } from '@libp2p/peer-id';
import { ed25519 } from '@noble/curves/ed25519.js';
import { openEnvelope, readSealedHeader, verifySealedHeader, sealEnvelope } from '@beanpool/core';
import {
    nodeSlug, getNodes, saveNodes, loadHarvestState, harvestNode, listSealedBackups, sealOldBackups, backoffDelayMs,
    ALLOW_MISSING_AFTER_FAILURES, listPlainHistory, imagesDirFor, missingManifestFor,
    type FleetNodeConfig,
} from './services/harvester.js';
import { sealFileVerified, MISSING_MEMBER } from './services/sealed-backup.js';
import { createManagerBackupsRoutes } from './routes/manager-backups.js';
import { attachmentKey, getImageStore, postPhotoKey, sha256Hex } from './storage/image-store.js';
import { ensureGenesis } from './genesis.js';
import { makeRecoveryCode } from './services/takeover-envelope.js';
import { initStateEngine, seedGenesisMember, createPost } from './state-engine.js';
import { db } from './db/db.js';
import { createBackupRoutes } from './routes/backup.js';
import { hashPassword, updateLocalConfig, setReplicationToken, getLocalConfig } from './config/local-config.js';
import { checkAdminAuth, resetAdminAuthTarpit } from './admin-auth.js';
import type { RouteDeps } from './routes/types.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

const NOT_LOCKED = 'Backups are not locked yet: make a recovery code to lock them.';

/** Every file under a folder, with a hash of its bytes: to prove nothing was touched. */
function snapshotTree(dir: string, skip?: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (skip && p === skip) continue;
            if (fs.lstatSync(p).isDirectory()) walk(p);
            else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        }
    };
    walk(dir);
    return out;
}

function tarOf(files: Record<string, Buffer>): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-tar-'));
    const stage = path.join(d, 'stage');
    fs.mkdirSync(stage);
    for (const [name, bytes] of Object.entries(files)) {
        // Nested members, because a backup's `images/` is a tree: `images/posts/<id>/<n>-<sha8>.jpg`.
        const full = path.join(stage, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, bytes);
    }
    const out = path.join(d, 'x.tar.gz');
    execFileSync('tar', ['-czf', out, '-C', stage, '.']);
    return out;
}

/** Every file under a directory, relative path → bytes. For comparing an image tree hop by hop. */
function treeOf(dir: string): Record<string, Buffer> {
    const out: Record<string, Buffer> = {};
    const walk = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (fs.lstatSync(p).isDirectory()) walk(p);
            else out[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p);
        }
    };
    walk(dir);
    return out;
}

/** Two image trees hold the same keys and the same bytes under each. */
function sameTree(a: Record<string, Buffer>, b: Record<string, Buffer>): boolean {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length === 0 || ka.join('|') !== kb.join('|')) return false;
    return ka.every(k => a[k].equals(b[k]));
}

/** Extract a backup tar into a fresh directory and hand back its path. */
function openArchive(bytes: Buffer, tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harvest-${tag}-`));
    const file = path.join(dir, 'x.tar.gz');
    fs.writeFileSync(file, bytes);
    execFileSync('tar', ['-xzf', file, '-C', dir]);
    fs.rmSync(file);
    return dir;
}

/** Harvest a node served in-process over local HTTP, the way the harvester reaches a real one. */
async function harvestLocalNode(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    initStateEngine();
    const PW = 'HarvesterAdmin123!';
    const TOKEN = 'harvester-test-token-0123456789abcdef';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    setReplicationToken(TOKEN);
    await ensureGenesis();

    // Give the real node images, so every readable backup this suite pulls from it is an archive with a real
    // `images/` member — which is what the seal-old pass has to carry into its envelope. Rows straight in:
    // `referencedStorageKeys` reads exactly these two tables, and it is the keys that drive the staging.
    const store = getImageStore();
    const localPostId = 'post-' + crypto.randomBytes(6).toString('hex');
    const localMsgId = 'msg-' + crypto.randomBytes(6).toString('hex');
    const localPhoto = crypto.randomBytes(3500);
    const localCipher = crypto.randomBytes(1200);
    const photoStored = store.put(postPhotoKey(localPostId, 0, sha256Hex(localPhoto), 'image/jpeg'), localPhoto, { mime: 'image/jpeg' });
    const cipherStored = store.put(attachmentKey(localMsgId), localCipher, { mime: 'application/octet-stream' });
    db.prepare('INSERT INTO post_photos (post_id, order_num, photo_data, storage_key, sha256, bytes, mime) VALUES (?, 0, NULL, ?, ?, ?, ?)')
        .run(localPostId, photoStored.key, photoStored.sha256, photoStored.bytes, photoStored.mime);
    db.prepare('INSERT INTO message_attachments (message_id, data, nonce, mime, storage_key) VALUES (?, NULL, ?, ?, ?)')
        .run(localMsgId, crypto.randomBytes(24).toString('base64'), 'image/jpeg', cipherStored.key);
    const localImages: Record<string, Buffer> = { [photoStored.key]: localPhoto, [cipherStored.key]: localCipher };

    const nodeKeyBytes = privateKeyToProtobuf(await generateKeyPair('Ed25519'));
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), nodeKeyBytes);

    const deps: RouteDeps = {
        checkAdminAuth: async (ctx: any) => checkAdminAuth(ctx),
        rateLimit: () => true,
        clampLimit: (_v: unknown, def = 20) => def,
        clampOffset: () => 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    };
    // Two stand-in nodes beside the real one: an old node (a BeanPool older than locked backups: a readable archive,
    // no X-Backup-Locked header) and a node whose /backup fails. Each counts its /backup hits; both report counts.
    const hits = { old: 0, down: 0, short: 0, shortWithAllowMissing: 0 };
    const oldStateDb = crypto.randomBytes(4000);
    // The archive a node of this version sends: the database AND the objects its rows name. Before round 3 the
    // harvester extracted this, kept state.db and deleted the rest.
    const standInImages: Record<string, Buffer> = {
        'images/posts/post-a/0-1a2b3c4d.jpg': crypto.randomBytes(2048),
        'images/posts/post-a/1-5e6f7a8b.jpg': crypto.randomBytes(1500),
        'images/attachments/msg-a.bin': crypto.randomBytes(900),
    };
    const oldTar = fs.readFileSync(tarOf({
        'state.db': oldStateDb, 'node_config.json': Buffer.from('{}'), ...standInImages,
    }));
    // The same node when one object is gone for good: everything it still holds, plus the manifest naming what
    // it could not send. The manifest's presence is the label — a complete backup does not carry one.
    const shortManifest = Buffer.from(JSON.stringify({
        note: 'This backup is SHORT.', takenAt: new Date().toISOString(),
        referenced: 3, staged: 2, missing: ['posts/post-a/1-5e6f7a8b.jpg'],
    }, null, 2));
    const shortImages: Record<string, Buffer> = {
        'images/posts/post-a/0-1a2b3c4d.jpg': standInImages['images/posts/post-a/0-1a2b3c4d.jpg'],
        'images/attachments/msg-a.bin': standInImages['images/attachments/msg-a.bin'],
    };
    const shortTar = fs.readFileSync(tarOf({
        'state.db': oldStateDb, 'node_config.json': Buffer.from('{}'),
        [MISSING_MEMBER]: shortManifest, ...shortImages,
    }));
    const app = new Koa();
    app.use(async (ctx, next) => {
        if (ctx.path === '/old-node/api/local/admin/backup') {
            hits.old++;
            ctx.set('X-Backup-Contents', 'database+images');
            ctx.set('X-Backup-Images', '3/3');
            ctx.set('Content-Type', 'application/gzip');
            ctx.body = oldTar;
            return;
        }
        if (ctx.path === '/down-node/api/local/admin/backup') {
            hits.down++;
            ctx.status = 500;
            ctx.body = { error: 'disk full' };
            return;
        }
        // A node with one object gone for good: it refuses every backup, exactly as sendBackup does, until
        // the caller says allowMissing — and then it sends a labelled short one. The failure that never
        // clears on its own, which is the whole reason the opt-in exists.
        if (ctx.path === '/short-node/api/local/admin/backup') {
            hits.short++;
            if (!ctx.query?.allowMissing) {
                ctx.status = 500;
                ctx.set('X-Backup-Error', 'incomplete-images');
                ctx.body = { error: 'Backup failed: Backup refused: the image store holds 411 of the 412 object(s)…',
                    images: { referenced: 412, staged: 411, missing: 1 } };
                return;
            }
            hits.shortWithAllowMissing++;
            ctx.set('X-Backup-Contents', 'database+images-partial');
            ctx.set('X-Backup-Images', '2/3');
            ctx.set('X-Backup-Missing-Images', '1');
            ctx.set('Content-Type', 'application/gzip');
            ctx.body = shortTar;
            return;
        }
        if (ctx.path === '/short-node/api/community/info') {
            // A different count every time, so every harvest sees drift and tries to pull.
            ctx.body = { memberCount: 3 + hits.short, postCount: 7 };
            return;
        }
        if (ctx.path === '/old-node/api/community/info' || ctx.path === '/down-node/api/community/info') {
            ctx.body = { memberCount: 3, postCount: 7 };
            return;
        }
        await next();
    });
    app.use(createBackupRoutes(deps).routes());
    // The fleet manager's own routes, so `download-db` and `download-history` are exercised as the dashboard
    // calls them rather than by reading the files off the disk the harvester just wrote.
    app.use(createManagerBackupsRoutes(deps).routes());
    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
        const tokenOnly: FleetNodeConfig = { id: 'tok-node', name: 'Token Node', url, replicationToken: TOKEN };
        const slug = nodeSlug(tokenOnly);
        const nodeDir = path.join(dataDir, 'backups', slug);
        const sealedDir = path.join(nodeDir, 'sealed');
        const today = new Date().toISOString().slice(0, 10);

        // ── No recovery code, no owner: readable, kept as before, flagged ──
        resetAdminAuthTarpit();
        const none = await harvestNode(tokenOnly, true);
        assert(none.status === 'ok' && none.error === null, `no code: the harvest succeeds (got ${none.status}: ${none.error})`);
        assert(fs.existsSync(path.join(nodeDir, 'state.db')) && fs.readFileSync(path.join(nodeDir, 'state.db')).subarray(0, 15).toString() === 'SQLite format 3',
            'no code: the readable state.db is kept, as before locked backups');
        assert(fs.existsSync(path.join(nodeDir, 'history', `beanpool-${today}.db`)), 'no code: …and today\'s daily copy in history/');
        assert(listSealedBackups(tokenOnly).length === 0, 'no code: nothing locked is stored (nothing could open it)');
        assert(none.backupLock?.locked === false && none.backupLock.message === NOT_LOCKED, `no code: the node's own words are kept (${none.backupLock?.message})`);
        assert(none.sealedBackup?.state === 'unlocked' && none.sealedBackup.message.includes(NOT_LOCKED),
            `no code: the status says the backup is readable and not locked yet ("${none.sealedBackup?.message}")`);
        assert(none.identityStatus === 'partial' && /locked backup/.test(none.identityNote || ''), 'no code: identity partial — a readable backup carries no keys');

        // ── Old readable files the harvester wrote before (§6.4), with the node key it collected then ──
        fs.mkdirSync(path.join(nodeDir, 'history'), { recursive: true });
        fs.mkdirSync(path.join(nodeDir, 'identity', '.tmp-extract'), { recursive: true });
        const oldDaily = crypto.randomBytes(3000);
        fs.writeFileSync(path.join(nodeDir, 'history', 'beanpool-2026-09-10.db'), oldDaily);
        fs.writeFileSync(path.join(nodeDir, 'identity', 'libp2p_key'), 'not-a-key');
        fs.writeFileSync(path.join(nodeDir, 'identity', 'genesis.json'), '{"communityId":"old"}');
        fs.writeFileSync(path.join(nodeDir, 'identity', '.tmp-extract', 'libp2p_key'), 'leftover-temp-key');
        fs.writeFileSync(path.join(nodeDir, '.tmp-backup.tar.gz'), 'leftover-temp-archive');
        const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
        fs.utimesSync(path.join(nodeDir, 'history', 'beanpool-2026-09-10.db'), tenDaysAgo, tenDaysAgo);

        // ── Still no code: the seal-old pass deletes NOTHING ──
        const before = snapshotTree(nodeDir);
        resetAdminAuthTarpit();
        const n2 = await harvestNode(tokenOnly, false);
        const after = snapshotTree(nodeDir);
        const gone = Object.keys(before).filter(f => !(f in after) || (f !== 'state.db' && !f.startsWith('history/beanpool-' + today) && before[f] !== after[f]));
        assert(gone.length === 0, `no code: seal-old deletes and changes nothing (${gone.join(', ') || 'all there'})`);
        assert(!!n2.sealOld?.error && /not locked yet/.test(n2.sealOld.error) && /Nothing was deleted/.test(n2.sealOld.error) && n2.sealOld.sealed.length === 0,
            `no code: sealOld.error says why ("${n2.sealOld?.error}")`);

        // ── An owner, still no code (probably the live nodes): the same — readable, nothing deleted ──
        const ownerSeed = crypto.randomBytes(32);
        const ownerPub = Buffer.from(ed25519.getPublicKey(ownerSeed)).toString('hex');
        seedGenesisMember(ownerPub, 'Olive');
        const b3 = snapshotTree(nodeDir);
        resetAdminAuthTarpit();
        const n3 = await harvestNode(tokenOnly, true);
        const a3 = snapshotTree(nodeDir);
        assert(n3.status === 'ok' && n3.backupLock?.locked === false && listSealedBackups(tokenOnly).length === 0,
            `an owner, no code: still readable, nothing locked to the owner alone (${n3.status}, locked=${n3.backupLock?.locked})`);
        assert(Object.keys(b3).every(f => f in a3), 'an owner, no code: seal-old deletes nothing');

        // Fable's measured case, straight at the pass: a header locked to an owner only. Refused, nothing touched.
        const ownerOnly = readSealedHeader(await sealEnvelope(new Uint8Array(10), {
            kind: 'backup', communityId: 'c', nodePeerId: peerIdFromPrivateKey((await import('@libp2p/crypto/keys')).privateKeyFromProtobuf(nodeKeyBytes)).toString(),
            recipients: { owners: [{ pubkey: ownerPub, callsign: 'Olive' }], codes: [] },
            signingKey: new Uint8Array((await import('@libp2p/crypto/keys')).privateKeyFromProtobuf(nodeKeyBytes).raw.subarray(0, 32)),
        }));
        const b4 = snapshotTree(nodeDir);
        const r4 = await sealOldBackups(tokenOnly, ownerOnly);
        assert(r4.sealed.length === 0 && /no recovery code/.test(r4.error || '') && JSON.stringify(snapshotTree(nodeDir)) === JSON.stringify(b4),
            `seal-old to an owner-only header: refused, every file untouched ("${r4.error}")`);

        // sealFileVerified is the check, not an assumption: it refuses without a code stanza, and a tar that is not a
        // backup (no state.db) is caught on re-open and its locked copy removed.
        const code0 = (await makeRecoveryCode()).code;
        const codeRec = getLocalConfig().recoveryCode as any;
        const seedOf = (await import('@libp2p/crypto/keys')).privateKeyFromProtobuf(nodeKeyBytes);
        const sOpts = { communityId: 'c', nodePeerId: peerIdFromPrivateKey(seedOf).toString(), signingKey: new Uint8Array(seedOf.raw.subarray(0, 32)) };
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sfv-'));
        let threw = '';
        try { await sealFileVerified(tarOf({ 'state.db': Buffer.from('x') }), path.join(scratch, 'a.bpsealed'), { ...sOpts, recipients: { owners: [{ pubkey: ownerPub, callsign: 'Olive' }], codes: [] } }); }
        catch (e: any) { threw = e.message; }
        assert(/recovery code/.test(threw) && !fs.existsSync(path.join(scratch, 'a.bpsealed')), `sealFileVerified refuses owners-only (${threw})`);
        threw = '';
        try { await sealFileVerified(tarOf({ 'other.txt': Buffer.from('x') }), path.join(scratch, 'b.bpsealed'), { ...sOpts, recipients: { owners: [], codes: [codeRec] }, requireStateDb: true }); }
        catch (e: any) { threw = e.message; }
        assert(/state\.db missing/.test(threw) && fs.readdirSync(scratch).length === 0, `sealFileVerified checks what re-opens and removes a bad copy (${threw})`);
        const good = await sealFileVerified(tarOf({ 'state.db': Buffer.from('x') }), path.join(scratch, 'c.bpsealed'), { ...sOpts, recipients: { owners: [], codes: [codeRec] }, requireStateDb: true });
        const reopened = await openEnvelope(new Uint8Array(fs.readFileSync(path.join(scratch, 'c.bpsealed'))), { type: 'code', code: code0 }, { kind: 'backup' });
        assert(!!good.sha256 && reopened.payload.length > 0, 'sealFileVerified: a good backup tar seals, and the recovery code opens it');
        fs.rmSync(scratch, { recursive: true, force: true });

        // ── A recovery code, but no key the harvester already knows: locked backups now, nothing deleted ──
        resetAdminAuthTarpit();
        const b5 = snapshotTree(nodeDir, sealedDir);
        const n5 = await harvestNode(tokenOnly, true);
        assert(n5.status === 'ok' && n5.backupLock?.locked === true && n5.sealedBackup?.state === 'sealed', `with a code: the node's backup is locked (${n5.sealedBackup?.state})`);
        assert(/no pinned key/.test(n5.sealOld?.error || '') && Object.keys(b5).every(f => f in snapshotTree(nodeDir, sealedDir)),
            `with a code, no pinned key: nothing deleted ("${n5.sealOld?.error}")`);
        // A pin that does not match the node (a spoofed endpoint, or a changed key): nothing deleted.
        const wrongPin: FleetNodeConfig = { ...tokenOnly, peerId: peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString() };
        resetAdminAuthTarpit();
        const n6 = await harvestNode(wrongPin, false);
        assert(/pinned key/.test(n6.sealOld?.error || '') && n6.pinSource === 'manager-nodes.json' && Object.keys(b5).every(f => f in snapshotTree(nodeDir, sealedDir)),
            `a pin that is not the node's key: nothing deleted ("${n6.sealOld?.error}")`);

        // ── The key file collected before is the pin. First a seal that fails: the readable originals stay ──
        fs.writeFileSync(path.join(nodeDir, 'identity', 'libp2p_key'), nodeKeyBytes);
        fs.chmodSync(sealedDir, 0o500);
        const b7 = snapshotTree(nodeDir, sealedDir);
        resetAdminAuthTarpit();
        const n7 = await harvestNode(tokenOnly, false);
        fs.chmodSync(sealedDir, 0o700);
        assert(!!n7.sealOld?.error && JSON.stringify(snapshotTree(nodeDir, sealedDir)) === JSON.stringify(b7),
            `a seal that fails keeps every readable file (${n7.sealOld?.error})`);

        // ── Now it works: every readable file locked, each deleted only after its copy re-opened ──
        const made = { code: code0, codeId: codeRec.codeId };
        resetAdminAuthTarpit();
        const a = await harvestNode(tokenOnly, true);
        assert(a.status === 'ok' && a.error === null, `token-only harvest completes without error (${a.status}: ${a.error})`);
        assert(a.pinnedPeerId === peerIdFromPrivateKey(seedOf).toString() && a.pinSource === 'collected key file', `the pin is the collected node key (${a.pinSource})`);
        const held = listSealedBackups(tokenOnly);
        const pulled = held.find(f => !f.file.includes('-legacy'));
        assert(!!pulled && pulled.file.endsWith('.bpsealed'), `the node's backup is stored as a sealed file (${pulled?.file})`);
        const pulledBytes = fs.readFileSync(pulled!.path);
        assert(!(pulledBytes[0] === 0x1f && pulledBytes[1] === 0x8b), 'the stored file is not a plain archive');
        assert(a.dbSizeBytes === pulled!.size, 'dbSizeBytes is the sealed file\'s size');
        assert(a.identityStatus === 'secured' && a.identityNote === null, `token-only node: identity secured, inside the sealed backup (got ${a.identityStatus}: ${a.identityNote})`);
        assert(a.sealedBackup?.state === 'sealed' && a.sealedBackup.codeIds.includes(made.codeId), 'the new status names the recovery code the file opens with');
        assert(/^Sealed backup held: sealed .* locked to 1 owner \+ recovery code #\d+\.$/.test(a.sealedBackup?.message || ''), `…in words: "${a.sealedBackup?.message}"`);
        const opened = await openEnvelope(new Uint8Array(pulledBytes), { type: 'code', code: made.code }, { kind: 'backup' });
        const extract = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-open-'));
        fs.writeFileSync(path.join(extract, 'b.tar.gz'), opened.payload);
        execFileSync('tar', ['-xzf', path.join(extract, 'b.tar.gz'), '-C', extract]);
        assert(fs.existsSync(path.join(extract, 'state.db')) && fs.existsSync(path.join(extract, 'takeover-bundle.json')),
            'the code opens it: state.db and the take-over bundle are inside');
        fs.rmSync(extract, { recursive: true, force: true });

        const leftovers = Object.keys(snapshotTree(nodeDir, sealedDir));
        assert(leftovers.length === 0, `seal-old: no plaintext left outside sealed/ (left: ${leftovers.join(', ') || 'none'})`);
        assert(a.sealOld?.left.length === 0 && a.sealOld?.error === null, `seal-old: the status says nothing is left (${a.sealOld?.error})`);
        const legacy = fs.readdirSync(sealedDir).filter(f => f.endsWith('-legacy.bpsealed')).sort();
        assert(legacy.length === 4, `seal-old: four sealed files made — latest db, two dailies, the key files (${legacy.join(', ')})`);
        assert(fs.readdirSync(sealedDir).every(f => f.endsWith('.bpsealed')), 'seal-old: nothing but sealed files in sealed/ (no temp files)');
        const openTar = async (file: string): Promise<string> => {
            const bytes = new Uint8Array(fs.readFileSync(path.join(sealedDir, file)));
            const { header, payload } = await openEnvelope(bytes, { type: 'code', code: made.code }, { kind: 'backup' });
            assert(header.nodePeerId !== readSealedHeader(new Uint8Array(pulledBytes)).nodePeerId && verifySealedHeader(header,
                (peerIdFromString(header.nodePeerId) as any).publicKey.raw), `seal-old: ${file} is signed by the harvester's own key, named in its header`);
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealold-'));
            fs.writeFileSync(path.join(dir, 'x.tar.gz'), payload);
            execFileSync('tar', ['-xzf', path.join(dir, 'x.tar.gz'), '-C', dir]);
            fs.rmSync(path.join(dir, 'x.tar.gz'));
            return dir;
        };
        const latestFile = legacy.find(f => f.includes('-latest-'))!;
        const d1 = await openTar(latestFile);
        const d1Hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(d1, 'state.db'))).digest('hex');
        assert(d1Hash === b7['state.db'], 'seal-old: the readable latest state.db re-opens byte for byte, as a restorable backup (state.db)');
        assert(sameTree(treeOf(path.join(d1, 'images')), localImages),
            `seal-old: …and its images are inside the envelope, byte for byte (${Object.keys(treeOf(path.join(d1, 'images'))).length}/${Object.keys(localImages).length})`);
        const todayDailyFile = legacy.find(f => f.startsWith(`beanpool-${today}`))!;
        const dToday = await openTar(todayDailyFile);
        assert(sameTree(treeOf(path.join(dToday, 'images')), localImages),
            'seal-old: today\'s daily archive seals whole too, not as a bare database');
        fs.rmSync(dToday, { recursive: true, force: true });
        const dailyFile = legacy.find(f => f.startsWith('beanpool-2026-09-10'))!;
        const d2 = await openTar(dailyFile);
        assert(fs.readFileSync(path.join(d2, 'state.db')).equals(oldDaily), 'seal-old: the old daily archive re-opens byte for byte');
        assert(!fs.existsSync(path.join(d2, 'images')),
            'seal-old: a file written before this version has no images beside it, and gets an envelope with no images/ member — not an empty one');
        assert(Math.abs(fs.statSync(path.join(sealedDir, dailyFile)).mtimeMs - tenDaysAgo.getTime()) < 2000, 'seal-old: the file keeps its date, so the 30-day rule still applies');
        const idFile = legacy.find(f => f.startsWith('beanpool-identity-'))!;
        assert(!!idFile && listSealedBackups(tokenOnly).some(f => f.file === idFile && f.identity), `the locked key file is named beanpool-identity-…, so it is listed (${idFile})`);
        const d3 = await openTar(idFile);
        assert(fs.readFileSync(path.join(d3, 'libp2p_key')).equals(Buffer.from(nodeKeyBytes))
            && fs.readFileSync(path.join(d3, 'genesis.json'), 'utf-8') === '{"communityId":"old"}', 'seal-old: the old key files re-open intact');
        for (const d of [d1, d2, d3]) fs.rmSync(d, { recursive: true, force: true });
        assert(a.historyCount === listSealedBackups(tokenOnly).filter(f => !f.identity).length, 'historyCount counts the backups held');

        // A second run has nothing to seal; the pin is remembered though the key file is now locked away.
        resetAdminAuthTarpit();
        const b = await harvestNode(tokenOnly, true);
        assert(b.status === 'ok' && b.sealOld?.left.length === 0 && b.pinSource === 'collected key file', 'a second run: nothing left to seal, the pin remembered');
        const afterSecond = fs.readdirSync(sealedDir);
        assert(afterSecond.includes(dailyFile) && afterSecond.includes(idFile),
            `a second run: the old daily and the locked key file are kept (${afterSecond.join(', ')})`);
        const todays = listSealedBackups(tokenOnly).filter(f => !f.identity && new Date(f.mtimeMs).toISOString().slice(0, 10) === today);
        assert(todays.length === 1, `a second run: one backup kept for today, the newest (${todays.map(f => f.file).join(', ')})`);

        // Admin password works the same way.
        const withPw: FleetNodeConfig = { ...tokenOnly, replicationToken: undefined, adminPassword: PW };
        resetAdminAuthTarpit();
        const c = await harvestNode(withPw, true);
        assert(c.status === 'ok' && c.identityStatus === 'secured', `with the admin password: a sealed backup, identity secured (got ${c.status}/${c.identityStatus})`);

        // ── A node whose pull fails: backed off, not pulled every minute ──
        assert(backoffDelayMs(1) === 5 * 60_000 && backoffDelayMs(2) === 10 * 60_000 && backoffDelayMs(20) === 6 * 3_600_000, 'back-off: 5 min, doubling, at most 6 hours');
        const down: FleetNodeConfig = { id: 'melb', name: 'Down Node', url: url + '/down-node', replicationToken: TOKEN };
        const f1 = await harvestNode(down, false);
        assert(hits.down === 1 && f1.status === 'error' && /HTTP 500/.test(f1.error || '') && f1.pullBackoff?.failures === 1,
            `a failing node: one pull, an error, backing off (${hits.down} pulls, ${f1.error})`);
        const waitMs = Date.parse(f1.pullBackoff!.nextPullAt) - Date.now();
        assert(waitMs > 4 * 60_000 && waitMs <= 5 * 60_000, `…for about 5 minutes (${Math.round(waitMs / 1000)} s)`);
        const f2 = await harvestNode(down, false);
        const f3 = await harvestNode(down, false);
        assert(hits.down === 1 && f3.status === 'error' && /next try after/.test(f3.error || '') && f2.pullBackoff?.failures === 1,
            `…the next minutes' harvests do not pull it again (${hits.down} pulls: "${f3.error}")`);
        const f4 = await harvestNode(down, true);
        assert(hits.down === 2 && f4.pullBackoff?.failures === 2, `…a forced harvest still pulls, and the wait doubles (${hits.down} pulls, failures ${f4.pullBackoff?.failures})`);

        // ── An old node: its readable archive is kept as before, pulled once, not every minute ──
        const oldNode: FleetNodeConfig = { id: 'bris', name: 'Old Node', url: url + '/old-node', replicationToken: TOKEN };
        const oldNodeForCheck = oldNode;
        const oldDir = path.join(dataDir, 'backups', nodeSlug(oldNode));
        const o1 = await harvestNode(oldNode, false);
        const o2 = await harvestNode(oldNode, false);
        const o3 = await harvestNode(oldNode, false);
        assert(hits.old === 1, `an old node: pulled once over three harvests (${hits.old} pulls)`);
        assert(o1.status === 'ok' && fs.readFileSync(path.join(oldDir, 'state.db')).equals(oldStateDb) && fs.existsSync(path.join(oldDir, 'history', `beanpool-${today}.db`)),
            `an old node: its readable backup is kept as before (${o1.status}: ${o1.error})`);
        assert(o3.status === 'ok' && o3.backupLock?.locked === false && /older than locked backups/.test(o3.sealedBackup?.message || '') && o2.status === 'ok',
            `an old node: the status says why it is not locked ("${o3.sealedBackup?.message}")`);
        assert(/not locked yet/.test(o3.sealOld?.error || '') && fs.existsSync(path.join(oldDir, 'state.db')), 'an old node: seal-old deletes nothing');

        // ── A readable backup is kept WHOLE: every hop carries the images, byte for byte ──
        //
        // Before round 3 `keepPlainBackup` extracted the archive, copied state.db out and deleted the
        // extraction directory with `images/` inside it. Every copy downstream — the latest, the daily
        // history, the sealed old archive, the manager's download — was then a database whose every
        // `storage_key` pointed at bytes nobody had, and the pull log still said "database + N image
        // object(s)". These assertions are what that bug could not pass.
        const sent: Record<string, Buffer> = {};
        for (const [name, bytes] of Object.entries(standInImages)) sent[name.replace(/^images\//, '')] = bytes;

        // 1. keepPlainBackup
        const keptImages = treeOf(imagesDirFor(path.join(oldDir, 'state.db')));
        assert(sameTree(keptImages, sent),
            `kept whole: the latest backup holds all ${Object.keys(sent).length} object(s) the node sent, byte for byte `
            + `(holds ${Object.keys(keptImages).length})`);
        assert(!fs.existsSync(missingManifestFor(path.join(oldDir, 'state.db'))),
            'kept whole: a complete backup carries NO missing-images.json — its absence is the label');

        // 2. createDailyArchive — and hard-linked, so thirty days is not thirty copies of the images
        const dailyDb = path.join(oldDir, 'history', `beanpool-${today}.db`);
        const dailyImages = treeOf(imagesDirFor(dailyDb));
        assert(sameTree(dailyImages, sent), `kept whole: today's daily copy holds them too (${Object.keys(dailyImages).length})`);
        const oneKey = Object.keys(sent)[0];
        const inodeOf = (p: string): number | null => { try { return fs.statSync(p).ino; } catch { return null; } };
        const dailyIno = inodeOf(path.join(imagesDirFor(dailyDb), oneKey));
        assert(dailyIno !== null && dailyIno === inodeOf(path.join(imagesDirFor(path.join(oldDir, 'state.db')), oneKey)),
            'kept whole: the daily copy hard-links the objects rather than copying their bytes');

        // 3. listPlainHistory still sees databases and nothing else
        const hist = listPlainHistory(oldNode);
        assert(hist.length === 1 && hist[0].file === `beanpool-${today}.db`,
            `kept whole: the images directory is not mistaken for a backup (${hist.map(h => h.file).join(', ')})`);

        // 4. the fleet manager's two downloads, over HTTP, as the dashboard calls them
        const managerGet = async (route: string, query: Record<string, string>) => {
            const qs = new URLSearchParams(query).toString();
            const r = await fetch(`${url}/api/manager/backups/${route}?${qs}`, { headers: { 'X-Admin-Password': PW } });
            return { res: r, bytes: Buffer.from(await r.arrayBuffer()) };
        };
        resetAdminAuthTarpit();
        const dl = await managerGet('download-db', { nodeId: oldNode.id });
        assert(dl.res.ok && /filename="[^"]+\.tar\.gz"/.test(dl.res.headers.get('content-disposition') || ''),
            `manager download-db: a restorable archive, named .tar.gz (${dl.res.status}, ${dl.res.headers.get('content-disposition')})`);
        const dlDir = openArchive(dl.bytes, 'dl');
        assert(fs.readFileSync(path.join(dlDir, 'state.db')).equals(oldStateDb)
            && sameTree(treeOf(path.join(dlDir, 'images')), sent),
            'manager download-db: the operator gets state.db AND every image object, byte for byte');
        fs.rmSync(dlDir, { recursive: true, force: true });

        resetAdminAuthTarpit();
        const dlHist = await managerGet('download-history', { nodeId: oldNode.id, filename: `beanpool-${today}.db` });
        assert(dlHist.res.ok, `manager download-history: served (${dlHist.res.status})`);
        const histDir = openArchive(dlHist.bytes, 'dlhist');
        assert(fs.readFileSync(path.join(histDir, 'state.db')).equals(oldStateDb)
            && sameTree(treeOf(path.join(histDir, 'images')), sent),
            'manager download-history: a day out of the history is whole too');
        fs.rmSync(histDir, { recursive: true, force: true });

        // 5. a pull that comes back complete clears a manifest an earlier short pull left beside the database
        const staleManifest = missingManifestFor(path.join(oldDir, 'state.db'));
        fs.writeFileSync(staleManifest, '{"missing":["posts/gone/0-dead.jpg"]}');
        hits.old = 0;
        await harvestNode(oldNode, true);
        assert(!fs.existsSync(staleManifest),
            'kept whole: a complete pull clears the last one\'s short-backup manifest, so the label cannot go stale');

        // ── A node missing an object for good: refused N times, then a labelled SHORT backup ──
        //
        // Refusing is right and stays the default. But the bytes are gone, so the refusal never lifts by
        // itself: without this the node's nightly backup fails every night from now on and it ends up with
        // NO backup, which is strictly worse than one short by a photo and saying so.
        // `castlemaine` so nodeSlug gives it a directory and a state entry of its own rather than the
        // localhost fallback every other stand-in here shares.
        const shortNode: FleetNodeConfig = { id: 'castlemaine', name: 'Short Node', url: url + '/short-node', replicationToken: TOKEN };
        const s1 = await harvestNode(shortNode, true);
        assert(s1.status === 'error' && /incomplete|image store holds/.test(s1.error || '') && s1.incompleteImages?.failures === 1,
            `a node missing an object: the first refusal is counted, not acted on (${s1.incompleteImages?.failures}: ${s1.error})`);
        assert(hits.shortWithAllowMissing === 0, 'and nothing was asked for with allowMissing yet');
        const s2 = await harvestNode(shortNode, true);
        assert(s2.incompleteImages?.failures === 2 && s2.incompleteImages?.allowingMissing !== true && hits.shortWithAllowMissing === 0,
            `…nor on the second: a refusal can be the one-VACUUM window, and that one clears itself (${s2.incompleteImages?.failures})`);
        const s3 = await harvestNode(shortNode, true);
        assert(s3.incompleteImages?.failures === ALLOW_MISSING_AFTER_FAILURES && s3.incompleteImages?.allowingMissing === true,
            `…the ${ALLOW_MISSING_AFTER_FAILURES}rd marks the node as one to take a short backup from (${s3.incompleteImages?.failures})`);
        assert(s3.status === 'error' && hits.shortWithAllowMissing === 0,
            'that pull itself still failed — the decision applies to the NEXT one, not retroactively');

        const s4 = await harvestNode(shortNode, true);
        assert(hits.shortWithAllowMissing === 1, `…and the next pull asks for allowMissing (${hits.shortWithAllowMissing})`);
        assert(s4.status === 'ok' && s4.error === null, `…which succeeds, so the node has a backup again (${s4.status}: ${s4.error})`);
        const shortDir = path.join(dataDir, 'backups', nodeSlug(shortNode));
        assert(fs.existsSync(path.join(shortDir, 'state.db'))
            && fs.readFileSync(path.join(shortDir, 'state.db')).equals(oldStateDb) && s4.dbSizeBytes === oldStateDb.length,
            '…and the file is on this node\'s own disk, byte for byte, not just reported');
        assert(s4.incompleteImages?.allowingMissing === true && /short by 1/.test(s4.incompleteImages?.lastError || ''),
            `…still flagged short, so the dashboard keeps saying so ("${s4.incompleteImages?.lastError}")`);
        assert(!s4.pullBackoff, '…and the back-off is cleared, because the pull worked');

        // ── A SHORT backup stays labelled short at every hop ──
        //
        // Inside the archive rather than in a header, because that is the copy that outlives the HTTP
        // response: a year from now the operator restoring this file has the headers nowhere.
        const shortSent: Record<string, Buffer> = {};
        for (const [name, bytes] of Object.entries(shortImages)) shortSent[name.replace(/^images\//, '')] = bytes;
        const shortDb = path.join(shortDir, 'state.db');
        assert(sameTree(treeOf(imagesDirFor(shortDb)), shortSent),
            'short: the two objects the node COULD send are kept, not thrown away with the third');
        const keptManifest = missingManifestFor(shortDb);
        assert(fs.existsSync(keptManifest)
            && JSON.parse(fs.readFileSync(keptManifest, 'utf8')).missing[0] === 'posts/post-a/1-5e6f7a8b.jpg',
            'short: the manifest is kept beside the database, naming the object that is gone');
        const shortDaily = path.join(shortDir, 'history', `beanpool-${today}.db`);
        assert(fs.existsSync(missingManifestFor(shortDaily))
            && sameTree(treeOf(imagesDirFor(shortDaily)), shortSent),
            'short: the daily copy is labelled short too, and holds the same two objects');
        resetAdminAuthTarpit();
        const shortDl = await fetch(`${url}/api/manager/backups/download-db?nodeId=${shortNode.id}`,
            { headers: { 'X-Admin-Password': PW } });
        assert(shortDl.headers.get('x-backup-contents') === 'database+images-partial',
            `short: the manager's download says so on the wire (${shortDl.headers.get('x-backup-contents')})`);
        const shortDir2 = openArchive(Buffer.from(await shortDl.arrayBuffer()), 'short');
        assert(fs.existsSync(path.join(shortDir2, MISSING_MEMBER))
            && sameTree(treeOf(path.join(shortDir2, 'images')), shortSent),
            'short: …and the downloaded archive carries the manifest, so a restore from it can say so');
        fs.rmSync(shortDir2, { recursive: true, force: true });

        // A node that answers normally never gets the opt-in.
        assert(!(await harvestNode(oldNodeForCheck, true)).incompleteImages,
            'a node whose backups are whole is never marked, and is never asked for a short one');

        // A wrong admin password: the harvest reports it; nothing crashes.
        const wrongPw: FleetNodeConfig = { ...tokenOnly, replicationToken: undefined, adminPassword: 'wrong-password-1!' };
        resetAdminAuthTarpit();
        const e = await harvestNode(wrongPw, true);
        assert(e.status === 'error' && /HTTP 401/.test(e.error || ''), `a refused admin password: error with the reason (got ${e.status}: ${e.error})`);
        assert(e.identityStatus === 'secured' && /latest pull failed/.test(e.sealedBackup?.message || ''),
            'a refused admin password: the sealed backups already held still count, and the status says the latest pull failed');
    } finally {
        try { fs.chmodSync(path.join(dataDir, 'backups', 'local-node', 'sealed'), 0o700); } catch { /* ignore */ }
        await new Promise<void>(r => server.close(() => r()));
    }
}

async function main() {
    console.log('Running harvester service test...\n');

    // 1. Test nodeSlug
    assert(nodeSlug('') === 'unknown', 'nodeSlug handles empty target');
    assert(nodeSlug('mullum') === 'mullum', 'nodeSlug handles exact default node id');
    assert(nodeSlug({ id: 'custom-1', name: 'Mullumbimby Node', url: 'https://mullum.example.com' }) === 'mullum', 'nodeSlug detects mullum keyword in name/url');
    assert(nodeSlug({ id: 'custom-2', name: 'Local Dev Node', url: 'http://localhost:8450' }) === 'local-node', 'nodeSlug detects localhost url');
    assert(nodeSlug({ id: 'special@node/1', name: 'Special Node', url: 'https://special.org' }) === 'special_node_1', 'nodeSlug sanitizes special characters');

    // 2. Test getNodes default fallback
    const initialNodes = getNodes();
    assert(Array.isArray(initialNodes) && initialNodes.length > 0, 'getNodes returns default nodes when no config file exists');
    assert(initialNodes.some(n => n.id === 'mullum'), 'default nodes include mullum');

    // 3. Test saveNodes & getNodes persistence roundtrip
    const customNodes: FleetNodeConfig[] = [
        { id: 'custom-pool', name: 'Custom Pool Node', url: 'https://custom.beanpool.org', adminPassword: 'secret-pass' },
    ];
    saveNodes(customNodes);
    const reloadedNodes = getNodes();
    assert(reloadedNodes.length === 1 && reloadedNodes[0].id === 'custom-pool', 'saveNodes persists custom node configuration');
    assert(reloadedNodes[0].adminPassword === 'secret-pass', 'adminPassword field preserved');

    // 4. Test loadHarvestState default
    const initialState = loadHarvestState();
    assert(typeof initialState === 'object' && Object.keys(initialState).length === 0, 'loadHarvestState returns empty object when state file does not exist');

    // 5. A real harvest against a local node
    await harvestLocalNode();

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
