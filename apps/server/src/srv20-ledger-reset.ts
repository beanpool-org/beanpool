/**
 * SRV-20 ledger cutover migration (phase 3e).
 *
 * Resets the *ledger* (transactions + balances) so the signed-ledger enforcement
 * (ENFORCE_LEDGER_AUTH) can be turned on cleanly: every transfer created after the
 * cutover carries a member signature (transfers) or is node-orchestrated, and the
 * conservation baseline starts from a clean zero. Existing UNSIGNED history can't
 * be verified and would be rejected under enforcement, so it is cleared.
 *
 * PRESERVED: members (identities/callsigns/tiers/vouches), posts (offers) + photos,
 *            messages, friends, ratings, projects, node config.
 * RESET:     transactions (deleted), all account balances → 0, transient escrow_
 *            and project_ accounts (deleted), the conservation baseline.
 *
 * One-shot, destructive, and IRREVERSIBLE for ledger data. Run with the node
 * STOPPED (so nothing writes concurrently and the restarted node reloads balances
 * from the reset DB), once per node in the test pair, at cutover:
 *
 *   # stop the node, then:
 *   CONFIRM_LEDGER_RESET=yes BEANPOOL_DATA_DIR=/data pnpm exec tsx src/srv20-ledger-reset.ts
 *   # start the node on the new build, then flip ENFORCE_LEDGER_AUTH=true
 */
import { db } from './db/db.js';

function main(): void {
    if (process.env.CONFIRM_LEDGER_RESET !== 'yes') {
        console.error('Refusing to run: set CONFIRM_LEDGER_RESET=yes to confirm this DESTRUCTIVE ledger reset.');
        console.error('It deletes all transactions and zeroes all balances (members + offers are preserved).');
        process.exit(1);
    }

    const before = {
        members: (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c,
        posts: (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number }).c,
        transactions: (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c,
        accounts: (db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c,
    };

    const nowIso = new Date().toISOString();

    db.transaction(() => {
        // Clear the unverifiable transaction history.
        db.prepare('DELETE FROM transactions').run();
        // Drop transient synthetic accounts (escrow/crowdfund holding wallets) —
        // their backing transactions are gone.
        db.prepare("DELETE FROM accounts WHERE public_key LIKE 'escrow\\_%' ESCAPE '\\' OR public_key LIKE 'project\\_%' ESCAPE '\\'").run();
        // Zero every remaining account (members, COMMONS_POOL, genesis/SYSTEM).
        db.prepare('UPDATE accounts SET balance = 0, last_demurrage_epoch = 0, last_updated_at = ?').run(nowIso);
        // Reset the conservation baseline so it re-establishes at the clean (~0) sum.
        db.prepare("DELETE FROM node_config WHERE key = 'ledger_audit_baseline'").run();
    })();

    const after = {
        members: (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c,
        posts: (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number }).c,
        transactions: (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c,
        accounts: (db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c,
        balanceSum: (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s,
    };

    console.log('✅ SRV-20 ledger cutover complete.');
    console.log(`   members preserved:      ${before.members} → ${after.members}`);
    console.log(`   offers (posts) preserved: ${before.posts} → ${after.posts}`);
    console.log(`   transactions cleared:   ${before.transactions} → ${after.transactions}`);
    console.log(`   accounts:               ${before.accounts} → ${after.accounts} (transient escrow/project dropped)`);
    console.log(`   balance sum (should be 0): ${after.balanceSum}`);
    console.log('   Next: start the node on the new build, then set ENFORCE_LEDGER_AUTH=true (and read/WS auth flags once the app is adopted).');
}

main();
process.exit(0);
