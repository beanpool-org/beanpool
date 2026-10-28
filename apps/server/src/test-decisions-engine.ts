/**
 * Test Suite: Community Decisions Engine
 * Source: docs/the-commons.md §3.2–§3.8, §6 Slice 5.
 *
 * Covers:
 * 1. Franchises & Eligibility:
 *    - 1m1v for member decisions; quadratic on trade standing for pool decisions
 *    - Enterprises and frozen members cannot propose or vote
 *    - Author standing gate (a completed trade, or a node admin) and max 1 open decision per author
 *    - Quadratic voice credits cost = voteCount²
 * 2. Quorum Rules:
 *    - 30% of active members in 30 days, floor K_min = 3 (25% for removal)
 *    - Under-quorum fails to 'unresolved' (no cost, no beans burned)
 * 3. Threshold Rules:
 *    - 60% supermajority standard
 *    - 66% supermajority for member removal
 *    - Simple majority (> 50%) for restorations
 *    - Ties fail
 * 4. Tick-driven close without admin intervention (7-day window)
 * 5. Pre-flight assertions & execution_void for dead subjects
 * 6. Reversible member effects (suspend/unsuspend, freeze/unfreeze, voucher, remove lead keeper)
 * 7. Pool grants to an enterprise with auth_signer='system:decision:<id>' and conservation audit
 * 8. Underfunded grants -> passed_queued_for_funds queue, auto-execution when funded, 90-day expiry
 * 9. Destructive member removal: 7-day grace period, immediate suspension, admin halt with reason, admin accelerate, auto-prune on grace expiry
 * 10. Reinstatement cancels pending grace removal
 * 11. Executor idempotency and transaction rollback safety
 * 12. Removed effects (set_rule, set_levy, poll, tier/elder by vote) cannot be proposed
 * 13. Removal by vote S2 (scratch/fable-design/DESIGN-removal-by-vote-fable.md §3.2, §3.3, §5 point 2, §7): an admin's
 *     pause opens the community's vote on removing the member ("Remove X?", the node's, rule 2), decided as a removal.
 *     Yes starts today's grace window, then the removal; No, a tie, a missed quorum or no votes at all lift the pause on
 *     the tick that closes the vote, the role held aside back; so does a vote that can't be carried out (votes switched
 *     off, an owner or admin, §3.8) or whose grace window can't start. Halting it or lifting the pause by hand lifts it.
 *     The subject never votes on, nor counts in, a vote to remove them; paused, they keep their vote, and their place
 *     in the electorate, on every other Decision, so pausing someone moves no vote. A member a vote suspended, one held
 *     by a removal's grace window, and one an older node suspended under a "Keep …'s suspension?" vote do not vote, and
 *     that old vote still ends under the old rule. Nothing in it moves Beans; the pot-unknown path still holds a pause
 *     vote's removal and reopens its brake. A member's proposal can't carry the node's marks of a pause vote.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-decisions-engine.ts
 *   SOFT_ASSERT=1 keeps going past a failed check (to list every rule an older server does not meet). CI never sets it.
 */

import {
    initStateEngine,
    createDecision,
    getDecision,
    getAllDecisions,
    castDecisionVote,
    getDecisionVotes,
    tallyDecision,
    executeDecision,
    tickDecisions,
    adminHaltDecision,
    adminAccelerateDecision,
    getActiveMembersCount30d,
    getQuorumRequired,
    checkCanProposeDecision,
    checkVoterEligibility,
    getDecisionVoiceCredits,
    getBalance,
    getCommonsBalance,
    grantNodeRole,
    adminSetUserStatus,
    adminEmergencySuspend,
    adminLiftSuspension,
    adminSetCreditFrozen,
    publicDecision,
} from './state-engine.js';
import * as decisionsEngine from './decisions-engine.js';
import { removalProposedFromBefore } from './decisions-from-before-test-fixture.js';
import { NODE_PROFILE_KEY } from './config/node-profile.js';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { setCommonsBalance } from '@beanpool/core';

let testsRun = 0;
let testsPassed = 0;
// SOFT_ASSERT=1 keeps going past a failed check, so the suite can be run against an older server to list every rule it
// does not meet. CI never sets it.
const SOFT = process.env.SOFT_ASSERT === '1';
function testAssert(cond: any, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        if (!SOFT) throw new Error(`Assertion failed: ${msg}`);
    }
}

function seedTestMember(pk: string, callsign: string, opts?: {
    isTreasury?: boolean;
    creditFrozen?: boolean;
    earnedCredit?: number;
    status?: string;
    joinedAt?: string;
}) {
    const isTreasury = opts?.isTreasury ? 1 : 0;
    const creditFrozen = opts?.creditFrozen ? 1 : 0;
    const earnedCredit = opts?.earnedCredit ?? 50;
    const status = opts?.status || 'active';
    const joinedAt = opts?.joinedAt || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
        INSERT INTO members (public_key, callsign, joined_at, status, credit_frozen, is_treasury, earned_credit)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(public_key) DO UPDATE SET
            status = excluded.status,
            credit_frozen = excluded.credit_frozen,
            is_treasury = excluded.is_treasury,
            earned_credit = excluded.earned_credit
    `).run(pk, callsign, joinedAt, status, creditFrozen, isTreasury, earnedCredit);

    db.prepare(`
        INSERT INTO accounts (public_key, balance, last_demurrage_epoch)
        VALUES (?, 0, 0)
        ON CONFLICT(public_key) DO NOTHING
    `).run(pk);
}

function recordTestActivity(buyer: string, seller: string, amount: number) {
    const txId = 'tx-' + Math.random().toString(36).slice(2);
    const postId = 'post-' + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)
    `).run(txId, postId, buyer, seller, amount, now, now);
}

function closeForTick(id: string) {
    db.prepare("UPDATE decisions SET closes_at = datetime('now', '-10 seconds') WHERE id = ?").run(id);
}

// A Decision row set up directly, bypassing createDecision's one-open-per-author gate, so the executor's
// failure handling can be exercised on a real effect.
function insertStoredDecision(opts: { author: string; effect: string; touches: string; subject: string; params?: any }): string {
    const id = 'stored-' + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    const closes = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
        INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params,
            franchise, status, opens_at, closes_at, created_at, updated_at)
        VALUES (?, ?, ?, 'Set up directly by the test', ?, ?, ?, ?, '1m1v', 'open', ?, ?, ?, ?)
    `).run(id, opts.author, `Stored ${opts.effect}`, opts.touches, opts.effect, opts.subject,
        opts.params ? JSON.stringify(opts.params) : null, now, closes, now, now);
    return id;
}
async function runDecisionsSuite() {
    console.log('🏛️ Running Community Decisions Engine Test Suite (§3.2–§3.8)...\n');

    initStateEngine();
    setCommonsBalance(1000);

    const admin = 'admin_user_' + Date.now();
    seedTestMember(admin, 'AdminDave', { earnedCredit: 500 });
    grantNodeRole(admin, 'owner');

    // ── 1. Franchises & Eligibility ─────────────────────────────────────────
    console.log('\n--- 1. Franchises & Eligibility ---');

    const m1 = 'member_alice_' + Date.now();
    const m2 = 'member_bob_' + Date.now();
    const enterprise1 = 'ent_community_eggs_' + Date.now();
    const frozenMember = 'member_frozen_' + Date.now();
    const zeroStandingMember = 'member_zero_' + Date.now();

    seedTestMember(m1, 'Alice', { earnedCredit: 100 });
    seedTestMember(m2, 'Bob', { earnedCredit: 100 });
    seedTestMember(enterprise1, 'Community Eggs', { isTreasury: true });
    seedTestMember(frozenMember, 'FrozenUser', { creditFrozen: true, earnedCredit: 100 });
    seedTestMember(zeroStandingMember, 'ZeroStanding', { earnedCredit: 0 });
    // Alice and Bob have traded: that is their standing to propose (their earned_credit badge is none).
    recordTestActivity(m1, m2, 20);

    // Eligibility to propose
    const entCheck = checkCanProposeDecision(enterprise1);
    testAssert(!entCheck.ok && entCheck.error?.includes('Enterprises cannot propose'), 'Enterprise cannot propose decisions');

    const frozenCheck = checkCanProposeDecision(frozenMember);
    testAssert(!frozenCheck.ok && frozenCheck.error?.includes('frozen'), 'Frozen member cannot propose decisions');

    // The refusal is in a member's words: what to do (complete a trade), never a field name (earnedCredit).
    const NO_TRADE_REFUSAL = 'You can propose a Decision once you have completed a trade';
    const zeroCheck = checkCanProposeDecision(zeroStandingMember);
    testAssert(!zeroCheck.ok && zeroCheck.error === NO_TRADE_REFUSAL, `A member with no completed trade cannot propose decisions (got ${JSON.stringify(zeroCheck)})`);
    testAssert(!/earnedCredit|earned_credit|standing/.test(zeroCheck.error ?? ''), `The refusal names no field and no "standing" (got "${zeroCheck.error}")`);

    // Badges unlock nothing (Marty, 23 Oct): a trust badge an admin gave (members.earned_credit, adminSetTier's Steward
    // here) is no standing to propose; only a trading record is. Its words are the no-standing refusal's.
    const badgeOnly = 'member_badge_only_' + Date.now();
    seedTestMember(badgeOnly, 'BadgeOnly', { earnedCredit: 600 });
    const badgeCheck = checkCanProposeDecision(badgeOnly);
    testAssert(!badgeCheck.ok && badgeCheck.error === NO_TRADE_REFUSAL,
        `A member with a trust badge and no trading record cannot propose (got ${JSON.stringify(badgeCheck)})`);
    let badgeRefusal = '';
    try {
        createDecision({ authorPubkey: badgeOnly, title: 'Badge-only proposal', description: 'A badge is no standing', touches: 'member', effect: 'freeze_credit', subject: m2 });
    } catch (e: any) { badgeRefusal = e.message; }
    testAssert(badgeRefusal.includes(NO_TRADE_REFUSAL), `createDecision refuses the badge-only member in the same words (got "${badgeRefusal}")`);

    // A trading record, with no badge, still proposes. Its pool vote weight is its trade value, and a badge adds none.
    const traderOnly = 'member_trader_only_' + Date.now();
    seedTestMember(traderOnly, 'TraderOnly', { earnedCredit: 0 });
    recordTestActivity(traderOnly, m1, 20);
    testAssert(checkCanProposeDecision(traderOnly).ok, 'A member with a trading record and no badge can propose');
    testAssert(getDecisionVoiceCredits('no-such-decision', badgeOnly).totalCredits === 0, 'A trust badge gives no voice credits on a pool Decision');
    testAssert(getDecisionVoiceCredits('no-such-decision', traderOnly).totalCredits === 20, 'Voice credits on a pool Decision are the trade value (20)');

    // Create decision with 1m1v franchise (member touch)
    const decMember = createDecision({
        authorPubkey: m1,
        title: 'Freeze Charlie credit',
        description: 'Charlie did not deliver tools',
        touches: 'member',
        effect: 'freeze_credit',
        subject: m2,
    });
    testAssert(decMember.franchise === '1m1v', 'Decisions touching member receive 1m1v franchise (§3.6)');

    // Author cannot create second open decision (limit 1)
    try {
        createDecision({
            authorPubkey: m1,
            title: 'Second proposal from Alice',
            description: 'Should fail',
            touches: 'member',
            effect: 'suspend_member',
            subject: m2,
        });
        testAssert(false, 'Should have blocked second open decision from same author');
    } catch (e: any) {
        testAssert(e.message.includes('already has an open decision'), 'Author limited to 1 open decision at a time (§10)');
    }

    // Pool decision gets quadratic franchise
    const decPool = createDecision({
        authorPubkey: m2,
        title: 'Grant 200 beans to Community Eggs',
        description: 'Feed purchase for winter',
        touches: 'pool',
        effect: 'grant_enterprise',
        subject: enterprise1,
        params: { amount: 200 },
    });
    testAssert(decPool.franchise === 'quadratic_trade', 'Decisions touching pool receive quadratic_trade franchise (§3.6)');

    // ── 2. Quorum & Denominator (active in 30d, floor K_min = 3) ──────────────
    console.log('\n--- 2. Quorum & Denominator ---');

    // Active trades for m1, m2 (their trade above), and admin
    recordTestActivity(admin, m1, 15);

    const activeCount = getActiveMembersCount30d();
    testAssert(activeCount >= 3, `Active members count >= 3 (counted ${activeCount})`);

    const qReq = getQuorumRequired(decMember);
    testAssert(qReq >= 3, `Quorum required has floor K_min = 3 (got ${qReq})`);

    // Vote under quorum: only Alice votes on decMember, then close it on tick
    castDecisionVote(decMember.id, m1, true);
    const votesBefore = getDecisionVotes(decMember.id);
    testAssert(votesBefore.length === 1, 'Alice cast vote on member decision');

    // Force close decMember by updating closes_at to the past
    db.prepare("UPDATE decisions SET closes_at = datetime('now', '-10 seconds') WHERE id = ?").run(decMember.id);
    tickDecisions();

    const decMemberAfterTick = getDecision(decMember.id)!;
    testAssert(decMemberAfterTick.status === 'unresolved', 'Decision under quorum expires as UNRESOLVED (§3.4)');
    testAssert(decMemberAfterTick.executionReason?.includes('Quorum not met'), 'Unresolved reason records quorum failure');

    // ── 3. Thresholds & Quadratic Voting ─────────────────────────────────────
    console.log('\n--- 3. Thresholds & Quadratic Voting ---');

    // Seed more voters for quorum
    const voterA = 'voter_a_' + Date.now();
    const voterB = 'voter_b_' + Date.now();
    const voterC = 'voter_c_' + Date.now();
    [voterA, voterB, voterC].forEach((v, i) => {
        seedTestMember(v, 'Voter_' + i, { earnedCredit: 100 });
        recordTestActivity(admin, v, 50); // Gives them qualified trade credits
    });

    // decPool needs quorum >= 3 and 60% support
    // voterA casts 4 votes (cost 16 credits) in favor
    // voterB casts 4 votes (cost 16 credits) in favor
    // voterC casts 2 votes (cost 4 credits) against
    const vResA = castDecisionVote(decPool.id, voterA, true, 4);
    testAssert(vResA.success && vResA.creditsUsed === 16, 'Quadratic voter A used 16 credits for 4 votes');
    castDecisionVote(decPool.id, voterB, true, 4);
    castDecisionVote(decPool.id, voterC, false, 2);

    const poolTally = tallyDecision(decPool.id);
    testAssert(poolTally.quorumMet, 'Quorum met with 3 voters');
    testAssert(poolTally.yesWeight === 8 && poolTally.noWeight === 2, 'Yes weight = 8, No weight = 2');
    testAssert(poolTally.supportRatio === 0.8, 'Support ratio is 80% (threshold 60%)');
    testAssert(poolTally.passed, 'Pool decision passed threshold');

    // Close and execute decPool on tick
    db.prepare("UPDATE decisions SET closes_at = datetime('now', '-10 seconds') WHERE id = ?").run(decPool.id);
    const balanceBeforeGrant = getBalance(enterprise1).balance;
    const commonsBeforeGrant = getCommonsBalance();

    const tickRes1 = tickDecisions();
    testAssert(tickRes1.executed >= 1, 'Tick evaluated and executed passed pool grant');

    const decPoolExecuted = getDecision(decPool.id)!;
    testAssert(decPoolExecuted.status === 'executed', 'Pool grant transitioned to EXECUTED');
    testAssert(getBalance(enterprise1).balance === balanceBeforeGrant + 200, 'Enterprise credited 200 beans in balance');
    testAssert(getCommonsBalance() === commonsBeforeGrant - 200, 'Commons pool debited 200 beans');

    // Verify transaction auth_signer provenance stamp (§3.7)
    const txRow = db.prepare(
        "SELECT * FROM transactions WHERE to_pubkey = ? AND auth_signer LIKE 'system:decision:%'"
    ).get(enterprise1) as any;
    testAssert(txRow != null, 'Grant transaction created with system:decision provenance');
    testAssert(txRow.auth_signer === `system:decision:${decPool.id}`, `auth_signer matches system:decision:${decPool.id}`);

    // ── 4. Reversible Member State Flips ────────────────────────────────────
    console.log('\n--- 4. Reversible Member State Flips ---');

    const targetUser = 'user_target_' + Date.now();
    seedTestMember(targetUser, 'TargetUser', { earnedCredit: 50 });

    // Test suspend_member
    const decSuspend = createDecision({
        authorPubkey: admin,
        title: 'Suspend target user',
        description: 'Policy violation',
        touches: 'member',
        effect: 'suspend_member',
        subject: targetUser,
    });
    castDecisionVote(decSuspend.id, voterA, true);
    castDecisionVote(decSuspend.id, voterB, true);
    castDecisionVote(decSuspend.id, voterC, true);
    closeForTick(decSuspend.id);
    tickDecisions();
    testAssert(getDecision(decSuspend.id)!.status === 'executed', 'Suspend decision executed on tick');
    testAssert((db.prepare("SELECT status FROM members WHERE public_key = ?").get(targetUser) as any).status === 'disabled', 'Target member status updated to disabled');

    // Test unsuspend_member (restoration: simple majority > 50%)
    const decUnsuspend = createDecision({
        authorPubkey: admin,
        title: 'Unsuspend target user',
        description: 'Issue resolved',
        touches: 'member',
        effect: 'unsuspend_member',
        subject: targetUser,
    });
    testAssert(decUnsuspend.effect === 'unsuspend_member', 'Unsuspend restoration created');
    castDecisionVote(decUnsuspend.id, voterA, true);
    castDecisionVote(decUnsuspend.id, voterB, true);
    castDecisionVote(decUnsuspend.id, voterC, false); // 2 yes, 1 no = 66% (> 50% simple majority)
    closeForTick(decUnsuspend.id);
    tickDecisions();
    testAssert(getDecision(decUnsuspend.id)!.status === 'executed', 'Unsuspend decision executed with simple majority');
    testAssert((db.prepare("SELECT status FROM members WHERE public_key = ?").get(targetUser) as any).status === 'active', 'Target member status restored to active');

    // Test freeze_credit / unfreeze_credit
    const decFreeze = createDecision({
        authorPubkey: admin,
        title: 'Freeze target credit',
        description: 'Overdraft review',
        touches: 'member',
        effect: 'freeze_credit',
        subject: targetUser,
    });
    castDecisionVote(decFreeze.id, voterA, true);
    castDecisionVote(decFreeze.id, voterB, true);
    castDecisionVote(decFreeze.id, voterC, true);
    closeForTick(decFreeze.id);
    tickDecisions();
    testAssert((db.prepare("SELECT credit_frozen FROM members WHERE public_key = ?").get(targetUser) as any).credit_frozen === 1, 'Member credit frozen by decision');

    const decUnfreeze = createDecision({
        authorPubkey: admin,
        title: 'Unfreeze target credit',
        description: 'Restoration',
        touches: 'member',
        effect: 'unfreeze_credit',
        subject: targetUser,
    });
    castDecisionVote(decUnfreeze.id, voterA, true);
    castDecisionVote(decUnfreeze.id, voterB, true);
    castDecisionVote(decUnfreeze.id, voterC, true);
    closeForTick(decUnfreeze.id);
    tickDecisions();
    testAssert((db.prepare("SELECT credit_frozen FROM members WHERE public_key = ?").get(targetUser) as any).credit_frozen === 0, 'Member credit unfrozen by restoration decision');

    // Test grant_voucher / revoke_voucher
    const decVoucher = createDecision({
        authorPubkey: admin,
        title: 'Grant voucher capability to Alice',
        description: 'Appoint voucher',
        touches: 'member',
        effect: 'grant_voucher',
        subject: m1,
    });
    castDecisionVote(decVoucher.id, voterA, true);
    castDecisionVote(decVoucher.id, voterB, true);
    castDecisionVote(decVoucher.id, voterC, true);
    closeForTick(decVoucher.id);
    tickDecisions();
    testAssert((db.prepare("SELECT can_vouch FROM members WHERE public_key = ?").get(m1) as any).can_vouch === 1, 'Alice granted can_vouch=1');

    const decRevokeVoucher = createDecision({
        authorPubkey: admin,
        title: 'Revoke voucher capability from Alice',
        description: 'Revocation',
        touches: 'member',
        effect: 'revoke_voucher',
        subject: m1,
    });
    castDecisionVote(decRevokeVoucher.id, voterA, true);
    castDecisionVote(decRevokeVoucher.id, voterB, true);
    castDecisionVote(decRevokeVoucher.id, voterC, true);
    closeForTick(decRevokeVoucher.id);
    tickDecisions();
    testAssert((db.prepare("SELECT can_vouch FROM members WHERE public_key = ?").get(m1) as any).can_vouch === 0, 'Alice voucher capability revoked (can_vouch=0)');

    // ── 5. Dead Subjects & Preflight Assertion ──────────────────────────────
    console.log('\n--- 5. Dead Subjects & Preflight Assertion ---');

    const deadMember = 'member_dead_' + Date.now();
    seedTestMember(deadMember, 'DeadMember');
    const decDead = createDecision({
        authorPubkey: admin,
        title: 'Action on dead member',
        description: 'Will be pruned before vote closes',
        touches: 'member',
        effect: 'suspend_member',
        subject: deadMember,
    });
    castDecisionVote(decDead.id, voterA, true);
    castDecisionVote(decDead.id, voterB, true);
    castDecisionVote(decDead.id, voterC, true);

    // Prune deadMember before tick
    adminSetUserStatus(deadMember, 'pruned');
    closeForTick(decDead.id);
    tickDecisions();

    const decDeadAfter = getDecision(decDead.id)!;
    testAssert(decDeadAfter.status === 'execution_void', 'Dead subject halts permanently at execution_void (§3.7)');
    testAssert(decDeadAfter.executionReason?.includes('pruned'), 'Tombstone reason explains subject was pruned');

    // ── 6. Underfunded Grants & Funding Queue ────────────────────────────────
    console.log('\n--- 6. Underfunded Grants & Funding Queue ---');

    const bigGrantEnterprise = 'ent_big_solar_' + Date.now();
    seedTestMember(bigGrantEnterprise, 'Big Solar Co-op', { isTreasury: true });

    const currentCommons = getCommonsBalance();
    const bigAmount = currentCommons + 500; // More than commons balance!

    // A grant is capped when proposed (grant cap, 2026-09-27), so an underfunded one gets here only by the Commons paying
    // out between proposal and close: it could pay the grant when proposed, and is short of it by the tick.
    setCommonsBalance(bigAmount);
    const decBigGrant = createDecision({
        authorPubkey: admin,
        title: 'Grant for community solar',
        description: 'Exceeds current pool balance',
        touches: 'pool',
        effect: 'grant_enterprise',
        subject: bigGrantEnterprise,
        params: { amount: bigAmount },
    });
    setCommonsBalance(currentCommons);
    castDecisionVote(decBigGrant.id, voterA, true, 5);
    castDecisionVote(decBigGrant.id, voterB, true, 5);
    castDecisionVote(decBigGrant.id, voterC, true, 5);
    closeForTick(decBigGrant.id);
    tickDecisions();
    const decQueued = getDecision(decBigGrant.id)!;
    testAssert(decQueued.status === 'passed_queued_for_funds', 'Underfunded grant queued at passed_queued_for_funds (§3.7)');
    testAssert(decQueued.executionReason?.includes('Insufficient pool funds'), 'Queue reason explains waiting for funds');

    // Increase commons pool (simulating fee revenue influx)
    setCommonsBalance(bigAmount + 200);
    const tickQueueRes = tickDecisions();
    testAssert(tickQueueRes.executed >= 1, 'Next tick executed queued grant once pool became solvent');

    const decQueuedAfterFunding = getDecision(decBigGrant.id)!;
    testAssert(decQueuedAfterFunding.status === 'executed', 'Queued grant completed execution');
    testAssert(getBalance(bigGrantEnterprise).balance === bigAmount, 'Solar enterprise received full grant amount');

    // Test 90-day expiry of queued grants
    const staleGrantEnterprise = 'ent_stale_grant_' + Date.now();
    seedTestMember(staleGrantEnterprise, 'Stale Initiative', { isTreasury: true });
    setCommonsBalance(500); // Within the cap when proposed...
    const decStale = createDecision({
        authorPubkey: admin,
        title: 'Stale initiative grant',
        description: 'Underfunded and sits for 90 days',
        touches: 'pool',
        effect: 'grant_enterprise',
        subject: staleGrantEnterprise,
        params: { amount: 500 },
    });
    setCommonsBalance(10); // ...then a low pool by the time it closes
    castDecisionVote(decStale.id, voterA, true, 2);
    castDecisionVote(decStale.id, voterB, true, 2);
    castDecisionVote(decStale.id, voterC, true, 2);
    closeForTick(decStale.id);
    tickDecisions();
    testAssert(getDecision(decStale.id)!.status === 'passed_queued_for_funds', 'Stale grant entered queue');

    // Simulate 91 days passing
    const ninetyOneDaysMs = 91 * 24 * 60 * 60 * 1000;
    tickDecisions(Date.now() + ninetyOneDaysMs);
    const decStaleAfter90 = getDecision(decStale.id)!;
    testAssert(decStaleAfter90.status === 'failed', 'Queued grant expired after 90 days (§3.7)');
    testAssert(decStaleAfter90.executionReason?.includes('expired after 90 days'), 'Expiration reason recorded');

    // Reset pool
    setCommonsBalance(1000);

    // ── 7. Destructive Member Removal & Grace Window ────────────────────────
    console.log('\n--- 7. Destructive Member Removal & Grace Window ---');

    const rogueMember = 'member_rogue_' + Date.now();
    seedTestMember(rogueMember, 'RogueDave', { earnedCredit: 50 });

    // Removal requires 66% supermajority on 25% quorum. Since removal by vote S3 nobody proposes one (only an admin's pause
    // opens it, section 13); one a member proposed before still runs to its end, and is this section's.
    const decRemoval = removalProposedFromBefore({
        authorPubkey: admin,
        title: 'Remove RogueDave from node',
        description: 'Malicious behaviour',
        subject: rogueMember,
    });
    castDecisionVote(decRemoval.id, voterA, true);
    castDecisionVote(decRemoval.id, voterB, true);
    castDecisionVote(decRemoval.id, voterC, true);
    closeForTick(decRemoval.id);
    tickDecisions();
    const decRemovalGrace = getDecision(decRemoval.id)!;
    testAssert(decRemovalGrace.status === 'execution_pending_grace', 'Passed member removal enters execution_pending_grace (§3.7)');
    testAssert(decRemovalGrace.gracePeriodEndsAt != null, '7-day grace period timestamp set');
    testAssert((db.prepare("SELECT status, credit_frozen FROM members WHERE public_key = ?").get(rogueMember) as any).status === 'disabled', 'Member immediately suspended during grace window');
    testAssert((db.prepare("SELECT credit_frozen FROM members WHERE public_key = ?").get(rogueMember) as any).credit_frozen === 1, 'Member credit immediately frozen during grace window');

    // Admin Halt Brake (§3.7)
    const haltRes = adminHaltDecision(decRemoval.id, admin, 'Evidence was forged; investigation pending');
    testAssert(haltRes.success, 'Admin successfully halted removal decision with signed reason');
    const decHalted = getDecision(decRemoval.id)!;
    testAssert(decHalted.status === 'admin_halted', 'Decision status updated to admin_halted');
    testAssert(decHalted.adminHaltReason?.includes('Evidence was forged'), 'Public halt justification recorded');
    testAssert((db.prepare("SELECT status FROM members WHERE public_key = ?").get(rogueMember) as any).status === 'active', 'Member reinstated to active upon admin halt');

    // Test admin halt on an OPEN removal decision does not activate a previously disabled/frozen member
    const disabledMember = 'disabled_member_' + Date.now();
    seedTestMember(disabledMember, 'DisabledDave');
    db.prepare("UPDATE members SET status = 'disabled', credit_frozen = 1 WHERE public_key = ?").run(disabledMember);
    db.prepare("INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch, last_updated_at) VALUES (?, -75, 0, ?)").run(disabledMember, new Date().toISOString());

    const decOpenRemoval = removalProposedFromBefore({
        authorPubkey: admin,
        title: 'Remove already disabled member',
        description: 'Testing halt on open decision',
        subject: disabledMember,
        closesAt: new Date(Date.now() + 100000).toISOString(),
    });
    testAssert(decOpenRemoval.status === 'open', 'Decision is open');
    testAssert(decOpenRemoval.params?.debt === 75, 'Canonical debt of 75 beans populated on removal decision from accounts ledger');
    testAssert(decOpenRemoval.params?.memberName === 'DisabledDave', 'Member callsign populated in params.memberName');
    const haltOpenRes = adminHaltDecision(decOpenRemoval.id, admin, 'Halted while open; member remains disabled');
    testAssert(haltOpenRes.success, 'Halted open decision');
    const disabledMemberCheck = db.prepare("SELECT status, credit_frozen FROM members WHERE public_key = ?").get(disabledMember) as any;
    testAssert(disabledMemberCheck.status === 'disabled', 'Halting OPEN decision does NOT reactivate a disabled member');
    testAssert(disabledMemberCheck.credit_frozen === 1, 'Halting OPEN decision does NOT unfreeze credit for a frozen member');

    // Second removal decision — test auto-execution when grace period ends
    const decRemoval2 = removalProposedFromBefore({
        authorPubkey: admin,
        title: 'Remove RogueDave round 2',
        description: 'Confirmed rogue activity',
        subject: rogueMember,
    });
    castDecisionVote(decRemoval2.id, voterA, true);
    castDecisionVote(decRemoval2.id, voterB, true);
    castDecisionVote(decRemoval2.id, voterC, true);
    closeForTick(decRemoval2.id);
    tickDecisions();
    testAssert(getDecision(decRemoval2.id)!.status === 'execution_pending_grace', 'Round 2 enters grace');

    // Advance time past 7-day grace window
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    const tickGraceRes = tickDecisions(Date.now() + eightDaysMs);
    testAssert(tickGraceRes.graceExpired >= 1, 'Tick fired expired grace period removal');

    const decRemoval2Final = getDecision(decRemoval2.id)!;
    testAssert(decRemoval2Final.status === 'executed', 'Destructive removal executed after grace window');
    testAssert((db.prepare("SELECT status FROM members WHERE public_key = ?").get(rogueMember) as any).status === 'pruned', 'RogueDave pruned from members table');

    // ── 8. Reinstatement Cancelling Pending Removal Grace ───────────────────
    console.log('\n--- 8. Reinstatement Cancelling Grace Removal ---');

    const memberToRevert = 'member_revert_' + Date.now();
    seedTestMember(memberToRevert, 'RevertMe');

    const decRemoval3 = removalProposedFromBefore({
        authorPubkey: admin,
        title: 'Remove RevertMe',
        description: 'Misunderstanding',
        subject: memberToRevert,
    });
    castDecisionVote(decRemoval3.id, voterA, true);
    castDecisionVote(decRemoval3.id, voterB, true);
    castDecisionVote(decRemoval3.id, voterC, true);
    closeForTick(decRemoval3.id);
    tickDecisions();
    testAssert(getDecision(decRemoval3.id)!.status === 'execution_pending_grace', 'RevertMe entered grace');

    // Reinstatement decision passes before grace expires
    const decReinstate = createDecision({
        authorPubkey: admin,
        title: 'Reinstate RevertMe',
        description: 'Mistake corrected',
        touches: 'member',
        effect: 'reinstate_member',
        subject: memberToRevert,
    });
    castDecisionVote(decReinstate.id, voterA, true);
    castDecisionVote(decReinstate.id, voterB, true);
    castDecisionVote(decReinstate.id, voterC, true);
    closeForTick(decReinstate.id);
    tickDecisions();

    testAssert(getDecision(decReinstate.id)!.status === 'executed', 'Reinstate decision executed');
    testAssert(getDecision(decRemoval3.id)!.status === 'failed', 'Pending removal cancelled by reinstatement');
    testAssert((db.prepare("SELECT status FROM members WHERE public_key = ?").get(memberToRevert) as any).status === 'active', 'Member remains active');

    // ── 9. Executor Idempotency & Rollback Safety ───────────────────────────
    console.log('\n--- 9. Executor Idempotency & Rollback Safety ---');

    // Calling executeDecision on already executed decision is idempotent
    const rerun = executeDecision(decPoolExecuted.id);
    testAssert(rerun.success && rerun.status === 'executed', 'executeDecision is idempotent on executed decisions');

    // Rollback test: an execution that throws inside the transaction. A temporary trigger makes the
    // grant_voucher write fail part-way, the way a real constraint violation would.
    const m1VouchBefore = (db.prepare('SELECT can_vouch FROM members WHERE public_key = ?').get(m1) as any).can_vouch;
    db.exec(`CREATE TRIGGER zz_block_vouch_m1 BEFORE UPDATE OF can_vouch ON members
             WHEN NEW.public_key = '${m1}' BEGIN SELECT RAISE(ABORT, 'vouch blocked by test'); END;`);
    const badDecision = { id: insertStoredDecision({ author: admin, effect: 'grant_voucher', touches: 'member', subject: m1 }) };
    const execBadRes = executeDecision(badDecision.id);
    db.exec('DROP TRIGGER zz_block_vouch_m1');
    testAssert(!execBadRes.success && execBadRes.status === 'execution_blocked', 'Failed execution rolls back to execution_blocked');
    testAssert(getDecision(badDecision.id)!.status === 'execution_blocked', 'Decision status persisted as execution_blocked');
    const m1VouchAfter = (db.prepare('SELECT can_vouch FROM members WHERE public_key = ?').get(m1) as any).can_vouch;
    testAssert(m1VouchAfter === m1VouchBefore, `A failed execution leaves the member unchanged (can_vouch ${m1VouchBefore} -> ${m1VouchAfter})`);

    // Effects removed on 2026-09-19 (did nothing, or voted on earned standing) cannot be proposed at all.
    for (const [effect, touches] of [
        ['set_rule', 'rule'], ['set_levy', 'rule'], ['poll', 'nothing'],
        ['grant_tier', 'member'], ['revoke_tier', 'member'], ['grant_elder', 'member'], ['revoke_elder', 'member'],
    ] as const) {
        let refused = '';
        try {
            createDecision({ authorPubkey: voterA, title: `Refused ${effect}`, description: 'Should be refused', touches: touches as any, effect: effect as any, subject: m1, params: { tier: 'Elder' } });
        } catch (e: any) {
            refused = e.message;
        }
        testAssert(/Unknown decision effect/.test(refused), `createDecision refuses ${effect} (${refused || 'accepted'})`);
    }

    // ── 9b. Robustness & Preflight Invariants ─────────────────────────────────
    console.log('\n--- 9b. Robustness & Preflight Invariants ---');

    // NaN vote count rejected
    const decForVoteCheck = createDecision({
        authorPubkey: admin,
        title: 'Vote check decision',
        description: 'Testing vote validation',
        touches: 'member',
        effect: 'grant_voucher',
        subject: m1,
    });
    const nanVoteRes = castDecisionVote(decForVoteCheck.id, voterA, true, NaN);
    testAssert(!nanVoteRes.success && nanVoteRes.error?.includes('positive finite integer'), 'NaN vote count rejected');

    const negVoteRes = castDecisionVote(decForVoteCheck.id, voterA, true, -5);
    testAssert(!negVoteRes.success && negVoteRes.error?.includes('positive finite integer'), 'Negative vote count rejected');
    closeForTick(decForVoteCheck.id);
    tickDecisions();

    // grant_hardship without valid member fails preflight with void
    const fakeRecipient = 'nonexistent_pubkey_' + Date.now();
    const hardshipDec = createDecision({
        authorPubkey: voterA,
        title: 'Hardship grant to ghost member',
        description: 'Testing preflight',
        touches: 'pool',
        effect: 'grant_hardship',
        subject: fakeRecipient,
        params: { amount: 50 },
    });
    const execHardshipRes = executeDecision(hardshipDec.id);
    testAssert(execHardshipRes.status === 'execution_void', 'Hardship to nonexistent recipient halts at execution_void');

    // Head-of-line blocking resilience in tickDecisions:
    // Create an expired decision with broken params that throws, plus a normal valid expired decision
    db.exec(`CREATE TRIGGER zz_block_vouch_hol BEFORE UPDATE OF can_vouch ON members
             WHEN NEW.public_key = '${m1}' BEGIN SELECT RAISE(ABORT, 'vouch blocked by test'); END;`);
    const brokenExpiredDec = { id: insertStoredDecision({ author: voterB, effect: 'grant_voucher', touches: 'member', subject: m1 }) };
    castDecisionVote(brokenExpiredDec.id, voterA, true, 1);
    castDecisionVote(brokenExpiredDec.id, voterC, true, 1);
    castDecisionVote(brokenExpiredDec.id, admin, true, 1);
    closeForTick(brokenExpiredDec.id);

    const targetGoodMember = 'good_target_' + Date.now();
    seedTestMember(targetGoodMember, 'GoodTarget', { earnedCredit: 50 });
    const goodExpiredDec = createDecision({
        authorPubkey: voterC,
        title: 'Good expired decision following broken one',
        description: 'Should still execute',
        touches: 'member',
        effect: 'grant_voucher',
        subject: targetGoodMember,
        params: {},
    });
    castDecisionVote(goodExpiredDec.id, voterA, true, 1);
    castDecisionVote(goodExpiredDec.id, voterB, true, 1);
    castDecisionVote(goodExpiredDec.id, admin, true, 1);
    closeForTick(goodExpiredDec.id);

    tickDecisions();
    db.exec('DROP TRIGGER zz_block_vouch_hol');
    testAssert(getDecision(brokenExpiredDec.id)!.status === 'execution_blocked', 'Failing expired decision isolated as execution_blocked');
    testAssert(getDecision(goodExpiredDec.id)!.status === 'executed', 'Subsequent expired decision executed successfully without HOL blocking');

    // Test remove_lead_keeper execution with conflated params (subject as member)
    const keeperMember = 'keeper_' + Date.now();
    const entPubkey = 'enterprise_test_' + Date.now();
    const keeperAuthor = 'keeper_author_' + Date.now();
    seedTestMember(keeperMember, 'TestKeeper');
    seedTestMember(keeperAuthor, 'KeeperAuthor', { earnedCredit: 50 });
    recordTestActivity(admin, keeperAuthor, 50); // a trade: their standing to propose
    db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_at, granted_by) VALUES (?, ?, 'lead', ?, 'admin')")
        .run(entPubkey, keeperMember, Date.now());
    db.prepare("UPDATE members SET can_operate = 1 WHERE public_key = ?").run(keeperMember);

    const removeKeeperDec = createDecision({
        authorPubkey: keeperAuthor,
        title: 'Remove rogue lead keeper',
        description: 'Remove rogue lead keeper',
        touches: 'member',
        effect: 'remove_lead_keeper',
        subject: keeperMember,
        params: { enterprisePubkey: keeperMember, leadPubkey: keeperMember },
    });
    castDecisionVote(removeKeeperDec.id, voterA, true, 1);
    castDecisionVote(removeKeeperDec.id, voterB, true, 1);
    castDecisionVote(removeKeeperDec.id, admin, true, 1);
    const execKeeperRes = executeDecision(removeKeeperDec.id);
    testAssert(execKeeperRes.success, 'remove_lead_keeper executed successfully');
    const remainingRoles = db.prepare("SELECT COUNT(*) AS c FROM treasury_operators WHERE member_pubkey = ? AND role = 'lead'").get(keeperMember) as any;
    testAssert(remainingRoles.c === 0, 'Lead keeper role deleted from treasury_operators');
    const memberAfterRemoval = db.prepare("SELECT can_operate FROM members WHERE public_key = ?").get(keeperMember) as any;
    testAssert(memberAfterRemoval.can_operate === 0, 'can_operate reset to 0 when member has no remaining roles');

    // ── 11. Governance Security, Parameter Decoupling & Ledger Hardening ────
    console.log('\n--- 11. Security, Parameter Decoupling & Ledger Hardening ---');

    // 11a. Parameter Decoupling: cannot propose remove_member with touches='pool'
    let decouplingCaught = false;
    try {
        createDecision({
            authorPubkey: admin,
            title: 'Spoofed touches',
            description: 'Try to bypass the member franchise',
            touches: 'pool',
            effect: 'remove_member',
            subject: m1,
        });
    } catch (e: any) {
        decouplingCaught = e.message.includes('Invalid touch');
    }
    testAssert(decouplingCaught, 'Mismatched touches and effect rejected by createDecision');

    // 11b. Expired voting window: castDecisionVote rejects votes after closesAt
    const decExpired = createDecision({
        authorPubkey: admin,
        title: 'Expiring vote',
        description: 'Test expiration',
        touches: 'member',
        effect: 'suspend_member',
        subject: m2,
    });
    closeForTick(decExpired.id);
    const expiredVoteRes = castDecisionVote(decExpired.id, voterA, true);
    testAssert(!expiredVoteRes.success && expiredVoteRes.error === 'Voting window has closed', 'castDecisionVote rejects vote on expired decision');
    tickDecisions(); // Closes decExpired as unresolved

    // 11c. voteCount NaN poisoning protection
    const decVoteSan = createDecision({
        authorPubkey: admin,
        title: 'Sanitized count test',
        description: 'Testing NaN count',
        touches: 'member',
        effect: 'suspend_member',
        subject: m2,
    });
    const nanVoteRes2 = castDecisionVote(decVoteSan.id, voterA, true, NaN as any);
    testAssert(!nanVoteRes2.success && nanVoteRes2.error?.includes('positive finite integer'), 'NaN voteCount rejected safely');
    closeForTick(decVoteSan.id);
    tickDecisions(); // Closes decVoteSan

    // 11d. Net unspent credits in getDecisionVoiceCredits
    const decQCredits = createDecision({
        authorPubkey: admin,
        title: 'Voice credits calculation test',
        description: 'Testing net unspent credits',
        touches: 'pool',
        effect: 'grant_enterprise',
        subject: enterprise1,
        params: { amount: 10 },
    });
    const initialCredits = getDecisionVoiceCredits(decQCredits.id, voterA);
    castDecisionVote(decQCredits.id, voterA, true, 3); // 9 credits
    const remainingCredits = getDecisionVoiceCredits(decQCredits.id, voterA);
    testAssert(remainingCredits.usedCredits === 9, 'usedCredits tracks 9 credits spent');
    testAssert(remainingCredits.availableCredits === initialCredits.totalCredits - 9, 'availableCredits deducts spent credits');
    closeForTick(decQCredits.id);
    tickDecisions(); // Closes decQCredits

    // 11e. Sole node owner removal: refused when proposed (§3.8, as for any owner or admin since 2026-10-01), and
    // blocked in preflight for a vote a node running the older code had already opened.
    const refusalOf = (fn: () => unknown): string => { try { fn(); return ''; } catch (e: any) { return e?.message || String(e); } };
    const soleOwnerRemovalRefusal = refusalOf(() => createDecision({
        authorPubkey: admin,
        title: 'Attempt removal of sole node owner',
        description: 'Refused when proposed',
        touches: 'member',
        effect: 'remove_member',
        subject: admin,
    }));
    testAssert(/can't remove or suspend an owner or admin/.test(soleOwnerRemovalRefusal), `Sole owner removal refused when proposed (§3.8): ${soleOwnerRemovalRefusal}`);
    // A vote a node running the older code had already opened (the suite's stored-row helper).
    const decSoleOwnerRemoval = { id: insertStoredDecision({ author: admin, effect: 'remove_member', touches: 'member', subject: admin }) };
    castDecisionVote(decSoleOwnerRemoval.id, voterA, true);
    castDecisionVote(decSoleOwnerRemoval.id, voterB, true);
    castDecisionVote(decSoleOwnerRemoval.id, voterC, true);
    closeForTick(decSoleOwnerRemoval.id);
    tickDecisions();
    const soleOwnerDec = getDecision(decSoleOwnerRemoval.id)!;
    testAssert(soleOwnerDec.status === 'execution_blocked', 'Sole owner removal blocked before grace window or suspension');
    testAssert((db.prepare("SELECT status FROM members WHERE public_key = ?").get(admin) as any).status === 'active', 'Sole node owner remains active');

    // 11e-2. Sole node owner suspend: refused when proposed, and blocked in preflight per §3.8
    const soleOwnerSuspendRefusal = refusalOf(() => createDecision({
        authorPubkey: admin,
        title: 'Attempt to suspend sole owner',
        description: 'Refused when proposed',
        touches: 'member',
        effect: 'suspend_member',
        subject: admin,
    }));
    testAssert(/can't remove or suspend an owner or admin/.test(soleOwnerSuspendRefusal), `Sole owner suspension refused when proposed (§3.8): ${soleOwnerSuspendRefusal}`);
    const decSoleOwnerSuspend = { id: insertStoredDecision({ author: admin, effect: 'suspend_member', touches: 'member', subject: admin }) };
    castDecisionVote(decSoleOwnerSuspend.id, voterA, true);
    castDecisionVote(decSoleOwnerSuspend.id, voterB, true);
    castDecisionVote(decSoleOwnerSuspend.id, voterC, true);
    closeForTick(decSoleOwnerSuspend.id);
    tickDecisions();
    const soleOwnerSuspendDec = getDecision(decSoleOwnerSuspend.id)!;
    testAssert(soleOwnerSuspendDec.status === 'execution_blocked', 'Sole owner suspension blocked in preflight (§3.8)');
    testAssert((db.prepare("SELECT status FROM members WHERE public_key = ?").get(admin) as any).status === 'active', 'Sole node owner remains active after suspend attempt');

    // 11e-3. Not only the sole owner (§3.8): a co-owner or an admin is refused when proposed, and a vote that opened while
    // its subject held no role is blocked if they hold one when it would be carried out. They keep it, and stay active.
    const coOwnerE = 'co_owner_' + Date.now();
    seedTestMember(coOwnerE, 'CoOwnerErin');
    grantNodeRole(coOwnerE, 'owner', admin);
    testAssert(/can't remove or suspend an owner or admin/.test(refusalOf(() => createDecision({
        authorPubkey: admin, title: 'Remove a co-owner', description: 'Refused when proposed', touches: 'member', effect: 'remove_member', subject: coOwnerE,
    }))), 'A co-owner removal is refused when proposed (§3.8)');
    const lateAdmin = 'late_admin_' + Date.now();
    seedTestMember(lateAdmin, 'LateAdminLou');
    const decLateAdmin = createDecision({
        authorPubkey: admin, title: 'Suspend Lou', description: 'Opened while Lou held no role', touches: 'member', effect: 'suspend_member', subject: lateAdmin,
    });
    grantNodeRole(lateAdmin, 'admin', admin);
    castDecisionVote(decLateAdmin.id, voterA, true);
    castDecisionVote(decLateAdmin.id, voterB, true);
    castDecisionVote(decLateAdmin.id, voterC, true);
    closeForTick(decLateAdmin.id);
    tickDecisions();
    testAssert(getDecision(decLateAdmin.id)!.status === 'execution_blocked', 'A suspension of someone made an admin while it was open is blocked in preflight (§3.8)');
    testAssert((db.prepare("SELECT status FROM members WHERE public_key = ?").get(lateAdmin) as any).status === 'active'
        && (db.prepare("SELECT role FROM node_roles WHERE member_pubkey = ?").get(lateAdmin) as any)?.role === 'admin',
        'and the admin stays active, with their role');
    // A moderator is a member with a job: a vote can still suspend one.
    const modE = 'moderator_' + Date.now();
    seedTestMember(modE, 'ModMia');
    grantNodeRole(modE, 'moderator', admin);
    const decMod = createDecision({ authorPubkey: admin, title: 'Suspend Mia', description: 'A moderator, as any member', touches: 'member', effect: 'suspend_member', subject: modE });
    testAssert(decMod.status === 'open', 'A Decision to suspend a moderator still opens');
    closeForTick(decMod.id);
    tickDecisions(); // closes unvoted, out of the way of the author's one-open limit

    // 11f. Hardship grant validates recipient is not treasury or missing
    const decBadHardship = createDecision({
        authorPubkey: admin,
        title: 'Hardship grant to enterprise',
        description: 'Invalid recipient',
        touches: 'pool',
        effect: 'grant_hardship',
        subject: enterprise1, // Enterprise, not member!
        params: { amount: 50 },
    });
    castDecisionVote(decBadHardship.id, voterA, true, 2);
    castDecisionVote(decBadHardship.id, voterB, true, 2);
    castDecisionVote(decBadHardship.id, voterC, true, 2);
    closeForTick(decBadHardship.id);
    tickDecisions();
    testAssert(getDecision(decBadHardship.id)!.status === 'execution_void', 'Hardship grant with treasury subject transitions to execution_void');

    // 11g. Write off deficit financial execution
    const insolventEnt = 'ent_insolvent_' + Date.now();
    seedTestMember(insolventEnt, 'Insolvent Shop', { isTreasury: true });
    // Give negative balance
    const acctInsolvent = ledger.getAccount(insolventEnt);
    acctInsolvent.balance = -150;
    db.prepare("UPDATE accounts SET balance = -150 WHERE public_key = ?").run(insolventEnt);
    setCommonsBalance(500);

    const decWriteOff = createDecision({
        authorPubkey: admin,
        title: 'Write off Insolvent Shop deficit',
        description: 'Clear -150 deficit from Commons pool',
        touches: 'pool',
        effect: 'write_off_deficit',
        subject: insolventEnt,
    });
    castDecisionVote(decWriteOff.id, voterA, true, 4);
    castDecisionVote(decWriteOff.id, voterB, true, 4);
    castDecisionVote(decWriteOff.id, voterC, true, 4);
    closeForTick(decWriteOff.id);
    tickDecisions();
    testAssert(getDecision(decWriteOff.id)!.status === 'executed', 'write_off_deficit executed successfully');
    testAssert(ledger.getAccount(insolventEnt).balance === 0, 'Insolvent enterprise balance reset to 0');
    testAssert(getCommonsBalance() === 350, 'Commons pool debited 150 beans to cover deficit');
    const writeOffTx = db.prepare("SELECT * FROM transactions WHERE to_pubkey = ? AND auth_signer = ?").get(insolventEnt, `system:decision:${decWriteOff.id}`) as any;
    testAssert(writeOffTx != null && writeOffTx.amount === 150, 'Deficit write-off transaction recorded with provenance');

    // 11h. Write off deficit queued when pool funds insufficient, then automatically executed on tick when replenished
    const queuedInsolventEnt = 'ent_queued_insolvent_' + Date.now();
    seedTestMember(queuedInsolventEnt, 'Queued Insolvent', { isTreasury: true });
    const acctQueued = ledger.getAccount(queuedInsolventEnt);
    acctQueued.balance = -200;
    db.prepare("UPDATE accounts SET balance = -200 WHERE public_key = ?").run(queuedInsolventEnt);
    setCommonsBalance(50); // Only 50 available, deficit is 200

    const decQueuedWriteOff = createDecision({
        authorPubkey: admin,
        title: 'Queued write-off for deficit',
        description: 'Needs 200, pool only has 50',
        touches: 'pool',
        effect: 'write_off_deficit',
        subject: queuedInsolventEnt,
    });
    castDecisionVote(decQueuedWriteOff.id, voterA, true, 4);
    castDecisionVote(decQueuedWriteOff.id, voterB, true, 4);
    castDecisionVote(decQueuedWriteOff.id, voterC, true, 4);
    closeForTick(decQueuedWriteOff.id);
    tickDecisions();
    testAssert(getDecision(decQueuedWriteOff.id)!.status === 'passed_queued_for_funds', 'Underfunded write_off_deficit enters passed_queued_for_funds');

    // Replenish Commons pool
    setCommonsBalance(300);
    tickDecisions();
    testAssert(getDecision(decQueuedWriteOff.id)!.status === 'executed', 'Queued write_off_deficit executes automatically once pool has funds');
    testAssert(ledger.getAccount(queuedInsolventEnt).balance === 0, 'Queued insolvent enterprise balance reset to 0');
    // 11i. Enforce 1-grant queue capacity per §3.7: trailing underfunded grants become execution_blocked
    // Each grant is within the cap when proposed; the pool is underfunded by the time each one closes.
    setCommonsBalance(100);
    const entQueue1 = 'ent_q1_' + Date.now();
    seedTestMember(entQueue1, 'Q1 Enterprise', { isTreasury: true });
    const decQ1 = createDecision({
        authorPubkey: admin,
        title: 'Grant Q1',
        description: 'First queued grant',
        touches: 'pool',
        effect: 'grant_enterprise',
        subject: entQueue1,
        params: { amount: 100 },
    });
    setCommonsBalance(10); // Pool underfunded
    castDecisionVote(decQ1.id, voterA, true, 4);
    castDecisionVote(decQ1.id, voterB, true, 4);
    castDecisionVote(decQ1.id, voterC, true, 4);
    closeForTick(decQ1.id);
    tickDecisions();
    testAssert(getDecision(decQ1.id)!.status === 'passed_queued_for_funds', 'First underfunded grant occupies queue slot');

    const entQueue2 = 'ent_q2_' + Date.now();
    seedTestMember(entQueue2, 'Q2 Enterprise', { isTreasury: true });
    setCommonsBalance(150);
    const decQ2 = createDecision({
        authorPubkey: admin,
        title: 'Grant Q2',
        description: 'Second underfunded grant exceeding queue capacity',
        touches: 'pool',
        effect: 'grant_enterprise',
        subject: entQueue2,
        params: { amount: 150 },
    });
    setCommonsBalance(10); // Pool underfunded again
    castDecisionVote(decQ2.id, voterA, true, 4);
    castDecisionVote(decQ2.id, voterB, true, 4);
    castDecisionVote(decQ2.id, voterC, true, 4);
    closeForTick(decQ2.id);
    tickDecisions();
    testAssert(getDecision(decQ2.id)!.status === 'execution_blocked', 'Second underfunded grant blocked when queue is at capacity (§3.7)');
    testAssert(getDecision(decQ2.id)!.executionError?.includes('Funding queue full'), 'Blocked reason cites 1-grant queue limit');

    // ── 13. Removal by vote S2: a pause opens the community's vote on removing the member ──
    // scratch/fable-design/DESIGN-removal-by-vote-fable.md §3.2 (how a pause ends), §3.3 (a paused member keeps their vote),
    // §5 point 2 (the subject is not in their own electorate), §7 (an old "Keep …'s suspension?" vote ends as before).
    console.log('\n--- 13. Removal by vote S2: the pause vote ---');
    const DAY = 24 * 60 * 60 * 1000;
    const statusOf = (pk: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as any)?.status;
    const frozenOf = (pk: string) => (db.prepare('SELECT COALESCE(credit_frozen, 0) AS f FROM members WHERE public_key = ?').get(pk) as any)?.f;
    const roleRow = (pk: string) => db.prepare('SELECT role, granted_at, granted_by, session_epoch, break_glass_hash FROM node_roles WHERE member_pubkey = ?').get(pk) as any;
    // The role row given back, bar the session epoch, which moves on by one (admin sessions from before stay dead).
    const sameRole = (before: any, after: any) => !!before && !!after && before.role === after.role && before.granted_at === after.granted_at
        && before.granted_by === after.granted_by && after.session_epoch === before.session_epoch + 1;
    const heldAside = (decisionId: string) => db.prepare('SELECT member_pubkey, role FROM suspended_node_roles WHERE decision_id = ?').get(decisionId) as any;
    const accountsNow = () => JSON.stringify(db.prepare('SELECT public_key, balance FROM accounts ORDER BY public_key').all());
    const markActive = (pk: string) => db.prepare('UPDATE members SET last_active_at = ? WHERE public_key = ?').run(new Date().toISOString(), pk);
    // Every block below measures its own electorate: nobody from the sections above counts as active any more.
    db.prepare('UPDATE members SET last_active_at = NULL').run();
    db.prepare('DELETE FROM marketplace_transactions').run();
    db.prepare('DELETE FROM posts').run();
    db.prepare('DELETE FROM decision_votes').run();
    // A member who joined 30 days ago; active in the last 30 days only when asked, so each electorate below stays small
    // (the six voters, and whoever a check needs counted).
    const fresh = (callsign: string, active = false): string => {
        const pk = `s2_${callsign.toLowerCase()}_${Date.now()}`;
        seedTestMember(pk, callsign);
        if (active) markActive(pk);
        return pk;
    };
    const retire = (...pks: string[]) => { for (const pk of pks) db.prepare('UPDATE members SET last_active_at = NULL WHERE public_key = ?').run(pk); };
    // Whether this member, active in the last 30 days, counts in this Decision's electorate: it drops by one without them.
    const countsIn = (decisionId: string, pk: string): boolean => {
        markActive(pk);
        const withThem = tallyDecision(decisionId).electorate;
        retire(pk);
        const without = tallyDecision(decisionId).electorate;
        markActive(pk);
        return withThem === without + 1;
    };
    const voters = ['Vera', 'Wade', 'Xena', 'Yuri', 'Zoe', 'Abel'].map(c => fresh(c, true));
    const pause = (pk: string, reason = 'Threats made to another member at the market') => {
        const r = adminEmergencySuspend(pk, admin, reason);
        if (!r.success || !r.decision) throw new Error(`could not pause ${pk}: ${r.error}`);
        return getDecision(r.decision.id)!;
    };
    const vote = (id: string, yes: number, no: number) => {
        voters.slice(0, yes).forEach(v => castDecisionVote(id, v, true));
        voters.slice(yes, yes + no).forEach(v => castDecisionVote(id, v, false));
    };
    const closeAndTick = (id: string) => { closeForTick(id); tickDecisions(); return getDecision(id)!; };
    const isOff = (r: { success: boolean }) => !r.success;
    // Admins with standing propose the other Decisions below (one open Decision each).
    const authorFor = (callsign: string) => { const pk = fresh(callsign); grantNodeRole(pk, 'admin', admin); return pk; };
    const authorA = authorFor('AuthorAda'), authorB = authorFor('AuthorBo'), authorC = authorFor('AuthorCy'), authorD = authorFor('AuthorDee');

    // 13a. The pause opens "Remove X?", the node's own removal vote.
    const pia = fresh('PausedPia', true);
    grantNodeRole(pia, 'moderator', admin);
    const countBeforePause = getActiveMembersCount30d();
    const accountsBeforePause = accountsNow();
    const piaVote = pause(pia);
    const countAfterPause = getActiveMembersCount30d();
    testAssert(piaVote.effect === 'remove_member' && piaVote.touches === 'member' && piaVote.franchise === '1m1v'
        && piaVote.authorPubkey === 'SYSTEM' && piaVote.status === 'open' && piaVote.subject === pia,
        `An admin's pause opens the community's vote on removing the member, by the node itself (${piaVote.effect}, ${piaVote.authorPubkey}, ${piaVote.status})`);
    testAssert(piaVote.title === 'Remove PausedPia?', `It asks "Remove PausedPia?" (${JSON.stringify(piaVote.title)})`);
    testAssert(piaVote.params?.rule === 2 && piaVote.params?.pausedBy === admin && piaVote.params?.reason === 'Threats made to another member at the market'
        && piaVote.params?.memberName === 'PausedPia', `Its params carry rule 2, who paused, the name and the reason (${JSON.stringify(piaVote.params)})`);
    testAssert(String(piaVote.description).startsWith(`An admin paused PausedPia on ${piaVote.opensAt.slice(0, 10)}.`)
        && String(piaVote.description).endsWith('Reason given: Threats made to another member at the market'),
        `Its description says who paused whom when, and the reason (${JSON.stringify(piaVote.description)})`);
    testAssert(Date.parse(piaVote.closesAt) - Date.parse(piaVote.opensAt) === 7 * DAY, 'It runs 7 days');
    testAssert(typeof piaVote.params?.balance === 'number' && typeof piaVote.params?.debt === 'number' && typeof piaVote.params?.commonsPool === 'number',
        `It records the member's balance, debt and the pot, as every removal vote does (${JSON.stringify(piaVote.params)})`);
    testAssert(!db.prepare("SELECT 1 FROM decisions WHERE subject = ? AND effect = 'keep_suspension'").get(pia), 'No "Keep the suspension?" vote opens');
    testAssert(statusOf(pia) === 'disabled' && !roleRow(pia) && heldAside(piaVote.id)?.role === 'moderator',
        `Pia is paused, her moderator role held aside under the vote (${statusOf(pia)}, ${heldAside(piaVote.id)?.role})`);
    testAssert(accountsNow() === accountsBeforePause, 'The pause moves no Beans');
    const piaTally = tallyDecision(piaVote.id);
    testAssert(piaTally.thresholdRequired === 0.66 && piaTally.quorumRatio === 0.25, `It is decided as a removal: 66% of votes cast, 25% turnout (got ${piaTally.thresholdRequired}, ${piaTally.quorumRatio})`);
    const shown = publicDecision(piaVote);
    testAssert(shown.params && !('pausedBy' in shown.params) && shown.params.reason === 'Threats made to another member at the market',
        `Members read the reason, never which admin paused (${JSON.stringify(shown.params)})`);
    let systemOnly = '';
    try {
        createDecision({ authorPubkey: authorD, title: 'Keep?', description: 'A member trying the old system effect', touches: 'member', effect: 'keep_suspension', subject: pia });
    } catch (e: any) { systemOnly = e?.message || String(e); }
    testAssert(/opened by the node/.test(systemOnly), 'Nobody proposes the old "Keep the suspension?" effect');

    // 13b. The voter rule (§3.3): the subject never votes on their own removal; paused, they keep every other vote.
    const ownVote = castDecisionVote(piaVote.id, pia, false);
    testAssert(isOff(ownVote) && /remov/i.test(ownVote.error ?? '') && /you/i.test(ownVote.error ?? ''), `Pia can't vote on her own removal (${JSON.stringify(ownVote)})`);
    testAssert(!db.prepare('SELECT 1 FROM decision_votes WHERE decision_id = ? AND voter_pubkey = ?').get(piaVote.id, pia), 'and nothing is written');
    const quinn = fresh('QuinnQ');
    const other = createDecision({ authorPubkey: authorA, title: 'Freeze Quinn', description: 'Another Decision while Pia is paused', touches: 'member', effect: 'freeze_credit', subject: quinn });
    const piaOnOther = castDecisionVote(other.id, pia, true);
    testAssert(piaOnOther.success, `Paused, Pia keeps her vote on every other Decision (${JSON.stringify(piaOnOther)})`);
    testAssert(checkVoterEligibility(pia, other).ok && !checkVoterEligibility(pia, piaVote).ok, 'checkVoterEligibility agrees: yes on the other Decision, no on her own removal');
    testAssert(countAfterPause === countBeforePause, `Pausing her moved no electorate: she still counts among those who could vote (${countBeforePause} before, ${countAfterPause} after)`);
    {
        const otherE = tallyDecision(other.id).electorate, ownE = tallyDecision(piaVote.id).electorate;
        testAssert(otherE === ownE + 1, `She is in every electorate but her own removal's (other ${otherE}, her own ${ownE})`);
    }
    // A removal a member proposed (before removal by vote S3, still open): its subject, active, is not in its electorate and
    // does not vote on it either.
    const xavi = fresh('XaviActive', true);
    const removeXavi = removalProposedFromBefore({ authorPubkey: authorB, title: 'Remove Xavi', description: 'A removal a member proposes', subject: xavi });
    const xaviOwn = castDecisionVote(removeXavi.id, xavi, false);
    testAssert(isOff(xaviOwn) && !db.prepare('SELECT 1 FROM decision_votes WHERE decision_id = ? AND voter_pubkey = ?').get(removeXavi.id, xavi),
        `Nor does anyone vote on a removal of them a member proposed (${JSON.stringify(xaviOwn)})`);
    testAssert(tallyDecision(removeXavi.id).electorate === tallyDecision(other.id).electorate - 1, 'and they are not in its electorate');
    testAssert(castDecisionVote(other.id, xavi, true).success, 'though they vote on every other Decision');
    // A member can't write the node's marks of a pause vote: since removal by vote S3 a member proposes no removal at all.
    const fay = fresh('FayForged');
    let forgedRefusal = '';
    try {
        createDecision({
            authorPubkey: authorC, title: 'Remove Fay', description: 'A member writes the node’s marks', touches: 'member', effect: 'remove_member', subject: fay,
            params: { rule: 2, pausedBy: admin, pausedAt: new Date().toISOString(), reason: 'Looks like a pause' },
        });
    } catch (e: any) {
        forgedRefusal = e?.message || String(e);
    }
    testAssert(forgedRefusal === decisionsEngine.REMOVAL_FOLLOWS_A_PAUSE && !db.prepare('SELECT 1 FROM decisions WHERE subject = ?').get(fay),
        `A member's removal proposal with a pause vote's marks is refused, and nothing is written (${forgedRefusal})`);
    // Nor does any other proposal carry them.
    const markedFreeze = createDecision({
        authorPubkey: authorC, title: 'Freeze Fay', description: 'A member writes the node’s marks on another Decision', touches: 'member', effect: 'freeze_credit', subject: fay,
        params: { rule: 2, pausedBy: admin, pausedAt: new Date().toISOString() },
    });
    testAssert(!!markedFreeze.params && !('rule' in markedFreeze.params) && !('pausedBy' in markedFreeze.params) && !('pausedAt' in markedFreeze.params),
        `A member's proposal can't carry a pause vote's marks (${JSON.stringify(markedFreeze.params)})`);
    adminHaltDecision(markedFreeze.id, admin, 'Out of the way of the blocks below');
    testAssert(countsIn(other.id, quinn), 'setup: an active member counts in the other Decision\'s electorate (the checks below have teeth)');
    retire(quinn);

    // Who does not vote: a member a vote suspended, one in a removal's grace window, one an older node suspended.
    const hal = fresh('HeldHal');
    const halVote = pause(hal);
    testAssert(countsIn(other.id, hal), 'Hal, paused, counts in the other Decision\'s electorate');
    const suspendHal = createDecision({ authorPubkey: authorC, title: 'Suspend Hal', description: 'The community suspends Hal while paused', touches: 'member', effect: 'suspend_member', subject: hal });
    vote(suspendHal.id, 4, 0);
    testAssert(closeAndTick(suspendHal.id).status === 'executed' && statusOf(hal) === 'disabled', 'setup: the community suspends Hal, paused, by a vote of its own');
    testAssert(!checkVoterEligibility(hal, other).ok, 'A member a vote suspended does not vote: the community has spoken');
    testAssert(!countsIn(other.id, hal), 'and is in no electorate');
    vote(halVote.id, 0, 4);
    const halEnd = closeAndTick(halVote.id);
    testAssert(halEnd.status === 'failed' && statusOf(hal) === 'disabled',
        `No on Hal's pause vote leaves the community's own suspension in place (${halEnd.status}, ${statusOf(hal)}: ${halEnd.executionReason})`);
    retire(hal);
    // A paused member whom a removal a member proposed puts in its grace window: the community has spoken, even with their
    // credit unfrozen by an admin.
    const kit = fresh('GraceKit');
    grantNodeRole(kit, 'moderator', admin);
    const kitRole = roleRow(kit);
    const kitPause = pause(kit);
    const removeKit = removalProposedFromBefore({ authorPubkey: authorD, title: 'Remove Kit', description: 'A removal a member proposes while Kit is paused', subject: kit });
    vote(removeKit.id, 4, 0);
    testAssert(closeAndTick(removeKit.id).status === 'execution_pending_grace', 'setup: a member\'s removal of Kit, paused, passes into its grace window');
    adminSetCreditFrozen(kit, false);
    testAssert(!checkVoterEligibility(kit, other).ok && !countsIn(other.id, kit),
        'A member in a removal\'s grace window votes on nothing and is in no electorate, whatever their credit says');
    // Kit's pause vote then says No: the removal holds Kit, and the role the pause held aside moves to it, so a halt of the
    // removal gives it back (liftEmergencySuspensionRow's "held elsewhere", now that both are removal votes).
    vote(kitPause.id, 0, 4);
    const kitPauseEnd = closeAndTick(kitPause.id);
    testAssert(kitPauseEnd.status === 'failed' && statusOf(kit) === 'disabled' && !heldAside(kitPause.id) && heldAside(removeKit.id)?.role === 'moderator',
        `No on a pause vote while a removal holds the member: they stay held, the role moves to the removal (${kitPauseEnd.status}, ${statusOf(kit)}, ${heldAside(removeKit.id)?.role})`);
    adminHaltDecision(removeKit.id, admin, 'The removal was a mistake; halting it');
    testAssert(statusOf(kit) === 'active' && sameRole(kitRole, roleRow(kit)), 'Halting that removal gives Kit back, with the moderator role');
    retire(kit);
    // Only a pause's own vote (the node's, rule 2) keeps a paused member's vote: not a member's removal written with its
    // marks, nor a removal vote of the node's without them.
    const forgedHold = fresh('ForgedHold'), nodeNoRule = fresh('NodeNoRule');
    for (const pk of [forgedHold, nodeNoRule]) db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(pk);
    const forgedRow = insertStoredDecision({ author: authorD, effect: 'remove_member', touches: 'member', subject: forgedHold, params: { rule: 2, pausedBy: admin } });
    const noRuleRow = insertStoredDecision({ author: 'SYSTEM', effect: 'remove_member', touches: 'member', subject: nodeNoRule, params: { pausedBy: admin } });
    testAssert(!checkVoterEligibility(forgedHold, other).ok && !checkVoterEligibility(nodeNoRule, other).ok,
        'Only the node\'s pause vote, marked rule 2, keeps a disabled member\'s vote');
    testAssert(!countsIn(other.id, forgedHold) && !countsIn(other.id, nodeNoRule), 'and their place in the electorate');
    for (const id of [forgedRow, noRuleRow]) adminHaltDecision(id, admin, 'Out of the way of the time travel below');
    retire(forgedHold, nodeNoRule);

    // An older node's pause: a "Keep …'s suspension?" vote, its role held aside under it.
    const legacyPause = (callsign: string): { pk: string; id: string; role: any } => {
        const pk = fresh(callsign);
        grantNodeRole(pk, 'moderator', admin);
        const role = roleRow(pk);
        const id = `legacy-keep-${callsign}-${Date.now()}`;
        const now = new Date();
        db.transaction(() => {
            db.prepare(`INSERT INTO suspended_node_roles (decision_id, member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
                        SELECT ?, member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash FROM node_roles WHERE member_pubkey = ?`).run(id, pk);
            db.prepare('DELETE FROM node_roles WHERE member_pubkey = ?').run(pk);
            db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(pk);
            db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, status, opens_at, closes_at, created_at, updated_at)
                        VALUES (?, 'SYSTEM', ?, 'An admin suspended them. Keep the suspension?', 'member', 'keep_suspension', ?, ?, '1m1v', 'open', ?, ?, ?, ?)`)
                .run(id, `Keep ${callsign}'s suspension?`, pk, JSON.stringify({ memberName: callsign, suspendedAt: now.toISOString(), suspendedBy: admin, reason: 'Paused before the pause vote' }),
                    now.toISOString(), new Date(now.getTime() + 7 * DAY).toISOString(), now.toISOString(), now.toISOString());
        })();
        return { pk, id, role };
    };
    const olga = legacyPause('OldRuleOlga');
    testAssert(!checkVoterEligibility(olga.pk, other).ok, 'A member an older node suspended keeps the old rule: no vote while suspended (day zero for pause votes)');
    testAssert(!countsIn(other.id, olga.pk), 'and is in no electorate');
    vote(olga.id, 1, 3);
    const olgaEnd = closeAndTick(olga.id);
    testAssert(olgaEnd.status === 'failed' && statusOf(olga.pk) === 'active' && sameRole(olga.role, roleRow(olga.pk)),
        `That old vote ends under the old rule: not kept, the suspension lifts and the role comes back (${olgaEnd.status}, ${statusOf(olga.pk)})`);
    retire(olga.pk);
    const kept = legacyPause('OldRuleKip');
    vote(kept.id, 4, 0);
    const keptEnd = closeAndTick(kept.id);
    testAssert(keptEnd.status === 'executed' && statusOf(kept.pk) === 'disabled' && !roleRow(kept.pk) && !heldAside(kept.id),
        `and kept, it stays kept, the role gone, as before (${keptEnd.status}, ${statusOf(kept.pk)})`);
    const halted = legacyPause('OldRuleHank');
    testAssert(adminHaltDecision(halted.id, admin, 'Halting an old suspension vote by hand').success && statusOf(halted.pk) === 'active' && sameRole(halted.role, roleRow(halted.pk)),
        'Halting an old vote still lifts its suspension, the role back');
    const liftedOld = legacyPause('OldRuleLiv');
    testAssert(adminLiftSuspension(liftedOld.pk, admin).success && getDecision(liftedOld.id)!.status === 'admin_halted' && sameRole(liftedOld.role, roleRow(liftedOld.pk)),
        'Lifting an old suspension by hand still closes its vote, the role back');

    // 13c. How a pause vote ends, on the tick that closes it.
    const ending = (callsign: string, yes: number, no: number) => {
        const pk = fresh(callsign);
        grantNodeRole(pk, 'moderator', admin);
        const role = roleRow(pk);
        const d = pause(pk);
        vote(d.id, yes, no);
        const before = accountsNow();
        const end = closeAndTick(d.id);
        return { pk, role, d, end, movedNoBeans: accountsNow() === before };
    };
    const no = ending('NellNo', 1, 3);
    testAssert(no.end.status === 'failed' && statusOf(no.pk) === 'active' && frozenOf(no.pk) === 0,
        `No (1 yes, 3 no): the pause lifts on the tick that closes the vote (${no.end.status}, ${statusOf(no.pk)}: ${no.end.executionReason})`);
    testAssert(sameRole(no.role, roleRow(no.pk)) && !heldAside(no.d.id), 'and her moderator role comes back exactly');
    testAssert(/pause has been lifted/i.test(no.end.executionReason ?? ''), `the record says the pause was lifted (${no.end.executionReason})`);
    const tie = ending('TedTie', 2, 2);
    testAssert(tie.end.status === 'failed' && statusOf(tie.pk) === 'active' && sameRole(tie.role, roleRow(tie.pk)),
        `A tie (2 yes, 2 no) lifts it too (${tie.end.status}, ${statusOf(tie.pk)})`);
    const thin = ending('QuoQuorum', 1, 0);
    testAssert(thin.end.status === 'unresolved' && statusOf(thin.pk) === 'active' && sameRole(thin.role, roleRow(thin.pk)) && /Quorum not met/.test(thin.end.executionReason ?? ''),
        `A missed quorum (1 vote of the 3 needed) lifts it: the same as No (${thin.end.status}, ${thin.end.executionReason})`);
    const none = ending('NoaNobody', 0, 0);
    testAssert(none.end.status === 'unresolved' && statusOf(none.pk) === 'active' && sameRole(none.role, roleRow(none.pk)),
        `Nobody voting at all lifts it (${none.end.status})`);
    testAssert(no.movedNoBeans && tie.movedNoBeans && thin.movedNoBeans && none.movedNoBeans, 'None of those endings moves Beans');
    const yes = ending('YanYes', 3, 0);
    const yesEnd = yes.end;
    testAssert(yesEnd.status === 'execution_pending_grace' && statusOf(yes.pk) === 'disabled' && frozenOf(yes.pk) === 1,
        `Yes (3 of 3): the grace window starts, the member stays paused, their credit frozen (${yesEnd.status}, ${statusOf(yes.pk)}, frozen ${frozenOf(yes.pk)})`);
    testAssert(heldAside(yes.d.id)?.role === 'moderator' && !roleRow(yes.pk), 'the role stays held aside under the same vote, for a halt in the grace window to give back');
    testAssert(Math.abs(Date.parse(yesEnd.gracePeriodEndsAt ?? '') - (Date.now() + 7 * DAY)) < 60_000, `the grace window is 7 days (${yesEnd.gracePeriodEndsAt})`);
    testAssert(yes.movedNoBeans, 'and nothing moves Beans until the removal completes');
    testAssert(!checkVoterEligibility(yes.pk, other).ok && !countsIn(other.id, yes.pk),
        'In the grace window the community has spoken: Yan votes on nothing and is in no electorate');
    retire(yes.pk);

    // A vote can't remove an owner or admin (§3.8): an admin's pause vote that says Yes is not carried out, and the pause
    // still ends with its vote.
    const abe = fresh('AdminAbe');
    grantNodeRole(abe, 'admin', admin);
    const abeRole = roleRow(abe);
    const abeVote = pause(abe);
    testAssert(abeVote.params?.serverRole === 'admin', `An admin's pause vote says they hold the admin role, which no vote removes (${JSON.stringify(abeVote.params)})`);
    vote(abeVote.id, 4, 0);
    const abeEnd = closeAndTick(abeVote.id);
    testAssert(abeEnd.status === 'execution_blocked' && statusOf(abe) === 'active' && sameRole(abeRole, roleRow(abe)),
        `Its Yes is not carried out, and the pause lifts with the vote, his admin role back (${abeEnd.status}, ${statusOf(abe)}: ${abeEnd.executionReason})`);
    // Votes switched off before it closes: no vote removes anyone there, and the pause still ends.
    const vic = fresh('VotesOffVic'), val = fresh('VotesOffVal');
    const vicVote = pause(vic), valVote = pause(val);
    vote(vicVote.id, 4, 0);
    const votesOff = db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    votesOff.run(`${NODE_PROFILE_KEY}.decisions`, 'false');
    let vicEnd: any, valEnd: any;
    try {
        vicEnd = closeAndTick(vicVote.id);
        valEnd = closeAndTick(valVote.id);
    } finally { db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.decisions`); }
    testAssert(vicEnd?.status === 'unresolved' && statusOf(vic) === 'active' && /Community votes are switched off/.test(vicEnd?.executionReason ?? ''),
        `Votes switched off before it closed: nothing it decided is carried out, and the pause lifts (${vicEnd?.status}: ${vicEnd?.executionReason})`);
    testAssert(valEnd?.status === 'unresolved' && statusOf(val) === 'active' && /Community votes are switched off/.test(valEnd?.executionReason ?? ''),
        `One nobody voted on is never tallied there: it ends for the same reason (${valEnd?.status}: ${valEnd?.executionReason})`);
    // The grace window can't start (a write fails): the pause still ends with its vote.
    const gil = fresh('GraceGil');
    const gilVote = pause(gil);
    vote(gilVote.id, 4, 0);
    db.exec(`CREATE TRIGGER zz_block_freeze_gil BEFORE UPDATE OF credit_frozen ON members
             WHEN NEW.public_key = '${gil}' BEGIN SELECT RAISE(ABORT, 'freeze blocked by test'); END;`);
    let gilEnd: any;
    try { gilEnd = closeAndTick(gilVote.id); } finally { db.exec('DROP TRIGGER zz_block_freeze_gil'); }
    testAssert(gilEnd?.status === 'execution_blocked' && statusOf(gil) === 'active' && frozenOf(gil) === 0,
        `A grace window that can't start leaves no pause behind (${gilEnd?.status}, ${statusOf(gil)}: ${gilEnd?.executionError})`);

    // 13d. Halting the vote, or lifting the pause by hand, lifts it.
    const holly = fresh('HaltedHolly');
    grantNodeRole(holly, 'moderator', admin);
    const hollyRole = roleRow(holly);
    const hollyVote = pause(holly);
    const hollyHalt = adminHaltDecision(hollyVote.id, admin, 'Paused the wrong member by mistake');
    testAssert(hollyHalt.success && getDecision(hollyVote.id)!.status === 'admin_halted' && statusOf(holly) === 'active' && sameRole(hollyRole, roleRow(holly)),
        `Halting a pause vote lifts the pause, the role back (${JSON.stringify(hollyHalt)}, ${statusOf(holly)})`);
    const lou = fresh('LiftedLou');
    grantNodeRole(lou, 'moderator', admin);
    const louRole = roleRow(lou);
    const louVote = pause(lou);
    const louLift = adminLiftSuspension(lou, admin);
    const louAfter = getDecision(louVote.id)!;
    testAssert(louLift.success && louAfter.status === 'admin_halted' && statusOf(lou) === 'active' && sameRole(louRole, roleRow(lou)),
        `Lifting the pause by hand closes its vote, the role back (${JSON.stringify(louLift)}, ${louAfter.status})`);
    testAssert(/lifted the pause/i.test(louAfter.adminHaltReason ?? ''), `and the record says the pause was lifted (${louAfter.adminHaltReason})`);
    // A paused admin's role comes back only by an owner.
    const alma = fresh('AdminAlma');
    grantNodeRole(alma, 'admin', admin);
    const almaRole = roleRow(alma);
    const almaVote = pause(alma);
    testAssert(decisionsEngine.adminActionNeedsOwner('lift', alma) && decisionsEngine.adminActionNeedsOwner('halt', almaVote.id),
        'Lifting a paused admin, or halting their pause vote, is an owner\'s act');
    const plainHalt = adminHaltDecision(almaVote.id, authorA, 'A plain admin halting an admin’s pause');
    const plainLift = adminLiftSuspension(alma, authorA);
    testAssert(plainHalt.status === 403 && plainLift.status === 403 && getDecision(almaVote.id)!.status === 'open' && statusOf(alma) === 'disabled',
        `A plain admin can do neither (${JSON.stringify(plainHalt)}, ${JSON.stringify(plainLift)})`);
    testAssert(adminLiftSuspension(alma, admin).success && statusOf(alma) === 'active' && sameRole(almaRole, roleRow(alma)), 'An owner lifts it, the admin role back');

    // Pia's own vote, out of the way of the time travel below: No lifts her.
    vote(piaVote.id, 0, 3);
    testAssert(closeAndTick(piaVote.id).status === 'failed' && statusOf(pia) === 'active', 'Pia\'s vote says No: she is back');
    for (const d of [other, removeXavi]) adminHaltDecision(d.id, admin, 'Closed before the time travel below');

    // 13e. The removal completes on the tick 7 days on; with the pot unknown it waits, and its brake reopens after the mend.
    const pat = fresh('PotPat');
    const patVote = pause(pat);
    vote(patVote.id, 3, 0);
    setCommonsBalance(NaN);
    let patGrace: any;
    try {
        patGrace = closeAndTick(patVote.id);
        testAssert(patGrace.status === 'execution_pending_grace' && statusOf(pat) === 'disabled',
            `With the pot unknown, a pause vote that passes still starts its grace window: it moves no Beans (${patGrace.status})`);
        const graceEnds = Date.parse(patGrace.gracePeriodEndsAt ?? '');
        const at = Number.isFinite(graceEnds) ? graceEnds : Date.now() + 8 * DAY;
        tickDecisions(at + 60_000);
        const waiting = getDecision(patVote.id)!;
        testAssert(waiting.status === 'execution_pending_grace' && waiting.executionReason === decisionsEngine.WAITING_FOR_POT && statusOf(pat) === 'disabled',
            `Its grace window ends with the pot unknown: the removal waits, Pat still paused (${waiting.status}: ${waiting.executionReason})`);
        testAssert(statusOf(yes.pk) === 'disabled' && getDecision(yes.d.id)!.status === 'execution_pending_grace', 'and so does Yan\'s, whose window ended too');
        setCommonsBalance(1000);
        tickDecisions(at + 120_000);
        const reopened = getDecision(patVote.id)!;
        const reopenedEnds = Date.parse(reopened.gracePeriodEndsAt ?? '');
        testAssert(reopened.status === 'execution_pending_grace' && reopened.executionReason === decisionsEngine.REOPENED_GRACE
            && Math.abs(reopenedEnds - (at + 120_000 + 24 * 3600_000)) < 1000,
            `The pot mended, the brake reopens for 24 hours before the removal (${reopened.status}, ${reopened.gracePeriodEndsAt})`);
        tickDecisions(at + 120_000 + 25 * 3600_000);
        testAssert(getDecision(patVote.id)!.status === 'executed' && statusOf(pat) === 'pruned', 'Then the removal completes');
        testAssert(getDecision(yes.d.id)!.status === 'executed' && statusOf(yes.pk) === 'pruned' && !heldAside(yes.d.id),
            'Yan\'s too: removed on the tick, the held role gone with them');
    } finally {
        setCommonsBalance(1000);
    }

    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} of ${testsRun} Decisions Engine checks failed`);
    console.log(`\n🎉 All ${testsPassed}/${testsRun} Decisions Engine tests PASSED!`);
}

runDecisionsSuite().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('Test suite failed with error:', err);
    process.exit(1);
});
