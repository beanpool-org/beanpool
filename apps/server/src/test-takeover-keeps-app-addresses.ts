/**
 * After a take-over, the promoted standby accepts members' signatures for the main server's names, including an
 * address an owner confirmed in Settings (request binding, engine/own-addresses.ts).
 *
 * A format-2 request names the host the app connected to, and a server accepts only its own names. A standby copies
 * the database but not node_config, so it knows none of the main server's names; the take-over envelope carries them:
 * `publicAddress` (the registrar's name) as before, and now `ownerAddresses` beside it. Confirming an address re-seals
 * the envelope, as a new public address does.
 *
 * Every node is its own process (takeover-test-harness.ts), and the signed requests go over HTTPS through the real
 * signature middleware of the node's own process:
 *   1. The main server's names: primary.beanpool.org (its registrar address) and owner-confirmed.test (confirmed by an
 *      owner); a request signed for either is accepted there, one for other.test refused (421).
 *   2. The standby copies it and holds the envelope; it knows none of those names itself.
 *   3. The main server confirms a second address; the envelope is re-sealed and the standby holds the newer copy.
 *   4. The main server dies; the standby takes over with the recovery code and restarts as the main server.
 *   5. There, requests signed for primary.beanpool.org and both confirmed addresses are accepted, other.test → 421,
 *      and Settings lists them with where each came from.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-takeover-keeps-app-addresses.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, runNodeChild, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Main-Server-Pw-2231!';
const PW_STANDBY = 'Standby-Own-Pw-7710!';

// ── The node processes' commands ───────────────────────────────────────────────────────────

let httpsBase: string | null = null;

/** This process's real HTTPS server, started once: the signature middleware a node runs. */
async function ownHttps(): Promise<string> {
    if (httpsBase) return httpsBase;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    delete process.env.CF_RECORD_NAME;
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    await initTls();
    httpsBase = `https://localhost:${await startHttpsServer(0)}`;
    return httpsBase;
}

async function child(): Promise<void> {
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const anna = Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex');
            se.seedGenesisMember(anna, 'Anna');
            // A registrar address in direct mode (no tunnel to bring back), and one address an owner confirmed.
            se.updateNodeConfig({ publicAddress: { name: 'primary', mode: 'direct', hostname: 'primary.beanpool.org', status: 'live' } } as any);
            se.updateNodeConfig({ ownerAddresses: ['owner-confirmed.test'] });
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            const st = await flushTakeoverChecks();
            return { code: made.code, envelopeId: st.envelopeId, anna };
        },
        'confirm-address': async (a: { address: string }) => {
            const se = await import('./state-engine.js');
            const { flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const current = (se.getNodeConfig() as any).ownerAddresses ?? [];
            se.updateNodeConfig({ ownerAddresses: [...current, a.address] });
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
            const resync = await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            return { resync, envelope, held: listHeldEnvelopes().map((h) => h.envelopeId) };
        },
        addresses: async () => {
            const { configuredAddresses } = await import('./engine/own-addresses.js');
            return configuredAddresses(Date.now() + 10_000);
        },
        // Anna's app reads her own standing here, signed (format 2) for each host, over this node's real HTTPS server.
        bound: async (a: { ownerSeedHex: string; hosts: string[] }) => {
            const core = await import('@beanpool/core');
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const base = await ownHttps();
            const seed = new Uint8Array(Buffer.from(a.ownerSeedHex, 'hex'));
            const pk = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
            const out: Record<string, { status: number; code: string | null; publicKey: string | null }> = {};
            for (const host of a.hosts) {
                const headers = await core.buildBoundRequestHeaders({ method: 'GET', url: `https://${host}/api/community/me`, body: '', publicKeyHex: pk, sign: core.ed25519Signer(seed) });
                const res = await fetch(`${base}/api/community/me`, { headers });
                const body: any = await res.json().catch(() => null);
                out[host] = { status: res.status, code: body?.code ?? null, publicKey: body?.publicKey ?? null };
            }
            return out;
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

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pw = (p: string) => ({ 'X-Admin-Password': p });
    const HOSTS = ['primary.beanpool.org', 'owner-confirmed.test', 'later-confirmed.test', 'other.test'];

    try {
        console.log('\n— 1. the main server and its names —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', CF_RECORD_NAME: undefined });
        nodes.push(main);
        const setup = await main.send('setup-primary', { ownerSeedHex, replicationToken });
        assert(/^BPRC-1 /.test(setup.code) && setup.envelopeId, 'the main server has a recovery code and a take-over envelope');
        const onMain = await main.send('bound', { ownerSeedHex, hosts: HOSTS });
        assert(onMain['primary.beanpool.org'].status === 200 && onMain['primary.beanpool.org'].publicKey === setup.anna,
            `a request signed for primary.beanpool.org is accepted there (${JSON.stringify(onMain['primary.beanpool.org'])})`);
        assert(onMain['owner-confirmed.test'].status === 200, `so is one for owner-confirmed.test, the address an owner confirmed (${JSON.stringify(onMain['owner-confirmed.test'])})`);
        assert(onMain['other.test'].status === 421 && onMain['later-confirmed.test'].status === 421,
            `other.test and later-confirmed.test (not yet confirmed) → 421 (${onMain['other.test'].status}, ${onMain['later-confirmed.test'].status})`);

        console.log('\n— 2. a standby copies it —');
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', CF_RECORD_NAME: undefined });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const pull1 = await standby.send('pull');
        assert(pull1.resync.ok && pull1.envelope === 'stored' && pull1.held.at(-1) === setup.envelopeId, `the standby copied the database and holds the envelope (${JSON.stringify(pull1.resync)})`);
        const standbyOwn = await standby.send('addresses');
        assert(Array.isArray(standbyOwn) && standbyOwn.length === 0, `the standby itself knows none of the main server's names (${JSON.stringify(standbyOwn)})`);

        console.log('\n— 3. a second address confirmed on the main server —');
        const later = await main.send('confirm-address', { address: 'later-confirmed.test' });
        assert(later.envelopeId && later.envelopeId !== setup.envelopeId, 'confirming an address re-seals the take-over envelope');
        const pull2 = await standby.send('pull');
        assert(pull2.envelope === 'stored' && pull2.held.at(-1) === later.envelopeId, 'and the standby holds the newer copy');

        console.log('\n— 4. the main server dies; the standby takes over with the code —');
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, pw(PW_STANDBY));
        assert(opened.status === 200 && opened.body?.preview?.sessionId, `the code opens the keys (${opened.status})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, pw(PW_STANDBY));
        assert(confirmed.status === 200, `the take-over is confirmed (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 160)})`);
        const exitCode = await standby.exited;
        assert(exitCode === 0, `the standby restarts itself (exit ${exitCode})`);
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', CF_RECORD_NAME: undefined });
        nodes.push(standby);
        assert(standby.ready.role === 'primary', 'it is the main server now');

        console.log('\n— 5. the promoted server accepts the main server\'s names —');
        const own = await standby.send('addresses');
        const src = (a: string) => own.find((x: any) => x.address === a)?.source;
        assert(src('primary.beanpool.org') === 'public-address' && src('owner-confirmed.test') === 'owner' && src('later-confirmed.test') === 'owner',
            `its names: primary.beanpool.org from the registrar address, both confirmed addresses from the owner's list (${JSON.stringify(own)})`);
        const after = await standby.send('bound', { ownerSeedHex, hosts: HOSTS });
        for (const host of ['primary.beanpool.org', 'owner-confirmed.test', 'later-confirmed.test']) {
            assert(after[host].status === 200 && after[host].publicKey === setup.anna, `a request signed for ${host} is accepted there (${JSON.stringify(after[host])})`);
        }
        assert(after['other.test'].status === 421 && after['other.test'].code === 'wrong_community', `other.test → 421 (${JSON.stringify(after['other.test'])})`);

        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    } catch (e: any) {
        console.error(`❌ ${e?.message || e}`);
        for (const n of nodes) console.error(`--- node output (tail) ---\n${n.output().slice(-2500)}`);
        process.exitCode = 1;
    } finally {
        for (const n of nodes) await n.kill('SIGKILL').catch(() => {});
    }
    process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--child')) {
    child().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
