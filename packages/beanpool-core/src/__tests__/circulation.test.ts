/**
 * The Wallet's Community Circulation figure is the ledger's own demurrage (circulation.ts, PR #2020 fix round 1): a
 * month of `monthlyCirculation()` is exactly what LedgerManager takes from a balance left a month and credits to the
 * Commons, and nothing at or under the fee-free line.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LedgerManager } from '../ledger.js';
import * as core from '../ledger.js';
import { CIRCULATION_BRACKETS, CIRCULATION_FREE_BEANS, balanceAfterCirculation, circulationChargeOf, monthlyCirculation } from '../circulation.js';

describe('community circulation', () => {
    let ledger: LedgerManager;

    beforeEach(() => {
        core.setCommonsBalance(0);
        ledger = new LedgerManager();
    });

    /** What the ledger itself takes from `balance` over one month (30 epochs) of applyDecay, and credits the Commons. */
    const ledgerMonth = (balance: number) => {
        core.setCommonsBalance(0);
        ledger.loadState([{ id: 'm', balance_c: balance, lastDemurrageEpoch: ledger.getCurrentEpoch() - 30 }]);
        const after = ledger.getAccount('m').balance_c;
        ledger.drainDecayEvents();
        return { taken: balance - after, credited: core.COMMONS_BALANCE };
    };

    it('the free line is the first bracket, which costs nothing', () => {
        expect(CIRCULATION_FREE_BEANS).toBe(20000);
        expect(CIRCULATION_BRACKETS[0].rate).toBe(0);
    });

    it('matches EXACTLY what the ledger takes and credits the Commons over a month, for balances across every bracket', () => {
        for (const balance of [25000, 30000, 50000, 75000, 100000, 150000, 200000, 500000, 123457]) {
            const { taken, credited } = ledgerMonth(balance);
            expect(taken).toBeGreaterThan(0);
            expect(Number.isSafeInteger(taken)).toBe(true);
            expect(monthlyCirculation(balance)).toBe(taken);
            expect(monthlyCirculation(balance)).toBe(credited);
            // Truncated once: never above the curve's exact charge, never a whole hundredth below it.
            const exact = balance - balanceAfterCirculation(balance, 1);
            expect(taken).toBeLessThanOrEqual(exact);
            expect(taken).toBeGreaterThan(exact - 1);
        }
    });

    it('matches calculateDecay for part months and several months', () => {
        const epoch = ledger.getCurrentEpoch();
        for (const [balance, days] of [[75000, 7], [150000, 45], [300000, 90]] as const) {
            expect(ledger.calculateDecay(balance, epoch - days, epoch)).toBe(balance - circulationChargeOf(balance, days / 30));
        }
    });

    it('sends nothing at or under 200 Beans, and the ledger takes nothing there either', () => {
        for (const balance of [-5000, 0, 8500, 19999, 20000]) {
            expect(monthlyCirculation(balance)).toBe(0);
        }
        expect(ledgerMonth(8500).taken).toBe(0);
        expect(ledgerMonth(20000).taken).toBe(0);
    });

    it('is progressive: each rate applies only to the Beans in its bracket', () => {
        // 300: 100 Beans over the line at 1 % (1 Bean). 1500: 300 at 1 % + 500 at 1.5 % + 500 at 2 % (20.50 Beans).
        // The curve is a float: truncated, the charge is the exact figure or one hundredth under it, never over.
        expect(monthlyCirculation(30000)).toBeGreaterThanOrEqual(99);
        expect(monthlyCirculation(30000)).toBeLessThanOrEqual(100);
        expect(monthlyCirculation(150000)).toBeGreaterThanOrEqual(2049);
        expect(monthlyCirculation(150000)).toBeLessThanOrEqual(2050);
    });
});
