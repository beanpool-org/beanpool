/**
 * Trust Model v2 regression test — earned credit is VALUE-based (saturating curve), not
 * handshake-count-based, and grants live in a SEPARATE lane from earned trust.
 *
 * Proves:
 *   1. earnedCreditFromValue() is proportional at the low end, saturating, integer, deterministic.
 *   2. A tiny (3-bean) first trade earns ~nothing → the old "3-bean → −128" cliff is gone.
 *   3. The self-funding partner farm is dead: 1-bean sends to 40 sock accounts no longer max the floor.
 *   4. Real, diverse value earns a real floor (≈ Steward at ~2000 cycled).
 *   5. The per-counterparty diversity cap holds under the new curve (10k to ONE partner counts as 5k).
 *   6. A grant (earned_credit column) deepens the floor but returns earnedCredit = 0 (vote-safe).
 *   7. The first-trade gate still holds: no overdraft with no trade, no grant, no vouch.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-trust-value-curve.ts
 */
import { earnedCreditFromValue } from '@beanpool/core';
import { initStateEngine, getMemberTrustProfile } from './state-engine.js';
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
function tx(from: string, to: string, amount: number) {
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp) VALUES (?,?,?,?,?,?)`)
        .run('t' + (seq++), from, to, amount, 'm', new Date().toISOString());
}
const floorOf = (pk: string) => getMemberTrustProfile(pk).floor;

function main() {
    console.log('Running Trust Model v2 value-curve test...\n');
    initStateEngine();

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

    // ── 2. 3-bean first trade → shallow floor (cliff gone; old model gave −128) ──
    seedMember('a'); seedMember('b');
    tx('a', 'b', 3);
    assert(floorOf('a') === -81, `3-bean trade → floor −81 (was −128), got ${floorOf('a')}`);

    // ── 3. Self-funding partner farm is DEAD: 1-bean sends to 40 socks ──
    seedMember('farmer');
    for (let i = 0; i < 40; i++) { const s = 'sock' + i; seedMember(s); tx('farmer', s, 1); }
    const farmFloor = floorOf('farmer');
    assert(farmFloor === -95, `40 × 1-bean socks → floor −95 (old model: −2000), got ${farmFloor}`);
    assert(farmFloor > -150, 'farmed floor nowhere near the −2000 cap');

    // ── 4. Real, diverse value earns a real floor (~Steward at 2000 cycled) ──
    seedMember('trader');
    for (let i = 0; i < 5; i++) { const p = 'tp' + i; seedMember(p); tx('trader', p, 400); } // 5 × 400 = 2000
    assert(floorOf('trader') === -628, `2000 cycled across 5 partners → floor −628, got ${floorOf('trader')}`);

    // ── 5. Diversity cap holds: 10k to ONE partner counts as 5k ──
    seedMember('whale'); seedMember('buddy');
    tx('whale', 'buddy', 10000);
    // capped at PER_COUNTERPARTY_VOLUME_CAP (5000) → curve(5000) = 960 → floor −1040
    assert(floorOf('whale') === -1040, `10k to one partner capped at 5k → floor −1040, got ${floorOf('whale')}`);

    // ── 6. Grant lane: deepens floor, but earnedCredit stays 0 (governance-safe) ──
    seedMember('granted');
    db.prepare(`UPDATE members SET earned_credit = ? WHERE public_key = ?`).run(520, 'granted');
    const gp = getMemberTrustProfile('granted');
    assert(gp.floor === -600, `grant of 520 → floor −600, got ${gp.floor}`);
    assert(gp.earnedCredit === 0, `granted credit does NOT count as earned (earnedCredit=0), got ${gp.earnedCredit}`);
    assert(gp.grantedCredit === 520, `grantedCredit reported separately (=520), got ${gp.grantedCredit}`);

    // ── 7. First-trade gate: no trade, no grant, no vouch → no overdraft ──
    seedMember('fresh');
    assert(floorOf('fresh') === 0, `fresh account (no trade/grant/vouch) → floor 0, got ${floorOf('fresh')}`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main();
