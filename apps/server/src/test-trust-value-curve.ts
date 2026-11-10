/**
 * Trust Model v2 + F3 regression test — earned trust comes ONLY from completed marketplace
 * (escrow) trades, on a saturating value curve. Direct "send credits" build no trust; grants
 * live in a separate lane.
 *
 * Proves:
 *   1. earnedCreditFromValue(): proportional low end, saturating, integer/deterministic.
 *   2. A small (3-bean) completed trade banks ~nothing, and opens a floor of what it earned.
 *   3. Direct transfers (gifts) build NO trust, at any size.
 *   4. The self-funding farm stays dead: 40 tiny completed trades ≠ a maxed floor.
 *   5. Real, diverse trade earns a real floor (~Steward at ~2000 across many sellers).
 *   6. Per-counterparty diversity cap holds (10k with ONE partner counts as 5k).
 *   7. A grant deepens the floor but returns earnedCredit = 0 (governance-safe).
 *   8. Activation gate: an account with no completed trade, no grant and no confirmation has no credit line at all.
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

/**
 * The story's figures are Beans; the node's are whole hundredths of a Bean, and so is the curve (core protocol.ts:
 * CREDIT_MAX_EARNED 192000, TRUST_CURVE_K 500000, the per-partner cap 50000). `hc` turns a Beans figure into hundredths.
 * The curve is the one it was in Beans, read to the hundredth: a figure the Beans curve floored to a whole Bean (548)
 * now keeps its hundredths (54857, 548.57 Beans).
 */
const hc = (beans: number) => Math.round(beans * 100);

let seq = 0;
function seedMember(pk: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, pk.slice(0, 8));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}
// A COMPLETED marketplace (escrow) trade of `credits` Beans — the only thing that builds trust; credits both sides.
// FK enforcement is on, so we back each trade with a real post (authored by the seller).
function mtx(buyer: string, seller: string, credits: number) {
    const pid = 'post-' + (seq++);
    db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, status) VALUES (?, 'offer', 'misc', 'test', 'test', ?, ?, 'completed')`)
        .run(pid, hc(credits), seller);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status) VALUES (?,?,?,?,?, 'completed')`)
        .run('mtx-' + (seq++), pid, buyer, seller, hc(credits));
}
// A direct peer-to-peer transfer (gift) of `amount` Beans — must NOT build trust.
function tx(from: string, to: string, amount: number) {
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c, memo, timestamp) VALUES (?,?,?,?,?,?)`)
        .run('t' + (seq++), from, to, hc(amount), 'm', new Date().toISOString());
}
const profile = (pk: string) => getMemberTrustProfile(pk);
const floorOf = (pk: string) => profile(pk).floor;

function main() {
    console.log('Running Trust Model v2 + F3 value-curve test...\n');
    initStateEngine();

    // ── 1. Pure curve: proportional low end, saturating, integer/deterministic ──
    assert(earnedCreditFromValue(0) === 0, 'curve(0) = 0');
    assert(earnedCreditFromValue(-5) === 0, 'curve(negative) = 0 (guarded)');
    assert(earnedCreditFromValue(hc(3)) === 115, 'curve(3 Beans) = 1.15 Beans, 115 (tiny trade earns ~nothing)');
    assert(earnedCreditFromValue(hc(2000)) === 54857, 'curve(2000 Beans) = 548.57 Beans, 54857 (≈ Steward)');
    assert(earnedCreditFromValue(hc(5000)) === hc(960), 'curve(5000 Beans) = 960 Beans');
    assert(earnedCreditFromValue(hc(10000)) === hc(1280), 'curve(10000 Beans) = 1280 Beans (≈ Elder)');
    assert(earnedCreditFromValue(hc(10_000_000)) < hc(1920), 'curve saturates below the 1920-Bean cap');
    assert(earnedCreditFromValue(hc(10000)) > earnedCreditFromValue(hc(2000)), 'curve is monotonic increasing');
    assert(Number.isInteger(earnedCreditFromValue(hc(1234))), 'curve returns an integer, whole hundredths (deterministic)');

    // ── 2. A small completed trade banks earned trust, and opens the floor immediately ──
    seedMember('buyer3'); seedMember('seller3');
    mtx('buyer3', 'seller3', 3);
    assert(floorOf('buyer3') === -115, `completed trade activates floor to -1.15 Beans (-115), got ${floorOf('buyer3')}`);
    assert(profile('buyer3').earnedCredit === 115, `...and the 1.15 earned is banked, got ${profile('buyer3').earnedCredit}`);
    assert(floorOf('seller3') === -115, `the seller ALSO earned it → floor −1.15 Beans (-115), got ${floorOf('seller3')}`);

    // ── 3. Direct transfers (gifts) build NO trust, at any size ──
    seedMember('gifter'); seedMember('friend');
    tx('gifter', 'friend', 5000);
    assert(profile('gifter').earnedCredit === 0, `5000 direct gift → earnedCredit 0 (gifts aren't trades), got ${profile('gifter').earnedCredit}`);
    // ...and RECEIVING a gift does NOT activate the account: no marketplace trade → no credit line,
    // floor stays 0. (Closes the faucet: gifting 1 bean to N socks can't mint them -20 floors each.)
    assert(floorOf('friend') === 0, `received a 5000 gift but no real trade → not activated, floor 0 (no credit faucet), got ${floorOf('friend')}`);
    // contrast: the SAME 5000 as a completed trade earns real trust
    seedMember('mbuyer'); seedMember('mseller');
    mtx('mbuyer', 'mseller', 5000);
    assert(profile('mbuyer').earnedCredit === 17454, `5000 completed trade → earnedCredit 174.54 Beans, 17454 (vs 0 for the identical gift), got ${profile('mbuyer').earnedCredit}`);

    // ── 4. Self-funding farm stays dead: 40 tiny completed trades ──
    seedMember('farmer');
    for (let i = 0; i < 40; i++) { const s = 'fsock' + i; seedMember(s); mtx('farmer', s, 1); }
    assert(floorOf('farmer') === -1523, `40 × 1-bean completed trades → floor −15.23 Beans (-1523: 15.23 earned, not −2000), got ${floorOf('farmer')}`);

    // ── 5. Real, diverse trade → real floor (~Steward at 2000 across 5 sellers) ──
    seedMember('trader');
    for (let i = 0; i < 5; i++) { const s = 'tseller' + i; seedMember(s); mtx('trader', s, 400); }
    assert(floorOf('trader') === -54857, `2000 across 5 sellers → floor −548.57 Beans (-54857 earned), got ${floorOf('trader')}`);

    // ── 6. Diversity cap: 10k with ONE partner counts as 500 ──
    seedMember('whale'); seedMember('buddy');
    mtx('whale', 'buddy', 10000);
    assert(floorOf('whale') === -17454, `10k with one partner capped at 500 → floor −174.54 Beans (-17454 earned), got ${floorOf('whale')}`);

    // ── 7. Grant lane: deepens floor (a grant activates), earnedCredit stays 0 ──
    seedMember('granted');
    db.prepare(`UPDATE members SET earned_credit_c = ? WHERE public_key = ?`).run(hc(520), 'granted');
    const gp = profile('granted');
    assert(gp.floor === -hc(520), `grant of 520 → floor −520 Beans (the grant is the whole floor), got ${gp.floor}`);
    assert(gp.earnedCredit === 0 && gp.grantedCredit === hc(520), `grant is a separate lane (earned 0, granted 520 Beans), got earned=${gp.earnedCredit} granted=${gp.grantedCredit}`);

    // ── 8. Activation gate: no trade, no grant, no confirmation → no credit line ──
    seedMember('fresh');
    assert(floorOf('fresh') === 0, `a fresh account → floor 0 (no credit line at all), got ${floorOf('fresh')}`);

    // ── 9. Send gate keys off EARNED trust (a real trade): no completed trade → can't gift; after a
    //       trade → can (and no velocity cap) ──
    seedMember('noTrade'); seedMember('rcpt');
    db.prepare(`UPDATE accounts SET balance_c = ? WHERE public_key = ?`).run(hc(100), 'noTrade');
    assert(transfer('noTrade', 'rcpt', hc(10), 'gift', 'direct') === null,
        'no completed trade → direct send blocked (even holding 100 beans)');
    seedMember('didTrade'); seedMember('aSeller');
    mtx('didTrade', 'aSeller', 5000); // real trade → earned credit (opens the send gate and a trading line)
    transfer('genesis', 'didTrade', hc(100), 'seed', 'direct'); // give didTrade 100 real beans to hold
    assert(transfer('didTrade', 'rcpt', hc(60), 'gift', 'direct') !== null,
        'after a trade, holding beans → direct send allowed (60 of 100), no velocity cap');
    // ...but you can NEVER send into debt: gifting beyond your positive balance is blocked (floor 0
    // for gifts), even though this account has an earned CREDIT line usable for trading.
    assert(floorOf('didTrade') === -17454, `a 5000 trade with one partner → trading floor −174.54 Beans (-17454), got ${floorOf('didTrade')}`);
    assert(transfer('didTrade', 'rcpt', hc(1000), 'gift', 'direct') === null,
        'cannot gift beyond positive balance — direct sends never draw on the overdraft/credit line');

    // ── 10. Velocity gate is gone from the balance shape ──
    assert(!('velocityGate' in getBalance('didTrade')), 'getBalance no longer exposes a velocityGate');

    // ── 11. Profile exposes value/ratings detail for the client Trust tab ──
    assert(profile('mbuyer').qualifiedValue === hc(500), `profile exposes qualifiedValue (500 Beans), got ${profile('mbuyer').qualifiedValue}`);
    assert(profile('whale').qualifiedValue === hc(500), `qualifiedValue is diversity-capped (10k with one partner → 500 Beans), got ${profile('whale').qualifiedValue}`);
    assert(profile('fresh').qualifiedValue === 0, `no trades → qualifiedValue 0, got ${profile('fresh').qualifiedValue}`);
    assert(typeof profile('mbuyer').avgRating === 'number' && typeof profile('mbuyer').reviewCount === 'number',
        'profile exposes numeric avgRating & reviewCount');
    assert(profile('mbuyer').reviewCount === 0, `no ratings left yet → reviewCount 0, got ${profile('mbuyer').reviewCount}`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main();
