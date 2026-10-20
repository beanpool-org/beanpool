/**
 * What a Decision card says about the member's own vote, and how its vote buttons read.
 * The server returns `myVote` for the signed caller only (null when they haven't voted). Every line whole, in the
 * member's language.
 */
import { t, tn } from '@beanpool/core';

export interface OwnDecisionVote {
    support: boolean;
    /** 1 for one-member-one-vote; the chosen count on a quadratic pool Decision. */
    voteCount: number;
    creditsUsed: number;
    updatedAt: string;
}

export interface VoteButtonState {
    label: string;
    /** True when pressing would re-cast the vote the member already has. */
    disabled: boolean;
}

/** "You voted Yes", or "You voted No (3 votes)" on a quadratic Decision; null before voting. */
export function ownVoteSummary(myVote: OwnDecisionVote | null | undefined, quadratic: boolean): string | null {
    if (!myVote) return null;
    if (!quadratic) return myVote.support ? t('You voted Yes') : t('You voted No');
    return myVote.support
        ? tn(myVote.voteCount, 'You voted Yes ({n} vote)', 'You voted Yes ({n} votes)')
        : tn(myVote.voteCount, 'You voted No ({n} vote)', 'You voted No ({n} votes)');
}

/** The vote count a quadratic stepper starts from: the member's pick, else their current vote, else 1. */
export function startingVoteCount(selected: number | undefined, myVote: OwnDecisionVote | null | undefined): number {
    return selected ?? myVote?.voteCount ?? 1;
}

/** Voting again replaces the earlier vote, so once a member has voted the buttons read as changing it. */
export function voteButtonStates(
    myVote: OwnDecisionVote | null | undefined,
    quadratic: boolean,
    selectedCount: number,
): { yes: VoteButtonState; no: VoteButtonState } {
    const state = (support: boolean): VoteButtonState => {
        if (!myVote) return { label: support ? t('Vote YES') : t('Vote NO'), disabled: false };
        if (myVote.support !== support) return { label: support ? t('Change to Yes') : t('Change to No'), disabled: false };
        if (quadratic && selectedCount !== myVote.voteCount) {
            return { label: tn(selectedCount, 'Change to {n} vote', 'Change to {n} votes'), disabled: false };
        }
        return { label: support ? t('Voted Yes') : t('Voted No'), disabled: true };
    };
    return { yes: state(true), no: state(false) };
}
