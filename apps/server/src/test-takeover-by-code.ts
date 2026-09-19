/**
 * Test Suite: take over as the main server on a standby, with the printed recovery code (sealed keys, slice 5).
 *
 * Design: scratch/overnight/design/sealed-keys.md §1.3, §5.3–§5.5 and the slice 5 row of §10. Crash-and-resume at
 * every journal step is test-takeover-crash-resume.ts.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts): a MAIN server, its STANDBY, and
 * later a THIRD server that was never part of any of this.
 *
 *  1. The main server has an owner (@Anna, with a member key), an admin (@Ben), a link with another community, a
 *     tunnel web address, a replication token and a recovery code. The standby copies it and holds its locked keys.
 *     Then the main server's registrar answer loses the tunnel token (967 follow-up #2, the old behaviour) and the
 *     standby copies the envelope sealed without it.
 *  2. The main server is killed.
 *  3. On the standby: a typo and a code of the wrong number are answered at once and cost nothing; six wrong codes
 *     brake the source even though every request carries the standby's admin password; the seventh, the RIGHT
 *     code, is refused while braked; after the wait it opens.
 *  4. The preview: the main server's PeerId, the owner, the admin, the link, the web address, the tunnel token
 *     from the OLDER envelope, "the main server does not answer", and what will be missing.
 *  5. Confirm → the journaled promotion → the process restarts itself → started again (NODE_ROLE=backup still in its
 *     environment, as a redeploy with the standby's old .env would be).
 *  6. After: the SAME PeerId; the roles; @Anna's key sign-in works; the link with the other community is back and
 *     the mirror pin gone; the community's admin password works and the standby's own does not; the conservation
 *     audit ran exactly once across every start; the tunnel token is back; the keys are re-sealed on this server
 *     to @Anna and the code; the used-code notice shows; the held envelopes and the opened keys are gone.
 *  7. A third server, pinned to the main server's PeerId, copies from the promoted standby: it accepts the sync
 *     payload and the take-over envelope, because they are signed with the same key.
 *  8. Refused: an envelope for another community (by its header, and by the bundle inside a header that lies);
 *     a forged newest envelope (not signed by the pinned main server) is skipped for the real one.
 *  9. The public-address agent keeps the last tunnel token when the registrar leaves it out.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-by-code.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, copyDir, runNodeChild, inspectNode, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Main-Server-Pw-907!';
const PW_STANDBY = 'Standby-Own-Pw-318!';
const PW_THIRD = 'Third-Server-Pw-552!';
const TUNNEL_TOKEN = 'eyJ0dW5uZWwiOiJ0ZXN0dG93biJ9.' + crypto.randomBytes(12).toString('hex');

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
            let transferred = false;
            let transferError: string | null = null;
            try { transferred = !!se.transfer('COMMONS_POOL', cara, 5, 'a commons grant'); } catch (e: any) { transferError = e?.message || String(e); }
            const neighbour = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
            addConnector(`/ip4/127.0.0.1/tcp/4999/p2p/${neighbour}`, 'peer', 'Neighbours', 'https://neighbours.example', true);
            se.updateNodeConfig({ publicAddress: { name: 'testtown', mode: 'tunnel', hostname: 'testtown.beanpool.org', status: 'live', tunnelToken: a.tunnelToken } } as any);
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            const st = await flushTakeoverChecks();
            return { code: made.code, codeId: made.codeId, envelopeId: st.envelopeId, anna, ben, neighbour, transferred, transferError };
        },
        // What the registrar-status bug did before this slice: save the answer without its token.
        'drop-tunnel': async () => {
            const se = await import('./state-engine.js');
            const { flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const pa = { ...(se.getNodeConfig() as any).publicAddress };
            delete pa.tunnelToken;
            se.updateNodeConfig({ publicAddress: pa } as any);
            return { envelopeId: (await flushTakeoverChecks()).envelopeId };
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
            const { db } = await import('./db/db.js');
            const resync = await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            const members = (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c;
            return { resync, envelope, held: listHeldEnvelopes().map((h) => h.envelopeId), members };
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        inspect: (a) => inspectNode(a),
        'tunnel-merge': async () => {
            const { withKeptTunnelToken } = await import('./services/public-address-agent.js');
            const prev = { name: 'testtown', status: 'live', tunnelToken: 'T-OLD' };
            return {
                missing: withKeptTunnelToken({ name: 'testtown', status: 'live' }, prev),
                fresh: withKeptTunnelToken({ name: 'testtown', status: 'live', tunnelToken: 'T-NEW' }, prev),
                otherName: withKeptTunnelToken({ name: 'elsewhere', status: 'live' }, prev),
                noPrev: withKeptTunnelToken({ name: 'testtown', status: 'live' }, null),
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
        throw new Error(`Assertion failed: ${msg}`);
    }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (text: string, needle: string) => text.split(needle).length - 1;
const AUDIT_BANNER = 'FAILOVER PROMOTION — running ledger conservation sanity check';

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby'), third: path.join(root, 'third'), probe: path.join(root, 'probe') };
    const nodes: NodeProc[] = [];
    const standbyOutputs: string[] = [];
    const core = await import('@beanpool/core');
    const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const benSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pw = (p: string) => ({ 'X-Admin-Password': p });

    try {
        // ── 1. The main server and its standby ──
        console.log('\n— 1. a main server, and a standby that copies it —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(main);
        const setup = await main.send('setup-primary', { ownerSeedHex, benSeedHex, replicationToken, tunnelToken: TUNNEL_TOKEN });
        const mainPeerId = main.ready.peerId;
        const communityId = JSON.parse(fs.readFileSync(path.join(dirs.main, 'genesis.json'), 'utf-8')).communityId;
        assert(main.ready.role === 'primary' && /^12D3/.test(mainPeerId), `the main server is up (${mainPeerId})`);
        assert(/^BPRC-1 /.test(setup.code) && setup.envelopeId, 'it has recovery code #1 and a take-over envelope');
        assert(setup.transferred, `(some beans moved on the main server, so the audit has a ledger to check) ${setup.transferError ?? ''}`);

        // The standby is set up as setup-backup.mjs does: the main server's genesis, its PeerId pinned as mirror.
        for (const d of [dirs.standby, dirs.third]) {
            fs.mkdirSync(d, { recursive: true });
            fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(d, 'genesis.json'));
        }
        let standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        const standbyOwnPeerId = standby.ready.peerId;
        assert(standby.ready.role === 'backup' && standbyOwnPeerId !== mainPeerId, 'the standby is up with its own PeerId');
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: mainPeerId });
        const pull1 = await standby.send('pull');
        assert(pull1.resync.ok && pull1.members >= 3, `the standby copied the database (${JSON.stringify(pull1.resync)}, ${pull1.members} members)`);
        assert(pull1.envelope === 'stored' && pull1.held.length === 1 && pull1.held[0] === setup.envelopeId, 'and holds the main server\'s take-over envelope');

        const dropped = await main.send('drop-tunnel');
        const pull2 = await standby.send('pull');
        assert(dropped.envelopeId !== setup.envelopeId && pull2.envelope === 'stored' && pull2.held.at(-1) === dropped.envelopeId,
            'the main server re-sealed without its tunnel token (the registrar bug) and the standby holds that newer copy too');

        // A copy of the standby as it is now, for the refusal probes (section 8).
        await standby.send('checkpoint');
        copyDir(dirs.standby, dirs.probe);

        // ── 2. The main server dies ──
        console.log('\n— 2. the main server is killed —');
        await main.kill('SIGKILL');
        assert(main.proc.signalCode === 'SIGKILL', 'the main server is gone');

        // ── 3. Codes: typos, the wrong number, the brake ──
        console.log('\n— 3. typing the code —');
        const open = (code: string, password = PW_STANDBY) => post(standby.base, '/api/local/admin/takeover/open', { code }, pw(password));
        const noAuth = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code });
        assert(noAuth.status === 401, `no admin password → 401 (${noAuth.status})`);
        const typo = await open(setup.code.slice(0, -1) + (setup.code.endsWith('A') ? 'B' : 'A'));
        assert(typo.status === 400 && typo.body.typo === true, `a typo is caught by the check characters at once (${typo.status} ${typo.body.error})`);
        const nine = (await core.createRecoveryCode(9)).code;
        const wrongNumber = await open(nine);
        assert(wrongNumber.status === 400 && wrongNumber.body.wrongCodeNumber === true && /#1/.test(wrongNumber.body.error),
            `a code with another number says which number the keys need (${wrongNumber.body.error})`);
        const wrongCodes: number[] = [];
        for (let i = 0; i < 6; i++) {
            const wrong = (await core.createRecoveryCode(1)).code;
            wrongCodes.push((await open(wrong)).status);
        }
        assert(wrongCodes.every((s) => s === 403), `six wrong codes (well formed, #1) are each refused 403 (${wrongCodes.join(',')})`);
        const braked = await open(setup.code);
        assert(braked.status === 429 && braked.body.passwordBackoff === true && braked.body.retryAfter >= 1,
            `the seventh try, with the RIGHT code, is braked (429, retry after ${braked.body.retryAfter}s) although each request carried the standby's admin password`);
        await sleep(braked.body.retryAfter * 1000 + 300);

        // ── 4. The preview ──
        console.log('\n— 4. the right code opens the keys and shows what will happen —');
        const opened = await open(setup.code);
        assert(opened.status === 200 && opened.body.success, `after the wait the right code opens (${opened.status} ${JSON.stringify(opened.body).slice(0, 200)})`);
        const pv = opened.body.preview;
        assert(pv.peerId === mainPeerId, 'the preview: this server will have the main server\'s PeerId');
        assert(pv.envelope.envelopeId === dropped.envelopeId && pv.envelope.codeId === 1, 'it uses the newest envelope the code opens');
        assert(JSON.stringify(pv.owners) === JSON.stringify(['@Anna']) && pv.admins === 1 && pv.connectors === 1,
            `owners @Anna, 1 admin, 1 link with another community (${JSON.stringify({ o: pv.owners, a: pv.admins, c: pv.connectors })})`);
        assert(pv.publicAddress === 'testtown.beanpool.org', 'the web address testtown.beanpool.org');
        assert(pv.tunnel.source === 'older-envelope' && pv.tunnel.sealedAt, `the newest envelope had no tunnel token; it came from the older copy (${pv.tunnel.message})`);
        assert(pv.mainServer.answers === false && pv.mainServer.warning === null, 'the main server does not answer, and the preview says so (no warning)');
        assert(pv.missing.some((m: string) => /invites/.test(m)) && pv.missing.some((m: string) => /Decisions/.test(m)) && pv.missing.some((m: string) => /notification/.test(m)),
            'the preview lists what will be missing (Decisions and votes, pledges, invites, notification settings, …)');
        assert(!JSON.stringify(opened.body).includes(TUNNEL_TOKEN) && !/adminHash|totpSecret|libp2p_key/.test(JSON.stringify(opened.body)),
            'the preview carries no secret from inside the keys');

        const noConfirm = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: pv.sessionId }, pw(PW_STANDBY));
        assert(noConfirm.status === 400, 'a confirm without confirm:true changes nothing');
        const badSession = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: 'f'.repeat(64), confirm: true }, pw(PW_STANDBY));
        assert(badSession.status === 400 && badSession.body.sessionGone, 'a wrong session id is refused');
        assert(!fs.existsSync(path.join(dirs.standby, 'takeover-journal.json')), 'nothing is written before the confirm');

        // ── 5. Confirm ──
        console.log('\n— 5. confirm: the journaled promotion, then the restart —');
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: pv.sessionId, confirm: true }, pw(PW_STANDBY));
        assert(confirmed.status === 200 && /^[0-9a-f]{64}$/.test(confirmed.body.progressToken),
            `the confirm answers with a progress token (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 160)})`);
        const progressToken = confirmed.body.progressToken;
        const exitCode = await standby.exited;
        standbyOutputs.push(standby.output());
        assert(exitCode === 0, `the standby restarts itself (exit ${exitCode})`);
        const replay = fs.existsSync(path.join(dirs.standby, 'takeover-journal.json'));
        assert(replay, 'the journal is on disk');

        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        assert(standby.ready.role === 'primary', 'started again with NODE_ROLE=backup still in its environment, it is the main server (the config wins)');
        assert(standby.ready.peerId === mainPeerId, `the SAME PeerId as the dead main server (${standby.ready.peerId})`);
        assert(standby.ready.auditRan === true, 'the conservation audit ran at this start');

        // ── 6. After ──
        console.log('\n— 6. the community, on its new server —');
        const prog = await post(standby.base, '/api/local/admin/takeover/progress', {}, { 'X-Takeover-Progress': progressToken });
        assert(prog.status === 200 && prog.body.state === 'complete' && prog.body.steps.every((s: any) => s.done),
            `the progress token follows the take-over across the restart: complete, every step done (${prog.body.state})`);
        const ownPw = await post(standby.base, '/api/local/admin/takeover/progress', {}, pw(PW_STANDBY));
        assert(ownPw.status === 401, "the standby's own admin password no longer works");
        const communityPw = await post(standby.base, '/api/local/admin/takeover/progress', {}, pw(PW_MAIN));
        assert(communityPw.status === 200 && communityPw.body.authorisedBy === 'recovery code #1', "the community's admin password does");

        const after = await standby.send('inspect', { ownerSeedHex });
        const roles = after.roles as { member_pubkey: string; role: string }[];
        assert(roles.some((r) => r.member_pubkey === setup.anna && r.role === 'owner') && roles.some((r) => r.member_pubkey === setup.ben && r.role === 'admin') && roles.length === 2,
            `the roles are present: @Anna owner, @Ben admin (${JSON.stringify(roles.map((r) => r.role))})`);
        assert(after.keySignIn.solved && after.keySignIn.role === 'owner' && after.keySignIn.session && after.keySignIn.sessionRole === 'owner',
            `@Anna's key sign-in works: challenge signed, token exchanged, an owner session (${JSON.stringify(after.keySignIn)})`);
        const conns = after.connectors as { address: string; trustLevel: string }[];
        assert(conns.length === 1 && conns[0].trustLevel === 'peer' && conns[0].address.includes(setup.neighbour),
            'the link with the other community is restored');
        assert(!conns.some((c) => c.trustLevel === 'mirror'), 'the mirror pin on the old main server is gone: this server imports from nobody');
        assert(after.configNodeRole === 'primary' && after.promotionAuditPending === false && after.lastPromotionAudit?.ok === true,
            `nodeRole is in the config, the audit is no longer pending, and the ledger adds up (${JSON.stringify(after.lastPromotionAudit)})`);
        assert(after.backupPrimaryUrl === null && after.backupReplicationToken === null, 'the pull settings are cleared');
        assert(after.publicAddress?.hostname === 'testtown.beanpool.org' && after.publicAddress?.tunnelToken === TUNNEL_TOKEN,
            'the web address is back, with the tunnel token from the older envelope');
        assert(after.tunnelTokenFile === TUNNEL_TOKEN, 'and the tunnel token is written for the cloudflared sidecar');
        assert(after.envelope.state === 'sealed' && JSON.stringify(after.envelope.owners) === JSON.stringify(['Anna']) && JSON.stringify(after.envelope.codes) === '[1]'
            && after.envelope.envelopeId !== dropped.envelopeId,
            `the keys are locked again on this server, to @Anna and code #1 (${after.envelope.envelopeId?.slice(0, 8)})`);
        assert(!after.heldDirExists && !after.bundleFileExists, "the old main server's held copies and the opened keys are gone from disk");
        assert(after.preTakeoverDirs.length === 1, `the standby's own files are kept for undo (${after.preTakeoverDirs[0]})`);
        const undoKey = fs.readFileSync(path.join(dirs.standby, after.preTakeoverDirs[0], 'libp2p_key'));
        const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
        assert(peerIdFromPrivateKey(privateKeyFromProtobuf(undoKey)).toString() === standbyOwnPeerId, "…including the standby's own node key");
        assert(after.progress.codeUsed?.codeId === 1 && /Make a new one/.test(after.progress.codeUsed.message), `the used-code notice shows (${after.progress.codeUsed?.message})`);
        const statusRoute = await post(standby.base, '/api/local/admin/takeover/status', {}, pw(PW_MAIN));
        assert(statusRoute.status === 200 && statusRoute.body.codeUsed?.codeId === 1, 'and the take-over status route carries it for Settings');
        const annc = after.progress.result?.announcement;
        assert(typeof annc === 'string' && /moved to a new server/.test(annc) && /recovery code \(#1\)/.test(annc), `the community was told (${annc})`);

        standbyOutputs.push(standby.output());
        const audits = count(standbyOutputs.join('\n'), AUDIT_BANNER);
        assert(audits === 1, `the conservation audit ran exactly once across both starts (${audits})`);

        // Another start: nothing runs again.
        await standby.kill('SIGTERM');
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        assert(standby.ready.role === 'primary' && standby.ready.peerId === mainPeerId && standby.ready.auditRan === false,
            'a later start stays the main server, same PeerId, and does not audit again');
        assert(count(standby.output(), AUDIT_BANNER) === 0, '(no audit in its log)');

        // ── 7. A third server trusts the promoted one ──
        console.log('\n— 7. a third server, pinned to the old main server\'s PeerId —');
        const token2 = await post(standby.base, '/api/local/admin/replication-token/generate', {}, pw(PW_MAIN));
        assert(token2.status === 200 && token2.body.token, 'the promoted server makes a replication token (the community\'s password)');
        const third = await spawnNode(SCRIPT, dirs.third, { ADMIN_PASSWORD: PW_THIRD, NODE_ROLE: 'backup' });
        nodes.push(third);
        await third.send('setup-standby', { primaryUrl: standby.base, replicationToken: token2.body.token, primaryPeerId: mainPeerId });
        const pull3 = await third.send('pull');
        assert(pull3.resync.ok === true, `it accepts the promoted server's signed sync payload (${JSON.stringify(pull3.resync)})`);
        assert(pull3.members >= 3, `and has the community's members (${pull3.members})`);
        assert(pull3.envelope === 'stored' && pull3.held.length === 1, 'and its take-over envelope, signed by the same key');
        await third.kill();

        // ── 8. Refusals ──
        console.log('\n— 8. refused: another community, and a forgery —');
        {
            const keyBytes = fs.readFileSync(path.join(dirs.main, 'libp2p_key'));
            const mainSeed = new Uint8Array(privateKeyFromProtobuf(keyBytes).raw.subarray(0, 32));
            const record = JSON.parse(fs.readFileSync(path.join(dirs.main, 'local-config.json'), 'utf-8')).recoveryCode;
            const heldDir = path.join(dirs.probe, 'held-takeover-envelopes');
            let at = Date.now() + 1_000_000;
            const plant = (bytes: Uint8Array) => {
                const id = core.readSealedHeader(bytes).envelopeId;
                fs.writeFileSync(path.join(heldDir, `${String(++at).padStart(13, '0')}-${id}.bpseal`), bytes, { mode: 0o600 });
                return id;
            };
            const otherGenesis = Buffer.from(JSON.stringify({ communityId: 'ffffffffffffffff', publicKey: '00', genesisHash: '00', createdAt: '2026-01-01' })).toString('base64');
            const bundleWith = (genesisB64: string) => new TextEncoder().encode(JSON.stringify({
                v: 1,
                files: { libp2p_key: keyBytes.toString('base64'), 'community.key': null, 'genesis.json': genesisB64, 'connectors.json': null },
                localConfig: { adminHash: 'x', salt: 'y', totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], breakGlassMode: false },
                nodeRoles: [], publicAddress: null, recoveryCode: record,
            }));
            const seal = (opts: { communityId: string; genesisB64: string; signer?: Uint8Array; claim?: string }) => core.sealEnvelope(bundleWith(opts.genesisB64), {
                kind: 'takeover', communityId: opts.communityId, nodePeerId: opts.claim ?? mainPeerId,
                recipients: { owners: [], codes: [record] }, signingKey: opts.signer ?? mainSeed, createdAt: new Date().toISOString(),
            });

            const probe = await spawnNode(SCRIPT, dirs.probe, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
            nodes.push(probe);
            const openProbe = () => post(probe.base, '/api/local/admin/takeover/open', { code: setup.code }, pw(PW_STANDBY));

            // A forged newest copy: names the main server, signed by some other key. Skipped, not used.
            const forged = plant(await seal({ communityId, genesisB64: Buffer.from(fs.readFileSync(path.join(dirs.main, 'genesis.json'))).toString('base64'), signer: crypto.randomBytes(32) }));
            const withForged = await openProbe();
            assert(withForged.status === 200 && withForged.body.preview.envelope.envelopeId === dropped.envelopeId && withForged.body.preview.envelope.envelopeId !== forged,
                'a forged newest envelope (not signed by the pinned main server) is skipped at open; the real newest is used');
            assert(/Skipped a held take-over envelope: its signature does not match/.test(probe.output()), '(and the skip is logged)');
            await post(probe.base, '/api/local/admin/takeover/cancel', {}, pw(PW_STANDBY));

            // Signed by the main server, header says this community, but the bundle inside is another community's.
            plant(await seal({ communityId, genesisB64: otherGenesis }));
            const lying = await openProbe();
            assert(lying.status === 409 && lying.body.wrongCommunity === true, `a bundle from another community inside this community's header is refused (${lying.status} ${lying.body.error})`);

            // Only an envelope whose header names another community.
            for (const n of fs.readdirSync(heldDir)) fs.rmSync(path.join(heldDir, n));
            plant(await seal({ communityId: 'ffffffffffffffff', genesisB64: otherGenesis }));
            const other = await openProbe();
            assert(other.status === 409 && other.body.wrongCommunity === true, `an envelope for another community is refused before the code is even checked (${other.status} ${other.body.error})`);
            assert(!fs.existsSync(path.join(dirs.probe, 'takeover-journal.json')) && !fs.existsSync(path.join(dirs.probe, 'takeover-bundle.json')),
                'refused take-overs write nothing');
            const probeState = await probe.send('inspect', {});
            assert(probeState.role === 'backup' && probeState.peerId !== mainPeerId, 'and the standby is still a standby with its own PeerId');
            await probe.kill();
        }

        // ── 9. The source of the lost token ──
        console.log('\n— 9. the public-address agent keeps the tunnel token —');
        const merged = await standby.send('tunnel-merge');
        assert(merged.missing.tunnelToken === 'T-OLD', 'a registrar answer without a tunnel token keeps the saved one');
        assert(merged.fresh.tunnelToken === 'T-NEW', 'a new token replaces it');
        assert(merged.otherName.tunnelToken === undefined && merged.noPrev.tunnelToken === undefined, 'nothing is carried to another name, or from nothing');

        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
        console.log('⭐️ ALL TAKE-OVER-BY-CODE CHECKS PASSED.');
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
