/**
 * Elder-vouch onboarding + offer covenant regression test.
 *
 * Proves:
 *   1. canVouch: the system admin always can; a plain member cannot; adminSetVoucher toggles it.
 *   2. vouchMember: rejects self-vouch and non-vouchers; a voucher's vouch hands out the -20 floor.
 *   3. unvouchMember: the original voucher can withdraw (balance ≥ 0); blocked while the target is
 *      negative; the admin can force-revoke; withdrawing removes the floor.
 *   4. Offer covenant: spending into a negative balance requires a LIVE offer (COVENANT_REQUIRED).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-vouch-covenant.ts
 */
import {
    initStateEngine, getAdminPubkey, canVouch, vouchMember, unvouchMember, adminSetVoucher,
    getMemberTrustProfile, requestPost, hasLiveOffer, reconcileLedgerFromDb,
    isOnHoliday, setHolidayMode, getPosts,
} from './state-engine.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function throws(fn: () => void, needle: string, msg: string): void {
    try { fn(); assert(false, `${msg} (expected a throw, got none)`); }
    catch (e: any) { assert(String(e?.message || e).includes(needle), `${msg} — threw "${e?.message}"`); }
}

let seq = 0;
function seedMember(pk: string, balance = 0) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at) VALUES (?, ?, 'a.png', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, pk.slice(0, 8));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(pk, balance);
}
// Insert an Offer row directly. live=false → a paused/soft-deleted offer that still counts for the
// "ever listed" contribution gate but is NOT a live offer for the covenant.
function offer(author: string, live: boolean, credits = 10): string {
    const pid = 'post-' + (seq++);
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, price_type, author_pubkey, active, status) VALUES (?, 'offer', 'misc', 't', 't', ?, 'fixed', ?, ?, ?)`)
        .run(pid, credits, author, live ? 1 : 0, live ? 'active' : 'paused');
    return pid;
}
const floorOf = (pk: string) => getMemberTrustProfile(pk).floor;

function main() {
    console.log('Running Elder-vouch + covenant test...\n');
    initStateEngine();
    const admin = getAdminPubkey();

    // ── 1. canVouch capability (admin-granted, never tier-derived) ──
    seedMember('elderA'); seedMember('plain');
    assert(canVouch(admin) === true, 'system admin always holds the vouch capability');
    assert(canVouch('elderA') === false, 'a plain member cannot vouch by default');
    adminSetVoucher('elderA', true);
    assert(canVouch('elderA') === true, 'adminSetVoucher(true) grants the capability');
    adminSetVoucher('elderA', false);
    assert(canVouch('elderA') === false, 'adminSetVoucher(false) revokes it');
    adminSetVoucher('elderA', true); // re-grant for the rest of the run

    // ── 2. vouchMember guards + effect (hands out the -20 floor) ──
    seedMember('newbie');
    throws(() => vouchMember('elderA', 'elderA'), 'yourself', 'cannot vouch for yourself');
    throws(() => vouchMember('plain', 'newbie'), 'appointed vouchers', 'a non-voucher cannot vouch');
    assert(floorOf('newbie') === 0, 'un-vouched newbie → floor 0 (no credit line)');
    vouchMember('elderA', 'newbie');
    assert(floorOf('newbie') === -20, 'after a vouch → floor -20 (welcome voucher unlocked)');

    // ── 3. unvouchMember: ownership + negative-balance guard + admin force ──
    seedMember('other'); adminSetVoucher('other', true);
    throws(() => unvouchMember('other', 'newbie'), 'voucher who vouched', 'a different voucher cannot withdraw someone else\'s vouch');
    db.prepare(`UPDATE accounts SET balance = -5 WHERE public_key = 'newbie'`).run();
    reconcileLedgerFromDb(); // getBalance reads the in-memory ledger — resync it from the raw update
    throws(() => unvouchMember('elderA', 'newbie'), 'negative balance', 'the voucher cannot withdraw while the target is underwater');
    unvouchMember(admin, 'newbie'); // admin can force even when negative
    assert(floorOf('newbie') === 0, 'admin force-withdraw removes the floor (back to 0)');
    vouchMember('elderA', 'newbie');
    db.prepare(`UPDATE accounts SET balance = 0 WHERE public_key = 'newbie'`).run();
    reconcileLedgerFromDb();
    unvouchMember('elderA', 'newbie'); // settled → the voucher can now withdraw
    assert(floorOf('newbie') === 0, 'voucher withdraws once the target has settled → floor 0');

    // ── 4. Offer covenant: to spend into a negative balance you must keep a live Offer ──
    seedMember('payer'); seedMember('seller');
    vouchMember('elderA', 'payer'); // floor -20, balance 0
    const sOffer = offer('seller', true, 10); // seller's live offer, costs 10
    offer('payer', false); // payer has listed an offer (clears contribution gate) but it is NOT live
    assert(hasLiveOffer('payer') === false, 'payer has no live offer');
    throws(() => requestPost(sOffer, 'payer'), 'COVENANT_REQUIRED', 'spending negative with no live offer → covenant blocks');
    offer('payer', true); // now payer keeps a live offer
    assert(hasLiveOffer('payer') === true, 'payer now has a live offer');
    const tx = requestPost(sOffer, 'payer');
    assert(!!tx && tx.status === 'requested', 'with a live offer → the credit spend is allowed');

    // ── 5. Holiday mode ──
    seedMember('holA');
    assert(isOnHoliday('holA') === false, 'default: a member is not on holiday');
    setHolidayMode('holA', true);
    assert(isOnHoliday('holA') === true, 'holiday switches on when there are no open trades');
    const sOffer2 = offer('seller', true, 5);
    throws(() => requestPost(sOffer2, 'holA'), 'HOLIDAY_MODE', 'on holiday → cannot initiate a trade');
    setHolidayMode('holA', false);
    assert(isOnHoliday('holA') === false, 'holiday switches back off');
    // open-trades guard: an in-flight deal blocks turning holiday ON
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at) VALUES ('mt-hol', ?, 'holA', 'seller', 5, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(sOffer2);
    throws(() => setHolidayMode('holA', true), 'active trade', 'cannot go on holiday with an open trade in progress');
    // feed-hide: an away member's offer is excluded from the general feed, but visible on their own listing view
    seedMember('holB'); const hbOffer = offer('holB', true, 7);
    setHolidayMode('holB', true);
    assert(!getPosts({ limit: 200 }).some(p => p.id === hbOffer), 'an away member\'s offer is hidden from the general feed');
    assert(getPosts({ authorPubkey: 'holB' }).some(p => p.id === hbOffer), 'but it is still visible when viewing that author\'s own listings');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main();
