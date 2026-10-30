import assert from 'node:assert';
import crypto from 'node:crypto';
import { db, createCrowdfundProject, pledgeToProject, deleteCrowdfundProject, updateCrowdfundProject, getCrowdfundProject } from './db/db.js';
import {
    initStateEngine, reconcileLedgerFromDb, getBalance, payFromCommons, adminAssignTreasuryOperator, replaceLeadByVote, runLedgerAudit,
    adminSetOperator, adminSetUserStatus, stepDownAsKeeper, adminRevokeTreasuryOperator, proposeLeadSuccession,
    adminPruneUser, purgeMemberSelf, getCommonsBalanceExact, returnUnfundedProjectPledges,
} from './state-engine.js';
import { createScopedDecision, PROJECT_LEADER_STAYS } from './decisions-engine.js';
import { grantNodeRole } from './engine/node-roles.js';
import { CLOSED_ACCOUNT_PLEDGE_MEMO } from './engine/unfunded-pledges.js';

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
const refusal = (f: () => void): string | null => { try { f(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };
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

// ── 9. Only a keeper who may act cancels it: not the keeper left switched off when nobody leads it, nor one of two keepers
// with no lead, nor a stopped lead (review of #2554; its ONLY keeper who may act now can, CF-Q1, part 10) ──
// The cancel is the project's wind-up (docs/the-commons.md: its lead keeper starts one) and can't be undone. Its edit's rule
// falls back to the first keeper when no keeper leads it. That happens when the lead left and no keeper was active with
// operator access to take over (promoteOrPauseAfterLeadLeft paused it), so the fallback named a keeper the engine had just
// passed over. And a keeper whose account is suspended, or whose operator access an admin switched off, acts for no
// enterprise (docs/enterprises-and-operators.md §4.1), as createCrowdfundProject and wind-up already ask.
console.log('\n── Only a keeper who may act cancels it ──');
const lia = makeMember('lia');
const ola = makeMember('ola');
const max = makeMember('max');
const bench = 'proj_' + crypto.randomUUID();
const benchEscrow = `escrow_${bench}`;
createCrowdfundProject(bench, lia, 'Park Bench', 'A bench by the creek', [], 40, null);
pledgeToProject('pledge_' + crypto.randomUUID(), bench, ann, 4, 'For the bench');
const shed = 'proj_' + crypto.randomUUID();
const shedEscrow = `escrow_${shed}`;
createCrowdfundProject(shed, max, 'Tool Shed', 'A shed for the tool library', [], 50, null);
pledgeToProject('pledge_' + crypto.randomUUID(), shed, ben, 6, 'For the shed');
reconcileLedgerFromDb();
const before9 = { ann: balanceOf(ann), ben: balanceOf(ben), sum: sumBalances(), drift: runLedgerAudit().drift };
const stillThere = (id: string, escrow: string, held: number, backer: string, was: number) => near(balanceOf(escrow), held)
    && near(balanceOf(backer), was) && !db.prepare('SELECT 1 FROM transactions WHERE from_pubkey = ?').get(escrow)
    && !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
const benchUntouched = () => stillThere(bench, benchEscrow, 4, ann, before9.ann);
const shedUntouched = () => stillThere(shed, shedEscrow, 6, ben, before9.ben);

// Ola keeps the bench with Lia, then an admin switches Ola's operator access off. Lia steps down: no keeper is left who
// could take the lead, so it pauses with nobody leading it, and the edit's rule names Ola.
adminAssignTreasuryOperator(bench, ola);
adminSetOperator(ola, false);
stepDownAsKeeper(bench, lia);
const benchLeadRow = db.prepare("SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND role = 'lead'").get(bench);
const benchPaused = (db.prepare('SELECT paused FROM members WHERE public_key = ?').get(bench) as { paused: number } | undefined)?.paused;
check(!benchLeadRow && benchPaused === 1, `the bench has no lead and is paused (lead row ${benchLeadRow ? 'there' : 'none'}, paused ${benchPaused})`);
check(getCrowdfundProject(bench)?.creator_pubkey === ola, "and its edit's rule falls back to Ola, its one keeper left");

const olaOffCancel = refusal(() => deleteCrowdfundProject(bench, ola));
check(olaOffCancel !== null && /Unauthorized/.test(olaOffCancel), `Ola, its keeper with operator access switched off, can't cancel it (${olaOffCancel ?? 'it was cancelled'})`);
check(benchUntouched(), `and nothing moves: the escrow still holds 4 (${balanceOf(benchEscrow)}), Ann not refunded, the project still there`);
const liaCancel = refusal(() => deleteCrowdfundProject(bench, lia));
check(liaCancel !== null && /Unauthorized/.test(liaCancel), `Lia, who made it and stepped down, can't cancel it (${liaCancel ?? 'it was cancelled'})`);
check(benchUntouched(), 'and nothing moves');

// Pat joins it as a second keeper while nobody leads it. Then an admin switches Ola's access back on: Ola is a keeper who
// doesn't lead it, one of two, and one of two keepers doesn't wind it up. (Its ONLY keeper may, once they may act: Marty's
// answer CF-Q1, 29 Oct 2026, part 10.)
const pat = makeMember('pat');
adminAssignTreasuryOperator(bench, pat);
adminSetOperator(ola, true);
const olaOnCancel = refusal(() => deleteCrowdfundProject(bench, ola));
check(olaOnCancel !== null && /Unauthorized/.test(olaOnCancel), `Ola, with operator access back on but not its lead, one of its two keepers, can't cancel it (${olaOnCancel ?? 'it was cancelled'})`);
check(benchUntouched(), 'and nothing moves');
const patCancel = refusal(() => deleteCrowdfundProject(bench, pat));
check(patCancel !== null && /Unauthorized/.test(patCancel), `nor can Pat, its other keeper (${patCancel ?? 'it was cancelled'})`);
check(benchUntouched(), 'and nothing moves');

// Nor can they name a lead who would: a keepers' vote for a lead (replace_lead) is refused for a project, and succession
// replaces only a lead it has. With two keepers and no lead, a node admin alone may cancel it (an admin's cancel of a project nobody leads: part
// 10a). (Review of #2599: this part made Ola lead with a direct replaceLeadByVote, past both refusals, a lead the product
// can't make.)
const leadVote = refusal(() => createScopedDecision({
    scopeKind: 'enterprise', scopeId: bench, authorPubkey: pat, title: 'Ola leads the bench', description: 'Ola should lead the bench now',
    effect: 'replace_lead', subject: ola,
}, () => {}));
check(leadVote === PROJECT_LEADER_STAYS, `a keepers' vote to make Ola its lead is refused (${leadVote ?? 'it opened'})`);
const succession = refusal(() => proposeLeadSuccession(bench, pat, ola));
check(succession !== null && /No lead keeper/.test(succession), `and so is succession, with no lead to replace (${succession ?? 'it opened'})`);
check(!db.prepare("SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND role = 'lead'").get(bench) && benchUntouched(),
    'nobody leads it still, and nothing moves');

// Pat steps down, as a keeper who isn't the only one may: Ola is its only keeper, active with operator access on, and
// cancels it (CF-Q1). Ann gets the 4 back.
stepDownAsKeeper(bench, pat);
const olaOnlyCancel = refusal(() => deleteCrowdfundProject(bench, ola));
check(olaOnlyCancel === null, `Ola, its only keeper once Pat steps down, cancels it (${olaOnlyCancel ?? 'cancelled'})`);
check(near(balanceOf(ann), before9.ann + 4) && near(balanceOf(benchEscrow), 0) && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(bench),
    `Ann gets back the 4 (${balanceOf(ann) - before9.ann}), the escrow is empty, the bench is gone`);

// Max makes and leads the shed. An admin switches Max's operator access off: refused, and nothing moves.
check(getCrowdfundProject(shed)?.creator_pubkey === max, 'Max leads the shed');
adminSetOperator(max, false);
const maxOffCancel = refusal(() => deleteCrowdfundProject(shed, max));
check(maxOffCancel !== null && /Unauthorized/.test(maxOffCancel), `Max, its lead with operator access switched off, can't cancel it (${maxOffCancel ?? 'it was cancelled'})`);
check(shedUntouched(), `and nothing moves: the escrow still holds 6 (${balanceOf(shedEscrow)}), Ben not refunded, the shed still there`);
adminSetOperator(max, true);

// Max's account suspended: refused, and nothing moves.
adminSetUserStatus(max, 'disabled');
const maxSuspendedCancel = refusal(() => deleteCrowdfundProject(shed, max));
check(maxSuspendedCancel !== null && /Unauthorized/.test(maxSuspendedCancel), `Max, its lead with the account suspended, can't cancel it (${maxSuspendedCancel ?? 'it was cancelled'})`);
check(shedUntouched(), 'and nothing moves');

// Max active again: cancelled, Ben gets the 6 back, and every Bean is accounted for.
adminSetUserStatus(max, 'active');
const maxCancel = refusal(() => deleteCrowdfundProject(shed, max));
check(maxCancel === null, `Max, its lead and active again, cancels it (${maxCancel ?? 'cancelled'})`);
check(near(balanceOf(ben), before9.ben + 6) && near(balanceOf(shedEscrow), 0) && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(shed),
    `Ben gets back the 6 (${balanceOf(ben) - before9.ben}), the escrow is empty, the shed is gone`);
check(near(sumBalances(), before9.sum), `the node's total is unchanged (${sumBalances()} vs ${before9.sum})`);
reconcileLedgerFromDb();
const after9 = runLedgerAudit();
check(after9.ok && Math.abs(after9.drift - before9.drift) < 0.0001, `the ledger audit holds, its drift unchanged (ok ${after9.ok}, drift ${before9.drift} → ${after9.drift})`);

// ── 10. Who else may cancel it: a node admin, its only keeper when nobody leads it, its maker only if it never had a keeper ──
// Marty's answers, board, 29 Oct 2026 (from the review of #2554). CF-Q1 "Yes, admin or sole keeper": a project with keepers
// and no lead is cancelled by a node admin or its only keeper, the people wind-up allows (isLeadOrSoleKeeperOrAdmin); before,
// nobody could. CF-Q2 "No, removal ends it": a maker an admin removed as its last keeper may not
// cancel it; before, its maker stood in whenever it had no keepers at all. A project that never had a keeper keeps its
// maker's cancel. Each cancel pays every pledge it holds back once and leaves the node's total and the audit's drift as they were.
console.log('\n── Who else may cancel it ──');
const ada = makeMember('ada'); // a node admin
const abe = makeMember('abe'); // a node admin whose account is suspended
const mo = makeMember('mo'); // a moderator
grantNodeRole(ada, 'admin', 'owner:password');
grantNodeRole(abe, 'admin', 'owner:password');
grantNodeRole(mo, 'moderator', 'owner:password');
adminSetUserStatus(abe, 'disabled');
for (const pk of [ann, ben]) payFromCommons(pk, 100, 'More Beans to pledge', { allowDeficit: true });

/** A project its maker makes, with a pledge in from Ann and one from Ben. */
function pledged(maker: string, title: string, a: number, b: number) {
    const id = 'proj_' + crypto.randomUUID();
    createCrowdfundProject(id, maker, title, `${title}, for the valley`, [], 100, null);
    const ids = ['pledge_' + crypto.randomUUID(), 'pledge_' + crypto.randomUUID()];
    pledgeToProject(ids[0], id, ann, a, `For ${title}`);
    pledgeToProject(ids[1], id, ben, b, `For ${title}`);
    return { id, escrow: `escrow_${id}`, held: a + b, a, b, ids };
}
type Pledged = ReturnType<typeof pledged>;
const keepersOf = (id: string) => db.prepare('SELECT member_pubkey, role FROM treasury_operators WHERE treasury_pubkey = ? ORDER BY rowid')
    .all(id) as { member_pubkey: string; role: string }[];
// The column came with this rule: on a server without it, each read says so and is counted, rather than ending the suite.
const leftAt = (id: string): string | null => {
    try {
        return (db.prepare('SELECT keeper_left_at FROM projects WHERE id = ?').get(id) as { keeper_left_at: string | null } | undefined)?.keeper_left_at ?? null;
    } catch {
        return 'no keeper_left_at column';
    }
};
function refusedAndUntouched(p: Pledged, who: string, label: string): void {
    reconcileLedgerFromDb();
    const was = { ann: balanceOf(ann), ben: balanceOf(ben), sum: sumBalances() };
    const why = refusal(() => deleteCrowdfundProject(p.id, who));
    check(why !== null && /Unauthorized/.test(why), `${label} can't cancel it (${why ?? 'it was cancelled'})`);
    check(near(balanceOf(p.escrow), p.held) && near(balanceOf(ann), was.ann) && near(balanceOf(ben), was.ben) && near(sumBalances(), was.sum)
        && !db.prepare('SELECT 1 FROM transactions WHERE from_pubkey = ?').get(p.escrow) && !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(p.id),
        `and nothing moves: the escrow still holds ${p.held} (${balanceOf(p.escrow)}), nobody refunded, the project still there`);
}
function cancelsAndRefundsOnce(p: Pledged, who: string, label: string): void {
    reconcileLedgerFromDb();
    const was = { ann: balanceOf(ann), ben: balanceOf(ben), who: balanceOf(who), sum: sumBalances(), drift: runLedgerAudit().drift };
    const why = refusal(() => deleteCrowdfundProject(p.id, who));
    check(why === null, `${label} cancels it (${why ?? 'cancelled'})`);
    const out = db.prepare('SELECT id, to_pubkey, amount FROM transactions WHERE from_pubkey = ? ORDER BY rowid')
        .all(p.escrow) as { id: string; to_pubkey: string; amount: number }[];
    check(near(balanceOf(ann), was.ann + p.a) && near(balanceOf(ben), was.ben + p.b) && near(balanceOf(who), was.who),
        `Ann gets back her ${p.a} and Ben his ${p.b} (${balanceOf(ann) - was.ann}, ${balanceOf(ben) - was.ben}); the canceller's own balance doesn't move`);
    check(out.length === 2 && out.some((r) => r.id === `refund_${p.ids[0]}` && r.to_pubkey === ann && near(r.amount, p.a))
        && out.some((r) => r.id === `refund_${p.ids[1]}` && r.to_pubkey === ben && near(r.amount, p.b)),
        `one refund row per pledge, each to its backer for its amount (${out.length} rows)`);
    check(near(balanceOf(p.escrow), 0) && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(p.id) && getCrowdfundProject(p.id) === undefined,
        `the escrow is empty (${balanceOf(p.escrow)}) and the project is gone`);
    check(near(sumBalances(), was.sum), `the node's total is unchanged (${sumBalances()} vs ${was.sum})`);
    reconcileLedgerFromDb();
    const audit = runLedgerAudit();
    check(audit.ok && Math.abs(audit.drift - was.drift) < 0.0001, `the ledger audit holds, its drift unchanged (ok ${audit.ok}, drift ${was.drift} → ${audit.drift})`);
    const again = refusal(() => deleteCrowdfundProject(p.id, who));
    check(again !== null && near(balanceOf(ann), was.ann + p.a) && near(balanceOf(ben), was.ben + p.b),
        `a second cancel pays nobody again (${again ?? 'it ran again'})`);
}

// 10a. No lead, one keeper with operator access off: a node admin cancels it. Wes made and led the well, Kai keeps it with
// Wes; an admin switches Kai's access off, and Wes steps down: nobody could take the lead, so it pauses with none.
const wes = makeMember('wes');
const kai = makeMember('kai');
const well = pledged(wes, 'Village Well', 7, 2);
adminAssignTreasuryOperator(well.id, kai);
adminSetOperator(kai, false);
stepDownAsKeeper(well.id, wes);
check(keepersOf(well.id).length === 1 && !keepersOf(well.id).some((k) => k.role === 'lead'),
    `the well has one keeper, Kai, and no lead (${JSON.stringify(keepersOf(well.id).map((k) => k.role))})`);
refusedAndUntouched(well, kai, 'Kai, its only keeper with operator access switched off,');
refusedAndUntouched(well, wes, 'Wes, who made it and stepped down,');
refusedAndUntouched(well, mo, 'Mo, a moderator of the node,');
refusedAndUntouched(well, abe, 'Abe, an admin of the node whose account is suspended,');
refusedAndUntouched(well, cal, 'Cal, a stranger to it,');
cancelsAndRefundsOnce(well, ada, 'Ada, an admin of the node,');

// 10b. No lead, its only keeper who may act cancels it. Kip made and led the kiln, Sol keeps it with Kip and has operator
// access switched off as Kip steps down, so it pauses with no lead. Sol, its only keeper: refused while switched off, and
// while Sol's account is suspended; with both back, Sol cancels it.
const kip = makeMember('kip');
const sol = makeMember('sol');
const kiln = pledged(kip, 'Pottery Kiln', 5, 4);
adminAssignTreasuryOperator(kiln.id, sol);
adminSetOperator(sol, false);
stepDownAsKeeper(kiln.id, kip);
check(keepersOf(kiln.id).length === 1 && keepersOf(kiln.id)[0].member_pubkey === sol && keepersOf(kiln.id)[0].role === 'keeper',
    `the kiln has one keeper, Sol, who doesn't lead it (${JSON.stringify(keepersOf(kiln.id).map((k) => k.role))})`);
refusedAndUntouched(kiln, sol, 'Sol, its only keeper with operator access switched off,');
adminSetOperator(sol, true);
adminSetUserStatus(sol, 'disabled');
refusedAndUntouched(kiln, sol, 'Sol, its only keeper with the account suspended,');
adminSetUserStatus(sol, 'active');
refusedAndUntouched(kiln, kip, 'Kip, who made it and stepped down,');
refusedAndUntouched(kiln, mo, 'Mo, a moderator,');
cancelsAndRefundsOnce(kiln, sol, 'Sol, its only keeper, active with operator access on,');

// 10c. Its maker removed by an admin as its last keeper: removal ends it. Mae makes the mill and is its only keeper; an
// admin removes her. It has no keepers, as a project that never had one has none, but a keeper left it.
const mae = makeMember('mae');
const mill = pledged(mae, 'Flour Mill', 6, 3);
check(leftAt(mill.id) === null, `no keeper has left the mill yet (${leftAt(mill.id)})`);
adminRevokeTreasuryOperator(mill.id, mae);
check(keepersOf(mill.id).length === 0 && leftAt(mill.id) !== null,
    `the mill has no keepers, and its row says when one left (${keepersOf(mill.id).length}, ${leftAt(mill.id)})`);
refusedAndUntouched(mill, mae, 'Mae, who made it and whom an admin removed as its last keeper,');
refusedAndUntouched(mill, mo, 'Mo, a moderator,');
cancelsAndRefundsOnce(mill, ada, 'Ada, an admin, who may cancel it still,');

// 10d. Its maker who stepped down, its last keeper then removed by an admin: no keepers now, but it had them. Dee makes and
// leads the dock, Eli keeps it with her; Dee steps down and Eli takes the lead; an admin removes Eli.
const dee = makeMember('dee');
const eli = makeMember('eli');
const dock = pledged(dee, 'Boat Dock', 4, 1);
adminAssignTreasuryOperator(dock.id, eli);
stepDownAsKeeper(dock.id, dee);
check(keepersOf(dock.id).length === 1 && keepersOf(dock.id)[0].member_pubkey === eli && keepersOf(dock.id)[0].role === 'lead',
    'Eli leads the dock once Dee steps down');
adminRevokeTreasuryOperator(dock.id, eli);
check(keepersOf(dock.id).length === 0, `the dock has no keepers (${keepersOf(dock.id).length})`);
refusedAndUntouched(dock, dee, 'Dee, who made it and stepped down,');
refusedAndUntouched(dock, eli, 'Eli, whom an admin removed as its lead,');
cancelsAndRefundsOnce(dock, ada, 'Ada, an admin,');

// 10e. A project no keeper was ever bound to keeps its maker's cancel. Every way of making a project binds its maker as its
// lead, so this is a projects row from before that (one the projects migration bound nobody to): Bo's barn with its binding
// taken out underneath, by no engine path, so nothing says a keeper left. Bo cancels it, and only while Bo may act.
const bo = makeMember('bo');
const barn = pledged(bo, 'Hay Barn', 3, 3);
db.prepare('DELETE FROM treasury_operators WHERE treasury_pubkey = ?').run(barn.id);
check(keepersOf(barn.id).length === 0 && leftAt(barn.id) === null,
    `the barn has no keepers and none ever left it (${keepersOf(barn.id).length}, ${leftAt(barn.id)})`);
refusedAndUntouched(barn, cal, 'Cal, a stranger to it,');
refusedAndUntouched(barn, mo, 'Mo, a moderator,');
adminSetUserStatus(bo, 'disabled');
refusedAndUntouched(barn, bo, 'Bo, who made it, with the account suspended,');
adminSetUserStatus(bo, 'active');
cancelsAndRefundsOnce(barn, bo, 'Bo, who made it, a project no keeper was ever bound to,');

// 10f. A project with a lead who may act: a node admin may cancel it too, as wind-up allows (isLeadOrSoleKeeperOrAdmin); its
// other keeper may not. Fay makes and leads the fence, Gus keeps it with her.
const fay = makeMember('fay');
const gus = makeMember('gus');
const fence = pledged(fay, 'Paddock Fence', 2, 2);
adminAssignTreasuryOperator(fence.id, gus);
refusedAndUntouched(fence, gus, "Gus, a keeper who doesn't lead it,");
refusedAndUntouched(fence, mo, 'Mo, a moderator,');
cancelsAndRefundsOnce(fence, ada, 'Ada, an admin, over a lead who may act,');

// ── 11. A backer whose account has closed: the cancel sends their share to the Commons, as the timed return does ─────────
// The deciding pass of #2599, measured: Ann's account removed, then the lead's cancel, and her closed account went from 0
// to 7 while the Commons didn't move. A closed account can't be paid here (engine/stranded-pledges.ts isClosedAccount: its
// owner deleted it, the community removed it, or an enterprise wound up), and the return of an unfunded project's pledges
// a week after its end date sends its share to the Commons (engine/unfunded-pledges.ts, A CLOSED ACCOUNT; Marty, board,
// 27 Oct 2026: "To the Commons"). The cancel sends it there the same way, and refunds every other backer as before.
console.log('\n── A backer whose account has closed: the cancel sends their share to the Commons ──');
const commonsRow = () => balanceOf('COMMONS_POOL');
const statusOf = (pk: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as { status: string } | undefined)?.status;
const escrowRows = (escrow: string) => db.prepare('SELECT id, to_pubkey, amount, tax_fee, memo FROM transactions WHERE from_pubkey = ? ORDER BY rowid')
    .all(escrow) as { id: string; to_pubkey: string; amount: number; tax_fee: number | null; memo: string }[];
const lou = makeMember('lou');
const ivy = makeMember('ivy'); // backs 7, then the community removes her
const zoe = makeMember('zoe'); // backs 2, then deletes her own account
const jon = makeMember('jon'); // backs 5, and stays
for (const pk of [ivy, zoe, jon]) payFromCommons(pk, 50, 'Beans to pledge', { allowDeficit: true });
const orchard = 'proj_' + crypto.randomUUID();
const orchardEscrow = `escrow_${orchard}`;
createCrowdfundProject(orchard, lou, 'Village Orchard', 'Fruit trees on the common', [], 100, null);
const jonPledge = 'pledge_' + crypto.randomUUID();
pledgeToProject('pledge_' + crypto.randomUUID(), orchard, ivy, 4, 'For the orchard');
pledgeToProject(jonPledge, orchard, jon, 5, 'For the orchard');
pledgeToProject('pledge_' + crypto.randomUUID(), orchard, ivy, 3, 'For the orchard');
pledgeToProject('pledge_' + crypto.randomUUID(), orchard, zoe, 2, 'For the orchard');
check(near(balanceOf(orchardEscrow), 14), `the orchard's escrow holds the 14 pledged (${balanceOf(orchardEscrow)})`);
const ivyRemoved = refusal(() => adminPruneUser(ivy, ada));
const zoeDeleted = purgeMemberSelf(zoe);
check(ivyRemoved === null && zoeDeleted.ok && statusOf(ivy) === 'pruned' && statusOf(zoe) === 'pruned' && near(balanceOf(ivy), 0) && near(balanceOf(zoe), 0),
    `Ada removes Ivy and Zoe deletes her own account: both closed, both at 0 (${ivyRemoved ?? statusOf(ivy)}, ${zoeDeleted.message}, ${balanceOf(ivy)}, ${balanceOf(zoe)})`);
reconcileLedgerFromDb();
const before11 = { jon: balanceOf(jon), lou: balanceOf(lou), commons: getCommonsBalanceExact(), sum: sumBalances(), drift: runLedgerAudit().drift };
const louCancel = refusal(() => deleteCrowdfundProject(orchard, lou));
check(louCancel === null, `Lou, its lead, cancels it (${louCancel ?? 'cancelled'})`);
check(near(balanceOf(ivy), 0) && near(balanceOf(zoe), 0), `Ivy's and Zoe's closed accounts stay at 0 (${balanceOf(ivy)}, ${balanceOf(zoe)})`);
check(near(getCommonsBalanceExact(), before11.commons + 9) && near(commonsRow(), getCommonsBalanceExact()),
    `the Commons gains Ivy's 7 and Zoe's 2 (${getCommonsBalanceExact() - before11.commons}), and its row says so (${commonsRow()})`);
check(near(balanceOf(jon), before11.jon + 5) && near(balanceOf(lou), before11.lou), `Jon gets back his 5 (${balanceOf(jon) - before11.jon}); Lou's own balance doesn't move`);
const orchardOut = escrowRows(orchardEscrow);
const orchardToCommons = orchardOut.filter((r) => r.to_pubkey === 'COMMONS_POOL');
check(orchardOut.length === 3 && orchardOut.filter((r) => r.id === `refund_${jonPledge}` && r.to_pubkey === jon && near(r.amount, 5)).length === 1
    && orchardToCommons.length === 2 && orchardToCommons.some((r) => near(r.amount, 7)) && orchardToCommons.some((r) => near(r.amount, 2))
    && !orchardOut.some((r) => r.to_pubkey === ivy || r.to_pubkey === zoe),
    `Jon's refund row, and one row each to the Commons, Ivy's 7 and Zoe's 2; none to a closed account (${JSON.stringify(orchardOut.map((r) => [r.to_pubkey.slice(0, 8), r.amount]))})`);
check(orchardToCommons.length === 2 && orchardToCommons.every((r) => r.memo === CLOSED_ACCOUNT_PLEDGE_MEMO && !r.tax_fee),
    `each fee-free, in the timed return's words, which name nobody ("${orchardToCommons[0]?.memo}")`);
check(near(balanceOf(orchardEscrow), 0) && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(orchard),
    `the escrow is empty (${balanceOf(orchardEscrow)}) and the orchard is gone`);
check(near(sumBalances(), before11.sum), `the node's total is unchanged (${sumBalances()} vs ${before11.sum})`);
check(near(getBalance(ivy).balance, 0) && near(getBalance(jon).balance, before11.jon + 5),
    `and the in-memory ledger says the same: Ivy ${getBalance(ivy).balance}, Jon +${getBalance(jon).balance - before11.jon}`);
reconcileLedgerFromDb();
const audit11 = runLedgerAudit();
check(audit11.ok && Math.abs(audit11.drift - before11.drift) < 0.0001, `the ledger audit holds, its drift unchanged (ok ${audit11.ok}, drift ${before11.drift} → ${audit11.drift})`);
const again11 = refusal(() => deleteCrowdfundProject(orchard, lou));
check(again11 !== null && near(getCommonsBalanceExact(), before11.commons + 9) && near(balanceOf(jon), before11.jon + 5),
    `a second cancel pays nobody again (${again11 ?? 'it ran again'})`);

// A wound-up enterprise as a backer ('completed'): its account is closed too, so its pledge goes to the Commons.
const coop = makeMember('coop');
payFromCommons(coop, 10, 'Beans to pledge', { allowDeficit: true });
const kiosk = 'proj_' + crypto.randomUUID();
createCrowdfundProject(kiosk, lou, 'Corner Kiosk', 'A kiosk for the market', [], 100, null);
pledgeToProject('pledge_' + crypto.randomUUID(), kiosk, jon, 1, 'For the kiosk');
pledgeToProject('pledge_' + crypto.randomUUID(), kiosk, coop, 3, 'For the kiosk');
db.prepare("UPDATE members SET status = 'completed' WHERE public_key = ?").run(coop);
reconcileLedgerFromDb();
const kioskBefore = { jon: balanceOf(jon), coop: balanceOf(coop), commons: getCommonsBalanceExact(), sum: sumBalances() };
const kioskCancel = refusal(() => deleteCrowdfundProject(kiosk, lou));
check(kioskCancel === null && near(balanceOf(jon), kioskBefore.jon + 1) && near(balanceOf(coop), kioskBefore.coop)
    && near(getCommonsBalanceExact(), kioskBefore.commons + 3) && near(sumBalances(), kioskBefore.sum),
    `a wound-up enterprise's 3 goes to the Commons (+${getCommonsBalanceExact() - kioskBefore.commons}), not to it (+${balanceOf(coop) - kioskBefore.coop}), and Jon gets his 1 (+${balanceOf(jon) - kioskBefore.jon}) (${kioskCancel ?? 'cancelled'})`);

// A cancel that fails after a closed account's share has gone to the Commons puts every Bean back, in memory too: its moves
// run in one conserving transaction (state-engine.ts conservingTransaction). Its enterprise's account holds dust its guard
// lets by (0.00005, under the 0.0001 it refuses) and the delete's own check doesn't, so the delete throws after the move.
const ned = makeMember('ned');
payFromCommons(ned, 20, 'Beans to pledge', { allowDeficit: true });
const pantry = 'proj_' + crypto.randomUUID();
const pantryEscrow = `escrow_${pantry}`;
createCrowdfundProject(pantry, lou, 'Food Pantry', 'Shelves for the pantry', [], 100, null);
pledgeToProject('pledge_' + crypto.randomUUID(), pantry, ned, 6, 'For the pantry');
pledgeToProject('pledge_' + crypto.randomUUID(), pantry, jon, 2, 'For the pantry');
const nedRemoved = refusal(() => adminPruneUser(ned, ada));
// The dust comes from Jon, so the node's total doesn't move.
function moveDust(amount: number): void {
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(pantry, nowEpoch);
    db.prepare('UPDATE accounts SET balance = balance + ? WHERE public_key = ?').run(amount, pantry);
    db.prepare('UPDATE accounts SET balance = balance - ? WHERE public_key = ?').run(amount, jon);
    reconcileLedgerFromDb();
}
moveDust(0.00005);
const pantryBefore = { jon: balanceOf(jon), commons: getCommonsBalanceExact(), commonsRow: commonsRow(), sum: sumBalances() };
const pantryFails = refusal(() => deleteCrowdfundProject(pantry, lou));
check(nedRemoved === null && pantryFails !== null && /enterprise account with non-zero balance/.test(pantryFails), `the pantry's cancel fails after its first move (${nedRemoved ?? pantryFails ?? 'it was cancelled'})`);
check(near(getCommonsBalanceExact(), pantryBefore.commons) && near(commonsRow(), pantryBefore.commonsRow) && near(balanceOf(ned), 0)
    && near(balanceOf(jon), pantryBefore.jon) && near(balanceOf(pantryEscrow), 8) && escrowRows(pantryEscrow).length === 0
    && !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pantry) && near(sumBalances(), pantryBefore.sum),
    `and nothing moved: the Commons as it was in memory (+${getCommonsBalanceExact() - pantryBefore.commons}) and in its row, the escrow still 8 (${balanceOf(pantryEscrow)}), the pantry still there`);
moveDust(-0.00005);
const pantryCancel = refusal(() => deleteCrowdfundProject(pantry, lou));
check(pantryCancel === null && near(getCommonsBalanceExact(), pantryBefore.commons + 6) && near(balanceOf(ned), 0)
    && near(balanceOf(jon), pantryBefore.jon + 0.00005 + 2) && near(balanceOf(pantryEscrow), 0),
    `with the dust gone it cancels: Ned's 6 to the Commons (+${getCommonsBalanceExact() - pantryBefore.commons}), Jon's 2 back (${pantryCancel ?? 'cancelled'})`);

// The same closed account's share by the timed return, on a twin project whose end date is a week gone: both paths send it
// through one helper (engine/unfunded-pledges.ts), so they write the same row to the Commons.
const DAY = 24 * 60 * 60 * 1000;
const una = makeMember('una');
payFromCommons(una, 20, 'Beans to pledge', { allowDeficit: true });
const twinEnds = new Date(Date.now() + DAY).toISOString();
const twin = 'proj_' + crypto.randomUUID();
createCrowdfundProject(twin, lou, 'Twin Orchard', 'Fruit trees by the school', [], 100, twinEnds);
pledgeToProject('pledge_' + crypto.randomUUID(), twin, una, 7, 'For the twin orchard');
pledgeToProject('pledge_' + crypto.randomUUID(), twin, jon, 5, 'For the twin orchard');
const unaRemoved = refusal(() => adminPruneUser(una, ada));
const twinBefore = { jon: balanceOf(jon), commons: getCommonsBalanceExact(), sum: sumBalances() };
const twinReturn = returnUnfundedProjectPledges(Date.parse(twinEnds) + 8 * DAY);
const twinToCommons = escrowRows(`escrow_${twin}`).filter((r) => r.to_pubkey === 'COMMONS_POOL');
const ivyRow = orchardToCommons.find((r) => near(r.amount, 7));
check(unaRemoved === null && twinReturn.returned === 1 && near(balanceOf(jon), twinBefore.jon + 5) && near(balanceOf(una), 0)
    && near(getCommonsBalanceExact(), twinBefore.commons + 7) && near(sumBalances(), twinBefore.sum),
    `the timed return does the same: Una's 7 to the Commons (+${getCommonsBalanceExact() - twinBefore.commons}), Jon's 5 back (${unaRemoved ?? JSON.stringify(twinReturn)})`);
check(twinToCommons.length === 1 && !!ivyRow && twinToCommons[0].memo === ivyRow.memo && near(twinToCommons[0].amount, ivyRow.amount)
    && !twinToCommons[0].tax_fee === !ivyRow.tax_fee,
    `and its row to the Commons is the cancel's: the same words, amount and fee (${JSON.stringify(twinToCommons.map((r) => [r.amount, r.memo]))} vs ${JSON.stringify(ivyRow ? [ivyRow.amount, ivyRow.memo] : null)})`);

console.log(`\n${run - failed}/${run} checks passed`);

// Exit explicitly. This suite leaves the engine's timers and handles open, so returning normally
// keeps the event loop alive and the process never terminates — it prints a pass and then hangs.
// In CI that is indistinguishable from a slow run and blocks every suite after it (scripts/test-all.sh
// runs them in sequence), which is how a single test burns hours of Actions time. Reaching here means
// every node:assert above held (a failure throws and exits non-zero long before this line); the counted
// checks of parts 8 and 9 decide the rest.
process.exit(failed === 0 ? 0 : 1);
