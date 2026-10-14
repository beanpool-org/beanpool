/**
 * Test Suite: a global node's profile survives a standby and a take-over, and a server set up as the wrong kind of
 * node never opens a global node's database with Beans on (Global node G1, config/node-profile.ts).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), booted as index.ts boots.
 *
 *  1. A main server runs NODE_PROFILE=global with an override (nodeProfile.probation=false). Its take-over bundle
 *     carries the profile and the override.
 *  2. Its standby runs with NODE_PROFILE unset (local), the mistake this guards against. A pull copies the main
 *     server's profile and override into the standby's database, signed with the payload, and the standby says its
 *     own NODE_PROFILE differs. Restarted, it starts (a standby only copies) and keeps the main server's record.
 *  3. The main server dies. A take-over with the right code is REFUSED before anything is written: 409, saying to set
 *     NODE_PROFILE=global. No journal, the code not spent.
 *  4. The same standby promoted by hand instead (NODE_ROLE=primary, NODE_PROFILE still unset): it does not start.
 * 4b. A copy of it with NODE_PROFILE=global and ENFORCE_READ_AUTH=false: a take-over killed before `role` and finished in
 *     place at the next start refuses there as a main server's boot does (exit 1), and finishes once the flag is gone.
 *  5. The standby restarted with NODE_PROFILE=global: the take-over goes through, its `profile` step writes the
 *     community's profile and override, and the promoted server runs global with Beans off.
 *  6. The promoted server started again without NODE_PROFILE: it does not start.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-profile-takeover.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, copyDir, runNodeChild, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Global-Main-Pw-615!';
const PW_STANDBY = 'Global-Standby-Pw-204!';

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks, readSealingInputs } = await import('./services/takeover-envelope.js');
            const anna = Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex');
            se.seedGenesisMember(anna, 'Anna');
            db.prepare("INSERT INTO node_config (key, value) VALUES ('nodeProfile.probation', 'false')").run();
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            const st = await flushTakeoverChecks();
            const inputs = readSealingInputs();
            return { code: made.code, envelopeId: st.envelopeId, bundleProfile: inputs.ok ? inputs.bundle.nodeProfile ?? null : null };
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
        profile: async () => {
            const p = await import('./config/node-profile.js');
            const { getTakeoverProgress } = await import('./services/takeover.js');
            const progress = getTakeoverProgress();
            return {
                record: p.readProfileRecord(),
                running: p.getNodeProfile(),
                switches: p.getProfileSwitches(),
                features: p.getNodeFeatures(),
                profileStep: progress.steps.find((s) => s.step === 'profile') ?? null,
                state: progress.state,
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

/** Start a node that is expected NOT to start. Resolves with its exit code and output. */
async function spawnRefused(dataDir: string, env: Record<string, string>): Promise<{ started: boolean; code: number | null; output: string }> {
    try {
        const n = await spawnNode(SCRIPT, dataDir, env);
        await n.kill();
        return { started: true, code: null, output: n.output() };
    } catch (e: any) {
        return { started: false, code: e?.code ?? null, output: String(e?.output ?? '') };
    }
}

/**
 * 4b (the 2026-10-02 re-review of #1448, state-engine.ts:902). A copy of the standby with NODE_PROFILE=global and
 * ENFORCE_READ_AUTH=false in its .env: a standby starts with it (it only copies), and a global main server never does. A
 * take-over killed after `roles` is finished at the next start, which makes the process the main server in place, after
 * its database booted as a standby's. That start refuses as a main server's boot does: it exits 1, saying why, before
 * anything serves, never running on as the main server with visitors shown the people. The take-over is kept: started
 * again with the flag still there, it refuses again; with the flag gone, it comes up the main server and finishes.
 */
async function refusedInPlace(standbyDir: string, dir: string, code: string, mainPeerId: string): Promise<void> {
    copyDir(standbyDir, dir);
    const env = { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', NODE_PROFILE: 'global' };
    const unsafe = { ...env, ENFORCE_READ_AUTH: 'false' };
    const node = await spawnNode(SCRIPT, dir, { ...unsafe, BEANPOOL_TEST_TAKEOVER_CRASH_AFTER: 'roles' });
    try {
        assert(node.ready.role === 'backup', 'the standby starts with ENFORCE_READ_AUTH=false (it only copies)');
        // Step 7c: under an owner's key session the node makes, not the password alone (refused with 2FA off).
        const nodeOwner: Record<string, string> = await node.send('owner-session');
        const opened = await post(node.base, '/api/local/admin/takeover/open', { code }, nodeOwner);
        assert(opened.status === 200, `the code opens (${opened.status})`);
        await post(node.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, nodeOwner);
        await node.exited;
    } finally {
        await node.kill();
    }
    const journal = () => JSON.parse(fs.readFileSync(path.join(dir, 'takeover-journal.json'), 'utf-8'));
    assert(!!journal().steps.roles && !journal().steps.role, 'killed after "roles", before "role"');

    const first = await spawnRefused(dir, unsafe);
    assert(!first.started && first.code === 1, `the start that finishes it in place does not run on as the main server: it exits 1 (${first.started ? 'it started' : `exit ${first.code}`})`);
    assert(/Resuming an interrupted take-over/.test(first.output) && /ENFORCE_READ_AUTH=false would show a visitor the people anyway, so this node will not start/.test(first.output),
        'it finished the steps before the restart, then refused as a main server\'s boot does, saying why');
    assert(journal().state === 'restarting' && !!journal().steps.restart && !journal().steps.audit,
        `the take-over is kept: its steps up to the restart recorded, the rest to come (${journal().state})`);

    const again = await spawnRefused(dir, unsafe);
    assert(!again.started && again.code === 1 && /so this node will not start/.test(again.output), 'started again with the flag still set, it refuses again');

    const fixed = await spawnNode(SCRIPT, dir, env);
    try {
        const p = await fixed.send('profile');
        assert(fixed.ready.role === 'primary' && fixed.ready.peerId === mainPeerId && p.state === 'complete' && p.running === 'global',
            `with the flag gone, it is the main server, the take-over finished (${fixed.ready.role}, ${p.state})`);
    } finally {
        await fixed.kill();
    }
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    // Whatever the shell running the suite has set: each node below is given its NODE_PROFILE explicitly.
    delete process.env.NODE_PROFILE;
    delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby'), probe: path.join(root, 'probe') };
    const nodes: NodeProc[] = [];
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    // Step 7c: the password alone opens no admin route with 2FA off: each take-over call goes under an owner's key session
    // the standby makes (takeover-test-harness.ts owner-session; in memory, so asked again after each start).
    const asOwner = async (n: NodeProc): Promise<Record<string, string>> => n.send('owner-session');
    const LOCAL = { NODE_PROFILE: '' };
    const GLOBAL = { NODE_PROFILE: 'global' };

    try {
        // ── 1. A global main server ──
        console.log('\n— 1. a main server running as global —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', ...GLOBAL });
        nodes.push(main);
        const setup = await main.send('setup-primary', { ownerSeedHex, replicationToken });
        assert(setup.envelopeId && /^BPRC-1 /.test(setup.code), 'it has a recovery code and a take-over envelope');
        assert(setup.bundleProfile?.profile === 'global' && setup.bundleProfile?.overrides?.probation === 'false',
            `its take-over bundle carries the profile and the override (${JSON.stringify(setup.bundleProfile)})`);
        const mainProfile = await main.send('profile');
        assert(mainProfile.running === 'global' && mainProfile.features.beans === false, 'it runs global, Beans off');

        // ── 2. A standby set up as the wrong kind of node ──
        console.log('\n— 2. its standby runs with NODE_PROFILE unset —');
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...LOCAL });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const pulled = await standby.send('pull');
        assert(pulled.resync.ok && pulled.envelope === 'stored', `the standby copied the main server and holds its keys (${JSON.stringify(pulled)})`);
        const copied = await standby.send('profile');
        assert(copied.record.profile === 'global' && copied.record.overrides.probation === 'false',
            `the pull brought the main server's profile and override into the standby's database (${JSON.stringify(copied.record)})`);
        assert(copied.running === 'local', 'the standby itself runs as its own NODE_PROFILE says (local)');
        assert(/main server runs as global, but NODE_PROFILE here is local/.test(standby.output()),
            'and says the main server runs as global while its NODE_PROFILE is local');

        await standby.kill('SIGTERM');
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...LOCAL });
        nodes.push(standby);
        const again = await standby.send('profile');
        assert(standby.ready.role === 'backup' && again.record.profile === 'global',
            'restarted, the standby starts (it only copies) and keeps the main server\'s record rather than writing its own');
        assert(/copies runs as global, but NODE_PROFILE here is local\. A take-over from here is refused/.test(standby.output()),
            'its boot log says a take-over from here would be refused');

        // ── 3. The main server dies; a take-over from the wrong kind of server is refused ──
        console.log('\n— 3. take-over on a standby whose NODE_PROFILE is local —');
        await main.kill('SIGKILL');
        const refused = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, await asOwner(standby));
        assert(refused.status === 409 && refused.body?.profileMismatch === true && /NODE_PROFILE=global/.test(refused.body?.error ?? ''),
            `refused 409, saying to set NODE_PROFILE=global (${refused.status} ${refused.body?.error})`);
        assert(refused.body?.communityProfile === 'global' && refused.body?.thisServerProfile === 'local', 'naming both profiles');
        assert(!fs.existsSync(path.join(dirs.standby, 'takeover-journal.json')) && !fs.existsSync(path.join(dirs.standby, 'takeover-bundle.json')),
            'nothing was written: no journal, no opened keys');

        // ── 4. …and promoting it by hand instead does not open it either ──
        console.log('\n— 4. the same standby promoted by hand, NODE_PROFILE still unset —');
        await standby.send('checkpoint');
        copyDir(dirs.standby, dirs.probe);
        const byHand = await spawnRefused(dirs.probe, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'primary', ...LOCAL });
        assert(!byHand.started && byHand.code === 1, `it does not start (exit ${byHand.code})`);
        assert(/This database is a global node, but NODE_PROFILE here is unset \(local\)/.test(byHand.output) && /will not start/.test(byHand.output),
            'and says why, before the ledger is loaded or a port is open');

        // ── 4b. A take-over finished in place, on settings every boot refuses ──
        console.log('\n— 4b. a take-over killed before "role", finished in place where the profile refuses to start —');
        await refusedInPlace(dirs.standby, path.join(root, 'in-place'), setup.code, main.ready.peerId);

        // ── 5. With NODE_PROFILE=global the take-over goes through ──
        console.log('\n— 5. the standby restarted with NODE_PROFILE=global —');
        await standby.kill('SIGTERM');
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...GLOBAL });
        nodes.push(standby);
        const standbyOwner = await asOwner(standby);
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, standbyOwner);
        assert(opened.status === 200 && opened.body?.preview?.profile?.community === 'global' && opened.body?.preview?.profile?.thisServer === 'global',
            `the code opens, and the preview names the profile (${opened.status} ${JSON.stringify(opened.body?.preview?.profile ?? opened.body)})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, standbyOwner);
        assert(confirmed.status === 200, `confirmed (${confirmed.status})`);
        const exit = await standby.exited;
        assert(exit === 0, `the standby restarts itself (exit ${exit})`);
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...GLOBAL });
        nodes.push(standby);
        assert(standby.ready.role === 'primary' && standby.ready.peerId === main.ready.peerId, 'it is the main server, with the same PeerId');
        const after = await standby.send('profile');
        assert(after.state === 'complete' && after.profileStep?.done && /global; 1 switch override/.test(after.profileStep?.detail ?? ''),
            `the take-over's profile step ran (${JSON.stringify(after.profileStep)})`);
        assert(after.record.profile === 'global' && after.record.overrides.probation === 'false' && Object.keys(after.record.overrides).length === 1,
            `the community's profile and override are in its database (${JSON.stringify(after.record)})`);
        assert(after.running === 'global' && after.switches.beans === false && after.switches.escrow === false
            && after.features.beans === false && after.features.enterprises === false,
            `it runs as global with Beans off (${JSON.stringify(after.features)})`);

        // ── 6. …and never as local ──
        console.log('\n— 6. the promoted server started again without NODE_PROFILE —');
        await standby.kill('SIGTERM');
        const later = await spawnRefused(dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ...LOCAL });
        assert(!later.started && later.code === 1 && /will not start/.test(later.output),
            `it does not start: a global node never opens as local (exit ${later.code})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    console.log('⭐️ A global node\'s profile survives a standby and a take-over.');
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
