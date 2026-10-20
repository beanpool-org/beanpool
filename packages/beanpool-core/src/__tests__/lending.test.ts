import { describe, expect, it } from 'vitest';
import { isLendablePriceType, lendBackAroundOf, loanDays } from '../lending.js';

describe('loanDays', () => {
    it('counts days for one fee or a fee per day, and seven a week', () => {
        expect(loanDays('fixed', 3)).toBe(3);
        expect(loanDays(undefined, 3)).toBe(3);
        expect(loanDays('daily', 2.5)).toBe(2.5);
        expect(loanDays('weekly', 2)).toBe(14);
    });
    it('knows no length without a quantity, or for a price a loan never has', () => {
        for (const units of [undefined, null, 0, -1, NaN, Infinity, '3', true]) expect(loanDays('daily', units)).toBe(null);
        expect(loanDays('hourly', 3)).toBe(null);
        expect(loanDays('monthly', 1)).toBe(null);
    });
});

describe('lendBackAroundOf', () => {
    it('is the hand-over day plus the loan', () => {
        expect(lendBackAroundOf('2026-10-20T09:00:00.000Z', 'fixed', 3)).toBe('2026-10-23T09:00:00.000Z');
        expect(lendBackAroundOf('2026-10-20T09:00:00.000Z', 'weekly', 1)).toBe('2026-10-27T09:00:00.000Z');
    });
    it('is unknown without both', () => {
        expect(lendBackAroundOf(null, 'daily', 3)).toBe(null);
        expect(lendBackAroundOf('not a time', 'daily', 3)).toBe(null);
        expect(lendBackAroundOf('2026-10-20T09:00:00.000Z', 'fixed', null)).toBe(null);
        expect(lendBackAroundOf('2026-10-20T09:00:00.000Z', 'daily', 1e300)).toBe(null);
    });
});

describe('isLendablePriceType', () => {
    it('takes one fee, per day and per week', () => {
        expect(['fixed', 'daily', 'weekly', undefined].map(isLendablePriceType)).toEqual([true, true, true, true]);
        expect(['hourly', 'monthly', 'other', 7].map(isLendablePriceType)).toEqual([false, false, false, false]);
    });
});
