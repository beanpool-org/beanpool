/**
 * Plain-language lines for a Decision card, in the member's language. Kept apart from the component so the wording is
 * tested once.
 */

import { formatDate, t, tn, word } from '@beanpool/core';
import type { DecisionTally, MyPoolVoting } from './api';

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
