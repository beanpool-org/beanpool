import { describe, it, expect } from 'vitest';
import {
    BILL_RULES, billLines, billMoneyLine, billNeedsLine, billNetOf, billSentLine, billWhatForOf, isBillAmount, type BillBalanceRead,
} from '../bills';
import { needsYouCounts } from '../needs-you';
import { feeOf } from '../hundredths';

/** Beans as whole hundredths, as every figure here is. */
const c = (beans: number) => Math.round(beans * 100);
const read = (balance: number, usable: number, floor: number, liveOffers: number): BillBalanceRead =>
    ({ balance_c: c(balance), usableFloor_c: c(usable), floor_c: c(floor), liveOffers });
const UNTIL = '12 Dec';

describe('billMoneyLine: the five cases of DESIGN-getting-paid-fable §4.3, at their boundaries', () => {
    it('holds enough: exactly the amount, and more', () => {
        const exact = billMoneyLine(c(60), read(60, 0, 0, 0), false, UNTIL);
        expect(exact).toEqual({ case: 'holds', line: 'You have 60 Beans. After this: 0.', canPay: true, postOffer: false });
        expect(billMoneyLine(c(60), read(85, -200, -1000, 1), false, UNTIL).line).toBe('You have 85 Beans. After this: 25.');
    });

    it('dealt before, room on the line: down to the usable floor exactly, and not one hundredth past it', () => {
        const atFloor = billMoneyLine(c(140), read(0, -140, -1000, 1), true, UNTIL);
        expect(atFloor).toEqual({ case: 'credit', line: 'This takes you to 140 Beans below zero. Your line goes to 140.', canPay: true, postOffer: false });
        expect(billMoneyLine(c(160), read(20, -1000, -1000, 3), true, UNTIL).line).toBe('This takes you to 140 Beans below zero. Your line goes to 1,000.');
        const past = billMoneyLine(c(140) + 1, read(0, -140, -140, 1), true, UNTIL);
        expect(past.canPay).toBe(false);
        expect(past.case).toBe('nothing');
    });

    it('dealt before, an allowance but no live Offer: Post an Offer, Pay off', () => {
        const line = billMoneyLine(c(60), read(0, 0, -1000, 0), true, UNTIL);
        expect(line).toEqual({ case: 'open_line', line: 'Post an Offer to open your credit line, then you can pay this.', canPay: false, postOffer: true });
        // An allowance too small for it is no open line: nothing to pay with.
        expect(billMoneyLine(c(60), read(0, 0, -50, 0), true, UNTIL).case).toBe('nothing');
    });

    it('never dealt, holds too little: held Beans only, whatever the line', () => {
        const line = billMoneyLine(c(60), read(12, -1000, -1000, 4), false, UNTIL);
        expect(line.case).toBe('first_bill');
        expect(line.canPay).toBe(false);
        expect(line.postOffer).toBe(true);
        expect(line.line).toBe('A first bill from someone can only be paid with Beans you hold. You hold 12. Earn Beans by selling or helping: post an Offer. The bill waits until 12 Dec.');
        // One hundredth short of the amount is still too little.
        expect(billMoneyLine(c(60), read(59.99, -1000, -1000, 4), false, UNTIL).case).toBe('first_bill');
    });

    it('anyone, nothing to pay with', () => {
        const none = billMoneyLine(c(60), read(0, 0, 0, 0), false, UNTIL);
        expect(none).toEqual({
            case: 'nothing', canPay: false, postOffer: true,
            line: 'You need 60 Beans to pay this. Earn Beans by selling or helping: post an Offer. The bill waits until 12 Dec.',
        });
        // Below zero already and never dealt: nothing held to pay with.
        expect(billMoneyLine(c(60), read(-30, -200, -200, 1), false, UNTIL).case).toBe('nothing');
        // A frozen line (below the usable floor already), dealt: nothing.
        expect(billMoneyLine(c(10), read(-250, -200, -200, 1), true, UNTIL).case).toBe('nothing');
    });

    it('Pay is on in exactly the two cases the node pays', () => {
        const cases: Array<[BillBalanceRead, boolean]> = [
            [read(100, 0, 0, 0), false], [read(10, -500, -500, 2), true], [read(0, 0, -500, 0), true], [read(5, -500, -500, 2), false], [read(0, 0, 0, 0), false],
        ];
        for (const [r, open] of cases) {
            const line = billMoneyLine(c(50), r, open, UNTIL);
            expect(line.canPay).toBe(line.case === 'holds' || line.case === 'credit');
            expect(line.postOffer).toBe(!line.canPay);
        }
    });
});

describe('the sender never reads the payer\'s balance, or why a bill is not paid', () => {
    it('no sentence for the sender carries a figure but the bill\'s own', () => {
        const day = () => '14 Nov';
        const base = { payerName: 'Kim', whatFor: 'Power, October', amount_c: c(60), sentAt: '2026-11-12T00:00:00Z', paidAt: null };
        expect(billSentLine({ ...base, state: 'sent' }, day)).toBe('Kim · Power, October · 60 Beans · sent 14 Nov · not paid');
        // Declined reads as not paid: the sender's line is the same.
        expect(billSentLine({ ...base, state: 'declined' }, day)).toBe(billSentLine({ ...base, state: 'sent' }, day));
        expect(billSentLine({ ...base, state: 'paid', paidAt: '2026-11-14T00:00:00Z' }, day)).toBe('Kim · Power, October · 60 Beans · paid 14 Nov · 59.10 Beans received');
        expect(billSentLine({ ...base, state: 'expired' }, day)).toBe('Kim · Power, October · 60 Beans · expired, not paid');
        expect(billLines.paidToSender('Kim', 'Power, October', c(60))).toBe("Kim paid your bill: Power, October · 60 Beans (59.10 after the community's 1.5%).");
        expect(billLines.youReceive(c(60))).toBe('You receive 59.10 of 60 Beans: 1.5% goes to the community.');
    });
});

describe('the bell: a stranger\'s bill is listed and not counted', () => {
    const bill = { id: 'b1', role: 'to-pay' as const, state: 'sent' as const, billerName: 'Zed', whatFor: 'Bike repair', amount_c: c(300) };
    it('from someone known: amber, counted', () => {
        const line = billNeedsLine({ ...bill, billerName: 'Rob', whatFor: 'Power, October', amount_c: c(60), known: true })!;
        expect(line).toEqual({ billId: 'b1', label: 'Bill from Rob: Power, October · 60 Beans', accent: true });
        expect(needsYouCounts({ kind: 'bill', accent: line.accent })).toBe(true);
    });
    it('from a stranger: calm, listed, never counted', () => {
        const line = billNeedsLine({ ...bill, known: false })!;
        expect(line.label).toBe("Bill from Zed, who you haven't dealt with: Bike repair · 300 Beans");
        expect(line.accent).toBe(false);
        expect(needsYouCounts({ kind: 'bill', accent: line.accent })).toBe(false);
    });
    it('no line for the sender, or for a bill no longer waiting', () => {
        expect(billNeedsLine({ ...bill, role: 'sent', known: true })).toBeNull();
        for (const state of ['paid', 'declined', 'withdrawn', 'expired'] as const) expect(billNeedsLine({ ...bill, state, known: true })).toBeNull();
    });
});

describe('the rules', () => {
    it('an amount is more than 0 and at most 2,000 Beans, in whole hundredths', () => {
        expect(isBillAmount(1)).toBe(true);
        expect(isBillAmount(BILL_RULES.maxAmount_c)).toBe(true);
        for (const bad of [0, -1, BILL_RULES.maxAmount_c + 1, 1.5, '100', null, Number.NaN]) expect(isBillAmount(bad)).toBe(false);
    });
    it('what it is for is 3 to 80 characters, trimmed, spaces folded', () => {
        expect(billWhatForOf('  Power,   October ')).toBe('Power, October');
        expect(billWhatForOf('ab')).toBeNull();
        expect(billWhatForOf('abc')).toBe('abc');
        expect(billWhatForOf('x'.repeat(80))).toBe('x'.repeat(80));
        expect(billWhatForOf('x'.repeat(81))).toBeNull();
        // Counted as a person counts: one emoji is one character.
        expect(billWhatForOf('🏠🏠🏠')).toBe('🏠🏠🏠');
        expect(billWhatForOf(42)).toBeNull();
    });
    it('the sender receives the amount less the fee the ledger takes, truncated once', () => {
        expect(billNetOf(c(60))).toBe(c(60) - feeOf(c(60)));
        expect(billNetOf(c(60))).toBe(c(59.1));
        expect(billNetOf(66)).toBe(66);
        expect(billNetOf(0)).toBe(0);
    });
});
