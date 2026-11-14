/**
 * Test Suite: a standby on its main server's own build whose database lost a column (a migration that failed) reads its
 * whole copies as schema drift (scratch/fable-design/decisions/DECISION-table-hashes-version.md, test 5): not exact, the
 * table named, no force-resync asked (a copy brings rows, never a schema), and the owners' incident open on the main server.
 *
 * Two node processes on this build, each with its own data dir (takeover-test-harness.ts): M, the main server, and S, its
 * standby, which pulls through its real puller (services/backup-puller.ts `pullNow`) from M's real backup routes.
 *  1. S copies M: its first copy, a delta and a whole copy. The whole copy's check compares every table, and is exact.
 *  2. A column is dropped from one of S's copied tables (forum_follows.last_read), as a failed migration would leave it.
 *     The next whole copy carries the same definitions (`def`) as S's own, so the table hashed another way on S is drift:
 *     S's record says not exact, names forum_follows, and asked for no force-resync; its next pull is a delta, not a
 *     resync, and reports it; M opens an incident for the owners whose banner names the table.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-schema-drift.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SCRIPT = fileURLToPath(import.meta.url);
const DROPPED = { table: 'forum_follows', column: 'last_read' };

async function child(): Promise<void> {
    // Nothing leaves this machine.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; owner: string }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            seedGenesisMember(a.owner, 'Gwen');
            setReplicationToken(a.replicationToken);
            return true;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            pinMainServerForTests(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        /** One pull of the kind the loop makes next; `whole` asks the loop's routine whole copy. */
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = '1';
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            process.env.BACKUP_RECONCILE_EVERY_MS = '86400000';
            const after = getBackupStatus();
            return { ...result, mode: after.lastPullMode, whole: after.lastFullReconcileAt !== before };
        },
        record: async () => (await import('./services/standby-copy-record.js')).readCopyRecord(),
        /** A write on the main server, so the next whole copy isn't the bodiless "unchanged" 304. */
        touch: async () => {
            const { db } = await import('./db/db.js');
            db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('test_touch', ?)").run(new Date().toISOString());
            return true;
        },
        /** A column gone from one of this database's copied tables, as a migration that failed would leave it. */
        'drop-column': async (a: { table: string; column: string }) => {
            const { db } = await import('./db/db.js');
            db.exec(`ALTER TABLE "${a.table}" DROP COLUMN "${a.column}"`);
            return (db.prepare('SELECT name FROM pragma_table_info(?)').all(a.table) as { name: string }[]).map((c) => c.name);
        },
        /** The main server's watch on its standbys (services/standby-health.ts): its state and the owners' banner. */
        health: async () => {
            const m = await import('./services/standby-health.js');
            return { state: m.readStandbyHealthForTests(), banner: m.getStandbyHealthBanner() };
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
    }
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}
const brief = (v: unknown) => JSON.stringify(v)?.slice(0, 300);

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (role: string) => ({ NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const owner = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    try {
        console.log('\n— 1. S copies M, exactly —');
        const main = await spawnNode(SCRIPT, dir('main'), env('primary'));
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, owner });
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dir('standby'), env('backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const first = await standby.send('pull', {});
        const delta = await standby.send('pull', {});
        await main.send('touch');
        const whole = await standby.send('pull', { whole: true });
        require_(first.ok && delta.ok && whole.ok && whole.whole, `S copies M: its first copy, a delta and a whole copy land (${brief([first, delta, whole])})`);
        let rec = await standby.send('record');
        require_(rec.lastWhole?.exact === true && rec.lastWhole.hashed === true,
            `S's whole-copy check compared every table, and found them equal (${brief(rec.lastWhole)})`);

        console.log('\n— 2. a column dropped on S: schema drift —');
        const columns: string[] = await standby.send('drop-column', DROPPED);
        require_(!columns.includes(DROPPED.column) && columns.length > 0, `S's ${DROPPED.table} has no ${DROPPED.column} now (${brief(columns)})`);
        await main.send('touch');
        const drifted = await standby.send('pull', { whole: true });
        require_(drifted.ok && drifted.whole && drifted.mode === 'full', `M's next whole copy lands on S (${brief(drifted)})`);
        rec = await standby.send('record');
        assert(rec.lastWhole?.exact === false && JSON.stringify(rec.lastWhole.differs) === JSON.stringify([DROPPED.table]) && rec.lastWhole.hashed === true,
            `S's check finds the copy not exact, and names ${DROPPED.table} alone (${brief(rec.lastWhole)})`);
        assert(rec.lastWhole?.resyncAsked === false && rec.lastMismatchResyncAt === null,
            `S asked for no force-resync, which would bring rows and never a schema (${rec.lastWhole?.resyncAsked}, ${rec.lastMismatchResyncAt})`);
        const report = await standby.send('pull', {});
        assert(report.ok && report.mode === 'delta', `S's next pull is a delta, not a resync, and carries its report (${brief(report)})`);
        const health = await main.send('health');
        const seen = health.state.standbys[0];
        assert(health.state.standbys.length === 1 && seen?.exact === false && JSON.stringify(seen.differs) === JSON.stringify([DROPPED.table]) && seen.healing === false,
            `M keeps S's report: not exact, ${DROPPED.table} differing, and not mending by itself (${brief(seen)})`);
        const problems = health.state.incident?.problems ?? [];
        assert(problems.length === 1 && problems[0].kind === 'inexact' && JSON.stringify(problems[0].differs) === JSON.stringify([DROPPED.table]),
            `M opens the owners' incident at once, for ${DROPPED.table} (${brief(health.state.incident)})`);
        const lines: string[] = health.banner.incident?.lines ?? [];
        assert(lines.length === 1 && lines[0].includes('did not match it: forum follows differed'),
            `the owners' banner names it: "${lines[0]}"`);
    } finally {
        for (const n of nodes) await n.kill().catch(() => {});
    }
    console.log(`\n${testsPassed}/${testsRun} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error(e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        process.exit(1);
    });
}
