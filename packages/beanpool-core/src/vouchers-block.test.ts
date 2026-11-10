import { describe, it, expect } from 'vitest';
import {
    inviteFromNamesListWords, isProfileVoucherButton, ownerRowWords, ownersHeading, profileVoucherButtonWords, voucherCardHeadline, voucherRowWords,
    vouchersBlockSections, waitingHeading, waitingRowWords, makeVoucherSheetTitle, makeVoucherAdminsHeading, makeVoucherConfirmedHeading,
    makeVoucherNobody, makeVoucherNobodyForCommittee, makeVoucherNobodyWords, ownerMakesAdminVoucherWords, voucherCandidateWords, makeVoucherBudgetWords, makeVoucherButtonWords, madeVoucherWords,
} from './vouchers-block.js';

// The Vouchers block and the profile button (invites-vouching I4; DESIGN-invites-vouching-review-fable.md §3 asks 1, 2, 4, 5(b)).

describe('the block: owners pinned first, everyone else after', () => {
    const rows = [
        { callsign: 'Ada', noLimit: false }, { callsign: 'Marty', noLimit: true }, { callsign: 'Rob' }, { callsign: 'Zoe', noLimit: true },
    ];
    it('splits owners from the rest and keeps the node’s order inside each', () => {
        const { owners, others } = vouchersBlockSections(rows);
        expect(owners.map((r) => r.callsign)).toEqual(['Marty', 'Zoe']);
        expect(others.map((r) => r.callsign)).toEqual(['Ada', 'Rob']);
    });
    it('an empty block is two empty sections', () => {
        expect(vouchersBlockSections([])).toEqual({ owners: [], others: [] });
    });
});

describe('the rows say what matters', () => {
    it('one line over the owners, and "Waiting to join" over the promised budgets', () => {
        expect(ownersHeading()).toBe('Owners · no limit');
        expect(waitingHeading()).toBe('Waiting to join');
    });
    it('an owner’s row says how many they vouched and has no budget words', () => {
        const row = ownerRowWords('Marty', 2);
        expect(row).toBe('@Marty · 2 vouched ›');
        expect(row).not.toMatch(/left|budget|of \d|below zero|limit/i);
    });
    it('another voucher’s row says what is left, and nothing else', () => {
        expect(voucherRowWords('Rob', 400)).toBe('@Rob · 400 left ›');
        expect(voucherRowWords('Rob', 1450)).toBe('@Rob · 1,450 left ›');
        expect(voucherRowWords('Rob', 400)).not.toMatch(/vouched|below zero| of /);
    });
    it('a voucher without a callsign reads "a voucher", never "@"', () => {
        expect(voucherRowWords('', 400)).toBe('a voucher · 400 left ›');
        expect(ownerRowWords('', 0)).toBe('a voucher · 0 vouched ›');
    });
    it('a waiting row names the person where the list is open, else says the name is on the phone', () => {
        expect(waitingRowWords({ level: 1000 }, 'Dee Dee')).toBe('Dee Dee · waiting to join · budget 1,000 ›');
        expect(waitingRowWords({ level: 1000 }, null)).toBe('Name on the phone · waiting to join · budget 1,000 ›');
        expect(waitingRowWords({ level: 500 }, '  ')).toBe('Name on the phone · waiting to join · budget 500 ›');
    });
    it('the invite panel’s link to the names list', () => {
        expect(inviteFromNamesListWords()).toBe('Invite someone from the names list ›');
    });
});

describe('the card puts its numbers first', () => {
    it('the headline, in the design’s words', () => {
        expect(voucherCardHeadline({ vouched: 350, peopleVouched: 4, vouchedLast30Days: 100, belowZero: 1, writtenOff: 0 }))
            .toBe('Vouched 350 to 4 people · 100 in the last 30 days · 1 below zero · written off 0');
    });
    it('one person is singular, none is "0 people"', () => {
        expect(voucherCardHeadline({ vouched: 100, peopleVouched: 1, vouchedLast30Days: 100, belowZero: 0, writtenOff: 0 }))
            .toBe('Vouched 100 to 1 person · 100 in the last 30 days · 0 below zero · written off 0');
        expect(voucherCardHeadline({ vouched: 0, peopleVouched: 0, vouchedLast30Days: 0, belowZero: 0, writtenOff: 0 }))
            .toBe('Vouched 0 to 0 people · 0 in the last 30 days · 0 below zero · written off 0');
    });
    it('a node that sends no 30-day figure (an older one) reads 0, never "undefined"', () => {
        expect(voucherCardHeadline({ vouched: 350, peopleVouched: 4, belowZero: 1, writtenOff: 25 }))
            .toBe('Vouched 350 to 4 people · 0 in the last 30 days · 1 below zero · written off 25');
    });
});

describe('the profile’s button follows the person’s state', () => {
    it('Add to the names list → Make a voucher → Voucher · 400 left ›', () => {
        expect(profileVoucherButtonWords({ state: 'add' })).toBe('Add to the names list');
        expect(profileVoucherButtonWords({ state: 'make' })).toBe('Make a voucher');
        expect(profileVoucherButtonWords({ state: 'voucher', left: 400, noLimit: false })).toBe('Voucher · 400 left ›');
    });
    it('an owner is "Voucher · No limit ›", with no figure', () => {
        expect(profileVoucherButtonWords({ state: 'voucher', left: 1000, noLimit: true })).toBe('Voucher · No limit ›');
    });
    it('shows only a state it knows (an older or newer node may say another)', () => {
        expect(isProfileVoucherButton({ state: 'add' })).toBe(true);
        expect(isProfileVoucherButton({ state: 'make' })).toBe(true);
        expect(isProfileVoucherButton({ state: 'voucher', left: 400, noLimit: false })).toBe(true);
        expect(isProfileVoucherButton({ state: 'voucher' })).toBe(false);
        expect(isProfileVoucherButton({ state: 'confirm' })).toBe(false);
        expect(isProfileVoucherButton(null)).toBe(false);
        expect(isProfileVoucherButton('add')).toBe(false);
        expect(isProfileVoucherButton(undefined)).toBe(false);
    });
});

describe('no balance figure anywhere in these words', () => {
    it('none of them says balance, and a budget left is the only amount a row carries', () => {
        const all = [
            ownersHeading(), waitingHeading(), ownerRowWords('Marty', 2), voucherRowWords('Rob', 400), waitingRowWords({ level: 1000 }, 'Dee Dee'),
            voucherCardHeadline({ vouched: 350, peopleVouched: 4, vouchedLast30Days: 100, belowZero: 1, writtenOff: 0 }),
            profileVoucherButtonWords({ state: 'add' }), profileVoucherButtonWords({ state: 'make' }),
            profileVoucherButtonWords({ state: 'voucher', left: 400, noLimit: false }), inviteFromNamesListWords(),
        ];
        for (const line of all) expect(line).not.toMatch(/balance/i);
    });
});

// + Make someone a voucher (invites-vouching I5; Marty, 10 Nov: admins are vouchers only when an owner makes them one).
describe('the make-voucher sheet’s words, one set for both apps', () => {
    it('two sections and one sentence for nobody', () => {
        expect(makeVoucherSheetTitle()).toBe('Make someone a voucher');
        expect(makeVoucherAdminsHeading()).toBe('Admins · no names-list entry needed');
        expect(makeVoucherConfirmedHeading()).toBe('Confirmed on the names list');
        expect(makeVoucherNobody()).toBe('Nobody to offer: every admin and everyone confirmed on the names list is a voucher already.');
    });
    it('the sentence for nobody is the true one for the viewer: an owner is told every admin is one; a committee admin is told only an owner makes an admin one (review, 10 Nov)', () => {
        expect(makeVoucherNobodyWords({ adminsOffered: true })).toBe(makeVoucherNobody());
        expect(makeVoucherNobodyWords(null)).toBe(makeVoucherNobody());
        expect(makeVoucherNobodyWords(undefined)).toBe(makeVoucherNobody());
        expect(makeVoucherNobodyWords({ adminsOffered: false })).toBe(makeVoucherNobodyForCommittee());
        expect(makeVoucherNobodyForCommittee()).toBe('Nobody confirmed on the names list is waiting to be made a voucher. Only an owner makes an admin a voucher.');
        expect(makeVoucherNobodyForCommittee()).not.toMatch(/every admin/i);
        expect(ownerMakesAdminVoucherWords()).toBe('Only an owner makes an admin a voucher.');
    });
    it('a row names the person from the list where the phone opened it, else by callsign', () => {
        expect(voucherCandidateWords('liz', 'Liz Moreau')).toBe('Liz Moreau · @liz');
        expect(voucherCandidateWords('liz', '  ')).toBe('@liz');
        expect(voucherCandidateWords('liz', null)).toBe('@liz');
    });
    it('the stepper, the button and the done line, numbers grouped, no balance', () => {
        expect(makeVoucherBudgetWords(1000)).toBe('Budget: 1,000 Beans');
        expect(makeVoucherButtonWords('@liz')).toBe('Make @liz a voucher');
        expect(madeVoucherWords('@liz', 1500)).toBe('@liz is a voucher now, with a budget of 1,500 Beans.');
        for (const line of [makeVoucherBudgetWords(1000), madeVoucherWords('@liz', 1500), makeVoucherNobody()]) expect(line).not.toMatch(/balance/i);
    });
});
