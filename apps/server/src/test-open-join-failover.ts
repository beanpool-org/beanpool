/**
 * Test Suite: the open door's record survives a standby, a hand promotion and a take-over (engine/open-join.ts). A
 * sign-in account that joined the main server is refused after a take-over (409 already_joined), because the rows
 * travel, and the key their hashes are made with (the file data/open-join.key, services/open-join-key.ts) travels in the
 * take-over keys, and nowhere else (report C12). A server without that key refuses every sign-in rather than guess.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), booted as index.ts boots, and the
 * joins go over REAL HTTPS through the real signature middleware (startHttpsServer in the node's process). No
 * provider is contacted: each node's Google JWKS cache is primed with a test key.
 *
 *  1. A global main server. Ada and Ben join through the door. Its sealed take-over bundle carries the key (the
 *     `open-join.key` file, byte for byte) and the rows, and nothing else of the door's: no address hash, and no key in
 *     the door's record; the envelope on disk holds neither in the clear.
 *  2. Its standby copies it (a force-resync): every row and which key made them, and no key and no address hash. A
 *     delta export after another join carries only that row, which key, and no key in any encoding.
 *  3. A copy of that standby promoted by hand (NODE_ROLE=primary), as the recovery seal's key is: it holds no key, says
 *     so at boot, and fails closed. Ada's sign-in account from a new key, and a new account too, are refused 503
 *     door_key_missing, with no member added. The 12-words door needs no key: Vic joins there by 12 words, and adding a
 *     sign-in is refused 503 door_key_missing. With the main server's key file put back by hand, Ada is 409
 *     already_joined and the new account joins.
 *  4. The take-over, from the bundle alone: Wes joins the main server by 12 words and the standby copies it again
 *     (Wes's `words` row with it), then Dan joins it, the main
 *     server re-seals and the standby pulls only the envelope. The standby's copy of the door's rows is then wiped (a
 *     standby that copied before the rows travelled; it still knows which key made them), and the main server dies. The
 *     take-over's open-door step brings the key and the rows back from the keys: the promoted server's key file is the
 *     main server's, byte for byte,
 *     0600; Wes's `words` row is back from the bundle; Ada and Ben are refused 409 with no member added, and Dan (whom
 *     this standby never copied, so has no identity here) can join again rather than be locked out. The key is in neither
 *     the journal nor the step's detail.
 *
 * And the key vault's ticket keys (V5, services/vault-ticket-keys.ts), env config on each server and nothing else: the
 * main server and its standby have the BEANPOOL_VAULT_TICKET_KEYS line, the hand-promoted copy has not. The take-over
 * bundle, the envelope on disk and a delta export carry no new entry and no ticket key; the copy without the line
 * answers `vault: null` and takes a join with the door's own nonce; the server promoted by the take-over, with the line
 * in its own .env, takes a ticket join.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-open-join-failover.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { newVaultTicket, signVaultTicket, solveDoorWorkSync, vaultTicketNonce } from '@beanpool/core';
import { spawnNode, post, copyDir, runNodeChild, type NodeProc } from './takeover-test-harness.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.CF_RECORD_NAME;

// Nothing in this suite may reach a real identity provider or any other host, even if a regression opens a door that
// should be shut: every request that is not to this machine fails as unreachable, which the sign-in code answers with 503.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new TypeError(`this suite reaches no host but this machine (${url.host})`);
    return realFetch(input, init);
}) as typeof fetch;

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Door-Failover-Main-Pw-731!';
const PW_STANDBY = 'Door-Failover-Standby-Pw-58!';
const GOOGLE_KID = 'test-open-join-failover-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';

const fingerprint = (value: string | null | undefined) =>
    value == null ? null : crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

const KEY_FILE = 'open-join.key';

/** Whether any encoding of the key (base64 `keyB64`) is in `text`: raw, base64 (with or without padding), base64url, hex. */
function holdsKey(text: string | Buffer, keyB64: string | null): boolean {
    if (!keyB64) return false;
    const key = Buffer.from(keyB64, 'base64');
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
    return [key, Buffer.from(key.toString('base64').replace(/=+$/, '')), Buffer.from(key.toString('base64url')), Buffer.from(key.toString('hex'))]
        .some((n) => bytes.includes(n));
}

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    const doorRecord = async () => {
        const { db } = await import('./db/db.js');
        const config = (key: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value?: string } | undefined)?.value ?? null;
        const file = path.join(process.env.BEANPOOL_DATA_DIR!, KEY_FILE);
        const key = fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null;
        const keyMode = fs.existsSync(file) ? (fs.statSync(file).mode & 0o777).toString(8) : null;
        const rows = db.prepare('SELECT member_pubkey, join_hash, ip_hash FROM open_joins ORDER BY member_pubkey').all() as any[];
        const members = (db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n;
        return { key, keyMode, keyId: config('openJoinKeyId'), legacyRow: config('openJoinSalt') !== null, rows, members };
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
        reseal: async (a: { vaultKey?: string } = {}) => {
            const { flushTakeoverChecks, readSealingInputs, TAKEOVER_ENVELOPE_FILE, BUNDLED_FILES } = await import('./services/takeover-envelope.js');
            const status = await flushTakeoverChecks();
            const inputs = readSealingInputs();
            const record = inputs.ok ? inputs.bundle.openJoins ?? null : null;
            const { key, rows } = await doorRecord();
            const onDisk = fs.readFileSync(path.join(process.env.BEANPOOL_DATA_DIR!, TAKEOVER_ENVELOPE_FILE), 'utf-8');
            const bundleText = JSON.stringify(inputs.ok ? inputs.bundle : null);
            return {
                envelopeId: status.envelopeId,
                recordKeys: record ? Object.keys(record).sort() : null,
                joinFields: record ? [...new Set(record.joins.flatMap((j) => Object.keys(j)))].sort() : null,
                members: record ? record.joins.map((j) => j.memberPubkey).sort() : null,
                total: record?.total ?? null,
                keySealed: !!key && inputs.ok && inputs.bundle.files[KEY_FILE as keyof typeof inputs.bundle.files] === key,
                keyInRecord: holdsKey(JSON.stringify(record), key),
                addressHashInBundle: rows.some((r) => r.ip_hash && bundleText.includes(r.ip_hash)),
                addressHashesHere: rows.filter((r) => r.ip_hash).length,
                keyInClear: holdsKey(onDisk, key),
                joinHashInClear: rows.some((r) => onDisk.includes(r.join_hash)),
                bundledFiles: inputs.ok ? Object.keys(inputs.bundle.files).sort() : null,
                declaredFiles: [...BUNDLED_FILES].sort(),
                vaultKeyInBundle: !!a.vaultKey && holdsKey(bundleText, Buffer.from(a.vaultKey, 'hex').toString('base64')),
                vaultKeyInClear: !!a.vaultKey && holdsKey(onDisk, Buffer.from(a.vaultKey, 'hex').toString('base64')),
            };
        },
        door: async () => {
            const { key, keyMode, keyId, legacyRow, rows, members } = await doorRecord();
            return {
                keyFp: fingerprint(key), keyMode, keyId, legacyRow, members,
                rows: rows.map((r) => ({ member: r.member_pubkey, hash: r.join_hash, ipHash: !!r.ip_hash })),
            };
        },
        'export-delta': async (a: { since: string; vaultKey?: string }) => {
            const { exportSyncState } = await import('./state-engine.js');
            const payload = await exportSyncState('test', a.since);
            const { key } = await doorRecord();
            return {
                members: (payload.openJoins ?? []).map((j) => j.memberPubkey).sort(),
                fields: [...new Set((payload.openJoins ?? []).flatMap((j) => Object.keys(j)))].sort(),
                keyId: payload.openJoinKeyId ?? null,
                carriesSalt: 'openJoinSalt' in payload,
                keyInPayload: holdsKey(JSON.stringify(payload), key),
                vaultEntries: Object.keys(payload).filter((k) => /vault/i.test(k)),
                vaultKeyInPayload: !!a.vaultKey && holdsKey(JSON.stringify(payload), Buffer.from(a.vaultKey, 'hex').toString('base64')),
            };
        },
        now: async () => new Date().toISOString(),
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        // A standby whose copies never carried the door's rows: the rows gone. Which key made them it keeps, as every
        // copy carries that.
        'forget-door': async () => {
            const { db } = await import('./db/db.js');
            db.prepare('DELETE FROM open_joins').run();
            return true;
        },
        progress: async () => {
            const { getTakeoverProgress, TAKEOVER_JOURNAL_FILE } = await import('./services/takeover.js');
            const { key } = await doorRecord();
            const progress = getTakeoverProgress();
            const journal = path.join(process.env.BEANPOOL_DATA_DIR!, TAKEOVER_JOURNAL_FILE);
            const journalText = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf-8') : '';
            return {
                state: progress.state,
                step: progress.steps.find((s) => s.step === 'open-door') ?? null,
                keyInJournal: holdsKey(journalText, key),
                keyInProgress: holdsKey(JSON.stringify(progress), key),
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

/** Join through the 12-words door at `port` as `id`: the door's work, solved here, and the name. */
async function wordsJoin(port: number, id: Id, callsign: string): Promise<{ status: number; body: any }> {
    const w = await signedPost(port, id, '/api/join/work', { door: 'words' });
    if (w.status !== 200 || !w.body?.work) return w;
    const work = { challenge: w.body.work.challenge, counters: solveDoorWorkSync(w.body.work.challenge) };
    return signedPost(port, id, '/api/join', { door: 'words', callsign, work });
}

// The key vault's ticket key (made here; only its public half goes in a server's env).
const vaultSeed = new Uint8Array(crypto.randomBytes(32));
const VAULT_KEY = Buffer.from(ed25519.getPublicKey(vaultSeed)).toString('hex');
const VAULT_ENV = { BEANPOOL_VAULT_TICKET_KEYS: VAULT_KEY };

/** Join through the door at `port` as `id` with a key vault deposit ticket instead of the door's nonce. */
async function ticketJoin(port: number, id: Id, sub: string, callsign: string): Promise<{ status: number; body: any }> {
    const ticket = signVaultTicket(newVaultTicket(id.pk, 'deposit', Date.now()), vaultSeed);
    const nonce = vaultTicketNonce(ticket);
    return signedPost(port, id, '/api/join', { callsign, provider: 'google', idToken: mintGoogle(sub, nonce), nonce, vaultTicket: ticket });
}

/** What the door at `port` says it takes, in its nonce answer to a new key: `{ ticketKeys }`, null, or the HTTP status. */
async function doorVault(port: number): Promise<unknown> {
    const n = await signedPost(port, newId(), '/api/join/sso-nonce', {});
    return n.status === 200 ? n.body?.vault : `HTTP ${n.status}`;
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
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', ...GLOBAL, ...VAULT_ENV });
        nodes.push(main);
        const { code } = await main.send('setup-primary', { ownerSeedHex, replicationToken });
        const mainHttps = (await main.send('serve', { jwk: googleJwk })).port as number;
        const vaultLine = main.output().split('\n').filter((l) => l.includes('Open door: takes key vault tickets signed by one key'));
        assert(vaultLine.length === 1 && vaultLine[0].includes(VAULT_KEY.slice(0, 8)),
            `its boot says, once, which key vault tickets its door takes (${vaultLine[0] ?? 'no line'})`);
        assert(JSON.stringify(await doorVault(mainHttps)) === JSON.stringify({ ticketKeys: [VAULT_KEY] }),
            'and its nonce answer lists that key');
        const adaJoin = await join(mainHttps, ada, 'ada-google-sub', 'Ada');
        const benJoin = await join(mainHttps, ben, 'ben-google-sub', 'Ben');
        require_(adaJoin.status === 200 && benJoin.status === 200, `Ada and Ben join over HTTPS (${adaJoin.status} ${adaJoin.body?.code ?? ''}, ${benJoin.status} ${benJoin.body?.code ?? ''})`);
        const mainDoor = await main.send('door');
        require_(mainDoor.keyFp && mainDoor.keyMode === '600' && mainDoor.keyId && !mainDoor.legacyRow
            && mainDoor.rows.length === 2 && mainDoor.rows.every((r: any) => r.ipHash),
            'the main server holds two join records, each with its address hash, and the key they are hashed with in data/open-join.key (0600), not in its database');

        const sealed1 = await main.send('reseal', { vaultKey: VAULT_KEY });
        assert(JSON.stringify(sealed1.recordKeys) === JSON.stringify(['joins', 'total'])
            && JSON.stringify(sealed1.joinFields) === JSON.stringify(['joinHash', 'joinedAt', 'memberPubkey', 'provider', 'updatedAt']),
            `the take-over bundle carries the door's rows, and only these fields (${JSON.stringify(sealed1.recordKeys)} ${JSON.stringify(sealed1.joinFields)})`);
        assert(sealed1.keySealed && !sealed1.keyInRecord && sealed1.total === 2 && JSON.stringify(sealed1.members) === JSON.stringify([ada.pk, ben.pk].sort()),
            'it holds both joins, and the key as the bundled file open-join.key, byte for byte, never in the door\'s record');
        assert(sealed1.addressHashesHere === 2 && !sealed1.addressHashInBundle, 'no address hash is in the bundle, though the main server holds two');
        assert(!sealed1.keyInClear && !sealed1.joinHashInClear, 'the envelope on disk holds neither the key nor a join hash in the clear');
        assert(JSON.stringify(sealed1.bundledFiles) === JSON.stringify(sealed1.declaredFiles) && !sealed1.bundledFiles.some((f: string) => /vault|ticket/i.test(f)),
            `the bundle's files are BUNDLED_FILES, none of them the key vault's (${JSON.stringify(sealed1.bundledFiles)})`);
        assert(!sealed1.vaultKeyInBundle && !sealed1.vaultKeyInClear, 'and the vault\'s ticket key is nowhere in the bundle or the envelope on disk, in any encoding');

        // ── 2. The standby copies it ──
        console.log('\n— 2. its standby copies it —');
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        // The standby has the same line in its own .env as the main server: nothing carries it across.
        let standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...GLOBAL, ...VAULT_ENV });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const pulled = await standby.send('pull', {});
        require_(pulled.resync?.ok && pulled.envelope === 'stored', `the standby copied the main server and holds its keys (${JSON.stringify(pulled)})`);
        const copied = await standby.send('door');
        assert(copied.keyFp === null && !copied.legacyRow && copied.keyId === mainDoor.keyId,
            'the standby holds no key for the door\'s hashes, in a file or its database: only which key made them');
        assert(JSON.stringify(copied.rows.map((r: any) => [r.member, r.hash])) === JSON.stringify(mainDoor.rows.map((r: any) => [r.member, r.hash])),
            'and every join record, the same hashes');
        assert(copied.rows.every((r: any) => !r.ipHash), 'and no address hash: the limiter\'s, not the standby\'s');

        const since = await main.send('now');
        const eve = newId();
        const eveJoin = await join(mainHttps, eve, 'eve-google-sub', 'Eve');
        assert(eveJoin.status === 200, `Eve joins (${eveJoin.status})`);
        const delta = await main.send('export-delta', { since, vaultKey: VAULT_KEY });
        assert(JSON.stringify(delta.members) === JSON.stringify([eve.pk]) && delta.keyId === mainDoor.keyId,
            `a delta export since then carries Eve's row alone, and which key made it (${JSON.stringify(delta.members.map((m: string) => m.slice(0, 8)))})`);
        assert(!delta.carriesSalt && !delta.keyInPayload, 'and not the key, in any encoding');
        assert(!delta.fields.includes('ipHash') && !delta.fields.includes('ip_hash'), 'and no address hash');
        assert(delta.vaultEntries.length === 0 && !delta.vaultKeyInPayload,
            `and no entry for the key vault, nor its ticket key in any encoding (${JSON.stringify(delta.vaultEntries)})`);

        // ── 3. A copy of the standby promoted by hand ──
        console.log('\n— 3. a copy of the standby promoted by hand —');
        await standby.send('checkpoint');
        copyDir(dirs.standby, dirs.probe);
        const probe = await spawnNode(SCRIPT, dirs.probe, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'primary', ...GLOBAL });
        nodes.push(probe);
        require_(probe.ready.role === 'primary', 'it starts as a main server');
        const probeBefore = await probe.send('door');
        const missingLine = probe.output().split('\n').filter((l) => /Open door: this server holds \d+ sign-in records? of members who joined through the open door, but data\/open-join\.key is missing/.test(l));
        assert(probeBefore.keyFp === null && missingLine.length === 1 && missingLine[0].includes(`holds ${probeBefore.rows.length} sign-in records`),
            `it has no key for the door's hashes (a standby holds none, as it holds no recovery-seal key), and its boot says so, once (${missingLine[0] ?? 'no line'})`);
        const probeHttps = (await probe.send('serve', { jwk: googleJwk })).port as number;
        const adaAgain = await join(probeHttps, newId(), 'ada-google-sub', 'Ada two');
        assert(adaAgain.status === 503 && adaAgain.body?.code === 'door_key_missing',
            `Ada's Google account, from a new key: refused, 503 door_key_missing, not joined a second time (${adaAgain.status} ${adaAgain.body?.code})`);
        const shutOut = await join(probeHttps, newId(), 'cara-google-sub', 'Cara');
        assert(shutOut.status === 503 && shutOut.body?.code === 'door_key_missing', `and a new Google account too: the door fails closed (${shutOut.status})`);
        assert((await probe.send('door')).members === probeBefore.members, 'no member was added');
        // The 12-words door compares no sign-in, so it needs no key: it stays open where the sign-in door is shut.
        const vic = newId();
        const vicJoin = await wordsJoin(probeHttps, vic, 'Vic');
        const vicRow = (await probe.send('door')).rows.find((r: any) => r.member === vic.pk);
        assert(vicJoin.status === 200 && vicJoin.body?.door === 'words' && typeof vicRow?.hash === 'string' && vicRow.hash.startsWith('words:'),
            `without the key, Vic still joins by 12 words, a \`words\` row with no sign-in behind it (${vicJoin.status} ${vicJoin.body?.code ?? ''})`);
        const vicLink = await signedPost(probeHttps, vic, '/api/join/link/sso-nonce', {});
        assert(vicLink.status === 503 && vicLink.body?.code === 'door_key_missing',
            `and adding a sign-in there is refused, 503 door_key_missing: it would need the key (${vicLink.status} ${vicLink.body?.code})`);
        fs.copyFileSync(path.join(dirs.main, KEY_FILE), path.join(dirs.probe, KEY_FILE));
        const adaWithKey = await join(probeHttps, newId(), 'ada-google-sub', 'Ada two');
        assert(adaWithKey.status === 409 && adaWithKey.body?.code === 'already_joined',
            `with the main server's key file put back by hand: Ada is 409 already_joined (${adaWithKey.status} ${adaWithKey.body?.code})`);
        // This copy was started without the BEANPOOL_VAULT_TICKET_KEYS line: its door takes no tickets, and says so.
        const probeVault = await doorVault(probeHttps);
        assert(probeVault === null, `without the line in its .env, its nonce answer says vault: null (${JSON.stringify(probeVault)})`);
        const ticketHere = await ticketJoin(probeHttps, newId(), 'cara-google-sub', 'Cara');
        assert(ticketHere.status === 401 && ticketHere.body?.code === 'ticket_unsupported',
            `a ticket join there → 401 ticket_unsupported, so a phone uses the door's nonce (${ticketHere.status} ${ticketHere.body?.code})`);
        const newcomer = await join(probeHttps, newId(), 'cara-google-sub', 'Cara');
        assert(newcomer.status === 200, `and a new Google account joins with the door's own nonce (${newcomer.status})`);
        await probe.kill();

        // ── 4. The take-over, from the bundle alone ──
        console.log('\n— 4. the take-over, with the standby\'s own copy of the door\'s record wiped —');
        const wes = newId();
        const wesJoin = await wordsJoin(mainHttps, wes, 'Wes');
        assert(wesJoin.status === 200 && wesJoin.body?.door === 'words', `Wes joins the main server by 12 words (${wesJoin.status} ${wesJoin.body?.code ?? ''})`);
        const recopied = await standby.send('pull', {});
        require_(recopied.resync?.ok, `the standby copies the main server again, Eve and Wes included (${JSON.stringify(recopied.resync)})`);
        const wesCopied = (await standby.send('door')).rows.find((r: any) => r.member === wes.pk);
        assert(typeof wesCopied?.hash === 'string' && wesCopied.hash.startsWith('words:') && !wesCopied.ipHash,
            'the standby\'s copy holds Wes\'s `words` row, with no address hash');
        const dan = newId();
        const danJoin = await join(mainHttps, dan, 'dan-google-sub', 'Dan');
        assert(danJoin.status === 200, `Dan joins the main server after the standby's last copy (${danJoin.status})`);
        const sealed2 = await main.send('reseal');
        assert(sealed2.members?.includes(dan.pk) && sealed2.members?.includes(wes.pk) && sealed2.total === 5,
            `the main server re-seals: the bundle has Dan's row and Wes's (${sealed2.total} in all)`);
        const envOnly = await standby.send('pull', { envelopeOnly: true });
        assert(envOnly.envelope === 'stored', `the standby pulls only the new envelope (${JSON.stringify(envOnly)})`);
        await standby.send('forget-door');
        const wiped = await standby.send('door');
        require_(wiped.rows.length === 0 && wiped.keyFp === null && wiped.keyId === mainDoor.keyId,
            'the standby\'s own copy of the door\'s rows is gone; it knows which key made them, and (a standby) holds no key');

        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code }, pw(PW_STANDBY));
        require_(opened.status === 200, `the recovery code opens the keys (${opened.status} ${opened.body?.error ?? ''})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, pw(PW_STANDBY));
        require_(confirmed.status === 200, `confirmed (${confirmed.status})`);
        const exit = await standby.exited;
        assert(exit === 0, `the standby restarts itself (exit ${exit})`);
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...GLOBAL, ...VAULT_ENV });
        nodes.push(standby);
        require_(standby.ready.role === 'primary', 'it is the main server');

        const progress = await standby.send('progress');
        assert(progress.state === 'complete' && progress.step?.done, `the take-over completed, open-door step included (${progress.state})`);
        assert(/4 sign-in account\(s\) on record here \(the main server had 5 when it sealed\)/.test(progress.step?.detail ?? '')
            && /1 for members this standby never copied/.test(progress.step?.detail ?? '') && /the key for the open door's hashes brought from the keys/.test(progress.step?.detail ?? ''),
            `the step says what it brought back (${progress.step?.detail})`);
        assert(!progress.keyInJournal && !progress.keyInProgress, 'the key is in neither the journal nor the progress the Settings screen reads');
        const after = await standby.send('door');
        assert(after.keyFp === mainDoor.keyFp && after.keyMode === '600' && after.keyId === mainDoor.keyId && !after.legacyRow,
            'the promoted server\'s data/open-join.key is the main server\'s, byte for byte, 0600, recorded as the key its records were made with');
        assert(JSON.stringify(after.rows.map((r: any) => r.member).sort()) === JSON.stringify([ada.pk, ben.pk, eve.pk, wes.pk].sort()),
            'Ada, Ben, Eve and Wes\'s join records are back; Dan\'s is not, as Dan is no member here');
        assert(after.rows.find((r: any) => r.member === wes.pk)?.hash === wesCopied?.hash,
            'Wes\'s is the `words` row, from the keys: a 12-words member is still one after a take-over');

        const standbyHttps = (await standby.send('serve', { jwk: googleJwk })).port as number;
        const membersAfter = after.members as number;
        const adaAfter = await join(standbyHttps, newId(), 'ada-google-sub', 'Ada three');
        assert(adaAfter.status === 409 && adaAfter.body?.code === 'already_joined',
            `after the take-over, Ada's Google account from a new key: refused, 409 already_joined (${adaAfter.status} ${adaAfter.body?.code})`);
        const benAfter = await join(standbyHttps, newId(), 'ben-google-sub', 'Ben two');
        assert(benAfter.status === 409 && benAfter.body?.code === 'already_joined', `and Ben's: 409 already_joined (${benAfter.status})`);
        assert((await standby.send('door')).members === membersAfter, 'and no member was added');
        const danAfter = await join(standbyHttps, dan, 'dan-google-sub', 'Dan');
        assert(danAfter.status === 200 && danAfter.body?.member?.publicKey === dan.pk,
            `Dan, whom the standby never copied, joins again with the same key rather than being locked out (${danAfter.status} ${danAfter.body?.code ?? ''})`);
        // The promoted server has the line in its own .env: its door takes the vault's tickets, as the main server's did.
        assert(JSON.stringify(await doorVault(standbyHttps)) === JSON.stringify({ ticketKeys: [VAULT_KEY] }), 'the promoted server\'s nonce answer lists the vault\'s key');
        const gil = newId();
        const gilJoin = await ticketJoin(standbyHttps, gil, 'gil-google-sub', 'Gil');
        assert(gilJoin.status === 200 && gilJoin.body?.member?.publicKey === gil.pk, `and a join with a key vault ticket is taken there (${gilJoin.status} ${gilJoin.body?.code ?? ''})`);
        const adaByTicket = await ticketJoin(standbyHttps, newId(), 'ada-google-sub', 'Ada four');
        assert(adaByTicket.status === 409 && adaByTicket.body?.code === 'already_joined',
            `while Ada's account, which joined the old main server with the door's nonce, is 409 already_joined with a ticket too (${adaByTicket.status} ${adaByTicket.body?.code})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ The open door\'s record survives a standby and a take-over; without its key, the door stays shut.');
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
