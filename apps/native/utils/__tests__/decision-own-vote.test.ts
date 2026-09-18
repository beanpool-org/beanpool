import { describe, it, expect } from 'vitest';
import { ownVoteSummary, startingVoteCount, voteButtonStates, type OwnDecisionVote } from '../decision-own-vote';

const vote = (support: boolean, voteCount = 1): OwnDecisionVote => ({
    support, voteCount, creditsUsed: voteCount * voteCount, updatedAt: '2026-09-19T00:00:00.000Z',
});

describe('own vote on a Decision card', () => {
    it('says nothing before voting, and the buttons read as a first vote', () => {
        expect(ownVoteSummary(null, false)).toBeNull();
        expect(voteButtonStates(null, false, 1)).toEqual({
            yes: { label: 'Vote YES', disabled: false },
            no: { label: 'Vote NO', disabled: false },
        });
    });

    it('one member one vote: shows the side and offers to change it', () => {
        expect(ownVoteSummary(vote(true), false)).toBe('You voted Yes');
        expect(voteButtonStates(vote(true), false, 1)).toEqual({
            yes: { label: 'Voted Yes', disabled: true },
            no: { label: 'Change to No', disabled: false },
        });
    });

    it('quadratic: shows the vote count, and a new count on the same side is a change', () => {
        expect(ownVoteSummary(vote(false, 3), true)).toBe('You voted No (3 votes)');
        expect(ownVoteSummary(vote(true, 1), true)).toBe('You voted Yes (1 vote)');
        expect(voteButtonStates(vote(false, 3), true, 3)).toEqual({
            yes: { label: 'Change to Yes', disabled: false },
            no: { label: 'Voted No', disabled: true },
        });
        expect(voteButtonStates(vote(false, 3), true, 2).no).toEqual({ label: 'Change to 2 votes', disabled: false });
    });

    it('the stepper starts from the current vote until the member picks another count', () => {
        expect(startingVoteCount(undefined, null)).toBe(1);
        expect(startingVoteCount(undefined, vote(true, 4))).toBe(4);
        expect(startingVoteCount(2, vote(true, 4))).toBe(2);
    });
});
