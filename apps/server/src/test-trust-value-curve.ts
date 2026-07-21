/**
 * Trust Model v2 + F3 regression test — earned trust comes ONLY from completed marketplace
 * (escrow) trades, on a saturating value curve. Direct "send credits" build no trust; grants
 * live in a separate lane.
 *
 * Proves:
 *   1. earnedCreditFromValue(): proportional low end, saturating, integer/deterministic.
 *   2. A small (3-bean) completed trade banks ~nothing; floor stays 0 until a vouch unlocks it.
 *   3. Direct transfers (gifts) build NO trust, at any size.
 *   4. The self-funding farm stays dead: 40 tiny completed trades ≠ a maxed floor (even vouched).
 *   5. Real, diverse trade earns a real floor (~Steward at ~2000 across many sellers), once vouched.
 *   6. Per-counterparty diversity cap holds (10k with ONE partner counts as 5k).
 *   7. A grant deepens the floor but returns earnedCredit = 0 (governance-safe).
 *   8. Vouch gate: only an appointed voucher's vouch (or a grant) hands out the credit floor (light vouch = -25) — trading alone does not.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-trust-value-curve.ts
 */
import { earnedCreditFromValue } from '@beanpool/core';
import { initStateEngine, getMemberTrustProfile, transfer, getBalance } from './state-engine.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let seq = 0;
function seedMember(pk: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, pk.slice(0, 8));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}
// A COMPLETED marketplace (escrow) trade — the only thing that builds trust; credits both sides.
// FK enforcement is on, so we back each trade with a real post (authored by the seller).
function mtx(buyer: string, seller: string, credits: number) {
    const pid = 'post-' + (seq++);
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status) VALUES (?, 'offer', 'misc', 'test', 'test', ?, ?, 'completed')`)
        .run(pid, credits, seller);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?,?,?,?,?, 'completed')`)
        .run('mtx-' + (seq++), pid, buyer, seller, credits);
}
// A direct peer-to-peer transfer (gift) — must NOT build trust.
function tx(from: string, to: string, amount: number) {
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp) VALUES (?,?,?,?,?,?)`)
        .run('t' + (seq++), from, to, amount, 'm', new Date().toISOString());
}
// An appointed voucher vouches for a member — hands out the -20 floor and unlocks any earned
// trust already banked (see getMemberTrustProfile activation gate). FK: elder_vouched_by
// references members(public_key), so we point it at a real seeded voucher ('voucherX').
function vouch(target: string) {
    db.prepare(`UPDATE members SET elder_vouched_by = 'voucherX' WHERE public_key = ?`).run(target);
}
const profile = (pk: string) => getMemberTrustProfile(pk);
const floorOf = (pk: string) => profile(pk).floor;

function main() {
    console.log('Running Trust Model v2 + F3 value-curve test...\n');
    initStateEngine();
    seedMember('voucherX'); // the appointed voucher used by vouch() below

    // ── 1. Pure curve: proportional low end, saturating, integer/deterministic ──
    assert(earnedCreditFromValue(0) === 0, 'curve(0) = 0');
    assert(earnedCreditFromValue(-5) === 0, 'curve(negative) = 0 (guarded)');
    assert(earnedCreditFromValue(3) === 1, 'curve(3) = 1 (tiny trade earns ~nothing)');
    assert(earnedCreditFromValue(2000) === 548, 'curve(2000) = 548 (≈ Steward)');
    assert(earnedCreditFromValue(5000) === 960, 'curve(5000) = 960');
    assert(earnedCreditFromValue(10000) === 1280, 'curve(10000) = 1280 (≈ Elder)');
    assert(earnedCreditFromValue(10_000_000) < 1920, 'curve saturates below the 1920 cap');
    assert(earnedCreditFromValue(10000) > earnedCreditFromValue(2000), 'curve is monotonic increasing');
    assert(Number.isInteger(earnedCreditFromValue(1234)), 'curve returns an integer (deterministic)');

    // ── 2. A small completed trade banks earned trust, and opens the floor immediately ──
    seedMember('buyer3'); seedMember('seller3');
    mtx('buyer3', 'seller3', 3);
    assert(floorOf('buyer3') === -1, `completed trade activates floor to -1, got ${floorOf('buyer3')}`);
    assert(profile('buyer3').earnedCredit === 1, `...but the 1 earned is banked, ready to unlock, got ${profile('buyer3').earnedCredit}`);
    vouch('buyer3'); vouch('seller3');
    assert(floorOf('buyer3') === -26, `once vouched (light, -25) → buyer floor −26 (25 vouch + 1 earned unlocked), got ${floorOf('buyer3')}`);
    assert(floorOf('seller3') === -26, `the seller ALSO earned it → floor −26 once vouched, got ${floorOf('seller3')}`);

    // ── 3. Direct transfers (gifts) build NO trust, at any size ──
    seedMember('gifter'); seedMember('friend');
    tx('gifter', 'friend', 5000);
    assert(profile('gifter').earnedCredit === 0, `5000 direct gift → earnedCredit 0 (gifts aren't trades), got ${profile('gifter').earnedCredit}`);
    // ...and RECEIVING a gift does NOT activate the account: no marketplace trade → no welcome voucher,
    // floor stays 0. (Closes the faucet: gifting 1 bean to N socks can't mint them -20 floors each.)
    assert(floorOf('friend') === 0, `received a 5000 gift but no real trade → not activated, floor 0 (no voucher faucet), got ${floorOf('friend')}`);
    // contrast: the SAME 5000 as a completed trade earns real trust
    seedMember('mbuyer'); seedMember('mseller');
    mtx('mbuyer', 'mseller', 5000);
    assert(profile('mbuyer').earnedCredit === 174, `5000 completed trade → earnedCredit 174 (vs 0 for the identical gift), got ${profile('mbuyer').earnedCredit}`);

    // ── 4. Self-funding farm stays dead: 40 tiny completed trades (even once vouched) ──
    seedMember('farmer'); vouch('farmer');
    for (let i = 0; i < 40; i++) { const s = 'fsock' + i; seedMember(s); mtx('farmer', s, 1); }
    assert(floorOf('farmer') === -40, `40 × 1-bean completed trades, vouched → floor −40 (25 vouch + 15 earned, not −2000), got ${floorOf('farmer')}`);

    // ── 5. Real, diverse trade → real floor (~Steward at 2000 across 5 sellers), once vouched ──
    seedMember('trader'); vouch('trader');
    for (let i = 0; i < 5; i++) { const s = 'tseller' + i; seedMember(s); mtx('trader', s, 400); }
    assert(floorOf('trader') === -573, `2000 across 5 sellers, vouched → floor −573 (25 vouch + 548 earned), got ${floorOf('trader')}`);

    // ── 6. Diversity cap: 10k with ONE partner counts as 500 (once vouched) ──
    seedMember('whale'); seedMember('buddy'); vouch('whale');
    mtx('whale', 'buddy', 10000);
    assert(floorOf('whale') === -199, `10k with one partner capped at 500, vouched → floor −199 (25 vouch + 174 earned), got ${floorOf('whale')}`);

    // ── 7. Grant lane: deepens floor (+voucher, since a grant activates), earnedCredit stays 0 ──
    seedMember('granted');
    db.prepare(`UPDATE members SET earned_credit = ? WHERE public_key = ?`).run(520, 'granted');
    const gp = profile('granted');
    assert(gp.floor === -520, `grant of 520 (not vouched) → floor −520 (grant is the whole floor, no vouch), got ${gp.floor}`);
    assert(gp.earnedCredit === 0 && gp.grantedCredit === 520, `grant is a separate lane (earned 0, granted 520), got earned=${gp.earnedCredit} granted=${gp.grantedCredit}`);

    // ── 8. Activation gate: only a vouch (or grant) hands out the -20 floor ──
    seedMember('fresh');
    assert(floorOf('fresh') === 0, `un-vouched account → floor 0 (no credit line at all), got ${floorOf('fresh')}`);
    seedMember('vouchedFresh'); vouch('vouchedFresh');
    assert(floorOf('vouchedFresh') === -25, `vouched (light), no trades → floor −25 (vouch credit only), got ${floorOf('vouchedFresh')}`);

    // ── 9. Send gate keys off EARNED trust (a real trade), independent of the vouch: no completed
    //       trade → can't gift; after a trade → can (and no velocity cap) ──
    seedMember('noTrade'); seedMember('rcpt');
    db.prepare(`UPDATE accounts SET balance = 100 WHERE public_key = ?`).run('noTrade');
    assert(transfer('noTrade', 'rcpt', 10, 'gift', 'direct') === null,
        'no completed trade → direct send blocked (even holding 100 beans, un-vouched)');
    seedMember('didTrade'); seedMember('aSeller');
    mtx('didTrade', 'aSeller', 5000); // real trade → earnedCredit 960 (opens the send gate)
    vouch('didTrade');                // + a vouch → real overdraft line (−980) for trading
    transfer('genesis', 'didTrade', 100, 'seed', 'direct'); // give didTrade 100 real beans to hold
    assert(transfer('didTrade', 'rcpt', 60, 'gift', 'direct') !== null,
        'after a trade, holding beans → direct send allowed (60 of 100), no velocity cap');
    // ...but you can NEVER send into debt: gifting beyond your positive balance is blocked (floor 0
    // for gifts), even though this account has a deep earned CREDIT line (−980) usable for trading.
    assert(floorOf('didTrade') === -199, `vouched (light) + 5000 trade → trading floor −199, got ${floorOf('didTrade')}`);
    assert(transfer('didTrade', 'rcpt', 1000, 'gift', 'direct') === null,
        'cannot gift beyond positive balance — direct sends never draw on the overdraft/credit line');

    // ── 10. Velocity gate is gone from the balance shape ──
    assert(!('velocityGate' in getBalance('didTrade')), 'getBalance no longer exposes a velocityGate');

    // ── 11. Profile exposes value/ratings detail for the client Trust tab ──
    assert(profile('mbuyer').qualifiedValue === 500, `profile exposes qualifiedValue (500), got ${profile('mbuyer').qualifiedValue}`);
    assert(profile('whale').qualifiedValue === 500, `qualifiedValue is diversity-capped (10k with one partner → 500), got ${profile('whale').qualifiedValue}`);
    assert(profile('fresh').qualifiedValue === 0, `no trades → qualifiedValue 0, got ${profile('fresh').qualifiedValue}`);
    assert(typeof profile('mbuyer').avgRating === 'number' && typeof profile('mbuyer').reviewCount === 'number',
        'profile exposes numeric avgRating & reviewCount');
    assert(profile('mbuyer').reviewCount === 0, `no ratings left yet → reviewCount 0, got ${profile('mbuyer').reviewCount}`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main();
