/**
 * An enterprise's keepers' vote, and a chat group's members' vote, as both apps show them (DESIGN-group-decisions §2.3–§2.5,
 * slices S2 and S3): the card's words, its two tally states, and the propose form's checks. Pure, so the apps share one copy and one test
 * (src/__tests__/scoped-decision.test.ts). The node is the judge (apps/server decisions-engine createScopedDecision): these
 * checks only keep a member from sending what it would refuse.
 *
 * While a vote is open the card shows turnout only ("2 of 4 have voted"); Yes and No once it has closed (Marty's pick 3,
 * 2026-10-10). A pay-out carries the 1.5% trade fee (pick 2): it comes out of the amount, as a Need's payment's does.
 */
import { TRANSACTION_FEE_RATE } from './ledger.js';

export type ScopedEffect = 'pay_out' | 'remove_keeper' | 'replace_lead';

/** A chat group's five effects (§2.3, slice S3): its own rows only, never money, trust or a node role. */
export type GroupEffect = 'replace_lead_convenor' | 'set_group_role' | 'remove_group_member' | 'set_join_policy' | 'close_group';

/** A join policy, as a group stores it. */
export type GroupJoinPolicy = 'open' | 'request_to_join' | 'invite_only';

/** One vote, as GET /api/enterprise/:x/decisions sends it (routes/enterprise-decisions.ts `card`). */
export interface ScopedDecisionCard {
    id: string;
    authorPubkey: string;
    title: string;
    description: string;
    effect: ScopedEffect | string;
    subject: string | null;
    params: { amount?: number; memo?: string; role?: string; policy?: string } | null;
    status: string;
    opensAt: string;
    closesAt: string;
    executionReason?: string | null;
    scopeKind?: string;
    scopeId?: string | null;
    /** Yes and No only once it has closed. */
    tally: { voted: number; roll: number; quorumRequired: number; thresholdRequired: number; yes?: number; no?: number };
    myVote: { support: number | boolean; updatedAt: string } | null;
    /** A group vote's author and subject by callsign, for a screen with no roster to name them from (#1794 N7). */
    names?: Record<string, string>;
    /** Whether the reader may vote on it: open, and on its own roll as frozen when it opened (an observer or someone removed
     *  since still is; someone who joined since is not). Yes / No are drawn from this, never from who is in the group now. */
    canVote?: boolean;
}

export interface ScopedDecisionList {
    decisions: ScopedDecisionCard[];
    /** A keeper (or a group's member or convenor) on a roll of two or more, on a node with Decisions; never in a closed group. */
    canPropose: boolean;
    rollSize: number;
    /** A group's only: whether the reader is on its roll now or on an open vote's roll, and when its members closed it. */
    onRoll?: boolean;
    closedAt?: string | null;
    /** A group's only: an observer now who votes on none of its open votes ("You watch this group"). */
    watching?: boolean;
    /** A group's only, to someone who may propose: who a vote may name (in the group now, no suspended member). */
    nameable?: string[];
}

/** A person on the roll, for the pickers. */
export interface RollPerson { pubkey: string; name: string; role?: string }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Beans to two places at most, never a trailing ".00" ("40", "39.4", "0.6"). */
export function beansAmount(n: number): string {
    const cents = Math.round(n * 100);
    return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace(/0$/, '');
}

const heldCents = (balance: number) => Math.floor(Math.max(0, balance) * 100 + 1e-6);

/**
 * What an account holds, rounded down to cents, as the node counts what it can pay ("112.31" for 112.3125): never a
 * fraction of a cent, and never more than it can pay.
 */
export function beansHeld(balance: number): string {
    return beansAmount(heldCents(balance) / 100);
}

/** What a pay-out of `amount` gives: the recipient's share and the Commons' 1.5%, in cents so they add up. */
export function payOutSplit(amount: number): { receives: number; fee: number } {
    const cents = Math.floor(amount * 100 + 1e-6);
    const fee = Math.round(cents * TRANSACTION_FEE_RATE);
    return { receives: (cents - fee) / 100, fee: fee / 100 };
}

/** The line under the amount: who gets what, and where the fee goes. */
export function payOutFeeWords(amount: number, recipient: string): string {
    const { receives, fee } = payOutSplit(amount);
    return `${recipient} receives ${beansAmount(receives)} Beans. The 1.5% trade fee (${beansAmount(fee)} Beans) goes to the Commons.`;
}

/** The node's words for a wage above the earned surplus (apps/server decisions-engine WAGE_NEEDS_SURPLUS). */
export const PAY_OUT_WAGE_WORDS = 'Paying a keeper is a wage, and a wage comes only out of what the enterprise has earned above its costs (its earned surplus)';

/**
 * The amount as typed, checked against what the enterprise holds now: a number of Beans above 0, cents at most, and no
 * more than it holds. For a keeper (`wageSurplus`: its earned surplus), no more than that either: paying a keeper is a
 * wage, and a wage comes only out of what it has earned above its costs (Rules 5 and 6), as the node checks it. A
 * surplus not known (null) is left to the node. Returns the amount, or the words to show under the field.
 */
export function checkPayOutAmount(typed: string, held: number, wageSurplus?: number | null): { amount: number } | { error: string } {
    const t = typed.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return { error: 'Enter an amount in Beans, like 40 or 12.50.' };
    const amount = Number(t);
    if (!(amount > 0)) return { error: 'The amount must be more than 0 Beans.' };
    if (Math.round(amount * 100) > heldCents(held)) return { error: `The enterprise holds ${beansHeld(held)} Beans, so it can't pay more than that.` };
    if (typeof wageSurplus === 'number' && Math.round(amount * 100) > heldCents(wageSurplus)) {
        return { error: `${PAY_OUT_WAGE_WORDS}: ${beansHeld(wageSurplus)} Beans now.` };
    }
    return { amount };
}

/** The line under the amount: a pay-out to a keeper is a wage, with the earned surplus it may come out of when known. */
export function wageNoteWords(earnedSurplus: number | null | undefined, lifecycle: string | null | undefined): string {
    const kind = lifecycle === 'bounded' ? 'project' : 'enterprise';
    return typeof earnedSurplus === 'number'
        ? `Paying a keeper is a wage: only out of what the ${kind} has earned above its costs, ${beansHeld(earnedSurplus)} Beans now.`
        : `Paying a keeper is a wage: only out of what the ${kind} has earned.`;
}

/** The effects a keeper may propose here: making another keeper the lead only in an ongoing enterprise (§2.4, pick 1). */
export function scopedEffectsFor(lifecycle: string | null | undefined): ScopedEffect[] {
    return lifecycle === 'bounded' ? ['pay_out', 'remove_keeper'] : ['pay_out', 'remove_keeper', 'replace_lead'];
}

/** The choice's label in the form, in the kind's own words (a project has a leader and collaborators, pick 8). */
export function scopedEffectLabel(effect: ScopedEffect, lifecycle: string | null | undefined): string {
    const project = lifecycle === 'bounded';
    switch (effect) {
        case 'pay_out': return 'Pay Beans out';
        case 'remove_keeper': return project ? 'Remove a collaborator' : 'Remove a keeper';
        case 'replace_lead': return 'Make another keeper the lead';
    }
}

/**
 * Who the pickers offer from the roll, as the node allows (decisions-engine createScopedDecision): never the proposer for
 * a pay-out (a keeper can't vote themselves paid) or a removal (to leave, they step down instead); never the lead for a
 * removal (the lead is replaced, not removed); never the lead as the new lead. A keeper may propose themselves as the new
 * lead, and the keepers vote on it.
 */
export function rollChoices(effect: ScopedEffect, roll: readonly RollPerson[], me: string): RollPerson[] {
    switch (effect) {
        case 'pay_out': return roll.filter(p => p.pubkey !== me);
        case 'remove_keeper': return roll.filter(p => p.role !== 'lead' && p.pubkey !== me);
        case 'replace_lead': return roll.filter(p => p.role !== 'lead');
    }
}

/** What the vote does, in one line, naming the person from the roll (the card is the keepers' own). */
/**
 * The line over a votes-only screen (someone no longer in the group, #1794 N8): "you can still vote" only when a vote
 * still takes theirs. Someone who left mid-vote, or whose votes have all closed, is told only what is true.
 */
export function votesOnlyWords(canVote: boolean): string {
    return canVote
        ? "You're not in this group now, but you were when these votes opened, so you can still vote on them."
        : "You're not in this group now. These are the votes you were part of.";
}

/** Who a group vote names when neither the roster nor the card knows them (an account deleted): never "a former member". */
export const GROUP_SOMEONE = 'someone in the group';

export function scopedEffectWords(d: Pick<ScopedDecisionCard, 'effect' | 'subject' | 'params'>, nameOf: (pubkey: string) => string, lifecycle?: string | null): string {
    const who = d.subject ? nameOf(d.subject) : 'someone';
    switch (d.effect) {
        case 'pay_out': return `Pay ${beansAmount(Number(d.params?.amount) || 0)} Beans to ${who}`;
        case 'remove_keeper': return lifecycle === 'bounded' ? `Remove ${who} as a collaborator` : `Remove ${who} as a keeper`;
        case 'replace_lead': return `Make ${who} the lead keeper`;
        case 'replace_lead_convenor': return `Make ${who} the lead convenor`;
        case 'set_group_role': return d.params?.role === 'convenor' ? `Make ${who} a convenor` : `Make ${who} a member, no longer a convenor`;
        case 'remove_group_member': return `Remove ${who} from the group`;
        case 'set_join_policy': return `Change who can join: ${joinPolicyWords(d.params?.policy)}`;
        case 'close_group': return 'Close the group. Its chat stays to read.';
        default: return 'A vote';
    }
}

/** The tally line: turnout while open, the split once closed (pick 3). */
export function scopedTallyWords(d: Pick<ScopedDecisionCard, 'status' | 'tally'>): string {
    const t = d.tally;
    const turnout = `${t.voted} of ${t.roll} ${t.voted === 1 && t.roll === 1 ? 'has' : 'have'} voted`;
    if (d.status === 'open') return `${turnout}. ${t.quorumRequired} must vote. Yes and No show when it closes.`;
    return `Yes ${t.yes ?? 0} · No ${t.no ?? 0}. ${t.voted} of ${t.roll} voted.`;
}

/** The outcome, in plain words, for a vote that has closed. */
export function scopedOutcomeWords(d: Pick<ScopedDecisionCard, 'status' | 'executionReason'> & { scopeKind?: string }): string {
    switch (d.status) {
        case 'open': return 'Open';
        case 'executed': return 'Passed and carried out';
        case 'passed': case 'passed_queued_for_funds': case 'execution_pending_grace': return 'Passed';
        case 'failed': return 'Did not pass';
        // The node writes "Quorum not met (1/3)" for a vote too few joined: never a member's word (#1784 review N5).
        case 'unresolved': return d.executionReason && !/^Quorum not met/.test(d.executionReason)
            ? d.executionReason
            : (d.scopeKind === 'group' ? 'Not enough people voted' : 'Not enough keepers voted');
        case 'execution_blocked': return `Passed, but not carried out${d.executionReason ? `: ${d.executionReason}` : ''}`;
        case 'execution_void': return `Passed, but there was nothing to do${d.executionReason ? `: ${d.executionReason}` : ''}`;
        default: return 'Closed';
    }
}

/** When it closes, in the reader's own time ("closes in 3 days", "closes in 5 hours", "closes within the hour"). */
export function scopedClosesWords(closesAt: string, now: number): string {
    const ms = Date.parse(closesAt) - now;
    if (!(ms > 0)) return 'closing now';
    const hours = Math.floor(ms / 3600_000);
    if (hours >= 48) return `closes in ${plural(Math.floor(hours / 24), 'day', 'days')}`;
    if (hours >= 1) return `closes in ${plural(hours, 'hour', 'hours')}`;
    return 'closes within the hour';
}

/** The one honest line (§2.5): in a very small roll, early close plus turnout can show the split. */
export const SMALL_ROLL_BALLOT_NOTE = 'Nobody sees who voted how. In a very small group, though, the result and who has voted can show it.';

// ── A chat group's vote (slice S3) ──────────────────────────────────────────────────────────────────────────────

/** Who can join, in the words the group's info uses. */
export function joinPolicyWords(policy: string | null | undefined): string {
    switch (policy) {
        case 'open': return 'anyone can join';
        case 'request_to_join': return 'people ask, and a convenor lets them in';
        case 'invite_only': return 'by invitation only';
        default: return 'a new rule';
    }
}

/**
 * What a group's propose form offers, as six plain choices over the five effects: a role vote is offered as its two
 * directions, so nobody has to pick a person and then a role. Each maps to one effect (and a role, for the two).
 */
export type GroupChoice = 'lead' | 'make_convenor' | 'make_member' | 'remove' | 'join_policy' | 'close';

export const GROUP_CHOICES: readonly GroupChoice[] = ['lead', 'make_convenor', 'make_member', 'remove', 'join_policy', 'close'];

/** The choice's label in the form. */
export function groupChoiceLabel(choice: GroupChoice): string {
    switch (choice) {
        case 'lead': return 'Choose a new lead convenor';
        case 'make_convenor': return 'Make someone a convenor';
        case 'make_member': return 'Make a convenor a member';
        case 'remove': return 'Remove someone';
        case 'join_policy': return 'Change who can join';
        case 'close': return 'Close the group';
    }
}

/** The question above the person picker, or null when the choice names nobody. */
export function groupChoiceWhoWords(choice: GroupChoice): string | null {
    switch (choice) {
        case 'lead': return 'Who should lead?';
        case 'make_convenor': return 'Who should be a convenor?';
        case 'make_member': return 'Which convenor?';
        case 'remove': return 'Remove whom?';
        default: return null;
    }
}

/** A person in the group now, for the pickers: role 'lead' for the lead convenor, 'observer' for one who watches. */
export interface GroupPerson { pubkey: string; name: string; role: string }

/**
 * Who each choice offers, as the node allows (apps/server decisions-engine createGroupDecision): the roll (members and
 * convenors, the lead included; observers watch) for a role or the lead; anyone in the group but the lead and yourself for
 * a removal (to leave, leave). The lead is never offered for a role vote, and never as the new lead.
 */
export function groupChoicePeople(choice: GroupChoice, people: readonly GroupPerson[], me: string): GroupPerson[] {
    switch (choice) {
        case 'lead': return people.filter(p => p.role === 'convenor' || p.role === 'member');
        case 'make_convenor': return people.filter(p => p.role === 'member');
        case 'make_member': return people.filter(p => p.role === 'convenor');
        case 'remove': return people.filter(p => p.role !== 'lead' && p.pubkey !== me);
        default: return [];
    }
}

/** The join policies a vote may change to: every one but the group's own now. */
export function joinPolicyChoices(current: string | null | undefined): GroupJoinPolicy[] {
    return (['open', 'request_to_join', 'invite_only'] as GroupJoinPolicy[]).filter(p => p !== current);
}

/** A join policy's chip in the form. */
export function joinPolicyLabel(policy: GroupJoinPolicy): string {
    switch (policy) {
        case 'open': return 'Open: anyone can join';
        case 'request_to_join': return 'Ask to join';
        case 'invite_only': return 'Invite only';
    }
}

/** What the form sends for a choice (POST /api/groups/:id/decisions), or null while it lacks a person or a policy. */
export function groupProposal(choice: GroupChoice, who: string | null, policy: GroupJoinPolicy | null):
    { effect: GroupEffect; subject?: string; params?: { role?: 'convenor' | 'member'; policy?: GroupJoinPolicy } } | null {
    switch (choice) {
        case 'lead': return who ? { effect: 'replace_lead_convenor', subject: who } : null;
        case 'make_convenor': return who ? { effect: 'set_group_role', subject: who, params: { role: 'convenor' } } : null;
        case 'make_member': return who ? { effect: 'set_group_role', subject: who, params: { role: 'member' } } : null;
        case 'remove': return who ? { effect: 'remove_group_member', subject: who } : null;
        case 'join_policy': return policy ? { effect: 'set_join_policy', params: { policy } } : null;
        case 'close': return { effect: 'close_group' };
    }
}

/** The line on a closed group's info, the words the group's chat took when it closed (decisions-engine GROUP_CLOSED_LINE). */
export const GROUP_CLOSED_NOTE = 'The group was closed by its members’ vote. Its chat stays to read.';

/** The block's note under DECISIONS, for a group. */
export const GROUP_DECISIONS_NOTE = "Votes among the group's members and convenors; observers watch. More than half must vote. 7 days, or sooner once the answer can't change.";

/** The choices worth offering: one that names a person only when somebody can be named. */
export function groupChoicesFor(people: readonly GroupPerson[], me: string): GroupChoice[] {
    return GROUP_CHOICES.filter(c => c === 'join_policy' || c === 'close' || groupChoicePeople(c, people, me).length > 0);
}
