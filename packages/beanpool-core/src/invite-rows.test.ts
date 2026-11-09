import { beforeEach, describe, expect, it } from 'vitest';
import {
    INVITE_LIFE_DAYS, INVITE_LIFE_MS, INVITE_URGENT_DAYS, inviteCarries, inviteExpiryMs, inviteFolds, inviteLapsed, inviteMadeTitle, inviteTimeLeft, inviteWho,
    joinedHeading, joinedInvites, pendingHeading, pendingInvites, type InviteRowSource,
} from './invite-rows.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const made = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const inv = (daysAgo: number, extra: Partial<InviteRowSource> = {}): InviteRowSource => ({ code: 'INV-TEST-0001', createdAt: made(daysAgo), ...extra });

describe('the one life of an invite', () => {
    it('is 30 days, and the milliseconds agree', () => {
        expect(INVITE_LIFE_DAYS).toBe(30);
        expect(INVITE_LIFE_MS).toBe(30 * DAY);
    });

    it('ends at the node’s expiresAt, else 30 days after it was made (an offline ticket has no node row)', () => {
        expect(inviteExpiryMs(inv(7))).toBe(NOW - 7 * DAY + 30 * DAY);
        expect(inviteExpiryMs({ ...inv(7), expiresAt: '2026-12-31T00:00:00.000Z' })).toBe(Date.parse('2026-12-31T00:00:00.000Z'));
        expect(inviteExpiryMs({ ...inv(7), expiresAt: 'not a date' })).toBe(NOW - 7 * DAY + 30 * DAY);
        expect(Number.isNaN(inviteExpiryMs({ createdAt: 'nope' }))).toBe(true);
    });

    it('is lapsed from the moment it ends', () => {
        expect(inviteLapsed(inv(29), NOW)).toBe(false);
        expect(inviteLapsed(inv(30), NOW)).toBe(true);
        expect(inviteLapsed(inv(31), NOW)).toBe(true);
    });
});

describe('who an invite is for', () => {
    it('the name opened from the names list, when this phone opened one', () => {
        expect(inviteWho(inv(1, { namesEntryId: 'e1', intendedFor: 'ignored' }), { name: 'Sam' })).toBe('Sam');
    });

    it('a bound invite whose name can’t be opened here: on the web the name is on the phone; on a phone, the note or the code', () => {
        expect(inviteWho(inv(1, { namesEntryId: 'e1' }), { nameOnPhone: true })).toBe('Name on the phone');
        expect(inviteWho(inv(1, { namesEntryId: 'e1' }))).toBe('INV-TEST-0001');
        expect(inviteWho(inv(1, { namesEntryId: 'e1', intendedFor: 'Kim' }))).toBe('For: Kim');
    });

    it('a plain invite: the note, else the code', () => {
        expect(inviteWho(inv(1, { intendedFor: 'Kim' }))).toBe('For: Kim');
        expect(inviteWho(inv(1, { intendedFor: '  ' }))).toBe('INV-TEST-0001');
        expect(inviteWho(inv(1))).toBe('INV-TEST-0001');
    });

    it('a name is never taken from a plain invite’s opened-name option: it needs the entry', () => {
        expect(inviteWho(inv(1, { intendedFor: 'Kim' }), { name: 'Sam' })).toBe('For: Kim');
    });

    it('made for a request to join: its note is the applicant’s key, which is never shown', () => {
        const key = 'f'.repeat(64);
        expect(inviteWho(inv(1, { forKnock: true, intendedFor: key }))).toBe('For someone who asked to join');
    });
});

describe('what an invite carries', () => {
    it('a vouch, a voucher budget and the confirming, in words', () => {
        expect(inviteCarries(inv(1, { namesEntryId: 'e1', vouchAmount: 200, voucherLevel: 1000 }))).toBe('200 vouch · voucher budget 1,000 · confirms them as known');
    });

    it('each part alone', () => {
        expect(inviteCarries(inv(1, { vouchAmount: 50 }))).toBe('50 vouch');
        expect(inviteCarries(inv(1, { namesEntryId: 'e1' }))).toBe('confirms them as known');
        expect(inviteCarries(inv(1, { namesEntryId: 'e1', voucherLevel: 500 }))).toBe('voucher budget 500 · confirms them as known');
    });

    it('nothing at all (null from the node, or missing) is a plain invite', () => {
        expect(inviteCarries(inv(1))).toBe('Plain invite');
        expect(inviteCarries(inv(1, { namesEntryId: null, vouchAmount: null, voucherLevel: null }))).toBe('Plain invite');
    });
});

describe('how long is left', () => {
    it('whole days, rounded up: 23 days after 7 of 30', () => {
        expect(inviteTimeLeft(inv(7), NOW)).toEqual({ text: '23 days left', urgent: false });
        expect(inviteTimeLeft(inv(0), NOW)).toEqual({ text: '30 days left', urgent: false });
    });

    it('one day is "1 day left", and the last hours still say a day', () => {
        expect(inviteTimeLeft(inv(29), NOW)).toEqual({ text: '1 day left', urgent: true });
        expect(inviteTimeLeft({ ...inv(29), createdAt: new Date(NOW - 29.5 * DAY).toISOString() }, NOW)?.text).toBe('1 day left');
    });

    it('red at 3 days or fewer, and not at 4', () => {
        expect(INVITE_URGENT_DAYS).toBe(3);
        expect(inviteTimeLeft(inv(26), NOW)?.urgent).toBe(false); // 4 left
        expect(inviteTimeLeft(inv(27), NOW)?.urgent).toBe(true); // 3 left
        expect(inviteTimeLeft(inv(28), NOW)?.urgent).toBe(true);
    });

    it('nothing to say for a date that can’t be read', () => {
        expect(inviteTimeLeft({ createdAt: 'nope' }, NOW)).toBeNull();
    });
});

describe('Pending and Joined', () => {
    const all: InviteRowSource[] = [
        { ...inv(1), code: 'A' },
        { ...inv(31), code: 'LAPSED' },
        { ...inv(2), code: 'B' },
        { ...inv(10), code: 'U1', usedBy: 'k1', usedAt: made(9) },
        { ...inv(12), code: 'U2', usedBy: 'k2', usedAt: made(2) },
    ];

    it('Pending is the codes nobody used that still work', () => {
        expect(pendingInvites(all, NOW).map((i) => i.code)).toEqual(['A', 'B']);
    });

    it('Joined is the codes someone used, the newest joiner first', () => {
        expect(joinedInvites(all).map((i) => i.code)).toEqual(['U2', 'U1']);
    });

    it('the headings carry the count', () => {
        expect(pendingHeading(7)).toBe('Pending (7)');
        expect(joinedHeading(3)).toBe('Joined (3)');
    });
});

describe('the made card’s title', () => {
    it('names who it is for, else says it was made', () => {
        expect(inviteMadeTitle('Sam')).toBe('Invite for Sam');
        expect(inviteMadeTitle(null)).toBe('Invite made');
        expect(inviteMadeTitle('  ')).toBe('Invite made');
    });
});

describe('the folds are closed at first and remembered for the session', () => {
    beforeEach(() => inviteFolds.clear());

    it('closed until opened; one fold doesn’t open the other', () => {
        expect(inviteFolds.isOpen('pending')).toBe(false);
        inviteFolds.set('pending', true);
        expect(inviteFolds.isOpen('pending')).toBe(true);
        expect(inviteFolds.isOpen('joined')).toBe(false);
        inviteFolds.set('pending', false);
        expect(inviteFolds.isOpen('pending')).toBe(false);
    });
});
