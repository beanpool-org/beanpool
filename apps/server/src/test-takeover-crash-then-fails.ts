/**
 * Test Suite: a take-over killed at any step, whose next step then fails at the start that resumes it, is rolled back at
 * that start, and the standby restarts cleanly and can take over again (F2 of the 2026-10-01 standby review,
 * scratch/reviews/FABLE-standby-e2e.md "Area 2").
 *
 * A crash on its own is resumed and finished (test-takeover-crash-resume.ts). Here the start after the crash cannot go on:
 *
 *  1. For each step from `opened` to `role`: the take-over is killed (SIGKILL on the node process, as a power cut) the
 *     moment that step is recorded, and at the next start the step after it fails (BEANPOOL_TEST_TAKEOVER_FAIL_AT). That
 *     start rolls it back before anything reads the role or the keys, and comes up as the standby, with its own PeerId
 *     (after `role`, its database had booted as a main server's: the role is set back too), its own files, settings,
 *     roles, web address, copy cursor and ledger, and no opened keys. Started again, it starts once, as the standby.
 *     Taken over again, it is the main server.
 *  2. With no test hook: killed after `roles`, and the opened keys (data/takeover-bundle.json) gone before the next start,
 *     so it cannot go on by itself. It is rolled back, not left 'failed' for good.
 *  3. With no test hook: killed after `admin-settings`, and the standby's database refuses one of the keys' roles before
 *     the next start: `roles` fails at that start, and it is rolled back. With the refusal gone, it takes over.
 *  4. A journal an older build left 'failed' (it retried the step at every start, and refused a new take-over meanwhile):
 *     the next start resumes it, and finishes it.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-crash-then-fails.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, type NodeProc } from './takeover-test-harness.js';
import {
    rollbackChild, buildWorld, openAndConfirm, standbyCopy, ownParts, differences, assert, tally, PW_STANDBY, type World,
} from './takeover-rollback-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const STEPS = ['opened', 'undo-copy', 'identity-files', 'admin-settings', 'roles', 'public-address', 'profile', 'open-door', 'community-settings', 'role', 'pull-config'];
const STANDBY_ENV = { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' };

/** Confirm with the process killed the moment `step` is recorded. */
async function killedAfter(world: World, dir: string, step: string): Promise<void> {
    const node = await spawnNode(SCRIPT, dir, { ...STANDBY_ENV, BEANPOOL_TEST_TAKEOVER_CRASH_AFTER: step });
    await openAndConfirm(node, world.code);
    await node.exited;
    const journal = JSON.parse(fs.readFileSync(path.join(dir, 'takeover-journal.json'), 'utf-8'));
    assert(!!journal.steps[step] && journal.state === 'running', `[killed after ${step}] the journal stops at "${step}"`);
}

/** The start after: rolled back there, the standby it was. */
async function assertStartedRolledBack(world: World, node: NodeProc, label: string, failedStep: string): Promise<void> {
    assert(node.ready.role === 'backup' && node.ready.peerId === world.standbyPeerId, `[${label}] that start comes up as the standby, with its own PeerId (${node.ready.role})`);
    assert(/\[Takeover\] Rolled back: /.test(node.output()), `[${label}] it rolled the take-over back, before anything else`);
    const s = await node.send('state');
    assert(ownParts(s) === ownParts(world.before), `[${label}] its own files, settings, roles, web address, copy cursor and ledger as they were (${differences(world.before, s)})`);
    assert(s.journal?.state === 'failed' && !!s.journal?.rolledBack && s.journal?.error?.step === failedStep && !s.bundleFile,
        `[${label}] the journal stopped at "${failedStep}", rolled back; no opened keys left (${s.journal?.state})`);
}

/** Started again with nothing in the way: once, as the standby; then taken over, the main server. */
async function restartsAndTakesOver(world: World, dir: string, label: string): Promise<void> {
    let node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
    try {
        assert(node.ready.role === 'backup' && node.ready.peerId === world.standbyPeerId && !/Rolled back|Resuming/.test(node.output()),
            `[${label}] started again, it starts once, as the standby, with nothing to resume`);
        const confirmed = await openAndConfirm(node, world.code);
        assert(confirmed.status === 200, `[${label}] taken over again: confirmed (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 160)})`);
        await node.exited;
        node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
        const s = await node.send('state');
        assert(s.role === 'primary' && node.ready.peerId === world.mainPeerId && s.journal?.state === 'complete',
            `[${label}] the main server now, with the main server's PeerId, the journal complete`);
    } catch (e: any) {
        console.error(`[${label}]\n${node.output().slice(-6000)}`);
        throw e;
    } finally {
        await node.kill();
    }
}

async function crashThenFail(world: World, root: string, step: string, next: string): Promise<void> {
    const label = `killed after ${step}, ${next} fails`;
    const dir = standbyCopy(world, root, `k-${step}`);
    await killedAfter(world, dir, step);
    const node = await spawnNode(SCRIPT, dir, { ...STANDBY_ENV, BEANPOOL_TEST_TAKEOVER_FAIL_AT: next });
    try {
        await assertStartedRolledBack(world, node, label, next);
    } catch (e: any) {
        console.error(`[${label}]\n${node.output().slice(-6000)}`);
        throw e;
    } finally {
        await node.kill();
    }
    await restartsAndTakesOver(world, dir, label);
}

async function keysGone(world: World, root: string): Promise<void> {
    const label = 'killed after roles, opened keys gone';
    const dir = standbyCopy(world, root, 'keys-gone');
    await killedAfter(world, dir, 'roles');
    fs.rmSync(path.join(dir, 'takeover-bundle.json'));
    const node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
    try {
        await assertStartedRolledBack(world, node, label, 'public-address');
    } finally {
        await node.kill();
    }
    await restartsAndTakesOver(world, dir, label);
}

async function refusedAtBoot(world: World, root: string): Promise<void> {
    const label = 'killed after admin-settings, a role refused at the next start';
    const dir = standbyCopy(world, root, 'refused-at-boot');
    await killedAfter(world, dir, 'admin-settings');
    const sqlite = (sql: string) => {
        const conn = new Database(path.join(dir, 'state.db'));
        try { conn.exec(sql); } finally { conn.close(); }
    };
    sqlite(`CREATE TRIGGER test_refuse_admin BEFORE INSERT ON node_roles WHEN NEW.member_pubkey = '${world.ben}' AND NEW.role = 'admin'
            BEGIN SELECT RAISE(ABORT, 'the database refused this role'); END`);
    const node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
    try {
        await assertStartedRolledBack(world, node, label, 'roles');
    } finally {
        await node.kill();
    }
    sqlite('DROP TRIGGER test_refuse_admin');
    await restartsAndTakesOver(world, dir, `${label}, then allowed`);
}

async function olderBuildsFailed(world: World, root: string): Promise<void> {
    const label = "a journal an older build left 'failed'";
    const dir = standbyCopy(world, root, 'older-failed');
    await killedAfter(world, dir, 'profile');
    const file = path.join(dir, 'takeover-journal.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf-8'));
    journal.state = 'failed';
    journal.error = { step: 'open-door', message: 'a refused write', at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(journal, null, 2), { mode: 0o600 });
    const node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
    try {
        const s = await node.send('state');
        assert(node.ready.role === 'primary' && node.ready.peerId === world.mainPeerId && s.journal?.state === 'complete',
            `[${label}] the next start resumes it at "open-door" and finishes it: the main server, the journal complete (${s.journal?.state})`);
    } catch (e: any) {
        console.error(`[${label}]\n${node.output().slice(-6000)}`);
        throw e;
    } finally {
        await node.kill();
    }
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    console.log('\n— setup: a main server (it stays up), and a standby that copies it and has an owner and an address of its own —');
    const world = await buildWorld(SCRIPT, root);
    try {
        console.log('\n— 1. killed after each step; the next one fails at the start that resumes it —');
        const cases = STEPS.slice(0, -1).map((step, i) => [step, STEPS[i + 1]] as const);
        for (let i = 0; i < cases.length; i += 4) {
            await Promise.all(cases.slice(i, i + 4).map(([step, next]) => crashThenFail(world, root, step, next)));
        }
        console.log('\n— 2-4. no test hook: the opened keys gone; a role refused at the next start; an older build\'s failed journal —');
        await Promise.all([keysGone(world, root), refusedAtBoot(world, root), olderBuildsFailed(world, root)]);
    } finally {
        await world.main.kill();
    }
    const { run, passed } = tally();
    console.log(`\n${passed}/${run} checks passed.`);
    console.log('⭐️ ALL TAKE-OVER CRASH-THEN-FAIL CHECKS PASSED.');
}

if (process.argv.includes('--child')) {
    rollbackChild().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error(e?.output ? `${e.message}\n--- node output ---\n${e.output}` : e);
        process.exit(1);
    });
}
