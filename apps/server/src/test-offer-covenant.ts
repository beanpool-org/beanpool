/**
 * Offer covenant regression test (the checks of the old test-vouch-covenant.ts that were never vouch code; the vouch's
 * went with it in the vouching reset, R0).
 *
 * Proves:
 *   1. A member with no earned, granted or known credit has no credit line (floor 0): nothing opens one but those.
 *   4. Offer covenant: spending into a negative balance requires a LIVE offer (COVENANT_REQUIRED), in bands.
 *   4b. The author sees their own paused Offer; others and the feed don't.
 *   6. Admin tier badges (adminSetTier): grant a tier's entry floor (Resident -200 … Elder -1400).
 *   7. Holiday mode.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-offer-covenant.ts
 */
import {
    initStateEngine, seedGenesisMember,
    getMemberTrustProfile, requestPost, hasLiveOffer, reconcileLedgerFromDb,
    isOnHoliday, setHolidayMode, getPosts, adminSetTier, getBalance,
} from './state-engine.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function throws(fn: () => void, needle: string, msg: string): void {
    try { fn(); assert(false, `${msg} (expected a throw, got none)`); }
    catch (e: any) { assert(String(e?.message || e).includes(needle), `${msg} — threw "${e?.message}"`); }
}

/** The story's Beans as the node's whole hundredths (every floor, balance and price here is hundredths). */
const hc = (beans: number) => Math.round(beans * 100);

let seq = 0;
/** `balance`: whole hundredths. */
function seedMember(pk: string, balance = 0) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, pk.slice(0, 8));
    setMemberPhoto(db, pk, 'a.png');
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, ?, 0)`).run(pk, balance);
}
// Insert an Offer row directly. live=false → a paused/soft-deleted offer that still counts for the
// "ever listed" contribution gate but is NOT a live offer for the covenant.
function offer(author: string, live: boolean, beans = 10): string {
    const pid = 'test-post-' + (seq++) + '-' + Math.random().toString(36).slice(2, 9);
    db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, price_type, author_pubkey, active, status) VALUES (?, 'offer', 'misc', 't', 't', ?, 'fixed', ?, ?, ?)`)
        .run(pid, hc(beans), author, live ? 1 : 0, live ? 'active' : 'paused');
    return pid;
}
const floorOf = (pk: string) => getMemberTrustProfile(pk).floor;

function main() {
    console.log('Running the offer covenant test...\n');
    initStateEngine();
    seedGenesisMember('genesis_admin', 'Admin');

    // ── 1. No credit line without earned, granted or known credit (the activation gate) ──
    seedMember('newbie');
    assert(floorOf('newbie') === 0, 'a new member with nothing earned, granted or confirmed → floor 0 (no credit line)');
    assert(getMemberTrustProfile('newbie').activated === false, 'and no line is open (activated false)');

    // ── 4. Offer covenant (v3, BANDED): live-offer count gates how deep you may spend on credit ──
    // Give the payer a deep earned limit (Elder −1400) so the OFFER band is the binding constraint.
    seedMember('payer'); seedMember('seller');
    adminSetTier('payer', 'Elder'); // earned limit -1400, balance 0
    const sOffer = offer('seller', true, 10); // seller's live offer, costs 10
    offer('payer', false); // payer has LISTED an offer (clears contribution gate) but it is NOT live
    assert(hasLiveOffer('payer') === false, 'payer has no live offer');
    assert(getBalance('payer').usableFloor_c === 0, '0 live offers → usable floor 0 (no credit line to draw)');
    throws(() => requestPost(sOffer, 'payer'), 'FLOOR_LOCKED', 'no live offer → banded covenant blocks the credit spend');
    offer('payer', true); // 1 live offer → unlocks −200
    assert(getBalance('payer').usableFloor_c === -hc(200), '1 live offer → usable floor -200');
    const tx = requestPost(sOffer, 'payer');
    assert(!!tx && tx.status === 'requested', 'spend within the unlocked band → allowed');

    // Band boundaries: each extra live offer unlocks a deeper band, capped by the earned limit.
    seedMember('deep'); adminSetTier('deep', 'Elder'); // earned limit -1400
    assert(getBalance('deep').usableFloor_c === 0, 'deep: 0 offers → 0');
    offer('deep', true); assert(getBalance('deep').usableFloor_c === -hc(200),  'deep: 1 offer → -200');
    offer('deep', true); assert(getBalance('deep').usableFloor_c === -hc(500),  'deep: 2 offers → -500');
    offer('deep', true); assert(getBalance('deep').usableFloor_c === -hc(1000), 'deep: 3 offers → -1000');
    offer('deep', true); assert(getBalance('deep').usableFloor_c === -hc(1400), 'deep: 4 offers → full earned -1400 (band -1500 capped by limit)');

    // Freeze: dropping below the offers your debt needs freezes spending (inbound stays open).
    seedMember('frozen'); adminSetTier('frozen', 'Elder');
    const fOfferA = offer('frozen', true); offer('frozen', true); // 2 offers → -500 line
    db.prepare(`UPDATE accounts SET balance_c = ? WHERE public_key = 'frozen'`).run(-hc(400));
    reconcileLedgerFromDb();
    assert(getBalance('frozen').frozen === false, 'debt -400 within the 2-offer -500 line → not frozen');
    db.prepare(`UPDATE posts SET status='paused', active=0 WHERE id = ?`).run(fOfferA); // pause one → 1 live offer
    assert(getBalance('frozen').usableFloor_c === -hc(200), 'after pausing one offer → usable floor -200');
    assert(getBalance('frozen').frozen === true, 'debt -400 now below the -200 line → frozen');

    // ── 4b. Viewer-aware paused visibility: author sees own paused Offer; others & the feed don't ──
    seedMember('pauser');
    const pausedId = 'test-post-paused-' + (seq++) + '-' + Math.random().toString(36).slice(2, 7);
    db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, price_type, author_pubkey, active, status) VALUES (?, 'offer', 'misc', 't', 't', ?, 'fixed', 'pauser', 1, 'paused')`).run(pausedId, hc(10));
    assert(getPosts({ authorPubkey: 'pauser', viewerPubkey: 'pauser' }).some(p => p.id === pausedId), 'author viewing their own listings sees their paused Offer');
    assert(!getPosts({ authorPubkey: 'pauser', viewerPubkey: 'someone-else' }).some(p => p.id === pausedId), 'a different viewer does NOT see the author\'s paused Offer');
    assert(!getPosts().some(p => p.id === pausedId), 'the general feed hides paused Offers');

    // ── 6. Admin tier badges grant the tier's entry floor ──
    seedMember('badgeUser');
    adminSetTier('badgeUser', 'Resident');
    assert(floorOf('badgeUser') === -hc(200), 'Resident badge → floor -200');
    adminSetTier('badgeUser', 'Steward');
    assert(floorOf('badgeUser') === -hc(600), 'Steward badge → floor -600');
    adminSetTier('badgeUser', 'Elder');
    assert(floorOf('badgeUser') === -hc(1400), 'Elder badge → floor -1400');
    adminSetTier('badgeUser', 'Newcomer');
    assert(floorOf('badgeUser') === 0, 'Newcomer badge clears the grant → floor 0');

    // ── 7. Holiday mode ──
    seedMember('holA');
    assert(isOnHoliday('holA') === false, 'default: a member is not on holiday');
    setHolidayMode('holA', true);
    assert(isOnHoliday('holA') === true, 'holiday switches on when there are no open trades');
    const sOffer2 = offer('seller', true, 5);
    throws(() => requestPost(sOffer2, 'holA'), 'HOLIDAY_MODE', 'on holiday → cannot initiate a trade');
    setHolidayMode('holA', false);
    assert(isOnHoliday('holA') === false, 'holiday switches back off');
    // open-trades guard: an in-flight deal blocks turning holiday ON
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status, created_at) VALUES ('mt-hol', ?, 'holA', 'seller', ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(sOffer2, hc(5));
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
