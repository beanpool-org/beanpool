import assert from 'node:assert';
import crypto from 'node:crypto';
import { db, createCrowdfundProject, pledgeToProject, deleteCrowdfundProject } from './db/db.js';
import { initStateEngine, reconcileLedgerFromDb, getBalance } from './state-engine.js';

console.log('Running #139 crowdfund project deletion refund regression test...');
initStateEngine();
db.exec('PRAGMA foreign_keys = ON;');

const creator = 'creator_pubkey_' + crypto.randomUUID();
const backer = 'backer_pubkey_' + crypto.randomUUID();
const projectId = 'proj_' + crypto.randomUUID();
const pledgeId = 'pledge_' + crypto.randomUUID();

// 1. Setup initial member and account balances
const INITIAL_BALANCE = 500;
const PLEDGE_AMOUNT = 100;

db.prepare(`INSERT INTO members (public_key, callsign) VALUES (?, ?)`).run(creator, 'creator_' + crypto.randomUUID().slice(0, 8));
db.prepare(`INSERT INTO members (public_key, callsign) VALUES (?, ?)`).run(backer, 'backer_' + crypto.randomUUID().slice(0, 8));

const nowEpoch = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)`).run(creator, INITIAL_BALANCE, nowEpoch);
db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)`).run(backer, INITIAL_BALANCE, nowEpoch);
db.prepare(`UPDATE node_config SET value = '1000' WHERE key = 'ledger_audit_baseline'`).run();
reconcileLedgerFromDb();

// 2. Create crowdfund project
createCrowdfundProject(projectId, creator, 'Test Project', 'Test Description', [], 1000, null);

// 3. Backer pledges to project
pledgeToProject(pledgeId, projectId, backer, PLEDGE_AMOUNT, 'Supporting project');

// Verify pledge moved funds to escrow
const escrowPubkey = `escrow_${projectId}`;
reconcileLedgerFromDb();
const backerAfterPledge = getBalance(backer).balance;
const escrowAfterPledge = getBalance(escrowPubkey).balance;

assert.strictEqual(backerAfterPledge, INITIAL_BALANCE - PLEDGE_AMOUNT, 'Backer balance should be debited');
assert.strictEqual(escrowAfterPledge, PLEDGE_AMOUNT, 'Escrow balance should be credited');

// Verify pledge transaction exists with project_id
const pledgeTx = db.prepare(`SELECT * FROM transactions WHERE project_id = ?`).get(projectId) as any;
assert(pledgeTx, 'Pledge transaction must exist with project_id');
assert.strictEqual(pledgeTx.project_id, projectId, 'Transaction project_id matches');

// 4. Delete the crowdfund project (This previously failed with SQLITE_CONSTRAINT_FOREIGNKEY #139)
let deleteError: Error | null = null;
try {
    deleteCrowdfundProject(projectId, creator);
} catch (err: any) {
    deleteError = err;
}

assert.strictEqual(deleteError, null, `deleteCrowdfundProject should not throw error (got: ${deleteError?.message})`);

// 5. Assert project is deleted from DB
const projectRow = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
assert.strictEqual(projectRow, undefined, 'Project row must be deleted');

// 6. Assert backer was refunded and escrow drained
reconcileLedgerFromDb();
const backerAfterDelete = getBalance(backer).balance;
const escrowAfterDelete = getBalance(escrowPubkey).balance;

assert.strictEqual(backerAfterDelete, INITIAL_BALANCE, 'Backer balance must be fully refunded');
assert.strictEqual(escrowAfterDelete, 0, 'Escrow balance must be drained to 0');

// 7. Assert refund transaction was created
const refundTx = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(`refund_${pledgeTx.id}`) as any;
assert(refundTx, 'Refund transaction must exist');
assert.strictEqual(refundTx.to_pubkey, backer, 'Refund to_pubkey is backer');
assert.strictEqual(refundTx.amount, PLEDGE_AMOUNT, 'Refund amount matches pledge amount');

console.log('✅ #139 crowdfund project deletion refund test PASSED successfully!');

// Exit explicitly. This suite leaves the engine's timers and handles open, so returning normally
// keeps the event loop alive and the process never terminates — it prints a pass and then hangs.
// In CI that is indistinguishable from a slow run and blocks every suite after it (scripts/test-all.sh
// runs them in sequence), which is how a single test burns hours of Actions time. Reaching here means
// every assertion above held; a failure throws and exits non-zero long before this line.
process.exit(0);
