/**
 * #138 regression — a balance may never RISE with its demurrage window left open.
 *
 * THE RULE. Demurrage is `principal × time × rate`, so an interval cannot be carried across a change of
 * principal. If an account's stored `last_demurrage_epoch` is stale and its balance then increases without
 * the window being closed, the account's next read charges the WHOLE old interval against the new, larger
 * balance. Someone who has not traded for two months is taxed on money their community just handed them.
 *
 * `ledger.applyDecay` closes the window on every branch, and `transfer()` / `moveToCommons()` /
 * `payFromCommons()` persist `last_demurrage_epoch` alongside the balance — so those paths are safe. Three
 * host paths were not, and each raises a balance a different way:
 *
 *   1. the crowdfund escrow sweep to a project creator   (db.ts, raw `balance = balance + ?`)
 *   2. the refund to every backer of a deleted project   (db.ts, same shape, widest blast radius)
 *   3. the commons voting-round grant to a proposer      (state-engine.ts, an UPSERT that omitted the
 *      column on DO UPDATE and wrote a literal epoch 0 — i.e. 1970 — on INSERT)
 *
 * HOW THIS MEASURES IT. Every case is scored against a CONTROL account seeded identically and settled the
 * ordinary way, so "what should this have cost?" is established by construction rather than by re-deriving
 * the bracket formula here — a test that recomputed the rates would agree with a broken implementation.
 *
 * Mind the tax-free Green Zone: the first 200 beans decay at 0.0%/mo, so nothing below 200 can ever decay
 * and a fixture under that is unfalsifiable. Every seeded balance here is above it.
 *
 * PRE-EMPTIVE, NOT A REPAIR. All 9 node snapshots were checked: zero crowdfund pledges, zero commons
 * grants, and zero `demurrage_` rows anywhere — every live account is inside the Green Zone, so nothing has
 * ever decayed and none of these three paths has fired. This becomes real the first time an account crosses
 * 200 beans, which is why it is worth pinning now rather than after.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-demurrage-window.ts
 */
import crypto from 'node:crypto';
import {
    initStateEngine, getBalance, reconcileLedgerFromDb, getCommonsBalanceExact,
    createProject, createVotingRound, closeVotingRound,
} from './state-engine.js';
import { setCommonsBalance } from '@beanpool/core';
import { db, createCrowdfundProject, pledgeToProject, deleteCrowdfundProject } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const EPOCH_MS = 24 * 60 * 60 * 1000;   // one epoch = one day, matching LedgerManager
const nowEpoch = () => Math.floor(Date.now() / EPOCH_MS);

/**
 * Two accounts holding the same balance for the same interval owe the same demurrage, so agreement with the
 * control is exact bar float noise. 0.05 beans is 2.5% of the ~2 the control charges and 0.02% of the ~223
 * the bug charged — it cannot confuse the two. It also absorbs the one-day shift if the suite happens to
 * straddle a UTC midnight; the row-level epoch assertions are immune to that either way.
 */
const SAME_CHARGE = 0.05;

const STALE_DAYS = 60;
const OPENING = 300;        // 100 beans above the Green Zone → a small but real, recordable decay
const PAYOUT = 5_000;       // large enough that taxing it retrospectively is unmistakable
/**
 * Inside the tax-free Green Zone, so however long it sits it owes NOTHING and queues no decay event. That is
 * the case a settlement built on `persistDecayEvents()` alone cannot reach — it returns early on an empty
 * queue, leaving the stale epoch in the row for the incoming credit to be taxed against. Nearly every real
 * member is here today, so it is the most likely shape of the bug, not an edge case.
 */
const GREEN_ZONE_HOLDING = 199;
/**
 * More than an unsettled `OPENING + PAYOUT` row can honestly afford, less than the row says. 5,300 held for
 * 60 days owes ~223.40, so the true balance is ~5,076.60 and this sits in the gap — the only band in which a
 * pledge's affordability check can be caught reading a pre-decay row.
 */
const PLEDGE_OVER_SETTLED = 5_200;
/** Small enough that two backers each keep a decayable OPENING after pledging (path 2b). */
const PLEDGE_SMALL = 100;
/** Matched by the temporary abort trigger in path 3d, via the memo the grant writes. */
const DOOMED_GRANT = 'Doomed grant';

function seedMember(pk: string, balance: number, staleDays: number): void {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(pk, pk.slice(0, 10));
    db.prepare(`
        INSERT INTO accounts (public_key, balance, last_demurrage_epoch)
        VALUES (?, ?, ?)
        ON CONFLICT(public_key) DO UPDATE SET balance=excluded.balance, last_demurrage_epoch=excluded.last_demurrage_epoch
    `).run(pk, balance, nowEpoch() - staleDays);
}

const row = (pk: string) =>
    db.prepare(`SELECT balance, last_demurrage_epoch AS epoch FROM accounts WHERE public_key=?`).get(pk) as
        { balance: number; epoch: number } | undefined;

/**
 * The whole ledger as one number. Every account row EXCEPT the COMMONS_POOL shadow, plus the live global —
 * the pool row is only a persisted copy of `COMMONS_BALANCE`, so counting both double-counts the pot.
 * Demurrage moves value between an account and the Commons, so this figure must not move at all.
 */
const nodeTotal = (): number => {
    const s = (db.prepare(`SELECT COALESCE(SUM(balance),0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'`)
        .get() as { s: number }).s;
    return Math.round((s + getCommonsBalanceExact()) * 10000) / 10000;
};

const id = (prefix: string) => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;

async function main() {
    console.log('Running #138 demurrage-window regression checks...\n');
    initStateEngine();   // registers both hooks: reconcileLedgerFromDb and settleDemurrage

    // ── Accounts, all seeded up front so conservation has a single stable baseline ──────────────────
    const control = id('control');      // settled the ordinary way; defines the fair charge
    const creator = id('creator');      // path 1 — receives the escrow sweep
    const quiet = id('quiet');          // path 1b — same, but inside the Green Zone: settling collects NOTHING
    const backer = id('backer');        // path 1/1b — funds both, seeded fresh so it adds no decay noise
    const spender = id('spender');      // path 1c — tries to pledge beans demurrage has already taken
    const refundee = id('refundee');    // path 2 — pledges, then gets refunded
    const emptyHanded = id('emptyhand'); // path 2 — creator of the deleted project, never paid
    const proposer = id('proposer');    // path 3 — granted, with an existing accounts row
    const quietProposer = id('quietprop'); // path 3c — the same, from inside the Green Zone
    const rowless = id('rowless');      // path 3b — granted, with NO accounts row (the epoch-0 insert)
    const backerOne = id('backerone');   // path 2b — two backers of one project, settled as one batch
    const backerTwo = id('backertwo');
    const failProposer = id('failprop'); // path 3d — a grant whose transaction aborts part-way
    const admin = id('admin');          // invited_by NULL → eligible round creator

    seedMember(control, OPENING, STALE_DAYS);
    seedMember(creator, OPENING, STALE_DAYS);
    seedMember(quiet, GREEN_ZONE_HOLDING, STALE_DAYS);
    seedMember(backer, PAYOUT * 2, 0);   // funds both path 1 and path 1b
    seedMember(spender, OPENING + PAYOUT, STALE_DAYS);
    // Fresh: path 2 ages this account itself, at the point in the story where the ageing belongs.
    seedMember(refundee, OPENING + PAYOUT, 0);
    seedMember(backerOne, OPENING + PLEDGE_SMALL, 0);
    seedMember(backerTwo, OPENING + PLEDGE_SMALL, 0);
    seedMember(emptyHanded, 0, 0);
    seedMember(proposer, OPENING, STALE_DAYS);
    seedMember(quietProposer, GREEN_ZONE_HOLDING, STALE_DAYS);
    // Stale, so the failed grant also has real demurrage in flight to unwind.
    seedMember(failProposer, OPENING, STALE_DAYS);
    // Seeded EMPTY on purpose. Path 3b deletes this account's row to reach the UPSERT's INSERT arm, and
    // deleting a row that holds beans destroys them — the conservation check below caught exactly that, off
    // by the 300 an earlier version of this fixture seeded here. The assertion was right and the fixture was
    // lying. Nothing is lost for the test either: the INSERT arm is about the epoch written alongside a
    // NON-ZERO granted balance, and the grant supplies that.
    seedMember(rowless, 0, 0);
    seedMember(admin, 0, 0);

    setCommonsBalance(50_000);          // must cover both grants; deductFromCommons refuses otherwise
    reconcileLedgerFromDb();            // pull the seeded rows in, as boot would
    const baseline = nodeTotal();

    // ── The control: what this interval genuinely costs ────────────────────────────────────────────
    const fairCharge = OPENING - getBalance(control).balance;
    assert(fairCharge > 0.5,
        `control: ${OPENING} beans held ${STALE_DAYS} days genuinely owes ${fairCharge.toFixed(4)} — a real, `
        + 'recordable decay, so every comparison below can actually fail');

    // ── Path 1: crowdfund escrow sweep to the creator ──────────────────────────────────────────────
    const funded = id('proj');
    createCrowdfundProject(funded, creator, 'Fully funded', 'sweeps to the creator', [], PAYOUT, null);
    pledgeToProject(crypto.randomUUID(), funded, backer, PAYOUT, 'pledge');

    const creatorRow = row(creator)!;
    assert(creatorRow.epoch === nowEpoch(),
        'path 1: the escrow sweep left the creator\'s demurrage window CLOSED in the row');
    // Row-level, so this holds whatever a later read does — the durable pair is the thing that was wrong.
    assert(Math.abs((OPENING + PAYOUT - creatorRow.balance) - fairCharge) < SAME_CHARGE,
        `path 1: the stored balance reflects only the fair ${fairCharge.toFixed(4)}, not a charge against the payout`);

    reconcileLedgerFromDb();   // what the balance-mutation hook, or any restart, does
    const creatorCharge = OPENING + PAYOUT - getBalance(creator).balance;
    assert(Math.abs(creatorCharge - fairCharge) < SAME_CHARGE,
        `path 1: reading the creator after the payout costs ${creatorCharge.toFixed(4)}, matching the control `
        + `(the open window charged the ${STALE_DAYS} days against all ${OPENING + PAYOUT})`);

    // ── Path 1b: the same sweep, to a creator inside the Green Zone ─────────────────────────────────
    const quietProject = id('proj');
    createCrowdfundProject(quietProject, quiet, 'Quiet creator', 'owes nothing, must still be closed', [], PAYOUT, null);
    pledgeToProject(crypto.randomUUID(), quietProject, backer, PAYOUT, 'pledge');

    const quietRow = row(quiet)!;
    assert(quietRow.epoch === nowEpoch(),
        `path 1b: a creator holding ${GREEN_ZONE_HOLDING} owes nothing and queues no decay event, and the `
        + 'window is STILL closed in the row — persisting only when there is an event to persist would leave '
        + 'the commonest case broken');
    assert(Math.abs(quietRow.balance - (GREEN_ZONE_HOLDING + PAYOUT)) < 1e-9,
        `path 1b: and nothing was collected on the way — ${GREEN_ZONE_HOLDING} + ${PAYOUT} arrives intact`);
    reconcileLedgerFromDb();
    assert(Math.abs(getBalance(quiet).balance - (GREEN_ZONE_HOLDING + PAYOUT)) < 1e-9,
        'path 1b: and the next read charges nothing either — the payout pushed them out of the Green Zone, so '
        + 'a carried window would have taxed a balance that had never owed a bean');

    // ── Path 1c: the payer side — a pledge may not be afforded out of beans demurrage has taken ─────
    // The affordability check is a raw `SELECT balance`, so against an unsettled row it reads the PRE-decay
    // figure. This account holds 5,300 on a 60-day window and genuinely owes ~223.40, leaving ~5,076.60 — so a
    // 5,200 pledge is affordable on the row and unaffordable in truth. Unsettled it went through, and the
    // member was charged for the same beans again on their next read.
    const overspend = PLEDGE_OVER_SETTLED;
    const spendProject = id('proj');
    createCrowdfundProject(spendProject, emptyHanded, 'Overspend', 'must be refused', [], PAYOUT * 20, null);
    let refusal: string | null = null;
    try { pledgeToProject(crypto.randomUUID(), spendProject, spender, overspend, 'pledge'); }
    catch (e: any) { refusal = e?.message || String(e); }

    const spenderRow = row(spender)!;
    assert(refusal === 'Insufficient balance for pledge',
        `path 1c: a ${overspend} pledge against a settled balance of ${spenderRow.balance.toFixed(2)} is REFUSED `
        + `— the row said ${OPENING + PAYOUT}, which is the pre-decay figure (got: ${refusal ?? 'no error'})`);
    assert(spenderRow.epoch === nowEpoch() && spenderRow.balance < overspend,
        'path 1c: and the settlement is durable even though the pledge was refused — settling runs before the '
        + 'affordability read and outside the pledge transaction, so the refusal does not undo it');

    // ── Path 2: refund to a backer of a deleted project ────────────────────────────────────────────
    // Goal far above the pledge so the sweep does NOT fire and the value stays parked in escrow.
    const doomed = id('proj');
    createCrowdfundProject(doomed, emptyHanded, 'Abandoned', 'refunds its backers', [], PAYOUT * 20, null);
    pledgeToProject(crypto.randomUUID(), doomed, refundee, PAYOUT, 'pledge');

    // TIME PASSES between the pledge and the project being abandoned — which is the whole scenario, and the
    // fixture has to say so explicitly now that pledging settles the backer as well as the creator (review
    // finding). Without this the refundee's window would be closed by their own pledge and the refund would
    // have nothing to land on. Epochs are whole days, so the only way to age an account inside one process is
    // to write the row back.
    db.prepare(`UPDATE accounts SET last_demurrage_epoch=? WHERE public_key=?`).run(nowEpoch() - STALE_DAYS, refundee);
    reconcileLedgerFromDb();

    const beforeRefund = row(refundee)!;
    assert(Math.abs(beforeRefund.balance - OPENING) < 1e-9 && beforeRefund.epoch === nowEpoch() - STALE_DAYS,
        `path 2 setup: the backer sits on ${OPENING} with a ${STALE_DAYS}-day window open when the project is `
        + 'abandoned — pledged long ago, refunded today');

    // SEPARATE PRE-EXISTING BUG, found while writing this (#139): deleting a project that has pledges ALWAYS
    // fails. `transactions.project_id REFERENCES projects(id)` is added by ALTER with the default
    // ON DELETE NO ACTION, so `DELETE FROM projects` aborts on its own pledge rows and the whole refund is
    // rolled back — the backers are never paid. That is a product decision (what becomes of a deleted
    // project's money trail), so it is filed rather than folded in here.
    //
    // The assertions below therefore hold in BOTH worlds — refund blocked, or refund landed once #139 is
    // fixed — instead of pinning today's broken behaviour, which would fail the day it is repaired. What
    // makes that possible is that the settlement runs OUTSIDE the delete transaction, so it survives the
    // rollback; that is exactly the property worth pinning, and this is the only place that can pin it.
    let refundBlocked: string | null = null;
    try { deleteCrowdfundProject(doomed, emptyHanded); }
    catch (e: any) { refundBlocked = e?.message || String(e); }
    console.log(refundBlocked
        ? `  ℹ path 2: the refund itself is blocked by #139 ("${refundBlocked}") — asserting the settlement, which survives the rollback`
        : '  ℹ path 2: the refund committed, so this is the full end-to-end path');

    const refundeeRow = row(refundee)!;
    assert(refundeeRow.epoch === nowEpoch(),
        'path 2: the backer\'s demurrage window is CLOSED in the row — durably, because settling happens '
        + 'outside the delete transaction and so is not undone by its rollback');

    reconcileLedgerFromDb();
    // Count only what was actually credited, so the arithmetic is the same whether or not the refund landed.
    const refunded = (db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE to_pubkey=? AND id LIKE 'refund_%'`,
    ).get(refundee) as { s: number }).s;
    const refundCharge = OPENING + refunded - getBalance(refundee).balance;
    assert(Math.abs(refundCharge - fairCharge) < SAME_CHARGE,
        `path 2: the backer is charged ${refundCharge.toFixed(4)} — the fair cost of the ${OPENING} they `
        + `actually held, with ${refunded} refunded on top and taxed at nothing`);

    // ── Path 2b: settling a whole refund batch is ALL-OR-NOTHING ───────────────────────────────────
    // A refund settles every backer of the project, so the loop was one WAL commit per member (review
    // finding). The stronger half of that finding is atomicity: un-batched, a failure part-way left some
    // windows closed and some open, with the decay applied in memory for every one of them — memory and rows
    // disagreeing in a way nothing would later reconcile.
    const shared = id('proj');
    createCrowdfundProject(shared, emptyHanded, 'Two backers', 'settled as one batch', [], PAYOUT * 20, null);
    pledgeToProject(crypto.randomUUID(), shared, backerOne, PLEDGE_SMALL, 'pledge');
    pledgeToProject(crypto.randomUUID(), shared, backerTwo, PLEDGE_SMALL, 'pledge');
    // Age both, so settling them is an observable write rather than a no-op.
    for (const pk of [backerOne, backerTwo]) {
        db.prepare(`UPDATE accounts SET last_demurrage_epoch=? WHERE public_key=?`).run(nowEpoch() - STALE_DAYS, pk);
    }
    reconcileLedgerFromDb();

    // Block the SECOND account the settle will reach, read through the same query db.ts uses so the target is
    // the real one rather than a guess — blocking the first would abort before any write and prove nothing.
    const settleOrder = (db.prepare(`SELECT DISTINCT from_pubkey FROM transactions WHERE to_pubkey=? AND project_id=?`)
        .all(`escrow_${shared}`, shared) as { from_pubkey: string }[]).map(b => b.from_pubkey);
    const firstSettled = settleOrder[0], blockedSettle = settleOrder[1];
    const before2b = [firstSettled, blockedSettle].map(pk => row(pk)!);
    db.exec(`CREATE TRIGGER zz_block_settle BEFORE UPDATE ON accounts
             WHEN NEW.public_key = '${blockedSettle}'
             BEGIN SELECT RAISE(ABORT, 'settle blocked by test'); END;`);
    let settleFailed: string | null = null;
    try { deleteCrowdfundProject(shared, emptyHanded); }
    catch (e: any) { settleFailed = e?.message || String(e); }
    db.exec(`DROP TRIGGER zz_block_settle`);

    assert(settleFailed === 'settle blocked by test',
        `path 2b: the batch aborted on the second account, not on the delete's own FK (${settleFailed})`);
    const after2b = [firstSettled, blockedSettle].map(pk => row(pk)!);
    assert(after2b.every((r, i) => r.epoch === before2b[i].epoch && Math.abs(r.balance - before2b[i].balance) < 1e-9),
        `path 2b: NEITHER window was closed — settling ${settleOrder.length} backers is one transaction, so the `
        + 'first is rolled back with the second instead of being left settled beside an unsettled peer');

    // ── Path 3: commons voting-round grant, proposer WITH an existing row ──────────────────────────
    const grantCharge = await grantTo(proposer, admin, 'Existing row', OPENING);
    assert(row(proposer)!.epoch === nowEpoch(),
        'path 3: the grant carried the settled epoch into the row on the DO UPDATE arm');
    assert(Math.abs(grantCharge - fairCharge) < SAME_CHARGE,
        `path 3: the granted proposer is charged ${grantCharge.toFixed(4)}, not a share of the grant itself`);

    const decayRows = db.prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE from_pubkey=? AND to_pubkey='COMMONS_POOL' AND id LIKE 'demurrage_%'`,
    ).get(proposer) as { n: number };
    assert(decayRows.n === 1,
        'path 3: the decay the grant path collected has a `demurrage_` transaction row — it never persisted '
        + 'its decay events, so the collection was unauditable even once conservation was safe');

    // ── Path 3c: the same grant, proposer inside the Green Zone → nothing to persist ────────────────
    // This is what actually holds the DO UPDATE arm honest. When the decay IS recordable, as for `proposer`
    // above, persistDecayEvents() writes `last_demurrage_epoch` on its own — so path 3 passes even with the
    // column omitted from the UPSERT, and reverting that fix looks harmless. A proposer who owes nothing
    // queues no event, and the omission is then the only thing standing between the grant and a stale window.
    await grantTo(quietProposer, admin, 'Quiet proposer', GREEN_ZONE_HOLDING);
    const quietPropRow = row(quietProposer)!;
    assert(quietPropRow.epoch === nowEpoch(),
        'path 3c: a granted proposer who owes no demurrage still has the window closed in the row — the '
        + 'UPSERT carries the epoch itself rather than relying on there being a decay event to persist');
    assert(Math.abs(quietPropRow.balance - (GREEN_ZONE_HOLDING + PAYOUT)) < 1e-9,
        `path 3c: and the grant arrives whole — ${GREEN_ZONE_HOLDING} + ${PAYOUT}`);
    reconcileLedgerFromDb();
    assert(Math.abs(getBalance(quietProposer).balance - (GREEN_ZONE_HOLDING + PAYOUT)) < 1e-9,
        'path 3c: and the next read charges nothing against it');

    // ── Path 3b: the same grant, proposer with NO accounts row → the literal epoch 0 ────────────────
    const rowlessProject = createProject(rowless, 'No row yet', 'tests the INSERT arm', PAYOUT);
    if (!rowlessProject) throw new Error('setup: createProject failed for the rowless proposer');
    // Drop the row (and the in-memory account with it) so the UPSERT takes its INSERT arm.
    db.prepare(`DELETE FROM accounts WHERE public_key=?`).run(rowless);
    reconcileLedgerFromDb();
    await closeRoundFor(rowlessProject.id, admin);

    const rowlessRow = row(rowless)!;
    assert(rowlessRow.epoch === nowEpoch(),
        'path 3b: inserting a granted account stamps the CURRENT epoch, not the literal 0');
    reconcileLedgerFromDb();
    const rowlessBalance = getBalance(rowless).balance;
    assert(Math.abs(rowlessBalance - PAYOUT) < 1e-6,
        `path 3b: the grant survives the next read intact (${rowlessBalance}) — epoch 0 is 1970, and ~56 years `
        + `of compound decay would have left roughly the 200-bean Green Zone of a ${PAYOUT} grant`);

    // ── Path 3d: a grant that FAILS must leave the ledger exactly as it was ─────────────────────────
    // The grant moves value in memory (`deductFromCommons`, the balance credit, and any demurrage the
    // proposer's read collects) as well as in rows, and a SQLite rollback touches only the rows. So the whole
    // thing runs inside `conservingTransaction` with the deduct INSIDE the snapshot. Previously the deduct and
    // the credit happened before a bare `db.transaction`, and a failed grant left the pot debited in memory
    // with nothing credited anywhere — beans destroyed, and the project already marked funded.
    //
    // Forced with a temporary trigger rather than a stub, so the failure arrives from SQLite the way a real
    // constraint violation would, part-way through the transaction.
    const blocked = createProject(failProposer, DOOMED_GRANT, 'must roll back cleanly', PAYOUT);
    if (!blocked) throw new Error('setup: createProject failed for the blocked grant');
    db.exec(`CREATE TRIGGER zz_block_grant BEFORE INSERT ON transactions
             WHEN NEW.memo = 'Commons grant: ${DOOMED_GRANT}'
             BEGIN SELECT RAISE(ABORT, 'grant blocked by test'); END;`);
    const commonsBeforeFail = getCommonsBalanceExact();
    const rowBeforeFail = row(failProposer)!;
    let grantFailed: string | null = null;
    try { await closeRoundFor(blocked.id, admin); }
    catch (e: any) { grantFailed = e?.message || String(e); }
    db.exec(`DROP TRIGGER zz_block_grant`);

    assert(!!grantFailed, `path 3d: the blocked grant really did fail, so the rest of this means something (${grantFailed})`);
    assert(Math.abs(getCommonsBalanceExact() - commonsBeforeFail) < 1e-9,
        `path 3d: the Commons pot is back where it started (${getCommonsBalanceExact().toFixed(4)}) — a debit `
        + `taken in memory for a grant that never landed destroys ${PAYOUT} beans`);
    const rowAfterFail = row(failProposer)!;
    assert(Math.abs(rowAfterFail.balance - rowBeforeFail.balance) < 1e-9 && rowAfterFail.epoch === rowBeforeFail.epoch,
        'path 3d: and the proposer\'s row is untouched, window included — the decay collected inside the failed '
        + 'transaction was unwound with it, not left as a credit with no debit');

    // ── Conservation: none of the above may move the ledger ────────────────────────────────────────
    assert(Math.abs(nodeTotal() - baseline) < 0.005,
        `conservation: sum(accounts) + Commons is unchanged (${nodeTotal().toFixed(4)} vs ${baseline.toFixed(4)}) — `
        + 'every settlement moved value between an account and the pot, and minted none');

    // ── And it survives a restart, which is where an un-persisted half shows up ─────────────────────
    // The live COMMONS_BALANCE is thrown away and rebuilt from the COMMONS_POOL row, exactly as
    // initStateEngine does on boot. Any decay debit or grant that was committed to an account row while its
    // matching Commons movement stayed in memory reappears here as drift — which is what makes the grant's
    // persists having to be INSIDE its transaction (review finding) an assertion rather than an argument.
    const commonsRow = (db.prepare(`SELECT balance FROM accounts WHERE public_key='COMMONS_POOL'`)
        .get() as { balance: number }).balance;
    setCommonsBalance(commonsRow);
    reconcileLedgerFromDb();
    assert(Math.abs(nodeTotal() - baseline) < 0.005,
        `durability: rebuilding the pot from its row conserves too (${nodeTotal().toFixed(4)} vs `
        + `${baseline.toFixed(4)}) — every credit taken in memory reached a row`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ #138 demurrage-window checks PASSED — no path raises a balance on an open window.');
}

/** Run a full propose → vote → close cycle and return what demurrage cost the proposer. */
async function grantTo(proposerPubkey: string, adminPubkey: string, title: string, opening: number): Promise<number> {
    const project = createProject(proposerPubkey, title, 'granted by the commons', PAYOUT);
    if (!project) throw new Error(`setup: createProject failed for ${title}`);
    await closeRoundFor(project.id, adminPubkey);
    reconcileLedgerFromDb();
    return opening + PAYOUT - getBalance(proposerPubkey).balance;
}

/** Give a project the only vote in a round, then close it — so it wins and is funded. */
async function closeRoundFor(projectId: string, adminPubkey: string): Promise<void> {
    const round = createVotingRound(adminPubkey, [projectId], new Date(Date.now() + 3_600_000).toISOString());
    if (!round) throw new Error('setup: createVotingRound failed');

    const projects = JSON.parse((db.prepare("SELECT value FROM node_config WHERE key='commons_projects'").get() as any).value);
    for (const p of projects) if (p.id === projectId) p.votes = [{ pubkey: 'voter', weight: 5, creditsUsed: 25 }];
    db.prepare(`UPDATE node_config SET value=? WHERE key='commons_projects'`).run(JSON.stringify(projects));

    const res = closeVotingRound(round.id);
    if (!res.success || res.winner?.id !== projectId) throw new Error('setup: the round did not fund its project');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
