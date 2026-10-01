/**
 * Test Suite: two standbys holding one set of locked keys can't both act as the main server (MEDIUM-2 of the 2026-10-01
 * replication review, scratch/reviews/FABLE-sec-replication.md).
 *
 * Every standby of a community holds the same envelope, and a take-over writes the keys' epoch + 1, so before this two
 * standbys each taken over were both main servers at the same epoch, and each one's split-brain check, seeing the other
 * at its own address, said "current".
 *
 * Every node is its own process (takeover-test-harness.ts). "The community's web address" is a stand-in the suite points
 * at whichever server holds it (BEANPOOL_TEST_IDENTITY_EPOCH_URL); no suite node asks a real hostname.
 *
 *  1. A main server, and two standbys A and B that copied it and hold the same envelope. The main server dies.
 *     - B opens the keys (a preview) while the web address leads nowhere. Then A takes over, and the address leads to A.
 *     - B's confirm is refused: another server already took over with these keys, at a higher epoch. B writes nothing (no
 *       journal, no opened keys) and stays a standby, saying what to do instead. Opening the keys again is refused too.
 *     - The same refusal when B asks the main server's URL it copies from, which now leads to A, with no web address.
 *     Exactly one main server.
 *  2. Both took over while the address led nowhere (copies of A and B from before): both main servers at epoch 1, each
 *     with its own `since`, B's later.
 *     - The address leads to A: B's check says "conflict", never "current"; B refuses members' writes, saying plainly that
 *       another server took over with the same keys before it, in the write's answer, in Settings and in its log.
 *     - The address leads to B: A's check says "conflict" too, and A, the first, keeps taking writes.
 *     - Restarted, B is still read-only (it remembers), and its check says "conflict" even when the address answers B.
 *     Exactly one of them takes members' writes. And the order itself: the earlier take-over is first, a time that can't
 *     be read sorts last, and two the same are no conflict.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-two-standbys.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawnNode, post, copyDir, runNodeChild, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Main-Server-Pw-404!';
const PW_A = 'Standby-A-Pw-731!';
const PW_B = 'Standby-B-Pw-862!';
const EPOCH_PATH = '/api/node/identity-epoch';

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
        'set-primary-url': async (a: { url: string }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            updateLocalConfig({ backupPrimaryUrl: a.url });
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
        'epoch-check': async (a: { url: string }) => {
            process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL = a.url;
            const { checkIdentityEpoch } = await import('./services/identity-epoch.js');
            return checkIdentityEpoch();
        },
        epoch: async () => {
            const { getLocalConfig } = await import('./config/local-config.js');
            const c = getLocalConfig();
            return { epoch: c.identityEpoch ?? null, since: c.identityEpochSince ?? null, replaced: c.identityReplaced ?? null };
        },
    });
}

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

/** The community's web address: answers the epoch route as the server it leads to does, or 404 when it leads nowhere. */
async function webAddress(): Promise<{ url: string; leadTo: (base: string | null) => void; close: () => Promise<void> }> {
    let target: string | null = null;
    const server = http.createServer((req, res) => {
        if (req.url !== EPOCH_PATH || !target) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
            return;
        }
        fetch(target + EPOCH_PATH).then(async (r) => {
            const text = await r.text();
            res.writeHead(r.status, { 'Content-Type': 'application/json' });
            res.end(text);
        }, () => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${EPOCH_PATH}`,
        leadTo: (base) => { target = base; },
        close: () => new Promise((r) => server.close(() => r())),
    };
}

async function openKeys(node: NodeProc, code: string, pw: string): Promise<{ status: number; body: any }> {
    return post(node.base, '/api/local/admin/takeover/open', { code }, { 'X-Admin-Password': pw });
}

async function confirm(node: NodeProc, sessionId: string, pw: string): Promise<{ status: number; body: any }> {
    return post(node.base, '/api/local/admin/takeover/confirm', { sessionId, confirm: true }, { 'X-Admin-Password': pw });
}

/** Take over on a standby with the code; the restart; the promoted server started again on `env`. */
async function takeOver(node: NodeProc, dir: string, code: string, pw: string, env: Record<string, string>, label: string): Promise<NodeProc> {
    const opened = await openKeys(node, code, pw);
    assert(opened.status === 200, `${label}: the code opens the keys (${opened.status} ${JSON.stringify(opened.body).slice(0, 200)})`);
    const confirmed = await confirm(node, opened.body.preview.sessionId, pw);
    assert(confirmed.status === 200, `${label}: confirmed (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 200)})`);
    await node.exited;
    return spawnNode(SCRIPT, dir, env);
}

const memberWrite = (n: NodeProc) => post(n.base, '/api/test/member-write', { hello: 1 });

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const track = (n: NodeProc) => { nodes.push(n); return n; };
    const address = await webAddress();
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const envA = { ADMIN_PASSWORD: PW_A, NODE_ROLE: 'backup', BEANPOOL_TEST_IDENTITY_EPOCH_URL: address.url };
    const envB = { ADMIN_PASSWORD: PW_B, NODE_ROLE: 'backup', BEANPOOL_TEST_IDENTITY_EPOCH_URL: address.url };

    try {
        // ── 1 ──
        console.log('\n— 1. a main server and two standbys with the same keys; the main server dies —');
        const main = track(await spawnNode(SCRIPT, dir('main'), { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' }));
        const setup = await main.send('setup-primary', { ownerSeedHex, replicationToken });
        const mainPeerId = main.ready.peerId;
        const held: Record<string, string[]> = {};
        for (const [name, env] of [['a', envA], ['b', envB]] as const) {
            fs.mkdirSync(dir(name), { recursive: true });
            fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir(name), 'genesis.json'));
            const s = await spawnNode(SCRIPT, dir(name), env);
            await s.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: mainPeerId });
            const pulled = await s.send('pull');
            assert(pulled.resync.ok && pulled.envelope === 'stored', `standby ${name.toUpperCase()} copied the main server and holds its keys`);
            held[name] = pulled.held;
            await s.send('checkpoint');
            await s.kill('SIGTERM');
            copyDir(dir(name), dir(`${name}-before`));
        }
        assert(held.a.length === 1 && JSON.stringify(held.a) === JSON.stringify(held.b) && held.a[0] === setup.envelopeId,
            'both hold the same envelope, the one the main server sealed');
        await main.kill('SIGKILL');

        let a = track(await spawnNode(SCRIPT, dir('a'), envA));
        let b = track(await spawnNode(SCRIPT, dir('b'), envB));
        const bOpened = await openKeys(b, setup.code, PW_B);
        assert(bOpened.status === 200 && bOpened.body.preview?.sessionId, `B opens the keys while the web address leads nowhere (${bOpened.status})`);

        a = track(await takeOver(a, dir('a'), setup.code, PW_A, envA, 'A takes over'));
        assert(a.ready.role === 'primary' && a.ready.peerId === mainPeerId, 'A is the main server, with the community\'s PeerId');
        address.leadTo(a.base);
        const aEpoch = await a.send('epoch');
        assert(aEpoch.epoch === 1 && aEpoch.since, `A is at identity epoch 1, since ${aEpoch.since}`);

        const bConfirmed = await confirm(b, bOpened.body.preview.sessionId, PW_B);
        assert(bConfirmed.status === 409 && bConfirmed.body.alreadyTakenOver === true && bConfirmed.body.epoch === 1 && bConfirmed.body.since === aEpoch.since,
            `B's confirm, opened before A took over, is refused: another server took over with these keys (${bConfirmed.status} ${JSON.stringify(bConfirmed.body).slice(0, 120)})`);
        assert(/^Another server already took over this community with these keys/.test(bConfirmed.body.error)
            && /the community's web address/.test(bConfirmed.body.error) && /make this standby copy it instead/.test(bConfirmed.body.error)
            && /Nothing has been changed here\.$/.test(bConfirmed.body.error),
        `B says so plainly, and what to do instead: ${bConfirmed.body.error}`);
        assert(!fs.existsSync(path.join(dir('b'), 'takeover-journal.json')) && !fs.existsSync(path.join(dir('b'), 'takeover-bundle.json'))
            && b.proc.exitCode === null, 'B wrote nothing: no journal, no opened keys, no restart');
        const bAgain = await openKeys(b, setup.code, PW_B);
        assert(bAgain.status === 409 && bAgain.body.alreadyTakenOver === true, `opening the keys on B again is refused at once (${bAgain.status})`);
        const bProgress = await post(b.base, '/api/local/admin/takeover/progress', {}, { 'X-Admin-Password': PW_B });
        assert(bProgress.body.role === 'backup' && bProgress.body.state === 'none', `B is still a standby, with no take-over (${bProgress.body.role}, ${bProgress.body.state})`);
        await b.kill('SIGTERM');

        // The main server's URL a standby copies from often IS the community's address: asked too, with no web address given.
        copyDir(dir('b-before'), dir('b-url'));
        const bUrl = track(await spawnNode(SCRIPT, dir('b-url'), { ADMIN_PASSWORD: PW_B, NODE_ROLE: 'backup' }));
        await bUrl.send('set-primary-url', { url: a.base });
        const viaUrl = await openKeys(bUrl, setup.code, PW_B);
        assert(viaUrl.status === 409 && viaUrl.body.alreadyTakenOver === true && /the main server's address/.test(viaUrl.body.error),
            `with no web address, B asks the main server's URL it copies from, which leads to A: refused (${viaUrl.status} ${String(viaUrl.body.error).slice(0, 120)})`);
        const urlProgress = await post(bUrl.base, '/api/local/admin/takeover/progress', {}, { 'X-Admin-Password': PW_B });
        assert(a.ready.role === 'primary' && urlProgress.body.role === 'backup' && urlProgress.body.state === 'none',
            'exactly one main server: A; B is still a standby');
        await bUrl.kill('SIGTERM');
        await a.kill('SIGTERM');

        // ── 2 ──
        console.log('\n— 2. both took over while the address led nowhere: two main servers at epoch 1 —');
        address.leadTo(null);
        copyDir(dir('a-before'), dir('a2'));
        copyDir(dir('b-before'), dir('b2'));
        let a2 = track(await spawnNode(SCRIPT, dir('a2'), envA));
        a2 = track(await takeOver(a2, dir('a2'), setup.code, PW_A, envA, "A' takes over"));
        let b2 = track(await spawnNode(SCRIPT, dir('b2'), envB));
        b2 = track(await takeOver(b2, dir('b2'), setup.code, PW_B, envB, "B' takes over (the address answered nothing)"));
        const ea = await a2.send('epoch');
        const eb = await b2.send('epoch');
        assert(a2.ready.role === 'primary' && b2.ready.role === 'primary' && ea.epoch === 1 && eb.epoch === 1 && ea.since < eb.since,
            `both are main servers at epoch 1; A' took over first (${ea.since}, ${eb.since})`);

        address.leadTo(a2.base);
        const bCheck = await b2.send('epoch-check', { url: address.url });
        assert(bCheck.state === 'conflict' && bCheck.readOnly === true && bCheck.ownSince === eb.since && bCheck.otherSince === ea.since,
            `the address leads to A': B''s check says "conflict", not "current", and B' goes read-only (${JSON.stringify(bCheck)})`);
        const bWrite = await memberWrite(b2);
        assert(bWrite.status === 503 && bWrite.body.readOnly === true && bWrite.body.conflict === true
            && /^Another server took over this community with the same keys on .+, before this server did \(.+\)\. This server is now read-only\./.test(bWrite.body.error),
        `B' refuses a member's write, saying why (${bWrite.status} ${bWrite.body.error})`);
        // After a take-over, Settings answers the community's admin password (the main server's), not the standby's own.
        const bProg = await post(b2.base, '/api/local/admin/takeover/progress', {}, { 'X-Admin-Password': PW_MAIN });
        assert(bProg.status === 200 && bProg.body.replaced?.conflict === true && /before this server did/.test(bProg.body.replaced.message),
            `Settings on B' (its admin control plane stays open) says so (${bProg.body.replaced?.message})`);
        assert(/\[Split-brain\] 🛑 Another server took over this community with the same keys/.test(b2.output()), "and so does B''s log");

        address.leadTo(b2.base);
        const aCheck = await a2.send('epoch-check', { url: address.url });
        assert(aCheck.state === 'conflict' && aCheck.readOnly === false && aCheck.ownSince === ea.since && aCheck.otherSince === eb.since,
            `the address leads to B': A''s check says "conflict" too, never "current" (${JSON.stringify(aCheck)})`);
        const aWrite = await memberWrite(a2);
        assert(aWrite.status === 200 && aWrite.body.written, "A', which took over first, keeps taking members' writes");
        assert(/\[Split-brain\] ⚠️ .*This one took over first/.test(a2.output()), "A''s log says another server took over with the same keys, after it");
        address.leadTo(a2.base);
        const aSelf = await a2.send('epoch-check', { url: address.url });
        assert(aSelf.state === 'current', `the address answers A' itself: "current" (${aSelf.state})`);

        await b2.kill('SIGTERM');
        address.leadTo(null);
        b2 = track(await spawnNode(SCRIPT, dir('b2'), envB));
        assert((await memberWrite(b2)).status === 503, "restarted, B' is still read-only: it remembers");
        address.leadTo(b2.base);
        const bSelf = await b2.send('epoch-check', { url: address.url });
        assert(bSelf.state === 'conflict' && bSelf.readOnly === true, `and asked when the address answers B' itself, it still says "conflict" (${bSelf.state})`);
        const writable = [await memberWrite(a2), await memberWrite(b2)].filter((w) => w.status === 200).length;
        assert(writable === 1, 'exactly one of the two takes members\' writes');

        const { firstTakeover } = await import('./services/identity-epoch.js');
        const t1 = new Date(Date.now() - 60_000).toISOString();
        const t2 = new Date().toISOString();
        assert(firstTakeover(t1, t2) < 0 && firstTakeover(t2, t1) > 0, 'the order: the earlier take-over is first, either way round');
        assert(firstTakeover(t1, null) < 0 && firstTakeover(null, t1) > 0 && firstTakeover('not a time', t1) > 0, 'a time that cannot be read sorts last');
        assert(firstTakeover(t1, t1) === 0 && firstTakeover(null, null) === 0, 'two the same are no conflict');
    } finally {
        for (const n of nodes) await n?.kill().catch(() => {});
        await address.close().catch(() => {});
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
