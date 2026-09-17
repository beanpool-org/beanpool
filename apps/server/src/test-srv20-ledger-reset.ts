/**
 * Integration test for srv20-ledger-reset.ts (Phase 3e cutover script).
 *
 * Asserts:
 * 1. The script refuses to run without CONFIRM_LEDGER_RESET=yes.
 * 2. Clears all rows from `transactions`.
 * 3. Drops transient synthetic accounts (`escrow_%` and `project_%`).
 * 4. Resets balances of remaining member/system accounts to 0 and epoch to 0.
 * 5. Removes `ledger_audit_baseline` from `node_config`.
 * 6. Preserves `members` and `posts` tables intact.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-srv20-ledger-reset.ts
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from './db/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let totalAssertions = 0;
let passedAssertions = 0;

function assert(condition: boolean, message: string): void {
    totalAssertions++;
    if (condition) {
        passedAssertions++;
        console.log(`✓ ${message}`);
    } else {
        console.error(`✗ ${message}`);
    }
}

function main(): void {
    console.log('Running srv20-ledger-reset tests...\n');

    // Step 1: Initialize schema in current data directory
    initSchema();

    // Seed test data
    const nowIso = new Date().toISOString();
    db.prepare(`
        INSERT INTO members (public_key, callsign, joined_at)
        VALUES ('pubkey_alice', 'alice', ?), ('pubkey_bob', 'bob', ?)
    `).run(nowIso, nowIso);

    db.prepare(`
        INSERT INTO posts (id, type, category, author_pubkey, title, description, credits, created_at)
        VALUES ('post_1', 'offer', 'goods', 'pubkey_alice', 'Apples', 'Fresh apples', 10, ?)
    `).run(nowIso);

    db.prepare(`
        INSERT INTO accounts (public_key, balance, last_demurrage_epoch, last_updated_at)
        VALUES
            ('pubkey_alice', 150.5, 4, ?),
            ('pubkey_bob', 49.5, 2, ?),
            ('escrow_proj123', 100.0, 0, ?),
            ('project_proj123', 0.0, 0, ?)
    `).run(nowIso, nowIso, nowIso, nowIso);

    db.prepare(`
        INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp)
        VALUES ('tx_1', 'pubkey_alice', 'pubkey_bob', 10.0, 'Test tx', ?)
    `).run(nowIso);

    db.prepare(`
        INSERT INTO node_config (key, value)
        VALUES ('ledger_audit_baseline', '200.0'), ('other_config', 'true')
    `).run();

    // Verify seeded state
    const beforeTxCount = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    const beforeMemberCount = (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c;
    const beforePostCount = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number }).c;
    const beforeAccountCount = (db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c;

    assert(beforeTxCount === 1, 'seeded 1 transaction');
    assert(beforeMemberCount === 2, 'seeded 2 members');
    assert(beforePostCount === 1, 'seeded 1 post');
    assert(beforeAccountCount === 4, 'seeded 4 accounts (2 members + 2 transient)');

    // Step 2: Assert refusal without CONFIRM_LEDGER_RESET=yes
    let refusalCaught = false;
    try {
        execFileSync('pnpm', ['exec', 'tsx', 'src/srv20-ledger-reset.ts'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, CONFIRM_LEDGER_RESET: 'no' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err: unknown) {
        refusalCaught = true;
        const execErr = err as { stderr?: Buffer | string };
        const stderr = execErr.stderr?.toString() || '';
        assert(stderr.includes('Refusing to run'), 'script outputs refusal message when flag is missing/no');
    }
    assert(refusalCaught, 'script exits with error code when CONFIRM_LEDGER_RESET is not yes');

    // Step 3: Run cutover script with CONFIRM_LEDGER_RESET=yes
    try {
        const out = execFileSync('pnpm', ['exec', 'tsx', 'src/srv20-ledger-reset.ts'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, CONFIRM_LEDGER_RESET: 'yes' },
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        assert(out.includes('SRV-20 ledger cutover complete'), 'script outputs success message');
    } catch (err: unknown) {
        const execErr = err as { stdout?: Buffer | string; stderr?: Buffer | string };
        console.error('Execution failed:', execErr.stdout || '', execErr.stderr || '');
        assert(false, 'script executed successfully with CONFIRM_LEDGER_RESET=yes');
    }

    // Step 4: Verify DB state after reset
    const afterTxCount = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    const afterMemberCount = (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c;
    const afterPostCount = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number }).c;
    const remainingAccounts = db.prepare('SELECT public_key, balance, last_demurrage_epoch FROM accounts').all() as { public_key: string; balance: number; last_demurrage_epoch: number }[];
    const baselineConfig = db.prepare("SELECT value FROM node_config WHERE key = 'ledger_audit_baseline'").get();
    const otherConfig = db.prepare("SELECT value FROM node_config WHERE key = 'other_config'").get() as { value: string } | undefined;

    assert(afterTxCount === 0, 'transactions table is completely cleared');
    assert(afterMemberCount === beforeMemberCount, 'members table count is preserved');
    assert(afterPostCount === beforePostCount, 'posts table count is preserved');
    assert(remainingAccounts.length === 2, 'transient escrow and project accounts were deleted, leaving 2 member accounts');

    const balancesZero = remainingAccounts.every(a => a.balance === 0 && a.last_demurrage_epoch === 0);
    assert(balancesZero, 'remaining member account balances and demurrage epochs were reset to 0');

    assert(baselineConfig === undefined, 'ledger_audit_baseline key was deleted from node_config');
    assert(otherConfig?.value === 'true', 'other node_config keys remain intact');

    console.log(`\n${passedAssertions}/${totalAssertions} checks passed.`);
    if (passedAssertions !== totalAssertions) {
        throw new Error(`${totalAssertions - passedAssertions} check(s) failed`);
    }
    console.log('⭐️ test-srv20-ledger-reset PASSED.');
}

main();
process.exit(0);
