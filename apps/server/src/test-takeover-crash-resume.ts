/**
 * Test Suite: a take-over killed at any step resumes, and ends exactly as an uninterrupted one (sealed keys, slice 5).
 *
 * Design: scratch/overnight/design/sealed-keys.md §5.4 ("each step written to data/takeover-journal.json so a crash
 * mid-way resumes rather than half-promotes") and §8.7. The uninterrupted take-over is test-takeover-by-code.ts.
 *
 * Once: a main server (own process) with an owner, an admin, a link with another community, a tunnel address and a
 * recovery code; a standby (own process) that copies it and holds its locked keys; the main server killed; the
 * standby's data dir kept as the starting point.
 *
 * Then, for EVERY journal step, on a fresh copy of that standby: the take-over is started with
 * BEANPOOL_TEST_TAKEOVER_CRASH_AFTER=<step>, which SIGKILLs the process the moment that step is recorded (no
 * cleanup, as a power cut). The process is started again, as Docker would, until it comes up; a crash after a
 * step that runs at boot kills that start too, and the next one goes on. In every case:
 *   - the journal ends complete with every step recorded once;
 *   - the node is the main server with the SAME PeerId, the roles present, the owner's key sign-in working, the
 *     link restored and no mirror pin, the pull settings cleared, the tunnel token back, the keys re-sealed;
 *   - the conservation audit ran exactly once and the community was told exactly once, across every start;
 *   - the opened keys (data/takeover-bundle.json) are gone.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-crash-resume.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, copyDir, runNodeChild, inspectNode, type NodeProc } from './takeover-test-harness.js';
import { TAKEOVER_STEPS } from './services/takeover.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Main-Server-Pw-907!';
const PW_STANDBY = 'Standby-Own-Pw-318!';
const TUNNEL_TOKEN = 'tunnel-' + crypto.randomBytes(12).toString('hex');
const AUDIT_BANNER = 'FAILOVER PROMOTION — running ledger conservation sanity check';
const ANNOUNCED = '[Takeover] ✔ announcement';

async function child(): Promise<void> {
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string; tunnelToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { addConnector } = await import('./connector-manager.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const anna = Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex');
            const ben = crypto.randomBytes(32).toString('hex');
            se.seedGenesisMember(anna, 'Anna');
            db.prepare('INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)')
                .run(ben, 'Ben', new Date().toISOString(), anna, 'TEST');
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(ben);
            se.grantNodeRole(ben, 'admin', anna);
            se.transfer('COMMONS_POOL', ben, 3, 'a commons grant');
            addConnector('/ip4/127.0.0.1/tcp/4999/p2p/12D3KooWD3eckifWpRn9wQpMG9R9hX3sD158z7EqHWmweQAJU5SA', 'peer', 'Neighbours', 'https://neighbours.example', true);
            se.updateNodeConfig({ publicAddress: { name: 'crashtown', mode: 'tunnel', hostname: 'crashtown.beanpool.org', status: 'live', tunnelToken: a.tunnelToken } } as any);
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            await flushTakeoverChecks();
            return { code: made.code, anna, ben };
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
            const { db } = await import('./db/db.js');
            const resync = await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            db.pragma('wal_checkpoint(TRUNCATE)');
            return { resync, envelope };
        },
        inspect: (a) => inspectNode(a),
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
const count = (text: string, needle: string) => text.split(needle).length - 1;

interface CaseResult { step: string; starts: number; outputs: string; after: any; journalSteps: string[] }

async function runCase(step: string, baseDir: string, root: string, code: string, ownerSeedHex: string): Promise<CaseResult> {
    const dir = path.join(root, `crash-${step}`);
    copyDir(baseDir, dir);
    const env = { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', BEANPOOL_TEST_TAKEOVER_CRASH_AFTER: step };
    const outputs: string[] = [];
    let node: NodeProc | null = await spawnNode(SCRIPT, dir, env);
    try {
        const opened = await post(node.base, '/api/local/admin/takeover/open', { code }, { 'X-Admin-Password': PW_STANDBY });
        if (opened.status !== 200) throw new Error(`[${step}] open answered ${opened.status}: ${JSON.stringify(opened.body)}`);
        // For a step before the restart the process dies inside this request, so there may be no answer.
        await post(node.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
        await node.exited;
        outputs.push(node.output());
        node = null;
        let starts = 1;
        for (;;) {
            starts++;
            if (starts > 5) throw new Error(`[${step}] never came up after 4 starts`);
            try {
                node = await spawnNode(SCRIPT, dir, env);
                break;
            } catch (e: any) {
                outputs.push(String(e.output || ''));
            }
        }
        const after = await node.send('inspect', { ownerSeedHex });
        outputs.push(node.output());
        const journal = JSON.parse(fs.readFileSync(path.join(dir, 'takeover-journal.json'), 'utf-8'));
        return { step, starts, outputs: outputs.join('\n'), after, journalSteps: Object.keys(journal.steps) };
    } catch (e: any) {
        console.error(outputs.join('\n').slice(-6000));
        if (node) console.error(node.output().slice(-6000));
        if (e?.output) console.error(String(e.output).slice(-6000));
        throw e;
    } finally {
        if (node) await node.kill();
    }
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const mainDir = path.join(root, 'main');
    const baseDir = path.join(root, 'standby-base');
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');

    console.log('\n— setup: a main server, a standby that copies it, then the main server killed —');
    const main = await spawnNode(SCRIPT, mainDir, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
    let setup: any;
    let mainPeerId: string;
    try {
        setup = await main.send('setup-primary', { ownerSeedHex, replicationToken, tunnelToken: TUNNEL_TOKEN });
        mainPeerId = main.ready.peerId;
        fs.mkdirSync(baseDir, { recursive: true });
        fs.copyFileSync(path.join(mainDir, 'genesis.json'), path.join(baseDir, 'genesis.json'));
        const standby = await spawnNode(SCRIPT, baseDir, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: mainPeerId });
        const pulled = await standby.send('pull');
        assert(pulled.resync.ok && pulled.envelope === 'stored', 'the standby copied the main server and holds its locked keys');
        await standby.kill('SIGTERM');
    } finally {
        await main.kill();
    }

    const steps = TAKEOVER_STEPS.map(([s]) => s);
    const results: CaseResult[] = [];
    // Four at a time: each case is a few short-lived processes.
    for (let i = 0; i < steps.length; i += 4) {
        results.push(...await Promise.all(steps.slice(i, i + 4).map((s) => runCase(s, baseDir, root, setup.code, ownerSeedHex))));
    }

    for (const r of results) {
        console.log(`\n— killed right after "${r.step}" (${r.starts} starts) —`);
        const a = r.after;
        assert(r.journalSteps.length === steps.length && steps.every((s) => r.journalSteps.includes(s)) && a.progress.state === 'complete',
            `[${r.step}] the journal ends complete, every step recorded`);
        assert(a.role === 'primary' && a.peerId === mainPeerId!, `[${r.step}] the main server, with the SAME PeerId`);
        const roles = a.roles as { member_pubkey: string; role: string }[];
        assert(roles.length === 2 && roles.some((x) => x.member_pubkey === setup.anna && x.role === 'owner') && roles.some((x) => x.member_pubkey === setup.ben && x.role === 'admin'),
            `[${r.step}] the roles are present`);
        assert(a.keySignIn.solved && a.keySignIn.session && a.keySignIn.sessionRole === 'owner', `[${r.step}] the owner's key sign-in works`);
        assert(a.connectors.length === 1 && a.connectors[0].trustLevel === 'peer', `[${r.step}] the link with the other community is restored, no mirror pin`);
        assert(a.configNodeRole === 'primary' && !a.promotionAuditPending && a.lastPromotionAudit?.ok === true && a.backupPrimaryUrl === null,
            `[${r.step}] nodeRole in the config, the audit done and passed, the pull settings cleared`);
        assert(a.tunnelTokenFile === TUNNEL_TOKEN && a.publicAddress?.tunnelToken === TUNNEL_TOKEN, `[${r.step}] the tunnel token is back`);
        assert(a.envelope.state === 'sealed' && !a.heldDirExists && !a.bundleFileExists, `[${r.step}] the keys are re-sealed here; no held copies, no opened keys left`);
        assert(count(r.outputs, AUDIT_BANNER) === 1, `[${r.step}] the conservation audit ran exactly once across every start (${count(r.outputs, AUDIT_BANNER)})`);
        assert(count(r.outputs, ANNOUNCED) === 1, `[${r.step}] the community was told exactly once (${count(r.outputs, ANNOUNCED)})`);
        assert(a.preTakeoverDirs.length === 1, `[${r.step}] one copy of the standby's own files`);
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    console.log('⭐️ ALL TAKE-OVER CRASH-RESUME CHECKS PASSED.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
