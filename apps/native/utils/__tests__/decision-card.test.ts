import { describe, it, expect } from 'vitest';
import {
    NO_TRADE_POOL_VOTE_MESSAGE,
    caseHiddenLine,
    electorateLine,
    isPauseVote,
    keepSuspensionHeadline,
    pauseVoteBody,
    pauseVoteHeadline,
    poolVoteBlocker,
    proposedByLine,
    replyHeading,
    replyTakenDownLine,
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
            // The date through core's formatDate (was the device's toLocaleDateString): "19 Sep 2026" in English.
            .toBe('An admin suspended Dave on 19 Sep 2026. Keep the suspension?');
        expect(keepSuspensionHeadline(null, 'abcd1234')).toBe('An admin suspended abcd1234. Keep the suspension?');
    });

    // Removal by vote S2: an admin's pause opens the community's vote on removing the member, the node's own (rule 2).
    it('explains a pause\'s own vote, and tells it from a removal a member proposed', () => {
        const pause = { effect: 'remove_member', authorPubkey: 'SYSTEM', params: { memberName: 'Dave', pausedAt: '2026-10-22T10:00:00.000Z', rule: 2 } };
        expect(isPauseVote(pause)).toBe(true);
        expect(isPauseVote({ ...pause, authorPubkey: 'a'.repeat(64) })).toBe(false);
        expect(isPauseVote({ ...pause, params: { memberName: 'Dave' } })).toBe(false);
        expect(isPauseVote({ ...pause, effect: 'keep_suspension' })).toBe(false);
        expect(pauseVoteHeadline(pause.params, 'abc')).toBe('An admin paused Dave on 22 Oct 2026.');
        expect(pauseVoteHeadline(null, 'abcd1234')).toBe('An admin paused abcd1234.');
        expect(pauseVoteBody(pause.params, 'abc')).toBe('Yes removes Dave after 7 days. No brings Dave back as soon as the vote closes.');
        expect(pauseVoteBody({ ...pause.params, serverRole: 'owner' }, 'abc'))
            .toBe("Dave holds a role that runs this community's server, and no community vote removes an owner or admin: whatever this vote decides, Dave is back when it closes.");
    });

    // Removal by vote, Amendment A: who brought it is named (point 3), the member's reply (point 2), a hidden case (point 4).
    it('names who brought a removal vote, heads the member\'s reply, and says what stands in for a hidden case', () => {
        const params = { memberName: 'Dave', pausedAt: '2026-10-22T10:00:00.000Z', rule: 2 };
        expect(pauseVoteHeadline(params, 'abc', { kind: 'admin', name: 'Ada' })).toBe('Ada, an admin, paused Dave on 22 Oct 2026.');
        expect(pauseVoteHeadline({ memberName: 'Dave' }, 'abc', { kind: 'admin', name: 'Ada' })).toBe('Ada, an admin, paused Dave.');
        expect(pauseVoteHeadline(params, 'abc', { kind: 'password', name: null })).toBe("An owner paused Dave on 22 Oct 2026, signed in with the server's password.");
        // An admin's name the node could not know, and a node from before: as it always read.
        expect(pauseVoteHeadline(params, 'abc', { kind: 'admin', name: null })).toBe('An admin paused Dave on 22 Oct 2026.');
        expect(pauseVoteHeadline(params, 'abc')).toBe('An admin paused Dave on 22 Oct 2026.');

        expect(proposedByLine({ effect: 'remove_member', proposer: { kind: 'member', name: 'Tia' } })).toBe('Proposed by Tia.');
        expect(proposedByLine({ effect: 'remove_member', proposer: { kind: 'member', name: null } })).toBe('Proposed by a member who has since left.');
        expect(proposedByLine({ effect: 'remove_member', proposer: { kind: 'admin', name: 'Ada' } })).toBeNull();
        expect(proposedByLine({ effect: 'freeze_credit', proposer: { kind: 'member', name: 'Tia' } })).toBeNull();
        expect(proposedByLine({ effect: 'remove_member' })).toBeNull();

        expect(replyHeading(params, 'abc', false)).toBe("Dave's reply");
        expect(replyHeading(null, 'abcd1234', false)).toBe("abcd1234's reply");
        expect(replyHeading(params, 'abc', true)).toBe('Your reply');

        expect(caseHiddenLine('Wu confirmed every repair')).toBe('An admin hid the case for this vote, as one shown to be false. Their reason: Wu confirmed every repair');
        expect(caseHiddenLine(null)).toBe('An admin hid the case for this vote, as one shown to be false.');
    });

    // The deciding review of #2585: a reply an admin took down, its reason in the reply's place.
    it("says what stands in for a reply an admin took down: to everyone, whose; to the member, theirs", () => {
        const params = { memberName: 'Dave' };
        expect(replyTakenDownLine(params, 'abc', false, 'It gave an address')).toBe("An admin took down Dave's reply. Their reason: It gave an address");
        expect(replyTakenDownLine(null, 'abcd1234', false, 'It gave an address')).toBe("An admin took down abcd1234's reply. Their reason: It gave an address");
        expect(replyTakenDownLine(params, 'abc', false, null)).toBe("An admin took down Dave's reply.");
        expect(replyTakenDownLine(params, 'abc', true, 'It gave an address')).toBe('An admin took down your reply. Their reason: It gave an address');
        expect(replyTakenDownLine(params, 'abc', true, null)).toBe('An admin took down your reply.');
    });
});
