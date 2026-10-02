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
 *     (after `role` too: that start decides the take-over before its database boots, as a standby's), its own files,
 *     settings, roles, web address, copy cursor, ledger and the rows a main server's boot writes, and no opened keys. Started again, it starts once, as the standby.
 *     Taken over again, it is the main server.
 *  2. With no test hook: killed after `roles`, and the opened keys (data/takeover-bundle.json) gone before the next start,
 *     so it cannot go on by itself. It is rolled back, not left 'failed' for good.
 *  3. With no test hook: killed after `admin-settings`, and the standby's database refuses one of the keys' roles before
 *     the next start: `roles` fails at that start, and it is rolled back. With the refusal gone, it takes over.
 *  4. A journal an older build left 'failed' (it retried the step at every start, and refused a new take-over meanwhile):
 *     the next start resumes it, and finishes it.
 *  5. A roll-back that can't finish at a start, after the take-over's `role` step wrote `nodeRole: primary` (the 2026-10-02
 *     review of #1433): that start comes up as the standby, never the main server, and runs no tunnel with the community's
 *     token; the journal stays 'rolling-back' and says why. By every path into a roll-back at boot:
 *       a. killed while rolling back (pull-config failed), and local-config.json refuses writes at the next start;
 *       b. the same, and the database refuses the standby's own owner row instead;
 *       c. killed after `role`, `pull-config` fails at the next start, and local-config.json refuses writes;
 *       d. killed after `role`, the opened keys gone, and local-config.json refuses writes.
 *     With what refused it gone, the next start finishes the roll-back: the standby it was.
 *  6. The undo copy gone (data/pre-takeover-… deleted after `roles`), and the next step fails at the next start: nothing
 *     is put back or deleted (the node key, genesis, links and settings stay as they were, so the same PeerId and no new
 *     genesis), the server is a standby with no tunnel, and the journal says why in plain words, never "put back". A
 *     start after that is the same.
 *  7. Killed after `role`, one crash state started several ways (the 2026-10-02 review of #1433, its A/B): the start that
 *     rolls the take-over back never boots its database as the main server. Its node_config rows are a standby's (as the
 *     control's, whose journal says 'rolling-back' from the first line), the recovery seal's records as before the
 *     take-over (rows a main server's boot already wrote are put back), and no main server's timer runs or fails, nor on a
 *     main server made a standby while it runs. Taken over again with no restart, the photo URLs' shape changes then.
 *  8. A main server whose journal is one the take-over code never resumes or rolls back (past its restart from a build with
 *     no `undo-copy`; `{}`, `[]`, no steps, another version) boots its database as the main server, as the merge base does.
 *  9. Killed before `role`, finished at the next start, which makes the process the main server in place: an expired vote,
 *     a passed hardship grant and a 10-day-old request are handled within its first ticks, and a settled escrow left at
 *     zero is swept, with no restart.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-crash-then-fails.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { spawnNode, copyDir, type NodeProc } from './takeover-test-harness.js';
import {
    rollbackChild, buildWorld, openAndConfirm, standbyCopy, ownParts, differences, assert, tally, PW_STANDBY, TUNNEL_TOKEN, type World,
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

/** The tunnel runs nowhere in this start: none wanted or running, and the fake cloudflared never started with the community's token. */
async function assertNoTunnel(node: NodeProc, dir: string, label: string): Promise<void> {
    const seen = await node.send('inspect');
    const runsFile = path.join(`${dir}.cloudflared`, 'runs.jsonl');
    const runs = fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    assert(seen.tunnel.wantedToken === null && seen.tunnel.runningToken === null && !runs.some((r: any) => r.env?.TUNNEL_TOKEN === TUNNEL_TOKEN),
        `[${label}] no tunnel: none wanted or running, and none started with the community's token (${JSON.stringify(seen.tunnel)}, ${runs.length} run(s))`);
}

/** A start whose roll-back did not finish: a standby, no tunnel, the journal still 'rolling-back' and saying why. */
async function assertHeldAsStandby(node: NodeProc, dir: string, label: string, why: RegExp): Promise<Record<string, any>> {
    assert(node.ready.role === 'backup', `[${label}] that start comes up as the standby, not the main server (${node.ready.role})`);
    await assertNoTunnel(node, dir, label);
    const s = await node.send('state');
    assert(s.role === 'backup' && s.journal?.state === 'rolling-back' && !s.journal?.rolledBack && s.progress.state === 'rolling-back',
        `[${label}] the journal and Settings say it is still rolling back (${s.journal?.state})`);
    assert(why.test(s.progress.rollBackStopped?.why ?? '') && s.journal?.rollBackStopped?.why === s.progress.rollBackStopped?.why,
        `[${label}] the journal says why, for Settings (${s.progress.rollBackStopped?.why})`);
    assert(/this server runs as a standby, with no tunnel/.test(node.output()), `[${label}] and the log says it runs as a standby`);
    return s;
}

/** Started with what refused the roll-back gone: finished, the standby it was. */
async function finishesOnceAllowed(world: World, dir: string, label: string, failedStep: string): Promise<void> {
    const node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
    try {
        assert(/Finishing the roll-back of a take-over that stopped/.test(node.output()), `[${label}] allowed again, the next start finishes the roll-back`);
        await assertStartedRolledBack(world, node, `${label}, allowed again`, failedStep);
        await assertNoTunnel(node, dir, `${label}, allowed again`);
    } catch (e: any) {
        console.error(`[${label}]\n${node.output().slice(-6000)}`);
        throw e;
    } finally {
        await node.kill();
    }
}

type Refusal = 'config' | 'owner-row';

/** Make the standby's data dir refuse the roll-back (local-config.json read-only, or the standby's own owner row), and undo it. */
function refuse(world: World, dir: string, how: Refusal): () => void {
    const configFile = path.join(dir, 'local-config.json');
    const sqlite = (sql: string) => {
        const conn = new Database(path.join(dir, 'state.db'));
        try { conn.exec(sql); } finally { conn.close(); }
    };
    if (how === 'config') {
        fs.chmodSync(configFile, 0o444);
        return () => fs.chmodSync(configFile, 0o644);
    }
    sqlite(`CREATE TRIGGER test_refuse_own_owner BEFORE INSERT ON node_roles WHEN NEW.member_pubkey = '${world.ben}' AND NEW.role = 'owner'
            BEGIN SELECT RAISE(ABORT, 'the database refused the standby''s own owner'); END`);
    return () => sqlite('DROP TRIGGER test_refuse_own_owner');
}

const REFUSED_WHY: Record<Refusal, RegExp> = {
    config: /local-config\.json could not be written/,
    'owner-row': /the database refused the standby's own owner/,
};

/** 5a, 5b: killed while rolling back a take-over whose `pull-config` failed (after `role`); the next start can't finish it. */
async function rollingBackRefused(world: World, root: string, how: Refusal): Promise<void> {
    const label = `killed rolling back after role, ${how === 'config' ? 'local-config.json read-only' : "the standby's own owner row refused"}`;
    const dir = standbyCopy(world, root, `rb-${how}`);
    let allow: (() => void) | null = null;
    let node = await spawnNode(SCRIPT, dir, { ...STANDBY_ENV, BEANPOOL_TEST_TAKEOVER_FAIL_AT: 'pull-config', BEANPOOL_TEST_TAKEOVER_CRASH_AFTER: 'rolling-back' });
    try {
        await openAndConfirm(node, world.code);
        await node.exited;
        const journal = JSON.parse(fs.readFileSync(path.join(dir, 'takeover-journal.json'), 'utf-8'));
        const config = JSON.parse(fs.readFileSync(path.join(dir, 'local-config.json'), 'utf-8'));
        assert(journal.state === 'rolling-back' && !!journal.steps.role && config.nodeRole === 'primary',
            `[${label}] killed rolling back, past "role": local-config.json says nodeRole primary (${journal.state}, ${config.nodeRole})`);
        allow = refuse(world, dir, how);
        node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
        await assertHeldAsStandby(node, dir, label, REFUSED_WHY[how]);
        await node.kill();
        allow();
        allow = null;
        await finishesOnceAllowed(world, dir, label, 'pull-config');
    } catch (e: any) {
        console.error(`[${label}]\n${node.output().slice(-6000)}`);
        throw e;
    } finally {
        allow?.();
        await node.kill();
    }
}

/** 5c, 5d: killed after `role`; at the next start the roll-back begins there (a resumed step fails, or the keys are gone) and can't finish. */
async function bootRollBackRefused(world: World, root: string, path_: 'step-fails' | 'keys-gone'): Promise<void> {
    const label = `killed after role, ${path_ === 'step-fails' ? 'pull-config fails' : 'opened keys gone'} at the next start, local-config.json read-only`;
    const dir = standbyCopy(world, root, `boot-${path_}`);
    let allow: (() => void) | null = null;
    await killedAfter(world, dir, 'role');
    if (path_ === 'keys-gone') fs.rmSync(path.join(dir, 'takeover-bundle.json'));
    allow = refuse(world, dir, 'config');
    const node = await spawnNode(SCRIPT, dir, { ...STANDBY_ENV, ...(path_ === 'step-fails' ? { BEANPOOL_TEST_TAKEOVER_FAIL_AT: 'pull-config' } : {}) });
    try {
        await assertHeldAsStandby(node, dir, label, REFUSED_WHY.config);
        await node.kill();
        allow();
        allow = null;
        await finishesOnceAllowed(world, dir, label, 'pull-config');
    } catch (e: any) {
        console.error(`[${label}]\n${node.output().slice(-6000)}`);
        throw e;
    } finally {
        allow?.();
        await node.kill();
    }
}

/** 6. The undo copy deleted after `roles`; `public-address` fails at the next start. */
async function undoCopyGone(world: World, root: string): Promise<void> {
    const label = 'killed after roles, the undo copy gone, public-address fails';
    const dir = standbyCopy(world, root, 'undo-gone');
    await killedAfter(world, dir, 'roles');
    const undo = fs.readdirSync(dir).filter((n) => n.startsWith('pre-takeover-'));
    assert(undo.length === 1, `[${label}] one undo copy to delete (${undo.join(', ')})`);
    fs.rmSync(path.join(dir, undo[0]), { recursive: true });
    const FILES = ['libp2p_key', 'community.key', 'genesis.json', 'connectors.json', 'recovery-seal.key', 'open-join.key', 'local-config.json'];
    const hashes = () => Object.fromEntries(FILES.map((f) => {
        const p = path.join(dir, f);
        return [f, fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) : null];
    }));
    const filesBefore = hashes();
    const communityId = JSON.parse(fs.readFileSync(path.join(dir, 'genesis.json'), 'utf-8')).communityId;
    for (const [i, env] of [{ BEANPOOL_TEST_TAKEOVER_FAIL_AT: 'public-address' }, {}].entries()) {
        const at = `${label}${i ? ', started again' : ''}`;
        const node = await spawnNode(SCRIPT, dir, { ...STANDBY_ENV, ...env });
        try {
            const s = await assertHeldAsStandby(node, dir, at, /is gone, so nothing was put back and nothing was deleted/);
            const filesNow = hashes();
            assert(JSON.stringify(filesNow) === JSON.stringify(filesBefore),
                `[${at}] no file deleted or changed: the node key, genesis, links and settings as the take-over left them (${JSON.stringify({ before: filesBefore, now: filesNow })})`);
            assert(node.ready.peerId === world.mainPeerId, `[${at}] the same PeerId, the one the take-over wrote (${node.ready.peerId})`);
            assert(JSON.parse(fs.readFileSync(path.join(dir, 'genesis.json'), 'utf-8')).communityId === communityId && !/generating Genesis Block|Genesis Block written/.test(node.output()),
                `[${at}] no new genesis: the same community`);
            assert(s.progress.rollBackStopped?.undoCopyMissing === true && !/put back this standby/.test(JSON.stringify(s.journal)),
                `[${at}] the journal says the undo copy is missing, and never that anything was put back`);
            assert(/Rolling back cannot start: the copy of this standby's own files/.test(node.output()) && !/\[Takeover\] Rolled back: /.test(node.output()),
                `[${at}] the log says why it cannot be undone, and never "rolled back"`);
        } catch (e: any) {
            console.error(`[${at}]\n${node.output().slice(-6000)}`);
            throw e;
        } finally {
            await node.kill();
        }
    }
}

/** A main server's timers failing on a standby: the Decisions, Keepers and Groups ticks, and the others armed with them. */
const TIMER_FAILED = /Periodic tick failed|Convenor vote tick failed|Reminder sweep failed|Hygiene sweep failed|StandbyLedgerError/;

/**
 * 7. One crash state (killed after `role`, a listing photo held) copied and started several ways (the 2026-10-02 review of
 * #1433, its A/B). B, the control: its journal set to 'rolling-back' first, so its database boots as a standby's from the
 * first line. Each of the others rolls the take-over back at that start, and its database never boots as the main server:
 *   A: the opened keys gone;
 *   A2: the keys there, and `pull-config` fails at that start;
 *   C: the keys gone, and the rows a main server's boot writes already written (as a start on a build before this left
 *      them): the roll-back puts them back.
 * Each holds every node_config row B holds, the recovery seal's clear and the epoch its main server sent are as before the
 * take-over, and no main server's timer runs or fails in 70 s. Nor on D, a main server made a standby while it runs: its
 * timers, armed at its boot, return quietly. A is then taken over again with no restart between: the main
 * server's start records the photo URLs' new shape at that start, so a phone that synced after the failed try still heals.
 */
async function bootRollBackAsStandby(world: World, root: string): Promise<{ mainDir: string; photoKeysSince: string }> {
    const label = 'killed after role, rolled back at the next start (A/B)';
    const crash = standbyCopy(world, root, 'ab-crash');
    await killedAfter(world, crash, 'role');
    const sqlite = (dir: string, fn: (conn: Database.Database) => void) => {
        const conn = new Database(path.join(dir, 'state.db'));
        try { fn(conn); } finally { conn.close(); }
    };
    sqlite(crash, (conn) => {
        conn.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey) VALUES ('ab-post', 'offer', 'food', 'Eggs', 'Fresh eggs', 5, ?)`)
            .run(world.anna);
        conn.prepare("INSERT INTO post_photos (post_id, photo_data, order_num) VALUES ('ab-post', 'data:image/png;base64,iVBORw0KGgo=', 0)").run();
    });
    const copyOf = (name: string) => standbyCopy({ ...world, baseDir: crash }, root, name);
    const dirA2 = copyOf('ab-a2');
    fs.rmSync(path.join(crash, 'takeover-bundle.json'));
    const [dirA, dirB, dirC] = [copyOf('ab-a'), copyOf('ab-b'), copyOf('ab-c')];
    const journalB = path.join(dirB, 'takeover-journal.json');
    fs.writeFileSync(journalB, JSON.stringify({ ...JSON.parse(fs.readFileSync(journalB, 'utf-8')), state: 'rolling-back' }, null, 2), { mode: 0o600 });
    // C: what a start that booted its database as the main server wrote (measured on the build before this).
    sqlite(dirC, (conn) => {
        const put = conn.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)');
        const shape = (conn.prepare("SELECT value FROM node_config WHERE key = 'photoKeysShape'").get() as { value: string }).value;
        put.run('photoKeysShape', shape.replace(/@standby$/, ''));
        put.run('photoKeysSince', new Date().toISOString());
        put.run('migration_members_schema_rules_v1', '1');
        put.run('recovery_seal_cleared', JSON.stringify({ at: new Date().toISOString(), seconds: 0.01, bytesBefore: 1, bytesAfter: 1, epoch: 'abcdef0123456789', clientForm: [] }));
        conn.prepare("DELETE FROM node_config WHERE key = 'recovery_seal_main_epoch'").run();
    });

    const nodes: Record<string, NodeProc> = {};
    const started = Date.now();
    try {
        const [a, a2, b, c, d] = await Promise.all([
            spawnNode(SCRIPT, dirA, STANDBY_ENV), spawnNode(SCRIPT, dirA2, { ...STANDBY_ENV, BEANPOOL_TEST_TAKEOVER_FAIL_AT: 'pull-config' }),
            spawnNode(SCRIPT, dirB, STANDBY_ENV), spawnNode(SCRIPT, dirC, STANDBY_ENV),
            // D: a main server made a standby while it runs, after its boot armed the main server's timers.
            spawnNode(SCRIPT, path.join(root, 'ab-d'), { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'primary' }),
        ]);
        Object.assign(nodes, { A: a, A2: a2, B: b, C: c, D: d });
        assert(d.ready.role === 'primary' && await d.send('set-role', { role: 'backup' }), `[${label}] D booted as a main server, then made a standby`);
        const sb = await b.send('state');
        assert(sb.role === 'backup' && /Finishing the roll-back/.test(b.output()) && /\[Takeover\] Rolled back: /.test(b.output()),
            `[${label}] B, the control, starts as the standby and finishes the roll-back (${sb.role})`);
        const seal = (s: Record<string, any>) => JSON.stringify([s.mainBootRows.recovery_seal_cleared, s.mainBootRows.recovery_seal_main_epoch]);
        assert(seal(sb) === seal(world.before) && world.before.mainBootRows.recovery_seal_main_epoch !== null,
            `[${label}] B's recovery seal: its clear and its main server's epoch as before the take-over (${seal(world.before)})`);
        for (const [name, node] of [['A', a], ['A2', a2], ['C', c]] as const) {
            const s = await node.send('state');
            assert(node.ready.role === 'backup' && s.role === 'backup' && /\[Takeover\] Rolled back: /.test(node.output()),
                `[${label}] ${name} starts as the standby and rolls the take-over back (${node.ready.role})`);
            const keys = [...new Set([...Object.keys(s.configRows), ...Object.keys(sb.configRows)])].sort();
            const differ = keys.filter((k) => s.configRows[k] !== sb.configRows[k]);
            assert(differ.length === 0, `[${label}] ${name}'s database holds no row a main server's boot writes: every node_config row as B's (differ: ${differ.join(', ') || 'none'})`);
            assert(JSON.stringify(s.mainBootRows) === JSON.stringify(sb.mainBootRows),
                `[${label}] ${name}: the photo URLs' shape, the schema-rules marker and the recovery seal's records as B's (${JSON.stringify({ [name]: s.mainBootRows, B: sb.mainBootRows })})`);
            assert(seal(s) === seal(world.before), `[${label}] ${name}: the recovery seal's clear and its main server's epoch as before the take-over (${seal(world.before)} → ${seal(s)})`);
        }
        // Decisions fires 30 s in, then Decisions, Keepers and Groups every minute.
        await new Promise((r) => setTimeout(r, Math.max(0, started + 70_000 - Date.now())));
        for (const [name, node] of [['A', a], ['A2', a2], ['C', c], ['D', d]] as const) {
            const failed = node.output().split('\n').filter((l) => TIMER_FAILED.test(l));
            assert(failed.length === 0, `[${label}] ${name}: in 70 s no main server's timer runs or fails on the standby (${failed.length} line(s): ${failed.slice(0, 2).join(' | ').slice(0, 300)})`);
        }
        await Promise.all([a2.kill(), b.kill(), c.kill(), d.kill()]);

        // A, taken over again with no restart between.
        const retriedAt = Date.now();
        const confirmed = await openAndConfirm(a, world.code);
        assert(confirmed.status === 200, `[${label}] A taken over again in the same process: confirmed (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 160)})`);
        await a.exited;
        nodes.A = await spawnNode(SCRIPT, dirA, STANDBY_ENV);
        const s = await nodes.A.send('state');
        const since = Date.parse(s.mainBootRows.photoKeysSince ?? '');
        assert(s.role === 'primary' && s.journal?.state === 'complete', `[${label}] A is the main server now, the journal complete (${s.role}, ${s.journal?.state})`);
        assert(since >= retriedAt && !/@standby/.test(s.mainBootRows.photoKeysShape ?? '@standby'),
            `[${label}] the photo URLs' shape is the main server's, changed at this take-over, not at the failed start (${s.mainBootRows.photoKeysSince}, retried ${new Date(retriedAt).toISOString()})`);
        return { mainDir: dirA, photoKeysSince: s.mainBootRows.photoKeysSince };
    } catch (e: any) {
        for (const [name, node] of Object.entries(nodes)) console.error(`[${label}] ${name}:\n${node.output().slice(-4000)}`);
        if (e?.output) console.error(String(e.output).slice(-4000));
        throw e;
    } finally {
        await Promise.all(Object.values(nodes).map((n) => n.kill()));
    }
}

/**
 * 8. A main server after a take-over, its journal replaced by one the take-over code never resumes or rolls back (the
 * 2026-10-02 review of #1448, node-role.ts:73). Each start boots its database as the main server, as the merge base does:
 * never as a standby's promoted in the process, the photo URLs' shape as it was. Two kinds:
 *   - a take-over past its restart, not yet done, whose build had no `undo-copy` (a journal from before #1433): it goes
 *     on, and no step before the restart runs again on the main server;
 *   - a journal the take-over code does not read: `{}`, `[]`, no steps, another version.
 */
async function journalsDecidedByConfig(root: string, promoted: { mainDir: string; photoKeysSince: string }): Promise<void> {
    const complete = JSON.parse(fs.readFileSync(path.join(promoted.mainDir, 'takeover-journal.json'), 'utf-8'));
    const olderBuild = { ...complete, state: 'restarting', completedAt: null, steps: { ...complete.steps } };
    for (const step of ['undo-copy', 'done']) delete olderBuild.steps[step];
    const kinds: [string, unknown][] = [
        ['past its restart, from a build with no undo-copy', olderBuild],
        ['{}', {}],
        ['[]', []],
        ['no steps', { v: 1, id: complete.id, state: 'running' }],
        ['another version', { ...complete, v: 2, state: 'running', steps: { opened: complete.steps.opened } }],
    ];
    await Promise.all(kinds.map(async ([kind, journal], i) => {
        const label = `a main server's journal: ${kind}`;
        const dir = path.join(root, `journal-kind-${i}`);
        copyDir(promoted.mainDir, dir);
        const written = JSON.stringify(journal, null, 2);
        fs.writeFileSync(path.join(dir, 'takeover-journal.json'), written, { mode: 0o600 });
        const undoCopies = fs.readdirSync(dir).filter((n) => n.startsWith('pre-takeover-')).sort();
        const node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
        try {
            const s = await node.send('state');
            assert(node.ready.role === 'primary' && !/NODE_ROLE set to 'primary'/.test(node.output()) && !/a standby holds no key of its own/.test(node.output()),
                `[${label}] its database boots as the main server, never as a standby's promoted in the process (${node.ready.role})`);
            assert(s.mainBootRows.photoKeysSince === promoted.photoKeysSince,
                `[${label}] the photo URLs' shape as it was: no phone's next sync answered whole (${promoted.photoKeysSince} → ${s.mainBootRows.photoKeysSince})`);
            if (i === 0) {
                assert(!/Resuming an interrupted take-over/.test(node.output()) && !s.journal?.steps?.['undo-copy']
                    && JSON.stringify([...s.preTakeoverDirs].sort()) === JSON.stringify(undoCopies) && s.journal?.state === 'complete',
                    `[${label}] it goes on to the end, and no step before the restart runs again on the main server (${s.journal?.state}; undo copies ${undoCopies.length} → ${s.preTakeoverDirs.length})`);
            } else {
                assert(fs.readFileSync(path.join(dir, 'takeover-journal.json'), 'utf-8') === written, `[${label}] the journal is left as it is`);
            }
        } catch (e: any) {
            console.error(`[${label}]\n${node.output().slice(-4000)}`);
            throw e;
        } finally {
            await node.kill();
        }
    }));
}

/**
 * 9. Killed after `roles` (before `role`), with an expired open vote, a passed hardship grant and a request nobody answered
 * for 10 days in the copy (the 2026-10-02 review of #1448, takeover.ts:1384). The next start boots its database as a
 * standby's, finishes the take-over and makes the process the main server in place: it runs what a main server's boot runs,
 * so within its first ticks the vote closes, the grant is paid or queued, the request expires, and the members' schema-rules
 * pass has run, with no restart.
 */
async function promotedInPlaceRunsMainServer(world: World, root: string): Promise<void> {
    const label = 'killed after roles, finished in place';
    const dir = standbyCopy(world, root, 'in-place');
    await killedAfter(world, dir, 'roles');
    const conn = new Database(path.join(dir, 'state.db'));
    try {
        const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
        const decision = conn.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, status,
                opens_at, closes_at, created_at, updated_at) VALUES (?, ?, ?, 'Seeded', 'pool', 'grant_hardship', ?, '{"amount":1}', '1m1v', ?, ?, ?, ?, ?)`);
        decision.run('seed-open', world.anna, 'An expired vote', world.ben, 'open', at(8), at(1), at(8), at(8));
        decision.run('seed-passed', world.ben, 'A passed hardship grant', world.ben, 'passed', at(9), at(2), at(9), at(2));
        conn.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey) VALUES ('seed-post', 'offer', 'food', 'Eggs', 'Fresh eggs', 1, ?)`)
            .run(world.anna);
        conn.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
                      VALUES ('seed-tx', 'seed-post', ?, ?, 1, 'requested', ?)`).run(world.ben, world.anna, at(10));
        // A settled deal's escrow left at zero, which a main server's boot sweeps (state-engine.ts sweepSettledEscrowAccounts).
        conn.prepare("INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES ('escrow_seed-settled', 0, 0)").run();
    } finally {
        conn.close();
    }
    const node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
    const started = Date.now();
    try {
        assert(node.ready.role === 'primary' && /NODE_ROLE set to 'primary'/.test(node.output()) && node.ready.resumed === true,
            `[${label}] the start resumed the take-over and made this process the main server in place (${node.ready.role})`);
        const seeded = async () => (await node.send('query', { sql: `SELECT
            (SELECT status FROM decisions WHERE id = 'seed-open') AS vote,
            (SELECT status FROM decisions WHERE id = 'seed-passed') AS grant_,
            (SELECT status FROM marketplace_transactions WHERE id = 'seed-tx') AS request,
            (SELECT value FROM node_config WHERE key = 'migration_members_schema_rules_v1') AS schemaRules,
            (SELECT COUNT(*) FROM accounts WHERE public_key = 'escrow_seed-settled') AS settledEscrow` }))[0];
        let now = await seeded();
        while (Date.now() - started < 75_000 && (now.vote === 'open' || now.grant_ === 'passed' || now.request === 'requested')) {
            await new Promise((r) => setTimeout(r, 2000));
            now = await seeded();
        }
        const took = Math.round((Date.now() - started) / 1000);
        assert(now.vote !== 'open', `[${label}] the expired vote is closed by the first Decisions tick (${now.vote}, ${took} s)`);
        assert(now.grant_ !== 'passed', `[${label}] the passed hardship grant is paid or queued for funds (${now.grant_})`);
        assert(now.request === 'cancelled', `[${label}] the request nobody answered for 10 days expires at the first hygiene sweep (${now.request})`);
        assert(now.schemaRules === '1', `[${label}] the members' schema-rules pass ran (${now.schemaRules})`);
        assert(now.settledEscrow === 0, `[${label}] the settled escrow left at zero is swept, as a main server's boot sweeps it (${now.settledEscrow} left)`);
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
        console.log('\n— 5. past "role", a roll-back that cannot finish at the next start: a standby, no tunnel —');
        await Promise.all([rollingBackRefused(world, root, 'config'), rollingBackRefused(world, root, 'owner-row')]);
        await Promise.all([bootRollBackRefused(world, root, 'step-fails'), bootRollBackRefused(world, root, 'keys-gone')]);
        console.log('\n— 6. the undo copy gone: nothing put back or deleted, and the journal says so —');
        await undoCopyGone(world, root);
        console.log('\n— 7. killed after "role", rolled back at the next start: its database never boots as the main server (A/B) —');
        const promoted = await bootRollBackAsStandby(world, root);
        console.log('\n— 8. journals the take-over code never resumes or rolls back: the database boots as the main server —');
        await journalsDecidedByConfig(root, promoted);
        console.log('\n— 9. killed before "role", finished at the next start in place: it runs what a main server\'s boot runs —');
        await promotedInPlaceRunsMainServer(world, root);
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
