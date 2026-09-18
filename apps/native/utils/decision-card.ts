/**
 * Plain-language lines for a Decision card. Kept apart from the component so the wording is tested once.
 */

import type { DecisionTally, MyPoolVoting } from './db';

/** Word for word what the node answers; the card shows it before the member tries. */
export const NO_TRADE_POOL_VOTE_MESSAGE = 'Voting on community money opens after your first completed trade.';

/** "4 of 6 votes needed" — turnout counts people, not vote weight. */
export function turnoutLine(tally: Pick<DecisionTally, 'totalVoters' | 'quorumRequired'>): string {
    return `${tally.totalVoters} of ${tally.quorumRequired} votes needed`;
}

/**
 * Who the turnout is measured against (answer K): the members who could vote on this Decision and were
 * active in the last 30 days. Never fewer than 3 votes.
 */
export function electorateLine(tally: Pick<DecisionTally, 'electorate' | 'quorumRatio' | 'quorumRequired'>): string {
    const pct = Math.round((tally.quorumRatio ?? 0.3) * 100);
    const electorate = tally.electorate ?? 0;
    const floor = Math.ceil((tally.quorumRatio ?? 0.3) * electorate) < tally.quorumRequired ? ' (at least 3)' : '';
    return `${pct}% of ${electorate} ${electorate === 1 ? 'member' : 'members'} active in the last 30 days${floor}`;
}

/** The emergency-suspension card's question (answer L). */
export function keepSuspensionHeadline(params: { memberName?: string; suspendedAt?: string } | null | undefined, fallbackName: string): string {
    const name = params?.memberName || fallbackName;
    const t = params?.suspendedAt ? Date.parse(params.suspendedAt) : NaN;
    const on = Number.isFinite(t) ? ` on ${new Date(t).toLocaleDateString()}` : '';
    return `An admin suspended ${name}${on}. Keep the suspension?`;
}

/**
 * What a member can do on a vote about community money (answer H), known before they try: null when they
 * can vote, otherwise the sentence the node would answer with.
 */
export function poolVoteBlocker(myPoolVoting: MyPoolVoting | null | undefined): string | null {
    if (myPoolVoting && !myPoolVoting.hasCompletedTrade && myPoolVoting.voiceCredits <= 0) return NO_TRADE_POOL_VOTE_MESSAGE;
    return null;
}

/** "You have 16 voice credits: up to 4 votes on this Decision." */
export function voiceCreditsLine(myPoolVoting: MyPoolVoting | null | undefined): string | null {
    if (!myPoolVoting || myPoolVoting.voiceCredits <= 0) return null;
    const credits = Math.floor(myPoolVoting.voiceCredits);
    const maxVotes = Math.floor(Math.sqrt(credits));
    return `You have ${credits} voice ${credits === 1 ? 'credit' : 'credits'}: up to ${maxVotes} ${maxVotes === 1 ? 'vote' : 'votes'} on this Decision.`;
}
