/**
 * Test Suite: the open door's record survives a standby, a hand promotion and a take-over (engine/open-join.ts). A
 * sign-in account that joined the main server is refused after a failover (409 already_joined), because the rows and
 * the key their hashes are made with (node_config `openJoinSalt`) travel.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), booted as index.ts boots, and the
 * joins go over REAL HTTPS through the real signature middleware (startHttpsServer in the node's process). No
 * provider is contacted: each node's Google JWKS cache is primed with a test key.
 *
 *  1. A global main server. Ada and Ben join through the door. Its sealed take-over bundle carries the key and the
 *     rows, and nothing else of the door's: no address hash; the envelope on disk holds neither in the clear.
 *  2. Its standby copies it (a force-resync): every row and the same key, and no address hash. A delta export after
 *     another join carries only that row, with the key.
 *  3. A copy of that standby promoted by hand (NODE_ROLE=primary): Ada's sign-in account, from a new key, is refused
 *     409 already_joined; the key is the main server's; a new account still joins.
 *  4. The take-over, from the bundle alone: the standby copies the main server again, then Dan joins it, the main
 *     server re-seals and the standby pulls only the envelope. The standby's copy of the door's record is then wiped (a
 *     standby that copied before this change), and the main server dies. The take-over's open-door step brings the
 *     key and the rows back from the keys: Ada is refused 409, the key is the main server's, and Dan (whom this
 *     standby never copied, so has no identity here) can join again rather than be locked out. The key is in neither
 *     the journal nor the step's detail.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-open-join-failover.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, copyDir, runNodeChild, type NodeProc } from './takeover-test-harness.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.CF_RECORD_NAME;

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Door-Failover-Main-Pw-731!';
const PW_STANDBY = 'Door-Failover-Standby-Pw-58!';
const GOOGLE_KID = 'test-open-join-failover-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';

const fingerprint = (value: string | null | undefined) =>
    value == null ? null : crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    const doorRecord = async () => {
        const { db } = await import('./db/db.js');
        const salt = (db.prepare("SELECT value FROM node_config WHERE key = 'openJoinSalt'").get() as { value?: string } | undefined)?.value ?? null;
        const rows = db.prepare('SELECT member_pubkey, join_hash, ip_hash FROM open_joins ORDER BY member_pubkey').all() as any[];
        return { salt, rows };
    };
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
            se.seedGenesisMember(Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex'), 'Anna');
            setReplicationToken(a.replicationToken);
            return { code: (await makeRecoveryCode()).code };
        },
        // The real HTTPS server, signature middleware and all, beside the harness's plain one.
        serve: async (a: { jwk: Record<string, unknown> }) => {
            const { initTls } = await import('./services/tls.js');
            const { startHttpsServer } = await import('./https-server.js');
            const sso = await import('./sso.js');
            await initTls();
            const port = await startHttpsServer(0);
            sso._resetJwksCacheForTests();
            sso._resetJwksCacheForTests('google', { keys: [a.jwk as any], expiresAt: Date.now() + 3600_000 });
            return { port };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async (a: { envelopeOnly?: boolean }) => {
            const { requestResync, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const resync = a.envelopeOnly ? null : await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            return { resync, envelope };
        },
        // Seal now, and look at what was sealed: the bundle's door record, and the envelope file as it sits on disk.
        reseal: async () => {
            const { flushTakeoverChecks, readSealingInputs, TAKEOVER_ENVELOPE_FILE } = await import('./services/takeover-envelope.js');
            const status = await flushTakeoverChecks();
            const inputs = readSealingInputs();
            const record = inputs.ok ? inputs.bundle.openJoins ?? null : null;
            const { salt, rows } = await doorRecord();
            const onDisk = fs.readFileSync(path.join(process.env.BEANPOOL_DATA_DIR!, TAKEOVER_ENVELOPE_FILE), 'utf-8');
            const bundleText = JSON.stringify(inputs.ok ? inputs.bundle : null);
            return {
                envelopeId: status.envelopeId,
                recordKeys: record ? Object.keys(record).sort() : null,
                joinFields: record ? [...new Set(record.joins.flatMap((j) => Object.keys(j)))].sort() : null,
                members: record ? record.joins.map((j) => j.memberPubkey).sort() : null,
                total: record?.total ?? null,
                saltSealed: !!salt && record?.salt === salt,
                addressHashInBundle: rows.some((r) => r.ip_hash && bundleText.includes(r.ip_hash)),
                addressHashesHere: rows.filter((r) => r.ip_hash).length,
                saltInClear: !!salt && onDisk.includes(salt),
                joinHashInClear: rows.some((r) => onDisk.includes(r.join_hash)),
            };
        },
        door: async () => {
            const { salt, rows } = await doorRecord();
            return { saltFp: fingerprint(salt), rows: rows.map((r) => ({ member: r.member_pubkey, hash: r.join_hash, ipHash: !!r.ip_hash })) };
        },
        'export-delta': async (a: { since: string }) => {
            const { exportSyncState } = await import('./state-engine.js');
            const payload = await exportSyncState('test', a.since);
            return {
                members: (payload.openJoins ?? []).map((j) => j.memberPubkey).sort(),
                fields: [...new Set((payload.openJoins ?? []).flatMap((j) => Object.keys(j)))].sort(),
                saltFp: fingerprint(payload.openJoinSalt),
            };
        },
        now: async () => new Date().toISOString(),
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        // A standby whose copies never carried the door's record: the rows and the key gone.
        'forget-door': async () => {
            const { db } = await import('./db/db.js');
            db.prepare('DELETE FROM open_joins').run();
            db.prepare("DELETE FROM node_config WHERE key = 'openJoinSalt'").run();
            return true;
        },
        progress: async () => {
            const { getTakeoverProgress, TAKEOVER_JOURNAL_FILE } = await import('./services/takeover.js');
            const { salt } = await doorRecord();
            const progress = getTakeoverProgress();
            const journal = path.join(process.env.BEANPOOL_DATA_DIR!, TAKEOVER_JOURNAL_FILE);
            const journalText = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf-8') : '';
            return {
                state: progress.state,
                step: progress.steps.find((s) => s.step === 'open-door') ?? null,
                saltInJournal: !!salt && journalText.includes(salt),
                saltInProgress: !!salt && JSON.stringify(progress).includes(salt),
            };
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
/** For a step the rest of the suite cannot run without. */
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}

const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleJwk = { ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' };

function mintGoogle(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url')}`;
}

interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

async function signedPost(port: number, id: Id, route: string, body: unknown): Promise<{ status: number; body: any }> {
    const raw = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`https://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${route}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: raw,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

/** Join through the door at `port` as `id`, signed in with the Google account `sub`. */
async function join(port: number, id: Id, sub: string, callsign: string): Promise<{ status: number; body: any }> {
    const n = await signedPost(port, id, '/api/join/sso-nonce', {});
    if (n.status !== 200) return n;
    return signedPost(port, id, '/api/join', { callsign, provider: 'google', idToken: mintGoogle(sub, n.body.nonce), nonce: n.body.nonce });
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    delete process.env.NODE_PROFILE;
    delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby'), probe: path.join(root, 'probe') };
    const nodes: NodeProc[] = [];
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pw = (p: string) => ({ 'X-Admin-Password': p });
    const GLOBAL = { NODE_PROFILE: 'global' };
    const ada = newId(), ben = newId();

    try {
        // ── 1. A global main server, two joins through the door ──
        console.log('\n— 1. a global main server; Ada and Ben join through the door —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', ...GLOBAL });
        nodes.push(main);
        const { code } = await main.send('setup-primary', { ownerSeedHex, replicationToken });
        const mainHttps = (await main.send('serve', { jwk: googleJwk })).port as number;
        const adaJoin = await join(mainHttps, ada, 'ada-google-sub', 'Ada');
        const benJoin = await join(mainHttps, ben, 'ben-google-sub', 'Ben');
        require_(adaJoin.status === 200 && benJoin.status === 200, `Ada and Ben join over HTTPS (${adaJoin.status} ${adaJoin.body?.code ?? ''}, ${benJoin.status} ${benJoin.body?.code ?? ''})`);
        const mainDoor = await main.send('door');
        require_(mainDoor.saltFp && mainDoor.rows.length === 2 && mainDoor.rows.every((r: any) => r.ipHash),
            'the main server holds two join records, each with its address hash, and the key they are hashed with');

        const sealed1 = await main.send('reseal');
        assert(JSON.stringify(sealed1.recordKeys) === JSON.stringify(['joins', 'salt', 'total'])
            && JSON.stringify(sealed1.joinFields) === JSON.stringify(['joinHash', 'joinedAt', 'memberPubkey', 'provider', 'updatedAt']),
            `the take-over bundle carries the door's key and rows, and only these fields (${JSON.stringify(sealed1.recordKeys)} ${JSON.stringify(sealed1.joinFields)})`);
        assert(sealed1.saltSealed && sealed1.total === 2 && JSON.stringify(sealed1.members) === JSON.stringify([ada.pk, ben.pk].sort()),
            'it holds the key and both joins');
        assert(sealed1.addressHashesHere === 2 && !sealed1.addressHashInBundle, 'no address hash is in the bundle, though the main server holds two');
        assert(!sealed1.saltInClear && !sealed1.joinHashInClear, 'the envelope on disk holds neither the key nor a join hash in the clear');

        // ── 2. The standby copies it ──
        console.log('\n— 2. its standby copies it —');
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...GLOBAL });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const pulled = await standby.send('pull', {});
        require_(pulled.resync?.ok && pulled.envelope === 'stored', `the standby copied the main server and holds its keys (${JSON.stringify(pulled)})`);
        const copied = await standby.send('door');
        assert(copied.saltFp === mainDoor.saltFp, 'the standby holds the main server\'s key for the door\'s hashes, the same key');
        assert(JSON.stringify(copied.rows.map((r: any) => [r.member, r.hash])) === JSON.stringify(mainDoor.rows.map((r: any) => [r.member, r.hash])),
            'and every join record, the same hashes');
        assert(copied.rows.every((r: any) => !r.ipHash), 'and no address hash: the limiter\'s, not the standby\'s');

        const since = await main.send('now');
        const eve = newId();
        const eveJoin = await join(mainHttps, eve, 'eve-google-sub', 'Eve');
        assert(eveJoin.status === 200, `Eve joins (${eveJoin.status})`);
        const delta = await main.send('export-delta', { since });
        assert(JSON.stringify(delta.members) === JSON.stringify([eve.pk]) && delta.saltFp === mainDoor.saltFp,
            `a delta export since then carries Eve's row alone, and the key (${JSON.stringify(delta.members.map((m: string) => m.slice(0, 8)))})`);
        assert(!delta.fields.includes('ipHash') && !delta.fields.includes('ip_hash'), 'and no address hash');

        // ── 3. A copy of the standby promoted by hand ──
        console.log('\n— 3. a copy of the standby promoted by hand —');
        await standby.send('checkpoint');
        copyDir(dirs.standby, dirs.probe);
        const probe = await spawnNode(SCRIPT, dirs.probe, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'primary', ...GLOBAL });
        nodes.push(probe);
        require_(probe.ready.role === 'primary', 'it starts as a main server');
        const probeHttps = (await probe.send('serve', { jwk: googleJwk })).port as number;
        const adaAgain = await join(probeHttps, newId(), 'ada-google-sub', 'Ada two');
        assert(adaAgain.status === 409 && adaAgain.body?.code === 'already_joined',
            `Ada's Google account, from a new key: refused, 409 already_joined (${adaAgain.status} ${adaAgain.body?.code})`);
        assert((await probe.send('door')).saltFp === mainDoor.saltFp, 'the key for the door\'s hashes is the main server\'s');
        const newcomer = await join(probeHttps, newId(), 'cara-google-sub', 'Cara');
        assert(newcomer.status === 200, `a new Google account still joins (${newcomer.status})`);
        await probe.kill();

        // ── 4. The take-over, from the bundle alone ──
        console.log('\n— 4. the take-over, with the standby\'s own copy of the door\'s record wiped —');
        const recopied = await standby.send('pull', {});
        require_(recopied.resync?.ok, `the standby copies the main server again, Eve included (${JSON.stringify(recopied.resync)})`);
        const dan = newId();
        const danJoin = await join(mainHttps, dan, 'dan-google-sub', 'Dan');
        assert(danJoin.status === 200, `Dan joins the main server after the standby's last copy (${danJoin.status})`);
        const sealed2 = await main.send('reseal');
        assert(sealed2.members.includes(dan.pk) && sealed2.total === 4, `the main server re-seals: the bundle has Dan's row (${sealed2.total} in all)`);
        const envOnly = await standby.send('pull', { envelopeOnly: true });
        require_(envOnly.envelope === 'stored', `the standby pulls only the new envelope (${JSON.stringify(envOnly)})`);
        await standby.send('forget-door');
        const wiped = await standby.send('door');
        require_(wiped.rows.length === 0 && wiped.saltFp === null, 'the standby\'s own copy of the door\'s record is gone: no rows, no key');

        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code }, pw(PW_STANDBY));
        require_(opened.status === 200, `the recovery code opens the keys (${opened.status} ${opened.body?.error ?? ''})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, pw(PW_STANDBY));
        require_(confirmed.status === 200, `confirmed (${confirmed.status})`);
        const exit = await standby.exited;
        assert(exit === 0, `the standby restarts itself (exit ${exit})`);
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...GLOBAL });
        nodes.push(standby);
        require_(standby.ready.role === 'primary', 'it is the main server');

        const progress = await standby.send('progress');
        assert(progress.state === 'complete' && progress.step?.done, `the take-over completed, open-door step included (${progress.state})`);
        assert(/3 sign-in account\(s\) on record here \(the main server had 4 when it sealed\)/.test(progress.step?.detail ?? '')
            && /1 for members this standby never copied/.test(progress.step?.detail ?? '') && /key for their hashes brought from the keys/.test(progress.step?.detail ?? ''),
            `the step says what it brought back (${progress.step?.detail})`);
        assert(!progress.saltInJournal && !progress.saltInProgress, 'the key is in neither the journal nor the progress the Settings screen reads');
        const after = await standby.send('door');
        assert(after.saltFp === mainDoor.saltFp, 'the key for the door\'s hashes is the main server\'s, from the keys');
        assert(JSON.stringify(after.rows.map((r: any) => r.member).sort()) === JSON.stringify([ada.pk, ben.pk, eve.pk].sort()),
            'Ada, Ben and Eve\'s join records are back; Dan\'s is not, as Dan is no member here');

        const standbyHttps = (await standby.send('serve', { jwk: googleJwk })).port as number;
        const adaAfter = await join(standbyHttps, newId(), 'ada-google-sub', 'Ada three');
        assert(adaAfter.status === 409 && adaAfter.body?.code === 'already_joined',
            `after the take-over, Ada's Google account from a new key: refused, 409 already_joined (${adaAfter.status} ${adaAfter.body?.code})`);
        const benAfter = await join(standbyHttps, newId(), 'ben-google-sub', 'Ben two');
        assert(benAfter.status === 409 && benAfter.body?.code === 'already_joined', `and Ben's: 409 already_joined (${benAfter.status})`);
        const danAfter = await join(standbyHttps, dan, 'dan-google-sub', 'Dan');
        assert(danAfter.status === 200 && danAfter.body?.member?.publicKey === dan.pk,
            `Dan, whom the standby never copied, joins again with the same key rather than being locked out (${danAfter.status} ${danAfter.body?.code ?? ''})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ The open door\'s record survives a standby, a hand promotion and a take-over.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        process.exit(1);
    });
}
