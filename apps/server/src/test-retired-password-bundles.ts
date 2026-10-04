/**
 * A retired admin password (step 10, passwordRetired) survives a take-over and a sealed-backup restore, and never comes
 * back from an envelope or backup sealed before the retirement (PR #1587 deciding review, BLOCKING 2).
 *
 * The take-over's `admin-settings` step and a sealed restore's applyBundle both merge the bundle through
 * bundledLocalConfigUpdates (services/takeover-envelope.ts): retired when the bundle OR this server says so, and then no
 * hash, salt or password 2FA.
 *
 * Every node is its own process (takeover-test-harness.ts); sign-ins go over the node's own real HTTPS server.
 *   1. The main server, with ADMIN_PASSWORD; two standbys copy it and hold envelope E1, sealed with the password.
 *   2. The main server's own sealed bundle, taken now (before the retirement), is kept for step 4.
 *   3. The password is retired on the main server: the envelope re-seals (E2) and carries it. Standby 2 holds E2;
 *      standby 1 holds only E1, and is itself retired (a server that already knows).
 *   4. A same-server restore of the step-2 backup: the main server stays retired, with no hash; the old password → 403.
 *   5. Standby 1 takes over from E1 (sealed BEFORE the retirement): the promoted server stays retired, no hash, and
 *      neither the old password nor its own ADMIN_PASSWORD signs in.
 *   6. Standby 2, never retired itself and with its own ADMIN_PASSWORD, takes over from E2 (sealed AFTER): the promoted
 *      server is retired, with no hash, and neither password signs in.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-retired-password-bundles.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, runNodeChild, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Main-Server-Pw-4417!';
const PW_STANDBY = 'Standby-Own-Pw-9902!';

/** What the retire route writes (routes/admin.ts retire-password), without its step-up and break-glass gates. */
async function retireHere(by: string): Promise<void> {
    const { updateLocalConfig } = await import('./config/local-config.js');
    updateLocalConfig({
        adminHash: null, salt: null,
        totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [],
        passwordRetired: { at: Date.now(), by, byCallsign: 'Anna', acceptedOneOwner: true },
    } as any);
}

let httpsBase: string | null = null;

/** This process's real HTTPS server, started once: the admin routes and middleware a node runs. */
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
        // Each password, at the password sign-in route over this node's real HTTPS server.
        'sign-in': async (a: { passwords: string[] }) => {
            const base = await ownHttps();
            const out: { status: number; code: string | null }[] = [];
            for (const password of a.passwords) {
                const res = await fetch(`${base}/api/local/admin/auth/password`, {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
                });
                const body: any = await res.json().catch(() => null);
                out.push({ status: res.status, code: body?.code ?? null });
            }
            return out;
        },
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const anna = Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex');
            se.seedGenesisMember(anna, 'Anna');
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            const st = await flushTakeoverChecks();
            return { code: made.code, envelopeId: st.envelopeId, anna };
        },
        'sealed-bundle': async () => {
            const { readSealingInputs } = await import('./services/takeover-envelope.js');
            const inputs = readSealingInputs();
            if (!inputs.ok) throw new Error(inputs.message);
            return inputs.bundle;
        },
        retire: async (a: { by: string }) => {
            const { flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            await retireHere(a.by);
            return { envelopeId: (await flushTakeoverChecks()).envelopeId };
        },
        'retire-standby': async (a: { by: string }) => {
            await retireHere(a.by);
            return true;
        },
        'apply-bundle': async (a: { bundle: any }) => {
            const { applyBundle } = await import('./services/sealed-backup.js');
            return applyBundle(a.bundle);
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
        held: async () => {
            const { listHeldEnvelopes } = await import('./services/standby-envelopes.js');
            return listHeldEnvelopes().map((h) => h.envelopeId);
        },
        config: async () => {
            const { getLocalConfig } = await import('./config/local-config.js');
            const c = getLocalConfig() as any;
            return {
                retired: c.passwordRetired ?? null, adminHash: c.adminHash ?? null, salt: c.salt ?? null,
                totpEnabled: !!c.totpEnabled, totpSecret: c.totpSecret ?? null,
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

const j = (v: unknown) => JSON.stringify(v);

/** Neither password opens an admin session: each answers 403 password_retired. */
async function passwordsRefused(node: NodeProc, label: string): Promise<void> {
    const answers = await node.send('sign-in', { passwords: [PW_MAIN, PW_STANDBY] });
    answers.forEach((r: { status: number; code: string | null }, i: number) => assert(r.status === 403 && r.code === 'password_retired',
        `${label}: ${i === 0 ? "the main server's old password" : 'the standbys\' ADMIN_PASSWORD'} → 403 password_retired (${r.status} ${r.code})`));
}

async function takeOver(standby: NodeProc, code: string): Promise<number | null> {
    const owner: Record<string, string> = await standby.send('owner-session');
    const opened = await post(standby.base, '/api/local/admin/takeover/open', { code }, owner);
    assert(opened.status === 200 && opened.body?.preview?.sessionId, `the code opens the keys (${opened.status} ${j(opened.body).slice(0, 160)})`);
    const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, owner);
    assert(confirmed.status === 200, `the take-over is confirmed (${confirmed.status} ${j(confirmed.body).slice(0, 160)})`);
    return standby.exited;
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), s1: path.join(root, 'standby1'), s2: path.join(root, 'standby2') };
    const nodes: NodeProc[] = [];
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const standbyEnv = { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', CF_RECORD_NAME: undefined };

    try {
        console.log('\n— 1. the main server, with a password; two standbys hold E1 —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', CF_RECORD_NAME: undefined });
        nodes.push(main);
        const setup = await main.send('setup-primary', { ownerSeedHex, replicationToken });
        assert(/^BPRC-1 /.test(setup.code) && setup.envelopeId, 'the main server has a recovery code and a take-over envelope (E1)');
        const before = await main.send('config');
        assert(before.adminHash && !before.retired, 'E1 is sealed while the main server has its password');
        const standbys: NodeProc[] = [];
        for (const dir of [dirs.s1, dirs.s2]) {
            fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dir, 'genesis.json'));
            const s = await spawnNode(SCRIPT, dir, standbyEnv);
            nodes.push(s);
            standbys.push(s);
            await s.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
            const pulled = await s.send('pull');
            assert(pulled.resync.ok && pulled.envelope === 'stored' && pulled.held.at(-1) === setup.envelopeId,
                `${path.basename(dir)} copied the database and holds E1 (${j(pulled.resync)})`);
        }
        let [s1, s2] = standbys;

        console.log('\n— 2. a sealed backup bundle taken before the retirement —');
        const oldBundle = await main.send('sealed-bundle');
        assert(oldBundle?.localConfig?.adminHash && !oldBundle.localConfig.passwordRetired, 'the old bundle carries the password and no retirement');

        console.log('\n— 3. the password is retired on the main server —');
        const retired = await main.send('retire', { by: setup.anna });
        assert(retired.envelopeId && retired.envelopeId !== setup.envelopeId, 'retiring re-seals the envelope (E2)');
        const newBundle = await main.send('sealed-bundle');
        assert(newBundle.localConfig.passwordRetired?.by === setup.anna && newBundle.localConfig.adminHash === null,
            `E2's bundle carries the retirement and no hash (${j(newBundle.localConfig.passwordRetired)})`);
        const pulled2 = await s2.send('pull');
        assert(pulled2.envelope === 'stored' && pulled2.held.at(-1) === retired.envelopeId, 'standby 2 holds E2');
        await s1.send('retire-standby', { by: setup.anna });
        const s1Held = await s1.send('held');
        assert(s1Held.at(-1) === setup.envelopeId && !s1Held.includes(retired.envelopeId), `standby 1 holds only E1, and is itself retired (${j(s1Held)})`);

        console.log('\n— 4. a same-server restore of the backup from before the retirement —');
        const written = await main.send('apply-bundle', { bundle: oldBundle });
        assert(written.some((w: string) => w.startsWith('local-config.json')), `the restore wrote local-config.json (${j(written)})`);
        const afterRestore = await main.send('config');
        assert(afterRestore.retired?.by === setup.anna && afterRestore.adminHash === null && afterRestore.salt === null && !afterRestore.totpEnabled,
            `the main server stays retired, with no hash, salt or 2FA (${j(afterRestore)})`);
        await passwordsRefused(main, 'the restored main server');
        await main.kill('SIGKILL');

        console.log('\n— 5. standby 1 (retired) takes over from E1, sealed BEFORE the retirement —');
        assert(await takeOver(s1, setup.code) === 0, 'standby 1 restarts itself');
        s1 = await spawnNode(SCRIPT, dirs.s1, standbyEnv);
        nodes.push(s1);
        assert(s1.ready.role === 'primary', 'it is the main server now');
        const c1 = await s1.send('config');
        assert(c1.retired?.by === setup.anna && c1.adminHash === null && c1.salt === null && !c1.totpEnabled && c1.totpSecret === null,
            `still retired: E1's password did not come back (${j(c1)})`);
        await passwordsRefused(s1, 'promoted standby 1');

        console.log('\n— 6. standby 2 (never retired, its own password) takes over from E2, sealed AFTER —');
        const s2Before = await s2.send('config');
        assert(!s2Before.retired && s2Before.adminHash, 'standby 2 has its own password and no retirement before the take-over');
        assert(await takeOver(s2, setup.code) === 0, 'standby 2 restarts itself');
        s2 = await spawnNode(SCRIPT, dirs.s2, standbyEnv);
        nodes.push(s2);
        assert(s2.ready.role === 'primary', 'it is the main server now');
        const c2 = await s2.send('config');
        assert(c2.retired?.by === setup.anna && c2.adminHash === null && c2.salt === null && !c2.totpEnabled,
            `the promoted server is retired, with no hash (${j(c2)})`);
        await passwordsRefused(s2, 'promoted standby 2');

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
