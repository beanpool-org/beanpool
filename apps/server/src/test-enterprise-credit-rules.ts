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

    // Test 4: A keeper CAN be paid from positive balance (when balance - amount >= 0)
    const { publicKey: solventTreasury } = createTreasury('SolventBakery', AVATAR, 100);
    const bakerKeeper = 'baker-keeper-000000000000000000000000000004';
    seedMember(bakerKeeper, 'BakerKeeper');
    assignKeeper(solventTreasury, bakerKeeper);

    // Seed positive balance for SolventBakery (e.g. 50 beans from genesis)
    transfer('genesis', solventTreasury, 50, 'Seed working capital', 'direct', true);
    assert(bal(solventTreasury) === 50, 'SolventBakery has positive balance of 50');

    createPost('offer', 'food', 'Sourdough', 'Fresh loaf', 10, 'fixed', solventTreasury, undefined, undefined, undefined, true);
    const bakingNeed = createPost('need', 'work', 'Bake shift', 'Early morning bake', 20, 'fixed', solventTreasury);
    const bakerBid = requestPost(bakingNeed!.id, bakerKeeper);
    const approveBaker = approvePostRequest(bakerBid.id, solventTreasury);
    assert(approveBaker !== null, 'Keeper CAN be paid when enterprise has positive balance (50 - 20 = 30 >= 0)');
    assert(bal(solventTreasury) === 30, 'SolventBakery balance dropped to 30 (stayed positive, never into credit)');

    console.log(`\n${passed}/${run} checks passed.`);
    console.log('⭐️ Enterprise credit model Rule 5 checks PASSED.');
    process.exit(0);
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
