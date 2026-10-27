import assert from 'node:assert';
import crypto from 'node:crypto';
import { db, createCrowdfundProject, pledgeToProject, deleteCrowdfundProject, updateCrowdfundProject, getCrowdfundProject } from './db/db.js';
import {
    initStateEngine, reconcileLedgerFromDb, getBalance, payFromCommons, adminAssignTreasuryOperator, replaceLeadByVote, runLedgerAudit,
} from './state-engine.js';

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

// 3b. A member who neither made nor leads it can't cancel it: refused, and nothing moves.
const stranger = 'stranger_pubkey_' + crypto.randomUUID();
db.prepare(`INSERT INTO members (public_key, callsign) VALUES (?, ?)`).run(stranger, 'stranger_' + crypto.randomUUID().slice(0, 8));
assert.throws(() => deleteCrowdfundProject(projectId, stranger), /Unauthorized/, "A stranger's cancel is refused");
reconcileLedgerFromDb();
assert.strictEqual(getBalance(backer).balance, INITIAL_BALANCE - PLEDGE_AMOUNT, "The backer's pledge is still held after the stranger's cancel");
assert.strictEqual(getBalance(escrowPubkey).balance, PLEDGE_AMOUNT, "The escrow still holds the pledge after the stranger's cancel");
assert(db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(projectId), "The project is still there after the stranger's cancel");

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

// ── 8. After a lead change the cancel is the new lead's, not the maker's (review of #2525) ──────────────────────────────
// A project is an enterprise, and its lead can change after it is made: a keepers' vote (state-engine.ts replaceLeadByVote),
// or a lead who steps down or closes their account and a keeper promoted in their place (promoteOrPauseAfterLeadLeft). The
// projects row's creator_pubkey keeps its maker. The cancel asked that column, so the maker who no longer led it could
// still cancel it, refunding every backer and deleting it, and the new lead could not. Its edit already asked its lead.
// Every check runs and is counted, so a tree without the fix shows each one it fails.
console.log('\n── After a lead change: the cancel is the new lead\'s ──');
let run = 0, failed = 0;
function check(cond: boolean, msg: string): void {
    run++;
    if (cond) console.log(`✓ ${msg}`); else { failed++; console.error(`✗ FAIL: ${msg}`); }
}
const refusal = (f: () => void): string | null => { try { f(); return null; } catch (e: any) { return String(e?.message ?? e); } };
const balanceOf = (key: string): number =>
    (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(key) as { balance: number } | undefined)?.balance ?? 0;
const sumBalances = (): number => (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
function makeMember(name: string): string {
    const pk = `${name}_pubkey_` + crypto.randomUUID();
    db.prepare(`INSERT INTO members (public_key, callsign) VALUES (?, ?)`).run(pk, `${name}_` + crypto.randomUUID().slice(0, 8));
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)`).run(pk, nowEpoch);
    return pk;
}

const uma = makeMember('uma');
const kim = makeMember('kim');
const ann = makeMember('ann');
const ben = makeMember('ben');
const cal = makeMember('cal');
// Beans to pledge, from the Commons: conserved, so the audit's sum holds throughout.
for (const pk of [ann, ben]) payFromCommons(pk, 200, 'Beans to pledge', { allowDeficit: true });

const gate = 'proj_' + crypto.randomUUID();
const gateEscrow = `escrow_${gate}`;
createCrowdfundProject(gate, uma, 'Garden Gate', 'A gate for the community garden', [], 60, null);
const gatePledges = [
    { id: 'pledge_' + crypto.randomUUID(), from: ann, amount: 10 },
    { id: 'pledge_' + crypto.randomUUID(), from: ben, amount: 5 },
    { id: 'pledge_' + crypto.randomUUID(), from: ann, amount: 3 },
];
for (const p of gatePledges) pledgeToProject(p.id, gate, p.from, p.amount, 'For the gate');
check(near(balanceOf(gateEscrow), 18), `the gate's escrow holds the 18 Beans pledged (${balanceOf(gateEscrow)})`);

// Kim joins as a keeper, then the keepers vote Kim lead. Uma stays a keeper, and the projects row still names her its maker.
adminAssignTreasuryOperator(gate, kim);
replaceLeadByVote(gate, kim);
check(getCrowdfundProject(gate)?.creator_pubkey === kim, `Kim leads the project now (${getCrowdfundProject(gate)?.creator_pubkey?.slice(0, 12)})`);
const madeBy = (db.prepare('SELECT creator_pubkey FROM projects WHERE id = ?').get(gate) as { creator_pubkey: string } | undefined)?.creator_pubkey;
check(madeBy === uma, 'its projects row still names Uma, who made it');

reconcileLedgerFromDb();
const before = { ann: balanceOf(ann), ben: balanceOf(ben), uma: balanceOf(uma), kim: balanceOf(kim), sum: sumBalances(), drift: runLedgerAudit().drift };
const outRows = () => db.prepare('SELECT id, to_pubkey, amount FROM transactions WHERE from_pubkey = ? ORDER BY rowid').all(gateEscrow) as { id: string; to_pubkey: string; amount: number }[];
const untouched = () => near(balanceOf(gateEscrow), 18) && near(balanceOf(ann), before.ann) && near(balanceOf(ben), before.ben)
    && outRows().length === 0 && !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(gate);

// Uma, its maker and still a keeper, but no longer its lead: refused, and nothing moves.
const umaCancel = refusal(() => deleteCrowdfundProject(gate, uma));
check(umaCancel !== null && /Unauthorized/.test(umaCancel), `Uma, who made it but no longer leads it, can't cancel it (${umaCancel ?? 'it was cancelled'})`);
check(untouched(), `and nothing moves: the escrow still holds 18 (${balanceOf(gateEscrow)}), no backer refunded, the project still there`);

// Cal, a member who neither made nor leads it: refused.
const calCancel = refusal(() => deleteCrowdfundProject(gate, cal));
check(calCancel !== null && /Unauthorized/.test(calCancel), `Cal, a stranger to it, can't cancel it (${calCancel ?? 'it was cancelled'})`);
check(untouched(), 'and nothing moves');

// Its edit asks the same rule (db.ts leadsProject): Uma's refused, Kim's made.
const umaEdit = refusal(() => updateCrowdfundProject(gate, uma, 'Garden Gate', 'A gate, says its maker', [], 60));
check(umaEdit !== null && /Unauthorized/.test(umaEdit), `Uma can't edit it either (${umaEdit ?? 'it was edited'})`);
const kimEdit = refusal(() => updateCrowdfundProject(gate, kim, 'Garden Gate', 'A gate, and a path to it', [], 60));
const purpose = (db.prepare('SELECT purpose FROM members WHERE public_key = ?').get(gate) as { purpose: string } | undefined)?.purpose;
check(kimEdit === null && purpose === 'A gate, and a path to it', `Kim, its lead, edits it (${kimEdit ?? purpose})`);

// Kim, its lead: cancelled, every pledge it holds refunded once, the escrow empty, every Bean accounted for.
const kimCancel = refusal(() => deleteCrowdfundProject(gate, kim));
check(kimCancel === null, `Kim, its lead, cancels it (${kimCancel ?? 'cancelled'})`);
check(near(balanceOf(ann), before.ann + 13), `Ann gets back her 10 and her 3 (${balanceOf(ann) - before.ann})`);
check(near(balanceOf(ben), before.ben + 5), `Ben gets back his 5 (${balanceOf(ben) - before.ben})`);
check(near(balanceOf(uma), before.uma) && near(balanceOf(kim), before.kim), "Uma's and Kim's own balances don't move");
const refunds = outRows();
check(refunds.length === gatePledges.length && gatePledges.every((p) => refunds.filter((r) => r.id === `refund_${p.id}` && r.to_pubkey === p.from && near(r.amount, p.amount)).length === 1),
    `one refund row per pledge, each to its backer for its amount (${refunds.length} rows)`);
check(near(balanceOf(gateEscrow), 0), `the escrow is empty (${balanceOf(gateEscrow)})`);
check(!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(gate) && getCrowdfundProject(gate) === undefined, 'the project is gone');
check(near(sumBalances(), before.sum), `the node's total is unchanged (${sumBalances()} vs ${before.sum})`);
reconcileLedgerFromDb();
check(near(getBalance(ann).balance, before.ann + 13), 'and the in-memory ledger agrees with the rows');
const after = runLedgerAudit();
check(after.ok && Math.abs(after.drift - before.drift) < 0.0001, `the ledger audit holds, its drift unchanged (ok ${after.ok}, drift ${before.drift} → ${after.drift})`);

// Once: Kim's second cancel finds nothing, and pays nobody twice.
const again = refusal(() => deleteCrowdfundProject(gate, kim));
check(again !== null && near(balanceOf(ann), before.ann + 13) && outRows().length === gatePledges.length, `a second cancel pays nobody again (${again ?? 'it ran again'})`);

console.log(`\n${run - failed}/${run} checks passed`);

// Exit explicitly. This suite leaves the engine's timers and handles open, so returning normally
// keeps the event loop alive and the process never terminates — it prints a pass and then hangs.
// In CI that is indistinguishable from a slow run and blocks every suite after it (scripts/test-all.sh
// runs them in sequence), which is how a single test burns hours of Actions time. Reaching here means
// every node:assert above held (a failure throws and exits non-zero long before this line); part 8's
// counted checks decide the rest.
process.exit(failed === 0 ? 0 : 1);
