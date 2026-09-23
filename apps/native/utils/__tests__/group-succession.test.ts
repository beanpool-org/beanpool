import { describe, it, expect } from 'vitest';
import {
    buildSuccessionView, outcomeLineText, proposalCandidates, silenceLineText, tallyLineText,
    closingLineText, voteConfirmText,
    type GroupSilence, type GroupSuccessionData, type GroupSuccessionProposal,
} from '../group-succession';
import type { GroupMemberItem } from '../db';

/**
 * The quiet-lead vote's screen, decided here so both the panel and the native screen are provably the same.
 *
 * What is being defended: a healthy group never sees this at all; nothing offers an action the server would
 * refuse; and no ballot ever names its voter.
 */

const LEAD = 'pk-lead';
const CONVENOR = 'pk-damo';
const MEMBER = 'pk-zed';
const OTHER = 'pk-pia';

const NOW = Date.parse('2026-09-23T00:00:00.000Z');
const DEADLINE = '2026-10-07T00:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const member = (pubkey: string, callsign: string, role: GroupMemberItem['role'], over: Partial<GroupMemberItem> = {}): GroupMemberItem => ({
    groupId: 'g1', memberPubkey: pubkey, callsign, role, status: 'active',
    joinedAt: '2026-01-01T00:00:00.000Z', invitedBy: null, ...over,
});

const ROSTER: GroupMemberItem[] = [
    member(LEAD, 'Marty', 'convenor'),
    member(CONVENOR, 'Damo', 'convenor'),
    member(MEMBER, 'Zed', 'member'),
    member(OTHER, 'Pia', 'member'),
    member('pk-obs', 'Obs', 'observer'),
    member('pk-gone', 'Gone', 'member', { status: 'pending_approval' }),
];

const silence = (over: Partial<GroupSilence> = {}): GroupSilence => ({
    convenorPubkey: LEAD, convenorCallsign: 'Marty', lastActiveAt: '2026-08-10T00:00:00.000Z',
    daysInactive: 44.6, isSilent: true, isEligible: true, electorate: 'convenors', ...over,
});

const proposal = (over: Partial<GroupSuccessionProposal> = {}): GroupSuccessionProposal => ({
    id: 'prop-1', groupId: 'g1',
    convenorPubkey: LEAD, convenorCallsign: 'Marty',
    candidatePubkey: CONVENOR, candidateCallsign: 'Damo',
    proposerPubkey: CONVENOR, proposerCallsign: 'Damo',
    status: 'active', closedReason: null,
    createdAt: '2026-09-23T00:00:00.000Z', deadlineAt: DEADLINE, executedAt: null,
    yesCount: 1, noCount: 0, electorateSize: 3, myVote: null, canVote: true, ...over,
});

const data = (over: Partial<GroupSuccessionData> = {}): GroupSuccessionData => ({
    silence: silence(), proposals: [], canPropose: true, ...over,
});

describe('buildSuccessionView — whether the section exists at all', () => {
    it('hides for a healthy group: the lead is not eligible and no vote was ever held', () => {
        const view = buildSuccessionView(data({ silence: silence({ isSilent: false, isEligible: false }), canPropose: false }), ROSTER, NOW);
        expect(view.show).toBe(false);
        expect(view.silenceLine).toBeNull();
        expect(view.canPropose).toBe(false);
        expect(view.canVote).toBe(false);
        expect(view.outcomeLine).toBeNull();
    });

    it('hides on a node too old for the route, which reaches the screen as null', () => {
        expect(buildSuccessionView(null, ROSTER, NOW).show).toBe(false);
        expect(buildSuccessionView(undefined, ROSTER, NOW).show).toBe(false);
    });

    it('hides when the lead is silent but nobody is left who could vote (isEligible false)', () => {
        // The server says silent-but-not-eligible when the lead is alone in the group. Silence alone is not the
        // trigger: `isEligible` is.
        const view = buildSuccessionView(data({ silence: silence({ isEligible: false }), canPropose: false }), ROSTER, NOW);
        expect(view.show).toBe(false);
    });

    it('still shows for a group whose lead came back, so the closed vote can say what happened', () => {
        const view = buildSuccessionView(data({
            silence: silence({ isSilent: false, isEligible: false }),
            canPropose: false,
            proposals: [proposal({ status: 'cancelled', closedReason: 'convenor_returned' })],
        }), ROSTER, NOW);
        expect(view.show).toBe(true);
        expect(view.silenceLine).toBeNull();
        expect(view.outcomeLine).toBe('Marty came back, so the vote closed.');
    });

    it('says how the last vote ended for a fortnight afterwards, and nothing else', () => {
        const view = buildSuccessionView(data({
            silence: silence({ isSilent: false, isEligible: false }),
            canPropose: false,
            proposals: [proposal({ status: 'cancelled', closedReason: 'rejected', deadlineAt: iso(NOW - 13 * DAY) })],
        }), ROSTER, NOW);
        expect(view.show).toBe(true);
        // Nothing is under way, so the screen has no process to announce: one line, no amber heading.
        expect(view.outcomeOnly).toBe(true);
        expect(view.outcomeLine).toBe('The group voted no, so Marty is still the lead.');
        expect(view.silenceLine).toBeNull();
        expect(view.openProposal).toBeNull();
        expect(view.canPropose).toBe(false);
        expect(view.canVote).toBe(false);
    });

    it('hides once that fortnight is up: a lead who is active and no vote running is a healthy group', () => {
        const view = buildSuccessionView(data({
            silence: silence({ isSilent: false, isEligible: false }),
            canPropose: false,
            proposals: [proposal({ status: 'cancelled', closedReason: 'rejected', deadlineAt: iso(NOW - 15 * DAY) })],
        }), ROSTER, NOW);
        expect(view.show).toBe(false);
        expect(view.outcomeLine).toBeNull();
    });

    it('dates a vote that passed by when it was executed, not by the deadline it never reached', () => {
        // A vote passes the moment the result is settled, which can be a fortnight before its deadline. Reading
        // the deadline here would keep a two-week-old outcome up for another two weeks.
        const view = buildSuccessionView(data({
            silence: silence({ isSilent: false, isEligible: false }),
            canPropose: false,
            proposals: [proposal({ status: 'passed', closedReason: null, executedAt: iso(NOW - 15 * DAY), deadlineAt: iso(NOW - DAY) })],
        }), ROSTER, NOW);
        expect(view.show).toBe(false);
    });

    it('keeps showing while the lead is still eligible, however old the last vote is', () => {
        const view = buildSuccessionView(data({
            proposals: [proposal({ status: 'cancelled', closedReason: 'rejected', deadlineAt: iso(NOW - 400 * DAY) })],
        }), ROSTER, NOW);
        expect(view.show).toBe(true);
        expect(view.outcomeOnly).toBe(false);
        expect(view.silenceLine).toBe("Marty hasn't been active for 44 days. The group can choose a new lead.");
    });
});

describe('buildSuccessionView — proposing', () => {
    it('offers the propose action only when the server says canPropose', () => {
        expect(buildSuccessionView(data({ canPropose: true }), ROSTER, NOW).canPropose).toBe(true);
        expect(buildSuccessionView(data({ canPropose: false }), ROSTER, NOW).canPropose).toBe(false);
    });

    it('never offers it while a vote is open, whatever the payload says', () => {
        const view = buildSuccessionView(data({ canPropose: true, proposals: [proposal()] }), ROSTER, NOW);
        expect(view.canPropose).toBe(false);
    });

    it('offers the lead\'s fellow convenors when the electorate is the convenors, viewer included', () => {
        const view = buildSuccessionView(data(), ROSTER, NOW);
        expect(view.candidates.map(m => m.callsign)).toEqual(['Damo']);
    });

    it('offers the active members when the lead is the group\'s only convenor', () => {
        const view = buildSuccessionView(data({ silence: silence({ electorate: 'members' }) }), ROSTER, NOW);
        // Members only: never the observer, never the pending join, never the quiet lead.
        expect(view.candidates.map(m => m.callsign)).toEqual(['Zed', 'Pia']);
    });

    it('never offers the quiet lead as a candidate, even if they hold the electorate\'s role', () => {
        const view = buildSuccessionView(data(), ROSTER, NOW);
        expect(view.candidates.some(m => m.memberPubkey === LEAD)).toBe(false);
    });
});

describe('buildSuccessionView — an open vote', () => {
    it('offers Yes/No only when the server says this viewer can vote', () => {
        expect(buildSuccessionView(data({ proposals: [proposal({ canVote: true })] }), ROSTER, NOW).canVote).toBe(true);
        expect(buildSuccessionView(data({ proposals: [proposal({ canVote: false })] }), ROSTER, NOW).canVote).toBe(false);
    });

    it('shows the viewer\'s own vote and stops offering the buttons once it is cast', () => {
        const view = buildSuccessionView(data({ proposals: [proposal({ myVote: 'yes', canVote: false })] }), ROSTER, NOW);
        expect(view.myVote).toBe('yes');
        expect(view.canVote).toBe(false);
    });

    it('gives the totals and the closing date, and no voter list to render', () => {
        const view = buildSuccessionView(data({ proposals: [proposal({ yesCount: 2, noCount: 1, electorateSize: 5 })] }), ROSTER, NOW);
        expect(view.tallyLine).toBe('2 yes, 1 no, of 5 who can vote.');
        expect(view.closingLine).toBe('Closes 7 Oct 2026 — 14 days left.');
        // Ballots are secret: the server sends no voter identities, so there are none in the view either.
        expect(JSON.stringify(view)).not.toMatch(/voter/i);
        expect(Object.keys(view.openProposal ?? {})).not.toContain('votes');
    });

    it('holds back the outcome line while a vote is running, even with a closed one behind it', () => {
        const view = buildSuccessionView(data({
            proposals: [proposal({ id: 'prop-2' }), proposal({ id: 'prop-1', status: 'cancelled', closedReason: 'rejected' })],
        }), ROSTER, NOW);
        expect(view.openProposal?.id).toBe('prop-2');
        expect(view.outcomeLine).toBeNull();
    });
});

describe('outcomeLineText — one line per closed reason (decision 5)', () => {
    it('passed', () => {
        expect(outcomeLineText(proposal({ status: 'passed', closedReason: null })))
            .toBe("Damo is now the group's lead convenor.");
    });
    it('rejected', () => {
        expect(outcomeLineText(proposal({ status: 'cancelled', closedReason: 'rejected' })))
            .toBe('The group voted no, so Marty is still the lead.');
    });
    it('the lead came back', () => {
        expect(outcomeLineText(proposal({ status: 'cancelled', closedReason: 'convenor_returned' })))
            .toBe('Marty came back, so the vote closed.');
    });
    it('the candidate left', () => {
        expect(outcomeLineText(proposal({ status: 'cancelled', closedReason: 'candidate_gone' })))
            .toBe('Damo is no longer in the group, so the vote closed.');
    });
    it('no longer needed', () => {
        expect(outcomeLineText(proposal({ status: 'cancelled', closedReason: 'no_longer_needed' })))
            .toBe('The group has another lead now, so the vote closed.');
    });
    it('says nothing about a vote that is still running', () => {
        expect(outcomeLineText(proposal())).toBeNull();
        expect(outcomeLineText(null)).toBeNull();
    });
    it('shows only the latest closed vote, never a history', () => {
        const view = buildSuccessionView(data({
            canPropose: false,
            proposals: [
                proposal({ id: 'p2', status: 'cancelled', closedReason: 'rejected' }),
                proposal({ id: 'p1', status: 'cancelled', closedReason: 'candidate_gone' }),
            ],
        }), ROSTER, NOW);
        expect(view.outcomeLine).toBe('The group voted no, so Marty is still the lead.');
        expect(view.outcomeLine).not.toContain('no longer in the group');
    });
});

describe('the words', () => {
    it('says how long the lead has been quiet, and only while they are eligible', () => {
        expect(silenceLineText(silence())).toBe("Marty hasn't been active for 44 days. The group can choose a new lead.");
        expect(silenceLineText(silence({ isEligible: false }))).toBeNull();
    });

    it('names the lead as "the lead convenor" when the node sent no callsign', () => {
        expect(silenceLineText(silence({ convenorCallsign: null })))
            .toBe("The lead convenor hasn't been active for 44 days. The group can choose a new lead.");
    });

    it('warns that a vote cannot be changed, in the confirm itself', () => {
        expect(voteConfirmText('yes', 'Damo')).toContain("Votes can't be changed.");
        expect(voteConfirmText('no', 'Damo')).toContain("Votes can't be changed.");
        expect(voteConfirmText('yes', 'Damo')).toContain('Damo');
    });

    it('never says an exact required count: the rule is more than half of those who ANSWER', () => {
        expect(tallyLineText(proposal({ yesCount: 0, noCount: 0, electorateSize: 4 })))
            .toBe('0 yes, 0 no, of 4 who can vote.');
        expect(tallyLineText(proposal())).not.toMatch(/needs/i);
    });

    it('drops the closing line rather than printing an unreadable date', () => {
        expect(closingLineText(proposal({ deadlineAt: 'not-a-date' }), NOW)).toBeNull();
    });
});

describe('proposalCandidates — the picker offers exactly the electorate', () => {
    it('reads the server\'s electorate field rather than working the rule out again', () => {
        expect(proposalCandidates(silence({ electorate: 'convenors' }), ROSTER).map(m => m.memberPubkey)).toEqual([CONVENOR]);
        expect(proposalCandidates(silence({ electorate: 'members' }), ROSTER).map(m => m.memberPubkey)).toEqual([MEMBER, OTHER]);
    });

    it('includes the viewer: proposing yourself is allowed', () => {
        const view = buildSuccessionView(data({ silence: silence({ electorate: 'members' }) }), ROSTER, NOW);
        expect(view.candidates.some(m => m.memberPubkey === MEMBER)).toBe(true);
    });
});
