/**
 * Community Decisions Engine (docs/the-commons.md §3.2–§3.8, Slice 5).
 *
 * The binding half of commons governance:
 * - Typed by what the effect touches: member or pool (§3.6).
 * - Two franchises:
 *     - 1m1v (one member, one vote) for member decisions.
 *     - Quadratic on earned trade standing for pool/treasury decisions.
 * - Who votes: active, unfrozen members who joined BEFORE the Decision opened (no mid-vote stacking).
 * - Ballots are secret: only totals and the caller's own vote are ever served; votes stay stored against
 *   keys for dedup and verification.
 * - Quorum: 30% of the Decision's electorate active in the last 30 days (any signed activity), floor 3
 *   (25% for member removal).
 * - Pass rules (§3.4):
 *     - 60% supermajority standard.
 *     - 66% supermajority for member removal.
 *     - Simple majority (> 50%) for restorations (unsuspend, unfreeze, reinstate).
 *     - Ties fail. Quorum failures expire as UNRESOLVED.
 * - Lifecycle:
 *     - Fixed 7-day voting window.
 *     - Closes and executes ON A TICK — no admin opens or closes it.
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
 * - Emergency suspension: an admin suspends at once and the node opens a 7-day "Keep this suspension?"
 *   Decision in the same transaction. If it does not pass (or misses quorum) the suspension lifts itself.
 */

import crypto from 'node:crypto';
import * as engine from '@beanpool/engine';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { isNodeOwner } from './engine/node-roles.js';
import { noteTakeoverInputsChanged } from './services/takeover-signal.js';
import { getProfileSwitches, BeansOffError, FeatureOffError, type ProfileSwitch } from './config/node-profile.js';
import {
    conservingTransaction,
    getCommonsBalanceExact,
    getBalance,
    getMember,
    setUserStatusRow,
    adminPruneUser,
    COMMUNITY_DECISION_ACTOR,
    isOwnerLevelActor,
    heldPrivilegedRole,
    broadcast,
    isNodeAdmin,
    isSoleOwner,
    persistDecayEvents,
    persistCommonsBalance,
    promoteOrPauseAfterLeadLeft,
    closePendingKeeperChangesFor,
    clearEnterpriseFloorCache,
} from './state-engine.js';

export type DecisionTouch = 'member' | 'pool';

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
    | 'remove_lead_keeper'
    | 'reinstate_member'
    // Opened only by an admin's emergency suspension, never proposed by a member
    | 'keep_suspension'
    // Member destructive
    | 'remove_member'
    // Pool money
    | 'grant_enterprise'
    | 'grant_hardship'
    | 'write_off_deficit';

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
    /** Members who could vote on this Decision and were active in the last 30 days — the turnout base. */
    electorate: number;
    /** Share of the electorate that must vote (0.30, or 0.25 for removing a member). */
    quorumRatio: number;
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

/** A Decision as members see it: see publicDecision. */
export type PublicDecision = Omit<Decision, 'adminHaltedBy'>;

/**
 * A Decision as members see it — every route and broadcast that is not admin-only. Which admin halted a vote
 * or made an emergency suspension is an admin key: members get the public reason on the card, not the key.
 * Admin routes (/api/local/admin/*) serve the full Decision.
 */
export function publicDecision(decision: Decision): PublicDecision {
    const { adminHaltedBy: _haltedBy, ...rest } = decision;
    if (rest.params && typeof rest.params === 'object' && 'suspendedBy' in rest.params) {
        const { suspendedBy: _suspendedBy, ...params } = rest.params;
        return { ...rest, params };
    }
    return rest;
}

/**
 * Maps what a decision touches to its mandatory franchise (§3.6):
 * - pool -> quadratic on earned trade
 * - member -> 1m1v
 */
export function franchiseForTouch(touches: DecisionTouch): DecisionFranchise {
    if (touches === 'pool') return 'quadratic_trade';
    return '1m1v';
}

export const TOUCHES_FOR_EFFECT: Record<DecisionEffect, DecisionTouch> = {
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
    remove_lead_keeper: 'member',
    keep_suspension: 'member',
};

/** Effects the node opens by itself; a member can never propose one. */
const SYSTEM_ONLY_EFFECTS: ReadonlySet<DecisionEffect> = new Set<DecisionEffect>(['keep_suspension']);

/**
 * The node profile switch an effect needs (config/node-profile.ts), or null. The pool effects pay Beans out of the
 * Commons, outside transfer(), so they are refused here when Beans are off: at the proposal, and again at execution.
 */
function switchOffFor(effect: DecisionEffect): ProfileSwitch | null {
    const s = getProfileSwitches();
    if (TOUCHES_FOR_EFFECT[effect] === 'pool' && !s.beans) return 'beans';
    if (effect === 'remove_lead_keeper' && !(s.enterprises && s.treasuries)) return 'enterprises';
    return null;
}

function assertEffectAllowedHere(effect: DecisionEffect): void {
    const off = switchOffFor(effect);
    if (off === 'beans') throw new BeansOffError('Beans are switched off on this node, so the Commons has nothing to grant or write off.');
    if (off) throw new FeatureOffError(off);
}

/** The node's impersonal voice: author of Decisions it opens by itself (emergency-suspension ratification). */
export const SYSTEM_AUTHOR = 'SYSTEM';

export const NO_TRADE_POOL_VOTE_ERROR = 'Voting on community money opens after your first completed trade.';
export const JOINED_AFTER_OPEN_ERROR = 'Only members who joined before this Decision opened can vote on it.';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a stored timestamp. Rows written by the code are ISO-8601 with a Z; rows written by SQLite's
 * datetime() are 'YYYY-MM-DD HH:MM:SS' with no zone, which Date.parse would read as LOCAL time.
 * Both are UTC.
 */
export function parseDbTime(value: string | null | undefined): number {
    if (!value) return NaN;
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return Date.parse(s.replace(' ', 'T') + 'Z');
    return Date.parse(s);
}

/**
 * Returns required pass threshold per §3.4:
 * - remove_member: 66% (0.66)
 * - restorations (unsuspend_member, unfreeze_credit, reinstate_member): simple majority (> 0.50)
 * - pool / member actions: 60% (0.60)
 */
export function thresholdForEffect(effect: DecisionEffect, _touches?: DecisionTouch): number {
    if (effect === 'remove_member') return 0.66;
    if (
        effect === 'unsuspend_member' ||
        effect === 'unfreeze_credit' ||
        effect === 'reinstate_member'
    ) {
        return 0.50;
    }
    return 0.60;
}

/**
 * Returns quorum ratio per §3.4:
 * - remove_member: 25% (0.25)
 * - others: 30% (0.30)
 */
export function quorumRatioForEffect(effect: DecisionEffect, _touches?: DecisionTouch): number {
    if (effect === 'remove_member') return 0.25;
    return 0.30;
}

/**
 * The turnout base (§3.4, answer K): members who could vote and were ACTIVE in the 30 days before
 * `asOfTime` — any signed activity, not only trades.
 *
 * "Could vote" is the same test checkVoterEligibility applies: active, unfrozen, not an enterprise, and —
 * when `joinedBefore` is given (a Decision's opensAt) — joined before the Decision opened.
 *
 * Activity signal: `members.last_active_at`, stamped from the verified signer of every signed write
 * (https-server requireSignature → recordActivity). It is NOT carried by delta backup (the members touch
 * trigger deliberately skips it, so a heartbeat doesn't resend the row), so on a node restored from a delta
 * replica it can lag. The durable records of signed actions that DO travel with every backup — ledger
 * payments the member signed, marketplace trades, posts — and local Decision votes are therefore counted too,
 * so a restored node never under-counts a member who was plainly active.
 *
 * Ledger rows count by `auth_signer`, never `from_pubkey`: the node writes rows FROM a member that the member
 * never signed (the daily circulation fee, engine/audit.ts), and those must not make an idle member active.
 */
export function getActiveMembersCount30d(asOfTime?: number, joinedBefore?: string | null): number {
    const asOf = asOfTime ?? Date.now();
    const cutoff = new Date(asOf - 30 * DAY_MS).toISOString();
    const joinedBeforeIso = joinedBefore ? new Date(parseDbTime(joinedBefore)).toISOString() : null;

    const row = db.prepare(`
        SELECT COUNT(*) AS count FROM members m
        WHERE m.status = 'active'
          AND COALESCE(m.is_treasury, 0) = 0
          AND COALESCE(m.credit_frozen, 0) = 0
          AND m.public_key NOT IN ('SYSTEM', 'COMMONS_POOL')
          AND m.public_key NOT LIKE 'escrow_%'
          AND (@joinedBefore IS NULL OR (m.joined_at IS NOT NULL AND julianday(m.joined_at) < julianday(@joinedBefore)))
          AND (
                julianday(m.last_active_at) >= julianday(@cutoff)
             OR EXISTS (SELECT 1 FROM transactions t
                        WHERE t.auth_signer = m.public_key AND julianday(t.timestamp) >= julianday(@cutoff))
             OR EXISTS (SELECT 1 FROM marketplace_transactions mt
                        WHERE mt.buyer_pubkey = m.public_key AND julianday(mt.created_at) >= julianday(@cutoff))
             OR EXISTS (SELECT 1 FROM marketplace_transactions mt
                        WHERE mt.seller_pubkey = m.public_key AND julianday(mt.created_at) >= julianday(@cutoff))
             OR EXISTS (SELECT 1 FROM posts p
                        WHERE p.author_pubkey = m.public_key AND julianday(p.created_at) >= julianday(@cutoff))
             OR EXISTS (SELECT 1 FROM decision_votes dv
                        WHERE dv.voter_pubkey = m.public_key AND julianday(dv.updated_at) >= julianday(@cutoff))
          )
    `).get({ cutoff, joinedBefore: joinedBeforeIso }) as any;

    return row?.count || 0;
}

/** When a Decision's turnout is measured: now while it is open, its closing moment once closed. */
function electorateAsOf(decision: { closesAt?: string }, asOfTime?: number): number {
    const at = asOfTime ?? Date.now();
    const closes = parseDbTime(decision.closesAt);
    return Number.isFinite(closes) ? Math.min(at, closes) : at;
}

/**
 * The electorate a Decision's turnout is measured against: members who could vote on it (joined before it
 * opened) and were active in the 30 days before it closes (or now, while it is open).
 */
export function getDecisionElectorate(decision: { opensAt?: string; closesAt?: string }, asOfTime?: number): number {
    return getActiveMembersCount30d(electorateAsOf(decision, asOfTime), decision.opensAt ?? null);
}

/**
 * Computes required quorum for a decision:
 * quorum = max( K_min, ceil(ratio * electorate) ), K_min = 3.
 */
export function getQuorumRequired(decision: Decision | { effect: DecisionEffect; touches: DecisionTouch; opensAt?: string; closesAt?: string }, asOfTime?: number, activeMembersCount?: number): number {
    const ratio = quorumRatioForEffect(decision.effect, decision.touches);
    const active = activeMembersCount !== undefined ? activeMembersCount : getDecisionElectorate(decision, asOfTime);
    return Math.max(3, Math.ceil(ratio * active));
}

/**
 * Check if a member is eligible to author a decision (§3.2, §10):
 * - Active member, not frozen, not treasury.
 * - earnedCredit > 0 (or qualified trade value > 0, or node admin).
 * - Max 1 open decision per author.
 */
export function checkCanProposeDecision(authorPubkey: string): { ok: boolean; error?: string } {
    const standing = checkProposalStanding(authorPubkey);
    if (!standing.ok) return standing;

    const openCount = (db.prepare(
        "SELECT COUNT(*) AS c FROM decisions WHERE author_pubkey = ? AND status = 'open'"
    ).get(authorPubkey) as any)?.c || 0;
    if (openCount >= 1) {
        return { ok: false, error: 'Member already has an open decision (limit 1)' };
    }

    return { ok: true };
}

/**
 * Whether a member may propose at all — every rule of checkCanProposeDecision except the one-open-Decision
 * limit. The Decisions list serves it (canPropose) so the apps gate the Propose button on the node's rule.
 */
export function checkProposalStanding(authorPubkey: string): { ok: boolean; error?: string } {
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
    return { ok: true };
}

/**
 * Check if a member is eligible to vote on decisions (§3.3, answer J):
 * - Account active, not frozen, not an enterprise.
 * - Joined BEFORE the Decision opened (pass the Decision) — a block of members invited mid-vote can't
 *   swing it. No 14-day or vouch rule at launch.
 *
 * joined_at is written once at registration and never overwritten: the backup importer copies it on insert
 * and leaves it alone on update, and a full-file restore carries the row as-is (test-decisions-voting-answers).
 */
export function checkVoterEligibility(voterPubkey: string, decision?: { opensAt: string } | null): { ok: boolean; error?: string } {
    const member = getMember(voterPubkey);
    if (!member) return { ok: false, error: 'Member not found' };
    if (member.status !== 'active') return { ok: false, error: 'Voter account is not active' };
    const row = db.prepare("SELECT COALESCE(credit_frozen, 0) as credit_frozen, joined_at FROM members WHERE public_key = ?").get(voterPubkey) as any;
    if (row?.credit_frozen === 1) return { ok: false, error: 'Voter credit is frozen' };
    if (member.isTreasury) return { ok: false, error: 'Enterprise accounts cannot vote' };
    if (decision) {
        const joined = parseDbTime(row?.joined_at);
        const opened = parseDbTime(decision.opensAt);
        if (!Number.isFinite(joined) || !Number.isFinite(opened) || joined >= opened) {
            return { ok: false, error: JOINED_AFTER_OPEN_ERROR };
        }
    }
    return { ok: true };
}

/** Has this member ever completed a marketplace trade (either side)? */
export function hasCompletedTrade(pubkey: string): boolean {
    return !!db.prepare(
        "SELECT 1 FROM marketplace_transactions WHERE status = 'completed' AND (buyer_pubkey = ? OR seller_pubkey = ?) AND buyer_pubkey != seller_pubkey LIMIT 1"
    ).get(pubkey, pubkey);
}

/**
 * Voice credits for pool Decisions (answer H): the number the server checks a quadratic vote against —
 * qualifiedTradeValue, rounded to cents. A fresh allowance on every pool Decision, never a shared budget.
 */
export function getVoiceCredits(pubkey: string): number {
    return Math.round(engine.qualifiedTradeValue(db, pubkey) * 100) / 100;
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
    const totalCredits = getVoiceCredits(voterPubkey);
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
    // First: a Decision this node can't carry out gets the plain answer, whoever proposes it. An unknown effect falls
    // through to the checks below as before.
    if (Object.prototype.hasOwnProperty.call(TOUCHES_FOR_EFFECT, opts.effect)) assertEffectAllowedHere(opts.effect);
    const check = checkCanProposeDecision(opts.authorPubkey);
    if (!check.ok) {
        throw new Error(check.error || 'Cannot propose decision');
    }

    if (!Object.prototype.hasOwnProperty.call(TOUCHES_FOR_EFFECT, opts.effect)) {
        throw new Error(`Unknown decision effect '${opts.effect}'`);
    }
    if (SYSTEM_ONLY_EFFECTS.has(opts.effect)) {
        throw new Error(`'${opts.effect}' Decisions are opened by the node when an admin suspends someone, not proposed`);
    }

    if (opts.touches !== TOUCHES_FOR_EFFECT[opts.effect]) {
        throw new Error(`Invalid touch '${opts.touches}' for effect '${opts.effect}'. Expected '${TOUCHES_FOR_EFFECT[opts.effect]}'.`);
    }

    const id = crypto.randomUUID();
    const franchise = franchiseForTouch(opts.touches);
    const now = new Date();
    const opensAt = now.toISOString();
    const closesAt = opts.closesAt || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    let finalParams = opts.params !== undefined && opts.params !== null ? { ...opts.params } : (opts.effect === 'remove_member' && opts.subject ? {} : opts.params);
    if (opts.effect === 'remove_member' && opts.subject) {
        const member = getMember(opts.subject);
        const accRow = db.prepare("SELECT balance FROM accounts WHERE public_key = ?").get(opts.subject) as { balance: number } | undefined;
        const memberBalance = accRow !== undefined ? accRow.balance : (getBalance(opts.subject)?.balance ?? 0);
        const commonsPoolBal = getCommonsBalanceExact();
        const memberName = member?.callsign || opts.params?.memberName || opts.subject.slice(0, 8);
        const debt = memberBalance < 0 ? Math.abs(memberBalance) : 0;
        finalParams = {
            ...opts.params,
            memberName,
            debt, // Authoritatively computed from ledger
            commonsPool: Math.round(commonsPoolBal), // Authoritatively computed from ledger
            balance: memberBalance,
        };
    }
    const serializedParams = finalParams !== undefined && finalParams !== null ? JSON.stringify(finalParams) : null;

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
    broadcast({ type: 'decision_created', decision: publicDecision(decision) });
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
    if (decision.status !== 'open') return { success: false, creditsUsed: 0, error: `Decision is ${decision.status}` };
    if (parseDbTime(decision.closesAt) <= Date.now()) {
        return { success: false, creditsUsed: 0, error: 'Voting window has closed' };
    }

    const elig = checkVoterEligibility(voterPubkey, decision);
    if (!elig.ok) return { success: false, creditsUsed: 0, error: elig.error };

    const num = Number(voteCount);
    if (!Number.isFinite(num) || num < 1) {
        return { success: false, creditsUsed: 0, error: 'voteCount must be a positive finite integer' };
    }
    const count = Math.floor(num);
    let weight = 1;
    let creditCost = 1;

    if (decision.franchise === 'quadratic_trade') {
        creditCost = count * count;
        weight = count;
        const credits = getVoiceCredits(voterPubkey);
        if (credits <= 0 && !hasCompletedTrade(voterPubkey)) {
            return { success: false, creditsUsed: 0, error: NO_TRADE_POOL_VOTE_ERROR };
        }
        if (creditCost > credits) {
            return {
                success: false,
                creditsUsed: 0,
                error: `${count} ${count === 1 ? 'vote costs' : 'votes cost'} ${creditCost} voice credits, and you have ${Math.floor(credits)}.`,
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

    // Secret ballot (answer I): the announcement says only that the tally moved. Who voted, which way and
    // with what weight never leave the node; clients refetch the totals.
    broadcast({ type: 'decision_vote_cast', decisionId });

    return { success: true, creditsUsed: creditCost };
}

export interface OwnDecisionVote {
    support: boolean;
    /** Votes cast: always 1 for one-member-one-vote; the chosen count on a quadratic pool Decision. */
    voteCount: number;
    creditsUsed: number;
    updatedAt: string;
}

/**
 * One voter's own votes, keyed by decision id. Callers pass the authenticated actor only —
 * this is how a member sees their own vote without the list exposing anyone else's.
 */
export function getOwnDecisionVotes(voterPubkey: string, decisionIds?: string[]): Map<string, OwnDecisionVote> {
    const rows = db.prepare(
        'SELECT decision_id, support, weight, credits_used, updated_at FROM decision_votes WHERE voter_pubkey = ?'
    ).all(voterPubkey) as any[];
    const wanted = decisionIds ? new Set(decisionIds) : null;
    const out = new Map<string, OwnDecisionVote>();
    for (const r of rows) {
        if (wanted && !wanted.has(r.decision_id)) continue;
        out.set(r.decision_id, {
            support: r.support === 1,
            voteCount: r.weight,
            creditsUsed: r.credits_used,
            updatedAt: r.updated_at,
        });
    }
    return out;
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
export function tallyDecision(decisionId: string, asOfTime?: number): DecisionTally {
    const decision = getDecision(decisionId);
    if (!decision) throw new Error(`Decision ${decisionId} not found`);

    const votes = getDecisionVotes(decisionId);
    const totalVoters = votes.length;
    const electorate = getDecisionElectorate(decision, asOfTime);
    const quorumRatio = quorumRatioForEffect(decision.effect, decision.touches);
    const quorumRequired = getQuorumRequired(decision, asOfTime, electorate);
    const quorumMet = totalVoters >= quorumRequired;

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
        electorate,
        quorumRatio,
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
    // 0. A switch this node runs with off: nothing to execute (config/node-profile.ts).
    const off = switchOffFor(decision.effect);
    if (off) return { status: 'blocked', reason: `${off} is switched off on this node` };

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

    if (decision.status === 'admin_halted' || decision.status === 'failed' || decision.status === 'unresolved') {
        return { success: false, status: decision.status, error: `Cannot execute decision in status ${decision.status}` };
    }

    const preflight = preflightAssert(decision);
    const now = new Date().toISOString();

    if (preflight.status === 'void') {
        db.prepare(
            "UPDATE decisions SET status = 'execution_void', executed_at = ?, execution_reason = ?, updated_at = ? WHERE id = ?"
        ).run(now, preflight.reason || 'Subject dead', now, decisionId);
        broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(decisionId)!) });
        return { success: false, status: 'execution_void', error: preflight.reason };
    }

    if (preflight.status === 'insufficient_funds') {
        const existingQueued = (db.prepare(
            "SELECT COUNT(*) as c FROM decisions WHERE status = 'passed_queued_for_funds' AND id != ?"
        ).get(decisionId) as any)?.c || 0;

        if (existingQueued >= 1) {
            db.prepare(
                "UPDATE decisions SET status = 'execution_blocked', execution_error = 'Funding queue full: maximum 1 queued grant permitted per §3.7', updated_at = ? WHERE id = ?"
            ).run(now, decisionId);
            broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(decisionId)!) });
            return { success: false, status: 'execution_blocked', error: 'Funding queue is full (max 1 queued grant per §3.7)' };
        }

        db.prepare(
            "UPDATE decisions SET status = 'passed_queued_for_funds', execution_reason = ?, updated_at = ? WHERE id = ?"
        ).run(preflight.reason || 'Queued for pool funds', now, decisionId);
        broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(decisionId)!) });
        return { success: true, status: 'passed_queued_for_funds' };
    }

    if (preflight.status === 'blocked') {
        db.prepare(
            "UPDATE decisions SET status = 'execution_blocked', execution_error = ?, updated_at = ? WHERE id = ?"
        ).run(preflight.reason || 'Preflight blocked', now, decisionId);
        broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(decisionId)!) });
        return { success: false, status: 'execution_blocked', error: preflight.reason };
    }

    // Handle Destructive removal: 7-day grace window (§3.7, §3.8)
    if (decision.effect === 'remove_member') {
        const graceEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        try {
            conservingTransaction(() => {
                // Hold the member's node role aside before the suspension deletes it, so halting the removal
                // in its grace window gives it back exactly (as an emergency suspension does).
                db.prepare(`
                    INSERT INTO suspended_node_roles (decision_id, member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
                    SELECT ?, member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash
                    FROM node_roles WHERE member_pubkey = ?
                `).run(decisionId, decision.subject!);
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
            broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(decisionId)!) });
            return { success: true, status: 'execution_pending_grace' };
        } catch (e: any) {
            db.prepare(
                "UPDATE decisions SET status = 'execution_blocked', execution_error = ?, updated_at = ? WHERE id = ?"
            ).run(e?.message || String(e), now, decisionId);
            return { success: false, status: 'execution_blocked', error: e?.message };
        }
    }

    // Reversible state flips and money movements: single atomic commit
    try {
        let alreadyExecuted = false;
        const cancelledDecisionIds: string[] = [];
        const touchedEnterprises: string[] = [];
        const touchedProfiles: string[] = [];

        conservingTransaction(() => {
            // Re-verify status under write lock to guard against concurrent execution
            const current = db.prepare("SELECT status FROM decisions WHERE id = ?").get(decision.id) as { status: DecisionStatus } | undefined;
            if (!current || current.status === 'executed' || current.status === 'execution_void') {
                alreadyExecuted = true;
                return;
            }

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
                        // The community reinstated them: the role the removal held aside comes back too.
                        restoreSuspendedNodeRole(cd.id);
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
                case 'keep_suspension': {
                    // The admin's emergency suspension is already in force; passing keeps it. The node role it
                    // held aside is gone for good — the community kept the suspension.
                    db.prepare('DELETE FROM suspended_node_roles WHERE decision_id = ?').run(decision.id);
                    break;
                }
                case 'remove_lead_keeper': {
                    // Answer G (2026-09-19): the removed lead's place goes at once to the longest-serving remaining
                    // active keeper, who may then be replaced by the other keepers' succession without the 30-day
                    // wait. No active keeper left: the enterprise pauses, and its next step is wind-up.
                    const leadPubkey = decision.params?.leadPubkey || decision.subject!;
                    const named = decision.params?.enterprisePubkey;
                    const enterprises: string[] = named && named !== leadPubkey
                        ? [named]
                        : (db.prepare("SELECT treasury_pubkey FROM treasury_operators WHERE member_pubkey = ? AND role = 'lead'").all(leadPubkey) as any[])
                            .map(r => r.treasury_pubkey);
                    for (const entPubkey of enterprises) {
                        const removed = db.prepare(
                            "DELETE FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ? AND role = 'lead'"
                        ).run(entPubkey, leadPubkey);
                        if (removed.changes === 0) continue;
                        closePendingKeeperChangesFor(entPubkey, leadPubkey, 'The community removed this lead keeper');
                        const { promoted } = promoteOrPauseAfterLeadLeft(entPubkey, `decision:${decision.id}`);
                        touchedEnterprises.push(entPubkey);
                        if (promoted) touchedProfiles.push(promoted);
                    }
                    const left = db.prepare("SELECT COUNT(*) AS c FROM treasury_operators WHERE member_pubkey = ?").get(leadPubkey) as any;
                    if (!left?.c) db.prepare("UPDATE members SET can_operate = 0 WHERE public_key = ?").run(leadPubkey);
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

        if (alreadyExecuted) {
            const current = getDecision(decisionId);
            return { success: true, status: current?.status || 'executed' };
        }

        for (const ent of touchedEnterprises) {
            clearEnterpriseFloorCache(ent);
            broadcast({ type: 'profile_updated', publicKey: ent });
        }
        for (const pk of touchedProfiles) broadcast({ type: 'profile_updated', publicKey: pk });
        for (const cid of cancelledDecisionIds) {
            broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(cid)!) });
        }

        if (decision.subject) {
            broadcast({ type: 'profile_updated', publicKey: decision.subject });
        }
        broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(decisionId)!) });
        return { success: true, status: 'executed' };
    } catch (e: any) {
        db.prepare(
            "UPDATE decisions SET status = 'execution_blocked', execution_error = ?, updated_at = ? WHERE id = ?"
        ).run(e?.message || String(e), now, decisionId);
        broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(decisionId)!) });
        return { success: false, status: 'execution_blocked', error: e?.message };
    }
}

// ── Admin Governance Controls (§3.7, §3.8) ──────────────────────────────

/**
 * Admin brake: halt a decision in grace period or execution.
 * Requires an authenticated admin pubkey and a signed, public reason (§3.7).
 */
export function adminHaltDecision(decisionId: string, adminPubkey: string, reason: string): { success: boolean; error?: string; status?: number } {
    if (!isAdminActor(adminPubkey)) {
        return { success: false, status: 403, error: 'Unauthorized: admin required to halt decision' };
    }
    if (!reason || reason.trim().length < 10) {
        return { success: false, error: 'A signed public reason (min 10 characters) is required to halt a decision' };
    }

    const decision = getDecision(decisionId);
    if (!decision) return { success: false, error: 'Decision not found' };
    if (decision.status !== 'execution_pending_grace' && decision.status !== 'open') {
        return { success: false, error: `Cannot halt decision with status ${decision.status}` };
    }
    // Halting a removal in its grace window, or the vote on an emergency suspension, gives the member back
    // the node role held aside for it — and only an owner may grant an owner or admin role.
    const restoresRole = (decision.status === 'execution_pending_grace' && decision.effect === 'remove_member')
        || decision.effect === 'keep_suspension';
    if (restoresRole && !isOwnerLevelActor(adminPubkey)) {
        const held = heldRoleFor([decisionId]);
        if (held) return { success: false, status: 403, error: roleRestoreRefusal(held) };
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
        if (decision.status === 'execution_pending_grace' && decision.effect === 'remove_member' && decision.subject) {
            setUserStatusRow(decision.subject, 'active');
            db.prepare('UPDATE members SET credit_frozen = 0 WHERE public_key = ?').run(decision.subject);
            restoreSuspendedNodeRole(decision.id);
        }
        // Halting the ratifying vote takes away the only thing that could keep an emergency suspension,
        // so it lifts — an admin can't park a suspension forever by stopping its vote.
        if (decision.effect === 'keep_suspension') {
            liftEmergencySuspensionRow(decision);
        }
    });

    if (decision.subject) {
        broadcast({ type: 'profile_updated', publicKey: decision.subject });
    }
    broadcast({ type: 'decision_halted', decisionId, reason });
    return { success: true };
}

/**
 * Admin accelerate: fires a pending grace removal immediately (§3.7).
 */
export function adminAccelerateDecision(decisionId: string, adminPubkey: string): { success: boolean; error?: string; status?: number } {
    if (!isAdminActor(adminPubkey)) {
        return { success: false, status: 403, error: 'Unauthorized: admin required to accelerate decision' };
    }

    const decision = getDecision(decisionId);
    if (!decision) return { success: false, error: 'Decision not found' };
    if (decision.status !== 'execution_pending_grace') {
        return { success: false, error: `Decision is not in grace window (${decision.status})` };
    }
    if (decision.effect !== 'remove_member' || !decision.subject) {
        return { success: false, error: 'Only pending member removals can be accelerated' };
    }
    // The prune below acts for the community, but speeding it up takes away the grace window in which an owner
    // could halt the removal of an owner or admin — so only an owner may speed that one up.
    const held = heldPrivilegedRole(decision.subject);
    if (held && !isOwnerLevelActor(adminPubkey)) {
        return {
            success: false,
            status: 403,
            error: `This member held the ${held} role, and only an owner can cut short the grace window on removing an owner or admin. Ask an owner to do this`,
        };
    }

    const now = new Date().toISOString();
    try {
        adminPruneUser(decision.subject, COMMUNITY_DECISION_ACTOR);
        db.prepare(`
            UPDATE decisions SET
                status = 'executed',
                executed_at = ?,
                execution_reason = 'Accelerated by admin',
                updated_at = ?
            WHERE id = ?
        `).run(now, now, decisionId);
        broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(decisionId)!) });
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}

// ── Emergency Suspension (§3.8, answer L) ───────────────────────────────

/**
 * Who may use the admin brake and emergency suspension: a node admin or owner (node_roles), or the
 * password — which only owners hold, so a password-authenticated admin route acts as 'owner:password'.
 * Routes pass the authenticated actor only, never one read from a request body.
 */
export function isAdminActor(actor: string | null | undefined): boolean {
    if (!actor) return false;
    return actor === 'owner:password' || isNodeAdmin(actor);
}

export const EMERGENCY_SUSPENSION_DAYS = 7;

/**
 * The owner or admin role held aside for any of these Decisions, if one is — what lifting them would restore.
 */
function heldRoleFor(decisionIds: string[]): 'owner' | 'admin' | null {
    if (decisionIds.length === 0) return null;
    const rows = db.prepare(
        `SELECT role FROM suspended_node_roles WHERE decision_id IN (${decisionIds.map(() => '?').join(',')}) AND role IN ('owner', 'admin')`
    ).all(...decisionIds) as { role: 'owner' | 'admin' }[];
    if (rows.some(r => r.role === 'owner')) return 'owner';
    return rows.length ? 'admin' : null;
}

function roleRestoreRefusal(role: 'owner' | 'admin'): string {
    return `This member held the ${role} role, which comes back with them, and only an owner can give back an owner or admin role. Ask an owner to do this`;
}

/**
 * Give back the node role a suspension (emergency, or a removal's grace window) held aside — the same role, grant record and break-glass
 * hash. The session epoch moves on by one, so admin sessions opened before the suspension stay dead and the
 * member signs in again. Call inside a transaction, after the member is active again.
 */
function restoreSuspendedNodeRole(decisionId: string): void {
    const held = db.prepare('SELECT * FROM suspended_node_roles WHERE decision_id = ?').get(decisionId) as {
        member_pubkey: string; role: string; granted_at: string | null; granted_by: string | null;
        session_epoch: number; break_glass_hash: string | null;
    } | undefined;
    db.prepare('DELETE FROM suspended_node_roles WHERE decision_id = ?').run(decisionId);
    if (!held) return;
    db.prepare(`
        INSERT INTO node_roles (member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(member_pubkey) DO NOTHING
    `).run(held.member_pubkey, held.role, held.granted_at, held.granted_by, held.session_epoch + 1, held.break_glass_hash);
    noteTakeoverInputsChanged(`${held.role} role given back`);
}

/**
 * Lift an emergency suspension whose ratifying Decision did not pass. Call inside a transaction.
 * The member stays suspended if something else holds them there: a pending community removal, or a
 * suspend_member Decision that passed after this suspension began. Lifted, they get back exactly the node
 * role they held. Held by a pending removal, the role moves to that removal, so halting it gives the role
 * back; held by a passed suspension, the community has acted and the role stays gone.
 */
function liftEmergencySuspensionRow(decision: Decision): boolean {
    if (!decision.subject) return false;
    const row = db.prepare('SELECT status FROM members WHERE public_key = ?').get(decision.subject) as { status: string } | undefined;
    const heldElsewhere = row?.status === 'disabled' && db.prepare(`
        SELECT 1 FROM decisions
        WHERE subject = ? AND id != ? AND (
            (effect = 'remove_member' AND status = 'execution_pending_grace')
            OR (effect = 'suspend_member' AND status = 'executed' AND julianday(executed_at) >= julianday(?))
        )
        LIMIT 1
    `).get(decision.subject, decision.id, decision.opensAt);
    if (!row || row.status !== 'disabled' || heldElsewhere) {
        // A pending community removal took them while this suspension held their role, so it had nothing to
        // hold itself. Hand the role over to the removal: an owner who halts it gives the member back with it.
        const pendingRemoval = row?.status === 'disabled' ? db.prepare(`
            SELECT id FROM decisions WHERE subject = ? AND effect = 'remove_member' AND status = 'execution_pending_grace'
            ORDER BY created_at DESC LIMIT 1
        `).get(decision.subject) as { id: string } | undefined : undefined;
        const removalHolds = pendingRemoval
            && db.prepare('SELECT 1 FROM suspended_node_roles WHERE decision_id = ?').get(pendingRemoval.id);
        if (pendingRemoval && !removalHolds) {
            db.prepare('UPDATE suspended_node_roles SET decision_id = ? WHERE decision_id = ?').run(pendingRemoval.id, decision.id);
        } else {
            db.prepare('DELETE FROM suspended_node_roles WHERE decision_id = ?').run(decision.id);
        }
        return false;
    }
    setUserStatusRow(decision.subject, 'active');
    restoreSuspendedNodeRole(decision.id);
    return true;
}

/**
 * Close a "Keep this suspension?" Decision that did not pass and lift the suspension, atomically.
 */
function closeUnkeptSuspension(decision: Decision, status: 'failed' | 'unresolved', why: string, nowIso: string): void {
    let lifted = false;
    db.transaction(() => {
        lifted = liftEmergencySuspensionRow(decision);
        db.prepare(`
            UPDATE decisions SET status = ?, execution_reason = ?, updated_at = ? WHERE id = ?
        `).run(status, `${why}. ${lifted ? 'The suspension has been lifted.' : 'The member was already restored or is held by another Decision.'}`, nowIso, decision.id);
    })();
    if (lifted && decision.subject) broadcast({ type: 'profile_updated', publicKey: decision.subject });
    broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(decision.id)!) });
}

export interface EmergencySuspendResult {
    success: boolean;
    error?: string;
    status?: number;
    decision?: Decision;
}

/**
 * An admin suspends a member at once (answer L). In the same transaction the node opens a 7-day
 * "Keep this suspension?" Decision — member-touching rules: one member one vote, the usual quorum, 60%.
 * If it does not pass, or misses quorum, the suspension lifts by itself on the tick.
 *
 * The reason is shown to members on the Decision card, so they can judge it.
 */
export function adminEmergencySuspend(subjectPubkey: string, adminActor: string, reason: string): EmergencySuspendResult {
    // Guards first, outside any transaction.
    if (!isAdminActor(adminActor)) return { success: false, status: 403, error: 'Only a node admin can suspend a member' };
    const cleanReason = String(reason || '').trim();
    if (cleanReason.length < 10) {
        return { success: false, status: 400, error: 'A reason members can read (at least 10 characters) is required to suspend someone' };
    }
    if (cleanReason.length > 1000) return { success: false, status: 400, error: 'Reason is too long (1000 characters at most)' };
    if (!subjectPubkey || subjectPubkey === SYSTEM_AUTHOR) return { success: false, status: 400, error: 'Member not found' };
    const member = getMember(subjectPubkey);
    if (!member) return { success: false, status: 404, error: 'Member not found' };
    if (member.isTreasury) return { success: false, status: 400, error: 'An enterprise account cannot be suspended this way' };
    if (member.status !== 'active') return { success: false, status: 409, error: `Member is already ${member.status === 'disabled' ? 'suspended' : member.status}` };
    if (isSoleOwner(subjectPubkey)) return { success: false, status: 400, error: "The node's only owner cannot be suspended" };
    if (adminActor === subjectPubkey) return { success: false, status: 400, error: 'You cannot suspend yourself' };
    // node_roles: only an owner may take away an owner's role, and suspending removes it. A plain admin
    // who thinks an owner must go proposes a member-removal Decision instead.
    if (isNodeOwner(subjectPubkey) && !isOwnerLevelActor(adminActor)) {
        return { success: false, status: 403, error: 'Only an owner can suspend an owner. Propose a Decision to remove them instead' };
    }

    const id = crypto.randomUUID();
    const now = new Date();
    const opensAt = now.toISOString();
    const closesAt = new Date(now.getTime() + EMERGENCY_SUSPENSION_DAYS * DAY_MS).toISOString();
    const memberName = member.callsign || subjectPubkey.slice(0, 8);
    const params = { memberName, suspendedAt: opensAt, suspendedBy: adminActor, reason: cleanReason };

    db.transaction(() => {
        // Hold the member's node role aside before the suspension deletes it, so a suspension the
        // community does not keep gives it back exactly.
        db.prepare(`
            INSERT INTO suspended_node_roles (decision_id, member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
            SELECT ?, member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash
            FROM node_roles WHERE member_pubkey = ?
        `).run(id, subjectPubkey);
        setUserStatusRow(subjectPubkey, 'disabled');
        db.prepare(`
            INSERT INTO decisions (
                id, author_pubkey, title, description, touches, effect, subject, params,
                franchise, status, opens_at, closes_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'member', 'keep_suspension', ?, ?, '1m1v', 'open', ?, ?, ?, ?)
        `).run(
            id,
            SYSTEM_AUTHOR,
            `Keep ${memberName}'s suspension?`,
            `An admin suspended ${memberName} on ${opensAt.slice(0, 10)}. Keep the suspension? Reason given: ${cleanReason}`,
            subjectPubkey,
            JSON.stringify(params),
            opensAt,
            closesAt,
            opensAt,
            opensAt,
        );
    })();

    const decision = getDecision(id)!;
    broadcast({ type: 'profile_updated', publicKey: subjectPubkey });
    broadcast({ type: 'decision_created', decision: publicDecision(decision) });
    return { success: true, decision };
}

/**
 * An admin lifts a suspension by hand. An open "Keep this suspension?" vote about it has nothing left to
 * decide, so it closes as halted, with the lift recorded as the reason.
 */
export function adminLiftSuspension(subjectPubkey: string, adminActor: string): { success: boolean; error?: string; status?: number } {
    if (!isAdminActor(adminActor)) return { success: false, status: 403, error: 'Only a node admin can lift a suspension' };
    const member = getMember(subjectPubkey);
    if (!member) return { success: false, status: 404, error: 'Member not found' };
    if (member.status !== 'disabled') return { success: false, status: 409, error: 'Member is not suspended' };
    const pendingRemoval = db.prepare(
        "SELECT 1 FROM decisions WHERE subject = ? AND effect = 'remove_member' AND status = 'execution_pending_grace'"
    ).get(subjectPubkey);
    if (pendingRemoval) {
        return { success: false, status: 409, error: 'The community voted to remove this member; halt that Decision instead' };
    }
    const nowIso = new Date().toISOString();
    const openKeeps = db.prepare(
        "SELECT id FROM decisions WHERE subject = ? AND effect = 'keep_suspension' AND status = 'open'"
    ).all(subjectPubkey) as { id: string }[];
    // Lifting gives back the role the suspension held aside; only an owner may give back an owner or admin role.
    if (!isOwnerLevelActor(adminActor)) {
        const held = heldRoleFor(openKeeps.map(k => k.id));
        if (held) return { success: false, status: 403, error: roleRestoreRefusal(held) };
    }
    db.transaction(() => {
        setUserStatusRow(subjectPubkey, 'active');
        for (const k of openKeeps) {
            restoreSuspendedNodeRole(k.id);
            db.prepare(`
                UPDATE decisions SET status = 'admin_halted', admin_halted_at = ?, admin_halted_by = ?,
                    admin_halt_reason = 'An admin lifted the suspension before the vote closed', updated_at = ?
                WHERE id = ?
            `).run(nowIso, adminActor, nowIso, k.id);
        }
    })();
    broadcast({ type: 'profile_updated', publicKey: subjectPubkey });
    for (const k of openKeeps) broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(k.id)!) });
    return { success: true };
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

    // 1. Close open decisions whose window expired, or retry stranded passed decisions
    const openExpired = db.prepare(
        "SELECT * FROM decisions WHERE status IN ('open', 'passed') AND closes_at <= ? ORDER BY closes_at ASC"
    ).all(nowIso) as any[];

    for (const r of openExpired) {
        evaluated++;
        try {
            const now = nowIso;

            if (r.status === 'passed') {
                const res = executeDecision(r.id);
                if (res.success && res.status === 'executed') {
                    executed++;
                }
                continue;
            }

            const tally = tallyDecision(r.id, asOfTime);

            if (r.effect === 'keep_suspension' && !tally.passed) {
                const why = !tally.quorumMet
                    ? `Quorum not met (${tally.totalVoters}/${tally.quorumRequired})`
                    : `Threshold not met (${(tally.supportRatio * 100).toFixed(1)}% < ${(tally.thresholdRequired * 100).toFixed(1)}%)`;
                closeUnkeptSuspension(getDecision(r.id)!, tally.quorumMet ? 'failed' : 'unresolved', why, now);
                continue;
            }

            if (!tally.quorumMet) {
                db.prepare(`
                    UPDATE decisions SET
                        status = 'unresolved',
                        execution_reason = ?,
                        updated_at = ?
                    WHERE id = ?
                `).run(`Quorum not met (${tally.totalVoters}/${tally.quorumRequired})`, now, r.id);
                broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(r.id)!) });
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
                broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(r.id)!) });
                continue;
            }

            // Passed! Mark passed and execute
            db.prepare("UPDATE decisions SET status = 'passed', updated_at = ? WHERE id = ?").run(now, r.id);
            const res = executeDecision(r.id);
            if (res.success && res.status === 'executed') {
                executed++;
            }
        } catch (err: any) {
            const now = nowIso;
            console.error(`[Decisions] Failed to evaluate decision ${r.id}:`, err);
            db.prepare(`
                UPDATE decisions SET
                    status = 'execution_blocked',
                    execution_error = ?,
                    updated_at = ?
                WHERE id = ?
            `).run(err?.message || String(err), now, r.id);
            broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(r.id)!) });
        }
    }

    // 2. Check pending grace periods that reached expiration (§3.7)
    const graceDue = db.prepare(
        "SELECT * FROM decisions WHERE status = 'execution_pending_grace' AND grace_period_ends_at <= ? ORDER BY grace_period_ends_at ASC"
    ).all(nowIso) as any[];

    for (const r of graceDue) {
        graceExpired++;
        const now = nowIso;
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
                adminPruneUser(r.subject, COMMUNITY_DECISION_ACTOR);
                db.prepare(`
                    UPDATE decisions SET
                        status = 'executed',
                        executed_at = ?,
                        execution_reason = 'Pruned automatically after 7-day grace window',
                        updated_at = ?
                    WHERE id = ?
                `).run(now, now, r.id);
                broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(r.id)!) });
            } catch (e: any) {
                db.prepare(`
                    UPDATE decisions SET
                        status = 'execution_blocked',
                        execution_error = ?,
                        updated_at = ?
                    WHERE id = ?
                `).run(e?.message || String(e), now, r.id);
                broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(r.id)!) });
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
            `).run(nowIso, top.id);
            broadcast({ type: 'decision_updated', decision: publicDecision(getDecision(top.id)!) });
        } else {
            let requiredAmount = 0;
            if (top.effect === 'write_off_deficit' && top.subject) {
                const entAccount = ledger.getAccount(top.subject);
                requiredAmount = entAccount && entAccount.balance < 0 ? Math.abs(entAccount.balance) : 0;
            } else {
                let parsed: any = {};
                try {
                    parsed = JSON.parse(top.params || '{}');
                } catch {
                    parsed = {};
                }
                requiredAmount = Number(parsed?.amount || 0);
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
