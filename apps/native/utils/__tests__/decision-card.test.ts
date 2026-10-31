import { describe, it, expect } from 'vitest';
import {
    NO_TRADE_POOL_VOTE_MESSAGE,
    caseHiddenLine,
    electorateLine,
    isPauseVote,
    keepSuspensionHeadline,
    minYesLine,
    ownerDecisionLine,
    pauseVoteBody,
    pauseVoteHeadline,
    poolVoteBlocker,
    proposedByLine,
    replyHeading,
    replyTakenDownLine,
    secondPauseLine,
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

    // Removal by vote S4 (design §3.4): an owner's second pause within 30 days of a vote that didn't remove them says so.
    it('says a second pause within 30 days is one, by how the last vote ended, and nothing for a first', () => {
        const endedAt = '2026-10-15T10:00:00.000Z';
        expect(secondPauseLine({ secondPause: { after: 'no', endedAt } } as any)).toBe('Second pause in 30 days. The last vote said No.');
        expect(secondPauseLine({ secondPause: { after: 'too_few', endedAt } } as any)).toBe('Second pause in 30 days. Too few members voted on the last one.');
        expect(secondPauseLine({ secondPause: { after: 'stopped', endedAt } } as any)).toBe('Second pause in 30 days. The last vote was stopped before it closed.');
        expect(secondPauseLine({ memberName: 'Dave', rule: 2 } as any)).toBeNull();
        expect(secondPauseLine({ secondPause: { after: 'something new' } })).toBeNull();
        expect(secondPauseLine(null)).toBeNull();
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

        // Removal by vote S4 / Marty 31 Oct: an owner's second pause says "an owner", never "an admin".
        const secondParams = { memberName: 'Dave', pausedAt: '2026-10-22T10:00:00.000Z', rule: 2, secondPause: { after: 'no' } };
        expect(pauseVoteHeadline(secondParams, 'abc', { kind: 'owner', name: 'Otto' })).toBe('Otto, an owner, paused Dave on 22 Oct 2026.');
        expect(pauseVoteHeadline({ memberName: 'Dave', secondPause: { after: 'no' } }, 'abc', { kind: 'owner', name: 'Otto' })).toBe('Otto, an owner, paused Dave.');
        expect(pauseVoteHeadline(secondParams, 'abc', { kind: 'admin', name: 'Otto' })).toBe('Otto, an owner, paused Dave on 22 Oct 2026.');
        expect(pauseVoteHeadline(secondParams, 'abc')).toBe('An owner paused Dave on 22 Oct 2026.');
        expect(pauseVoteHeadline({ memberName: 'Dave', secondPause: { after: 'no' } }, 'abc')).toBe('An owner paused Dave.');

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

    // Removal by vote S6 (design §5): at least 3 Yes; too few to vote, the owner decides when it closes.
    it('says the 3-Yes floor on a removal, and nothing on another Decision or from a node from before', () => {
        expect(minYesLine({ minYes: 3 })).toBe('Removing a member also needs at least 3 Yes votes.');
        expect(minYesLine({})).toBeNull();
        expect(minYesLine(null)).toBeNull();
    });

    it('says when too few can vote, what an owner decided while it is open, and that the owner decided it once carried out', () => {
        const params = { memberName: 'Sam', rule: 2 };
        const open = { status: 'open', params };
        expect(ownerDecisionLine(open, { tooFewToVote: true }, 'abc')).toBe('Fewer than 3 members could vote. If nobody else votes, the owner decides when it closes.');
        expect(ownerDecisionLine(open, { tooFewToVote: false }, 'abc')).toBeNull();
        expect(ownerDecisionLine(open, null, 'abc')).toBeNull();
        const decided = { ...open, ownerDecidedAt: '2026-10-30T10:00:00.000Z', ownerDecidedReason: 'Both who could vote saw it' };
        expect(ownerDecisionLine(decided, { tooFewToVote: true }, 'abc'))
            .toBe('Too few members can vote, so an owner decided: unless more of them vote, Sam is removed when this vote closes. Their reason: Both who could vote saw it');
        const carried = { ...decided, status: 'executed', ownerDecisionCarriedAt: '2026-11-06T10:00:00.000Z' };
        expect(ownerDecisionLine(carried, { tooFewToVote: true }, 'abc')).toBe('Decided by the owner: too few members to vote. Their reason: Both who could vote saw it');
        // Decided, but enough members voted by the close: the vote ended as any vote does, and the closed card says nothing of it.
        expect(ownerDecisionLine({ ...decided, status: 'unresolved' }, { tooFewToVote: false }, 'abc')).toBeNull();
        // An admin hid the case: the node leaves the owner's reason off, as it may repeat the accusation, and the line says the rest.
        expect(ownerDecisionLine({ ...decided, ownerDecidedReason: null }, { tooFewToVote: true }, 'abc'))
            .toBe('Too few members can vote, so an owner decided: unless more of them vote, Sam is removed when this vote closes.');
        expect(ownerDecisionLine({ ...carried, ownerDecidedReason: null }, { tooFewToVote: true }, 'abc')).toBe('Decided by the owner: too few members to vote.');
        // No vote, and no owner, removes someone holding a server role: nothing about the owner on that card.
        expect(ownerDecisionLine({ status: 'open', params: { ...params, serverRole: 'admin' } }, { tooFewToVote: true }, 'abc')).toBeNull();
    });
});
