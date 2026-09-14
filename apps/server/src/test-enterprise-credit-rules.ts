/**
 * Enterprise Credit Model Rules (docs/the-commons.md §2.4)
 *
 * Rules 5, 6, and 7:
 *   Rule 5: Credit buys inputs, profit pays people.
 *   Rule 6: Keeper pay capped by earned surplus; deferred wage claims.
 *   Rule 7: Automatic sweep to Commons pool above working capital ceiling.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-credit-rules.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury, createPost, completePostTransaction,
    requestPost, approvePostRequest, transfer, getBalance,
} from './state-engine.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

function assignKeeper(treasury: string, keeper: string, role = 'keeper') {
    db.prepare(`INSERT OR IGNORE INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by) VALUES (?, ?, ?, 'admin')`).run(treasury, keeper, role);
    db.prepare(`UPDATE members SET can_operate = 1 WHERE public_key = ?`).run(keeper);
}

const bal = (pk: string) => getBalance(pk).balance;

async function main() {
    console.log('Running enterprise credit model tests (Rules 5, 6, 7)...\n');
    await initTls();
    initStateEngine();

    // ─────────────────────────────────────────────────────────────────────────────
    // RULE 5: Credit buys inputs, profit pays people
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('── Rule 5: Credit buys inputs, profit pays people ──');

    const { publicKey: eggs } = createTreasury('CommunityEggs', AVATAR, 200);
    const aliceKeeper = 'alice-keeper-000000000000000000000000000001';
    const bobNonKeeper = 'bob-supplier-000000000000000000000000000002';
    seedMember(aliceKeeper, 'AliceKeeper');
    seedMember(bobNonKeeper, 'BobSupplier');
    assignKeeper(eggs, aliceKeeper);

    // Initial state: CommunityEggs has 0 balance and 200 credit line (floor = -200)
    assert(bal(eggs) === 0, 'CommunityEggs starts at 0 balance');

    // Need 1: Buying feed from outside supplier (non-keeper Bob)
    // Post requirement: must have at least one active offer for the covenant
    createPost('offer', 'food', 'Farm eggs', 'Fresh eggs', 10, 'fixed', eggs, undefined, undefined, undefined, true);
    const feedNeed = createPost('need', 'goods', 'Chicken feed 20kg', 'Organic grain', 30, 'fixed', eggs);
    assert(feedNeed !== null, 'Created feed need for CommunityEggs');

    // Test 1: A non-keeper payee can be paid into credit
    const bobBid = requestPost(feedNeed!.id, bobNonKeeper);
    const approveBob = approvePostRequest(bobBid.id, eggs);
    assert(approveBob !== null, 'Non-keeper payee can be paid into credit (escrow funded)');
    assert(bal(eggs) === -30, 'CommunityEggs spent into credit (-30) to buy inputs from non-keeper');

    // Complete transaction with Bob
    const bobComplete = completePostTransaction(bobBid.id, eggs);
    assert(bobComplete !== null, 'Non-keeper deal completed successfully');
    assert(bal(bobNonKeeper) === 29.55, 'Bob received payout minus community fee (30 - 1.5% = 29.55)');

    // Need 2: Labor from keeper Alice while CommunityEggs is in deficit (-30)
    const laborNeed = createPost('need', 'work', 'Coop cleaning', 'Clean roosts', 25, 'fixed', eggs);
    assert(laborNeed !== null, 'Created labor need for CommunityEggs');

    // Test 2: A keeper payee CANNOT be paid into credit
    const aliceBid = requestPost(laborNeed!.id, aliceKeeper);
    let keeperRefused = false;
    let refusalMessage = '';
    try {
        approvePostRequest(aliceBid.id, eggs);
    } catch (err: any) {
        keeperRefused = true;
        refusalMessage = err.message;
    }
    assert(keeperRefused, 'Keeper payee CANNOT be paid into credit');
    assert(
        refusalMessage.includes('CommunityEggs is in deficit and cannot borrow to pay its keepers'),
        `Refusal explains itself in volunteer terms: "${refusalMessage}"`
    );

    // Test 3: A sole keeper in deficit is refused with the intended message
    const { publicKey: soloEnterprise } = createTreasury('SoloFlock', AVATAR, 100);
    const soloKeeper = 'solo-keeper-000000000000000000000000000003';
    seedMember(soloKeeper, 'SoloKeeper');
    assignKeeper(soloEnterprise, soloKeeper);

    createPost('offer', 'goods', 'Solo craft', 'Craft goods', 15, 'fixed', soloEnterprise, undefined, undefined, undefined, true);
    const soloNeed = createPost('need', 'work', 'Solo flock tending', 'Feed flock', 20, 'fixed', soloEnterprise);
    const soloBid = requestPost(soloNeed!.id, soloKeeper);

    let soloRefused = false;
    let soloMsg = '';
    try {
        approvePostRequest(soloBid.id, soloEnterprise);
    } catch (err: any) {
        soloRefused = true;
        soloMsg = err.message;
    }
    assert(soloRefused, 'Sole keeper in deficit is refused');
    assert(
        soloMsg === 'SoloFlock is in deficit and cannot borrow to pay its keepers — credit buys inputs, but keepers can only be paid from profit.',
        `Sole keeper gets exact friendly refusal copy: "${soloMsg}"`
    );

    // ─────────────────────────────────────────────────────────────────────────────
    // RULE 6: Keeper pay capped by earned surplus & deferred wage claims
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Rule 6: Keeper pay capped by earned surplus & deferred claims ──');

    const { publicKey: solventTreasury } = createTreasury('SolventBakery', AVATAR, 100);
    const bakerKeeper = 'baker-keeper-000000000000000000000000000004';
    const customerCharlie = 'customer-charlie-000000000000000000000005';
    seedMember(bakerKeeper, 'BakerKeeper');
    seedMember(customerCharlie, 'CustomerCharlie');
    assignKeeper(solventTreasury, bakerKeeper);

    // Initial state: SolventBakery has 0 balance and 0 earned surplus
    const surplusOf = (pk: string) => Number((db.prepare('SELECT earned_surplus FROM members WHERE public_key=?').get(pk) as any)?.earned_surplus) || 0;
    assert(surplusOf(solventTreasury) === 0, 'SolventBakery starts with 0 earned surplus');

    // Seed positive balance for SolventBakery (e.g. 50 beans from genesis or grant)
    transfer('genesis', solventTreasury, 50, 'Seed grant / gift', 'direct', true);
    assert(bal(solventTreasury) === 50, 'SolventBakery has positive balance of 50 from grant');
    assert(surplusOf(solventTreasury) === 0, 'Grants and gifts do NOT increment earned surplus (Rule 6)');

    // Offer: Sourdough bread for customers
    createPost('offer', 'food', 'Sourdough loaf', 'Fresh sourdough', 40, 'fixed', solventTreasury, undefined, undefined, undefined, true);

    // Need: Keeper labor for baking (20 beans)
    const bakingNeed = createPost('need', 'work', 'Bake shift', 'Early morning bake', 20, 'fixed', solventTreasury);
    const bakerBid = requestPost(bakingNeed!.id, bakerKeeper);

    // Test 4: Positive balance without earned surplus REFUSES keeper payment and records deferred claim
    let rule6Refused = false;
    let rule6Msg = '';
    try {
        approvePostRequest(bakerBid.id, solventTreasury);
    } catch (err: any) {
        rule6Refused = true;
        rule6Msg = err.message;
    }
    assert(rule6Refused, 'Keeper payment refused when earned surplus is 0 despite positive balance (Rule 6)');
    assert(
        rule6Msg.includes('has insufficient earned surplus (0 Beans) to pay keeper wages (20 Beans)'),
        `Refusal copy explains grant cannot become wages: "${rule6Msg}"`
    );

    // Verify deferred wage claim recorded in DB
    const claimRow = db.prepare('SELECT * FROM deferred_wage_claims WHERE enterprise_pubkey = ? AND keeper_pubkey = ?').get(solventTreasury, bakerKeeper) as any;
    assert(!!claimRow && claimRow.status === 'pending' && claimRow.amount === 20, 'Deferred wage claim recorded with pending status for 20 beans');

    // Regression Test 1: Wash trading prevention — sale to own keeper does NOT increment earned_surplus
    const { publicKey: washCoop } = createTreasury('WashCoop', AVATAR, 100);
    const washKeeper = 'wash-keeper-000000000000000000000000000007';
    const washExternalCustomer = 'wash-cust-000000000000000000000000000008';
    seedMember(washKeeper, 'WashKeeper');
    seedMember(washExternalCustomer, 'WashCustomer');
    assignKeeper(washCoop, washKeeper);
    createPost('offer', 'goods', 'Wash pottery', 'Handmade mugs', 30, 'fixed', washCoop, undefined, undefined, undefined, true);
    const washOffer = db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND type = 'offer'").get(washCoop) as any;
    // Wash keeper tries to buy from own enterprise
    transfer('genesis', washKeeper, 50, 'Seed WashKeeper', 'direct', true);
    createPost('offer', 'skills', 'Pottery lessons', 'Learn clay', 10, 'fixed', washKeeper, undefined, undefined, undefined, true);
    const keeperWashBid = requestPost(washOffer.id, washKeeper);
    approvePostRequest(keeperWashBid.id, washCoop);
    completePostTransaction(keeperWashBid.id, washKeeper);
    assert(surplusOf(washCoop) === 0, 'Wash trade with own keeper does NOT increment earned surplus (Rule 6 wash trading defense)');

    // External customer buys from WashCoop -> earned surplus DOES increment
    transfer('genesis', washExternalCustomer, 50, 'Seed WashCustomer', 'direct', true);
    createPost('offer', 'skills', 'Glazing help', 'Assist with glaze', 10, 'fixed', washExternalCustomer, undefined, undefined, undefined, true);
    const extBid = requestPost(washOffer.id, washExternalCustomer);
    approvePostRequest(extBid.id, washCoop);
    completePostTransaction(extBid.id, washExternalCustomer);
    assert(surplusOf(washCoop) === 30, 'Genuine sale to external customer increments earned surplus by 30');

    // Customer Charlie buys bread from SolventBakery for 40 beans (genuine external sale)
    transfer('genesis', customerCharlie, 100, 'Seed Charlie', 'direct', true);
    createPost('offer', 'skills', 'Gardening help', 'Weeding and pruning', 15, 'fixed', customerCharlie, undefined, undefined, undefined, true);
    const breadOffer = db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND type = 'offer'").get(solventTreasury) as any;
    const charlieBid = requestPost(breadOffer.id, customerCharlie);
    const approveCharlie = approvePostRequest(charlieBid.id, solventTreasury);
    assert(approveCharlie !== null, 'Customer Charlie deal approved');

    // Complete customer purchase
    const charlieComplete = completePostTransaction(charlieBid.id, customerCharlie);
    assert(charlieComplete !== null, 'Customer Charlie deal completed');
    // Sale of 40 beans increments earned surplus by 40 (Math.round(releaseCredits))
    // And automatically triggers processDeferredWageClaims(solventTreasury)!
    // The pending 20 bean claim is automatically paid:
    // - Baker receives 20 - 1.5% fee = 19.70 beans
    // - Surplus becomes 40 - 20 = 20 beans
    // - Bakery balance: 50 (initial grant) + 39.40 (net sale) - 20 (claim payout) = 69.40 beans
    const updatedClaim = db.prepare('SELECT * FROM deferred_wage_claims WHERE id = ?').get(claimRow.id) as any;
    assert(updatedClaim.status === 'paid', 'Deferred wage claim automatically paid upon incoming marketplace sale');
    assert(!!updatedClaim.paid_at, 'Deferred wage claim has paid_at timestamp recorded');
    assert(bal(bakerKeeper) === 19.70, 'Baker keeper received deferred payout minus 1.5% fee (19.70)');
    assert(surplusOf(solventTreasury) === 20, 'SolventBakery earned surplus is now 20 (40 earned - 20 paid)');
    assert(bal(solventTreasury) === 69.40, 'SolventBakery balance is 69.40 (50 grant + 39.40 sale - 20 payout)');

    // Test 5: With positive balance AND earned surplus (20), keeper wage of 15 CAN be approved directly
    const shift2Need = createPost('need', 'work', 'Evening shift', 'Close bakery', 15, 'fixed', solventTreasury);
    const bakerBid2 = requestPost(shift2Need!.id, bakerKeeper);
    const approveBaker2 = approvePostRequest(bakerBid2.id, solventTreasury);
    assert(approveBaker2 !== null, 'Keeper payment succeeds directly when balance and earned surplus suffice');
    assert(surplusOf(solventTreasury) === 5, 'Earned surplus decremented to 5 (20 - 15) upon keeper escrow approval');
    assert(bal(solventTreasury) === 54.40, 'SolventBakery balance held 15 in escrow (69.40 - 15 = 54.40)');

    // Complete shift 2
    completePostTransaction(bakerBid2.id, solventTreasury);
    assert(bal(bakerKeeper) === Math.round((19.70 + 14.775) * 100) / 100, 'Baker received second payment minus fee (34.48)');

    // ─────────────────────────────────────────────────────────────────────────────
    // RULE 7: Automatic sweep to Commons pool above working capital ceiling
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Rule 7: Automatic sweep to Commons above working capital ceiling ──');

    const { publicKey: cider } = createTreasury('CommunityCider', AVATAR, 100, { workingCapitalCeiling: 100 });
    const daveKeeper = 'dave-keeper-000000000000000000000000000006';
    seedMember(daveKeeper, 'DaveKeeper');
    assignKeeper(cider, daveKeeper);

    const ceilingOf = (pk: string) => (db.prepare('SELECT working_capital_ceiling FROM members WHERE public_key=?').get(pk) as any)?.working_capital_ceiling;
    assert(ceilingOf(cider) === 100, 'CommunityCider initialized with working_capital_ceiling = 100');
    assert(bal(cider) === 0, 'CommunityCider starts at 0 balance');

    // Transfer 80 beans to Cider (under ceiling 100) -> no sweep
    transfer('genesis', cider, 80, 'Seed cider coop', 'direct', true);
    assert(bal(cider) === 80, 'CommunityCider holds 80 beans (below 100 ceiling, no sweep)');

    // Transfer another 50 beans to Cider (80 + 50 = 130 > 100) -> excess 30 sweeps automatically!
    transfer('genesis', cider, 50, 'Additional capital', 'direct', true);
    assert(bal(cider) === 100, 'CommunityCider balance automatically capped at ceiling 100 (30 swept to Commons)');

    // Complete a sale on Cider: sells cider for 40 beans
    createPost('offer', 'drinks', 'Apple cider 6-pack', 'Fresh pressed', 40, 'fixed', cider, undefined, undefined, undefined, true);
    const ciderOffer = db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND type = 'offer'").get(cider) as any;
    const charlieCiderBid = requestPost(ciderOffer.id, customerCharlie);
    approvePostRequest(charlieCiderBid.id, cider);
    completePostTransaction(charlieCiderBid.id, customerCharlie);

    // Sale of 40 beans nets 39.40. Since balance was at 100, the full net proceeds of 39.40 sweep to Commons!
    assert(bal(cider) === 100, 'After sale, balance above ceiling immediately sweeps to Commons, leaving balance at 100');

    // Admin updates ceiling: lowers ceiling to 60
    db.prepare('UPDATE members SET working_capital_ceiling = ? WHERE public_key = ?').run(60, cider);
    const { sweepEnterpriseCeiling } = await import('./state-engine.js');
    const sweptAmount = sweepEnterpriseCeiling(cider);
    assert(sweptAmount === 40, 'Admin lowering ceiling sweeps excess (100 - 60 = 40) to Commons');
    assert(bal(cider) === 60, 'CommunityCider balance reduced to new ceiling of 60');

    // Rule 7 constraint: The ceiling must NOT be editable by the enterprise's own keepers (admin-only for now)
    const keeperEndpoints = ['/api/treasury/:treasury/offer', '/api/treasury/:treasury/need', '/api/treasury/:treasury/approve', '/api/treasury/:treasury/complete', '/api/treasury/:treasury/sweep'];
    assert(!keeperEndpoints.some(e => e.includes('ceiling')), 'No keeper routes expose ceiling modification');

    // Existing enterprise without ceiling (e.g. CommunityEggs) defaults to NULL and is uncapped
    assert(ceilingOf(eggs) === null, 'Existing enterprise (CommunityEggs) has working_capital_ceiling = NULL (uncapped)');

    // Conservation check
    const { runLedgerAudit } = await import('./state-engine.js');
    const audit = runLedgerAudit();
    assert(audit.ok, `Ledger audit passed: sum(balances)=${audit.sumBalances}, drift=${audit.drift}`);
    assert(Math.abs(audit.drift) < 0.0001, 'Ledger conservation strictly preserved (SUM(balances) + COMMONS_POOL = 0)');

    console.log(`\n${passed}/${run} checks passed.`);
    console.log('⭐️ Enterprise credit model Rules 5, 6, and 7 checks PASSED.');
    process.exit(0);
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
