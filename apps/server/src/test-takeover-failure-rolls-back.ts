/**
 * Test Suite: a take-over step that fails is rolled back, and the standby is the standby it was (F2 of the 2026-10-01
 * standby review, scratch/reviews/FABLE-standby-e2e.md "Area 2").
 *
 * Before: a step before the restart that threw left the journal 'failed' for good. The standby could not start a new
 * take-over ("already under way"), and every whole copy it built was thrown away at the restart that swapped it in
 * ("a take-over is under way"), the next one too: a restart and a whole copy from the main server each time, for nothing.
 *
 * The world (takeover-rollback-test-harness.ts): a main server that stays up, and a standby that copied it, holds its
 * locked keys, and has an owner and a web address of its own.
 *
 *  A. The review's case, with no test hook: the standby's database refuses one of the keys' roles, so `roles` fails after
 *     the community's node key, links and admin password are written. The confirm answers 500 and says nothing was kept;
 *     the server runs on as the standby it was: its own files, settings, roles, web address, copy cursor and ledger, the
 *     mirror pin in memory, no opened keys left. A new take-over opens. A force-resync's whole copy is swapped in at its
 *     restart, not thrown away. Restarted, it starts once, as the standby. Taken over again, it is the main server.
 *  B. Every step before the restart fails in turn (BEANPOOL_TEST_TAKEOVER_FAIL_AT, once the step's own writes are done):
 *     each is rolled back the same way, in the process that confirmed; restarted, the server starts once, as the standby;
 *     taken over again, it is the main server with the main server's PeerId.
 *  C. A crash while rolling back (SIGKILL, with the journal 'rolling-back'; and once the files are back but the settings
 *     and database not yet): the next start finishes the roll-back before anything else, and it is the standby it was.
 *  D. A roll-back that can't finish (local-config.json refuses writes, no test hook for that): the server still starts,
 *     as the standby; it copies nothing from the main server while the journal says 'rolling-back', and its status and
 *     a force-resync say why. With the file writable again, the next start finishes the roll-back.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-failure-rolls-back.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, type NodeProc } from './takeover-test-harness.js';
import {
    rollbackChild, buildWorld, openAndConfirm, standbyCopy, ownParts, differences, assert, tally, PW_STANDBY, type World,
} from './takeover-rollback-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PRE_RESTART = ['undo-copy', 'identity-files', 'admin-settings', 'roles', 'public-address', 'profile', 'open-door', 'community-settings', 'role', 'pull-config'];
const STANDBY_ENV = { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' };

/** The standby put back as it was, by `state` read in the process that rolled back or started after. */
function assertRolledBack(world: World, s: Record<string, any>, label: string, step: string): void {
    assert(s.role === 'backup', `[${label}] a standby still (${s.role})`);
    assert(ownParts(s) === ownParts(world.before),
        `[${label}] its own node key, links, settings, roles, web address, copy cursor and ledger as they were (differences: ${differences(world.before, s)})`);
    assert(s.journal?.state === 'failed' && !!s.journal?.rolledBack && s.journal?.error?.step === step,
        `[${label}] the journal says it stopped at "${step}" and was rolled back (${s.journal?.state}, ${JSON.stringify(s.journal?.rolledBack)})`);
    assert(s.progress.state === 'failed' && !!s.progress.rolledBack, `[${label}] Settings' progress says so`);
    assert(!s.bundleFile, `[${label}] the opened keys are deleted`);
}

/**
 * Take over again with the code, after whatever stopped the first one: the main server, with its PeerId. `undoCopies`: the
 * pre-takeover- folders then, one a take-over (a first one stopped before its copy was whole leaves none).
 */
async function takeOverAgain(world: World, node: NodeProc, dir: string, label: string, undoCopies = 2): Promise<void> {
    const confirmed = await openAndConfirm(node, world.code);
    assert(confirmed.status === 200 && confirmed.body.success, `[${label}] taken over again: confirmed (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 160)})`);
    assert((await node.exited) === 0, `[${label}] it restarts itself`);
    const promoted = await spawnNode(SCRIPT, dir, STANDBY_ENV);
    try {
        const s = await promoted.send('state');
        assert(s.role === 'primary' && promoted.ready.peerId === world.mainPeerId, `[${label}] the main server now, with the main server's PeerId`);
        assert(s.journal?.state === 'complete' && s.progress.state === 'complete', `[${label}] the new take-over's journal is complete`);
        assert(s.preTakeoverDirs.length === undoCopies, `[${label}] ${undoCopies} cop${undoCopies === 1 ? 'y' : 'ies'} of the standby's own files (${s.preTakeoverDirs.length})`);
    } finally {
        await promoted.kill();
    }
}

async function partA(world: World, root: string): Promise<void> {
    console.log("\n— A. the standby's database refuses one of the keys' roles (no test hook) —");
    const dir = standbyCopy(world, root, 'a-roles-refused');
    let node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
    try {
        await node.send('refuse-admin-role', { ben: world.ben });
        const confirmed = await openAndConfirm(node, world.code);
        assert(confirmed.status === 500 && confirmed.body.failedStep === 'roles',
            `the confirm answers 500, stopped at "roles" (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 200)})`);
        assert(confirmed.body.rolledBack === true && /Nothing of it was kept: this server is the standby it was/.test(confirmed.body.error ?? ''),
            `and says nothing of it was kept (${confirmed.body.error})`);
        assert(node.proc.exitCode === null && node.proc.signalCode === null, 'the server runs on: no restart');
        const s = await node.send('state');
        assertRolledBack(world, s, 'A', 'roles');
        assert(s.connectorsInMemory.includes('mirror') && !s.connectorsInMemory.includes('peer'),
            `[A] in memory too, it pins its main server again, and holds no link of the community's (${s.connectorsInMemory})`);

        const again = await post(node.base, '/api/local/admin/takeover/open', { code: world.code }, await node.send('owner-session')); // step 7c: an owner's key session the node makes
        assert(again.status === 200 && again.body.preview?.sessionId,
            `[A] a new take-over opens: nothing is "already under way" (${again.status} ${JSON.stringify(again.body).slice(0, 160)})`);
        await post(node.base, '/api/local/admin/takeover/cancel', {}, await node.send('owner-session')); // step 7c: an owner's key session the node makes

        const resync = await node.send('resync');
        assert(resync.ok && resync.restarting === true, `[A] a force-resync builds a whole copy and restarts to swap it in (${JSON.stringify(resync)})`);
        assert(node.swaps() === 1, `[A] one restart for it (${node.swaps()})`);
        const out = node.output();
        assert(/\[Swap\] Swapped in the whole copy/.test(out) && !/not swapped in, and is deleted: a take-over is under way/.test(out),
            '[A] the copy is swapped in at that restart, not thrown away for a take-over "under way"');
        const swapped = await node.send('state');
        assert(swapped.role === 'backup' && swapped.ledger.members === world.before.ledger.members && swapped.ledger.sum === world.before.ledger.sum,
            '[A] and it runs on it as the standby, every member and Bean there');
        await node.kill();

        node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
        assert(node.ready.role === 'backup' && node.ready.peerId === world.standbyPeerId, '[A] restarted, it starts once, as the standby, with its own PeerId');
        await takeOverAgain(world, node, dir, 'A');
    } catch (e: any) {
        console.error(node.output().slice(-6000));
        throw e;
    } finally {
        await node.kill();
    }
}

async function failAt(world: World, root: string, step: string): Promise<void> {
    const label = `fails at ${step}`;
    const dir = standbyCopy(world, root, `b-${step}`);
    let node = await spawnNode(SCRIPT, dir, { ...STANDBY_ENV, BEANPOOL_TEST_TAKEOVER_FAIL_AT: step });
    try {
        const confirmed = await openAndConfirm(node, world.code);
        assert(confirmed.status === 500 && confirmed.body.failedStep === step && confirmed.body.rolledBack === true,
            `[${label}] the confirm answers 500, rolled back (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 200)})`);
        assert(node.proc.exitCode === null && node.proc.signalCode === null, `[${label}] the server runs on`);
        const s = await node.send('state');
        assertRolledBack(world, s, label, step);
        assert(s.connectorsInMemory.includes('mirror'), `[${label}] it pins its main server again, in memory too`);
        // `pull-config` stopped the puller before it failed: a standby put back copies again.
        if (step === 'pull-config') assert(s.pullerRunning, `[${label}] the puller it stopped runs again`);
        await node.kill();

        node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
        assert(node.ready.role === 'backup' && node.ready.peerId === world.standbyPeerId, `[${label}] restarted, it starts once, as the standby, with its own PeerId`);
        const after = await node.send('state');
        assert(ownParts(after) === ownParts(world.before), `[${label}] and stays as it was (${differences(world.before, after)})`);
        // A step that fails before the copy of the standby's own files is whole leaves no copy: nothing had been written.
        await takeOverAgain(world, node, dir, label, step === 'undo-copy' ? 1 : 2);
    } catch (e: any) {
        console.error(`[${label}]\n${node.output().slice(-6000)}`);
        throw e;
    } finally {
        await node.kill();
    }
}

async function crashWhileRollingBack(world: World, root: string, step: string, point: string): Promise<void> {
    const label = `fails at ${step}, killed at ${point}`;
    const dir = standbyCopy(world, root, `c-${step}-${point}`);
    let node = await spawnNode(SCRIPT, dir, { ...STANDBY_ENV, BEANPOOL_TEST_TAKEOVER_FAIL_AT: step, BEANPOOL_TEST_TAKEOVER_CRASH_AFTER: point });
    try {
        await openAndConfirm(node, world.code);
        await node.exited;
        const journal = JSON.parse(fs.readFileSync(path.join(dir, 'takeover-journal.json'), 'utf-8'));
        assert(journal.state === 'rolling-back' && fs.existsSync(path.join(dir, 'takeover-bundle.json')),
            `[${label}] killed part way through the roll-back (${journal.state})`);
        node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
        assert(/Finishing the roll-back of a take-over that stopped/.test(node.output()), `[${label}] the next start finishes the roll-back`);
        assert(node.ready.role === 'backup' && node.ready.peerId === world.standbyPeerId, `[${label}] and it is the standby, with its own PeerId`);
        assertRolledBack(world, await node.send('state'), label, step);
        await takeOverAgain(world, node, dir, label);
    } catch (e: any) {
        console.error(`[${label}]\n${node.output().slice(-6000)}`);
        throw e;
    } finally {
        await node.kill();
    }
}

async function rollBackRefused(world: World, root: string): Promise<void> {
    const label = 'a roll-back that cannot finish';
    const dir = standbyCopy(world, root, 'd-refused');
    const configFile = path.join(dir, 'local-config.json');
    let node = await spawnNode(SCRIPT, dir, { ...STANDBY_ENV, BEANPOOL_TEST_TAKEOVER_FAIL_AT: 'public-address', BEANPOOL_TEST_TAKEOVER_CRASH_AFTER: 'rolling-back' });
    try {
        await openAndConfirm(node, world.code);
        await node.exited;
        fs.chmodSync(configFile, 0o444);
        node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
        assert(node.ready.role === 'backup', `[${label}] the server still starts, as the standby (${node.ready.role})`);
        assert(/Rolling back did not finish: local-config\.json could not be written/.test(node.output()), `[${label}] its log says the roll-back did not finish, and why`);
        const s = await node.send('state');
        assert(s.journal?.state === 'rolling-back' && s.progress.state === 'rolling-back', `[${label}] the journal and Settings say it is still rolling back (${s.journal?.state})`);
        const resync = await node.send('resync');
        assert(!resync.ok && /A take-over is under way on this server, or one that stopped is not yet rolled back/.test(resync.error ?? ''),
            `[${label}] a force-resync copies nothing, and says why (${resync.error})`);
        assert(node.swaps() === 0, `[${label}] no whole copy, so no restart to swap one in`);
        assert(/not yet rolled back/.test((await node.send('backup-status')).heldByTakeover ?? ''), `[${label}] the copy status says why too`);
        await node.kill();

        fs.chmodSync(configFile, 0o644);
        node = await spawnNode(SCRIPT, dir, STANDBY_ENV);
        assert(/Finishing the roll-back of a take-over that stopped/.test(node.output()) && node.ready.role === 'backup',
            `[${label}] writable again, the next start finishes the roll-back`);
        assertRolledBack(world, await node.send('state'), label, 'public-address');
        const copies = await node.send('resync');
        assert(copies.ok && copies.restarting === true, `[${label}] and it copies again (${JSON.stringify(copies)})`);
    } catch (e: any) {
        console.error(`[${label}]\n${node.output().slice(-6000)}`);
        throw e;
    } finally {
        if (fs.existsSync(configFile)) fs.chmodSync(configFile, 0o644);
        await node.kill();
    }
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    console.log('\n— setup: a main server (it stays up), and a standby that copies it and has an owner and an address of its own —');
    const world = await buildWorld(SCRIPT, root);
    try {
        assert(world.before.role === 'backup' && world.before.roles.some((r: any) => r.member_pubkey === world.ben && r.role === 'owner')
            && world.before.publicAddress?.hostname === 'standby-own.example' && world.before.cursor && world.before.files['recovery-seal.key'] === null,
        `the standby: its own owner and web address, a copy cursor, no recovery-seal key (${JSON.stringify({ ...world.before, journal: undefined })})`);

        await partA(world, root);

        console.log('\n— B. each step before the restart fails in turn —');
        for (let i = 0; i < PRE_RESTART.length; i += 4) {
            await Promise.all(PRE_RESTART.slice(i, i + 4).map((step) => failAt(world, root, step)));
        }

        console.log('\n— C. killed while rolling back —');
        await Promise.all([
            crashWhileRollingBack(world, root, 'public-address', 'rolling-back'),
            crashWhileRollingBack(world, root, 'pull-config', 'rollback-files'),
        ]);

        console.log("\n— D. a roll-back local-config.json won't let finish —");
        await rollBackRefused(world, root);
    } finally {
        await world.main.kill();
    }
    const { run, passed } = tally();
    console.log(`\n${passed}/${run} checks passed.`);
    console.log('⭐️ ALL TAKE-OVER ROLL-BACK CHECKS PASSED.');
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
