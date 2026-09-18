import { describe, it, expect } from 'vitest';
import {
    timeLeftText, keeperChangeTitle, keeperChangeBody, canObjectToChange, canRemoveKeeper, canStepDown, nextLead,
    stepDownConfirmText, approvedApplicantText, successionTallyText, successionDeadlineText, myChoice,
    successionClosedText, successionHeading, successionExplainer, removeKeeperConfirmText,
} from '../keeper-governance';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 19, 12);

const LEAD = { publicKey: 'lead', callsign: 'Rosa', role: 'lead', suspended: false, grantedAt: '2026-01-01T00:00:00Z' };
const SENIOR = { publicKey: 'sen', callsign: 'Tomas', role: 'keeper', suspended: false, grantedAt: '2026-02-01T00:00:00Z' };
const JUNIOR = { publicKey: 'jun', callsign: 'Ana', role: 'keeper', suspended: false, grantedAt: '2026-03-01T00:00:00Z' };
const SUSP = { publicKey: 'sus', callsign: 'Ivo', role: 'keeper', suspended: true, grantedAt: '2025-12-01T00:00:00Z' };
const KEEPERS = [LEAD, SENIOR, JUNIOR, SUSP];

const ADD = { id: 'c1', kind: 'add' as const, memberPubkey: 'app', memberCallsign: 'Lee', proposedBy: 'lead', proposedByCallsign: 'Rosa', pledgedBacking: 20, appliesAt: new Date(NOW + 2 * DAY + 5 * HOUR).toISOString() };
const REMOVE = { ...ADD, id: 'c2', kind: 'remove' as const, memberPubkey: 'jun', memberCallsign: 'Ana', pledgedBacking: 0 };

describe('countdowns', () => {
    it('days and hours, hours, under an hour, ended', () => {
        expect(timeLeftText(new Date(NOW + 2 * DAY + 5 * HOUR).toISOString(), NOW)).toBe('2 days 5 hours left');
        expect(timeLeftText(new Date(NOW + 1 * DAY).toISOString(), NOW)).toBe('1 day left');
        expect(timeLeftText(new Date(NOW + 3 * HOUR + 10).toISOString(), NOW)).toBe('3 hours left');
        expect(timeLeftText(new Date(NOW + 10 * 60000).toISOString(), NOW)).toBe('less than an hour left');
        expect(timeLeftText(new Date(NOW - 1).toISOString(), NOW)).toBe('ending now');
    });
});

describe('pending keeper changes (answers A and M)', () => {
    it('says what the change is, in beans', () => {
        expect(keeperChangeTitle(ADD)).toBe('Adding Lee as a keeper, backing 20 beans');
        expect(keeperChangeTitle({ ...ADD, pledgedBacking: 0 })).toBe('Adding Lee as a keeper');
        expect(keeperChangeTitle(REMOVE)).toBe('Removing Ana as a keeper');
        expect(keeperChangeBody(ADD)).toContain('one objection cancels it');
    });

    it('any other active keeper may object; not the lead who made it, the keeper being removed, or a suspended keeper', () => {
        expect(canObjectToChange(ADD, 'sen', KEEPERS)).toBe(true);
        expect(canObjectToChange(ADD, 'lead', KEEPERS)).toBe(false);
        expect(canObjectToChange(REMOVE, 'jun', KEEPERS)).toBe(false);
        expect(canObjectToChange(ADD, 'sus', KEEPERS)).toBe(false);
        expect(canObjectToChange(ADD, 'stranger', KEEPERS)).toBe(false);
        expect(canObjectToChange(ADD, null, KEEPERS)).toBe(false);
    });

    it('the lead may remove an ordinary keeper who has nothing pending', () => {
        expect(canRemoveKeeper(SENIOR, 'lead', true, [])).toBe(true);
        expect(canRemoveKeeper(JUNIOR, 'lead', true, [REMOVE])).toBe(false);
        expect(canRemoveKeeper(LEAD, 'lead', true, [])).toBe(false);
        expect(canRemoveKeeper(SENIOR, 'sen', false, [])).toBe(false);
        expect(removeKeeperConfirmText(SENIOR)).toBe('Tomas stops being a keeper in 3 days, unless another keeper objects first.');
    });

    it('the applicant is told the window is running', () => {
        expect(approvedApplicantText(ADD.appliesAt, NOW)).toContain('(2 days 5 hours left)');
    });
});

describe('stepping down (answers G and M)', () => {
    it('any keeper except the only one', () => {
        expect(canStepDown('sen', KEEPERS)).toBe(true);
        expect(canStepDown('lead', [LEAD])).toBe(false);
        expect(canStepDown('stranger', KEEPERS)).toBe(false);
    });

    it('a lead stepping down names who takes over: the longest-serving active keeper', () => {
        expect(nextLead(KEEPERS, 'lead')?.publicKey).toBe('sen');
        expect(stepDownConfirmText('lead', KEEPERS)).toContain('Tomas becomes lead at once');
        expect(stepDownConfirmText('lead', [LEAD, SUSP])).toContain('the enterprise pauses');
        expect(stepDownConfirmText('jun', KEEPERS)).toBe('You stop being a keeper of this enterprise. Any backing you pledged is released.');
    });
});

describe('succession (answers G and M)', () => {
    const P = {
        status: 'active', deadlineAt: new Date(NOW + 13 * DAY).toISOString(), votesCount: 1, noVotesCount: 1,
        requiredVotes: 2, totalEligible: 3, votes: [{ voterPubkey: 'sen', choice: 'yes' as const }, { voterPubkey: 'jun', choice: 'no' as const }],
    };
    it('tally, deadline and my vote', () => {
        expect(successionTallyText(P)).toBe('1 yes, 1 no. Needs 2 yes of 3 keepers.');
        expect(successionDeadlineText(P, NOW)).toContain('13 days left');
        expect(myChoice(P, 'jun')).toBe('no');
        expect(myChoice(P, 'sen')).toBe('yes');
        expect(myChoice(P, 'lead')).toBeNull();
    });
    it('closing reasons in plain words', () => {
        expect(successionClosedText('rejected')).toContain('lead stays');
        expect(successionClosedText('expired')).toContain('14 days ran out');
        expect(successionClosedText(null)).toBeNull();
    });
    it('an automatic promotion opens succession at once and says so', () => {
        expect(successionHeading({ autoPromoted: true })).toBe('NEW LEAD CHOSEN AUTOMATICALLY');
        expect(successionHeading({ daysInactive: 41.7 })).toBe('LEAD KEEPER INACTIVE (41 DAYS)');
        expect(successionExplainer({ autoPromoted: true, leadCallsign: 'Tomas' })).toContain('can choose someone else now');
    });
});
