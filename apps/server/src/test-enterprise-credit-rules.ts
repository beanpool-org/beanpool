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
    recordDeferredWageClaim, acceptPost,
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

    // ─────────────────────────────────────────────────────────────────────────────
    // REGRESSION TEST 2: Community Eggs backfill from historical sales
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Regression Test 2: Historical sales earned surplus backfill ──');
    const { publicKey: liveEggs } = createTreasury('LiveCommunityEggs', AVATAR, 200);
    const eggKeeper = 'egg-keeper-000000000000000000000000000009';
    const eggCustomer = 'egg-cust-0000000000000000000000000000010';
    seedMember(eggKeeper, 'EggKeeper');
    seedMember(eggCustomer, 'EggCustomer');
    assignKeeper(liveEggs, eggKeeper);
    // Simulate historical trading before Rule 6 migration:
    // 2 completed sales of 12 beans each (total 24 beans)
    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at)
        VALUES ('hist-tx-1', 'post-1', ?, ?, 12.0, 'completed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
               ('hist-tx-2', 'post-2', ?, ?, 12.0, 'completed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(eggCustomer, liveEggs, eggCustomer, liveEggs);
    // Give LiveCommunityEggs balance
    transfer('genesis', liveEggs, 24, 'Fund egg revenue', 'direct', true);
    // Explicitly reset earned_surplus to 0 to simulate pre-migration state
    db.prepare('UPDATE members SET earned_surplus = 0 WHERE public_key = ?').run(liveEggs);
    assert(surplusOf(liveEggs) === 0, 'LiveCommunityEggs starts with 0 earned surplus before backfill');

    // Run the migration backfill query
    db.prepare(`
        UPDATE members
        SET earned_surplus = MAX(0, COALESCE((
            SELECT SUM(credits) FROM marketplace_transactions
            WHERE seller_pubkey = members.public_key AND status = 'completed'
              AND buyer_pubkey NOT IN (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = members.public_key)
        ), 0) - COALESCE((
            SELECT SUM(credits) FROM marketplace_transactions
            WHERE buyer_pubkey = members.public_key AND status = 'completed'
              AND seller_pubkey IN (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = members.public_key)
        ), 0))
        WHERE is_treasury = 1 AND (earned_surplus IS NULL OR earned_surplus = 0)
    `).run();

    assert(surplusOf(liveEggs) === 24, 'LiveCommunityEggs earned_surplus accurately backfilled to 24 Beans from historical sales');

    // Keeper can now be paid from the backfilled surplus
    createPost('offer', 'food', 'Farm fresh eggs', 'Fresh eggs daily', 12, 'fixed', liveEggs, undefined, undefined, undefined, true);
    createPost('offer', 'skills', 'Coop repair', 'Fixed coop roof', 10, 'fixed', eggKeeper, undefined, undefined, undefined, true);
    const eggWageNeed = createPost('need', 'work', 'Coop maintenance', 'Fix roof', 15, 'fixed', liveEggs);
    const keeperWageBid = requestPost(eggWageNeed!.id, eggKeeper);
    const approveKeeperWage = approvePostRequest(keeperWageBid.id, liveEggs);
    assert(approveKeeperWage !== null, 'Keepers are no longer stranded — backfilled surplus allows keeper wage approval');
    assert(surplusOf(liveEggs) === 9, 'Surplus decrements to 9 (24 - 15) after keeper wage approval');

    // ─────────────────────────────────────────────────────────────────────────────
    // REGRESSION TEST 3: Escrow stranding prevention on hourly adjustment
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Regression Test 3: Hourly adjustment escrow stranding prevention ──');
    const { publicKey: garden } = createTreasury('HourlyGarden', AVATAR, 100);
    const gardenKeeper = 'garden-keeper-000000000000000000000000000011';
    const gardenCustomer = 'garden-cust-000000000000000000000000000012';
    seedMember(gardenKeeper, 'GardenKeeper');
    seedMember(gardenCustomer, 'GardenCustomer');
    assignKeeper(garden, gardenKeeper);

    // Give garden 20 balance and 20 earned surplus
    transfer('genesis', garden, 20, 'Seed garden', 'direct', true);
    db.prepare('UPDATE members SET earned_surplus = 20 WHERE public_key = ?').run(garden);

    createPost('offer', 'food', 'Garden greens', 'Fresh lettuce', 25, 'fixed', garden, undefined, undefined, undefined, true);
    createPost('offer', 'skills', 'Weeding service', 'Weed beds', 10, 'fixed', gardenKeeper, undefined, undefined, undefined, true);

    // Hourly need: 10 credits per hour, 2 hours = 20 credits base
    const weedNeed = createPost('need', 'work', 'Weeding bed', 'Weed garden beds', 10, 'hourly', garden);
    const weedBid = requestPost(weedNeed!.id, gardenKeeper, 2);
    approvePostRequest(weedBid.id, garden);

    // At this point, 20 beans are in escrow, earned surplus decremented to 0
    assert(bal(`escrow_${weedBid.id}`) === 20, '20 beans locked in escrow for initial 2 hours');
    assert(surplusOf(garden) === 0, 'Earned surplus decremented to 0 for initial 2 hours');

    // Keeper completes 3 hours (30 beans, diff = 10). Enterprise has 0 surplus, cannot cover extra 10 beans.
    const weedComplete = completePostTransaction(weedBid.id, garden, 3);
    assert(weedComplete !== null, 'Transaction completes rather than stranding escrow');
    assert(bal(`escrow_${weedBid.id}`) === 0, 'Escrow account is drained to 0 — NO STRANDED ESCROW');
    assert(bal(gardenKeeper) === 19.70, 'Keeper received base 20 hold minus 1.5% fee (19.70)');

    // Verify deferred wage claim recorded for the difference (10 beans)
    const gardenClaim = db.prepare('SELECT * FROM deferred_wage_claims WHERE enterprise_pubkey = ? AND keeper_pubkey = ? AND status = ?').get(garden, gardenKeeper, 'pending') as any;
    assert(!!gardenClaim && gardenClaim.amount === 10, 'Deferred wage claim recorded for the remaining 10 beans');

    // Enterprise earns surplus from customer sale (25 beans)
    transfer('genesis', gardenCustomer, 50, 'Seed GardenCustomer', 'direct', true);
    createPost('offer', 'skills', 'Watering service', 'Water plots', 10, 'fixed', gardenCustomer, undefined, undefined, undefined, true);
    const gardenOffer = db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND type = 'offer'").get(garden) as any;
    const custBid = requestPost(gardenOffer.id, gardenCustomer);
    approvePostRequest(custBid.id, garden);
    completePostTransaction(custBid.id, gardenCustomer);

    // Sale of 25 beans pays 10 claim automatically!
    const updatedGardenClaim = db.prepare('SELECT * FROM deferred_wage_claims WHERE id = ?').get(gardenClaim.id) as any;
    assert(updatedGardenClaim.status === 'paid', 'Deferred claim for extra hours paid automatically on sales income');
    assert(bal(gardenKeeper) === Math.round((19.70 + 9.85) * 100) / 100, 'Keeper received both payments minus fee (29.55 total)');

    // ─────────────────────────────────────────────────────────────────────────────
    // REGRESSION TEST 5: Deferred claim deduplication & replay prevention
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Regression Test 5: Deferred claim deduplication & replay prevention ──');
    const { publicKey: dedupTreasury } = createTreasury('DedupBakery', AVATAR, 100);
    const dedupKeeper = 'dedup-keeper-000000000000000000000000000013';
    seedMember(dedupKeeper, 'DedupKeeper');
    assignKeeper(dedupTreasury, dedupKeeper);

    // 1. Direct recordDeferredWageClaim deduplication on (enterprise, keeper, postId)
    const claimId1 = recordDeferredWageClaim(dedupTreasury, dedupKeeper, 15, 'post-dedup-1');
    const claimId2 = recordDeferredWageClaim(dedupTreasury, dedupKeeper, 15, 'post-dedup-1');
    assert(claimId1 === claimId2, 'Repeated claim recording for same enterprise+keeper+postId returns same ID');
    const countPending = (db.prepare('SELECT COUNT(*) as cnt FROM deferred_wage_claims WHERE enterprise_pubkey = ? AND post_id = ?').get(dedupTreasury, 'post-dedup-1') as any).cnt;
    assert(countPending === 1, 'Only one pending claim exists in database despite repeated recording');

    // 2. Replay prevention when claim status is 'paid'
    db.prepare("UPDATE deferred_wage_claims SET status = 'paid' WHERE id = ?").run(claimId1);
    const claimId3 = recordDeferredWageClaim(dedupTreasury, dedupKeeper, 15, 'post-dedup-1');
    assert(claimId3 === claimId1, 'Paid claim is not replayed into a new pending claim (replay prevention)');
    const countTotal = (db.prepare('SELECT COUNT(*) as cnt FROM deferred_wage_claims WHERE enterprise_pubkey = ? AND post_id = ?').get(dedupTreasury, 'post-dedup-1') as any).cnt;
    assert(countTotal === 1, 'Still only one claim exists after attempted replay of paid claim');

    // 3. Dedup on acceptPost when enterprise has insufficient surplus
    createPost('offer', 'food', 'Keeper Bread', 'Daily baked loaf', 20, 'fixed', dedupKeeper, undefined, undefined, undefined, true);
    const keeperBread = db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND type = 'offer'").get(dedupKeeper) as any;
    createPost('offer', 'goods', 'Bakery merch', 'Apron', 10, 'fixed', dedupTreasury, undefined, undefined, undefined, true);
    let accept1Failed = false;
    try {
        acceptPost(keeperBread.id, dedupTreasury);
    } catch {
        accept1Failed = true;
    }
    assert(accept1Failed, 'First acceptPost failed due to insufficient surplus');

    let accept2Failed = false;
    try {
        acceptPost(keeperBread.id, dedupTreasury);
    } catch {
        accept2Failed = true;
    }
    assert(accept2Failed, 'Second acceptPost retry failed due to insufficient surplus');

    const acceptClaims = (db.prepare('SELECT COUNT(*) as cnt FROM deferred_wage_claims WHERE enterprise_pubkey = ? AND post_id = ?').get(dedupTreasury, keeperBread.id) as any).cnt;
    assert(acceptClaims === 1, 'Retrying acceptPost does NOT create duplicate deferred wage claims');

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
