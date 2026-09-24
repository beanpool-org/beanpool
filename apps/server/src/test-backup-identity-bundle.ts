/**
 * Test Suite: the identity bundle is gone, and with a recovery code no backup leaves unlocked — under ANY credential.
 *
 * Sealed keys slice 3 (sealed-keys.md §6.1). Until slice 0 this suite asserted the replication token got the plain
 * identity bundle (that encoded the leak); slice 0 made it owner/admin only; slice 3 deletes the route: the node
 * keys now travel only inside the sealed backup. Over real HTTP, for every credential the node accepts —
 * none, a wrong token, the replication token, the admin password, password + 2FA code, an owner's key session and
 * an admin's key session:
 *
 *  1. POST /api/local/admin/identity-bundle is 404, and never a gzip body.
 *  2. With a recovery code, POST /api/local/admin/backup and GET /api/local/admin/snapshots/download are either
 *     refused or a `bpsealed/v1` backup envelope marked X-Backup-Locked: yes; no body starts with gzip magic.
 *  3. The take-over envelope and backup-enroll never start with gzip magic either; backup-enroll carries no
 *     communityKey (it is public material only).
 *  4. Without a recovery code (no owner; then an owner but still no code — the live nodes' likely state) a backup
 *     cannot be locked to anything that ships an opener, so /backup and the snapshot download send the readable
 *     format they always did — the tar.gz of state.db + node_config.json (no keys, no bundle), the raw snapshot —
 *     flagged X-Backup-Locked: no with "Backups are not locked yet: make a recovery code to lock them", and
 *     /backup-status says the same in backupLock (seal review round 1). With a code, 2. holds: every one locked.
 *  5. The token still gets sync-snapshot and sync-delta (unchanged).
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-backup-identity-bundle.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { readSealedHeader } from '@beanpool/core';
import { initStateEngine, seedGenesisMember, grantNodeRole } from './state-engine.js';
import { db } from './db/db.js';
import { ensureGenesis } from './genesis.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { generateTotpSecret, generateTotpCode } from './totp.js';
import { createBackupRoutes } from './routes/backup.js';
import { createTakeoverEnvelopeRoutes } from './routes/takeover-envelope.js';
import { startP2P } from './p2p.js';
import { updateLocalConfig, setReplicationToken } from './config/local-config.js';
import { checkAdminAuth, resetAdminAuthTarpit } from './admin-auth.js';
import { createSnapshot } from './services/snapshot-scheduler.js';
import { makeRecoveryCode } from './services/takeover-envelope.js';
import type { RouteDeps } from './routes/types.js';

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

const deps: RouteDeps = {
    checkAdminAuth: async (ctx: any) => checkAdminAuth(ctx),
    rateLimit: () => true,
    clampLimit: (_v: unknown, def = 20) => def,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
};

const isGzip = (b: Buffer) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

async function runSuite() {
    console.log('📦 Running the no-plain-backup-under-any-credential suite...\n');

    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR environment variable is set');

    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const p2pNode = await startP2P(0, 0); // signs sync-snapshot / sync-delta (loads the key written above)

    const testPass = 'IdentityBundleSecret123!';
    const salt = crypto.randomBytes(16).toString('hex');
    const adminHash = crypto.scryptSync(testPass, salt, 64).toString('hex');
    updateLocalConfig({ adminHash, salt, totpEnabled: false, totpSecret: null });
    const repToken = 'rep-token-secret-999';
    setReplicationToken(repToken);
    const snap = createSnapshot();

    const app = new Koa();
    app.use(createBackupRoutes(deps).routes());
    app.use(createTakeoverEnvelopeRoutes(deps as any).routes());
    const server = http.createServer(app.callback());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    async function hit(method: string, route: string, headers: Record<string, string>) {
        resetAdminAuthTarpit();
        const res = await fetch(base + route, { method, headers });
        const body = Buffer.from(await res.arrayBuffer());
        return { status: res.status, body, type: res.headers.get('content-type') || '', headers: res.headers };
    }

    // Owners and admins for the key sessions (2FA on for key sign-in, as the product requires for admins).
    const makeKeypair = () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        return { privateKey, pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
    };
    const owner = makeKeypair();
    const admin = makeKeypair();

    // ── 4. No recovery code: readable, as before, and flagged not locked ──
    const NOT_LOCKED = 'Backups are not locked yet: make a recovery code to lock them.';
    const tarMembers = (buf: Buffer): string[] => {
        const f = path.join(dataDir!, `.t-${crypto.randomBytes(4).toString('hex')}.tar.gz`);
        fs.writeFileSync(f, buf);
        try { return execFileSync('tar', ['-tzf', f], { encoding: 'utf-8' }).split('\n').map(x => x.trim().replace(/^\.\//, '')).filter(x => x && x !== '.'); }
        finally { fs.rmSync(f, { force: true }); }
    };
    const readableNoCode = async (stage: string) => {
        for (const [who, headers] of [['token', { 'x-replication-token': repToken }], ['admin password', { 'x-admin-password': testPass }]] as const) {
            const r = await hit('POST', '/api/local/admin/backup', headers);
            assert(r.status === 200 && isGzip(r.body) && r.type === 'application/gzip',
                `4. ${stage}: /backup under the ${who} is the readable tar.gz, as before (got ${r.status}, ${r.type})`);
            assert(r.headers.get('x-backup-locked') === 'no' && r.headers.get('x-backup-not-locked') === NOT_LOCKED,
                `4. ${stage}: …flagged X-Backup-Locked: no, "${r.headers.get('x-backup-not-locked')}" (${who})`);
            const members = tarMembers(r.body).sort();
            assert(JSON.stringify(members) === JSON.stringify(['node_config.json', 'state.db']),
                `4. ${stage}: …holding state.db and node_config.json only — no keys, no bundle (${members.join(', ')})`);
        }
        // This used to assert the snapshot download WAS the snapshot file — 'SQLite format 3' and nothing
        // else. That is the shape the deciding pass refused: since the images left state.db, a bare .db is a
        // database whose every photo is a storage_key pointing at bytes the download does not carry, and it
        // restores an empty gallery without saying a word. Unlocked, the snapshot now leaves as the same
        // readable tar.gz /backup sends — state.db, node_config.json and the objects that database
        // references — and is still flagged not locked, which is what this check is here to hold.
        const sd = await hit('GET', `/api/local/admin/snapshots/download?name=${encodeURIComponent(snap.name)}`, { 'x-admin-password': testPass });
        assert(sd.status === 200 && isGzip(sd.body) && sd.headers.get('x-backup-locked') === 'no',
            `4. ${stage}: the snapshot download is a readable archive, flagged not locked (got ${sd.status})`);
        assert(sd.headers.get('x-backup-contents') === 'database+images',
            `4. ${stage}: …and says it carries the node's images, not the database alone (${sd.headers.get('x-backup-contents')})`);
        const sdMembers = tarMembers(sd.body).sort();
        assert(sdMembers.includes('state.db'),
            `4. ${stage}: …with the snapshot inside it as state.db (${sdMembers.join(', ')})`);
        const st = await fetch(base + '/api/local/admin/backup-status', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': testPass }, body: '{}' });
        const sj: any = await st.json();
        assert(sj.backupLock?.locked === false && sj.backupLock?.message === NOT_LOCKED && sj.backupLock?.reason === 'no-recovery-code',
            `4. ${stage}: backup-status says backups are not locked, and why (${JSON.stringify(sj.backupLock)})`);
    };
    resetAdminAuthTarpit();
    await readableNoCode('no owner, no code');

    seedGenesisMember(owner.pubKeyHex, 'Olive'); // the genesis member is the owner
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
        .run(admin.pubKeyHex, 'Adam', new Date().toISOString(), owner.pubKeyHex, 'TEST');
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(admin.pubKeyHex);
    grantNodeRole(admin.pubKeyHex, 'admin', 'owner:password');
    // An owner and still no code: nothing that ships could open a file locked to the owner alone, so still readable.
    await readableNoCode('an owner, no code');
    await makeRecoveryCode();
    const locked = await hit('POST', '/api/local/admin/backup', { 'x-admin-password': testPass });
    assert(locked.status === 200 && locked.headers.get('x-backup-locked') === 'yes' && !locked.headers.get('x-backup-not-locked'),
        '4. with a recovery code: /backup is flagged X-Backup-Locked: yes');

    const totpSecret = generateTotpSecret();
    const keySession = (kp: ReturnType<typeof makeKeypair>): string => {
        const chal = createAdminChallenge();
        const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), kp.privateKey).toString('hex');
        const solved = verifyAndSolveChallenge({
            challengeId: chal.challengeId, memberPubkey: kp.pubKeyHex, signature, totpCode: generateTotpCode(totpSecret),
        });
        if (!solved.ok) throw new Error('key sign-in failed: ' + solved.error);
        const ex = consumeHandshakeToken(solved.handshakeToken!);
        if (!ex.ok) throw new Error('handshake failed: ' + ex.error);
        return ex.sessionId!;
    };

    // Every credential. 2FA is switched on for the rows that need it and off again after.
    const credentials: { name: string; headers: () => Record<string, string>; tfa?: boolean; accepted: boolean }[] = [
        { name: 'no credential', headers: () => ({}), accepted: false },
        { name: 'a wrong token', headers: () => ({ 'x-replication-token': 'not-the-token' }), accepted: false },
        { name: 'the replication token', headers: () => ({ 'x-replication-token': repToken }), accepted: true },
        { name: 'the admin password', headers: () => ({ 'x-admin-password': testPass }), accepted: true },
        { name: 'password + 2FA code', headers: () => ({ 'x-admin-password': testPass, 'x-admin-totp': generateTotpCode(totpSecret) }), tfa: true, accepted: true },
        { name: "an owner's key session", headers: () => ({ 'x-admin-session': keySession(owner) }), tfa: true, accepted: true },
        { name: "an admin's key session", headers: () => ({ 'x-admin-session': keySession(admin) }), tfa: true, accepted: true },
        { name: 'token + admin password', headers: () => ({ 'x-replication-token': repToken, 'x-admin-password': testPass }), accepted: true },
    ];

    for (const cred of credentials) {
        updateLocalConfig(cred.tfa ? { totpEnabled: true, totpSecret } : { totpEnabled: false, totpSecret: null });
        const h = cred.headers;

        const id = await hit('POST', '/api/local/admin/identity-bundle', h());
        assert(id.status === 404 && !isGzip(id.body), `1. identity-bundle under ${cred.name}: 404, no gzip (got ${id.status})`);

        const bk = await hit('POST', '/api/local/admin/backup', h());
        assert(!isGzip(bk.body), `2. /backup under ${cred.name}: the body does not start with gzip magic (status ${bk.status})`);
        if (bk.status === 200) {
            assert(bk.type === 'application/octet-stream' && readSealedHeader(new Uint8Array(bk.body)).kind === 'backup', `2. /backup under ${cred.name}: a sealed backup`);
        }
        const tokenCanBackup = cred.name.includes('token') && !cred.name.includes('wrong');
        assert((bk.status === 200) === (cred.accepted || tokenCanBackup), `2. /backup under ${cred.name}: ${cred.accepted ? 'accepted' : 'refused'} (got ${bk.status})`);

        const sd = await hit('GET', `/api/local/admin/snapshots/download?name=${encodeURIComponent(snap.name)}`, h());
        assert(!isGzip(sd.body), `2. snapshot download under ${cred.name}: no gzip magic (status ${sd.status})`);
        if (sd.status === 200) {
            assert(readSealedHeader(new Uint8Array(sd.body)).kind === 'backup' && !sd.body.includes(Buffer.from('SQLite format 3')),
                `2. snapshot download under ${cred.name}: sealed, no SQLite file in the clear`);
        }

        const te = await hit('GET', '/api/local/admin/takeover-envelope', h());
        assert(!isGzip(te.body), `3. take-over envelope under ${cred.name}: no gzip magic (status ${te.status})`);

        const en = await hit('GET', '/api/local/admin/backup-enroll', h());
        assert(!isGzip(en.body), `3. backup-enroll under ${cred.name}: no gzip magic (status ${en.status})`);
        if (en.status === 200) {
            const j = JSON.parse(en.body.toString());
            assert(!('communityKey' in j) && !en.body.includes(fs.readFileSync(path.join(dataDir!, 'community.key')).toString('base64')),
                `3. backup-enroll under ${cred.name}: no communityKey, public material only`);
        }
    }
    updateLocalConfig({ totpEnabled: false, totpSecret: null });

    // ── 5. The token still copies the database ──
    for (const route of ['/api/local/admin/sync-snapshot', '/api/local/admin/sync-delta']) {
        const r = await hit('GET', route, { 'x-replication-token': repToken });
        assert(r.status === 200 && !!JSON.parse(r.body.toString()).signature, `5. ${route} with the token answers 200 with a signed payload (got ${r.status})`);
    }

    await new Promise<void>((r) => server.close(() => r()));
    await p2pNode.stop();
    console.log(`\n🎉 All ${testsPassed}/${testsRun} checks PASSED!\n`);
    process.exit(0);
}

runSuite().catch((err) => {
    console.error('❌ Test suite failed with error:', err);
    process.exit(1);
});
