/**
 * Test Suite: after a take-over killed part way, the role a start boots its database as (the 2026-10-02 reviews of #1433
 * and #1448):
 *
 * The three suites test-takeover-crash-next-start-fails.ts, test-takeover-crash-boot-role.ts and
 * test-takeover-crash-promoted-in-place.ts were one until it took 3m52s-4m17s on CI against the runner's 300 s per suite;
 * each builds the same world (takeover-rollback-test-harness.ts).
 *
 *  1. Killed after `role`, one crash state started several ways (the 2026-10-02 review of #1433, its A/B): the start that
 *     rolls the take-over back never boots its database as the main server. Its node_config rows are a standby's (as the
 *     control's, whose journal says 'rolling-back' from the first line), the recovery seal's records as before the
 *     take-over (rows a main server's boot already wrote are put back), and no main server's timer runs or fails, nor on a
 *     main server made a standby while it runs. Taken over again with no restart, the photo URLs' shape changes then.
 *  2. A main server whose journal is one the take-over code never resumes or rolls back (past its restart from a build with
 *     no `undo-copy`; `{}`, `[]`, no steps, another version) boots its database as the main server, as the merge base does.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-crash-boot-role.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, copyDir, type NodeProc } from './takeover-test-harness.js';
import {
    runRollbackSuite, killedAfter, openAndConfirm, standbyCopy, assert, PW_STANDBY, STANDBY_ENV, type World,
} from './takeover-rollback-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);

/** A main server's timers failing on a standby: the Decisions, Keepers and Groups ticks, and the others armed with them. */
const TIMER_FAILED = /Periodic tick failed|Convenor vote tick failed|Reminder sweep failed|Hygiene sweep failed|StandbyLedgerError/;

/**
 * 1. One crash state (killed after `role`, a listing photo held) copied and started several ways (the 2026-10-02 review of
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
 * 2. A main server after a take-over, its journal replaced by one the take-over code never resumes or rolls back (the
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

runRollbackSuite(SCRIPT, '⭐️ ALL TAKE-OVER CRASH, BOOT-ROLE CHECKS PASSED.', async (world, root) => {
    console.log('\n— 1. killed after "role", rolled back at the next start: its database never boots as the main server (A/B) —');
    const promoted = await bootRollBackAsStandby(world, root);
    console.log('\n— 2. journals the take-over code never resumes or rolls back: the database boots as the main server —');
    await journalsDecidedByConfig(root, promoted);
});
