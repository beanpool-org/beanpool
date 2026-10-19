/**
 * An enterprise's keepers' vote, and a chat group's members' vote, as both apps show them (DESIGN-group-decisions §2.3–§2.5,
 * slices S2 and S3): the card's words, its two tally states, and the propose form's checks. Pure, so the apps share one copy and one test
 * (src/__tests__/scoped-decision.test.ts). The node is the judge (apps/server decisions-engine createScopedDecision): these
 * checks only keep a member from sending what it would refuse.
 *
 * While a vote is open the card shows turnout only ("2 of 4 have voted"); Yes and No once it has closed (Marty's pick 3,
 * 2026-10-10). A pay-out carries the 1.5% trade fee (pick 2): it comes out of the amount, as a Need's payment's does.
 *
 * The words are in the member's language (core's t / tn; the constants are word() keys, translated where shown). What
 * members wrote (a vote's title and why) and the node's own words (an execution reason) are shown as written.
 */
import { TRANSACTION_FEE_RATE } from './ledger.js';
import { t, tn, word } from './words.js';

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

/** Beans to two places at most, never a trailing ".00" ("40", "39.4", "0.6"). */
export function beansAmount(n: number): string {
    const cents = Math.round(n * 100);
    return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace(/0$/, '');
}

/** beansAmount as a number, for a sentence: t() writes it with the language's decimal sign ("39,4" in fr). */
const beansNumber = (n: number): number => Number(beansAmount(n));

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
    const n = beansNumber(receives);
    return tn(n, '{name} receives {n} Beans. The 1.5% trade fee ({fee} Beans) goes to the Commons.', '{name} receives {n} Beans. The 1.5% trade fee ({fee} Beans) goes to the Commons.', { name: recipient, fee: beansNumber(fee) });
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
    const asTyped = typed.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(asTyped)) return { error: t('Enter an amount in Beans, like 40 or 12.50.') };
    const amount = Number(asTyped);
    if (!(amount > 0)) return { error: t('The amount must be more than 0 Beans.') };
    if (Math.round(amount * 100) > heldCents(held)) {
        const n = Number(beansHeld(held));
        return { error: tn(n, "The enterprise holds {n} Beans, so it can't pay more than that.", "The enterprise holds {n} Beans, so it can't pay more than that.") };
    }
    if (typeof wageSurplus === 'number' && Math.round(amount * 100) > heldCents(wageSurplus)) {
        // PAY_OUT_WAGE_WORDS, then what the surplus is now: one sentence.
        const n = Number(beansHeld(wageSurplus));
        return { error: tn(n, 'Paying a keeper is a wage, and a wage comes only out of what the enterprise has earned above its costs (its earned surplus): {n} Beans now.', 'Paying a keeper is a wage, and a wage comes only out of what the enterprise has earned above its costs (its earned surplus): {n} Beans now.') };
    }
    return { amount };
}

/** The line under the amount: a pay-out to a keeper is a wage, with the earned surplus it may come out of when known. */
export function wageNoteWords(earnedSurplus: number | null | undefined, lifecycle: string | null | undefined): string {
    const project = lifecycle === 'bounded';
    if (typeof earnedSurplus !== 'number') {
        return project
            ? t('Paying a keeper is a wage: only out of what the project has earned.')
            : t('Paying a keeper is a wage: only out of what the enterprise has earned.');
    }
    const n = Number(beansHeld(earnedSurplus));
    return project
        ? tn(n, 'Paying a keeper is a wage: only out of what the project has earned above its costs, {n} Beans now.', 'Paying a keeper is a wage: only out of what the project has earned above its costs, {n} Beans now.')
        : tn(n, 'Paying a keeper is a wage: only out of what the enterprise has earned above its costs, {n} Beans now.', 'Paying a keeper is a wage: only out of what the enterprise has earned above its costs, {n} Beans now.');
}

/** The effects a keeper may propose here: making another keeper the lead only in an ongoing enterprise (§2.4, pick 1). */
export function scopedEffectsFor(lifecycle: string | null | undefined): ScopedEffect[] {
    return lifecycle === 'bounded' ? ['pay_out', 'remove_keeper'] : ['pay_out', 'remove_keeper', 'replace_lead'];
}

/** The choice's label in the form, in the kind's own words (a project has a leader and collaborators, pick 8). */
export function scopedEffectLabel(effect: ScopedEffect, lifecycle: string | null | undefined): string {
    const project = lifecycle === 'bounded';
    switch (effect) {
        case 'pay_out': return t('Pay Beans out');
        case 'remove_keeper': return project ? t('Remove a collaborator') : t('Remove a keeper');
        case 'replace_lead': return t('Make another keeper the lead');
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

/**
 * The line over a votes-only screen (someone no longer in the group, #1794 N8): "you can still vote" only when a vote
 * still takes theirs. Someone who left mid-vote, or whose votes have all closed, is told only what is true.
 */
export function votesOnlyWords(canVote: boolean): string {
    return canVote
        ? t("You're not in this group now, but you were when these votes opened, so you can still vote on them.")
        : t("You're not in this group now. These are the votes you were part of.");
}

/**
 * Who a group vote names when neither the roster nor the card knows them (an account deleted): never "a former member".
 * Marked here, translated where it is shown.
 */
export const GROUP_SOMEONE = word('someone in the group');

/** What the vote does, in one line, naming the person from the roll (the card is the keepers' own). */
export function scopedEffectWords(d: Pick<ScopedDecisionCard, 'effect' | 'subject' | 'params'>, nameOf: (pubkey: string) => string, lifecycle?: string | null): string {
    const name = d.subject ? nameOf(d.subject) : t('someone');
    switch (d.effect) {
        case 'pay_out': {
            const n = beansNumber(Number(d.params?.amount) || 0);
            return tn(n, 'Pay {n} Beans to {name}', 'Pay {n} Beans to {name}', { name });
        }
        case 'remove_keeper': return lifecycle === 'bounded' ? t('Remove {name} as a collaborator', { name }) : t('Remove {name} as a keeper', { name });
        case 'replace_lead': return lifecycle === 'bounded' ? t('Make {name} the leader', { name }) : t('Make {name} the lead keeper', { name });
        case 'replace_lead_convenor': return t('Make {name} the lead convenor', { name });
        case 'set_group_role': return d.params?.role === 'convenor' ? t('Make {name} a convenor', { name }) : t('Make {name} a member, no longer a convenor', { name });
        case 'remove_group_member': return t('Remove {name} from the group', { name });
        case 'set_join_policy': return t('Change who can join: {policy}', { policy: joinPolicyWords(d.params?.policy) });
        case 'close_group': return t('Close the group. Its chat stays to read.');
        default: return t('A vote');
    }
}

/** The tally line: turnout while open, the split once closed (pick 3). */
export function scopedTallyWords(d: Pick<ScopedDecisionCard, 'status' | 'tally'>): string {
    const tally = d.tally;
    if (d.status === 'open') {
        const values = { roll: tally.roll, quorum: tally.quorumRequired };
        // English says "has" only for one of one; otherwise the count of those who voted takes the plural.
        return tally.voted === 1 && tally.roll === 1
            ? t('{voted} of {roll} has voted. {quorum} must vote. Yes and No show when it closes.', { voted: tally.voted, ...values })
            : tn(tally.voted, '{n} of {roll} have voted. {quorum} must vote. Yes and No show when it closes.', '{n} of {roll} have voted. {quorum} must vote. Yes and No show when it closes.', values);
    }
    return t('Yes {yes} · No {no}. {voted} of {roll} voted.', { yes: tally.yes ?? 0, no: tally.no ?? 0, voted: tally.voted, roll: tally.roll });
}

/** The outcome, in plain words, for a vote that has closed. The node's own reason is shown as it wrote it. */
export function scopedOutcomeWords(d: Pick<ScopedDecisionCard, 'status' | 'executionReason'> & { scopeKind?: string }): string {
    const reason = d.executionReason;
    switch (d.status) {
        case 'open': return t('Open', undefined, 'a vote');
        case 'executed': return t('Passed and carried out');
        case 'passed': case 'passed_queued_for_funds': case 'execution_pending_grace': return t('Passed');
        case 'failed': return t('Did not pass');
        // The node writes "Quorum not met (1/3)" for a vote too few joined: never a member's word (#1784 review N5).
        case 'unresolved': return reason && !/^Quorum not met/.test(reason)
            ? reason
            : (d.scopeKind === 'group' ? t('Not enough people voted') : t('Not enough keepers voted'));
        case 'execution_blocked': return reason ? t('Passed, but not carried out: {reason}', { reason }) : t('Passed, but not carried out');
        case 'execution_void': return reason ? t('Passed, but there was nothing to do: {reason}', { reason }) : t('Passed, but there was nothing to do');
        default: return t('Closed', undefined, 'a vote');
    }
}

/** When it closes, in the reader's own time ("closes in 3 days", "closes in 5 hours", "closes within the hour"). */
export function scopedClosesWords(closesAt: string, now: number): string {
    const ms = Date.parse(closesAt) - now;
    if (!(ms > 0)) return t('closing now');
    const hours = Math.floor(ms / 3600_000);
    if (hours >= 48) return tn(Math.floor(hours / 24), 'closes in {n} day', 'closes in {n} days');
    if (hours >= 1) return tn(hours, 'closes in {n} hour', 'closes in {n} hours');
    return t('closes within the hour');
}

/** The one honest line (§2.5): in a very small roll, early close plus turnout can show the split. Translated where shown. */
export const SMALL_ROLL_BALLOT_NOTE = word('Nobody sees who voted how. In a very small group, though, the result and who has voted can show it.');

// ── A chat group's vote (slice S3) ──────────────────────────────────────────────────────────────────────────────

/** Who can join, in the words the group's info uses. */
export function joinPolicyWords(policy: string | null | undefined): string {
    switch (policy) {
        case 'open': return t('anyone can join');
        case 'request_to_join': return t('people ask, and a convenor lets them in');
        case 'invite_only': return t('by invitation only');
        default: return t('a new rule');
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
        case 'lead': return t('Choose a new lead convenor');
        case 'make_convenor': return t('Make someone a convenor');
        case 'make_member': return t('Make a convenor a member');
        case 'remove': return t('Remove someone');
        case 'join_policy': return t('Change who can join');
        case 'close': return t('Close the group');
    }
}

/** The question above the person picker, or null when the choice names nobody. */
export function groupChoiceWhoWords(choice: GroupChoice): string | null {
    switch (choice) {
        case 'lead': return t('Who should lead?');
        case 'make_convenor': return t('Who should be a convenor?');
        case 'make_member': return t('Which convenor?');
        case 'remove': return t('Remove whom?');
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
        case 'open': return t('Open: anyone can join');
        case 'request_to_join': return t('Ask to join');
        case 'invite_only': return t('Invite only');
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

/**
 * The line on a closed group's info, the words the group's chat took when it closed (decisions-engine GROUP_CLOSED_LINE).
 * Marked here, translated where it is shown.
 */
export const GROUP_CLOSED_NOTE = word('The group was closed by its members’ vote. Its chat stays to read.');

/** The block's note under DECISIONS, for a group. Translated where it is shown. */
export const GROUP_DECISIONS_NOTE = word("Votes among the group's members and convenors; observers watch. More than half must vote. 7 days, or sooner once the answer can't change.");

/** The choices worth offering: one that names a person only when somebody can be named. */
export function groupChoicesFor(people: readonly GroupPerson[], me: string): GroupChoice[] {
    return GROUP_CHOICES.filter(c => c === 'join_policy' || c === 'close' || groupChoicePeople(c, people, me).length > 0);
}
