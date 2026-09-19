/**
 * Test Suite: the split-brain guard (sealed keys, slice 8).
 *
 * Design: scratch/overnight/design/sealed-keys.md §5.4 ("Split-brain guard") and the slice 8 row of §10.
 *
 * Every node is its own process (takeover-test-harness.ts). A node's "own public address" is the URL in
 * BEANPOOL_TEST_IDENTITY_EPOCH_URL, which stands in for https://<its hostname>/api/node/identity-epoch; no suite
 * node asks a real hostname.
 *
 *  1. A main server (epoch 0) serves its epoch, signed with its node key. Its standby copies it and holds its keys.
 *  2. The main server is killed; the standby takes over with the recovery code (slice 5). The new main server has
 *     the same PeerId and serves epoch 1, signed with the same key; its keys are re-sealed carrying epoch 1.
 *  3. The OLD main server is started again, and its public address now leads to the new one: it sees a higher
 *     epoch signed by its own key, goes READ-ONLY (a member's write refused with the reason; Settings' progress
 *     route says so; its log says so) and still boots. Started again with its address unreachable, it stays
 *     read-only (it remembers). The new main server, asking its own address, finds itself current and writable.
 *  4. Unreachable: a copy of the old main server from before the take-over, whose address answers nothing, carries
 *     on as the main server and takes writes. So does one whose address has no such route (an older BeanPool).
 *  5. Forged: statements NOT signed by its node key (a stranger's key, a real signature over a changed number,
 *     garbage) are ignored, with a log line, and it carries on. The same number signed correctly changes nothing.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-split-brain.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawnNode, post, copyDir, runNodeChild, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Main-Server-Pw-771!';
const PW_STANDBY = 'Standby-Own-Pw-264!';
const EPOCH_PATH = '/api/node/identity-epoch';

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            se.seedGenesisMember(Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex'), 'Anna');
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            const st = await flushTakeoverChecks();
            return { code: made.code, envelopeId: st.envelopeId };
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
            const resync = await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            return { resync, envelope };
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        // Ask "my own public address" now, as the hourly check does.
        'epoch-check': async (a: { url: string }) => {
            process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL = a.url;
            const { checkIdentityEpoch } = await import('./services/identity-epoch.js');
            return checkIdentityEpoch();
        },
        epoch: async () => {
            const { getLocalConfig } = await import('./config/local-config.js');
            const { readSealingInputs } = await import('./services/takeover-envelope.js');
            const c = getLocalConfig();
            const inputs = readSealingInputs();
            return {
                identityEpoch: c.identityEpoch ?? null, identityEpochSince: c.identityEpochSince ?? null,
                identityReplaced: c.identityReplaced ?? null,
                bundleEpoch: inputs.ok ? inputs.bundle.identityEpoch : null,
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

async function get(url: string): Promise<{ status: number; body: any }> {
    const res = await fetch(url);
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
}

/** A stand-in for "the web address", answering the epoch route with whatever the test says. */
async function fakeAddress(): Promise<{ url: string; set: (status: number, body: unknown) => void; hits: () => number; close: () => Promise<void> }> {
    let answer: { status: number; body: unknown } = { status: 404, body: {} };
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits++;
        const status = req.url === EPOCH_PATH ? answer.status : 404;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${EPOCH_PATH}`,
        set: (status, body) => { answer = { status, body }; },
        hits: () => hits,
        close: () => new Promise((r) => server.close(() => r())),
    };
}

async function closedPortUrl(): Promise<string> {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return `http://127.0.0.1:${port}${EPOCH_PATH}`;
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = {
        main: path.join(root, 'main'), standby: path.join(root, 'standby'),
        before: path.join(root, 'main-before'), copy: path.join(root, 'main-copy'),
    };
    const nodes: NodeProc[] = [];
    const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
    const { verifyEpochStatement, signEpochStatement } = await import('./services/identity-epoch.js');
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pw = (p: string) => ({ 'X-Admin-Password': p });
    const memberWrite = (n: NodeProc) => post(n.base, '/api/test/member-write', { hello: 1 });
    const fake = await fakeAddress();

    try {
        // ── 1. A main server and its standby ──
        console.log('\n— 1. a main server serves its epoch, signed; a standby copies it —');
        let old = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(old);
        const setup = await old.send('setup-primary', { ownerSeedHex, replicationToken });
        const mainPeerId = old.ready.peerId;
        const keyBytes = fs.readFileSync(path.join(dirs.main, 'libp2p_key'));
        const mainSeed = new Uint8Array(privateKeyFromProtobuf(keyBytes).raw.subarray(0, 32));
        const mainIdentity = { seed: mainSeed, peerId: mainPeerId };
        const communityId = JSON.parse(fs.readFileSync(path.join(dirs.main, 'genesis.json'), 'utf-8')).communityId;
        assert(/^BPRC-1 /.test(setup.code) && setup.envelopeId, 'the main server has recovery code #1 and a take-over envelope');
        assert(old.ready.epochCheck === null, '(no public address given, so it asks nobody)');

        const e0 = await get(old.base + EPOCH_PATH);
        assert(e0.status === 200 && e0.body.statement.epoch === 0 && e0.body.statement.peerId === mainPeerId
            && e0.body.statement.communityId === communityId && e0.body.statement.since === null,
        `GET ${EPOCH_PATH} with no credential: epoch 0, its PeerId and community (${JSON.stringify(e0.body.statement)})`);
        assert(verifyEpochStatement(e0.body, mainIdentity).ok, 'signed with its node key');
        const w0 = await memberWrite(old);
        assert(w0.status === 200 && w0.body.written, 'it takes members\' writes');

        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: old.base, replicationToken, primaryPeerId: mainPeerId });
        const pulled = await standby.send('pull');
        assert(pulled.resync.ok && pulled.envelope === 'stored', 'the standby copied the database and holds the keys');

        // The old main server as it is now, for sections 4 and 5.
        await old.send('checkpoint');
        await old.kill('SIGKILL');
        copyDir(dirs.main, dirs.before);

        // ── 2. Take-over ──
        console.log('\n— 2. the main server dies; the standby takes over and serves epoch 1 —');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, pw(PW_STANDBY));
        assert(opened.status === 200 && opened.body.preview?.peerId === mainPeerId, `the code opens the keys (${opened.status})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, pw(PW_STANDBY));
        assert(confirmed.status === 200, `confirmed (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 120)})`);
        assert((await standby.exited) === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        assert(standby.ready.role === 'primary' && standby.ready.peerId === mainPeerId, 'it is the main server, with the same PeerId');

        const e1 = await get(standby.base + EPOCH_PATH);
        const journal = JSON.parse(fs.readFileSync(path.join(dirs.standby, 'takeover-journal.json'), 'utf-8'));
        assert(e1.status === 200 && e1.body.statement.epoch === 1 && e1.body.statement.peerId === mainPeerId && e1.body.statement.since === journal.startedAt,
            `the new main server serves epoch 1, since the take-over started (${JSON.stringify(e1.body.statement)})`);
        assert(verifyEpochStatement(e1.body, mainIdentity).ok, "signed with the community's node key: the old main server's own");
        const newEpoch = await standby.send('epoch');
        assert(newEpoch.identityEpoch === 1 && newEpoch.bundleEpoch === 1, 'its config says 1, and the keys it seals now carry 1 (a later take-over makes 2)');
        const selfCheck = await standby.send('epoch-check', { url: standby.base + EPOCH_PATH });
        assert(selfCheck.state === 'current' && selfCheck.seen === 1 && selfCheck.own === 1, `asking its own address, it finds itself current (${JSON.stringify(selfCheck)})`);
        const wNew = await memberWrite(standby);
        assert(wNew.status === 200, 'and takes members\' writes');

        // ── 3. The old main server comes back ──
        console.log('\n— 3. the old main server is started again; its address leads to the new one —');
        old = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', BEANPOOL_TEST_IDENTITY_EPOCH_URL: standby.base + EPOCH_PATH });
        nodes.push(old);
        assert(old.ready.role === 'primary' && old.ready.peerId === mainPeerId, 'it still boots, as the main server it was');
        assert(old.ready.epochCheck?.state === 'replaced' && old.ready.epochCheck.seen === 1 && old.ready.epochCheck.own === 0,
            `at boot it sees epoch 1 over its own 0, signed by its own key (${JSON.stringify(old.ready.epochCheck)})`);
        const date = journal.startedAt.slice(0, 10);
        const refused = await memberWrite(old);
        assert(refused.status === 503 && refused.body.readOnly === true && refused.body.error.includes(`This server was replaced on ${date}. It is now read-only.`),
            `a member's write is refused, saying why (${refused.status} ${refused.body.error})`);
        const readStill = await get(old.base + EPOCH_PATH);
        assert(readStill.status === 200 && readStill.body.statement.epoch === 0, 'reads still answer');
        const prog = await post(old.base, '/api/local/admin/takeover/progress', {}, pw(PW_MAIN));
        assert(prog.status === 200 && prog.body.replaced?.message === `This server was replaced on ${date}. It is now read-only.` && prog.body.replaced.epoch === 1,
            `Settings (the admin control plane stays open) says so (${prog.body.replaced?.message})`);
        assert(/\[Split-brain\].*replaced on/.test(old.output()), 'and so does its log');
        const oldCfg = await old.send('epoch');
        assert(oldCfg.identityReplaced?.peerId === mainPeerId && oldCfg.identityReplaced.epoch === 1, 'it keeps what it saw in local-config.json');

        await old.kill('SIGTERM');
        const gone = await closedPortUrl();
        old = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', BEANPOOL_TEST_IDENTITY_EPOCH_URL: gone });
        nodes.push(old);
        assert(old.ready.epochCheck?.state === 'unreachable', `started again with its address unreachable (${old.ready.epochCheck?.state})…`);
        const stillRefused = await memberWrite(old);
        assert(stillRefused.status === 503 && stillRefused.body.readOnly, '…it is still read-only: it remembers');
        await old.kill('SIGTERM');

        // ── 4. Unreachable ──
        console.log('\n— 4. an address that does not answer: carry on —');
        copyDir(dirs.before, dirs.copy);
        const copy = await spawnNode(SCRIPT, dirs.copy, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', BEANPOOL_TEST_IDENTITY_EPOCH_URL: gone });
        nodes.push(copy);
        assert(copy.ready.role === 'primary' && copy.ready.epochCheck?.state === 'unreachable', `unreachable hostname → it boots as the main server (${JSON.stringify(copy.ready.epochCheck)})`);
        const w4 = await memberWrite(copy);
        assert(w4.status === 200 && w4.body.written, 'and carries on taking writes');
        assert(/\[Split-brain\] Could not ask/.test(copy.output()), 'its log says it could not ask, and carries on');
        fake.set(404, { error: 'Not found' });
        const noRoute = await copy.send('epoch-check', { url: fake.url });
        assert(noRoute.state === 'no-epoch-route', `an address with no such route (an older BeanPool) → carry on (${noRoute.state})`);
        assert((await memberWrite(copy)).status === 200, '(still writable)');

        // ── 5. Forged ──
        console.log('\n— 5. forged epochs: ignored, with a log line —');
        const strangerSeed = crypto.randomBytes(32);
        const forged = signEpochStatement({ v: 1, peerId: mainPeerId, communityId, epoch: 5, since: new Date().toISOString() }, strangerSeed);
        fake.set(200, forged);
        const f1 = await copy.send('epoch-check', { url: fake.url });
        assert(f1.state === 'forged', `epoch 5 naming its PeerId but signed by another key → ignored (${JSON.stringify(f1)})`);
        assert((await memberWrite(copy)).status === 200, 'it carries on taking writes');
        assert(/\[Split-brain\] Ignored a statement for epoch 5 that is NOT signed by this server's node key/.test(copy.output()), 'with a log line saying it was ignored');

        const genuine = signEpochStatement({ v: 1, peerId: mainPeerId, communityId, epoch: 1, since: new Date().toISOString() }, mainSeed);
        fake.set(200, { ...genuine, statement: { ...genuine.statement, epoch: 7 } });
        const f2 = await copy.send('epoch-check', { url: fake.url });
        assert(f2.state === 'forged', `a real signature over epoch 1, with the number changed to 7 → ignored (${f2.state})`);
        fake.set(200, '<html>parked domain</html>');
        const f3 = await copy.send('epoch-check', { url: fake.url });
        assert(f3.state === 'forged', `a page that is not a statement at all → ignored (${f3.state})`);
        fake.set(200, signEpochStatement({ v: 1, peerId: mainPeerId, communityId, epoch: 0, since: null }, mainSeed));
        const same = await copy.send('epoch-check', { url: fake.url });
        assert(same.state === 'current' && same.seen === 0, `its own number, correctly signed → nothing happens (${same.state})`);
        assert((await memberWrite(copy)).status === 200, 'after all of that it is still writable');
        const copyCfg = await copy.send('epoch');
        assert(copyCfg.identityReplaced === null, 'and nothing was recorded');

        // The same server, shown a genuine higher epoch at its address, does go read-only: the check itself, not
        // the boot, is what acts (the hourly path).
        fake.set(200, signEpochStatement({ v: 1, peerId: mainPeerId, communityId, epoch: 2, since: '2026-09-20T00:00:00.000Z' }, mainSeed));
        const real = await copy.send('epoch-check', { url: fake.url });
        assert(real.state === 'replaced' && real.seen === 2, `a genuine epoch 2 at the next check → replaced (${real.state})`);
        const w5 = await memberWrite(copy);
        assert(w5.status === 503 && /replaced on 2026-09-20/.test(w5.body.error), 'and the next write is refused');
        await copy.kill('SIGTERM');
    } finally {
        for (const n of nodes) await n.kill().catch(() => {});
        await fake.close().catch(() => {});
    }

    console.log(`\n${testsPassed}/${testsRun} passed`);
    if (testsPassed !== testsRun) process.exit(1);
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error(e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error(e?.output ? `${e.message}\n--- node output ---\n${e.output}` : e);
        process.exit(1);
    });
}
