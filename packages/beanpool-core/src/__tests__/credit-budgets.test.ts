/**
 * Vouchers' budgets on the view, in core (scratch/fable-design/DESIGN-credit-list-amend-fable.md §3.5, §8 tests 18 and 19;
 * slice C3): running low, nothing left, and the one level "Top up to" offers. Each check names the change that turns it red.
 */
import { describe, expect, it } from 'vitest';
import { nothingLeft, runningLow, topUpTarget, TOP_UP_LEVELS } from '../credit-sight.js';
import { VOUCH_MAX, VOUCHER_BUDGET_DEFAULT, VOUCHER_BUDGET_MAX, VOUCH_PRESETS } from '../vouch-presets.js';

describe('running low (test 18)', () => {
    it('flags under 100 left, not at 100 (red when the threshold leaves VOUCH_MAX)', () => {
        expect(runningLow(10000)).toBe(false);
        expect(runningLow(9999)).toBe(true);
        expect(runningLow(0)).toBe(true);
        expect(runningLow(VOUCH_MAX)).toBe(false);
        expect(runningLow(VOUCH_MAX - 1)).toBe(true);
    });
    it('reads what is left, never the level (red when the level is read instead)', () => {
        // A 2,000 budget with 99.99 left is running low; a 100 budget with 100 left is not.
        expect(runningLow(9999)).toBe(true);
        expect(runningLow(10000)).toBe(false);
    });
    it('nothing left under the smallest vouch (25), not at 25', () => {
        expect(Math.min(...VOUCH_PRESETS)).toBe(2500);
        expect(nothingLeft(2500)).toBe(false);
        expect(nothingLeft(2499)).toBe(true);
        expect(nothingLeft(0)).toBe(true);
        expect(nothingLeft(9999)).toBe(false);
    });
});

describe('the top-up offer (test 19)', () => {
    it('the level last set when they have less in hand: last set 500 with 150 in hand → 500', () => {
        expect(topUpTarget(15000, 50000)).toBe(50000);
    });
    it('the next of 500 · 1,000 · 1,500 · 2,000 above what they have in hand: 500 in hand, last set 500 → 1,000', () => {
        expect(topUpTarget(50000, 50000)).toBe(100000);
        expect(topUpTarget(120000, 100000)).toBe(150000);
        expect(topUpTarget(199900, 100000)).toBe(200000);
        expect(topUpTarget(0, 0)).toBe(50000);
    });
    it('none at the ceiling: 2,000 in hand → null', () => {
        expect(topUpTarget(VOUCHER_BUDGET_MAX, 100000)).toBeNull();
        expect(topUpTarget(VOUCHER_BUDGET_MAX, VOUCHER_BUDGET_MAX)).toBeNull();
    });
    it("no line: the community's setting is the last level (the caller passes it)", () => {
        expect(topUpTarget(30000, VOUCHER_BUDGET_DEFAULT)).toBe(VOUCHER_BUDGET_DEFAULT);
    });
    it('a last level that is not a budget level is never offered', () => {
        expect(topUpTarget(15000, 12345)).toBe(50000);
        expect(topUpTarget(15000, 300000)).toBe(50000);
    });
    it('the offer is always a budget level and above what is in hand', () => {
        expect(TOP_UP_LEVELS).toEqual([50000, 100000, 150000, 200000]);
        for (let inHand = 0; inHand < VOUCHER_BUDGET_MAX; inHand += 2500) {
            for (const last of [10000, 50000, 100000, 200000]) {
                const t = topUpTarget(inHand, last)!;
                expect(t).toBeGreaterThan(inHand);
                expect(t % 10000).toBe(0);
                expect(t).toBeLessThanOrEqual(VOUCHER_BUDGET_MAX);
            }
        }
    });
});
