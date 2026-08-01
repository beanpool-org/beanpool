/**
 * Conservation across the Commons pot (#124, #126).
 *
 * THE INVARIANT. BeanPool is mutual credit: there is no money supply, and the network always sums to zero.
 * Every path that moves value into or out of the Commons must preserve that, including across a restart.
 *
 * WHY THIS FILE EXISTS. Two live paths were destroying beans, and both had the same cause: they moved the
 * `COMMONS_POOL` *account*, which is only the persisted shadow of the `COMMONS_BALANCE` global.
 * `persistCommonsBalance()` rewrites that row from the global after every transfer, so a transfer INTO it is
 * written and immediately overwritten, and a transfer OUT of it is funded from nowhere.
 *
 *   • `POST /api/treasury/:treasury/sweep` — a Keeper sweeping surplus into the Commons. Measured before the
 *     fix: 40 beans in, 40 beans gone, node total 100 → 60. (#126)
 *   • `adminPruneUser` — both directions. A confiscation vanished; a debt write-off MINTED. (#124)
 *
 * Neither had any test asserting the books still balanced, which is how both shipped. The checks below are
 * deliberately written as "sum of every account, before and after" rather than as assertions about the
 * particular accounts involved — a test that only inspects the two accounts it expects to move is exactly
 * the test that misses value leaving through a third.
 *
 * The reboot check matters as much as the arithmetic: the original defect was invisible until the next
 * restart reloaded the clobbered row.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-commons-conservation.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import {
    initStateEngine, reconcileLedgerFromDb, moveToCommons, payFromCommons,
    getCommonsBalanceExact, adminPruneUser, persistCommonsBalance, conservingTransaction,
} from './state-engine.js';
import { createTreasuryRoutes } from './routes/treasury.js';
import { setCommonsBalance } from '@beanpool/core';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function throws(fn: () => unknown, re: RegExp, msg: string) {
    let m = '';
    try { fn(); } catch (e: any) { m = e.message; }
    assert(re.test(m), `${msg} (got "${m}")`);
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const bal = (k: string) => r4((db.prepare('SELECT balance FROM accounts WHERE public_key=?').get(k) as any)?.balance ?? 0);

/**
 * The whole node, as one number.
 *
 * Sums every account row EXCEPT `COMMONS_POOL`, then adds the Commons pot from the global — because the row
 * is a shadow of the global and counting both would double-count, while counting only the row would miss any
 * un-flushed value. This is the figure that must not move.
 */
const nodeTotal = () => {
    const accounts = (db.prepare(
        `SELECT COALESCE(SUM(balance), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`,
    ).get() as any).t;
    return r4(accounts + getCommonsBalanceExact());
};

/**
 * Simulate a restart: drop in-memory state, reload from the rows. Mirrors `initStateEngine()`.
 *
 * It deliberately does NOT flush first (review finding). An earlier version called
 * `persistCommonsBalance()` here, which made every durability check below pass whether or not the code
 * under test persisted anything — the helper was writing the row it then asserted on. A real restart reloads
 * only what was ALREADY stored, so this must too, or the checks measure the test instead of the code.
 *
 * Verified by mutation: with the flush removed, deleting `persistCommonsBalance()` from `moveToCommons`
 * fails these checks. With the flush in place, it did not.
 */
const reboot = () => {
    setCommonsBalance(0);
    const row = db.prepare("SELECT balance FROM accounts WHERE public_key='COMMONS_POOL'").get() as any;
    if (row && typeof row.balance === 'number') setCommonsBalance(row.balance);
    reconcileLedgerFromDb();
};

function makeMember(callsign: string, balance: number, opts?: { treasury?: boolean }): string {
    const pk = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, is_treasury)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`)
        .run(pk, callsign, opts?.treasury ? 1 : 0);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)`)
        .run(pk, balance, ledger.getCurrentEpoch());
    reconcileLedgerFromDb();
    return pk;
}

function main() {
    console.log('Running Commons conservation tests (#124, #126)...\n');
    initStateEngine();

    // ── 1. A treasury sweep conserves value (#126) ────────────────────────────────────────────────
    const treasury = makeMember('Community Eggs', 100, { treasury: true });
    const before = nodeTotal();
    const commonsBefore = getCommonsBalanceExact();

    const swept = moveToCommons(treasury, 40, 'Surplus swept to Commons');
    assert(!!swept, 'a treasury may sweep surplus into the Commons');
    assert(bal(treasury) === 60, 'the treasury is debited');
    assert(r4(getCommonsBalanceExact()) === r4(commonsBefore + 40), 'and the Commons POT actually receives it');
    assert(nodeTotal() === before, `and the node still sums to the same total (${before})`);

    reboot();
    assert(r4(getCommonsBalanceExact()) === r4(commonsBefore + 40), 'the credit SURVIVES a restart');
    assert(nodeTotal() === before, 'and the total is unchanged across the restart');
    assert(bal(treasury) === 60, 'with the treasury still debited, not silently restored');

    // A sweep is recorded, so it is auditable rather than a bare balance change.
    const sweepTxn = db.prepare(
        `SELECT COUNT(*) n FROM transactions WHERE from_pubkey=? AND to_pubkey='COMMONS_POOL'`,
    ).get(treasury) as any;
    assert(sweepTxn.n === 1, 'and the sweep left exactly one ledger row behind');

    // ── 2. A treasury cannot sweep itself into debt ───────────────────────────────────────────────
    const t2 = makeMember('Small Treasury', 5, { treasury: true });
    const beforeOverdraw = nodeTotal();
    assert(moveToCommons(t2, 50, 'too much') === null, 'sweeping more than it holds is refused');
    assert(bal(t2) === 5, 'the treasury is untouched by the refusal');
    assert(nodeTotal() === beforeOverdraw, 'and nothing moved anywhere');

    // ── 3. An ordinary member still cannot use this path ──────────────────────────────────────────
    // Member-facing debits belong in transfer(), where the send gate and floor policy live. Widening
    // moveToCommons to treasuries must not have widened it to everyone.
    const ordinary = makeMember('Ordinary Member', 100);
    throws(() => moveToCommons(ordinary, 10, 'nope'), /synthetic accounts and treasuries only/,
        'an ordinary member is refused — this is not a back door around the send gate');

    // ── 4. Pruning a member in CREDIT conserves value (#124) ──────────────────────────────────────
    const rich = makeMember('Leaving With Credit', 200);
    const beforePrune = nodeTotal();
    const commonsBeforePrune = getCommonsBalanceExact();
    adminPruneUser(rich);

    assert(bal(rich) === 0, 'the pruned member ends at zero');
    assert(r4(getCommonsBalanceExact()) === r4(commonsBeforePrune + 200),
        'and the community RECLAIMS the surplus rather than it vanishing');
    assert(nodeTotal() === beforePrune, 'the node still sums to the same total');
    reboot();
    assert(nodeTotal() === beforePrune, 'across a restart too');

    // ── 5. Pruning a member in DEBT conserves value (#124) ────────────────────────────────────────
    // The dangerous direction: this used to MINT the write-off from nowhere.
    const debtor = makeMember('Leaving In Debt', -120);
    const beforeDebt = nodeTotal();
    const commonsBeforeDebt = getCommonsBalanceExact();
    adminPruneUser(debtor);

    assert(bal(debtor) === 0, 'the debt is settled and the member ends at zero');
    assert(r4(getCommonsBalanceExact()) === r4(commonsBeforeDebt - 120),
        'and the COMMUNITY absorbs it — the write-off is funded, not minted');
    assert(nodeTotal() === beforeDebt, 'so the node total does not move: no beans created');
    reboot();
    assert(nodeTotal() === beforeDebt, 'and it holds across a restart');

    // ── 6. A write-off larger than the pot still balances, and the deficit is visible ──────────────
    // docs/commons-pool-transparency.md's Solvency Rule: a prune must ALWAYS balance the books. That
    // document names an empty pot as a threat to balance, not a reason to refuse — so the pot goes negative
    // and says so, rather than the prune failing or beans being minted.
    setCommonsBalance(10);
    persistCommonsBalance();
    reconcileLedgerFromDb();
    const bigDebtor = makeMember('Deep Debt', -500);
    const beforeBig = nodeTotal();
    adminPruneUser(bigDebtor);

    assert(bal(bigDebtor) === 0, 'a debt far larger than the pot is still settled');
    assert(getCommonsBalanceExact() < 0, 'the Commons goes into DEFICIT — the honest record of the write-off');
    assert(nodeTotal() === beforeBig, 'and conservation holds: no beans were invented to cover it');
    reboot();
    assert(getCommonsBalanceExact() < 0, 'the deficit survives a restart rather than resetting to zero');
    assert(nodeTotal() === beforeBig, 'and so does the total');

    // ── 7. payFromCommons refuses an unfunded draw unless a deficit is explicitly allowed ─────────
    setCommonsBalance(10);
    persistCommonsBalance();
    const payee = makeMember('Payee', 0);
    const beforePay = nodeTotal();
    assert(payFromCommons(payee, 50, 'unfunded') === null,
        'an ordinary draw beyond the pot is refused — the Commons does not quietly overdraw');
    assert(bal(payee) === 0 && nodeTotal() === beforePay, 'and nothing moved');
    assert(!!payFromCommons(payee, 50, 'write-off', { allowDeficit: true }),
        'while an explicit allowDeficit draw succeeds, for the Solvency Rule');
    assert(nodeTotal() === beforePay, 'and even that conserves value');

    // ── 8. A failed write unwinds the IN-MEMORY ledger, not just the rows ─────────────────────────
    // `db.transaction()` rolls back SQLite. It does NOT roll back the in-memory ledger or the
    // COMMONS_BALANCE global, which these primitives also mutate — so a throw in a later statement leaves
    // memory and rows disagreeing, and the next flush writes the phantom value over the rolled-back row,
    // making it durable. `conservingTransaction` exists for that, and this asserts both halves.
    setCommonsBalance(25);
    persistCommonsBalance();
    reconcileLedgerFromDb();
    const t3 = makeMember('Rollback Treasury', 50, { treasury: true });
    const beforeRollback = nodeTotal();
    const commonsAtStart = getCommonsBalanceExact();

    throws(() => conservingTransaction(() => {
        moveToCommons(t3, 30, 'swept — then a later statement fails');
        throw new Error('a later statement failed');
    }), /a later statement failed/, 'the failure propagates rather than being swallowed');

    assert(bal(t3) === 50, 'the treasury ROW is rolled back by SQLite');
    assert(r4(ledger.getAccount(t3).balance) === 50, 'and the IN-MEMORY balance is rolled back with it');
    assert(r4(getCommonsBalanceExact()) === r4(commonsAtStart),
        'and the Commons global is restored, not left ahead of the rows');
    assert(nodeTotal() === beforeRollback, 'so conservation survives the failure');

    // The damaging part is what the NEXT flush writes. A stale global becomes durable here or nowhere.
    persistCommonsBalance();
    reboot();
    assert(r4(getCommonsBalanceExact()) === r4(commonsAtStart),
        'and the next flush cannot make the phantom credit durable');
    assert(nodeTotal() === beforeRollback, 'with the node total still intact across the restart');

    // ── 9. adminPruneUser is actually WIRED to that, on its real failure path ──────────────────────
    // Section 8 proves the helper; this proves the prune uses it. The prune moves value FIRST and runs two
    // more statements afterwards, so a failure in either is the reachable case. A trigger makes the posts
    // cancellation abort — the last statement in the transaction, and the one furthest from the ledger move.
    const stubborn = makeMember('Cannot Be Pruned', -75);
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status)
                VALUES ('post-prune-fail', 'offer', 'food', 'Eggs', '', 1, ?, 'active')`).run(stubborn);
    db.exec(`CREATE TRIGGER t_fail_posts BEFORE UPDATE ON posts
             BEGIN SELECT RAISE(ABORT, 'simulated failure after the ledger move'); END;`);
    const beforeFailedPrune = nodeTotal();
    const commonsBeforeFailedPrune = getCommonsBalanceExact();

    throws(() => adminPruneUser(stubborn), /simulated failure/, 'a prune that fails late reports it');
    db.exec('DROP TRIGGER t_fail_posts');

    assert(bal(stubborn) === -75, 'the member keeps their debt — the write-off was rolled back');
    assert(r4(ledger.getAccount(stubborn).balance) === -75, 'in memory as well as in the row');
    assert(r4(getCommonsBalanceExact()) === r4(commonsBeforeFailedPrune),
        'the Commons was NOT charged for a write-off that did not happen');
    assert(nodeTotal() === beforeFailedPrune, 'and no beans were created by the half-completed prune');
    const stillActive = (db.prepare('SELECT status FROM members WHERE public_key=?').get(stubborn) as any)?.status;
    assert(stillActive !== 'pruned', 'and the member is not left marked pruned with their debt intact');
    reboot();
    assert(nodeTotal() === beforeFailedPrune, 'all of which holds across a restart');

    // ── 10. A rollback with UNFLUSHED demurrage in the snapshot ────────────────────────────────────
    // The subtle one, and it is a hazard the wrapper could CREATE rather than one it inherits.
    //
    // Demurrage is applied lazily inside `ledger.getAccount()`: it debits the account, does
    // `COMMONS_BALANCE += decayed` in memory, queues a decay event, and touches no row until
    // `persistDecayEvents()` runs. If that has happened but not been flushed when `conservingTransaction`
    // snapshots the pot, the snapshot holds a Commons credit whose matching account debit exists only in
    // memory. The rollback then reloads the PRE-decay row and `loadState()` clears the decay queue — so
    // restoring the snapshotted Commons leaves a credit with no debit anywhere, and the next flush mints it.
    //
    // `conservingTransaction` flushes decay before snapshotting for exactly this reason.
    const t4 = makeMember('Decay Era Treasury', 50, { treasury: true });
    const decayer = makeMember('Has Decayed', 500);
    const baseline = nodeTotal();

    // Backdate two months so the next read of this account applies real demurrage.
    db.prepare('UPDATE accounts SET last_demurrage_epoch=? WHERE public_key=?')
        .run(ledger.getCurrentEpoch() - 60, decayer);
    reconcileLedgerFromDb();   // last reconcile: from here on, the decay queue must survive

    // Touching the account is what applies it — in memory only, with the row left stale.
    const decayedTo = ledger.getAccount(decayer).balance;
    assert(decayedTo < 500, `reading the account applied demurrage lazily (500 → ${r4(decayedTo)})`);
    assert(bal(decayer) === 500, 'and the ROW is still stale, so memory and rows disagree at this point');

    throws(() => conservingTransaction(() => {
        moveToCommons(t4, 10, 'a sweep that fails, with decay pending');
        throw new Error('a later statement failed');
    }), /a later statement failed/, 'the failure propagates');

    // What matters is the durable outcome: flush, restart, and see whether the books still add up.
    persistCommonsBalance();
    reboot();
    assert(nodeTotal() === baseline,
        `no beans were minted by the pending decay (expected ${baseline}, got ${nodeTotal()})`);
    assert(bal(t4) === 50, 'the failed sweep left the treasury alone');

    console.log(`\n${passed}/${run} direct-call checks passed.`);
}

/**
 * The same conservation checks, driven through the REAL HTTP route (review finding).
 *
 * Everything above calls `moveToCommons` directly, so re-wiring the sweep route back to
 * `transfer(..., 'COMMONS_POOL', ...)` — the exact defect #126 fixed — would leave the suite green. The
 * route wiring IS the bug, so the route has to be what gets exercised.
 *
 * It drives the router the server actually mounts rather than a re-implementation of it, so the keeper gate,
 * the amount validation, the active-status check and the ledger call are all the production ones.
 */
async function routeChecks() {
    console.log('\n── through the real sweep route ──');
    const router = createTreasuryRoutes({
        checkAdminAuth: async () => false,
        rateLimit: () => true,
        clampLimit: (v: unknown, def = 20) => def,
        clampOffset: () => 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    });

    const layer = (router as any).stack.find((l: any) =>
        l.path === '/api/treasury/:treasury/sweep' && l.methods.includes('POST'));
    if (!layer) throw new Error('The sweep route is not mounted — this test is looking at the wrong path');

    /** Invoke the mounted handler with a hand-built ctx, the way Koa would. */
    const sweep = async (treasury: string, actor: string, amount: unknown) => {
        const ctx: any = {
            params: { treasury }, state: { actor }, requestBody: { amount },
            status: 200, body: undefined,
        };
        await layer.stack[layer.stack.length - 1](ctx, async () => {});
        return ctx;
    };

    const treasury = makeMember('Route Treasury', 100, { treasury: true });
    const keeper = makeMember('Keeper', 0);
    db.prepare('UPDATE members SET can_operate=1 WHERE public_key=?').run(keeper);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(treasury, keeper);

    const before = nodeTotal();
    const commonsBefore = getCommonsBalanceExact();

    const ok = await sweep(treasury, keeper, 40);
    assert(ok.status === 200 && ok.body?.success === true, 'a keeper can sweep surplus through the route');
    assert(bal(treasury) === 60, 'the treasury is debited');
    assert(r4(getCommonsBalanceExact()) === r4(commonsBefore + 40), 'the Commons POT receives it');
    assert(nodeTotal() === before, 'and the route conserves value — no beans destroyed');
    reboot();
    assert(r4(getCommonsBalanceExact()) === r4(commonsBefore + 40), 'which survives a restart');
    assert(nodeTotal() === before, 'still summing to the same total');

    // Overdraw: refused with a message, and nothing moved.
    const over = await sweep(treasury, keeper, 500);
    assert(over.status === 400, 'sweeping more than the treasury holds is refused');
    assert(bal(treasury) === 60 && nodeTotal() === before, 'and nothing moved on the refusal');

    const zero = await sweep(treasury, keeper, 0);
    assert(zero.status === 400, 'a zero sweep is refused');

    // A stranger is not a keeper. Seeded at zero deliberately: `nodeTotal()` is compared against `before`
    // below, and a fixture that mints itself 50 beans mid-suite breaks that comparison rather than the code.
    const stranger = makeMember('Stranger', 0);
    const denied = await sweep(treasury, stranger, 10);
    assert(denied.status === 403, 'a non-keeper is refused');

    // Suspended parties cannot move value — the check that moving off transfer() dropped.
    db.prepare("UPDATE members SET status='disabled' WHERE public_key=?").run(treasury);
    const closed = await sweep(treasury, keeper, 10);
    assert(closed.status === 403, 'a keeper cannot sweep a DISABLED enterprise');
    assert(bal(treasury) === 60, 'and its funds are untouched');
    db.prepare("UPDATE members SET status='active' WHERE public_key=?").run(treasury);

    db.prepare("UPDATE members SET status='disabled' WHERE public_key=?").run(keeper);
    const suspended = await sweep(treasury, keeper, 10);
    assert(suspended.status === 403, 'and a DISABLED keeper cannot sweep a live one');
    assert(bal(treasury) === 60 && nodeTotal() === before, 'with the books unchanged throughout');
    db.prepare("UPDATE members SET status='active' WHERE public_key=?").run(keeper);

    // ── The BLAST RADIUS of that gate ─────────────────────────────────────────────────────────────
    // The active check went into `requireOperator`, which all six operator routes share — so the fix for
    // one route changed the authority rules for five others that no test drives. Only the sweep needed it;
    // none of them must be BROKEN by it. Enumerated off the router itself rather than hand-listed, so an
    // operator route added later is covered here without anyone remembering to add it.
    const operatorRoutes = (router as any).stack.filter((l: any) =>
        l.path.includes(':treasury') && !l.path.includes('/local/admin/') && l.methods.includes('POST'));
    assert(operatorRoutes.length >= 5,
        `the gate is shared by ${operatorRoutes.length} operator routes, so all of them are checked here`);

    const call = async (l: any, actor: string) => {
        const ctx: any = { params: { treasury }, state: { actor }, requestBody: {}, status: 200, body: undefined };
        try { await l.stack[l.stack.length - 1](ctx, async () => {}); } catch { ctx.status = 500; }
        return ctx;
    };

    for (const l of operatorRoutes) {
        const name = l.path.split('/').pop();
        // An ACTIVE keeper must get past the gate. The body is empty, so each route then refuses on its own
        // terms (400 "title is required", "transactionId is required", "amount must be positive") — the point
        // is that it is the ROUTE refusing, not the gate.
        const allowed = await call(l, keeper);
        assert(allowed.status !== 403, `an active keeper still gets past the gate on /${name} (got ${allowed.status})`);

        db.prepare("UPDATE members SET status='disabled' WHERE public_key=?").run(keeper);
        const blocked = await call(l, keeper);
        assert(blocked.status === 403, `and a suspended keeper is refused on /${name}`);
        db.prepare("UPDATE members SET status='active' WHERE public_key=?").run(keeper);
    }
    assert(nodeTotal() === before, 'and none of that moved a single bean');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Commons conservation checks PASSED (#124, #126).');
}

main();
await routeChecks();
process.exit(0);
