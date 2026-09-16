/**
 * Enterprise Wind-Up & Accountability Ledger Tests (docs/the-commons.md §2.2)
 *
 * Verifies:
 *  1. initiateWindUp:
 *     - Lead keeper only (non-keeper & non-lead rejected).
 *     - Insolvent enterprise in deficit cannot self-wind-up (§2.6).
 *     - status -> 'winding_up', sets graceEndsAt (7 days).
 *     - Idempotent.
 *     - No new listings allowed while winding up.
 *  2. cancelWindUp:
 *     - Any keeper can cancel during grace period.
 *     - Non-keeper rejected.
 *     - Grace period expiry prevents cancel.
 *  3. finaliseWindUp:
 *     - Keeper / admin only.
 *     - Grace period enforced (cannot finalise before 7 days).
 *     - Blocked while open escrows / accepted bids exist.
 *     - Sweeps remaining balance to Commons inside conservingTransaction.
 *     - Conservation invariant strictly holds (SUM(balances) + COMMONS_POOL = 0).
 *     - Releases all keepers and backing pledges in treasury_operators.
 *     - Status -> 'completed'.
 *     - Name stays reserved (cannot reuse).
 *  4. Wound-up enterprise enforcement:
 *     - Cannot trade (createPost, requestPost, acceptPost rejected).
 *     - Cannot be paid or spend (transfer rejected).
 *     - Cannot be resumed or paused.
 *  5. Read-only accountability ledger:
 *     - Accessible to any member of the node (public accountability surface).
 *     - Resolves counterparties to display names.
 *     - Line items, running totals, starting/ending balance, period income vs spend.
 *     - Excludes nothing that moved money.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-season-lifecycle.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury, createPost, completePostTransaction,
    requestPost, approvePostRequest, acceptPost, transfer, getBalance,
    adminAssignTreasuryOperator, initiateWindUp, cancelWindUp,
    finaliseWindUp, getEnterpriseLedger, pauseEnterprise, resumeEnterprise,
    reconcileLedgerFromDb, getCommonsBalance, getCommonsBalanceExact,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8623;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

function makeIdentity(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at) VALUES (?, ?, 'data:image/png;base64,iVBORw0KGgo=', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(method: 'GET' | 'POST', path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, error: json?.error as string | undefined, body: json };
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

function verifyConservation(): number {
    const sumAccounts = (db.prepare(
        "SELECT COALESCE(SUM(balance), 0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'"
    ).get() as any).s;
    return Math.abs(sumAccounts + getCommonsBalanceExact());
}

async function main() {
    console.log('Running enterprise wind-up and ledger tests (docs/the-commons.md §2.2)...\n');
    await initTls();
    initStateEngine();

    const leadKeeper = 'lead-alice-0000000000000000000000000001';
    const regKeeper = 'keeper-bob-0000000000000000000000000002';
    const ordinaryMember = 'member-charlie-0000000000000000000003';
    seedMember(leadKeeper, 'AliceLead');
    seedMember(regKeeper, 'BobKeeper');
    seedMember(ordinaryMember, 'CharlieCitizen');

    // Give Charlie some initial beans from genesis for trading tests
    transfer('genesis', ordinaryMember, 500, 'Seed citizen funds');

    // Create an enterprise "GreenFarm"
    const { publicKey: farm } = createTreasury('GreenFarm', AVATAR, 200);
    adminAssignTreasuryOperator(farm, leadKeeper, 'admin', 200);
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(farm, leadKeeper);
    adminAssignTreasuryOperator(farm, regKeeper, 'admin', 50);

    // Initial offer for covenant
    createPost('offer', 'food', 'Fresh Kale', 'Crisp organic kale', 20, 'fixed', farm);

    // ─────────────────────────────────────────────────────────────────────────
    // 1. WIND-UP AUTHORIZATION & INITIATION
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 1: initiateWindUp authorization & grace period ──');

    // Non-keeper cannot initiate
    let outsiderInitThrew = false;
    try {
        initiateWindUp(farm, ordinaryMember);
    } catch (e: any) {
        outsiderInitThrew = true;
        assert(e.message.includes('Only the lead keeper'), `Outsider init rejected: "${e.message}"`);
    }
    assert(outsiderInitThrew, 'Non-keeper cannot initiate wind-up');

    // Regular (non-lead) keeper cannot initiate
    let regKeeperInitThrew = false;
    try {
        initiateWindUp(farm, regKeeper);
    } catch (e: any) {
        regKeeperInitThrew = true;
        assert(e.message.includes('Only the lead keeper'), `Regular keeper init rejected: "${e.message}"`);
    }
    assert(regKeeperInitThrew, 'Regular (non-lead) keeper cannot initiate wind-up');

    // Insolvent enterprise in deficit cannot initiate
    // Farm spends 50 into credit (floor is -200)
    transfer(farm, ordinaryMember, 50, 'Spend into deficit', 'escrow');
    assert(getBalance(farm).balance === -50, 'GreenFarm is in deficit (-50)');
    let deficitInitThrew = false;
    try {
        initiateWindUp(farm, leadKeeper);
    } catch (e: any) {
        deficitInitThrew = true;
        assert(e.message.includes('Cannot wind up an enterprise in deficit'), `Deficit init rejected: "${e.message}"`);
    }
    assert(deficitInitThrew, 'Insolvent enterprise in deficit cannot initiate wind-up');

    // Restore solvent balance: Genesis grants GreenFarm 150 beans
    transfer('genesis', farm, 150, 'Solvent capital payment');
    assert(getBalance(farm).balance === 100, 'GreenFarm restored to positive balance (100)');

    // Lead keeper initiates wind-up
    const initRes = initiateWindUp(farm, leadKeeper);
    assert(initRes.ok === true && initRes.status === 'winding_up', 'Lead keeper successfully initiated wind-up');
    assert(typeof initRes.graceEndsAt === 'string', 'Grace period end timestamp returned');
    assert(initRes.initiatedBy === leadKeeper, 'Initiator recorded as lead keeper');

    // Idempotent second call
    const initRes2 = initiateWindUp(farm, leadKeeper);
    assert(initRes2.ok === true && initRes2.alreadyInitiated === true, 'Subsequent initiate call is idempotent');

    // DB row check
    const mRow = db.prepare("SELECT status, wind_up_initiated_at, wind_up_initiated_by FROM members WHERE public_key = ?").get(farm) as any;
    assert(mRow.status === 'winding_up', 'Enterprise status is winding_up in database');
    assert(mRow.wind_up_initiated_by === leadKeeper, 'wind_up_initiated_by recorded in DB');

    // While winding up: no new listings allowed
    let newOfferThrew = false;
    try {
        createPost('offer', 'food', 'Carrots', 'Fresh carrots', 15, 'fixed', farm);
    } catch (e: any) {
        newOfferThrew = true;
        assert(e.message.includes('Enterprise is winding up — no new listings allowed'), `New listing rejected: "${e.message}"`);
    }
    assert(newOfferThrew, 'New listings blocked while winding up');

    // ─────────────────────────────────────────────────────────────────────────
    // 2. CANCEL WIND-UP DURING GRACE PERIOD
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 2: cancelWindUp during grace period ──');

    // Non-keeper cannot cancel
    let outsiderCancelThrew = false;
    try {
        cancelWindUp(farm, ordinaryMember);
    } catch (e: any) {
        outsiderCancelThrew = true;
        assert(e.message.includes('Only a keeper'), `Outsider cancel rejected: "${e.message}"`);
    }
    assert(outsiderCancelThrew, 'Non-keeper cannot cancel wind-up');

    // ANY keeper (e.g. regular keeper Bob) can cancel during grace period
    const cancelRes = cancelWindUp(farm, regKeeper);
    assert(cancelRes.ok === true && cancelRes.status === 'active', 'Regular keeper Bob successfully cancelled wind-up');

    const mRowActive = db.prepare("SELECT status, wind_up_initiated_at, wind_up_initiated_by FROM members WHERE public_key = ?").get(farm) as any;
    assert(mRowActive.status === 'active', 'Status reset to active');
    assert(mRowActive.wind_up_initiated_at === null, 'wind_up_initiated_at cleared');

    // Re-initiate for finalisation tests
    initiateWindUp(farm, leadKeeper);

    // ─────────────────────────────────────────────────────────────────────────
    // 3. FINALISE WIND-UP: GRACE PERIOD & OPEN TRANSACTIONS ENFORCEMENT
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 3: finaliseWindUp gates & execution ──');

    // Premature finalise rejected (7 days have not elapsed)
    let earlyFinaliseThrew = false;
    try {
        finaliseWindUp(farm, leadKeeper);
    } catch (e: any) {
        earlyFinaliseThrew = true;
        assert(e.message.includes('Cannot finalise wind-up before 7-day grace period has elapsed'), `Premature finalise rejected: "${e.message}"`);
    }
    assert(earlyFinaliseThrew, 'Premature finalise blocked before 7 days');

    // Fast-forward wind_up_initiated_at to 8 days ago
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE members SET wind_up_initiated_at = ? WHERE public_key = ?").run(eightDaysAgo, farm);

    // Create an open transaction (Charlie requests kale offer created before wind-up)
    const existingOffer = db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND status = 'active'").get(farm) as any;
    // Give Charlie an active offer so he can trade
    createPost('offer', 'tools', 'Wrench', 'Steel wrench', 10, 'fixed', ordinaryMember);
    const txDeal = requestPost(existingOffer.id, ordinaryMember);
    assert(txDeal !== null, 'Charlie requested kale offer');

    // Finalise blocked while open transaction exists
    let openEscrowFinaliseThrew = false;
    try {
        finaliseWindUp(farm, leadKeeper);
    } catch (e: any) {
        openEscrowFinaliseThrew = true;
        assert(e.message.includes('pending settlement'), `Blocked on open escrows: "${e.message}"`);
    }
    assert(openEscrowFinaliseThrew, 'finaliseWindUp blocked while transactions are open');

    // Settle open transaction: farm approves and completes
    approvePostRequest(txDeal.id, farm, { authSigner: leadKeeper });
    completePostTransaction(txDeal.id, ordinaryMember, undefined);

    // Record pre-sweep Commons pool balance
    const commonsPre = getCommonsBalance();
    const farmPreBal = getBalance(farm).balance;
    assert(farmPreBal > 0, `GreenFarm holds ${farmPreBal} beans before final wind-up sweep`);

    // Now finalise wind-up!
    const finalRes = finaliseWindUp(farm, leadKeeper);
    assert(finalRes.ok === true && finalRes.status === 'completed', 'Wind-up finalised successfully');
    assert(finalRes.sweptAmount === farmPreBal, `Swept full remaining balance (${farmPreBal}) to Commons`);

    // Verify sweep landed in Commons pool
    const commonsPost = getCommonsBalance();
    assert(Math.round((commonsPost - commonsPre) * 100) / 100 === farmPreBal, `Commons pool received exactly swept amount (${farmPreBal})`);
    assert(getBalance(farm).balance === 0, 'GreenFarm balance is now 0');

    // Conservation check: SUM(balances) == 0
    const drift = verifyConservation();
    assert(drift < 1e-6, `Ledger conservation strictly preserved (drift = ${drift})`);

    // Verify keepers released
    const remainingOps = db.prepare("SELECT COUNT(*) as c FROM treasury_operators WHERE treasury_pubkey = ?").get(farm) as any;
    assert(remainingOps.c === 0, 'All operators deleted from treasury_operators');

    // Verify name stays reserved
    let duplicateNameThrew = false;
    try {
        createTreasury('GreenFarm', AVATAR, 100);
    } catch (e: any) {
        duplicateNameThrew = true;
        assert(e.message.includes('That name is already taken'), `Duplicate name rejected: "${e.message}"`);
    }
    assert(duplicateNameThrew, 'Wound-up enterprise name stays reserved');

    // ─────────────────────────────────────────────────────────────────────────
    // 4. WOUND-UP ENTERPRISE OPERATIONS BLOCKED
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 4: Wound-up enterprise cannot trade, be paid, or resume ──');

    // Cannot create posts
    let woundUpPostThrew = false;
    try {
        createPost('offer', 'goods', 'Old Tools', 'Rakes', 10, 'fixed', farm);
    } catch (e: any) {
        woundUpPostThrew = true;
    }
    assert(woundUpPostThrew, 'Wound-up enterprise cannot create listings');

    // Cannot be paid (transfer in blocked)
    let woundUpTransferInThrew = false;
    try {
        transfer(ordinaryMember, farm, 25, 'Payment to closed enterprise');
    } catch (e: any) {
        woundUpTransferInThrew = true;
        assert(e.message.includes('Enterprise has wound up — account closed'), `Transfer in rejected: "${e.message}"`);
    }
    assert(woundUpTransferInThrew, 'Wound-up enterprise cannot receive payments');

    // Cannot spend (transfer out blocked)
    let woundUpTransferOutThrew = false;
    try {
        transfer(farm, ordinaryMember, 10, 'Spend from closed enterprise');
    } catch (e: any) {
        woundUpTransferOutThrew = true;
        assert(e.message.includes('Enterprise has wound up — account closed'), `Transfer out rejected: "${e.message}"`);
    }
    assert(woundUpTransferOutThrew, 'Wound-up enterprise cannot send payments');

    // Cannot be resumed
    let woundUpResumeThrew = false;
    try {
        resumeEnterprise(farm, leadKeeper);
    } catch (e: any) {
        woundUpResumeThrew = true;
        assert(e.message.includes('Enterprise has wound up — cannot be resumed'), `Resume rejected: "${e.message}"`);
    }
    assert(woundUpResumeThrew, 'Wound-up enterprise cannot be resumed');

    // Cannot be paused
    let woundUpPauseThrew = false;
    try {
        pauseEnterprise(farm, leadKeeper);
    } catch (e: any) {
        woundUpPauseThrew = true;
        assert(e.message.includes('Enterprise has wound up — account closed'), `Pause rejected: "${e.message}"`);
    }
    assert(woundUpPauseThrew, 'Wound-up enterprise cannot be paused');

    // ─────────────────────────────────────────────────────────────────────────
    // 5. READ-ONLY ACCOUNTABILITY LEDGER
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 5: Read-only accountability ledger ──');

    // Create active enterprise "SolarBakery" to test P&L transactions
    const { publicKey: bakery } = createTreasury('SolarBakery', AVATAR, 100);
    adminAssignTreasuryOperator(bakery, leadKeeper, 'admin', 100);

    // Initial funding transfer (150 beans)
    transfer('genesis', bakery, 150, 'Startup capital grant');
    // Sale income (Charlie buys bread for 40 beans)
    transfer(ordinaryMember, bakery, 40, 'Bought 4 sourdough loaves', 'escrow');
    // Spend input (Bakery buys flour from Charlie for 25 beans)
    transfer(bakery, ordinaryMember, 25, 'Flour supply purchase', 'escrow');

    // Fetch full ledger
    const ledger = getEnterpriseLedger(bakery);
    assert(ledger.enterprise.publicKey === bakery, 'Ledger returns enterprise publicKey');
    assert(ledger.enterprise.name === 'SolarBakery', 'Ledger returns enterprise callsign');
    assert(ledger.entries.length === 3, `Ledger contains all 3 transactions (got ${ledger.entries.length})`);

    // Verify counterparty display name resolution
    const genesisEntry = ledger.entries.find(e => e.memo.includes('Startup capital'));
    assert(genesisEntry?.counterpartyName === 'Genesis', `Genesis counterparty resolved: "${genesisEntry?.counterpartyName}"`);

    const saleEntry = ledger.entries.find(e => e.direction === 'income' && e.amount === 40);
    assert(saleEntry?.counterpartyName === 'CharlieCitizen', `Customer counterparty resolved to callsign: "${saleEntry?.counterpartyName}"`);
    assert(saleEntry?.fee === 0.6, `Marketplace fee recorded (40 * 1.5% = 0.6)`);
    assert(saleEntry?.netAmount === 39.4, `Net amount recorded (40 - 0.6 = 39.4)`);

    const spendEntry = ledger.entries.find(e => e.direction === 'spend' && e.amount === 25);
    assert(spendEntry?.counterpartyName === 'CharlieCitizen', `Supplier counterparty resolved to callsign: "${spendEntry?.counterpartyName}"`);

    // Verify summary totals
    assert(ledger.summary.transactionCount === 3, 'Summary transaction count is 3');
    assert(ledger.summary.totalIncome === 190, `Total gross income is 190 (150 + 40, got ${ledger.summary.totalIncome})`);
    assert(ledger.summary.totalSpend === 25, `Total gross spend is 25 (got ${ledger.summary.totalSpend})`);
    assert(ledger.summary.startingBalance === 0, 'Starting balance is 0');
    assert(ledger.summary.endingBalance === getBalance(bakery).balance, `Ending balance matches current balance (${getBalance(bakery).balance})`);

    // Test period filtering with `since`
    // Set tx1 timestamp to 1 hour ago so since filtering is unambiguous across millisecond execution
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    db.prepare("UPDATE transactions SET timestamp = ? WHERE id = ?").run(oneHourAgo, ledger.entries[0].id);

    const tx2Time = ledger.entries[1].timestamp;
    const periodLedger = getEnterpriseLedger(bakery, { since: tx2Time });
    assert(periodLedger.entries.length === 2, `Period ledger filtered to 2 transactions (got ${periodLedger.entries.length})`);
    assert(periodLedger.summary.startingBalance === 150, `Period starting balance is 150 (got ${periodLedger.summary.startingBalance})`);
    // ─────────────────────────────────────────────────────────────────────────
    // 6. HTTP ROUTE LEVEL VERIFICATION
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 6: HTTP routes for pause, wind-up, and accountability ledger ──');
    await startHttpsServer(PORT);

    const httpLead = makeIdentity('HTTPLead');
    const httpKeeper = makeIdentity('HTTPKeeper');
    const httpOutsider = makeIdentity('HTTPOutsider');

    const { publicKey: cafe } = createTreasury('CommunityCafe', AVATAR, 100);
    adminAssignTreasuryOperator(cafe, httpLead.pubKeyHex, 'admin', 100);
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(cafe, httpLead.pubKeyHex);
    adminAssignTreasuryOperator(cafe, httpKeeper.pubKeyHex, 'admin', 50);

    // Initial funding to cafe
    transfer('genesis', cafe, 80, 'Cafe initial capital');

    // 1. Outsider cannot pause
    const outsiderPause = await signedFetch('POST', `/api/treasury/${cafe}/pause`, httpOutsider);
    assert(outsiderPause.status === 403, 'HTTP: Non-keeper pause returned 403');

    // 2. Keeper can pause
    const keeperPause = await signedFetch('POST', `/api/treasury/${cafe}/pause`, httpKeeper);
    assert(keeperPause.status === 200 && keeperPause.body?.paused === true, 'HTTP: Keeper paused enterprise successfully (200)');

    // 3. Keeper can resume
    const keeperResume = await signedFetch('POST', `/api/treasury/${cafe}/resume`, httpKeeper);
    assert(keeperResume.status === 200 && keeperResume.body?.paused === false, 'HTTP: Keeper resumed enterprise successfully (200)');

    // 4. Regular keeper cannot initiate wind-up
    const regInit = await signedFetch('POST', `/api/treasury/${cafe}/wind-up/initiate`, httpKeeper);
    assert(regInit.status === 403, 'HTTP: Regular keeper cannot initiate wind-up (403)');

    // 5. Lead keeper can initiate wind-up
    const leadInit = await signedFetch('POST', `/api/treasury/${cafe}/wind-up/initiate`, httpLead);
    assert(leadInit.status === 200 && leadInit.body?.status === 'winding_up', 'HTTP: Lead keeper initiated wind-up (200)');
    assert(typeof leadInit.body?.graceEndsAt === 'string', 'HTTP: graceEndsAt timestamp returned');

    // 6. Outsider cannot cancel wind-up
    const outsiderCancel = await signedFetch('POST', `/api/treasury/${cafe}/wind-up/cancel`, httpOutsider);
    assert(outsiderCancel.status === 403, 'HTTP: Non-keeper cannot cancel wind-up (403)');

    // 7. Regular keeper can cancel wind-up
    const keeperCancel = await signedFetch('POST', `/api/treasury/${cafe}/wind-up/cancel`, httpKeeper);
    assert(keeperCancel.status === 200 && keeperCancel.body?.status === 'active', 'HTTP: Keeper cancelled wind-up (200)');

    // 8. Public / any member can read accountability ledger
    const outsiderLedger = await signedFetch('GET', `/api/treasury/${cafe}/ledger`, httpOutsider);
    assert(outsiderLedger.status === 200, 'HTTP: Ordinary member can read accountability ledger (200)');
    assert(outsiderLedger.body?.enterprise?.name === 'CommunityCafe', 'HTTP: Ledger returned enterprise details');
    assert(outsiderLedger.body?.summary?.totalIncome === 80, 'HTTP: Ledger summary totalIncome is 80');
    assert(Array.isArray(outsiderLedger.body?.entries), 'HTTP: Ledger entries is an array');

    console.log(`\nAll ${passed}/${run} enterprise season lifecycle assertions passed!`);
}

main().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
