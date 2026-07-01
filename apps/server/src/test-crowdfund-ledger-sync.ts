/**
 * A2-1 regression test — a crowdfund pledge must not desync the in-memory ledger
 * from the `accounts` table.
 *
 * The credit-mint exploit (A2-1) worked because `pledgeToProject` debited the DB
 * via raw SQL while the in-memory LedgerManager (what getBalance/transfer read and
 * write back) stayed stale-high — so the next transfer() wrote the stale balance
 * over the DB, erasing the pledge debit and minting unbacked credit. The fix makes
 * db.ts fire a balance-mutation hook that reconciles the in-memory ledger from the
 * DB; this test asserts the two stay in lockstep across a pledge.
 *
 * Run with a throwaway data dir:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-crowdfund-ledger-sync.ts
 */
import crypto from 'node:crypto';
import { initStateEngine, getBalance, reconcileLedgerFromDb } from './state-engine.js';
import { createCrowdfundProject, pledgeToProject, db } from './db/db.js';

let testsRun = 0;
let testsPassed = 0;
function assert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) { testsPassed++; console.log(`✓ ${msg}`); }
    else { console.error(`✗ ${msg}`); }
}

function seedMember(pk: string, balance: number): void {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, pk.slice(0, 8));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(pk, balance);
    db.prepare(`UPDATE accounts SET balance=? WHERE public_key=?`).run(balance, pk);
}
const dbBalance = (pk: string): number => (db.prepare(`SELECT balance FROM accounts WHERE public_key=?`).get(pk) as { balance: number }).balance;
const sumBalances = (): number => (db.prepare(`SELECT COALESCE(SUM(balance),0) AS s FROM accounts`).get() as { s: number }).s;

async function run() {
    console.log('Running A2-1 crowdfund ledger-sync regression test...\n');
    initStateEngine(); // registers the balance-mutation hook → reconcileLedgerFromDb

    const A = 'a1pledger-' + crypto.randomBytes(6).toString('hex');
    seedMember(A, 100);
    // Pull the freshly-seeded DB balance into the in-memory ledger (as boot would).
    reconcileLedgerFromDb();

    assert(getBalance(A).balance === 100, 'baseline: in-memory balance matches DB (100)');
    const sumBefore = sumBalances();

    const projectId = 'proj-' + crypto.randomBytes(6).toString('hex');
    // goal (1000) >> pledge (30) so the auto-sweep-to-creator branch does NOT fire;
    // the pledged value stays parked in escrow.
    createCrowdfundProject(projectId, A, 'Test Project', 'desc', [], 1000, null);

    pledgeToProject(crypto.randomUUID(), projectId, A, 30, 'pledge'); // hook fires → reconcile

    assert(dbBalance(A) === 70, 'DB debited the pledger to 70');
    assert(getBalance(A).balance === 70, 'in-memory ledger reflects the pledge debit (70, NOT the stale 100)');
    assert(getBalance(A).balance === dbBalance(A),
        'in-memory == DB after pledge — the next transfer() cannot write a stale balance back and mint');

    // Pledge only MOVES value (A −30 → escrow +30): the system-wide sum is unchanged.
    assert(Math.abs(sumBalances() - sumBefore) < 1e-9, 'total balance sum unchanged by the pledge (no value minted)');

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A2-1 regression PASSED — crowdfund pledge no longer desyncs the ledger.');
}

run().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
