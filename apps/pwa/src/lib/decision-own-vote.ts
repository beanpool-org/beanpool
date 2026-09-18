/**
 * What a Decision card says about the member's own vote, and how its vote buttons read.
 * The server returns `myVote` for the signed caller only (null when they haven't voted).
 */
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

const votesWord = (n: number) => `${n} ${n === 1 ? 'vote' : 'votes'}`;

/** "You voted Yes", or "You voted No (3 votes)" on a quadratic Decision; null before voting. */
export function ownVoteSummary(myVote: OwnDecisionVote | null | undefined, quadratic: boolean): string | null {
    if (!myVote) return null;
    const side = myVote.support ? 'Yes' : 'No';
    return quadratic ? `You voted ${side} (${votesWord(myVote.voteCount)})` : `You voted ${side}`;
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
        const side = support ? 'Yes' : 'No';
        if (!myVote) return { label: `Vote ${side.toUpperCase()}`, disabled: false };
        if (myVote.support !== support) return { label: `Change to ${side}`, disabled: false };
        if (quadratic && selectedCount !== myVote.voteCount) {
            return { label: `Change to ${votesWord(selectedCount)}`, disabled: false };
        }
        return { label: `Voted ${side}`, disabled: true };
    };
    return { yes: state(true), no: state(false) };
}
