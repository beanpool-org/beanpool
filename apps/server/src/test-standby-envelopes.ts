/**
 * Test Suite: the standby holds the main server's take-over envelopes (sealed keys, slice 4).
 *
 * Design: scratch/overnight/design/sealed-keys.md §3, §4, §9 and the slice 4 row of §10.
 *
 * This process is the STANDBY (NODE_ROLE=backup) and BEANPOOL_DATA_DIR is its data dir. Sections 1–7 talk to a
 * stand-in main server over real HTTP on 127.0.0.1 that seals with a key held only in this test's memory, so the
 * plaintext it seals is never on the standby's disk unless the standby put it there (section 7 greps for it).
 * Section 8 then talks to the real GET takeover-envelope route.
 *
 *  1. No token → nothing is fetched and the status says why.
 *  2. An old main server (plain 404, no envelope route) → "the main server is too old to send a take-over
 *     envelope", nothing held. A new main server with nothing to send (404 + state) says so instead.
 *  3. The first envelope, signed by the pinned mirror, is kept; the status names its recipients.
 *  4. The next tick sends If-None-Match with the held envelopeId and gets a bodyless 304.
 *  5. Refused, with a SECURITY log line and nothing written: an envelope signed by a non-mirror key; one that
 *     names the mirror but is signed by another key; a backup envelope signed by the mirror; junk bytes.
 *  6. Six envelopes → the sixth evicts only the oldest; a recipient change is flagged, and clears on the next.
 *  7. No plaintext on the standby's disk (every file, state.db included, grepped for the sealed payload's markers
 *     and the recovery code).
 *  8. Against the real route: fetched with the token, the ETag honoured (304), and the main server's status says
 *     which standby holds which envelope — "was sent", then "holds", then "from before the latest change".
 *  9. The status routes on both ends carry it (backup-status, takeover/status, replication-access).
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-envelopes.ts
 */

process.env.TAKEOVER_RESEAL_DEBOUNCE_MS = '40';
delete process.env.BACKUP_ADMIN_PASSWORD;
delete process.env.BACKUP_REPLICATION_TOKEN;
delete process.env.BACKUP_PRIMARY_URL;

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import { ed25519 } from '@noble/curves/ed25519.js';

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DATA_DIR = process.env.BEANPOOL_DATA_DIR;
if (!DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

/** Every file under dir whose bytes contain needle (state.db and its WAL included). */
function filesContaining(dir: string, needle: string): string[] {
    const hits: string[] = [];
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile() && fs.readFileSync(p).includes(Buffer.from(needle))) hits.push(path.relative(dir, p));
        }
    };
    walk(dir);
    return hits;
}

async function main() {
    const { initStateEngine, setNodeRole, grantNodeRole } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { addConnector, removeConnector } = await import('./connector-manager.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
    const { updateLocalConfig, setReplicationToken } = await import('./config/local-config.js');
    const core = await import('@beanpool/core');
    const sb = await import('./services/standby-envelopes.js');
    const { pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
    const svc = await import('./services/takeover-envelope.js');
    const { createTakeoverEnvelopeRoutes } = await import('./routes/takeover-envelope.js');
    const { createBackupRoutes } = await import('./routes/backup.js');

    initStateEngine();
    await ensureGenesis();
    setNodeRole('backup');

    // ── The stand-in main server: its key lives in this test's memory only ──
    async function nodeKey() {
        const priv = await generateKeyPair('Ed25519');
        return { priv, seed: new Uint8Array(priv.raw.subarray(0, 32)), peerId: peerIdFromPrivateKey(priv).toString() };
    }
    const main = await nodeKey();
    const stranger = await nodeKey();
    const mirrorAddr = `/ip4/127.0.0.1/tcp/4991/p2p/${main.peerId}`;
    addConnector(mirrorAddr, 'mirror', 'main-server', undefined, false);

    const ownerSeed = crypto.randomBytes(32);
    const anna = { pubkey: Buffer.from(ed25519.getPublicKey(ownerSeed)).toString('hex'), callsign: 'Anna' };
    const benSeed = crypto.randomBytes(32);
    const ben = { pubkey: Buffer.from(ed25519.getPublicKey(benSeed)).toString('hex'), callsign: 'Ben' };
    const { code, record } = await core.createRecoveryCode(1);

    // What a real bundle would hold, as markers the grep in section 7 can find.
    const MARKERS = {
        libp2pKey: 'LIBP2P-KEY-' + crypto.randomBytes(12).toString('hex'),
        adminHash: 'ADMIN-HASH-' + crypto.randomBytes(12).toString('hex'),
        totpSecret: 'TOTP-SECRET-' + crypto.randomBytes(12).toString('hex'),
        tunnelToken: 'TUNNEL-TOKEN-' + crypto.randomBytes(12).toString('hex'),
    };
    const payload = new TextEncoder().encode(JSON.stringify({
        v: 1,
        files: { libp2p_key: Buffer.from(MARKERS.libp2pKey).toString('base64') },
        localConfig: { adminHash: MARKERS.adminHash, totpSecret: MARKERS.totpSecret },
        publicAddress: { tunnelToken: MARKERS.tunnelToken },
    }));
    const communityId = JSON.parse(fs.readFileSync(path.join(DATA_DIR!, 'genesis.json'), 'utf-8')).communityId;

    let clock = Date.parse('2026-09-20T01:00:00Z');
    async function seal(opts: { signer?: typeof main; claim?: string; owners?: typeof anna[]; codes?: boolean; kind?: 'takeover' | 'backup' } = {}) {
        clock += 60_000;
        return core.sealEnvelope(payload, {
            kind: opts.kind ?? 'takeover',
            communityId,
            nodePeerId: opts.claim ?? (opts.signer ?? main).peerId,
            recipients: { owners: opts.owners ?? [anna], codes: opts.codes === false ? [] : [record] },
            signingKey: (opts.signer ?? main).seed,
            createdAt: new Date(clock).toISOString(),
        });
    }

    type Mode = { kind: 'serve'; bytes: Uint8Array } | { kind: 'old' } | { kind: 'none' };
    let mode: Mode = { kind: 'old' };
    const seen: { ifNoneMatch: string | undefined; token: string | undefined; status: number; bodyBytes: number }[] = [];
    const server = http.createServer((req, res) => {
        const entry = { ifNoneMatch: req.headers['if-none-match'] as string | undefined, token: req.headers['x-replication-token'] as string | undefined, status: 0, bodyBytes: 0 };
        seen.push(entry);
        const send = (status: number, body: Buffer | string, headers: Record<string, string> = {}) => {
            entry.status = status;
            entry.bodyBytes = Buffer.byteLength(body);
            res.writeHead(status, headers);
            res.end(body);
        };
        if (req.url !== sb.TAKEOVER_ENVELOPE_PATH) return send(404, 'Not Found', { 'Content-Type': 'text/plain' });
        if (mode.kind === 'old') return send(404, 'Not Found', { 'Content-Type': 'text/plain' }); // Koa's default 404
        if (mode.kind === 'none') {
            return send(404, JSON.stringify({ error: 'No take-over envelope: this server has no owner and no recovery code, so there is nobody to lock its keys to.', state: 'no-recipients' }), { 'Content-Type': 'application/json' });
        }
        let id = 'junk';
        try { id = core.readSealedHeader(mode.bytes).envelopeId; } catch { /* section 5 serves junk on purpose */ }
        const inm = String(req.headers['if-none-match'] || '').split(',').map((t) => t.trim().replace(/^W\//, '').replace(/^"|"$/g, ''));
        if (inm.includes(id)) return send(304, '', { ETag: `"${id}"` });
        return send(200, Buffer.from(mode.bytes), { ETag: `"${id}"`, 'Content-Type': 'application/octet-stream' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const mainUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const TOKEN = 'rep-token-standby-envelopes-1';
    const pull = () => sb.pullTakeoverEnvelope({ primaryUrl: mainUrl, replicationToken: TOKEN });
    const heldIds = () => sb.listHeldEnvelopes().map((h) => h.envelopeId);
    const securityLogs = () => (db.prepare(`SELECT message FROM system_logs WHERE level = 'SECURITY' ORDER BY id`).all() as { message: string }[]).map((r) => r.message);

    try {
        // ── 1. No token ──
        console.log('\n— 1. no token —');
        const r1 = await sb.pullTakeoverEnvelope({ primaryUrl: mainUrl, replicationToken: null });
        assert(r1 === 'no-token' && seen.length === 0, '1. with no replication token nothing is fetched');
        assert(/no replication token/.test(sb.getHeldEnvelopesStatus().message), `1. the status says why: "${sb.getHeldEnvelopesStatus().message}"`);

        // ── 2. An old main server ──
        console.log('\n— 2. old main server (404) —');
        mode = { kind: 'old' };
        const r2 = await pull();
        assert(r2 === 'main-too-old', `2. a plain 404 is an old main server (got ${r2})`);
        assert(seen.at(-1)!.token === TOKEN, '2. the fetch carries the replication token');
        const st2 = sb.getHeldEnvelopesStatus();
        assert(st2.state === 'holding-none' && st2.held.length === 0, '2. nothing held');
        assert(/the main server is too old to send a take-over envelope/i.test(st2.message), `2. the status says so: "${st2.message}"`);
        mode = { kind: 'none' };
        assert((await pull()) === 'main-has-none', '2. a 404 with a state is a new main server with nothing to send');
        assert(/nobody to lock/.test(sb.getHeldEnvelopesStatus().message) && !/too old/.test(sb.getHeldEnvelopesStatus().message),
            `2. …and says that instead: "${sb.getHeldEnvelopesStatus().message}"`);

        // ── 3. The first envelope ──
        console.log('\n— 3. first envelope —');
        const e1 = await seal();
        mode = { kind: 'serve', bytes: e1 };
        const id1 = core.readSealedHeader(e1).envelopeId;
        assert((await pull()) === 'stored', '3. a mirror-signed envelope is stored');
        assert(seen.at(-1)!.ifNoneMatch === undefined, '3. the first fetch sends no If-None-Match (nothing held)');
        assert(JSON.stringify(heldIds()) === JSON.stringify([id1]), '3. it is held');
        const file1 = fs.readdirSync(path.join(DATA_DIR!, sb.HELD_ENVELOPES_DIR)).find((n) => n.endsWith('.bpseal'))!;
        const stat1 = fs.statSync(path.join(DATA_DIR!, sb.HELD_ENVELOPES_DIR, file1));
        assert((stat1.mode & 0o777) === 0o600, `3. the file is owner-only (mode ${(stat1.mode & 0o777).toString(8)})`);
        assert(Buffer.compare(fs.readFileSync(path.join(DATA_DIR!, sb.HELD_ENVELOPES_DIR, file1)), Buffer.from(e1)) === 0, '3. the bytes are kept exactly as received (sealed)');
        const st3 = sb.getHeldEnvelopesStatus();
        assert(st3.state === 'holding' && st3.newest?.envelopeId === id1 && !st3.recipientsChanged, '3. status: holding, newest is it, no change flagged');
        assert(/@Anna/.test(st3.message) && /recovery code #1/.test(st3.message) && /cannot open/.test(st3.message), `3. status names who opens it: "${st3.message}"`);

        // ── 4. The 304 path ──
        console.log('\n— 4. 304 —');
        assert((await pull()) === 'unchanged', '4. the next tick reports unchanged');
        const last = seen.at(-1)!;
        assert(last.ifNoneMatch === `"${id1}"`, `4. it sent If-None-Match "${id1.slice(0, 8)}…" (got ${last.ifNoneMatch})`);
        assert(last.status === 304 && last.bodyBytes === 0, '4. the main server answered a bodyless 304');
        assert(heldIds().length === 1, '4. still exactly one held');

        // ── 5. Refusals ──
        console.log('\n— 5. refused —');
        const secBefore = securityLogs().length;
        const refusals: [string, Uint8Array][] = [
            ['signed by a non-mirror key', await seal({ signer: stranger })],
            ['naming the mirror but signed by another key', await seal({ signer: stranger, claim: main.peerId })],
            ['a backup envelope, even signed by the mirror', await seal({ kind: 'backup' })],
            ['not an envelope at all', new TextEncoder().encode('{"hello":"world"}')],
        ];
        for (const [what, bytes] of refusals) {
            mode = { kind: 'serve', bytes };
            const r = await pull();
            assert(r === 'rejected', `5. ${what}: rejected (got ${r})`);
            assert(JSON.stringify(heldIds()) === JSON.stringify([id1]), `5. ${what}: nothing written, the held one untouched`);
        }
        const sec = securityLogs().slice(secBefore);
        assert(sec.length === refusals.length && sec.every((m) => /Refused a take-over envelope/.test(m)), `5. one SECURITY log line per refusal (${sec.length})`);
        assert(sec[0].includes(stranger.peerId) && /not the main server this standby copies from/.test(sec[0]), `5. the line names the signer: "${sec[0]}"`);
        assert(/signature does not match/.test(sec[1]), `5. a forged signature is named as such: "${sec[1]}"`);
        const st5 = sb.getHeldEnvelopesStatus();
        assert(st5.lastRejected?.signer === null && /did not update/.test(st5.message), `5. the status keeps the held copy and says the last check failed: "${st5.message}"`);
        // No pin at all → refuse even the real main server's envelope.
        removeConnector(mirrorAddr);
        mode = { kind: 'serve', bytes: await seal() };
        assert((await pull()) === 'rejected' && /no pinned main server/.test(sb.getHeldEnvelopesStatus().lastRejected!.why), '5. with no mirror pin, nothing is trusted');
        addConnector(mirrorAddr, 'mirror', 'main-server', undefined, false);

        // ── 6. Keep five ──
        console.log('\n— 6. keep five —');
        const ids = [id1];
        for (let i = 2; i <= 5; i++) {
            const e = await seal();
            mode = { kind: 'serve', bytes: e };
            assert((await pull()) === 'stored', `6. envelope ${i} stored`);
            ids.push(core.readSealedHeader(e).envelopeId);
        }
        assert(JSON.stringify(heldIds()) === JSON.stringify(ids), '6. five held, oldest first');
        // The sixth changes who it is locked to: Ben added, the code dropped.
        const e6 = await seal({ owners: [anna, ben], codes: false });
        mode = { kind: 'serve', bytes: e6 };
        assert((await pull()) === 'stored', '6. the sixth is stored');
        ids.push(core.readSealedHeader(e6).envelopeId);
        assert(JSON.stringify(heldIds()) === JSON.stringify(ids.slice(1)), '6. the sixth evicted only the oldest (the first); the other four kept, in order');
        assert(sb.readHeldEnvelope(ids[0]) === null && sb.readHeldEnvelope(ids[1]) !== null, '6. the first is gone, the second still reads');
        const st6 = sb.getHeldEnvelopesStatus();
        assert(st6.recipientsChanged && st6.change!.ownersAdded.join() === '@Ben' && st6.change!.codesRemoved.join() === '1', '6. the recipient change is flagged: +@Ben, -code #1');
        assert(/changed since the copy before it: added @Ben; dropped recovery code #1/.test(st6.message), `6. …in words: "${st6.message}"`);
        const e7 = await seal({ owners: [anna, ben], codes: false });
        mode = { kind: 'serve', bytes: e7 };
        await pull();
        assert(heldIds().length === 5 && !sb.getHeldEnvelopesStatus().recipientsChanged, '6. a seventh with the same recipients: still five, no change flagged');
        // The same envelope served again (say its ETag was lost) is not stored twice.
        mode = { kind: 'serve', bytes: e7 };
        const before = heldIds();
        seen.length = 0;
        await sb.pullTakeoverEnvelope({ primaryUrl: mainUrl, replicationToken: TOKEN });
        assert(JSON.stringify(heldIds()) === JSON.stringify(before), '6. an envelope already held is not kept twice');

        // ── 7. No plaintext on the standby's disk ──
        console.log('\n— 7. no plaintext —');
        // The held envelopes do open, for an owner and the code: they are the real thing, just locked.
        const newestBytes = sb.readHeldEnvelope(sb.listHeldEnvelopes().at(-1)!.envelopeId)!;
        const opened = await core.openEnvelope(newestBytes, { type: 'owner', privateKey: benSeed }, { kind: 'takeover' });
        assert(new TextDecoder().decode(opened.payload).includes(MARKERS.adminHash), '7. (control) Ben opens the newest held copy and the markers are inside');
        const oldestHeld = sb.readHeldEnvelope(sb.listHeldEnvelopes()[0].envelopeId)!;
        const openedByCode = await core.openEnvelope(oldestHeld, { type: 'code', code }, { kind: 'takeover' });
        assert(openedByCode.payload.length === payload.length, '7. (control) the code opens an older held copy');
        db.pragma('wal_checkpoint(FULL)');
        for (const [name, marker] of Object.entries(MARKERS)) {
            const hits = filesContaining(DATA_DIR!, marker);
            assert(hits.length === 0, `7. no file in the standby's data dir holds the ${name} (found in: ${hits.join(', ') || 'none'})`);
            const b64 = Buffer.from(marker).toString('base64');
            assert(filesContaining(DATA_DIR!, b64).length === 0, `7. …nor its base64`);
        }
        assert(filesContaining(DATA_DIR!, code).length === 0 && filesContaining(DATA_DIR!, code.replace(/^BPRC-\d+\s+/, '')).length === 0, '7. the recovery code is nowhere on disk');

        // ── 8. Against the real route ──
        console.log('\n— 8. the real GET takeover-envelope route —');
        // The main server's side, in this process: its own node key, an owner, a token. The standby pins it.
        fs.writeFileSync(path.join(DATA_DIR!, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
        const realMain = svc.readNodeIdentity()!;
        for (const w of [{ ...anna, seed: ownerSeed }, { ...ben, seed: benSeed }]) {
            db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                        VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(w.pubkey, w.callsign);
            db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(w.pubkey);
        }
        grantNodeRole(anna.pubkey, 'owner', 'owner:password');
        setReplicationToken(TOKEN);
        const deps: any = {
            checkAdminAuth: async () => true, // the admin routes' own auth is covered by their suites
            rateLimit: () => true, clampLimit: (_v: unknown, d = 20) => d, clampOffset: () => 0,
            activeConnections: new Map(), calculateAnalytics: () => ({}), enforceReadAuth: false,
        };
        const app = new Koa();
        app.use(async (ctx, next) => { (ctx as any).requestBody = {}; await next(); });
        app.use(createTakeoverEnvelopeRoutes(deps).routes());
        app.use(createBackupRoutes(deps).routes());
        const realServer = http.createServer(app.callback());
        await new Promise<void>((r) => realServer.listen(0, '127.0.0.1', () => r()));
        const realUrl = `http://127.0.0.1:${(realServer.address() as AddressInfo).port}`;
        try {
            removeConnector(mirrorAddr);
            const realMirror = `/ip4/127.0.0.1/tcp/4993/p2p/${realMain.peerId}`;
            addConnector(realMirror, 'mirror', 'real-main', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: realUrl, backupReplicationToken: TOKEN });
            const current = await svc.flushTakeoverChecks();
            assert(current.state === 'sealed', `8. the main server has an envelope (${current.state})`);

            const r8 = await pullTakeoverEnvelopeNow();
            assert(r8 === 'stored' && sb.listHeldEnvelopes().at(-1)!.envelopeId === current.envelopeId, `8. the puller fetched the real envelope with the token (${r8})`);
            assert(heldIds().length === 5, '8. still five held');
            let holders = svc.getEnvelopeHolders();
            assert(holders.length === 1 && holders[0].envelopeId === current.envelopeId && holders[0].current && holders[0].how === 'sent',
                '8. the main server records which envelope went to this standby');
            assert(/The standby at \S*127\.0\.0\.1 was sent the take-over keys sealed .*the current lock/.test(holders[0].message), `8. "${holders[0].message}"`);

            assert((await pullTakeoverEnvelopeNow()) === 'unchanged', '8. the next tick: 304 from the real route');
            holders = svc.getEnvelopeHolders();
            assert(holders[0].how === 'confirmed' && /holds the take-over keys/.test(holders[0].message), `8. …and the main server now says it holds them: "${holders[0].message}"`);

            // An owner is added: the main server re-seals; until the standby's next tick it is named as behind.
            grantNodeRole(ben.pubkey, 'owner', anna.pubkey);
            await sleep(150);
            const resealed = await svc.flushTakeoverChecks();
            assert(resealed.envelopeId !== current.envelopeId, '8. adding Ben re-sealed');
            holders = svc.getEnvelopeHolders();
            assert(!holders[0].current && /from before the latest change/.test(holders[0].message), `8. the standby is named as holding keys from before the change: "${holders[0].message}"`);
            assert((await pullTakeoverEnvelopeNow()) === 'stored', '8. the next tick fetches the new one');
            const st8 = sb.getHeldEnvelopesStatus();
            assert(st8.recipientsChanged && st8.change!.ownersAdded.includes('@Ben'), '8. the standby flags the added owner');
            assert(svc.getEnvelopeHolders()[0].current, '8. and the main server says it is current again');

            // ── 9. Status routes ──
            console.log('\n— 9. status routes —');
            const post = async (p: string) => {
                const res = await fetch(realUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                return { status: res.status, body: await res.json() as any };
            };
            const bs = await post('/api/local/admin/backup-status');
            assert(bs.status === 200 && bs.body.takeoverEnvelopes?.newest?.envelopeId === resealed.envelopeId, '9. backup-status on a standby carries what it holds');
            assert(bs.body.takeoverEnvelopes.held.length === 5 && bs.body.takeoverEnvelopes.recipientsChanged === true, '9. …five, with the change flag');
            const ts = await post('/api/local/admin/takeover/status');
            assert(ts.status === 200 && ts.body.held?.newest?.envelopeId === resealed.envelopeId && Array.isArray(ts.body.standbys), '9. takeover/status on a standby carries what it holds');
            setNodeRole('primary');
            const ts2 = await post('/api/local/admin/takeover/status');
            assert(ts2.body.held === null && ts2.body.standbys[0]?.current === true, '9. takeover/status on a main server lists the standbys and what they hold');
            const bs2 = await post('/api/local/admin/backup-status');
            assert(bs2.body.takeoverEnvelopes === null, '9. backup-status on a main server has no held envelopes');
            const ra = await post('/api/local/admin/replication-access');
            assert(ra.status === 200 && ra.body.envelopeHolders?.[0]?.ip?.includes("127.0.0.1"), '9. replication-access lists who holds which envelope');
            for (const body of [bs.body, ts.body, ts2.body, ra.body]) {
                const text = JSON.stringify(body);
                assert(!Object.values(MARKERS).some((m) => text.includes(m)) && !text.includes(code), '9. no status carries a plaintext field or the code');
            }
            setNodeRole('backup');
        } finally {
            await new Promise<void>((r) => realServer.close(() => r()));
        }

        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
        if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
        console.log('⭐️ ALL STANDBY-ENVELOPE CHECKS PASSED.');
    } finally {
        svc.stopTakeoverEnvelopeService();
        await new Promise<void>((r) => server.close(() => r()));
    }
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
