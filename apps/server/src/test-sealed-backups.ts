/**
 * Test Suite: sealed backups, restore (sealed keys slice 3; sealed-keys.md §6.1–6.2, the slice 3 row of §10).
 *
 *  1. Seal → restore round trip onto a FRESH data dir (a second process with its own data dir, its own genesis and
 *     its own node key) with the recovery code, through the real HTTPS server as the operator manual's curl line
 *     sends it: the database, the node key, community key, genesis, connectors, the admin/2FA credentials, the
 *     roles and the recovery code record all come back.
 *  2. A legacy plain `.tar.gz` still restores (database only; its fresh keys stay — a plain archive's keys are
 *     never installed).
 *  3. The hostile-archive suite through the sealed path: a `../` member, a symlink, a hardlink and an absolute
 *     member, each sealed properly to the recovery code and signed by the node itself, are refused whole, nothing
 *     lands outside the extraction folder, and the live database is untouched.
 *  4. The code: none → 400 with who can open it; typo → 400 before any guess; wrong code number → 400; a
 *     well-formed wrong code → 403; a take-over envelope is not a backup; a cut-short file is refused.
 *  5. The signature, where this server holds a pin (966 follow-up #2): a file of this community signed by another
 *     key is refused 409 and names the signer; confirming that signer by name lets it through to the next check;
 *     a header whose signature does not match the server it names is refused 400.
 *  6. A file let through by naming its signer (X-Accept-Signer) restores its database only: a take-over bundle inside
 *     it — which anyone who has seen a header can forge — is never applied (seal review round 1).
 *
 * Recovery seal S2 (the key that opens members' sign-in recovery copies travels only inside a sealed backup):
 *  1. @Dee deposits a sign-in copy on the main server over HTTPS. The sealed backup's bundle carries
 *     data/recovery-seal.key byte for byte; the restore on a fresh data dir installs it (the fresh server's own key is
 *     kept beside it), says the copy opens, and after the restart a device with only @Dee's sign-in recovers their seed
 *     and 12 words over HTTPS.
 *  2e. A plain backup (no recovery code) lists no recovery-seal.key and holds none of its bytes; a restore from it says
 *     the copy will not open there, with the missing-key line, and after the restart it does not.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-sealed-backups.ts
 * (It re-runs itself as a child with `--child` for the fresh-server side.)
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const IS_CHILD = process.argv[2] === '--child';

let testsRun = 0;
let testsPassed = 0;
function assert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const sha = (b: Buffer | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const isGzip = (b: Buffer) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** A minimal ustar writer, so hostile archives are built the same way on every OS (no reliance on tar's flags). */
function makeTarGz(entries: { name: string; type?: '0' | '1' | '2' | '5'; content?: Buffer; link?: string }[]): Buffer {
    const blocks: Buffer[] = [];
    for (const e of entries) {
        const content = e.content ?? Buffer.alloc(0);
        const h = Buffer.alloc(512);
        h.write(e.name, 0, 100, 'utf8');
        h.write('0000644\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write((e.type === '0' || !e.type ? content.length : 0).toString(8).padStart(11, '0') + '\0', 124);
        h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
        h.write('        ', 148);
        h.write(e.type ?? '0', 156);
        if (e.link) h.write(e.link, 157, 100, 'utf8');
        h.write('ustar\0', 257);
        h.write('00', 263);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(h);
        if (!e.type || e.type === '0') {
            blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512));
        }
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}

// ── Shared: a node's routes over real HTTP ─────────────────────────────────────────────────

async function serveBackupRoutes() {
    const Koa = (await import('koa')).default;
    const { createBackupRoutes, setRestoreRestartForTests } = await import('./routes/backup.js');
    const { checkAdminAuth } = await import('./admin-auth.js');
    setRestoreRestartForTests(() => { /* the test inspects the data dir instead of restarting */ });
    const deps: any = {
        checkAdminAuth: async (ctx: any) => checkAdminAuth(ctx),
        rateLimit: () => true, clampLimit: (_v: unknown, d = 20) => d, clampOffset: () => 0,
        activeConnections: new Map(), calculateAnalytics: () => ({}), enforceReadAuth: false,
    };
    const app = new Koa();
    app.use(createBackupRoutes(deps).routes());
    const server = http.createServer(app.callback());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// ── The fresh server (child process) ───────────────────────────────────────────────────────

async function child(): Promise<void> {
    const [, , , mode, file] = process.argv;
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    const sealKeyOf = () => { try { return sha(fs.readFileSync(path.join(dataDir, 'recovery-seal.key'))); } catch { return null; } };
    const retiredKeys = () => Object.fromEntries(fs.readdirSync(dataDir).filter((n) => n.startsWith('recovery-seal-retired-'))
        .map((n) => [n, { sha: sha(fs.readFileSync(path.join(dataDir, n))), mode: (fs.statSync(path.join(dataDir, n)).mode & 0o777).toString(8) }]));
    if (mode === 'recover') {
        // The restored server after its restart, and a device with nothing but @Dee's sign-in (recovery-seal-test-http.ts).
        const { initStateEngine: boot } = await import('./state-engine.js');
        boot();
        const { startRecoveryHttps } = await import('./recovery-seal-test-http.js');
        const recovered = await (await startRecoveryHttps()).recover({ callsign: 'Dee' });
        console.log('CHILD_RESULT ' + JSON.stringify({ recovered, sealKey: sealKeyOf(), retired: retiredKeys() }));
        process.exit(0);
    }
    const { initStateEngine } = await import('./state-engine.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');

    // A fresh install: its own genesis, its own node key, its own admin password.
    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const pw = 'Fresh-Server-Pw-551!';
    const { hash, salt } = hashPassword(pw);
    updateLocalConfig({ adminHash: hash, salt });
    const before = {
        key: sha(fs.readFileSync(path.join(dataDir, 'libp2p_key'))),
        communityId: JSON.parse(fs.readFileSync(path.join(dataDir, 'genesis.json'), 'utf-8')).communityId,
        sealKey: sealKeyOf(),
    };

    // The real HTTPS server, with the request the operator manual gives (curl --data-binary sends
    // application/x-www-form-urlencoded), so the upload goes through every middleware a node runs.
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { setRestoreRestartForTests } = await import('./routes/backup.js');
    setRestoreRestartForTests(() => { /* the test inspects the data dir instead of restarting */ });
    await initTls();
    // Bind once and read the port back, rather than guessing a random one that may be taken.
    const port = await startHttpsServer(0);
    // Before the restore, on this fresh server: its backups are readable until it has a recovery code, and the
    // operator manual's make-a-code line (password header, JSON body) makes one, after which they are locked.
    let makeCode: any = null;
    if (mode === 'sealed') {
        const backupLocked = async () => {
            resetAdminAuthTarpit();
            const r = await fetch(`https://localhost:${port}/api/local/admin/backup`, { method: 'POST', headers: { 'X-Admin-Password': pw } });
            const b = Buffer.from(await r.arrayBuffer());
            return { status: r.status, locked: r.headers.get('x-backup-locked'), why: r.headers.get('x-backup-not-locked'), gzip: b[0] === 0x1f && b[1] === 0x8b };
        };
        const beforeCode = await backupLocked();
        resetAdminAuthTarpit();
        const made = await fetch(`https://localhost:${port}/api/local/admin/takeover/recovery-code`, {
            method: 'POST', headers: { 'X-Admin-Password': pw, 'Content-Type': 'application/json' }, body: '{}',
        });
        const madeBody: any = await made.json();
        const afterCode = await backupLocked();
        makeCode = { beforeCode, status: made.status, looksLikeCode: /^BPRC-\d+ /.test(madeBody?.code || ''), afterCode };
    }
    resetAdminAuthTarpit();
    const headers: Record<string, string> = { 'X-Admin-Password': pw, 'Content-Type': 'application/x-www-form-urlencoded' };
    if (mode === 'sealed') headers['X-Recovery-Code'] = process.env.TEST_RECOVERY_CODE!;
    const res = await fetch(`https://localhost:${port}/api/local/admin/restore`, { method: 'POST', headers, body: new Uint8Array(fs.readFileSync(file)) });
    const body = await res.json();

    const read = (f: string) => { try { return fs.readFileSync(path.join(dataDir, f)); } catch { return null; } };
    const Database = (await import('better-sqlite3')).default;
    const restored = new Database(path.join(dataDir, 'state.db'), { readonly: true });
    const roles = restored.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all();
    const members = (restored.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c;
    const marker = restored.prepare("SELECT callsign FROM members WHERE callsign = 'RoundTripMarker'").get();
    restored.close();
    const localConfig = JSON.parse(read('local-config.json')?.toString() || '{}');
    const leftovers = fs.readdirSync(dataDir).filter((f) => f.startsWith('.restore') || f.startsWith('uploaded-backup') || f.includes('.tmp-'));
    // The image store as it stands after the restore: relative key → sha of the bytes, so the caller can
    // check that what came back is what the archive carried rather than only how many objects were counted.
    const images: Record<string, string> = {};
    const walkImages = (d: string, rel: string) => {
        let entries: string[];
        try { entries = fs.readdirSync(d); } catch { return; }
        for (const f of entries) {
            const full = path.join(d, f);
            const childRel = rel ? `${rel}/${f}` : f;
            if (fs.lstatSync(full).isDirectory()) walkImages(full, childRel);
            else images[childRel] = sha(fs.readFileSync(full));
        }
    };
    walkImages(path.join(dataDir, 'images'), '');
    console.log('CHILD_RESULT ' + JSON.stringify({
        status: res.status, body, before, makeCode,
        after: {
            key: read('libp2p_key') ? sha(read('libp2p_key')!) : null,
            communityKey: read('community.key') ? sha(read('community.key')!) : null,
            genesis: read('genesis.json') ? sha(read('genesis.json')!) : null,
            connectors: read('connectors.json') ? sha(read('connectors.json')!) : null,
            communityId: JSON.parse(read('genesis.json')?.toString() || '{}').communityId,
            adminHash: localConfig.adminHash, salt: localConfig.salt, totpEnabled: localConfig.totpEnabled,
            totpSecret: localConfig.totpSecret, recoveryCodeId: localConfig.recoveryCode?.codeId ?? null,
            roles, members, marker: !!marker, leftovers, images,
            sealKey: sealKeyOf(), sealKeyMode: fs.existsSync(path.join(dataDir, 'recovery-seal.key'))
                ? (fs.statSync(path.join(dataDir, 'recovery-seal.key')).mode & 0o777).toString(8) : null,
            retired: retiredKeys(),
        },
    }));
    process.exit(0);
}

function runChild(mode: 'sealed' | 'legacy', file: string, code?: string, opts: { thenRecover?: boolean } = {}): any {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-restore-fresh-'));
    const spawnChild = (m: string) => {
        const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--child', m, file], {
            env: { ...process.env, BEANPOOL_DATA_DIR: freshDir, TEST_RECOVERY_CODE: code ?? '' },
            encoding: 'utf-8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
        });
        const line = (r.stdout || '').split('\n').find((l) => l.startsWith('CHILD_RESULT '));
        if (!line) {
            console.error(r.stdout?.slice(-3000), r.stderr?.slice(-3000));
            throw new Error(`the fresh-server child printed no result (exit ${r.status})`);
        }
        return { ...JSON.parse(line.slice('CHILD_RESULT '.length)), logs: `${r.stdout}\n${r.stderr}` };
    };
    try {
        const restored = spawnChild(mode);
        // The node restarts after a restore (the child stood in for it); this is that restart, on the same data dir.
        if (opts.thenRecover) restored.afterRestart = spawnChild('recover');
        return restored;
    } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
    }
}

// ── The main server (this process) ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-backups-'));

    const { initStateEngine, seedGenesisMember, grantNodeRole } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
    const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { makeRecoveryCode, getSealedTakeoverEnvelope } = await import('./services/takeover-envelope.js');
    const { createSealedBackup } = await import('./services/sealed-backup.js');
    const core = await import('@beanpool/core');

    initStateEngine();
    await ensureGenesis();
    const nodeKeyBytes = privateKeyToProtobuf(await generateKeyPair('Ed25519'));
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), nodeKeyBytes);
    const nodeSeed = new Uint8Array(privateKeyFromProtobuf(nodeKeyBytes).raw.subarray(0, 32));
    fs.writeFileSync(path.join(dataDir!, 'connectors.json'), JSON.stringify([{ address: '/p2p/12D3KooWPeerExample', trustLevel: 'peer', enabled: true, callsign: 'friend', addedAt: 1 }]));
    const PW = 'Main-Server-Pw-907!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' });
    // 2FA stays on in the bundle; this process signs in with the password alone below, so switch it off locally
    // AFTER the backup is made.
    const ownerKey = crypto.randomBytes(32);
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const ownerPub = Buffer.from(ed25519.getPublicKey(ownerKey)).toString('hex');
    seedGenesisMember(ownerPub, 'Olive');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
        .run('ab'.repeat(32), 'RoundTripMarker', new Date().toISOString(), ownerPub, 'TEST');
    const code = await makeRecoveryCode();
    // S2: @Dee's sign-in recovery copy, deposited over HTTPS through the signature middleware (recovery-seal-test-http.ts).
    const { startRecoveryHttps, fixtureWords } = await import('./recovery-seal-test-http.js');
    const dee = fixtureWords(4);
    const deposited = await (await startRecoveryHttps()).deposit({ seedHex: dee.seedHex, words: dee.words, callsign: 'Dee', addMember: true });
    assert(deposited.status === 200 && deposited.body?.threshold === 1, `S2 setup: @Dee deposits a sign-in copy on the main server over HTTPS (${deposited.status})`);
    const mainSealKeyBytes = fs.readFileSync(path.join(dataDir!, 'recovery-seal.key'));
    const mainSealKey = sha(mainSealKeyBytes);
    const main = {
        key: sha(nodeKeyBytes),
        communityKey: sha(fs.readFileSync(path.join(dataDir!, 'community.key'))),
        genesis: sha(fs.readFileSync(path.join(dataDir!, 'genesis.json'))),
        connectors: sha(fs.readFileSync(path.join(dataDir!, 'connectors.json'))),
        communityId: JSON.parse(fs.readFileSync(path.join(dataDir!, 'genesis.json'), 'utf-8')).communityId,
        roles: db.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all(),
        members: (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c,
    };
    assert((main.roles as any[]).some((r) => r.member_pubkey === ownerPub && r.role === 'owner'), 'setup: the main server has an owner');

    // The backup, made by the same code the route uses.
    const backupFile = path.join(work, 'backup.bpsealed');
    {
        const b = await createSealedBackup();
        const parts: Buffer[] = [];
        for await (const c of b.body) parts.push(c as Buffer);
        fs.writeFileSync(backupFile, Buffer.concat(parts));
    }
    const backupBytes = fs.readFileSync(backupFile);
    assert(!isGzip(backupBytes), 'the backup is not a plain archive');
    const header = core.readSealedHeader(new Uint8Array(backupBytes));
    assert(header.kind === 'backup' && header.recipients.some((r: any) => r.type === 'owner' && r.pubkey === ownerPub)
        && header.recipients.some((r: any) => r.type === 'code' && r.codeId === code.codeId), 'it is locked to the owner and the recovery code');
    const ownerOpened = (await core.openEnvelope(new Uint8Array(backupBytes), { type: 'owner', privateKey: ownerKey }, { kind: 'backup' })).payload;
    assert(ownerOpened.length > 0, 'the owner opens it with their member key');
    {
        const tarFile = path.join(work, 'opened.tar.gz');
        fs.writeFileSync(tarFile, ownerOpened);
        const bundleText = spawnSync('tar', ['-xzOf', tarFile, './takeover-bundle.json'], { encoding: 'utf-8' }).stdout;
        assert(JSON.parse(bundleText).files['recovery-seal.key'] === mainSealKeyBytes.toString('base64'),
            "S2: the sealed backup's take-over bundle carries data/recovery-seal.key, byte for byte");
    }
    updateLocalConfig({ totpEnabled: false, totpSecret: null });

    // ── 1. Round trip onto a fresh server ──
    console.log('\n— 1. seal → restore on a fresh data dir —');
    const rt = runChild('sealed', backupFile, code.code, { thenRecover: true });
    const mc = rt.makeCode;
    assert(mc?.beforeCode.status === 200 && mc.beforeCode.gzip && mc.beforeCode.locked === 'no'
        && mc.beforeCode.why === "Backups are not locked yet: make a recovery code to lock them. Until then a backup file can be read by anyone who has it, and a server restored from it cannot open members' sign-in recovery copies.",
        `1. a fresh server with no recovery code sends a readable backup over HTTPS, flagged not locked (${JSON.stringify(mc?.beforeCode)})`);
    assert(mc?.status === 200 && mc.looksLikeCode, `1. the operator manual's make-a-code request (password header, JSON body) makes a code over HTTPS (got ${mc?.status})`);
    assert(mc?.afterCode.status === 200 && !mc.afterCode.gzip && mc.afterCode.locked === 'yes', `1. …after which its backups are locked (${JSON.stringify(mc?.afterCode)})`);
    assert(rt.status === 200 && rt.body.success === true && rt.body.sealed === true && rt.body.restoredKeys === true,
        `1. the fresh server restores the sealed backup (got ${rt.status}: ${JSON.stringify(rt.body).slice(0, 200)})`);
    assert(rt.before.key !== main.key && rt.before.communityId !== main.communityId, '1. (the fresh server started with its own key and community)');
    assert(rt.after.key === main.key, '1. the node key (libp2p_key) is back, byte for byte — the same PeerId');
    assert(rt.after.communityKey === main.communityKey && rt.after.genesis === main.genesis && rt.after.communityId === main.communityId,
        '1. community.key and genesis.json are back');
    assert(rt.after.connectors === main.connectors, '1. connectors.json is back');
    assert(rt.after.adminHash === hash && rt.after.salt === salt && rt.after.totpEnabled === true && rt.after.totpSecret === 'JBSWY3DPEHPK3PXP',
        "1. the community's admin password and 2FA come back, so owners sign in with the community's credentials");
    assert(rt.after.recoveryCodeId === code.codeId, '1. the recovery code record comes back, so the server keeps locking to the same paper');
    assert(JSON.stringify(rt.after.roles) === JSON.stringify(main.roles), '1. the roles are back');
    assert(rt.after.members === main.members && rt.after.marker, '1. the database is back (members, and the marker row)');
    assert(rt.after.leftovers.length === 0, `1. no restore temp files left (${rt.after.leftovers.join(', ')})`);
    assert(rt.before.sealKey && rt.before.sealKey !== mainSealKey && rt.after.sealKey === mainSealKey && rt.after.sealKeyMode === '600',
        "1. S2: the restore installs the community's recovery-seal key, byte for byte, 0600 (the fresh server had made its own)");
    const keptOwn = Object.values(rt.after.retired as Record<string, { sha: string; mode: string }>);
    assert(keptOwn.length === 1 && keptOwn[0].sha === rt.before.sealKey && keptOwn[0].mode === '600',
        "1. S2: …and keeps the fresh server's own key beside it, never lost");
    assert(rt.body.recoverySeal?.copies === 1 && rt.body.recoverySeal.open === 1 && rt.body.recoverySeal.carriedKey === true
        && /\[Restore\] 🔐 The sign-in recovery copy in this backup opens on this server\./.test(rt.logs),
        `1. S2: the restore says the sign-in copy in it opens here (${JSON.stringify(rt.body.recoverySeal)})`);
    const rec1 = rt.afterRestart?.recovered;
    assert(rec1?.released.status === 200 && rec1.released.body?.enough === true && rec1.seedHex === dee.seedHex
        && JSON.stringify(rec1.words) === JSON.stringify(dee.words) && rt.afterRestart.sealKey === mainSealKey,
        `1. S2: after the restart, a device with only @Dee's sign-in recovers their seed and 12 words over HTTPS (${rec1?.released.status} ${rec1?.error ?? 'opened'})`);
    assert(!/cannot be opened here/.test(rt.afterRestart.logs), '1. S2: …and the restarted server names no copy it cannot open');

    // ── 2. A legacy plain tar still restores ──
    console.log('\n— 2. legacy .tar.gz —');
    const legacyDir = path.join(work, 'legacy');
    fs.mkdirSync(legacyDir);
    const snapPath = path.join(legacyDir, 'state.db');
    db.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
    const photoObject = crypto.randomBytes(2200);
    const cipherObject = crypto.randomBytes(1400);
    const objectMembers = [
        { name: './images/posts/p-restore/0-11223344.jpg', content: photoObject },
        { name: './images/attachments/m-restore.bin', content: cipherObject },
    ];
    const objectShas = {
        'posts/p-restore/0-11223344.jpg': sha(photoObject),
        'attachments/m-restore.bin': sha(cipherObject),
    };
    // The database in the archive REFERENCES both objects, because that is the only kind of archive whose
    // shortfall means anything: a restore now counts what it lacks off the restored `storage_key`s rather
    // than trusting the archive's label (routes/backup.ts `missingAfterRestore`). A fixture whose rows name
    // nothing is complete however many objects are stripped out of it, and would prove nothing below.
    {
        const Database = (await import('better-sqlite3')).default;
        const seed = new Database(snapPath);
        // As the node itself runs (db.ts: `foreign_keys = OFF`, an accepted risk documented there), so these
        // two rows do not need a `posts` and a `messages` row invented for them.
        seed.pragma('foreign_keys = OFF');
        seed.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, storage_key, sha256, bytes, mime)
                      VALUES (?, NULL, 0, ?, ?, ?, 'image/jpeg')`)
            .run('p-restore', 'posts/p-restore/0-11223344.jpg', sha(photoObject), photoObject.length);
        seed.prepare(`INSERT INTO message_attachments (message_id, data, nonce, mime, storage_key)
                      VALUES (?, NULL, 'nonce-v1', 'image/jpeg', ?)`)
            .run('m-restore', 'attachments/m-restore.bin');
        seed.close();
    }
    const legacyTar = makeTarGz([
        { name: './state.db', content: fs.readFileSync(snapPath) },
        { name: './node_config.json', content: Buffer.from('{}') },
        // A plain archive's keys are never installed, even when it carries a bundle.
        { name: './takeover-bundle.json', content: Buffer.from(JSON.stringify({ v: 1, files: {}, localConfig: {} })) },
        ...objectMembers,
    ]);
    const legacyFile = path.join(work, 'legacy.tar.gz');
    fs.writeFileSync(legacyFile, legacyTar);
    const lg = runChild('legacy', legacyFile);
    assert(lg.status === 200 && lg.body.success === true && lg.body.sealed === false && lg.body.restoredKeys === false,
        `2. a legacy plain backup still restores (got ${lg.status}: ${JSON.stringify(lg.body).slice(0, 200)})`);
    assert(lg.after.members === main.members && lg.after.marker, '2. …its database is restored');
    assert(lg.after.key === lg.before.key && lg.after.communityId === lg.before.communityId, "2. …and the fresh server keeps its own keys (a plain archive's are never installed)");
    const sameShas = (a: Record<string, string>, b: Record<string, string>) => {
        const ka = Object.keys(a).sort();
        const kb = Object.keys(b).sort();
        return ka.join('|') === kb.join('|') && ka.every(k => a[k] === b[k]);
    };
    assert(sameShas(lg.after.images || {}, objectShas),
        `2. …and its image objects are back on the disk, byte for byte (${Object.keys(lg.after.images || {}).join(', ')})`);
    assert(lg.body.complete === true && lg.body.images?.restored === 2 && lg.body.images?.missing === 0 && !lg.body.warning,
        `2. …and the answer says the restore came back whole (${JSON.stringify(lg.body.images)})`);
    assert(lg.body.images?.referenced === 2,
        `2. …having actually counted the objects the restored database references (${lg.body.images?.referenced})`);

    // ── 2b. A SHORT backup says so in the answer, not at the first 503 ──
    //
    // The manifest inside the archive is the label that outlives the response headers, and this is the
    // moment it was written for. Before this, a restore read `state.db`, called restoreImages and answered
    // `success: true` whatever came back; the manifest sat in the temp directory until it was deleted.
    console.log('\n— 2b. a short backup, restored —');
    const shortTar = makeTarGz([
        { name: './state.db', content: fs.readFileSync(snapPath) },
        { name: './node_config.json', content: Buffer.from('{}') },
        objectMembers[0],
        {
            name: './missing-images.json',
            content: Buffer.from(JSON.stringify({
                note: 'This backup is SHORT.', takenAt: '2026-09-24T01:02:03.000Z',
                referenced: 2, staged: 1, missing: ['attachments/m-restore.bin'],
            })),
        },
    ]);
    const shortFile = path.join(work, 'short.tar.gz');
    fs.writeFileSync(shortFile, shortTar);
    const sh = runChild('legacy', shortFile);
    assert(sh.status === 200 && sh.body.success === true,
        `2b. a short backup still restores — the database is in and the node restarts (${sh.status})`);
    assert(sh.body.complete === false && sh.body.images?.missing === 1
        && sh.body.images?.missingKeys?.[0] === 'attachments/m-restore.bin',
        `2b. …and the answer is NOT a plain success: it names what is missing (${JSON.stringify(sh.body.images)})`);
    assert(typeof sh.body.warning === 'string' && /SHORT/i.test(sh.body.warning),
        `2b. …in words the Backup tab and the fleet manager can show ("${sh.body.warning}")`);
    assert(sh.body.images?.restored === 1
        && sh.after.images['posts/p-restore/0-11223344.jpg'] === objectShas['posts/p-restore/0-11223344.jpg']
        && !sh.after.images['attachments/m-restore.bin'],
        '2b. …and the object it DID carry went back byte for byte, while the missing one is simply absent');
    assert(sh.body.images?.labelledShort === true && sh.body.images?.referenced === 2,
        `2b. …with the manifest recorded as the EXPLANATION beside the measured counts (${JSON.stringify(sh.body.images)})`);

    // ── 2c. An archive with no images/ at all reports its real shortfall, label or no label ──
    //
    // The hole the round-3 review found: `complete` trusted the manifest, so an archive with no `images/`
    // member and no `missing-images.json` — a `databaseOnly` backup, or one whose `images/` was stripped in
    // transit — was indistinguishable from a pre-version backup. It answered `complete: true, missing: 0`
    // over a database whose every `storage_key` pointed at nothing, and the operator found out at the first
    // 503. The count now comes from the restored data: `referencedStorageKeys` on the state.db that is on
    // disk, against the store beside it.
    console.log('\n— 2c. an archive whose images/ never arrived —');
    const strippedTar = makeTarGz([
        { name: './state.db', content: fs.readFileSync(snapPath) },
        { name: './node_config.json', content: Buffer.from('{}') },
    ]);
    const strippedFile = path.join(work, 'stripped.tar.gz');
    fs.writeFileSync(strippedFile, strippedTar);
    const st = runChild('legacy', strippedFile);
    assert(st.status === 200 && st.body.success === true,
        `2c. the database still restores, and the node still restarts (${st.status})`);
    assert(st.body.complete === false,
        `2c. …but the answer is NOT complete, though the archive carried no label at all (${JSON.stringify(st.body.images)})`);
    assert(st.body.images?.missing === 2 && st.body.images?.referenced === 2 && st.body.images?.labelledShort === false,
        `2c. …and the shortfall is MEASURED off the restored database, not read off a manifest (${JSON.stringify(st.body.images)})`);
    assert(Array.isArray(st.body.images?.missingKeys)
        && st.body.images.missingKeys.includes('attachments/m-restore.bin')
        && st.body.images.missingKeys.includes('posts/p-restore/0-11223344.jpg'),
        `2c. …naming the keys that will 503 (${JSON.stringify(st.body.images?.missingKeys)})`);
    assert(typeof st.body.warning === 'string' && /did not carry/i.test(st.body.warning),
        `2c. …in words that say the archive never had them, rather than blaming the node ("${st.body.warning}")`);

    // A pre-version backup is the case that MUST still read as complete: its photos are inline in the rows
    // it brought, so it references no storage_key and lacks nothing. Measuring, not labelling, is what tells
    // it apart from the stripped archive above — the two are byte-identical in shape.
    console.log('\n— 2d. a pre-version backup is complete, and measures as complete —');
    const inlineDb = path.join(work, 'inline-state.db');
    fs.copyFileSync(snapPath, inlineDb);
    {
        const Database = (await import('better-sqlite3')).default;
        const legacyShape = new Database(inlineDb);
        legacyShape.pragma('foreign_keys = OFF');
        legacyShape.prepare('UPDATE post_photos SET storage_key = NULL, photo_data = ?')
            .run(`data:image/jpeg;base64,${photoObject.toString('base64')}`);
        legacyShape.prepare('UPDATE message_attachments SET storage_key = NULL, data = ?')
            .run(cipherObject.toString('base64'));
        legacyShape.close();
    }
    const inlineFile = path.join(work, 'inline.tar.gz');
    fs.writeFileSync(inlineFile, makeTarGz([
        { name: './state.db', content: fs.readFileSync(inlineDb) },
        { name: './node_config.json', content: Buffer.from('{}') },
    ]));
    const inl = runChild('legacy', inlineFile);
    assert(inl.status === 200 && inl.body.complete === true && inl.body.images?.missing === 0
        && inl.body.images?.referenced === 0 && !inl.body.warning,
        `2d. a backup from before the image store restores COMPLETE — it references no objects (${JSON.stringify(inl.body.images)})`);

    // ── This process as the restoring server, for the refusals (nothing below reaches the database swap) ──
    const { server, base } = await serveBackupRoutes();
    const restore = async (bytes: Buffer, headers: Record<string, string> = {}) => {
        resetAdminAuthTarpit();
        const res = await fetch(base + '/api/local/admin/restore', {
            method: 'POST', headers: { 'X-Admin-Password': PW, 'Content-Type': 'application/octet-stream', ...headers }, body: new Uint8Array(bytes),
        });
        return { status: res.status, body: await res.json() as any };
    };
    const liveMembers = () => (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c;
    const membersBefore = liveMembers();
    const noLeftovers = () => fs.readdirSync(dataDir!).filter((f) => f.startsWith('.restore') || f.startsWith('uploaded-backup'));

    /** Seal a tar exactly as the node does: its own key signs, locked to the owner and the code. */
    const sealAsNode = async (payload: Buffer, opts: { signingKey?: Uint8Array; nodePeerId?: string; kind?: 'backup' | 'takeover' } = {}) => {
        const peerId = opts.nodePeerId ?? peerIdFromPrivateKey(privateKeyFromProtobuf(nodeKeyBytes)).toString();
        return Buffer.from(await core.sealEnvelope(new Uint8Array(payload), {
            kind: opts.kind ?? 'backup', communityId: main.communityId, nodePeerId: peerId,
            recipients: { owners: [{ pubkey: ownerPub, callsign: 'Olive' }], codes: [(await import('./config/local-config.js')).getLocalConfig().recoveryCode as any] },
            signingKey: opts.signingKey ?? nodeSeed,
        }));
    };

    // ── 2e. S2: a plain backup never carries the recovery-seal key ──
    console.log('\n— 2e. S2: a plain backup carries no recovery-seal key —');
    {
        const { createPlainBackup } = await import('./services/sealed-backup.js');
        const plain = await createPlainBackup();
        const parts: Buffer[] = [];
        for await (const c of plain.body) parts.push(c as Buffer);
        const plainFile = path.join(work, 'plain.tar.gz');
        fs.writeFileSync(plainFile, Buffer.concat(parts));
        const listing = spawnSync('tar', ['-tzf', plainFile], { encoding: 'utf-8' }).stdout.split('\n').filter(Boolean);
        assert(listing.some((n) => /state\.db$/.test(n)) && !listing.some((n) => /recovery-seal/.test(n) || /takeover-bundle/.test(n)),
            `2e. the plain backup tar lists no recovery-seal.key (and no take-over bundle): ${listing.filter((n) => !n.startsWith('./images')).join(', ')}`);
        const out = path.join(work, 'plain-out');
        fs.mkdirSync(out);
        spawnSync('tar', ['-xzf', plainFile, '-C', out]);
        const needles = [mainSealKeyBytes, Buffer.from(mainSealKeyBytes.toString('base64')), Buffer.from(mainSealKeyBytes.toString('hex'))];
        const hits: string[] = [];
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p);
                else if (needles.some((n) => fs.readFileSync(p).includes(n))) hits.push(path.relative(out, p));
            }
        };
        walk(out);
        assert(hits.length === 0 && !fs.readFileSync(plainFile).includes(mainSealKeyBytes), `2e. …and no file in it holds the key's bytes, in any form (${hits.join(', ') || 'none'})`);
        const pr = runChild('legacy', plainFile, undefined, { thenRecover: true });
        assert(pr.status === 200 && pr.body.success === true && pr.body.sealed === false, `2e. the plain backup restores (${pr.status})`);
        const NO_KEY_LINE = "No recovery-seal key in this backup: members' sign-in copies will not open on this server until they reconnect. Their 12 words still work.";
        assert(pr.body.recoverySeal?.copies === 1 && pr.body.recoverySeal.open === 0 && pr.body.recoverySeal.carriedKey === false
            && pr.logs.includes(`[Restore] ⚠️ ${NO_KEY_LINE} The sign-in recovery copy in it will not open on this server.`),
            `2e. the restore from it logs the missing-key line, and says the copy will not open (${JSON.stringify(pr.body.recoverySeal)})`);
        assert(pr.after.sealKey === pr.before.sealKey && Object.keys(pr.after.retired).length === 0,
            "2e. …and the fresh server keeps its own key: nothing came to replace it");
        const rec2 = pr.afterRestart?.recovered;
        assert(rec2?.seedHex === null && rec2.released.body?.enough !== true && /cannot be opened here/.test(pr.afterRestart.logs),
            `2e. after the restart @Dee's copy does not open there, and its boot says so (${rec2?.released.status})`);
    }

    // ── 3. Hostile archives, through the sealed path ──
    console.log('\n— 3. the hostile-archive suite, sealed —');
    const escapeName = `sealed-escape-${process.pid}`;
    const outside = path.join(path.dirname(dataDir!), escapeName);
    const hostile: [string, Buffer, RegExp][] = [
        ['a ../ member', makeTarGz([{ name: './state.db', content: Buffer.from('x') }, { name: `../${escapeName}`, content: Buffer.from('pwned') }]), /unsafe member path/],
        ['a symlink member', makeTarGz([{ name: './state.db', type: '2', link: '/etc/passwd' }]), /links are not permitted/],
        ['a hardlink member', makeTarGz([{ name: './a', content: Buffer.from('x') }, { name: './state.db', type: '1', link: './a' }]), /links are not permitted/],
        ['an absolute member', makeTarGz([{ name: './state.db', content: Buffer.from('x') }, { name: outside, content: Buffer.from('pwned') }]), /unsafe member path|links are not permitted|state\.db missing|Restore failed/],
    ];
    for (const [what, tarGz, why] of hostile) {
        const r = await restore(await sealAsNode(tarGz), { 'X-Recovery-Code': code.code });
        assert(r.status === 500 && why.test(r.body.error || ''), `3. ${what}, sealed and signed by the node itself, is refused (got ${r.status}: ${r.body.error})`);
        assert(!fs.existsSync(outside), `3. ${what}: nothing was written outside the data dir`);
        assert(noLeftovers().length === 0, `3. ${what}: the upload and extraction folder are removed`);
    }
    // The absolute member: whatever tar does with it (list with or without the slash), it must not land at the path.
    assert(!fs.existsSync(outside), '3. no hostile member escaped');
    assert(liveMembers() === membersBefore, '3. the live database is untouched by every refused archive');

    // ── 4. The code ──
    console.log('\n— 4. the recovery code —');
    const noCode = await restore(backupBytes);
    assert(noCode.status === 400 && noCode.body.needsRecoveryCode === true && new RegExp(`#${code.codeId}`).test(noCode.body.error)
        && /@Olive/.test(noCode.body.backup?.opensWith || ''), `4. no code: 400 naming the code number and who can open it (${noCode.body.error} / ${noCode.body.backup?.opensWith})`);
    const body = code.code.split(/\s+/)[1];
    const typoCode = `BPRC-${code.codeId} ${body.slice(0, -1)}${body.endsWith('0') ? '1' : '0'}`;
    const typo = await restore(backupBytes, { 'X-Recovery-Code': typoCode });
    assert(typo.status === 400 && typo.body.typo === true, `4. a typo: 400, "check what you typed" (${typo.body.error})`);
    const zero = await restore(backupBytes, { 'X-Recovery-Code': `BPRC-0 ${body}` });
    assert(zero.status === 400 && zero.body.typo === true, `4. code number 0: a typo too (${zero.body.error})`);
    const otherNumber = await restore(backupBytes, { 'X-Recovery-Code': `BPRC-${code.codeId + 5} ${body}` });
    assert(otherNumber.status === 400 && otherNumber.body.wrongCodeNumber === true, `4. the wrong code number: 400 naming the right one (${otherNumber.body.error})`);
    const stranger = (await core.createRecoveryCode(code.codeId)).code;
    const wrong = await restore(backupBytes, { 'X-Recovery-Code': stranger });
    assert(wrong.status === 403 && wrong.body.wrongCode === true, `4. a well-formed wrong code: 403 (${wrong.body.error})`);
    const envelope = await getSealedTakeoverEnvelope();
    assert(envelope.envelopeId !== null, 'setup: a take-over envelope exists');
    const takeoverAsBackup = await restore((envelope as any).bytes, { 'X-Recovery-Code': code.code });
    assert(takeoverAsBackup.status === 400 && /take-over envelope, not a backup/.test(takeoverAsBackup.body.error), '4. a take-over envelope is refused as a backup');
    const cut = await restore(backupBytes.subarray(0, backupBytes.length - 100), { 'X-Recovery-Code': code.code });
    assert(cut.status === 400 && /altered or cut short/.test(cut.body.error), `4. a cut-short file: 400 (${cut.body.error})`);
    const garbage = await restore(Buffer.from('not a backup at all'));
    assert(garbage.status === 400 && /not a BeanPool backup/.test(garbage.body.error), '4. a file that is neither: 400');
    assert(liveMembers() === membersBefore && noLeftovers().length === 0, '4. nothing was restored and nothing left behind');

    // ── 5. The signature, against this server's pin ──
    console.log('\n— 5. who signed it —');
    const forgerKey = await generateKeyPair('Ed25519');
    const forgerPeer = peerIdFromPrivateKey(forgerKey).toString();
    const forged = await sealAsNode(Buffer.from('not even a tar'), { signingKey: new Uint8Array(forgerKey.raw.subarray(0, 32)), nodePeerId: forgerPeer });
    const pinned = await restore(forged, { 'X-Recovery-Code': code.code });
    assert(pinned.status === 409 && pinned.body.signerNotPinned === true && pinned.body.signer === forgerPeer,
        `5. a file of this community signed by another key is refused 409, naming the signer (got ${pinned.status})`);
    const confirmed = await restore(forged, { 'X-Recovery-Code': code.code, 'X-Accept-Signer': forgerPeer });
    assert(confirmed.status === 500 && /Restore failed/.test(confirmed.body.error),
        `5. confirming that signer by name passes the pin, and the next check (the archive) still applies (got ${confirmed.status}: ${confirmed.body.error})`);
    const wrongConfirm = await restore(forged, { 'X-Recovery-Code': code.code, 'X-Accept-Signer': 'someone-else' });
    assert(wrongConfirm.status === 409, '5. confirming a different signer does not');
    // A header that names the node but was signed by someone else: altered.
    const lying = await sealAsNode(Buffer.from('x'), { signingKey: new Uint8Array(forgerKey.raw.subarray(0, 32)) });
    const lie = await restore(lying, { 'X-Recovery-Code': code.code });
    assert(lie.status === 400 && lie.body.badSignature === true, `5. a signature that does not match the server it names: 400 (got ${lie.status})`);
    assert(liveMembers() === membersBefore && noLeftovers().length === 0, '5. nothing was restored and nothing left behind');

    // ── 6. Accepted by its signer's name: the database only, never the bundle (seal review round 1, #2) ──
    // Anyone who has seen a header can lock a tar to the same recovery code and sign it with their own key, with a
    // bundle whose node key is that same key and whose genesis names this community: every bundle check passes.
    // Naming the signer must still not install that key, nor the admin password inside. Last: it swaps the database.
    console.log('\n— 6. X-Accept-Signer restores the database only —');
    const { writeDbSnapshot } = await import('./services/snapshot-scheduler.js');
    const snapDb = path.join(work, 'forged-state.db');
    writeDbSnapshot(snapDb);
    const forgedBundle = {
        v: 1,
        files: {
            libp2p_key: Buffer.from(privateKeyToProtobuf(forgerKey)).toString('base64'),
            'community.key': Buffer.from('forged-community-key').toString('base64'),
            'genesis.json': Buffer.from(JSON.stringify({ communityId: main.communityId, forged: true })).toString('base64'),
            'connectors.json': null,
        },
        localConfig: { adminHash: 'forged-hash', salt: 'forged-salt', totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], breakGlassMode: null },
        nodeRoles: [], publicAddress: null, recoveryCode: null,
    };
    const forgedTar = makeTarGz([
        { name: './state.db', content: fs.readFileSync(snapDb) },
        { name: './node_config.json', content: Buffer.from('{}') },
        { name: './takeover-bundle.json', content: Buffer.from(JSON.stringify(forgedBundle)) },
    ]);
    const forgedFull = await sealAsNode(forgedTar, { signingKey: new Uint8Array(forgerKey.raw.subarray(0, 32)), nodePeerId: forgerPeer });
    const keyBefore = sha(fs.readFileSync(path.join(dataDir!, 'libp2p_key')));
    const communityKeyBefore = sha(fs.readFileSync(path.join(dataDir!, 'community.key')));
    const genesisBefore = sha(fs.readFileSync(path.join(dataDir!, 'genesis.json')));
    const configBefore = JSON.parse(fs.readFileSync(path.join(dataDir!, 'local-config.json'), 'utf-8'));
    const byName = await restore(forgedFull, { 'X-Recovery-Code': code.code, 'X-Accept-Signer': forgerPeer });
    assert(byName.status === 200 && byName.body.success === true && byName.body.restoredKeys === false && byName.body.keysIgnored === true,
        `6. accepted by name: the database comes back, the keys inside are ignored (got ${byName.status}: ${JSON.stringify(byName.body).slice(0, 200)})`);
    assert(sha(fs.readFileSync(path.join(dataDir!, 'libp2p_key'))) === keyBefore
        && sha(fs.readFileSync(path.join(dataDir!, 'community.key'))) === communityKeyBefore
        && sha(fs.readFileSync(path.join(dataDir!, 'genesis.json'))) === genesisBefore,
        "6. …this server's node key, community key and genesis are untouched");
    const configAfter = JSON.parse(fs.readFileSync(path.join(dataDir!, 'local-config.json'), 'utf-8'));
    assert(configAfter.adminHash === configBefore.adminHash && configAfter.salt === configBefore.salt && configAfter.adminHash !== 'forged-hash',
        '6. …and so is its admin password');
    assert(sha(fs.readFileSync(path.join(dataDir!, 'state.db'))) === sha(fs.readFileSync(snapDb)), '6. …while the database itself was restored');

    server.close();
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`\n🎉 All ${testsPassed}/${testsRun} sealed-backup checks PASSED!\n`);
    process.exit(0);
}

(IS_CHILD ? child() : main()).catch((err) => {
    console.error('❌ Test suite failed with error:', err);
    process.exit(1);
});
