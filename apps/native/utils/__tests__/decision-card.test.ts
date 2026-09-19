import { describe, it, expect } from 'vitest';
import {
    NO_TRADE_POOL_VOTE_MESSAGE,
    electorateLine,
    keepSuspensionHeadline,
    poolVoteBlocker,
    turnoutLine,
    voiceCreditsLine,
} from '../decision-card';

describe('Decision card wording (native)', () => {
    it('turnout counts people against the members active in the last 30 days (K)', () => {
        expect(turnoutLine({ totalVoters: 4, quorumRequired: 6 })).toBe('4 of 6 votes needed');
        expect(electorateLine({ electorate: 20, quorumRatio: 0.3, quorumRequired: 6 })).toBe('30% of 20 members active in the last 30 days');
        expect(electorateLine({ electorate: 20, quorumRatio: 0.25, quorumRequired: 5 })).toBe('25% of 20 members active in the last 30 days');
        expect(electorateLine({ electorate: 4, quorumRatio: 0.3, quorumRequired: 3 })).toBe('30% of 4 members active in the last 30 days (at least 3)');
    });

    it('a member with no completed trade is told before they try, in the node\'s words (H)', () => {
        expect(NO_TRADE_POOL_VOTE_MESSAGE).toBe('Voting on community money opens after your first completed trade.');
        expect(poolVoteBlocker({ voiceCredits: 0, hasCompletedTrade: false })).toBe(NO_TRADE_POOL_VOTE_MESSAGE);
        expect(poolVoteBlocker({ voiceCredits: 16, hasCompletedTrade: true })).toBeNull();
        expect(poolVoteBlocker(null)).toBeNull();
    });

    it('shows the voice credits the node checks and what they buy (H)', () => {
        expect(voiceCreditsLine({ voiceCredits: 16.4, hasCompletedTrade: true })).toBe('You have 16 voice credits: up to 4 votes on this Decision.');
        expect(voiceCreditsLine({ voiceCredits: 1, hasCompletedTrade: true })).toBe('You have 1 voice credit: up to 1 vote on this Decision.');
        expect(voiceCreditsLine({ voiceCredits: 0, hasCompletedTrade: false })).toBeNull();
    });

    it('explains an emergency suspension vote (L)', () => {
        const at = '2026-09-19T10:00:00.000Z';
        expect(keepSuspensionHeadline({ memberName: 'Dave', suspendedAt: at }, 'abc'))
            .toBe(`An admin suspended Dave on ${new Date(at).toLocaleDateString()}. Keep the suspension?`);
        expect(keepSuspensionHeadline(null, 'abcd1234')).toBe('An admin suspended abcd1234. Keep the suspension?');
    });
});
