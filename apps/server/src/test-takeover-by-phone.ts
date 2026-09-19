/**
 * Test Suite: take over as the main server on a standby, and restore a sealed backup onto a fresh server, with an
 * OWNER'S PHONE (sealed keys, slice 6).
 *
 * Design: scratch/overnight/design/sealed-keys.md §5.2, §6.2 step 2 and the slice 6 row of §10. The crypto and the
 * session rules are core's owner-unlock.ts (its own tests); this suite is the two servers and the HTTP between them.
 * The phone here is this process running the same core calls the apps make (apps/native/utils/takeover-unlock.ts,
 * apps/pwa/src/lib/takeover-unlock.ts): parse the QR, read the header from the server, check it, re-wrap, sign, POST.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), as in test-takeover-by-code.ts:
 *
 *  1. A MAIN server with an owner (@Anna), an admin (@Ben), a link with another community, a tunnel web address and
 *     a recovery code; its STANDBY copies it and holds its locked keys. The main server is killed.
 *  2. On the standby: "Take over with an owner's phone" needs the standby's own admin sign-in; it answers a QR.
 *  3. The phone reads the header and checks it against the QR. Refused on the standby: a request signed by someone
 *     the keys are not locked to, a request for another community, a bad signature, an unknown session. Then @Anna's
 *     phone — her key in the web app's PKCS8 form — unlocks it. The same request again is refused: single use.
 *  4. The standby's screen gets the preview: the same PeerId, owners, admin, link, web address, "opened by @Anna's
 *     phone"; and nothing secret reached the phone or the preview.
 *  5. Confirm → the journaled promotion → the restart. After: the SAME end state as by code — the same PeerId, the
 *     roles, @Anna's key sign-in, the link, the audit exactly once, the tunnel token — and it says "@Anna's phone",
 *     the notice names @Anna, and no "your recovery code was used" (nothing was spent).
 *  6. A standby holding only another community's keys refuses to start a phone session. Only the NEWEST held envelope
 *     is offered to a phone: when it has no owner the answer is the printed recovery code, never an older envelope an
 *     owner removed since could open; when it has, the session is on it and the removed owner is refused.
 *  7. Restore: a sealed backup from the promoted server, uploaded to a FRESH server with "open with an owner's
 *     phone" → the QR → @Anna's phone (native raw seed) → restored, restarted: the community's PeerId and roles.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-by-phone.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, copyDir, runNodeChild, inspectNode, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Main-Server-Pw-907!';
const PW_STANDBY = 'Standby-Own-Pw-318!';
const PW_FRESH = 'Fresh-Server-Pw-771!';
const TUNNEL_TOKEN = 'eyJ0dW5uZWwiOiJwaG9uZXRvd24ifQ.' + crypto.randomBytes(12).toString('hex');

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; benSeedHex: string; replicationToken: string; tunnelToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { addConnector } = await import('./connector-manager.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const { generateKeyPair } = await import('@libp2p/crypto/keys');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            const pub = (hex: string) => Buffer.from(ed25519.getPublicKey(Buffer.from(hex, 'hex'))).toString('hex');
            const anna = pub(a.ownerSeedHex);
            const ben = pub(a.benSeedHex);
            const cara = crypto.randomBytes(32).toString('hex');
            se.seedGenesisMember(anna, 'Anna');
            const { db } = await import('./db/db.js');
            for (const [key, callsign] of [[ben, 'Ben'], [cara, 'Cara']]) {
                db.prepare('INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)')
                    .run(key, callsign, new Date().toISOString(), anna, 'TEST');
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
            }
            se.grantNodeRole(ben, 'admin', anna);
            try { se.transfer('COMMONS_POOL', cara, 5, 'a commons grant'); } catch { /* the audit still has a ledger */ }
            const neighbour = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
            addConnector(`/ip4/127.0.0.1/tcp/4999/p2p/${neighbour}`, 'peer', 'Neighbours', 'https://neighbours.example', true);
            se.updateNodeConfig({ publicAddress: { name: 'phonetown', mode: 'tunnel', hostname: 'phonetown.beanpool.org', status: 'live', tunnelToken: a.tunnelToken } } as any);
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            const st = await flushTakeoverChecks();
            return { code: made.code, envelopeId: st.envelopeId, anna, ben, neighbour };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async () => {
            const { requestResync, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const { listHeldEnvelopes } = await import('./services/standby-envelopes.js');
            const resync = await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            return { resync, envelope, held: listHeldEnvelopes().map((h) => h.envelopeId) };
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        inspect: (a) => inspectNode(a),
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
        throw new Error(`Assertion failed: ${msg}`);
    }
}
const count = (text: string, needle: string) => text.split(needle).length - 1;
const AUDIT_BANNER = 'FAILOVER PROMOTION — running ledger conservation sanity check';

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby'), probe: path.join(root, 'probe'), fresh: path.join(root, 'fresh') };
    const nodes: NodeProc[] = [];
    const standbyOutputs: string[] = [];
    const core = await import('@beanpool/core');
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const ownerPkcs8Hex = Buffer.from(core.toEd25519Pkcs8(Buffer.from(ownerSeedHex, 'hex'))).toString('hex');
    const benSeedHex = crypto.randomBytes(32).toString('hex');
    const mallorySeed = crypto.randomBytes(32);
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pw = (p: string) => ({ 'X-Admin-Password': p });

    /** The phone, as the apps do it: parse, read the header from the server, check, approve. */
    const phone = async (qrText: string, privateKey: string, expected: { communityId?: string; nodePeerId?: string } = {}) => {
        const qr = core.parseOwnerUnlockQr(qrText);
        if (!qr.ok) throw new Error(`the QR did not parse: ${qr.reason}`);
        const res = await fetch(`${qr.serverUrl}/api/local/admin/unlock/${qr.sessionId}`);
        const described = await res.json() as any;
        if (!res.ok) throw new Error(`describe: ${res.status} ${JSON.stringify(described)}`);
        const pub = Buffer.from(ed25519.getPublicKey(core.toEd25519Seed(Buffer.from(privateKey, 'hex')))).toString('hex');
        const check = core.checkUnlockHeader(qr, described.header, pub, expected);
        return { qr, described, check, request: core.approveOwnerUnlock(qr, check.header, privateKey) };
    };
    /** Re-sign a request as someone else, as a forger would. */
    const resign = (req: any, seed: Uint8Array, changes: Record<string, unknown>) => {
        const { sig: _sig, ...rest } = { ...req, ...changes };
        void _sig;
        const msg = new Uint8Array([...new TextEncoder().encode('bpseal-unlock/v1\n'), ...new TextEncoder().encode(core.canonicalJson(rest))]);
        return { ...rest, sig: Buffer.from(ed25519.sign(msg, seed)).toString('base64') };
    };
    const send = (qr: { serverUrl: string; sessionId: string }, body: unknown) => post(qr.serverUrl, `/api/local/admin/unlock/${qr.sessionId}`, body);

    try {
        // ── 1. A main server and its standby; the main server dies ──
        console.log('\n— 1. a main server, a standby that copies it, and the main server dies —');
        const mainNode = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(mainNode);
        const setup = await mainNode.send('setup-primary', { ownerSeedHex, benSeedHex, replicationToken, tunnelToken: TUNNEL_TOKEN });
        const mainPeerId = mainNode.ready.peerId;
        const communityId = JSON.parse(fs.readFileSync(path.join(dirs.main, 'genesis.json'), 'utf-8')).communityId;
        assert(setup.envelopeId && /^BPRC-1 /.test(setup.code), 'the main server has a take-over envelope (locked to @Anna and code #1)');

        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: mainNode.base, replicationToken, primaryPeerId: mainPeerId });
        const pulled = await standby.send('pull');
        assert(pulled.resync.ok && pulled.envelope === 'stored' && pulled.held.at(-1) === setup.envelopeId, 'the standby copied the database and holds the envelope');
        await standby.send('checkpoint');
        copyDir(dirs.standby, dirs.probe);
        await mainNode.kill('SIGKILL');

        // ── 2. Start the phone session ──
        console.log('\n— 2. "Take over with an owner\'s phone" on the standby —');
        const noAuth = await post(standby.base, '/api/local/admin/takeover/phone/start', {});
        assert(noAuth.status === 401, `without the standby's admin sign-in → 401 (${noAuth.status})`);
        const started = await post(standby.base, '/api/local/admin/takeover/phone/start', { serverUrl: standby.base }, pw(PW_STANDBY));
        assert(started.status === 200 && started.body.qr.startsWith('beanpool-unlock:v1?') && started.body.link.startsWith('beanpool://unlock-keys?'),
            `it answers a QR and the same as a link (${started.status})`);
        assert(JSON.stringify(started.body.owners) === '["@Anna"]' && started.body.envelope.envelopeId === setup.envelopeId,
            'naming who can unlock it (@Anna) and the newest held envelope');
        const waiting = await post(standby.base, '/api/local/admin/takeover/phone/wait', { sessionId: started.body.sessionId }, pw(PW_STANDBY));
        assert(waiting.body.state === 'waiting', 'the screen waits for the phone');

        // ── 3. The phone ──
        console.log('\n— 3. the phone: checks, refusals, then @Anna unlocks —');
        const unknown = await fetch(`${standby.base}/api/local/admin/unlock/${'f'.repeat(64)}`);
        assert(unknown.status === 404, `an unknown session → 404 (${unknown.status})`);
        const anna = await phone(started.body.qr, ownerPkcs8Hex, { communityId, nodePeerId: mainPeerId });
        assert(anna.check.signer === 'pinned' && anna.check.stanza.callsign === 'Anna',
            "the phone finds @Anna's stanza, in a header signed by the community's own server (the pin)");
        assert(anna.described.takeover.mainServerAnswers === false && anna.described.takeover.missing.some((m: string) => /invites/.test(m)),
            'the phone is told the main server does not answer, and what will be missing');
        assert(!JSON.stringify(anna.request).includes(TUNNEL_TOKEN) && !/adminHash|libp2p_key/.test(JSON.stringify(anna.described)),
            'nothing from inside the keys reaches the phone, and the request carries none');

        const malloryPub = Buffer.from(ed25519.getPublicKey(mallorySeed)).toString('hex');
        const notRecipient = await send(anna.qr, resign(anna.request, mallorySeed, { signer: malloryPub }));
        assert(notRecipient.status === 403 && notRecipient.body.reason === 'not-a-recipient',
            `a request signed by someone the keys are not locked to is refused (${notRecipient.status} ${notRecipient.body.reason})`);
        const otherCommunity = await send(anna.qr, resign(anna.request, Buffer.from(ownerSeedHex, 'hex'), { communityId: 'ffffffffffffffff' }));
        assert(otherCommunity.status === 403 && otherCommunity.body.reason === 'wrong-community',
            `a request for another community is refused (${otherCommunity.status} ${otherCommunity.body.reason})`);
        const badSig = await send(anna.qr, { ...anna.request, sig: Buffer.alloc(64, 7).toString('base64') });
        assert(badSig.status === 403 && badSig.body.reason === 'bad-signature', `a bad signature is refused (${badSig.body.reason})`);
        assert(!fs.existsSync(path.join(dirs.standby, 'takeover-journal.json')), 'refusals write nothing');

        const unlocked = await send(anna.qr, anna.request);
        assert(unlocked.status === 200 && unlocked.body.success === true && unlocked.body.purpose === 'takeover',
            `@Anna's phone (her key in the web app's PKCS8 form) unlocks it (${unlocked.status} ${JSON.stringify(unlocked.body)})`);
        const again = await send(anna.qr, anna.request);
        assert(again.status === 410 && again.body.reason === 'used', `the same request again → 410 used: single use (${again.body.reason})`);

        // ── 4. The standby's screen ──
        console.log('\n— 4. the standby\'s screen gets the preview —');
        const followed = await post(standby.base, '/api/local/admin/takeover/phone/wait', { sessionId: started.body.sessionId }, pw(PW_STANDBY));
        assert(followed.body.state === 'unlocked' && followed.body.unlockedBy === '@Anna', `unlocked by @Anna (${followed.body.state})`);
        const pv = followed.body.preview;
        assert(pv.peerId === mainPeerId && pv.openedBy === "@Anna's phone" && pv.envelope.codeId === null,
            "the preview: the main server's PeerId, opened by @Anna's phone");
        assert(JSON.stringify(pv.owners) === '["@Anna"]' && pv.admins === 1 && pv.connectors === 1 && pv.publicAddress === 'phonetown.beanpool.org',
            'owners @Anna, 1 admin, 1 link, the web address');
        assert(pv.tunnel.source === 'envelope', `the tunnel token came with the keys (${pv.tunnel.message})`);
        assert(!JSON.stringify(followed.body).includes(TUNNEL_TOKEN) && !/adminHash|totpSecret|libp2p_key/.test(JSON.stringify(followed.body)),
            'the preview carries no secret from inside the keys');

        // ── 5. Confirm, exactly as for the code ──
        console.log('\n— 5. confirm → the journaled promotion → the restart —');
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: pv.sessionId, confirm: true }, pw(PW_STANDBY));
        assert(confirmed.status === 200 && /^[0-9a-f]{64}$/.test(confirmed.body.progressToken), `the confirm answers with a progress token (${confirmed.status})`);
        const exitCode = await standby.exited;
        standbyOutputs.push(standby.output());
        assert(exitCode === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        assert(standby.ready.role === 'primary' && standby.ready.peerId === mainPeerId,
            `it is the main server, with the SAME PeerId as the dead one (${standby.ready.peerId})`);

        const prog = await post(standby.base, '/api/local/admin/takeover/progress', {}, { 'X-Takeover-Progress': confirmed.body.progressToken });
        assert(prog.body.state === 'complete' && prog.body.steps.every((s: any) => s.done) && prog.body.authorisedBy === "@Anna's phone",
            `complete, every step done, authorised by @Anna's phone (${prog.body.authorisedBy})`);
        const after = await standby.send('inspect', { ownerSeedHex });
        const roles = after.roles as { member_pubkey: string; role: string }[];
        assert(roles.length === 2 && roles.some((r) => r.member_pubkey === setup.anna && r.role === 'owner') && roles.some((r) => r.member_pubkey === setup.ben && r.role === 'admin'),
            'the same roles: @Anna owner, @Ben admin');
        assert(after.keySignIn.solved && after.keySignIn.sessionRole === 'owner', "@Anna's key sign-in works");
        const conns = after.connectors as { address: string; trustLevel: string }[];
        assert(conns.length === 1 && conns[0].address.includes(setup.neighbour) && conns[0].trustLevel === 'peer', 'the link with the other community is back; no mirror pin');
        assert(after.lastPromotionAudit?.ok === true && after.promotionAuditPending === false, 'the ledger adds up');
        assert(after.tunnelTokenFile === TUNNEL_TOKEN && after.publicAddress?.hostname === 'phonetown.beanpool.org', 'the web address and its tunnel token are back');
        assert(after.envelope.state === 'sealed' && JSON.stringify(after.envelope.owners) === '["Anna"]' && JSON.stringify(after.envelope.codes) === '[1]',
            'the keys are locked again on this server, to @Anna and code #1');
        assert(after.progress.codeUsed === null, 'no "your recovery code was used" notice: an owner\'s phone spends nothing');
        assert(/authorised by @Anna\./.test(after.progress.result?.announcement ?? ''), `the notice names @Anna (${after.progress.result?.announcement})`);
        assert(!after.heldDirExists && !after.bundleFileExists, 'the held copies and the opened keys are gone from disk');
        standbyOutputs.push(standby.output());
        assert(count(standbyOutputs.join('\n'), AUDIT_BANNER) === 1, 'the conservation audit ran exactly once');

        // ── 6. Another community's keys ──
        console.log('\n— 6. refused: a standby holding only another community\'s keys —');
        {
            const heldDir = path.join(dirs.probe, 'held-takeover-envelopes');
            const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
            const mainSeed = new Uint8Array(privateKeyFromProtobuf(fs.readFileSync(path.join(dirs.main, 'libp2p_key'))).raw.subarray(0, 32));
            for (const n of fs.readdirSync(heldDir)) fs.rmSync(path.join(heldDir, n));
            const other = await core.sealEnvelope(new TextEncoder().encode('{}'), {
                kind: 'takeover', communityId: 'ffffffffffffffff', nodePeerId: mainPeerId, signingKey: mainSeed,
                recipients: { owners: [{ pubkey: setup.anna, callsign: 'Anna' }] },
            });
            fs.writeFileSync(path.join(heldDir, `${String(Date.now()).padStart(13, '0')}-${core.readSealedHeader(other).envelopeId}.bpseal`), other, { mode: 0o600 });
            const probe = await spawnNode(SCRIPT, dirs.probe, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
            nodes.push(probe);
            const refused = await post(probe.base, '/api/local/admin/takeover/phone/start', { serverUrl: probe.base }, pw(PW_STANDBY));
            assert(refused.status === 409 && refused.body.wrongCommunity === true, `no session: the keys are another community's (${refused.status} ${refused.body.error})`);

            // ── 6b. Only the NEWEST envelope is offered to a phone ──
            console.log('\n— 6b. only the newest held envelope is offered to a phone —');
            for (const n of fs.readdirSync(heldDir)) fs.rmSync(path.join(heldDir, n));
            const zedSeed = crypto.randomBytes(32);
            const zedPub = Buffer.from(ed25519.getPublicKey(zedSeed)).toString('hex');
            const { record: codeRecord } = await core.createRecoveryCode(2);
            let stamp = Date.now();
            const hold = async (createdAt: string, recipients: { owners: { pubkey: string; callsign: string }[]; codes?: any[] }) => {
                const env = await core.sealEnvelope(new TextEncoder().encode('{}'), {
                    kind: 'takeover', communityId, nodePeerId: mainPeerId, signingKey: mainSeed, recipients, createdAt,
                });
                const id = core.readSealedHeader(env).envelopeId;
                fs.writeFileSync(path.join(heldDir, `${String(stamp++).padStart(13, '0')}-${id}.bpseal`), env, { mode: 0o600 });
                return id;
            };
            // An older envelope locked to @Zed, an owner since removed; the newest has no owner at all.
            const olderId = await hold('2026-01-01T00:00:00.000Z', { owners: [{ pubkey: zedPub, callsign: 'Zed' }], codes: [codeRecord] });
            await hold('2026-02-01T00:00:00.000Z', { owners: [], codes: [codeRecord] });
            const codeOnly = await post(probe.base, '/api/local/admin/takeover/phone/start', { serverUrl: probe.base }, pw(PW_STANDBY));
            assert(codeOnly.status === 409 && codeOnly.body.noOwnerStanza === true && /printed recovery code/.test(codeOnly.body.error),
                `the newest has no owner → no session, "use the printed recovery code", not the older one @Zed could open (${codeOnly.status} ${codeOnly.body.error})`);
            assert(!JSON.stringify(codeOnly.body).includes(olderId), 'the older envelope is not offered');

            // A newer one locked to @Anna: the session is on it, and @Zed can't open it.
            const newestId = await hold('2026-03-01T00:00:00.000Z', { owners: [{ pubkey: setup.anna, callsign: 'Anna' }], codes: [codeRecord] });
            const onNewest = await post(probe.base, '/api/local/admin/takeover/phone/start', { serverUrl: probe.base }, pw(PW_STANDBY));
            assert(onNewest.status === 200 && onNewest.body.envelope.envelopeId === newestId && JSON.stringify(onNewest.body.owners) === '["@Anna"]',
                `the newest locked to an owner → a session on it, for @Anna (${onNewest.status})`);
            const annaProbe = await phone(onNewest.body.qr, ownerSeedHex, { communityId, nodePeerId: mainPeerId });
            const zedTry = await send(annaProbe.qr, resign(annaProbe.request, zedSeed, { signer: zedPub }));
            assert(zedTry.status === 403 && zedTry.body.reason === 'not-a-recipient',
                `the removed owner @Zed's phone is refused (${zedTry.status} ${zedTry.body.reason})`);
            await probe.kill();
        }

        // ── 7. Restore onto a fresh server with the phone ──
        console.log('\n— 7. restore a sealed backup onto a fresh server with @Anna\'s phone —');
        const dl = await fetch(standby.base + '/api/local/admin/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', ...pw(PW_MAIN) }, body: '{}' });
        const backupBytes = new Uint8Array(await dl.arrayBuffer());
        assert(dl.ok && core.readSealedHeader(backupBytes).kind === 'backup', `a sealed backup from the promoted server (${dl.status}, ${backupBytes.length} bytes)`);
        let fresh = await spawnNode(SCRIPT, dirs.fresh, { ADMIN_PASSWORD: PW_FRESH, NODE_ROLE: 'primary' });
        nodes.push(fresh);
        assert(fresh.ready.peerId !== mainPeerId, 'a fresh server, with its own PeerId');
        const upload = (headers: Record<string, string>) => fetch(fresh.base + '/api/local/admin/restore', {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...pw(PW_FRESH), ...headers }, body: backupBytes,
        }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
        const inspect = await upload({});
        assert(inspect.status === 400 && inspect.body.ownerPhoneCanOpen === true && /owner's phone/.test(inspect.body.error),
            `without a code it says an owner's phone can open it (${inspect.body.error})`);
        const kept = await upload({ 'X-Unlock-With': 'phone', 'X-Unlock-Server-Url': fresh.base });
        assert(kept.status === 202 && kept.body.needsOwnerPhone && kept.body.phone.qr.startsWith('beanpool-unlock:v1?'),
            `"open with an owner's phone" keeps the file and answers a QR (${kept.status})`);
        assert(fs.readdirSync(dirs.fresh).some((n) => n.startsWith('uploaded-backup.pending-')), 'the file waits on the server, still locked');
        const annaRestore = await phone(kept.body.phone.qr, ownerSeedHex, { communityId });
        assert(annaRestore.qr.purpose === 'restore' && annaRestore.described.restore.backup.envelopeId === core.readSealedHeader(backupBytes).envelopeId,
            'the phone reads the backup it will open');
        const restored = await send(annaRestore.qr, annaRestore.request);
        assert(restored.status === 200 && restored.body.success && restored.body.purpose === 'restore',
            `@Anna's phone (native raw seed) opens it and the server restores (${restored.status} ${JSON.stringify(restored.body)})`);
        const ownPwNow = await post(fresh.base, '/api/local/admin/restore/phone/wait', { sessionId: kept.body.phone.sessionId }, pw(PW_FRESH));
        assert(ownPwNow.status !== 200, `a password sign-in cannot follow it: the database is closed for the restart (${ownPwNow.status})`);
        const waitRestore = await post(fresh.base, '/api/local/admin/restore/phone/wait', { sessionId: kept.body.phone.sessionId },
            { 'X-Unlock-Follow': kept.body.phone.followToken });
        assert(waitRestore.body.state === 'restored' && waitRestore.body.unlockedBy === '@Anna' && waitRestore.body.result.restoredKeys === true,
            `the screen that started it follows it with its token: restored by @Anna, keys and all (${waitRestore.status} ${waitRestore.body.state})`);
        const wrongToken = await post(fresh.base, '/api/local/admin/restore/phone/wait', { sessionId: kept.body.phone.sessionId }, { 'X-Unlock-Follow': 'a'.repeat(64) });
        assert(wrongToken.status === 401, 'another token does not');
        assert(!fs.readdirSync(dirs.fresh).some((n) => n.startsWith('uploaded-backup.pending-')), 'the kept file is gone');
        await fresh.exited;
        fresh = await spawnNode(SCRIPT, dirs.fresh, { ADMIN_PASSWORD: PW_FRESH, NODE_ROLE: 'primary' });
        nodes.push(fresh);
        const restoredState = await fresh.send('inspect', { ownerSeedHex });
        assert(fresh.ready.peerId === mainPeerId, `after its restart it is the community's server: the same PeerId (${fresh.ready.peerId})`);
        assert((restoredState.roles as any[]).some((r) => r.member_pubkey === setup.anna && r.role === 'owner') && restoredState.keySignIn.solved,
            "@Anna is its owner and her key signs in");
        const communityPw = await post(fresh.base, '/api/local/admin/takeover/progress', {}, pw(PW_MAIN));
        assert(communityPw.status === 200, "the community's admin password works on it");
        const freshPw = await post(fresh.base, '/api/local/admin/takeover/progress', {}, pw(PW_FRESH));
        assert(freshPw.status === 401, "and the fresh server's own no longer does: why the screen follows the restore with its token");

        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
        console.log('⭐️ ALL TAKE-OVER-BY-PHONE CHECKS PASSED.');
    } catch (e: any) {
        console.error(e);
        for (const n of nodes) console.error(`\n──── node on :${n.port} ────\n` + n.output().slice(-4000));
        if (e?.output) console.error('\n──── node that did not start ────\n' + String(e.output).slice(-4000));
        throw e;
    } finally {
        for (const n of nodes) await n.kill().catch(() => {});
    }
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch(() => process.exit(1));
}
