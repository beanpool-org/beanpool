/**
 * A standby pins its main server once, on its own shell (design scratch/global-node/case19/DESIGN-standby-pin-fable.md,
 * fail-first rows a–j). Over the real HTTPS server, through every middleware a node runs; `beanpool pair` as its own
 * process beside it; the boot migration as a node's start on data folders in today's shape.
 *
 * One process is the main server K1 and its standby, as in test-standby-token-only: the node copies its own server over
 * HTTPS with a replication token. A copy source that "answers as another key" is, to the standby, a source whose signer
 * is not its pin: here the pin names another key (K4), which is what a standby pointed at Mallory's server sees.
 *
 *  a. The residual, closed: with the owner's fresh phone hand-off (Manage within 90 s), and with the password and a
 *     current code: a `mirror` link → 400 (no such level); another key's pairing code in Live Backup Server → 409
 *     pairOnShell; another server's address and token → 200 and the pin as it was; standby-main.json byte for byte. A
 *     same-community file signed by K4, locked to her own code → 409 signerNotPinned, naming both keys; the phone way
 *     (X-Unlock-With: phone) too; a file naming K1 that K1 never signed → 400 altered. (test-owner-delete-gates 3a has
 *     every other credential.)
 *  b. The hostile copy source: the standby pinned to K4 pulls from K1: refused at the first page, the copied tables
 *     unchanged, its cursor kept, the report says signer-not-pinned (`signature` + whyDetail for an older main server),
 *     standby.source-not-main raised; the main server's watch opens its incident after an hour, saying why. Pointed back
 *     (the pin is K1's): the next copy lands from the cursor, the condition clears.
 *  c. Honest pairing: an unpaired standby (standby.unpaired raised); the main server's code pasted into Live Backup
 *     Server → 409 pairOnShell, nothing written; `beanpool pair --code-file F` → exit 0, the pin (0600, how 'shell'), the
 *     copy source and token, the cursor dropped, the condition gone; the copy lands; a file K1 signed passes the pin.
 *  d. Re-pair: a K2 code → exit 1, nothing changed; with --follow-new-server → the pin replaced, the cursor dropped (the
 *     next copy is whole), the security line; the code's address answering as K1 → the amber line, paired anyway. A K1
 *     code on the K1 standby: address and token updated, the cursor kept.
 *  e. Promotion needs no re-pair: a code the standby's own key made (a promoted standby's) pasted into Live Backup
 *     Server with the fresh hand-off → 200, its address and token taken, the pin unchanged.
 *  f. Migration: today's shape (one mirror link, a copy taken) → pinned, how 'migrated', connectors.json without the
 *     link, written once (a second start rewrites nothing); the standby's own import record wins; two mirror links, or
 *     one and no copy → unpaired, with the words; a main server with a mirror link → the link removed, one line, no pin.
 *  g. No route writes the pin: the peer-link routes and Live Backup Server × every credential leave standby-main.json
 *     byte for byte (test-restore-points 5 sweeps every admin route).
 *  h. A restore point's tar holds the pin; notABrandNewInstall names it. (The take-over's retire and roll-back:
 *     test-takeover-by-code, test-takeover-failure-rolls-back.)
 *  i. `mirror` is gone: POST /connectors → 400; a mirror entry on disk is dropped at load and GET /connectors never
 *     answers one.
 *  j. The code itself: the generate answer is no-store and carries this server's own key; the token is in no log line,
 *     no command output and no file but local-config; a code with one character changed is refused by its checksum,
 *     nothing written.
 *
 * It runs to the end on a server without the pin (origin/main), reporting a count: the pin's module is loaded with a
 * catch, the pairing code and the pin file are this suite's own reading of the design's format, and "the key a standby
 * trusts" counts both the pin and any `mirror` link (what a standby trusted before it).
 *
 * Run:
 *   SERVER_SUITES_ONLY=test-standby-pin node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.BACKUP_ADMIN_PASSWORD;
delete process.env.BACKUP_REPLICATION_TOKEN;
delete process.env.BACKUP_PRIMARY_URL;

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import util from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const PIN_FILE = 'standby-main.json';

/** The pin as the design writes it (D1), read and written here so this suite needs nothing of the module it tests. */
function pinPath(dir = process.env.BEANPOOL_DATA_DIR!): string { return path.join(dir, PIN_FILE); }
function readPin(dir?: string): any {
    try { return JSON.parse(fs.readFileSync(pinPath(dir), 'utf8')); } catch { return null; }
}
function writePin(peerId: string, url: string | null, dir?: string): void {
    fs.writeFileSync(pinPath(dir), JSON.stringify({ v: 1, peerId, communityId: null, url, pairedAt: Date.now(), how: 'shell' }), { mode: 0o600 });
}
function removePin(dir?: string): void { fs.rmSync(pinPath(dir), { force: true }); }
/** The pairing code's format (D1): bpair1-<base64url JSON>-<first 6 hex of the sha256 of the base64url part>. */
function makeCode(c: { url: string; communityId: string; peerId: string; token: string }): string {
    const body = Buffer.from(JSON.stringify({ v: 1, ...c })).toString('base64url');
    return `bpair1-${body}-${crypto.createHash('sha256').update(body).digest('hex').slice(0, 6)}`;
}
function parseCode(raw: unknown): { ok: true; code: { url: string; communityId: string; peerId: string; token: string } } | { ok: false } {
    const m = typeof raw === 'string' ? /^bpair1-([A-Za-z0-9_-]+)-([0-9a-f]{6})$/.exec(raw.trim()) : null;
    if (!m || crypto.createHash('sha256').update(m[1]).digest('hex').slice(0, 6) !== m[2]) return { ok: false };
    try { return { ok: true, code: JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) }; } catch { return { ok: false }; }
}

// ── f. the child: one node start on a prepared data folder (the migration and the connectors' load) ──
if (process.argv.includes('--child-migrate')) {
    const dir = process.env.BEANPOOL_DATA_DIR!;
    const lines: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error'] as const) {
        console[m] = (...a: unknown[]) => { lines.push(util.format(...a)); };
    }
    // As a start runs it: after the database is up (index.ts step 2.505).
    const { db, initSchema } = await import('./db/db.js');
    initSchema();
    const seed = process.env.PIN_SEED || '';
    if (seed.includes('cursor')) {
        db.prepare("INSERT OR REPLACE INTO sync_cursors (peer_id, last_synced_at, last_sync_attempt_at) VALUES ('backup:primary', ?, ?)")
            .run('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    }
    if (seed.includes('audit:')) {
        db.prepare('INSERT INTO sync_audit_log (origin_peer_id, origin_node_id) VALUES (?, ?)').run(seed.split('audit:')[1].split(',')[0], 'n');
    }
    const sm: any = await import('./services/standby-main.js').catch(() => null);
    const outcome = sm ? await sm.migrateStandbyMainAtBoot() : { kind: 'no migration on this server' };
    const { loadConnectors, getConnectors } = await import('./connector-manager.js');
    loadConnectors();
    const alerts: any = await import('./services/alerts.js');
    const unpaired = (alerts.standbyPinConditions?.() ?? []).find((c: any) => c.key === 'standby.unpaired');
    process.stdout.write(`${JSON.stringify({
        outcome, pin: readPin(dir), connectors: getConnectors().map((c) => c.trustLevel), unpaired: unpaired?.active ? unpaired.detail : null,
        lines: lines.filter((l) => /\[Standby\]|\[Connectors\] Removed/.test(l)),
    })}\n`);
    process.exit(0);
}

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) { testsPassed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}

// Everything this process prints, for j.
const printed: string[] = [];
for (const m of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[m].bind(console);
    console[m] = (...a: unknown[]) => { printed.push(util.format(...a)); orig(...a); };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (p: string) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'none');

/** `beanpool pair` as its own process; the node in this process takes its request on its 2 s tick. */
function pairCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
    // NODE_ROLE as the node's container has it (`docker compose exec` inherits it).
    const c = spawn(process.execPath, ['--import', 'tsx', path.join(SRC, 'recover-cli.ts'), 'pair', ...args], {
        env: { ...process.env, NODE_ROLE: 'backup', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    return new Promise((resolve) => c.on('close', (code) => resolve({ code, out })));
}

/** One node start on `dir` (the child above): its answer. */
function childStart(dir: string, env: Record<string, string>): Promise<any> {
    const c = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--child-migrate'], {
        env: { ...process.env, BEANPOOL_DATA_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    return new Promise((resolve) => c.on('close', () => {
        const line = out.trim().split('\n').reverse().find((l) => l.startsWith('{'));
        try { resolve(JSON.parse(line || 'null')); } catch { resolve({ error: `${out}\n${err}`.slice(-600) }); }
    }));
}

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-pin-'));

    // The address service, a stub on loopback that knows nothing: no request leaves this machine.
    const registrar = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => { res.statusCode = 404; res.end('{"error":"not found"}'); });
    });
    await new Promise<void>((r) => registrar.listen(0, '127.0.0.1', () => r()));
    process.env.REGISTRAR_URL = `http://127.0.0.1:${(registrar.address() as any).port}`;

    const { initStateEngine, seedGenesisMember, setNodeRole } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis, notABrandNewInstall } = await import('./genesis.js');
    const { generateKeyPair } = await import('@libp2p/crypto/keys');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
    const { hashPassword, updateLocalConfig, getLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { mintHandshakeToken, consumeHandshakeToken, createPasswordSession, PHONE_HANDOFF_IDLE_TTL_MS } = await import('./admin-key-auth.js');
    const { turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { getConnectors, loadConnectors, removeConnector } = await import('./connector-manager.js');
    const { initTls } = await import('./services/tls.js');
    const https = await import('./https-server.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { startP2P } = await import('./p2p.js');
    const { pullNow, savedPullCursor, setSwapRestartForTests } = await import('./services/backup-puller.js');
    const { setSyncCursor, noteReplicaFormat } = await import('./engine/sync.js');
    const { readCopyRecord, standbyReport } = await import('./services/standby-copy-record.js');
    const { standbyReportHeader, parseStandbyReport } = await import('./services/standby-report.js');
    const alertsMod: any = await import('./services/alerts.js');
    const pinConditions = (): Array<{ key: string; active: boolean; detail: string }> => alertsMod.standbyPinConditions?.() ?? [];
    const { noteStandbyReport, checkStandbyHealth, getStandbyHealthBanner, setStandbyHealthClockForTests, forgetStandby } = await import('./services/standby-health.js');
    // The module under test, when this server has it: its node half takes `beanpool pair`'s request.
    const sm: any = await import('./services/standby-main.js').catch(() => null);
    const { signerCheck } = await import('./services/sealed-backup.js');
    const { takeRestorePoint, RESTORE_POINT_SERVER_TAR } = await import('./services/restore-points.js');
    const { readNodeIdentity } = await import('./services/takeover-envelope.js');
    const { tableContentHashes } = await import('./engine/replica-hashes.js');
    const core: any = await import('@beanpool/core');
    const { localFetch } = await import('./keepalive-test-fetch.js');

    initStateEngine();
    await ensureGenesis();
    const node = await startP2P(0, 0);
    const K1 = node.peerId.toString();
    const k2Key = await generateKeyPair('Ed25519');
    const K2 = peerIdFromPrivateKey(k2Key).toString();
    const mallory = await generateKeyPair('Ed25519');
    const K4 = peerIdFromPrivateKey(mallory).toString();
    const community = JSON.parse(fs.readFileSync(path.join(dataDir, 'genesis.json'), 'utf8')).communityId as string;
    // A whole copy made ready would restart the server: here it stays ready (the stager's own suites swap it).
    setSwapRestartForTests(() => {});

    const PW = 'Standby-Pin-Pw-8842!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, breakGlassMode: false, replicationTokenOnly: true } as any);
    const owner = crypto.randomBytes(32).toString('hex');
    const admin = crypto.randomBytes(32).toString('hex');
    seedGenesisMember(owner, 'Victor');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, 'Adam', ?, ?, 'TEST')`).run(admin, new Date().toISOString(), owner);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(admin);
    const { grantNodeRole } = await import('./state-engine.js');
    grantNodeRole(admin, 'admin', owner);
    const keySession = (pk: string, role: 'owner' | 'admin', phone = false): string => {
        const ex = consumeHandshakeToken(mintHandshakeToken(pk, role).handshakeToken, Date.now(), phone ? { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS } : {});
        if (!ex.ok || ex.role !== role) throw new Error(`setup: no ${role} session: ${ex.error}`);
        return ex.sessionId!;
    };
    const asPhone = (): Record<string, string> => ({ 'x-admin-session': keySession(owner, 'owner', true) });
    const asComputer = (): Record<string, string> => ({ 'x-admin-session': keySession(owner, 'owner') });
    const asAdmin = (): Record<string, string> => ({ 'x-admin-session': keySession(admin, 'admin') });

    await initTls();
    const port = await https.startHttpsServer(0);
    const base = `https://localhost:${port}`;
    async function call(method: string, route: string, headers: Record<string, string> = {}, body?: unknown) {
        resetAdminAuthTarpit();
        https.resetAdminRateLimit();
        pruneAuthAttempts(Date.now() + 120_000);
        const init: RequestInit = { method, headers: { ...headers } };
        if (method !== 'GET') {
            (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body ?? {});
        }
        const res = await localFetch(base + route, init);
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, text, json, cache: res.headers.get('cache-control') };
    }
    const short = (r: { status: number; text: string }) => `${r.status} ${r.text.slice(0, 160)}`;
    const tfa = turnOn2faForTests(PW);
    const pwCode = (): Record<string, string> => ({ 'x-admin-session': createPasswordSession().sessionId });
    const pinFile = path.join(dataDir, PIN_FILE);
    const copied = () => JSON.stringify(tableContentHashes());
    sm?.startPairRequestWatch(dataDir);
    /** The keys this standby trusts as its main server: the pin, and any `mirror` link (before the pin, the anchor). */
    const trusted = () => JSON.stringify([sha(pinFile), ...getConnectors().filter((c: any) => c.trustLevel === 'mirror').map((c: any) => c.address)]);

    try {
        // ── j (part). The pairing code, made on the main server ──
        console.log('\n── j. the pairing code: made from this server\'s own key, shown once, no-store ──');
        const made = await call('POST', '/api/local/admin/replication-token/generate', asPhone(), {});
        const code1: string = made.json?.pairingCode;
        const parsed1 = parseCode(code1);
        assert(made.status === 200 && made.cache === 'no-store' && parsed1.ok && parsed1.code.peerId === K1 && parsed1.code.communityId === community
            && parsed1.code.token === made.json?.token && parsed1.code.url === base,
            `j. generate answers { token, pairingCode } with no-store, the code holding this server's own key, its community and address (${made.status} ${made.cache})`);
        const TOKEN = made.json?.token as string;
        const forged = await call('POST', '/api/local/admin/replication-token/generate', asPhone(), { peerId: K4, communityId: 'c0ffee00c0ffee00' });
        const pf = parseCode(forged.json?.pairingCode);
        assert(forged.status === 200 && pf.ok && pf.code.peerId === K1 && pf.code.communityId === community,
            'j. a key or community in the request is never the code\'s: it holds this server\'s own');
        // The code made last is the one that copies (one token per server).
        const token = String(forged.json?.token ?? '');
        // A server with no pairing code (origin/main): the code it would have made, so the rows below still run.
        const code = String(forged.json?.pairingCode ?? makeCode({ url: base, communityId: community, peerId: K1, token }));

        // ── i. mirror is gone ──
        console.log('\n── i. `mirror` is no trust level ──');
        const mirrorPost = await call('POST', '/api/local/connectors', asPhone(), { address: `/ip4/127.0.0.1/tcp/4002/p2p/${K4}`, trustLevel: 'mirror' });
        assert(mirrorPost.status === 400 && /beanpool pair/.test(mirrorPost.json?.error || '') && !getConnectors().some((c: any) => c.address.includes(K4)),
            `i. POST /api/local/connectors trustLevel mirror → 400, naming beanpool pair (${short(mirrorPost)})`);
        fs.writeFileSync(path.join(dataDir, 'connectors.json'), JSON.stringify([
            { address: `/ip4/127.0.0.1/tcp/4002/p2p/${K4}`, trustLevel: 'mirror', enabled: false, callsign: 'old', addedAt: 1 },
            { address: `/ip4/127.0.0.1/tcp/4003/p2p/${K2}`, trustLevel: 'peer', enabled: false, callsign: 'neighbour', addedAt: 1 },
        ]));
        loadConnectors();
        const listed = await call('GET', '/api/local/connectors', asComputer());
        const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'connectors.json'), 'utf8'));
        assert(listed.status === 200 && Array.isArray(listed.json) && listed.json.every((c: any) => c.trustLevel !== 'mirror') && listed.json.length === 1
            && onDisk.length === 1 && onDisk[0].trustLevel === 'peer',
            `i. a mirror entry on disk is dropped at load, and GET /connectors answers none (${listed.json?.map((c: any) => c.trustLevel)})`);
        fs.writeFileSync(path.join(dataDir, 'connectors.json'), '[]');
        loadConnectors();

        setNodeRole('backup');

        // ── c. Honest pairing ──
        console.log('\n── c. an unpaired standby, paired from its shell ──');
        removePin();
        updateLocalConfig({ backupPrimaryUrl: null, backupReplicationToken: null } as any);
        const unpairedNow = pinConditions().find((c) => c.key === 'standby.unpaired');
        assert(unpairedNow?.active === true && /not paired with a main server, so it copies nothing/.test(unpairedNow.detail) && /beanpool pair/.test(unpairedNow.detail),
            `c. unpaired: standby.unpaired is raised, with the next step (${unpairedNow?.detail})`);
        const fromSettings = await call('POST', '/api/local/admin/replication-config/save', asPhone(), { pairingCode: code });
        assert(fromSettings.status === 409 && fromSettings.json?.pairOnShell === true && /beanpool pair/.test(fromSettings.json?.error || '')
            && !fs.existsSync(pinFile) && !getLocalConfig().backupReplicationToken,
            `c. the main server's code pasted into Live Backup Server of an unpaired standby → 409 pairOnShell, nothing written (${short(fromSettings)})`);
        // A cut paste: one character changed is refused by the checksum, before anything is written (j).
        const bad = code.slice(0, 20) + (code[20] === 'A' ? 'B' : 'A') + code.slice(21);
        const badFile = path.join(work, 'bad-code');
        fs.writeFileSync(badFile, bad);
        const cut = await pairCli(['--code-file', badFile]);
        assert(cut.code === 1 && /not whole/.test(cut.out) && !fs.existsSync(pinFile) && !fs.existsSync(path.join(dataDir, 'pair-request.json'))
            && !getLocalConfig().backupReplicationToken,
            `j. a code with one character changed → exit 1, refused by its checksum, nothing written (${cut.out.trim().slice(-160)})`);
        const onArgv = await pairCli([code]);
        assert(onArgv.code === 2 && /never given on the command line/.test(onArgv.out) && !fs.existsSync(pinFile), `c. the code on the command line → exit 2, refused (${onArgv.out.trim().slice(-100)})`);
        const codeFile = path.join(work, 'code');
        fs.writeFileSync(codeFile, `${code}\n`, { mode: 0o600 });
        setSyncCursor('backup:primary', new Date(Date.now() - 3600_000).toISOString());
        const paired = await pairCli(['--code-file', codeFile]);
        const pin = readPin();
        assert(paired.code === 0 && pin?.peerId === K1 && pin.how === 'shell' && pin.communityId === community && pin.url === base
            && (fs.statSync(pinFile).mode & 0o777) === 0o600,
            `c. beanpool pair --code-file → exit 0, the pin written (0600, how shell, K1) (${paired.out.trim().slice(-200)})`);
        assert(/Main server: .*key …/.test(paired.out) && /This standby: not paired yet/.test(paired.out) && /paired with its main server/.test(paired.out),
            'c. it showed the main server, this standby (not paired yet) and the outcome');
        assert(getLocalConfig().backupPrimaryUrl === base && getLocalConfig().backupReplicationToken === token && savedPullCursor() === null,
            'c. the copy source and token are in local-config, and the cursor is dropped: the next copy is whole');
        assert(!pinConditions().find((c) => c.key === 'standby.unpaired')?.active, 'c. standby.unpaired is over');
        // That whole copy is built in the stager and swapped in at a restart (its own suites); here, as after that restart,
        // the standby holds a cursor and the copy's format (engine/sync.ts noteReplicaFormat), and copies on from it.
        setSyncCursor('backup:primary', new Date(Date.now() - 600_000).toISOString());
        noteReplicaFormat();
        const first = await pullNow();
        assert(first.ok && !first.staged && readCopyRecord().lastOutcome === 'ok', `c. copies land from the paired main server (${first.error || 'ok'})`);
        const k1Header = core.readSealedHeader(await core.sealEnvelope(new Uint8Array(Buffer.from('x')), {
            kind: 'backup', communityId: community, nodePeerId: K1, recipients: { owners: [], codes: [(await core.createRecoveryCode(1)).record] },
            signingKey: readNodeIdentity()!.seed,
        }));
        const k1Check = signerCheck(k1Header);
        assert(k1Check.ok === true && (k1Check as any).pinned === true, `c. a file K1 signed passes the pin on this standby (${JSON.stringify(k1Check).slice(0, 120)})`);

        // ── j. The token: no log line, no command output, no file but local-config ──
        console.log('\n── j. the token is in no log line, no output, no file but local-config ──');
        const files: string[] = [];
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p); else if (e.isFile() && fs.readFileSync(p).includes(Buffer.from(token))) files.push(path.relative(dataDir, p));
            }
        };
        walk(dataDir);
        assert(files.length > 0 && files.every((f) => f === 'local-config.json' || f === 'local-config.json.bak'),
            `j. the token is in local-config only (${files.join(', ')})`);
        assert(!printed.some((l) => l.includes(token) || l.includes(TOKEN)) && !paired.out.includes(token) && !cut.out.includes(token),
            'j. no log line and no command output holds a token');

        // ── b. The hostile copy source ──
        console.log('\n── b. a copy source that answers as another key: refused at the first page, loud on both servers ──');
        writePin(K4, base);
        const cursorBefore = new Date(Date.now() - 600_000).toISOString();
        setSyncCursor('backup:primary', cursorBefore);
        const tablesBefore = copied();
        const refused = await pullNow();
        const rec = readCopyRecord();
        assert(!refused.ok && rec.lastOutcome === 'refused' && rec.lastWhy === 'signer-not-pinned',
            `b. the pull is refused: signer-not-pinned (${rec.lastOutcome} ${rec.lastWhy}: ${refused.error?.slice(0, 120)})`);
        assert(copied() === tablesBefore && savedPullCursor() === cursorBefore, 'b. the copied tables are unchanged, and the cursor kept');
        const report = standbyReport();
        const header = standbyReportHeader(report);
        const asOld = JSON.parse(header);
        assert(report.why === 'signer-not-pinned' && report.pin === K4 && asOld.why === 'signature' && asOld.whyDetail === 'signer-not-pinned'
            && parseStandbyReport(header)?.why === 'signer-not-pinned' && parseStandbyReport(header)?.pin === K4,
            `b. the report: signer-not-pinned (signature + whyDetail for a main server from before), pin K4 (${header.slice(0, 120)})`);
        const wrong = pinConditions().find((c) => c.key === 'standby.source-not-main');
        assert(wrong?.active === true && /answers with a key that is not its main server's/.test(wrong.detail) && /pair this standby again from its shell/.test(wrong.detail),
            `b. standby.source-not-main is raised (${wrong?.detail})`);
        // The main server's watch (this server as the main one, its clock an hour on): silence, with the reason.
        setNodeRole('primary');
        noteStandbyReport(header, '127.0.0.1');
        setStandbyHealthClockForTests(2 * 3600_000);
        checkStandbyHealth();
        const banner = getStandbyHealthBanner();
        assert(!!banner.incident && banner.incident.lines.some((l) => /it refuses copies: the server it copies from is not its main server/.test(l))
            && banner.standbys.some((s) => s.paired === 'other') && banner.incident.whatToDo.some((w) => /beanpool pair/.test(w)),
            `b. the main server's watch opens its incident after an hour, saying why (${banner.incident?.lines.join(' | ')})`);
        for (const s of banner.standbys) forgetStandby(s.id);
        setStandbyHealthClockForTests(0);
        setNodeRole('backup');
        // Pointed back: the source is the main server again.
        writePin(K1, base);
        const back = await pullNow();
        assert(back.ok && readCopyRecord().lastOutcome === 'ok', `b. pointed back, the next copy lands (${back.error || (back.staged ? 'whole' : 'from the cursor')})`);
        assert(!pinConditions().find((c) => c.key === 'standby.source-not-main')?.active, 'b. standby.source-not-main is over');

        // ── a. The residual, closed ──
        console.log('\n── a. no session makes another key the pin ──');
        writePin(K1, base);
        const pinBytes = trusted();
        const k4Code = makeCode({ url: 'https://mallory.example.invalid', communityId: community, peerId: K4, token: 'b'.repeat(64) });
        for (const [who, headers, extra] of [
            ['a fresh phone hand-off', asPhone, () => ({})],
            ['the password with a current code', pwCode, () => ({ code: tfa.code() })],
        ] as Array<[string, () => Record<string, string>, () => Record<string, unknown>]>) {
            const link = await call('POST', '/api/local/connectors', headers(), { address: `/ip4/127.0.0.1/tcp/4002/p2p/${K4}`, trustLevel: 'mirror', ...extra() });
            assert(link.status === 400 && trusted() === pinBytes, `a. ${who}: a mirror link → 400, the keys it trusts as they were (${short(link)})`);
            const k4 = await call('POST', '/api/local/admin/replication-config/save', headers(), { pairingCode: k4Code, ...extra() });
            assert(k4.status === 409 && k4.json?.pairOnShell === true && k4.json?.mainServer === K1 && trusted() === pinBytes
                && new RegExp(K4.slice(-8)).test(k4.json?.error || '') && /--follow-new-server/.test(k4.json?.error || ''),
                `a. ${who}: K4's pairing code in Live Backup Server → 409 pairOnShell, naming both keys (${short(k4)})`);
            const urlAndToken = await call('POST', '/api/local/admin/replication-config/save', headers(), { primaryUrl: 'https://mallory.example.invalid', primaryToken: 'b'.repeat(64), ...extra() });
            assert(urlAndToken.status === 200 && trusted() === pinBytes && readPin()?.peerId === K1,
                `a. ${who}: K4's address and a token → 200, and the pin byte for byte as it was (${short(urlAndToken)})`);
        }
        updateLocalConfig({ backupPrimaryUrl: base, backupReplicationToken: token } as any);
        const theirCode = await core.createRecoveryCode(7);
        const sealedBy = async (nodePeerId: string) => Buffer.from(await core.sealEnvelope(new Uint8Array(Buffer.from('a database of her own')), {
            kind: 'backup', communityId: community, nodePeerId,
            recipients: { owners: [], codes: [theirCode.record] }, signingKey: new Uint8Array(mallory.raw.subarray(0, 32)),
        }));
        const rolesBefore = JSON.stringify(db.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all());
        const filesBefore = fs.readdirSync(dataDir).sort().join(',');
        const upload = async (file: Buffer, headers: Record<string, string>) => {
            resetAdminAuthTarpit();
            https.resetAdminRateLimit();
            pruneAuthAttempts(Date.now() + 120_000);
            const res = await localFetch(base + '/api/local/admin/restore', {
                method: 'POST', body: new Uint8Array(file),
                headers: { ...headers, 'X-Recovery-Code': theirCode.code, 'Content-Type': 'application/octet-stream' },
            });
            return { status: res.status, json: await res.json().catch(() => null) as any };
        };
        const forgedFile = await sealedBy(K4);
        for (const [who, headers] of [
            ['a fresh phone hand-off', asPhone()],
            ['a fresh phone hand-off, opened with the phone', { ...asPhone(), 'X-Unlock-With': 'phone' }],
        ] as Array<[string, Record<string, string>]>) {
            const r = await upload(forgedFile, headers);
            assert(r.status === 409 && r.json?.signerNotPinned === true && r.json?.mainServer === K1 && !r.json?.sessionId
                && /A standby restores only its main server's backups/.test(r.json?.error || ''),
                `a. ${who}: the same-community file K4 signed, with her own code → 409 signerNotPinned, naming the pin (${r.status} ${String(r.json?.error).slice(0, 140)})`);
        }
        const posing = await upload(await sealedBy(K1), asPhone());
        assert(posing.status === 400 && posing.json?.badSignature === true, `a. a file naming K1 that K1 never signed → 400 altered (${posing.status})`);
        assert(JSON.stringify(db.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all()) === rolesBefore
            && fs.readdirSync(dataDir).sort().join(',') === filesBefore && trusted() === pinBytes,
            'a. nothing moved: the roles, the pin, no restore point, no file kept for a phone');

        // ── g. No route writes the pin ──
        console.log('\n── g. the peer-link routes and Live Backup Server, every credential: the pin byte for byte ──');
        const creds: Array<[string, () => Record<string, string>]> = [
            ['no credential', () => ({})], ['an admin', asAdmin], ["the owner's computer", asComputer], ['a password session', pwCode],
            ['a fresh phone hand-off', asPhone], ['the password with a current code', () => ({ ...pwCode(), 'x-fresh-proof': tfa.code() })],
        ];
        const bait = { address: `/ip4/127.0.0.1/tcp/4002/p2p/${K4}`, trustLevel: 'mirror', pairingCode: k4Code, peerId: K4, primaryUrl: base, primaryToken: token };
        let sent = 0;
        const changedBy: string[] = [];
        for (const [who, headers] of creds) {
            for (const [m, route] of [['POST', '/api/local/connectors'], ['POST', '/api/local/connectors/remove'], ['POST', '/api/local/connectors/disconnect'],
                ['POST', '/api/local/admin/replication-config/save'], ['POST', '/api/local/admin/replication-config/get'], ['POST', '/api/local/admin/backup-status'],
                ['POST', '/api/local/admin/replication-resync'], ['GET', '/api/local/connectors']] as Array<[string, string]>) {
                await call(m, route, headers(), bait);
                sent++;
                if (trusted() !== pinBytes) {
                    changedBy.push(`${who}: ${m} ${route}`);
                    for (const c of getConnectors()) if ((c as any).trustLevel === 'mirror') removeConnector(c.address);
                    writePin(K1, base);
                }
            }
        }
        assert(sent === creds.length * 8 && changedBy.length === 0, `g. ${sent} requests: standby-main.json byte for byte after each (${changedBy.join(' | ') || 'none changed it'})`);
        const status = await call('POST', '/api/local/admin/backup-status', asComputer(), {});
        assert(status.json?.standbyMain?.peerId === K1 && status.json?.standbyMain?.keyEnd === `…${K1.slice(-8)}` && status.json?.standbyMain?.how === 'shell',
            `g. backup-status shows the pin for the card, read-only (${JSON.stringify(status.json?.standbyMain)})`);

        // ── e. Promotion needs no re-pair ──
        console.log('\n── e. a code from a promoted standby (the same key) is taken in Live Backup Server ──');
        const promotedCode = makeCode({ url: 'https://promoted.example.invalid', communityId: community, peerId: K1, token: 'd'.repeat(64) });
        const followed = await call('POST', '/api/local/admin/replication-config/save', asPhone(), { pairingCode: promotedCode });
        assert(followed.status === 200 && getLocalConfig().backupPrimaryUrl === 'https://promoted.example.invalid' && getLocalConfig().backupReplicationToken === 'd'.repeat(64)
            && trusted() === pinBytes, `e. the same key's code → 200, its address and token taken, the pin unchanged (${short(followed)})`);
        const noProof = await call('POST', '/api/local/admin/replication-config/save', asComputer(), { pairingCode: promotedCode });
        assert(noProof.status === 403, `e. …with the fresh proof only: the owner's computer session → 403 (${short(noProof)})`);
        updateLocalConfig({ backupPrimaryUrl: base, backupReplicationToken: token } as any);

        // ── d. Re-pair ──
        console.log('\n── d. a different main server: only with --follow-new-server, from the shell ──');
        const k2CodeFile = path.join(work, 'k2-code');
        // The code's address is this server, which answers as K1: the amber line.
        fs.writeFileSync(k2CodeFile, makeCode({ url: base, communityId: community, peerId: K2, token: 'e'.repeat(64) }));
        const cursorKept = new Date(Date.now() - 300_000).toISOString();
        setSyncCursor('backup:primary', cursorKept);
        const refusedRepair = await pairCli(['--code-file', k2CodeFile]);
        assert(refusedRepair.code === 1 && /This standby follows …/.test(refusedRepair.out) && /--follow-new-server/.test(refusedRepair.out)
            && trusted() === pinBytes && getLocalConfig().backupReplicationToken === token && savedPullCursor() === cursorKept,
            `d. a K2 code on the K1 standby → exit 1, nothing changed (${refusedRepair.out.trim().slice(-160)})`);
        const secBefore = printed.length;
        const repaired = await pairCli(['--code-file', k2CodeFile, '--follow-new-server']);
        assert(repaired.code === 0 && readPin()?.peerId === K2 && savedPullCursor() === null && getLocalConfig().backupReplicationToken === 'e'.repeat(64),
            `d. --follow-new-server → exit 0, the pin is K2, the cursor dropped: the next copy is built from nothing (${repaired.out.trim().slice(-200)})`);
        assert(/answers as another key/.test(repaired.out) && /paired anyway/.test(repaired.out),
            `d. the code's address answering as another key: the amber line, paired anyway (${repaired.out.trim().slice(-200)})`);
        assert(printed.slice(secBefore).some((l) => /now follows a different main server/.test(l) && l.includes(K2)), 'd. the security log line says it');
        // Back to K1, and a K1 code on the K1 standby: address and token, no copy from nothing.
        writePin(K1, base);
        setSyncCursor('backup:primary', cursorKept);
        const sameFile = path.join(work, 'same-code');
        fs.writeFileSync(sameFile, makeCode({ url: base, communityId: community, peerId: K1, token }));
        const same = await pairCli(['--code-file', sameFile]);
        assert(same.code === 0 && readPin()?.peerId === K1 && savedPullCursor() === cursorKept && /already follows/.test(same.out) && !/answers as another key/.test(same.out),
            `d. a K1 code on the K1 standby → address and token updated, the cursor kept (${same.out.trim().slice(-160)})`);

        // ── h. Restore points and a new install ──
        console.log('\n── h. the pin in a restore point; a data folder with it is no new install ──');
        const point = takeRestorePoint('restore');
        const tar = path.join(dataDir, 'restore-points', point.name, RESTORE_POINT_SERVER_TAR);
        const listedTar = fs.existsSync(tar) ? execFileSync('tar', ['-tzf', tar], { encoding: 'utf8' }) : '';
        assert(listedTar.split('\n').some((l) => l.replace(/^\.\//, '') === PIN_FILE), `h. the restore point's tar holds ${PIN_FILE} (${listedTar.split('\n').join(' ')})`);
        const onlyPin = fs.mkdtempSync(path.join(work, 'only-pin-'));
        fs.copyFileSync(pinFile, path.join(onlyPin, PIN_FILE));
        assert(notABrandNewInstall(onlyPin) === `it has ${PIN_FILE}`, `h. notABrandNewInstall names it (${notABrandNewInstall(onlyPin)})`);

        // ── f. Migration ──
        console.log('\n── f. a start on this version: today\'s standbys move themselves where the record is clear ──');
        const newDir = (links: Array<{ peer: string | null; level?: string }>) => {
            const d = fs.mkdtempSync(path.join(work, 'mig-'));
            fs.copyFileSync(path.join(dataDir, 'genesis.json'), path.join(d, 'genesis.json'));
            fs.writeFileSync(path.join(d, 'connectors.json'), JSON.stringify(links.map((l, i) => ({
                address: l.peer ? `/ip4/127.0.0.1/tcp/${4100 + i}/p2p/${l.peer}` : 'main.example.invalid:4001',
                trustLevel: l.level ?? 'mirror', enabled: false, callsign: `link${i}`, addedAt: 1,
            }))));
            fs.writeFileSync(path.join(d, 'local-config.json'), JSON.stringify({ backupPrimaryUrl: 'https://main.example.invalid' }));
            return d;
        };
        const standbyEnv = { NODE_ROLE: 'backup' };
        const today = newDir([{ peer: K1 }, { peer: K2, level: 'peer' }]);
        const m1 = await childStart(today, { ...standbyEnv, PIN_SEED: 'cursor' });
        assert(m1?.outcome?.kind === 'migrated' && m1.outcome.from === 'mirror-link' && m1.pin?.peerId === K1 && m1.pin?.how === 'migrated'
            && m1.pin?.url === 'https://main.example.invalid' && JSON.stringify(m1.connectors) === '["peer"]' && m1.unpaired === null
            && m1.lines.some((l: string) => /Pinned this standby's main server/.test(l)) && m1.lines.some((l: string) => /Removed the mirror link/.test(l)),
            `f. one mirror link and a copy taken → pinned (how migrated), connectors.json without the link, no banner (${JSON.stringify(m1).slice(0, 300)})`);
        const pinAfter1 = sha(path.join(today, PIN_FILE));
        const connAfter1 = sha(path.join(today, 'connectors.json'));
        const m2 = await childStart(today, standbyEnv);
        assert(m2?.outcome?.kind === 'paired-already' && sha(path.join(today, PIN_FILE)) === pinAfter1 && sha(path.join(today, 'connectors.json')) === connAfter1,
            `f. a second start rewrites nothing (${m2?.outcome?.kind})`);
        // Once per data folder: an unpaired standby whose database a restore replaced (its import record naming any key)
        // is not pinned by a later start; only its shell pairs it.
        const once = newDir([{ peer: K1 }]);
        const o1 = await childStart(once, standbyEnv);
        const o2 = await childStart(once, { ...standbyEnv, PIN_SEED: `audit:${K4}` });
        assert(o1?.outcome?.kind === 'unpaired' && o2?.outcome?.kind === 'ran-before' && o2.pin === null && /not paired/.test(o2.unpaired || ''),
            `f. the migration runs once: a later start with an import record naming K4 pins nothing (${o1?.outcome?.kind}, then ${o2?.outcome?.kind})`);
        const audited = newDir([{ peer: K4 }]);
        const m3 = await childStart(audited, { ...standbyEnv, PIN_SEED: `audit:${K1}` });
        assert(m3?.outcome?.kind === 'migrated' && m3.outcome.from === 'audit-log' && m3.pin?.peerId === K1,
            `f. its own import record wins over a mirror link: the key that signed a copy it took (${JSON.stringify(m3?.outcome)})`);
        for (const [what, d, seed] of [
            ['two mirror links and a copy', newDir([{ peer: K1 }, { peer: K2 }]), 'cursor'],
            ['one mirror link and no copy ever', newDir([{ peer: K1 }]), ''],
            ['no mirror link', newDir([]), 'cursor'],
        ] as Array<[string, string, string]>) {
            const m = await childStart(d, { ...standbyEnv, PIN_SEED: seed });
            assert(m?.outcome?.kind === 'unpaired' && m.pin === null && /not paired with a main server/.test(m.unpaired || '')
                && m.lines.some((l: string) => /beanpool pair/.test(l)) && !m.connectors.includes('mirror'),
                `f. ${what} → unpaired: no pin, the banner's words and the log line, the links dropped (${JSON.stringify(m).slice(0, 240)})`);
        }
        const mainDir = newDir([{ peer: K4 }, { peer: K2, level: 'peer' }]);
        const mm = await childStart(mainDir, { NODE_ROLE: '' });
        assert(mm?.outcome?.kind === 'not-a-standby' && mm.pin === null && JSON.stringify(mm.connectors) === '["peer"]' && mm.unpaired === null
            && mm.lines.filter((l: string) => /Removed the mirror link/.test(l)).length === 1,
            `f. a main server with a mirror link → the link removed, one line, no pin (${JSON.stringify(mm).slice(0, 240)})`);
        // An unpaired standby is healed from its shell (row c) and told on the main server: its report carries no pin.
        setNodeRole('primary');
        noteStandbyReport(standbyReportHeader({ ...report, pin: null }), '127.0.0.1');
        setStandbyHealthClockForTests(2 * 3600_000);
        checkStandbyHealth();
        const b2 = getStandbyHealthBanner();
        assert(!!b2.incident && b2.incident.lines.some((l) => /it is not paired with this server/.test(l)) && b2.standbys.some((s) => s.paired === 'none'),
            `f. the main server's incident for an unpaired standby says so (${b2.incident?.lines.join(' | ')})`);
        for (const s of b2.standbys) forgetStandby(s.id);
        setStandbyHealthClockForTests(0);
        setNodeRole('backup');
    } finally {
        sm?.stopPairRequestWatch();
        try { await node.stop(); } catch { /* stopped */ }
        registrar.close();
        fs.rmSync(work, { recursive: true, force: true });
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) {
        console.error(`❌ ${testsRun - testsPassed} standby-pin check(s) failed`);
        process.exit(1);
    }
    console.log('⭐️ standby pin PASSED.');
    process.exit(0);
}

main().catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
