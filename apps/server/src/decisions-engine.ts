/**
 * Community Decisions Engine (docs/the-commons.md §3.2–§3.8, Slice 5).
 *
 * The binding half of commons governance:
 * - Typed by what the effect touches: member, pool, rule, nothing (§3.6).
 * - Two franchises:
 *     - 1m1v (one member, one vote) for member/rule/general decisions.
 *     - Quadratic on earned trade standing for pool/treasury decisions.
 * - Quorum: 30% of members active in the last 30 days, floor 3 (25% for member removal).
 * - Pass rules (§3.4):
 *     - 60% supermajority standard.
 *     - 66% supermajority for member removal.
 *     - Simple majority (> 50%) for restorations (unsuspend, unfreeze, reinstate).
 *     - Ties fail. Quorum failures expire as UNRESOLVED.
 * - Lifecycle:
 *     - Fixed 7-day voting window.
 *     - Closes and executes ON A TICK — no admin opens or closes rounds.
 * - Execution (§3.7):
 *     - Pre-flight assertions: subject alive, pool solvent, invariants intact.
 *     - Single BEGIN IMMEDIATE transaction (via conservingTransaction).
 *     - Provenance stamp: auth_signer = 'system:decision:<id>' on all ledger movements.
 *     - Effects sorted by reversibility:
 *         - Reversible state flips and money execute immediately on close.
 *         - Destructive actions (member prune) set a 7-day grace window (execution_pending_grace),
 *           immediately suspending the member, with automatic execution on expiry.
 *     - Funding queue: underfunded grants sit at passed_queued_for_funds (1 at a time, 90-day expiry).
 *     - Dead subjects halt permanently at execution_void.
 *     - Reinstatements cancel pending removals.
 *     - Admin brake: adminHaltDecision (requires public signed reason) or adminAccelerateDecision.
 */

import crypto from 'node:crypto';
import { grantedCreditForTier, type TierName } from '@beanpool/core';
import * as engine from '@beanpool/engine';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import {
    conservingTransaction,
    getCommonsBalanceExact,
    getBalance,
    getMember,
    setUserStatusRow,
    adminPruneUser,
    broadcast,
    isNodeAdmin,
    isSoleOwner,
    persistDecayEvents,
    persistCommonsBalance,
} from './state-engine.js';

export type DecisionTouch = 'member' | 'pool' | 'rule' | 'nothing';

export type DecisionFranchise = '1m1v' | 'quadratic_trade';

export type DecisionStatus =
    | 'open'
    | 'passed'
    | 'failed'
    | 'unresolved'
    | 'passed_queued_for_funds'
    | 'execution_pending_grace'
    | 'execution_blocked'
    | 'execution_void'
    | 'executed'
    | 'admin_halted';

export type DecisionEffect =
    // Member reversible
    | 'suspend_member'
    | 'unsuspend_member'
    | 'freeze_credit'
    | 'unfreeze_credit'
    | 'grant_voucher'
    | 'revoke_voucher'
    | 'grant_tier'
    | 'revoke_tier'
    | 'grant_elder'
    | 'revoke_elder'
    | 'remove_lead_keeper'
    | 'reinstate_member'
    // Member destructive
    | 'remove_member'
    // Pool money
    | 'grant_enterprise'
    | 'grant_hardship'
    | 'write_off_deficit'
    | 'set_levy'
    // Rule
    | 'set_rule'
    // Nothing (Poll)
    | 'poll';

export interface Decision {
    id: string;
    authorPubkey: string;
    title: string;
    description: string;
    touches: DecisionTouch;
    effect: DecisionEffect;
    subject: string | null;
    params: any | null;
    franchise: DecisionFranchise;
    status: DecisionStatus;
    opensAt: string;
    closesAt: string;
    gracePeriodEndsAt: string | null;
    createdAt: string;
    executedAt: string | null;
    executionError: string | null;
    executionReason: string | null;
    adminHaltedAt: string | null;
    adminHaltedBy: string | null;
    adminHaltReason: string | null;
    updatedAt: string;
}

export interface DecisionVote {
    decisionId: string;
    voterPubkey: string;
    support: number; // 1 = yes, 0 = no
    weight: number;
    creditsUsed: number;
    signature?: string;
    createdAt: string;
    updatedAt: string;
}

export interface DecisionTally {
    decisionId: string;
    status: DecisionStatus;
    totalVoters: number;
    quorumRequired: number;
    quorumMet: boolean;
    yesWeight: number;
    noWeight: number;
    totalWeight: number;
    supportRatio: number;
    thresholdRequired: number;
    passed: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function rowToDecision(r: any): Decision {
    let parsedParams: any = null;
    if (r.params) {
        try {
            parsedParams = JSON.parse(r.params);
        } catch {
            parsedParams = r.params;
        }
    }
    return {
        id: r.id,
        authorPubkey: r.author_pubkey,
        title: r.title,
        description: r.description,
        touches: r.touches as DecisionTouch,
        effect: r.effect as DecisionEffect,
        subject: r.subject || null,
        params: parsedParams,
        franchise: r.franchise as DecisionFranchise,
        status: r.status as DecisionStatus,
        opensAt: r.opens_at,
        closesAt: r.closes_at,
        gracePeriodEndsAt: r.grace_period_ends_at || null,
        createdAt: r.created_at,
        executedAt: r.executed_at || null,
        executionError: r.execution_error || null,
        executionReason: r.execution_reason || null,
        adminHaltedAt: r.admin_halted_at || null,
        adminHaltedBy: r.admin_halted_by || null,
        adminHaltReason: r.admin_halt_reason || null,
        updatedAt: r.updated_at,
    };
}

/**
 * Maps what a decision touches to its mandatory franchise (§3.6):
 * - pool -> quadratic on earned trade
 * - member, rule, nothing -> 1m1v
 */
export function franchiseForTouch(touches: DecisionTouch): DecisionFranchise {
    if (touches === 'pool') return 'quadratic_trade';
    return '1m1v';
}

export const TOUCHES_FOR_EFFECT: Record<DecisionEffect, DecisionTouch> = {
    poll: 'nothing',
    set_rule: 'rule',
    set_levy: 'rule',
    grant_enterprise: 'pool',
    grant_hardship: 'pool',
    write_off_deficit: 'pool',
    suspend_member: 'member',
    unsuspend_member: 'member',
    freeze_credit: 'member',
    unfreeze_credit: 'member',
    remove_member: 'member',
    reinstate_member: 'member',
    grant_voucher: 'member',
    revoke_voucher: 'member',
    grant_tier: 'member',
    revoke_tier: 'member',
    grant_elder: 'member',
    revoke_elder: 'member',
    remove_lead_keeper: 'member',
};

/**
 * Returns required pass threshold per §3.4:
 * - remove_member: 66% (0.66)
 * - restorations (unsuspend_member, unfreeze_credit, reinstate_member): simple majority (> 0.50)
 * - pool / rule / member actions: 60% (0.60)
 * - poll (nothing): simple majority (> 0.50)
 */
export function thresholdForEffect(effect: DecisionEffect, touches?: DecisionTouch): number {
    if (effect === 'remove_member') return 0.66;
    if (
        effect === 'unsuspend_member' ||
        effect === 'unfreeze_credit' ||
        effect === 'reinstate_member' ||
        effect === 'poll'
    ) {
        return 0.50;
    }
    if (touches === 'nothing') return 0.50;
    return 0.60;
}

/**
 * Returns quorum ratio per §3.4:
 * - remove_member: 25% (0.25)
 * - others: 30% (0.30)
 * - nothing (poll): 0 (no quorum)
 */
export function quorumRatioForEffect(effect: DecisionEffect, touches?: DecisionTouch): number {
    if (effect === 'remove_member') return 0.25;
    if (effect === 'poll' || touches === 'nothing') return 0;
    return 0.30;
}

/**
 * Count distinct accounts with a trade, transfer, or settlement in the last 30 days (§3.4).
 * Excludes SYSTEM, COMMONS_POOL, escrow wallets, and enterprise accounts.
 */
export function getActiveMembersCount30d(asOfTime?: number): number {
    const cutoff = asOfTime
        ? new Date(asOfTime - 30 * 24 * 60 * 60 * 1000).toISOString()
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const row = db.prepare(`
        SELECT COUNT(DISTINCT member_pubkey) AS count FROM (
            SELECT from_pubkey AS member_pubkey FROM transactions
            WHERE timestamp >= ?
              AND from_pubkey NOT LIKE 'escrow_%'
              AND from_pubkey NOT IN ('SYSTEM', 'COMMONS_POOL')
            UNION
            SELECT to_pubkey AS member_pubkey FROM transactions
            WHERE timestamp >= ?
              AND to_pubkey NOT LIKE 'escrow_%'
              AND to_pubkey NOT IN ('SYSTEM', 'COMMONS_POOL')
            UNION
            SELECT buyer_pubkey AS member_pubkey FROM marketplace_transactions
            WHERE created_at >= ?
            UNION
            SELECT seller_pubkey AS member_pubkey FROM marketplace_transactions
            WHERE created_at >= ?
        )
        WHERE member_pubkey IN (SELECT public_key FROM members WHERE COALESCE(is_treasury, 0) = 0)
    `).get(cutoff, cutoff, cutoff, cutoff) as any;

    return row?.count || 0;
}

/**
 * Computes required quorum for a decision:
 * quorum = max( K_min, ceil(ratio * activeMembers_30d) ), K_min = 3.
 */
export function getQuorumRequired(decision: Decision | { effect: DecisionEffect; touches: DecisionTouch }, asOfTime?: number, activeMembersCount?: number): number {
    if (decision.touches === 'nothing') return 0;
    const ratio = quorumRatioForEffect(decision.effect, decision.touches);
    const active = activeMembersCount !== undefined ? activeMembersCount : getActiveMembersCount30d(asOfTime);
    return Math.max(3, Math.ceil(ratio * active));
}

/**
 * Check if a member is eligible to author a decision (§3.2, §10):
 * - Active member, not frozen, not treasury.
 * - earnedCredit > 0 (or qualified trade value > 0, or node admin).
 * - Max 1 open decision per author.
 */
export function checkCanProposeDecision(authorPubkey: string): { ok: boolean; error?: string } {
    const member = getMember(authorPubkey);
    if (!member) return { ok: false, error: 'Member not found' };
    if (member.status !== 'active') return { ok: false, error: 'Member is not active' };
    const frozenRow = db.prepare("SELECT COALESCE(credit_frozen, 0) as credit_frozen FROM members WHERE public_key = ?").get(authorPubkey) as any;
    if (frozenRow?.credit_frozen === 1) return { ok: false, error: 'Member credit is frozen' };
    if (member.isTreasury) return { ok: false, error: 'Enterprises cannot propose decisions' };

    const tradeVal = engine.qualifiedTradeValue(db, authorPubkey);
    const isAdmin = isNodeAdmin(authorPubkey);
    if (tradeVal <= 0 && (member.earnedCredit || 0) <= 0 && !isAdmin) {
        return { ok: false, error: 'Proposing a Decision requires earned trade standing (earnedCredit > 0)' };
    }

    const openCount = (db.prepare(
        "SELECT COUNT(*) AS c FROM decisions WHERE author_pubkey = ? AND status = 'open'"
    ).get(authorPubkey) as any)?.c || 0;
    if (openCount >= 1) {
        return { ok: false, error: 'Member already has an open decision (limit 1)' };
    }

    return { ok: true };
}

/**
 * Check if a member is eligible to vote on decisions (§3.3):
 * - Account active, not frozen, not an enterprise.
 */
export function checkVoterEligibility(voterPubkey: string): { ok: boolean; error?: string } {
    const member = getMember(voterPubkey);
    if (!member) return { ok: false, error: 'Member not found' };
    if (member.status !== 'active') return { ok: false, error: 'Voter account is not active' };
    const frozenRow = db.prepare("SELECT COALESCE(credit_frozen, 0) as credit_frozen FROM members WHERE public_key = ?").get(voterPubkey) as any;
    if (frozenRow?.credit_frozen === 1) return { ok: false, error: 'Voter credit is frozen' };
    if (member.isTreasury) return { ok: false, error: 'Enterprise accounts cannot vote' };
    return { ok: true };
}

/**
 * Get available voice credits for a voter in a quadratic decision.
 * Voice credits = qualifiedTradeValue(pubkey). Casting N votes costs N².
 */
export function getDecisionVoiceCredits(decisionId: string, voterPubkey: string): {
    totalCredits: number;
    usedCredits: number;
    availableCredits: number;
} {
    const totalCredits = Math.round(engine.qualifiedTradeValue(db, voterPubkey) * 100) / 100;
    // Credits used by this voter on this decision
    const voteRow = db.prepare(
        'SELECT credits_used FROM decision_votes WHERE decision_id = ? AND voter_pubkey = ?'
    ).get(decisionId, voterPubkey) as any;
    const currentCreditsUsed = voteRow?.credits_used || 0;

    return {
        totalCredits,
        usedCredits: currentCreditsUsed,
        availableCredits: Math.max(0, totalCredits - currentCreditsUsed),
    };
}

// ── Decision Lifecycle ──────────────────────────────────────────────────

export interface CreateDecisionOptions {
    authorPubkey: string;
    title: string;
    description: string;
    touches: DecisionTouch;
    effect: DecisionEffect;
    subject?: string | null;
    params?: any;
    closesAt?: string; // Optional override for tests; defaults to 7 days
}

/**
 * Propose a new Community Decision.
 * Enforces:
 * - Author standing and single-open limit.
 * - Mandatory franchise alignment with what it touches.
 * - Fixed 7-day duration (closes on tick).
 */
export function createDecision(opts: CreateDecisionOptions): Decision {
    const check = checkCanProposeDecision(opts.authorPubkey);
    if (!check.ok) {
        throw new Error(check.error || 'Cannot propose decision');
    }

    if (opts.touches !== TOUCHES_FOR_EFFECT[opts.effect]) {
        throw new Error(`Invalid touch '${opts.touches}' for effect '${opts.effect}'. Expected '${TOUCHES_FOR_EFFECT[opts.effect]}'.`);
    }

    const id = crypto.randomUUID();
    const franchise = franchiseForTouch(opts.touches);
    const now = new Date();
    const opensAt = now.toISOString();
    const closesAt = opts.closesAt || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    let finalParams = opts.params;
    if (opts.effect === 'remove_member' && opts.subject) {
        const member = getMember(opts.subject);
        const memberBalance = getBalance(opts.subject)?.balance ?? 0;
        const commonsPoolBal = getCommonsBalanceExact();
        const memberName = member?.callsign || opts.params?.memberName || opts.subject.slice(0, 8);
        const debt = memberBalance < 0 ? Math.abs(memberBalance) : 0;
        finalParams = {
            ...opts.params,
            memberName,
            debt, // Authoritatively computed from ledger
            commonsPool: Math.round(commonsPoolBal), // Authoritatively computed from ledger
        };
    }
    const serializedParams = finalParams !== undefined ? JSON.stringify(finalParams) : null;

    db.prepare(`
        INSERT INTO decisions (
            id, author_pubkey, title, description, touches, effect, subject, params,
            franchise, status, opens_at, closes_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `).run(
        id,
        opts.authorPubkey,
        opts.title,
        opts.description,
        opts.touches,
        opts.effect,
        opts.subject || null,
        serializedParams,
        franchise,
        opensAt,
        closesAt,
        opensAt,
        opensAt
    );

    const decision = getDecision(id)!;
    broadcast({ type: 'decision_created', decision });
    return decision;
}

export function getDecision(id: string): Decision | null {
    const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    return row ? rowToDecision(row) : null;
}

export function getAllDecisions(status?: DecisionStatus): Decision[] {
    if (status) {
        const rows = db.prepare('SELECT * FROM decisions WHERE status = ? ORDER BY created_at DESC').all(status);
        return rows.map(rowToDecision);
    }
    const rows = db.prepare('SELECT * FROM decisions ORDER BY created_at DESC').all();
    return rows.map(rowToDecision);
}

export function getOpenDecisions(): Decision[] {
    return getAllDecisions('open');
}

/**
 * Cast or update a vote on an open Decision.
 * - 1m1v: 1 vote, cost = 1.
 * - Quadratic: voteCount votes in support or opposition, cost = voteCount².
 */
export function castDecisionVote(
    decisionId: string,
    voterPubkey: string,
    support: boolean,
    voteCount = 1,
    signature?: string
): { success: boolean; creditsUsed: number; error?: string } {
    const decision = getDecision(decisionId);
    if (!decision) return { success: false, creditsUsed: 0, error: 'Decision not found' };
    if (decision.status !== 'open' || new Date(decision.closesAt).getTime() <= Date.now()) {
        return { success: false, creditsUsed: 0, error: 'Voting window has closed' };
    }

    const elig = checkVoterEligibility(voterPubkey);
    if (!elig.ok) return { success: false, creditsUsed: 0, error: elig.error };

    const parsedCount = Number(voteCount);
    const count = Number.isFinite(parsedCount) ? Math.max(1, Math.floor(parsedCount)) : 1;
    let weight = 1;
    let creditCost = 1;

    if (decision.franchise === 'quadratic_trade') {
        creditCost = count * count;
        weight = count;
        const credits = getDecisionVoiceCredits(decisionId, voterPubkey);
        if (creditCost > credits.totalCredits) {
            return {
                success: false,
                creditsUsed: 0,
                error: `Insufficient voice credits: ${count} votes costs ${creditCost} credits, but you have ${credits.totalCredits.toFixed(0)}`,
            };
        }
    }

    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO decision_votes (
            decision_id, voter_pubkey, support, weight, credits_used, signature, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(decision_id, voter_pubkey) DO UPDATE SET
            support = excluded.support,
            weight = excluded.weight,
            credits_used = excluded.credits_used,
            signature = excluded.signature,
            updated_at = excluded.updated_at
    `).run(
        decisionId,
        voterPubkey,
        support ? 1 : 0,
        weight,
        creditCost,
        signature || null,
        now,
        now
    );

    broadcast({
        type: 'decision_vote_cast',
        decisionId,
        voterPubkey,
        support,
        weight,
        creditCost,
    });

    return { success: true, creditsUsed: creditCost };
}

export function getDecisionVotes(decisionId: string): DecisionVote[] {
    const rows = db.prepare('SELECT * FROM decision_votes WHERE decision_id = ? ORDER BY created_at ASC').all(decisionId) as any[];
    return rows.map(r => ({
        decisionId: r.decision_id,
        voterPubkey: r.voter_pubkey,
        support: r.support,
        weight: r.weight,
        creditsUsed: r.credits_used,
        signature: r.signature || undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    }));
}

/**
 * Tally votes for a decision.
 */
export function tallyDecision(decisionId: string, asOfTime?: number, activeMembersCount?: number): DecisionTally {
    const decision = getDecision(decisionId);
    if (!decision) throw new Error(`Decision ${decisionId} not found`);

    const votes = getDecisionVotes(decisionId);
    const totalVoters = votes.length;
    const quorumRequired = getQuorumRequired(decision, asOfTime, activeMembersCount);
    const quorumMet = decision.touches === 'nothing' || totalVoters >= quorumRequired;

    let yesWeight = 0;
    let noWeight = 0;
    for (const v of votes) {
        if (v.support === 1) yesWeight += v.weight;
        else noWeight += v.weight;
    }
    const totalWeight = yesWeight + noWeight;
    const supportRatio = totalWeight > 0 ? yesWeight / totalWeight : 0;
    const thresholdRequired = thresholdForEffect(decision.effect, decision.touches);

    // Ties fail (§3.4). Quorum failures expire as unresolved.
    const passed = quorumMet && totalWeight > 0 && supportRatio >= thresholdRequired && yesWeight > noWeight;

    return {
        decisionId,
        status: decision.status,
        totalVoters,
        quorumRequired,
        quorumMet,
        yesWeight,
        noWeight,
        totalWeight,
        supportRatio,
        thresholdRequired,
        passed,
    };
}

// ── Execution Engine (§3.7) ─────────────────────────────────────────────

/**
 * Pre-flight assertion for a decision.
 * Returns:
 * - 'ok': assertions pass, ready to execute.
 * - 'void': subject is dead/deleted -> transition to execution_void.
 * - 'insufficient_funds': pool has insufficient funds -> transition to passed_queued_for_funds.
 * - 'blocked': invalid state/parameters -> transition to execution_blocked.
 */
export function preflightAssert(decision: Decision): {
    status: 'ok' | 'void' | 'insufficient_funds' | 'blocked';
    reason?: string;
} {
    // 1. Check subject existence
    if (decision.touches === 'member') {
        if (!decision.subject) return { status: 'blocked', reason: 'Missing member subject' };
        const member = getMember(decision.subject);
        if (decision.effect !== 'reinstate_member' && (!member || member.status === 'pruned')) {
            return { status: 'void', reason: 'Subject member does not exist or was already pruned' };
        }
        if (decision.effect === 'reinstate_member' && !member) {
            return { status: 'void', reason: 'Subject member does not exist' };
        }
    }

    if (decision.effect === 'remove_member' || decision.effect === 'suspend_member') {
        if (!decision.subject) return { status: 'blocked', reason: 'Missing member subject' };
        if (isSoleOwner(decision.subject)) {
            return { status: 'blocked', reason: 'Cannot remove or suspend sole node owner via community vote per §3.8' };
        }
    }

    if (decision.effect === 'grant_enterprise') {
        if (!decision.subject) return { status: 'blocked', reason: 'Missing enterprise subject' };
        const enterprise = getMember(decision.subject);
        if (!enterprise || !enterprise.isTreasury) {
            return { status: 'void', reason: 'Subject enterprise does not exist or was archived' };
        }
        const amount = Number(decision.params?.amount);
        if (!amount || amount <= 0 || !Number.isFinite(amount)) {
            return { status: 'blocked', reason: 'Invalid grant amount' };
        }
        if (getCommonsBalanceExact() < amount) {
            return { status: 'insufficient_funds', reason: `Insufficient pool funds: requires ${amount}, available ${getCommonsBalanceExact().toFixed(2)}` };
        }
    }

    if (decision.effect === 'grant_hardship') {
        if (!decision.subject) return { status: 'blocked', reason: 'Missing hardship grant recipient' };
        const recipient = getMember(decision.subject);
        if (!recipient || recipient.status === 'pruned' || recipient.isTreasury) {
            return { status: 'void', reason: 'Invalid or missing hardship recipient member' };
        }
        const amount = Number(decision.params?.amount);
        if (!amount || amount <= 0 || !Number.isFinite(amount)) {
            return { status: 'blocked', reason: 'Invalid hardship grant amount' };
        }
        if (getCommonsBalanceExact() < amount) {
            return { status: 'insufficient_funds', reason: `Insufficient pool funds: requires ${amount}, available ${getCommonsBalanceExact().toFixed(2)}` };
        }
    }

    if (decision.effect === 'write_off_deficit') {
        if (!decision.subject) return { status: 'blocked', reason: 'Missing enterprise subject' };
        const enterprise = getMember(decision.subject);
        if (!enterprise || !enterprise.isTreasury) {
            return { status: 'void', reason: 'Subject enterprise does not exist or was archived' };
        }
        const entAccount = ledger.getAccount(decision.subject);
        const deficit = entAccount && entAccount.balance < 0 ? Math.abs(entAccount.balance) : 0;
        if (deficit > 0 && getCommonsBalanceExact() < deficit) {
            return { status: 'insufficient_funds', reason: `Insufficient pool funds: requires ${deficit}, available ${getCommonsBalanceExact().toFixed(2)}` };
        }
    }

    return { status: 'ok' };
}

/**
 * Executes a passed decision inside a single conservingTransaction (BEGIN IMMEDIATE).
 * Reversible flips and money execute immediately.
 * Destructive removal sets 7-day grace period and suspends member.
 */
export function executeDecision(decisionId: string): { success: boolean; status: DecisionStatus; error?: string } {
    const decision = getDecision(decisionId);
    if (!decision) return { success: false, status: 'execution_blocked', error: 'Decision not found' };

    // Idempotency: if already executed or void, return current status
    if (decision.status === 'executed' || decision.status === 'execution_void') {
        return { success: true, status: decision.status };
    }

    const preflight = preflightAssert(decision);
    const now = new Date().toISOString();

    if (preflight.status === 'void') {
        db.prepare(
            "UPDATE decisions SET status = 'execution_void', executed_at = ?, execution_reason = ?, updated_at = ? WHERE id = ?"
        ).run(now, preflight.reason || 'Subject dead', now, decisionId);
        broadcast({ type: 'decision_updated', decision: getDecision(decisionId)! });
        return { success: false, status: 'execution_void', error: preflight.reason };
    }

    if (preflight.status === 'insufficient_funds') {
        db.prepare(
            "UPDATE decisions SET status = 'passed_queued_for_funds', execution_reason = ?, updated_at = ? WHERE id = ?"
        ).run(preflight.reason || 'Queued for pool funds', now, decisionId);
        broadcast({ type: 'decision_updated', decision: getDecision(decisionId)! });
        return { success: true, status: 'passed_queued_for_funds' };
    }

    if (preflight.status === 'blocked') {
        db.prepare(
            "UPDATE decisions SET status = 'execution_blocked', execution_error = ?, updated_at = ? WHERE id = ?"
        ).run(preflight.reason || 'Preflight blocked', now, decisionId);
        broadcast({ type: 'decision_updated', decision: getDecision(decisionId)! });
        return { success: false, status: 'execution_blocked', error: preflight.reason };
    }

    // Handle Destructive removal: 7-day grace window (§3.7, §3.8)
    if (decision.effect === 'remove_member') {
        const graceEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        try {
            conservingTransaction(() => {
                // Immediately suspend and freeze member
                setUserStatusRow(decision.subject!, 'disabled');
                db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(decision.subject!);
                db.prepare(`
                    UPDATE decisions SET
                        status = 'execution_pending_grace',
                        grace_period_ends_at = ?,
                        execution_reason = 'Member suspended. 7-day grace period active before destructive removal.',
                        updated_at = ?
                    WHERE id = ?
                `).run(graceEndsAt, now, decisionId);
            });
            broadcast({ type: 'profile_updated', publicKey: decision.subject! });
            broadcast({ type: 'decision_updated', decision: getDecision(decisionId)! });
            return { success: true, status: 'execution_pending_grace' };
        } catch (e: any) {
            db.prepare(
                "UPDATE decisions SET status = 'execution_blocked', execution_error = ?, updated_at = ? WHERE id = ?"
            ).run(e?.message || String(e), now, decisionId);
            return { success: false, status: 'execution_blocked', error: e?.message };
        }
    }

    const cancelledDecisionIds: string[] = [];

    // Reversible state flips and money movements: single atomic commit
    try {
        conservingTransaction(() => {
            const authSigner = `system:decision:${decision.id}`;

            switch (decision.effect) {
                case 'suspend_member': {
                    setUserStatusRow(decision.subject!, 'disabled');
                    break;
                }
                case 'unsuspend_member':
                case 'reinstate_member': {
                    setUserStatusRow(decision.subject!, 'active');
                    db.prepare('UPDATE members SET credit_frozen = 0 WHERE public_key = ?').run(decision.subject!);
                    // Cancel any pending removal grace periods for this subject
                    const cancelledDecisions = db.prepare(
                        "SELECT id FROM decisions WHERE subject = ? AND effect = 'remove_member' AND status = 'execution_pending_grace'"
                    ).all(decision.subject!) as any[];

                    db.prepare(`
                        UPDATE decisions SET
                            status = 'failed',
                            execution_reason = 'Cancelled by member reinstatement decision',
                            updated_at = ?
                        WHERE subject = ? AND effect = 'remove_member' AND status = 'execution_pending_grace'
                    `).run(now, decision.subject!);

                    for (const cd of cancelledDecisions) {
                        cancelledDecisionIds.push(cd.id);
                    }
                    break;
                }
                case 'freeze_credit': {
                    db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(decision.subject!);
                    break;
                }
                case 'unfreeze_credit': {
                    db.prepare('UPDATE members SET credit_frozen = 0 WHERE public_key = ?').run(decision.subject!);
                    break;
                }
                case 'grant_voucher': {
                    db.prepare('UPDATE members SET can_vouch = 1 WHERE public_key = ?').run(decision.subject!);
                    break;
                }
                case 'revoke_voucher': {
                    db.prepare('UPDATE members SET can_vouch = 0 WHERE public_key = ?').run(decision.subject!);
                    break;
                }
                case 'grant_tier': {
                    const validTiers: TierName[] = ['Newcomer', 'Resident', 'Steward', 'Elder'];
                    const tier: TierName = decision.params?.tier;
                    if (!tier || !validTiers.includes(tier)) {
                        throw new Error(`Invalid tier badge: ${tier}`);
                    }
                    const granted = grantedCreditForTier(tier);
                    db.prepare('UPDATE members SET earned_credit = ? WHERE public_key = ?').run(granted, decision.subject!);
                    break;
                }
                case 'revoke_tier': {
                    db.prepare('UPDATE members SET earned_credit = 0 WHERE public_key = ?').run(decision.subject!);
                    break;
                }
                case 'grant_elder': {
                    const granted = grantedCreditForTier('Elder');
                    db.prepare('UPDATE members SET earned_credit = ? WHERE public_key = ?').run(granted, decision.subject!);
                    break;
                }
                case 'revoke_elder': {
                    db.prepare('UPDATE members SET earned_credit = 0 WHERE public_key = ?').run(decision.subject!);
                    break;
                }
                case 'remove_lead_keeper': {
                    const entPubkey = decision.params?.enterprisePubkey;
                    const leadPubkey = decision.params?.leadPubkey || decision.subject!;
                    if (!entPubkey) throw new Error('enterprisePubkey required for remove_lead_keeper');
                    db.prepare(
                        "DELETE FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ? AND role = 'lead'"
                    ).run(entPubkey, leadPubkey);
                    break;
                }
                case 'grant_enterprise': {
                    const amount = Number(decision.params.amount);
                    const entPubkey = decision.subject!;
                    if (!ledger.deductFromCommons(amount)) {
                        throw new Error('Insufficient commons funds during grant execution');
                    }
                    const account = ledger.getAccount(entPubkey);
                    account.balance += amount;
                    db.prepare(`
                        INSERT INTO accounts (public_key, balance, last_demurrage_epoch, last_updated_at)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(public_key) DO UPDATE SET
                            balance = excluded.balance,
                            last_demurrage_epoch = excluded.last_demurrage_epoch,
                            last_updated_at = excluded.last_updated_at
                    `).run(entPubkey, account.balance, account.lastDemurrageEpoch, now);

                    db.prepare(`
                        INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp, auth_signer)
                        VALUES (?, 'COMMONS_POOL', ?, ?, ?, ?, ?)
                    `).run(crypto.randomUUID(), entPubkey, amount, `Commons grant: ${decision.title.slice(0, 80)}`, now, authSigner);

                    persistDecayEvents();
                    persistCommonsBalance();
                    break;
                }
                case 'grant_hardship': {
                    const amount = Number(decision.params.amount);
                    const memberPubkey = decision.subject!;
                    if (!ledger.deductFromCommons(amount)) {
                        throw new Error('Insufficient commons funds during hardship execution');
                    }
                    const account = ledger.getAccount(memberPubkey);
                    account.balance += amount;
                    db.prepare(`
                        INSERT INTO accounts (public_key, balance, last_demurrage_epoch, last_updated_at)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(public_key) DO UPDATE SET
                            balance = excluded.balance,
                            last_demurrage_epoch = excluded.last_demurrage_epoch,
                            last_updated_at = excluded.last_updated_at
                    `).run(memberPubkey, account.balance, account.lastDemurrageEpoch, now);

                    db.prepare(`
                        INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp, auth_signer)
                        VALUES (?, 'COMMONS_POOL', ?, ?, ?, ?, ?)
                    `).run(crypto.randomUUID(), memberPubkey, amount, `Hardship grant: ${decision.title.slice(0, 80)}`, now, authSigner);

                    persistDecayEvents();
                    persistCommonsBalance();
                    break;
                }
                case 'write_off_deficit': {
                    const entPubkey = decision.subject!;
                    const entAccount = ledger.getAccount(entPubkey);
                    if (entAccount && entAccount.balance < 0) {
                        const deficit = Math.abs(entAccount.balance);
                        if (!ledger.deductFromCommons(deficit)) {
                            throw new Error('Insufficient commons funds to write off deficit');
                        }
                        entAccount.balance = 0;
                        db.prepare(`
                            INSERT INTO accounts (public_key, balance, last_demurrage_epoch, last_updated_at)
                            VALUES (?, 0, ?, ?)
                            ON CONFLICT(public_key) DO UPDATE SET balance = 0, last_updated_at = excluded.last_updated_at
                        `).run(entPubkey, entAccount.lastDemurrageEpoch, now);
                        db.prepare(`
                            INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp, auth_signer)
                            VALUES (?, 'COMMONS_POOL', ?, ?, ?, ?, ?)
                        `).run(crypto.randomUUID(), entPubkey, deficit, `Deficit write-off: ${decision.title.slice(0, 80)}`, now, authSigner);
                        persistDecayEvents();
                        persistCommonsBalance();
                    }
                    break;
                }
                case 'poll':
                case 'set_rule':
                case 'set_levy':
                    // Rule updates or parameter updates
                    break;
                default:
                    throw new Error(`Unsupported effect: ${decision.effect}`);
            }

            db.prepare(`
                UPDATE decisions SET
                    status = 'executed',
                    executed_at = ?,
                    execution_reason = 'Executed successfully',
                    updated_at = ?
                WHERE id = ?
            `).run(now, now, decisionId);
        });

        for (const cid of cancelledDecisionIds) {
            broadcast({ type: 'decision_updated', decision: getDecision(cid)! });
        }

        if (decision.subject) {
            broadcast({ type: 'profile_updated', publicKey: decision.subject });
        }
        broadcast({ type: 'decision_updated', decision: getDecision(decisionId)! });
        return { success: true, status: 'executed' };
    } catch (e: any) {
        db.prepare(
            "UPDATE decisions SET status = 'execution_blocked', execution_error = ?, updated_at = ? WHERE id = ?"
        ).run(e?.message || String(e), now, decisionId);
        broadcast({ type: 'decision_updated', decision: getDecision(decisionId)! });
        return { success: false, status: 'execution_blocked', error: e?.message };
    }
}

// ── Admin Governance Controls (§3.7, §3.8) ──────────────────────────────

/**
 * Admin brake: halt a decision in grace period or execution.
 * Requires an authenticated admin pubkey and a signed, public reason (§3.7).
 */
export function adminHaltDecision(decisionId: string, adminPubkey: string, reason: string): { success: boolean; error?: string } {
    if (!adminPubkey || !isNodeAdmin(adminPubkey)) {
        return { success: false, error: 'Unauthorized: admin required to halt decision' };
    }
    if (!reason || reason.trim().length < 10) {
        return { success: false, error: 'A signed public reason (min 10 characters) is required to halt a decision' };
    }

    const decision = getDecision(decisionId);
    if (!decision) return { success: false, error: 'Decision not found' };
    if (decision.status !== 'execution_pending_grace' && decision.status !== 'open') {
        return { success: false, error: `Cannot halt decision with status ${decision.status}` };
    }

    const now = new Date().toISOString();
    conservingTransaction(() => {
        db.prepare(`
            UPDATE decisions SET
                status = 'admin_halted',
                admin_halted_at = ?,
                admin_halted_by = ?,
                admin_halt_reason = ?,
                updated_at = ?
            WHERE id = ?
        `).run(now, adminPubkey, reason.trim(), now, decisionId);

        // If member was suspended in grace window, restore them
        if (decision.effect === 'remove_member' && decision.subject) {
            setUserStatusRow(decision.subject, 'active');
            db.prepare('UPDATE members SET credit_frozen = 0 WHERE public_key = ?').run(decision.subject);
        }
    });

    if (decision.subject) {
        broadcast({ type: 'profile_updated', publicKey: decision.subject });
    }
    broadcast({ type: 'decision_halted', decisionId, adminPubkey, reason });
    return { success: true };
}

/**
 * Admin accelerate: fires a pending grace removal immediately (§3.7).
 */
export function adminAccelerateDecision(decisionId: string, adminPubkey: string): { success: boolean; error?: string } {
    if (!adminPubkey || !isNodeAdmin(adminPubkey)) {
        return { success: false, error: 'Unauthorized: admin required to accelerate decision' };
    }

    const decision = getDecision(decisionId);
    if (!decision) return { success: false, error: 'Decision not found' };
    if (decision.status !== 'execution_pending_grace') {
        return { success: false, error: `Decision is not in grace window (${decision.status})` };
    }
    if (decision.effect !== 'remove_member' || !decision.subject) {
        return { success: false, error: 'Only pending member removals can be accelerated' };
    }

    const now = new Date().toISOString();
    try {
        adminPruneUser(decision.subject);
        db.prepare(`
            UPDATE decisions SET
                status = 'executed',
                executed_at = ?,
                execution_reason = 'Accelerated by admin',
                updated_at = ?
            WHERE id = ?
        `).run(now, now, decisionId);
        broadcast({ type: 'decision_updated', decision: getDecision(decisionId)! });
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}

// ── Tick Engine ─────────────────────────────────────────────────────────

/**
 * Tick-driven close, queue evaluation, and grace expiration.
 * No admin opens or closes rounds (§3.4, §3.7).
 */
export function tickDecisions(asOfTime?: number): {
    evaluated: number;
    executed: number;
    graceExpired: number;
    queuedEvaluated: number;
} {
    const nowIso = asOfTime ? new Date(asOfTime).toISOString() : new Date().toISOString();
    let evaluated = 0;
    let executed = 0;
    let graceExpired = 0;
    let queuedEvaluated = 0;

    // 1. Close open decisions whose window expired
    const openExpired = db.prepare(
        "SELECT * FROM decisions WHERE status = 'open' AND closes_at <= ? ORDER BY closes_at ASC"
    ).all(nowIso) as any[];

    for (const r of openExpired) {
        evaluated++;
        const tally = tallyDecision(r.id, asOfTime);
        const now = new Date().toISOString();

        if (!tally.quorumMet) {
            db.prepare(`
                UPDATE decisions SET
                    status = 'unresolved',
                    execution_reason = ?,
                    updated_at = ?
                WHERE id = ?
            `).run(`Quorum not met (${tally.totalVoters}/${tally.quorumRequired})`, now, r.id);
            broadcast({ type: 'decision_updated', decision: getDecision(r.id)! });
            continue;
        }

        if (!tally.passed) {
            db.prepare(`
                UPDATE decisions SET
                    status = 'failed',
                    execution_reason = ?,
                    updated_at = ?
                WHERE id = ?
            `).run(
                `Threshold not met (${(tally.supportRatio * 100).toFixed(1)}% < ${(tally.thresholdRequired * 100).toFixed(1)}%)`,
                now,
                r.id
            );
            broadcast({ type: 'decision_updated', decision: getDecision(r.id)! });
            continue;
        }

        // Passed! Mark passed and execute
        db.prepare("UPDATE decisions SET status = 'passed', updated_at = ? WHERE id = ?").run(now, r.id);
        const res = executeDecision(r.id);
        if (res.success && res.status === 'executed') {
            executed++;
        }
    }

    // 2. Check pending grace periods that reached expiration (§3.7)
    const graceDue = db.prepare(
        "SELECT * FROM decisions WHERE status = 'execution_pending_grace' AND grace_period_ends_at <= ? ORDER BY grace_period_ends_at ASC"
    ).all(nowIso) as any[];

    for (const r of graceDue) {
        graceExpired++;
        const now = new Date().toISOString();
        if (r.effect === 'remove_member' && r.subject) {
            const member = getMember(r.subject);
            if (!member || member.status === 'pruned') {
                db.prepare(`
                    UPDATE decisions SET
                        status = 'executed',
                        executed_at = ?,
                        execution_reason = 'Member was already pruned',
                        updated_at = ?
                    WHERE id = ?
                `).run(now, now, r.id);
                continue;
            }

            try {
                adminPruneUser(r.subject);
                db.prepare(`
                    UPDATE decisions SET
                        status = 'executed',
                        executed_at = ?,
                        execution_reason = 'Pruned automatically after 7-day grace window',
                        updated_at = ?
                    WHERE id = ?
                `).run(now, now, r.id);
                broadcast({ type: 'decision_updated', decision: getDecision(r.id)! });
            } catch (e: any) {
                db.prepare(`
                    UPDATE decisions SET
                        status = 'execution_blocked',
                        execution_error = ?,
                        updated_at = ?
                    WHERE id = ?
                `).run(e?.message || String(e), now, r.id);
                broadcast({ type: 'decision_updated', decision: getDecision(r.id)! });
            }
        }
    }

    // 3. Check funding queue (§3.7): 1 grant at a time, 90-day expiry
    const queuedGrants = db.prepare(
        "SELECT * FROM decisions WHERE status = 'passed_queued_for_funds' ORDER BY closes_at ASC"
    ).all() as any[];

    if (queuedGrants.length > 0) {
        const top = queuedGrants[0];
        queuedEvaluated++;
        const now = asOfTime ? new Date(asOfTime) : new Date();
        const closesAtDate = new Date(top.closes_at);
        const ageDays = (now.getTime() - closesAtDate.getTime()) / (1000 * 60 * 60 * 24);

        if (ageDays > 90) {
            // Expired after 90 days
            db.prepare(`
                UPDATE decisions SET
                    status = 'failed',
                    execution_reason = 'Queued grant expired after 90 days without sufficient pool funds',
                    updated_at = ?
                WHERE id = ?
            `).run(now.toISOString(), top.id);
            broadcast({ type: 'decision_updated', decision: getDecision(top.id)! });
        } else {
            let requiredAmount = 0;
            if (top.effect === 'write_off_deficit' && top.subject) {
                const entAccount = ledger.getAccount(top.subject);
                requiredAmount = entAccount && entAccount.balance < 0 ? Math.abs(entAccount.balance) : 0;
            } else {
                requiredAmount = Number(JSON.parse(top.params || '{}')?.amount || 0);
            }

            if (requiredAmount === 0 || getCommonsBalanceExact() >= requiredAmount) {
                const res = executeDecision(top.id);
                if (res.success && res.status === 'executed') {
                    executed++;
                }
            }
        }
    }

    return { evaluated, executed, graceExpired, queuedEvaluated };
}
