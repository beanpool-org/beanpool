import { describe, it, expect } from 'vitest';
import {
    MONEY_RESEND_HOURS, MONEY_RETRY_WORDS, firstSending, heldAfterChange, heldAged, heldAgesInMs, heldResend, moneyResendable, payAgedLine,
} from '../money-retry';

/**
 * One rule for every money write an app keeps to send again with its retry id (core money-retry.ts): a day from its FIRST
 * sending, strictly inside the node's REQUEST_ID_KEPT_DAYS (7; the node's suite test-commons-pay-idempotent-http step 9
 * pins that). Past it a held payment is aged: never sent again, and a new payment starts afresh. Pay the Commons (both
 * apps) holds its payment through HeldPayment here.
 */
const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 10, 27, 9, 0, 0);
/** What either app's confirmCommonsPayment makes: an id, and the body every send of it carries. */
const PAYMENT = Object.freeze({ requestId: 'pay-0001', body: Object.freeze({ amount_c: 500, requestId: 'pay-0001' }) });

describe('a held payment over its age (the brief: fresh, 23 h, 25 h, 8 d)', () => {
    const rows: Array<[string, number, 'resend' | 'aged']> = [
        ['just sent', 0, 'resend'],
        ['a minute later', 60_000, 'resend'],
        ['23 hours later', 23 * H, 'resend'],
        ['the last moment of the day', DAY - 1, 'resend'],
        ['exactly a day later', DAY, 'aged'],
        ['25 hours later', 25 * H, 'aged'],
        ['6 days later (the node may still know it: never sent anyway)', 6 * DAY, 'aged'],
        ['8 days later (the node has forgotten its id)', 8 * DAY, 'aged'],
        ['a clock set back 5 minutes (a network time fix)', -5 * 60_000, 'resend'],
        ['a clock set back 10 minutes', -10 * 60_000, 'resend'],
        ['a clock set back 11 minutes: the age is unknown', -11 * 60_000, 'aged'],
        ['a clock set back a day', -DAY, 'aged'],
    ];
    for (const [name, age, want] of rows) {
        it(`${name}: ${want === 'resend' ? 'Try again sends it, same id, same stamp' : 'never sent again; a new payment starts'}`, () => {
            const held = firstSending(PAYMENT, T0);
            const now = T0 + age;
            expect(moneyResendable(held.sentAt, now)).toBe(want === 'resend');
            if (want === 'resend') {
                expect(heldResend(held, now)).toBe(held);
                expect(heldAged(held, now)).toBeNull();
                // The member changed the amount or the code: the next is a new payment, so nothing is held.
                expect(heldAfterChange(held, now)).toBeNull();
            } else {
                expect(heldResend(held, now)).toBeNull();
                expect(heldAged(held, now)).toBe(held);
                // An aged payment is never sent: it stays only to keep its line up until the next payment goes.
                expect(heldAfterChange(held, now)).toBe(held);
            }
        });
    }

    it('the window is a day, strictly inside the node’s 7 days with days to spare', () => {
        expect(MONEY_RESEND_HOURS).toBe(24);
        expect(MONEY_RESEND_HOURS * H + DAY).toBeLessThanOrEqual(7 * DAY);
    });

    it('a stamp that is not a time is an age that can’t be told: never sent again', () => {
        for (const sentAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            const held = { payment: PAYMENT, sentAt };
            expect(moneyResendable(sentAt, T0)).toBe(false);
            expect(heldResend(held, T0)).toBeNull();
            expect(heldAged(held, T0)).toBe(held);
        }
        expect(moneyResendable(T0, Number.NaN)).toBe(false);
    });

    it('nothing held: nothing to send, nothing aged', () => {
        for (const held of [null, undefined]) {
            expect(heldResend(held, T0)).toBeNull();
            expect(heldAged(held, T0)).toBeNull();
            expect(heldAfterChange(held, T0)).toBeNull();
            expect(heldAgesInMs(held, T0)).toBeNull();
        }
    });

    it('a screen left open is told when to draw itself again: at the moment the payment ages, never after', () => {
        const held = firstSending(PAYMENT, T0);
        expect(heldAgesInMs(held, T0)).toBe(DAY);
        expect(heldAgesInMs(held, T0 + 23 * H)).toBe(H);
        expect(heldAgesInMs(held, T0 + DAY - 1)).toBe(1);
        // Drawn again at that moment, it has aged: Try again is no longer offered.
        expect(heldResend(held, T0 + heldAgesInMs(held, T0)!)).toBeNull();
        for (const age of [DAY, 25 * H, 8 * DAY, -DAY]) expect(heldAgesInMs(held, T0 + age)).toBeNull();
    });
});

describe('the stamp is the FIRST sending', () => {
    it('sent again at 23 hours, its answer lost again: it keeps the first stamp, so at 25 hours it has aged', () => {
        const first = firstSending(PAYMENT, T0);
        // Try again at 23 h hands back the very same held payment (stamp and all); the screen holds it again on a lost answer.
        const again = heldResend(first, T0 + 23 * H);
        expect(again).toBe(first);
        expect(again!.sentAt).toBe(T0);
        expect(heldResend(again, T0 + 25 * H)).toBeNull();
        expect(heldAged(again, T0 + 25 * H)!.payment.requestId).toBe('pay-0001');
    });

    it('a new payment after an aged one is stamped afresh: it is sent again for a whole day of its own', () => {
        const aged = firstSending(PAYMENT, T0);
        const later = T0 + 8 * DAY;
        expect(heldAged(aged, later)).toBe(aged);
        const fresh = firstSending({ requestId: 'pay-0002', body: { amount_c: 500, requestId: 'pay-0002' } }, later);
        expect(heldResend(fresh, later + 23 * H)).toBe(fresh);
        expect(heldResend(fresh, later + 25 * H)).toBeNull();
    });

    it('a held payment is frozen: nothing can move its stamp', () => {
        const held = firstSending(PAYMENT, T0);
        expect(Object.isFrozen(held)).toBe(true);
        expect(() => { (held as { sentAt: number }).sentAt = T0 + 100 * DAY; }).toThrow();
    });
});

describe('the aged line', () => {
    it('says it may have gone through, where to see it, and that the button makes a new payment; never "nothing was paid" or "never paid twice"', () => {
        const line = payAgedLine();
        expect(line).toBe('An earlier payment from here got no answer, so it may have gone through: your Ledger shows whether it did. Pay the Commons makes a new payment.');
        expect(MONEY_RETRY_WORDS.payAged).toBeTruthy();
        expect(line).not.toMatch(/nothing was|never paid twice|Try again/i);
    });
});
