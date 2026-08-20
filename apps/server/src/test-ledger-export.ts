/**
 * Test suite for the exportLedgerAudit utility.
 * Verifies that CSV generation for balances and transactions captures members, the commons pool, funded projects, pending escrows, and transaction history.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-ledger-export.ts
 */

import { db, initSchema } from './db/db.js';
import { exportLedgerAudit } from './engine/audit.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('🧪 Starting ledger export audit test...\n');

    initSchema();

    // 1. Setup mock members & accounts
    db.prepare(`
        INSERT OR IGNORE INTO members (public_key, callsign)
        VALUES ('pubkey-alice', 'Alice'), ('pubkey-bob', 'Bob')
    `).run();
    db.prepare(`
        INSERT OR IGNORE INTO accounts (public_key, balance)
        VALUES ('pubkey-alice', 15.5), ('pubkey-bob', 20.0)
    `).run();

    // 2. Set up commons pool config/balance mock via global/state
    // Commons balance isn't explicitly mocked in accounts table for the export, it's pulled from COMMONS_BALANCE global in @beanpool/core.
    // However, the test will at least assert the row exists in CSV.

    // 3. Set up mock node_config for funded projects
    const projects = [
        { id: 'proj-1', title: 'Community Garden', status: 'funded', requestedAmount: 50 },
        { id: 'proj-2', title: 'Rejected Project', status: 'rejected', requestedAmount: 100 }
    ];
    db.prepare(`
        INSERT INTO node_config (key, value) VALUES ('commons_projects', ?)
    `).run(JSON.stringify(projects));

    // 4. Set up mock pending marketplace transaction for escrow
    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, status, credits)
        VALUES ('tx-escrow-1', 'post-1', 'pubkey-bob', 'pubkey-alice', 'pending', 12.5)
    `).run();

    // 5. Set up mock transactions for history
    db.prepare(`
        INSERT INTO transactions (id, timestamp, from_pubkey, to_pubkey, amount, memo)
        VALUES
        ('tx-1', '2024-01-01T12:00:00Z', 'pubkey-alice', 'pubkey-bob', 5.5, 'Test, memo\nwith newline'),
        ('tx-2', '2024-01-02T12:00:00Z', 'pubkey-bob', 'pubkey-alice', 2.0, 'Second memo')
    `).run();

    const { balancesCsv, transactionsCsv } = exportLedgerAudit();

    // Verify Balances CSV
    assert(balancesCsv.includes('Account,Callsign,Balance_Type,Balance'), 'balancesCsv contains correct header');
    assert(balancesCsv.includes('commons,Community Pool,System,'), 'balancesCsv contains commons pool row');
    assert(balancesCsv.includes('pubkey-alice,Alice,Member,15.5'), 'balancesCsv contains Alice member balance');
    assert(balancesCsv.includes('pubkey-bob,Bob,Member,20'), 'balancesCsv contains Bob member balance');
    assert(balancesCsv.includes('project_proj-1,Project: Community Garden,Project_Funded,50'), 'balancesCsv contains funded project');
    assert(!balancesCsv.includes('proj-2'), 'balancesCsv excludes rejected projects');
    assert(balancesCsv.includes('escrow_tx-escrow-1,Escrow (Payer: Bob),Pending_Trade,12.5'), 'balancesCsv contains escrow for pending trade');

    // Verify Transactions CSV
    assert(transactionsCsv.includes('Timestamp,Transaction_ID,From_Account,To_Account,Amount,Memo'), 'transactionsCsv contains correct header');
    assert(transactionsCsv.includes('2024-01-01T12:00:00Z,tx-1,pubkey-alice,pubkey-bob,5.5,Test; memo with newline'), 'transactionsCsv contains tx-1 with sanitized memo (newlines to spaces, commas to semicolons)');
    assert(transactionsCsv.includes('2024-01-02T12:00:00Z,tx-2,pubkey-bob,pubkey-alice,2,Second memo'), 'transactionsCsv contains tx-2');

    console.log(`\n🎉 Ledger Export Audit Test Summary: ${passed}/${run} assertions passed.\n`);
    if (passed !== run) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch(err => {
    console.error('Test failed with uncaught exception:', err);
    process.exit(1);
});
