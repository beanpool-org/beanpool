/**
 * Test Suite: a take-over killed before `role` and finished at the next start, which makes the process the main server in
 * place, runs what a main server's boot runs (the 2026-10-02 review of #1448).
 *
 * The three suites test-takeover-crash-next-start-fails.ts, test-takeover-crash-boot-role.ts and
 * test-takeover-crash-promoted-in-place.ts were one until it took 3m52s-4m17s on CI against the runner's 300 s per suite;
 * each builds the same world (takeover-rollback-test-harness.ts).
 *
 *  1. Killed before `role`, finished at the next start, which makes the process the main server in place: an expired vote,
 *     a passed hardship grant and a 10-day-old request are handled within its first ticks, and a settled escrow left at
 *     zero is swept, with no restart.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-crash-promoted-in-place.ts
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode } from './takeover-test-harness.js';
import { runRollbackSuite, killedAfter, standbyCopy, assert, STANDBY_ENV, type World } from './takeover-rollback-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);

/**
 * 1. Killed after `roles` (before `role`), with an expired open vote, a passed hardship grant and a request nobody answered
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

runRollbackSuite(SCRIPT, '⭐️ ALL TAKE-OVER CRASH, PROMOTED-IN-PLACE CHECKS PASSED.', async (world, root) => {
    console.log('\n— 1. killed before "role", finished at the next start in place: it runs what a main server\'s boot runs —');
    await promotedInPlaceRunsMainServer(world, root);
});
