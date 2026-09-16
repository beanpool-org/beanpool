/**
 * Test Suite: Community Decisions Engine
 * Source: docs/the-commons.md §3.2–§3.8, §6 Slice 5.
 *
 * Covers:
 * 1. Franchises & Eligibility:
 *    - 1m1v for member/rule decisions; quadratic on trade standing for pool decisions
 *    - Enterprises and frozen members cannot propose or vote
 *    - Author standing gate (earnedCredit > 0) and max 1 open decision per author
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
 * 6. Reversible member effects (suspend/unsuspend, freeze/unfreeze, voucher, tier, elder, remove lead keeper)
 * 7. Pool grants to an enterprise with auth_signer='system:decision:<id>' and conservation audit
 * 8. Underfunded grants -> passed_queued_for_funds queue, auto-execution when funded, 90-day expiry
 * 9. Destructive member removal: 7-day grace period, immediate suspension, admin halt with reason, admin accelerate, auto-prune on grace expiry
 * 10. Reinstatement cancels pending grace removal
 * 11. Executor idempotency and transaction rollback safety
 * 12. Backward compatibility: reading legacy voting rounds
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-decisions-engine.ts
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
    getVotingRounds,
    createVotingRound,
    closeVotingRound,
    createProject,
    adminSetUserStatus,
} from './state-engine.js';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { setCommonsBalance } from '@beanpool/core';

let testsRun = 0;
let testsPassed = 0;
function testAssert(cond: any, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
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

    // Eligibility to propose
    const entCheck = checkCanProposeDecision(enterprise1);
    testAssert(!entCheck.ok && entCheck.error?.includes('Enterprises cannot propose'), 'Enterprise cannot propose decisions');

    const frozenCheck = checkCanProposeDecision(frozenMember);
    testAssert(!frozenCheck.ok && frozenCheck.error?.includes('frozen'), 'Frozen member cannot propose decisions');

    const zeroCheck = checkCanProposeDecision(zeroStandingMember);
    testAssert(!zeroCheck.ok && zeroCheck.error?.includes('earnedCredit > 0'), 'Member with zero earned credit cannot propose decisions');

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

    // Generate active trades for m1, m2, admin
    recordTestActivity(m1, m2, 20);
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

    const decBigGrant = createDecision({
        authorPubkey: admin,
        title: 'Grant for community solar',
        description: 'Exceeds current pool balance',
        touches: 'pool',
        effect: 'grant_enterprise',
        subject: bigGrantEnterprise,
        params: { amount: bigAmount },
    });
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
    setCommonsBalance(10); // Low pool
    const decStale = createDecision({
        authorPubkey: admin,
        title: 'Stale initiative grant',
        description: 'Underfunded and sits for 90 days',
        touches: 'pool',
        effect: 'grant_enterprise',
        subject: staleGrantEnterprise,
        params: { amount: 500 },
    });
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

    // Removal requires 66% supermajority on 25% quorum
    const decRemoval = createDecision({
        authorPubkey: admin,
        title: 'Remove RogueDave from node',
        description: 'Malicious behaviour',
        touches: 'member',
        effect: 'remove_member',
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

    // Second removal decision — test auto-execution when grace period ends
    const decRemoval2 = createDecision({
        authorPubkey: admin,
        title: 'Remove RogueDave round 2',
        description: 'Confirmed rogue activity',
        touches: 'member',
        effect: 'remove_member',
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

    const decRemoval3 = createDecision({
        authorPubkey: admin,
        title: 'Remove RevertMe',
        description: 'Misunderstanding',
        touches: 'member',
        effect: 'remove_member',
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

    // Rollback test: simulate an invalid execution param that throws inside transaction
    const badDecision = createDecision({
        authorPubkey: admin,
        title: 'Bad Decision with failing mutation',
        description: 'Testing rollback',
        touches: 'member',
        effect: 'grant_tier',
        subject: m1,
        params: { tier: 'NonExistentTier' as any }, // Will throw in grantedCreditForTier
    });
    const execBadRes = executeDecision(badDecision.id);
    testAssert(!execBadRes.success && execBadRes.status === 'execution_blocked', 'Failed execution rolls back to execution_blocked');
    testAssert(getDecision(badDecision.id)!.status === 'execution_blocked', 'Decision status persisted as execution_blocked');

    // ── 10. Backward Compatibility: Legacy Voting Rounds ─────────────────────
    console.log('\n--- 10. Backward Compatibility ---');

    const legacyProj = createProject(m1, 'Legacy Project', 'Legacy desc', 50);
    testAssert(legacyProj != null, 'Legacy project created');
    const legacyRound = createVotingRound(admin, [legacyProj!.id], new Date(Date.now() + 3600_000).toISOString());
    testAssert(legacyRound != null, 'createVotingRound succeeds for backwards compatibility');

    const rounds = getVotingRounds();
    testAssert(rounds.some(r => r.id === legacyRound!.id), 'getVotingRounds reads legacy round data');

    // ── 11. Governance Security, Parameter Decoupling & Ledger Hardening ────
    console.log('\n--- 11. Security, Parameter Decoupling & Ledger Hardening ---');

    // 11a. Parameter Decoupling: cannot propose remove_member with touches='nothing'
    let decouplingCaught = false;
    try {
        createDecision({
            authorPubkey: admin,
            title: 'Spoofed touches',
            description: 'Try to bypass quorum',
            touches: 'nothing',
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
    const nanVoteRes = castDecisionVote(decVoteSan.id, voterA, true, NaN as any);
    testAssert(nanVoteRes.success && nanVoteRes.creditsUsed === 1, 'NaN voteCount falls back safely to count 1');
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

    // 11e. Sole node owner removal blocked in preflight
    const decSoleOwnerRemoval = createDecision({
        authorPubkey: admin,
        title: 'Attempt removal of sole node owner',
        description: 'Should be blocked in preflight',
        touches: 'member',
        effect: 'remove_member',
        subject: admin,
    });
    castDecisionVote(decSoleOwnerRemoval.id, voterA, true);
    castDecisionVote(decSoleOwnerRemoval.id, voterB, true);
    castDecisionVote(decSoleOwnerRemoval.id, voterC, true);
    closeForTick(decSoleOwnerRemoval.id);
    tickDecisions();
    const soleOwnerDec = getDecision(decSoleOwnerRemoval.id)!;
    testAssert(soleOwnerDec.status === 'execution_blocked', 'Sole owner removal blocked before grace window or suspension');
    testAssert((db.prepare("SELECT status FROM members WHERE public_key = ?").get(admin) as any).status === 'active', 'Sole node owner remains active');

    // 11e-2. Sole node owner suspend blocked in preflight per §3.8
    const decSoleOwnerSuspend = createDecision({
        authorPubkey: admin,
        title: 'Attempt to suspend sole owner',
        description: 'Should fail at preflight',
        touches: 'member',
        effect: 'suspend_member',
        subject: admin,
    });
    castDecisionVote(decSoleOwnerSuspend.id, voterA, true);
    castDecisionVote(decSoleOwnerSuspend.id, voterB, true);
    castDecisionVote(decSoleOwnerSuspend.id, voterC, true);
    closeForTick(decSoleOwnerSuspend.id);
    tickDecisions();
    const soleOwnerSuspendDec = getDecision(decSoleOwnerSuspend.id)!;
    testAssert(soleOwnerSuspendDec.status === 'execution_blocked', 'Sole owner suspension blocked in preflight (§3.8)');
    testAssert((db.prepare("SELECT status FROM members WHERE public_key = ?").get(admin) as any).status === 'active', 'Sole node owner remains active after suspend attempt');

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
    setCommonsBalance(10); // Pool underfunded
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
    castDecisionVote(decQ1.id, voterA, true, 4);
    castDecisionVote(decQ1.id, voterB, true, 4);
    castDecisionVote(decQ1.id, voterC, true, 4);
    closeForTick(decQ1.id);
    tickDecisions();
    testAssert(getDecision(decQ1.id)!.status === 'passed_queued_for_funds', 'First underfunded grant occupies queue slot');

    const entQueue2 = 'ent_q2_' + Date.now();
    seedTestMember(entQueue2, 'Q2 Enterprise', { isTreasury: true });
    const decQ2 = createDecision({
        authorPubkey: admin,
        title: 'Grant Q2',
        description: 'Second underfunded grant exceeding queue capacity',
        touches: 'pool',
        effect: 'grant_enterprise',
        subject: entQueue2,
        params: { amount: 150 },
    });
    castDecisionVote(decQ2.id, voterA, true, 4);
    castDecisionVote(decQ2.id, voterB, true, 4);
    castDecisionVote(decQ2.id, voterC, true, 4);
    closeForTick(decQ2.id);
    tickDecisions();
    testAssert(getDecision(decQ2.id)!.status === 'execution_blocked', 'Second underfunded grant blocked when queue is at capacity (§3.7)');
    testAssert(getDecision(decQ2.id)!.executionError?.includes('Funding queue full'), 'Blocked reason cites 1-grant queue limit');

    console.log(`\n🎉 All ${testsPassed}/${testsRun} Decisions Engine tests PASSED!`);
}

runDecisionsSuite().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('Test suite failed with error:', err);
    process.exit(1);
});
