/**
 * Plain-language lines for a Decision card, in the member's language. Kept apart from the component so the wording is
 * tested once.
 */

import { formatDate, t, tn, word } from '@beanpool/core';
import type { DecisionTally, MyPoolVoting, RemovalProposer } from './api';

/** The card's sentences that are also the node's own answers: word() keys, shown through t(). */
export const DECISION_CARD_WORDS = {
    noTradePoolVote: word('Voting on community money opens after your first completed trade.'),
} as const;

/**
 * Word for word what the node answers; the card shows it before the member tries (in the member's language), and the
 * vote's refusal, when it is this sentence, is shown the same way.
 */
export const NO_TRADE_POOL_VOTE_MESSAGE: string = DECISION_CARD_WORDS.noTradePoolVote;

/** "4 of 6 votes needed" — turnout counts people, not vote weight. */
export function turnoutLine(tally: Pick<DecisionTally, 'totalVoters' | 'quorumRequired'>): string {
    return tn(tally.quorumRequired, '{voters} of {n} vote needed', '{voters} of {n} votes needed', { voters: tally.totalVoters });
}

/**
 * Who the turnout is measured against (answer K): the members who could vote on this Decision and were
 * active in the last 30 days. Never fewer than 3 votes.
 */
export function electorateLine(tally: Pick<DecisionTally, 'electorate' | 'quorumRatio' | 'quorumRequired'>): string {
    const pct = Math.round((tally.quorumRatio ?? 0.3) * 100);
    const electorate = tally.electorate ?? 0;
    const floor = Math.ceil((tally.quorumRatio ?? 0.3) * electorate) < tally.quorumRequired;
    return floor
        ? tn(electorate, '{pct}% of {n} member active in the last 30 days (at least 3)', '{pct}% of {n} members active in the last 30 days (at least 3)', { pct })
        : tn(electorate, '{pct}% of {n} member active in the last 30 days', '{pct}% of {n} members active in the last 30 days', { pct });
}

/** The emergency-suspension card's question (answer L), its date through core's formatDate ("19 Sep 2026"). */
export function keepSuspensionHeadline(params: { memberName?: string; suspendedAt?: string } | null | undefined, fallbackName: string): string {
    const name = params?.memberName || fallbackName;
    const at = params?.suspendedAt ? Date.parse(params.suspendedAt) : NaN;
    return Number.isFinite(at)
        ? t('An admin suspended {name} on {date}. Keep the suspension?', { name, date: formatDate(new Date(at), 'day-month-year') })
        : t('An admin suspended {name}. Keep the suspension?', { name });
}

/**
 * A pause's own vote (removal by vote S2): the community's vote on removing a member, which the node opened when an admin
 * paused them. Its author is the node and its params carry `rule: 2`; a removal a member proposes is never one (the node
 * keeps those marks out of a proposal).
 */
export function isPauseVote(decision: { effect: string; authorPubkey?: string; params?: any }): boolean {
    return decision.effect === 'remove_member' && decision.authorPubkey === 'SYSTEM' && decision.params?.rule === 2;
}

/**
 * A vote on removing the reader themself, a pause's or one a member proposed: nobody votes on their own removal (the node
 * refuses it, removal by vote S2), so the card says so instead of offering the vote.
 */
export function isOwnRemoval(decision: { effect: string; subject?: string | null }, me: string | null | undefined): boolean {
    return decision.effect === 'remove_member' && !!me && decision.subject === me;
}

/**
 * The pause vote card's first line: who paused whom, and when (core's formatDate, "22 Oct 2026"). The admin who paused is
 * named (removal by vote, Amendment A point 3: the node sends `proposer`); an owner who paused with the server's password
 * is named as an owner, since the password names nobody; a node from before names no one, as before.
 */
export function pauseVoteHeadline(params: { memberName?: string; pausedAt?: string; secondPause?: unknown } | null | undefined, fallbackName: string, proposer?: RemovalProposer | null): string {
    const name = params?.memberName || fallbackName;
    const at = params?.pausedAt ? Date.parse(params.pausedAt) : NaN;
    const date = Number.isFinite(at) ? formatDate(new Date(at), 'day-month-year') : null;
    const isOwner = Boolean(params?.secondPause || proposer?.kind === 'owner');
    if (isOwner) {
        if (proposer?.name) {
            return date
                ? t('{admin}, an owner, paused {name} on {date}.', { admin: proposer.name, name, date })
                : t('{admin}, an owner, paused {name}.', { admin: proposer.name, name });
        }
        if (proposer?.kind === 'password') {
            return date
                ? t("An owner paused {name} on {date}, signed in with the server's password.", { name, date })
                : t("An owner paused {name}, signed in with the server's password.", { name });
        }
        return date ? t('An owner paused {name} on {date}.', { name, date }) : t('An owner paused {name}.', { name });
    }
    if (proposer?.kind === 'admin' && proposer.name) {
        return date
            ? t('{admin}, an admin, paused {name} on {date}.', { admin: proposer.name, name, date })
            : t('{admin}, an admin, paused {name}.', { admin: proposer.name, name });
    }
    if (proposer?.kind === 'password') {
        return date
            ? t("An owner paused {name} on {date}, signed in with the server's password.", { name, date })
            : t("An owner paused {name}, signed in with the server's password.", { name });
    }
    return date ? t('An admin paused {name} on {date}.', { name, date }) : t('An admin paused {name}.', { name });
}

/**
 * A pause made again within 30 days of a vote that ended without removing the member (removal by vote S4, design §3.4:
 * only an owner may, with a new reason): the node records how that vote ended (`params.secondPause`), and the card says so.
 * Null for any other card.
 */
export function secondPauseLine(params: { secondPause?: { after?: string } | null } | null | undefined): string | null {
    const after = params?.secondPause?.after;
    if (after === 'no') return t('Second pause in 30 days. The last vote said No.');
    if (after === 'too_few') return t('Second pause in 30 days. Too few members voted on the last one.');
    if (after === 'stopped') return t('Second pause in 30 days. The last vote was stopped before it closed.');
    return null;
}

/**
 * Who proposed a removal a member proposed, before proposing one closed (Amendment A point 3), or null for any other card:
 * a pause's own vote names its admin in its headline instead.
 */
export function proposedByLine(decision: { effect: string; proposer?: RemovalProposer | null }): string | null {
    if (decision.effect !== 'remove_member' || decision.proposer?.kind !== 'member') return null;
    return decision.proposer.name ? t('Proposed by {name}.', { name: decision.proposer.name }) : t('Proposed by a member who has since left.');
}

/** Over the member's reply to the case (Amendment A point 2): "Dave's reply", and to Dave himself "Your reply". */
export function replyHeading(params: { memberName?: string } | null | undefined, fallbackName: string, mine: boolean): string {
    return mine ? t('Your reply') : t("{name}'s reply", { name: params?.memberName || fallbackName });
}

/** In place of a case an admin hid as shown to be false (Amendment A point 4), with their public reason. */
export function caseHiddenLine(reason: string | null | undefined): string {
    return reason
        ? t('An admin hid the case for this vote, as one shown to be false. Their reason: {reason}', { reason })
        : t('An admin hid the case for this vote, as one shown to be false.');
}

/**
 * In place of a reply an admin took down (the deciding review of #2585), with their public reason: "{name}'s reply", and to
 * the member themself "your reply". The reply itself is gone from the node.
 */
export function replyTakenDownLine(
    params: { memberName?: string } | null | undefined, fallbackName: string, mine: boolean, reason: string | null | undefined,
): string {
    if (mine) return reason ? t('An admin took down your reply. Their reason: {reason}', { reason }) : t('An admin took down your reply.');
    const name = params?.memberName || fallbackName;
    return reason
        ? t("An admin took down {name}'s reply. Their reason: {reason}", { name, reason })
        : t("An admin took down {name}'s reply.", { name });
}

/**
 * Under a removal's threshold (removal by vote S6, design §5 point 1): at least this many Yes votes remove anyone, whatever
 * the share. Null for any other card, and from a node from before (it sends no `minYes`).
 */
export function minYesLine(tally: Pick<DecisionTally, 'minYes'> | null | undefined): string | null {
    if (!tally?.minYes) return null;
    return t('Removing a member also needs at least {n} Yes votes.', { n: tally.minYes });
}

/**
 * The owner's part in a pause's vote too few could vote on (removal by vote S6, design §5 point 3), in the design's words:
 * while it is open and nobody has decided, that the owner decides when it closes if nobody else votes; once an owner has
 * decided, what happens at the close unless more members vote, with the owner's public reason, and once more can vote, that
 * the vote decides (the owner's decision would stand again only if too few could vote at the close, when this line says so
 * again); once it closed with the owner's decision carried out, that the owner decided it. Null for any other card. A vote
 * on someone who holds a server role says nothing of it: no vote, and no owner, removes them (pauseVoteBody says so). Once an
 * admin has hidden the case the node leaves the owner's reason off, since it may repeat the accusation, and the line says the
 * rest without it; and no owner can decide after that, so left too few the member is back when the vote closes.
 */
export function ownerDecisionLine(
    decision: { status: string; params?: { memberName?: string; serverRole?: string } | null; caseHiddenAt?: string | null; ownerDecidedAt?: string | null; ownerDecidedReason?: string | null; ownerDecisionCarriedAt?: string | null },
    tally: Pick<DecisionTally, 'tooFewToVote'> | null | undefined,
    fallbackName: string,
): string | null {
    const reason = decision.ownerDecidedReason;
    if (decision.ownerDecisionCarriedAt) {
        return reason
            ? t('Decided by the owner: too few members to vote. Their reason: {reason}', { reason })
            : t('Decided by the owner: too few members to vote.');
    }
    if (decision.status !== 'open' || decision.params?.serverRole) return null;
    const name = decision.params?.memberName || fallbackName;
    if (!tally?.tooFewToVote) {
        if (!decision.ownerDecidedAt) return null;
        return reason
            ? t('An owner decided when too few members could vote, but enough can now, so this vote decides. Their reason: {reason}', { reason })
            : t('An owner decided when too few members could vote, but enough can now, so this vote decides.');
    }
    if (decision.ownerDecidedAt) {
        return reason
            ? t('Too few members can vote, so an owner decided: unless more of them vote, {name} is removed when this vote closes. Their reason: {reason}', { name, reason })
            : t('Too few members can vote, so an owner decided: unless more of them vote, {name} is removed when this vote closes.', { name });
    }
    return decision.caseHiddenAt
        ? t('Too few members can vote, so unless more of them vote, {name} is back when this vote closes.', { name })
        : t('Fewer than 3 members could vote. If nobody else votes, the owner decides when it closes.');
}

/**
 * What each answer does (design §8.2): Yes removes them after the 7-day grace window, No brings them back when the vote
 * closes. No vote removes someone who holds an owner or admin role (§3.8): then the pause ends with the vote, whatever it says.
 * While too few can vote neither answer does that: the quorum can't be met, and an owner's decision would stand against
 * every vote cast. So the card says nothing of the answers then, and ownerDecisionLine says what happens.
 */
export function pauseVoteBody(
    params: { memberName?: string; serverRole?: string } | null | undefined,
    fallbackName: string,
    tally?: Pick<DecisionTally, 'tooFewToVote'> | null,
): string | null {
    const name = params?.memberName || fallbackName;
    if (params?.serverRole) {
        return t("{name} holds a role that runs this community's server, and no community vote removes an owner or admin: whatever this vote decides, {name} is back when it closes.", { name });
    }
    return tally?.tooFewToVote ? null : t('Yes removes {name} after 7 days. No brings {name} back as soon as the vote closes.', { name });
}

/**
 * Why a vote that closed as failed did nothing, beside its numbers: too few voted, or its share fell short, or on a removal
 * (the node's `minYes`) only the Yes floor stopped it (design §5 point 1). A removal that passed and was then cancelled in
 * its grace window by a vote to reinstate the member failed too, and says so: its numbers still show a vote that passed.
 */
export function notExecutedLine(
    tally: Pick<DecisionTally, 'quorumMet' | 'passed' | 'minYes' | 'yesWeight' | 'noWeight' | 'supportRatio' | 'thresholdRequired'>,
): string {
    if (!tally.quorumMet) return t('Not executed: Quorum not reached');
    if (tally.minYes) {
        if (tally.passed) return t('Not executed: a reinstatement vote cancelled it');
        if (tally.yesWeight < tally.minYes && tally.supportRatio >= tally.thresholdRequired && tally.yesWeight > tally.noWeight) {
            return t('Not executed: fewer than {n} Yes votes', { n: tally.minYes });
        }
    }
    return t('Not executed: Threshold not met');
}

/**
 * What a member can do on a vote about community money (answer H), known before they try: null when they
 * can vote, otherwise the sentence the node would answer with.
 */
export function poolVoteBlocker(myPoolVoting: MyPoolVoting | null | undefined): string | null {
    if (myPoolVoting && !myPoolVoting.hasCompletedTrade && myPoolVoting.voiceCredits <= 0) return t(DECISION_CARD_WORDS.noTradePoolVote);
    return null;
}

/** "You have 16 voice credits: up to 4 votes on this Decision." */
export function voiceCreditsLine(myPoolVoting: MyPoolVoting | null | undefined): string | null {
    if (!myPoolVoting || myPoolVoting.voiceCredits <= 0) return null;
    const credits = Math.floor(myPoolVoting.voiceCredits);
    const maxVotes = Math.floor(Math.sqrt(credits));
    // Two counts in one sentence: each takes its own plural.
    return t('You have {credits}: up to {votes} on this Decision.', {
        credits: tn(credits, '{n} voice credit', '{n} voice credits'),
        votes: tn(maxVotes, '{n} vote', '{n} votes'),
    });
}
