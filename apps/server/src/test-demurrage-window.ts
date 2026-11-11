/**
 * #138 regression — a balance may never RISE with its demurrage window left open.
 *
 * THE RULE. Demurrage is `principal × time × rate`, so an interval cannot be carried across a change of
 * principal. If an account's stored `last_demurrage_epoch` is stale and its balance then increases without
 * the window being closed, the account's next read charges the WHOLE old interval against the new, larger
 * balance. Someone who has not traded for two months is taxed on money their community just handed them.
 *
 * `ledger.applyDecay` closes the window on every branch, and `transfer()` / `moveToCommons()` /
 * `payFromCommons()` persist `last_demurrage_epoch` alongside the balance — so those paths are safe. Two
 * host paths were not, and each raises a balance a different way:
 *
 *   1. the crowdfund escrow sweep to a project creator   (db.ts, raw `balance = balance + ?`)
 *   2. the refund to every backer of a deleted project   (db.ts, same shape, widest blast radius)
 *
 * (A third, the old commons voting-round grant, was deleted with voting rounds on 2026-09-19.)
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
 * ever decayed and none of these paths has fired. This becomes real the first time an account crosses
 * 200 beans, which is why it is worth pinning now rather than after.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-demurrage-window.ts
 */
import crypto from 'node:crypto';
import {
    initStateEngine, getBalance, reconcileLedgerFromDb, getCommonsBalanceExact,
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
 * Every figure here is whole hundredths of a Bean (1 Bean = 100), as the node keeps them; `hc` makes one from Beans, and
 * the messages print Beans (`/ 100`, exact for whole hundredths).
 *
 * Two accounts holding the same balance for the same interval owe the same demurrage: the circulation charge is truncated
 * to whole hundredths once (core circulationChargeOf), so agreement with the control is EXACT, and the charge itself is a
 * whole number of hundredths. (The old 0.05-Bean slack absorbed float noise, and a run straddling a UTC midnight, which
 * reads the control and a case a day apart; that rare run now fails loudly and is rerun. The row-level epoch assertions are
 * immune to it either way.) The ~2-Bean fair charge and the ~223 the bug charged can't be confused.
 */
const hc = (beans: number) => Math.round(beans * 100);

const STALE_DAYS = 60;
const OPENING = hc(300);    // 100 beans above the Green Zone → a small but real, recordable decay
const PAYOUT = hc(5_000);   // large enough that taxing it retrospectively is unmistakable
/**
 * Inside the tax-free Green Zone, so however long it sits it owes NOTHING and queues no decay event. That is
 * the case a settlement built on `persistDecayEvents()` alone cannot reach — it returns early on an empty
 * queue, leaving the stale epoch in the row for the incoming credit to be taxed against. Nearly every real
 * member is here today, so it is the most likely shape of the bug, not an edge case.
 */
const GREEN_ZONE_HOLDING = hc(199);
/**
 * More than an unsettled `OPENING + PAYOUT` row can honestly afford, less than the row says. 5,300 held for
 * 60 days owes ~223.40, so the true balance is ~5,076.60 and this sits in the gap — the only band in which a
 * pledge's affordability check can be caught reading a pre-decay row.
 */
const PLEDGE_OVER_SETTLED = hc(5_200);
/** Small enough that two backers each keep a decayable OPENING after pledging (path 2b). */
const PLEDGE_SMALL = hc(100);

function seedMember(pk: string, balance: number, staleDays: number): void {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(pk, pk.slice(0, 10));
    db.prepare(`
        INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch)
        VALUES (?, ?, ?)
        ON CONFLICT(public_key) DO UPDATE SET balance_c=excluded.balance_c, last_demurrage_epoch=excluded.last_demurrage_epoch
    `).run(pk, balance, nowEpoch() - staleDays);
}

const row = (pk: string) =>
    db.prepare(`SELECT balance_c, last_demurrage_epoch AS epoch FROM accounts WHERE public_key=?`).get(pk) as
        { balance_c: number; epoch: number } | undefined;

/**
 * The whole ledger as one number. Every account row EXCEPT the COMMONS_POOL shadow, plus the live global —
 * the pool row is only a persisted copy of `COMMONS_BALANCE`, so counting both double-counts the pot.
 * Demurrage moves value between an account and the Commons, so this figure must not move at all.
 */
const nodeTotal = (): number => {
    const s = (db.prepare(`SELECT COALESCE(SUM(balance_c),0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'`)
        .get() as { s: number }).s;
    // Whole hundredths sum exactly: no rounding.
    return s + getCommonsBalanceExact();
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
    const backerOne = id('backerone');   // path 2b — two backers of one project, settled as one batch
    const backerTwo = id('backertwo');

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

    setCommonsBalance(hc(50_000));
    reconcileLedgerFromDb();            // pull the seeded rows in, as boot would
    const baseline = nodeTotal();

    // ── The control: what this interval genuinely costs ────────────────────────────────────────────
    const fairCharge = OPENING - getBalance(control).balance_c;
    assert(Number.isSafeInteger(fairCharge) && fairCharge > hc(0.5),
        `control: ${OPENING / 100} beans held ${STALE_DAYS} days genuinely owes ${fairCharge / 100}, whole hundredths — a real, `
        + 'recordable decay, so every comparison below can actually fail');

    // ── Path 1: crowdfund escrow sweep to the enterprise account (Slice 3) ─────────────────────────
    const funded = id('proj');
    createCrowdfundProject(funded, creator, 'Fully funded', 'sweeps to the enterprise account', [], PAYOUT, null);
    pledgeToProject(crypto.randomUUID(), funded, backer, PAYOUT, 'pledge');

    const creatorRow = row(creator)!;
    assert(creatorRow.epoch === nowEpoch(),
        'path 1: the escrow sweep left the creator\'s demurrage window CLOSED in the row');
    // Row-level, creator personal balance reflects only the fair charge (sweep lands in enterprise account per Slice 3)
    assert(OPENING - creatorRow.balance_c === fairCharge,
        `path 1: the stored balance reflects only the fair ${fairCharge / 100}, with creator personal funds protected (charged ${(OPENING - creatorRow.balance_c) / 100})`);
    const fundedRow = row(funded)!;
    assert(fundedRow.balance_c === PAYOUT,
        `path 1: the enterprise account received the full ${PAYOUT / 100} payout (demurrage-exempt)`);

    reconcileLedgerFromDb();   // what the balance-mutation hook, or any restart, does
    const creatorCharge = OPENING - getBalance(creator).balance_c;
    assert(creatorCharge === fairCharge,
        `path 1: reading the creator after the payout costs ${creatorCharge / 100}, matching the control`);

    // ── Path 1b: the same sweep, with a creator inside the Green Zone ────────────────────────────────
    const quietProject = id('proj');
    createCrowdfundProject(quietProject, quiet, 'Quiet creator', 'owes nothing, must still be closed', [], PAYOUT, null);
    pledgeToProject(crypto.randomUUID(), quietProject, backer, PAYOUT, 'pledge');

    const quietRow = row(quiet)!;
    assert(quietRow.epoch === nowEpoch(),
        `path 1b: a creator holding ${GREEN_ZONE_HOLDING / 100} owes nothing and queues no decay event, and the `
        + 'window is STILL closed in the row — persisting only when there is an event to persist would leave '
        + 'the commonest case broken');
    assert(quietRow.balance_c === GREEN_ZONE_HOLDING,
        `path 1b: creator inside Green Zone untouched — holds ${GREEN_ZONE_HOLDING / 100}`);
    const quietProjectRow = row(quietProject)!;
    assert(quietProjectRow.balance_c === PAYOUT,
        `path 1b: enterprise received ${PAYOUT / 100} payout (demurrage-exempt)`);
    reconcileLedgerFromDb();
    assert(getBalance(quiet).balance_c === GREEN_ZONE_HOLDING,
        'path 1b: and the next read charges nothing against creator');

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
        `path 1c: a ${overspend / 100} pledge against a settled balance of ${spenderRow.balance_c / 100} is REFUSED `
        + `— the row said ${(OPENING + PAYOUT) / 100}, which is the pre-decay figure (got: ${refusal ?? 'no error'})`);
    assert(spenderRow.epoch === nowEpoch() && spenderRow.balance_c < overspend,
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
    assert(beforeRefund.balance_c === OPENING && beforeRefund.epoch === nowEpoch() - STALE_DAYS,
        `path 2 setup: the backer sits on ${OPENING / 100} with a ${STALE_DAYS}-day window open when the project is `
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
        `SELECT COALESCE(SUM(amount_c),0) AS s FROM transactions WHERE to_pubkey=? AND id LIKE 'refund_%'`,
    ).get(refundee) as { s: number }).s;
    const refundCharge = OPENING + refunded - getBalance(refundee).balance_c;
    assert(refundCharge === fairCharge,
        `path 2: the backer is charged ${refundCharge / 100} — the fair cost of the ${OPENING / 100} they `
        + `actually held, with ${refunded / 100} refunded on top and taxed at nothing`);

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
    assert(after2b.every((r, i) => r.epoch === before2b[i].epoch && r.balance_c === before2b[i].balance_c),
        `path 2b: NEITHER window was closed — settling ${settleOrder.length} backers is one transaction, so the `
        + 'first is rolled back with the second instead of being left settled beside an unsettled peer');

    // ── Conservation: none of the above may move the ledger ────────────────────────────────────────
    assert(nodeTotal() === baseline,
        `conservation: sum(accounts) + Commons is unchanged (${nodeTotal()} vs ${baseline} hundredths) — `
        + 'every settlement moved value between an account and the pot, and minted none');

    // ── And it survives a restart, which is where an un-persisted half shows up ─────────────────────
    // The live COMMONS_BALANCE is thrown away and rebuilt from the COMMONS_POOL row, exactly as
    // initStateEngine does on boot. Any decay debit that was committed to an account row while its
    // matching Commons movement stayed in memory reappears here as drift.
    const commonsRow = (db.prepare(`SELECT balance_c FROM accounts WHERE public_key='COMMONS_POOL'`)
        .get() as { balance_c: number }).balance_c;
    setCommonsBalance(commonsRow);
    reconcileLedgerFromDb();
    assert(nodeTotal() === baseline,
        `durability: rebuilding the pot from its row conserves too (${nodeTotal()} vs `
        + `${baseline} hundredths) — every credit taken in memory reached a row`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ #138 demurrage-window checks PASSED — no path raises a balance on an open window.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
