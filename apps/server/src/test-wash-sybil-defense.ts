/**
 * Wash Trading and Sybil Ring Defense Regression Tests (Change 1, Change 3)
 *
 * Proves:
 *   1. Cap 500: repeat trade with one partner caps at 500.
 *   2. Wash trading pair (r < 0.15): mutual volume is excluded from trust.
 *   3. Sybil ring (size <= 12, insularity >= 0.8, >= 50% new members): internal trade volume is excluded from trust.
 *   4. Hard credit freeze: admin can set credit_frozen to force floor to 0.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-wash-sybil-defense.ts
 */

import {
    initStateEngine, getMemberTrustProfile, adminSetCreditFrozen,
    getCommunityHealth, getGovernanceCredits, clearWashTradingCache
} from './state-engine.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let txc = 0;
function seedMember(pk: string, joinedAtDaysAgo = 0) {
    const joinedAt = new Date(Date.now() - joinedAtDaysAgo * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, ?)`).run(pk, pk.slice(0, 8), joinedAt);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

function mtx(buyer: string, seller: string, credits: number, completedDaysAgo = 0) {
    const pid = 'wsp-' + (txc++);
    db.prepare(`INSERT OR IGNORE INTO posts (id, type, category, title, description, credits, author_pubkey, status) VALUES (?, 'offer', 'misc', 'test', 'test', ?, ?, 'completed')`)
        .run(pid, credits, seller);

    const completedAt = new Date(Date.now() - completedDaysAgo * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, completed_at) VALUES (?,?,?,?,?, 'completed', ?)`)
        .run('wmtx-' + (txc++), pid, buyer, seller, credits, completedAt);
}

async function main() {
    console.log('Running Wash Trading & Sybil Ring Defense tests...\n');
    initStateEngine();

    try {
        // --- Test 1: Cap 500 & unidirectional trade between non-new members (not flagged as ring) ---
        const userA = 'userA-' + Date.now();
        const userB = 'userB-' + Date.now();
        // Seed as 20 days old (non-new) to avoid Sybil ring check
        seedMember(userA, 20); seedMember(userB, 20);

        // Trade 800 credits from A to B (one direction)
        mtx(userA, userB, 800);
        clearWashTradingCache();

        // Cap is 500, so qualified trade value for userA and userB should be 500
        const profileA = getMemberTrustProfile(userA);
        const profileB = getMemberTrustProfile(userB);
        assert(profileA.qualifiedValue === 500, `Unidirectional trade capped at 500 (got ${profileA.qualifiedValue})`);
        assert(profileB.qualifiedValue === 500, `Seller also receives 500 qualified value (got ${profileB.qualifiedValue})`);

        // --- Test 2: Wash trading pair (r < 0.15) ---
        const wash1 = 'wash1-' + Date.now();
        const wash2 = 'wash2-' + Date.now();
        // Seed as 20 days old to avoid Sybil ring check
        seedMember(wash1, 20); seedMember(wash2, 20);

        // Mutually trade 600 credits back and forth
        mtx(wash1, wash2, 600); // wash1 buys from wash2
        mtx(wash2, wash1, 600); // wash2 buys from wash1
        // Gross: 1200, Inflow: 600, Outflow: 600. r = 0.
        clearWashTradingCache();

        const profileW1 = getMemberTrustProfile(wash1);
        const profileW2 = getMemberTrustProfile(wash2);
        assert(profileW1.qualifiedValue === 0, `Wash trading pair volume excluded (got ${profileW1.qualifiedValue})`);
        assert(profileW2.qualifiedValue === 0, `Wash trading pair counterparty volume excluded (got ${profileW2.qualifiedValue})`);

        // Verify wash trading alert exists in health report
        const health = getCommunityHealth();
        const washFlag = health.flags.find(f => f.type === 'wash_trading' && f.members.includes(wash1));
        assert(!!washFlag, 'Wash trading alert was raised in community health flags');

        // --- Test 3: Sybil Ring (size <= 12, insularity >= 0.8, >= 50% new members) ---
        const ring = Array.from({ length: 4 }, (_, i) => `ring${i}-${Date.now()}`);
        for (const r of ring) {
            seedMember(r, 2); // 2 days old (new member)
        }

        // Circular trade within the ring (all in the last 30 days)
        mtx(ring[0], ring[1], 600);
        mtx(ring[1], ring[2], 600);
        mtx(ring[2], ring[3], 600);
        mtx(ring[3], ring[0], 600);
        clearWashTradingCache();

        // They form an insular cluster where all members are new.
        // Therefore, their internal trade volumes must be excluded.
        for (const r of ring) {
            const profile = getMemberTrustProfile(r);
            assert(profile.qualifiedValue === 0, `Sybil ring member ${r.slice(0, 8)} trust volume excluded (got ${profile.qualifiedValue})`);
        }

        // Verify Sybil ring alert exists in health report
        const health2 = getCommunityHealth();
        const ringFlag = health2.flags.find(f => f.type === 'sybil_ring' && f.members.includes(ring[0]));
        assert(!!ringFlag, 'Sybil ring alert was raised in community health flags');
        assert(ringFlag?.severity === 'critical', 'Sybil ring severity is critical');

        // --- Test 4: Hard credit freeze ---
        const frozenUser = 'frozen-' + Date.now();
        seedMember(frozenUser, 20); // 20 days old (non-new)
        const partner = 'partner-' + Date.now();
        seedMember(partner, 20); // 20 days old (non-new)
        mtx(frozenUser, partner, 800); // unidirectional, gross 800, r = 1.0 (not wash)
        clearWashTradingCache();

        const profileBefore = getMemberTrustProfile(frozenUser);
        assert(profileBefore.floor < 0, `Before freeze: member has credit allowance (floor: ${profileBefore.floor})`);

        // Freeze credit
        adminSetCreditFrozen(frozenUser, true);
        const profileAfter = getMemberTrustProfile(frozenUser);
        assert(profileAfter.floor === 0, `After freeze: member floor is forced to 0 (floor: ${profileAfter.floor})`);

        // Unfreeze credit
        adminSetCreditFrozen(frozenUser, false);
        const profileUnfrozen = getMemberTrustProfile(frozenUser);
        assert(profileUnfrozen.floor === profileBefore.floor, `After unfreeze: member floor is restored to ${profileUnfrozen.floor}`);

        console.log(`\n${passed}/${run} checks passed.`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
        console.log('⭐️ Wash Trading & Sybil Ring Defense tests PASSED.');
    } catch (e) {
        console.error('❌ Test failed:', e);
        process.exit(1);
    }
    process.exit(0);
}

main();
