/**
 * The Wallet's Community Circulation figure is the ledger's own demurrage (circulation.ts, PR #2020 fix round 1): a
 * month of `monthlyCirculation()` is exactly what LedgerManager takes from a balance left a month and credits to the
 * Commons, and nothing at or under the fee-free line.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LedgerManager } from '../ledger.js';
import * as core from '../ledger.js';
import { CIRCULATION_BRACKETS, CIRCULATION_FREE_BEANS, balanceAfterCirculation, monthlyCirculation } from '../circulation.js';

describe('community circulation', () => {
    let ledger: LedgerManager;

    beforeEach(() => {
        core.setCommonsBalance(0);
        ledger = new LedgerManager();
    });

    /** What the ledger itself takes from `balance` over one month (30 epochs) of applyDecay, and credits the Commons. */
    const ledgerMonth = (balance: number) => {
        core.setCommonsBalance(0);
        ledger.loadState([{ id: 'm', balance, lastDemurrageEpoch: ledger.getCurrentEpoch() - 30 }]);
        const after = ledger.getAccount('m').balance;
        ledger.drainDecayEvents();
        return { taken: balance - after, credited: core.COMMONS_BALANCE };
    };

    it('the free line is the first bracket, which costs nothing', () => {
        expect(CIRCULATION_FREE_BEANS).toBe(200);
        expect(CIRCULATION_BRACKETS[0].rate).toBe(0);
    });

    it('matches what the ledger takes and credits the Commons over a month, for balances across every bracket', () => {
        for (const balance of [250, 300, 500, 750, 1000, 1500, 2000, 5000]) {
            const { taken, credited } = ledgerMonth(balance);
            expect(taken).toBeGreaterThan(0);
            expect(monthlyCirculation(balance)).toBeCloseTo(taken, 10);
            expect(monthlyCirculation(balance)).toBeCloseTo(credited, 10);
            expect(balanceAfterCirculation(balance, 1)).toBeCloseTo(balance - taken, 10);
        }
    });

    it('matches calculateDecay for part months and several months', () => {
        const epoch = ledger.getCurrentEpoch();
        for (const [balance, days] of [[750, 7], [1500, 45], [3000, 90]] as const) {
            expect(balanceAfterCirculation(balance, days / 30)).toBeCloseTo(ledger.calculateDecay(balance, epoch - days, epoch), 10);
        }
    });

    it('sends nothing at or under 200 Beans, and the ledger takes nothing there either', () => {
        for (const balance of [-50, 0, 85, 199.99, 200]) {
            expect(monthlyCirculation(balance)).toBe(0);
        }
        expect(ledgerMonth(85).taken).toBe(0);
        expect(ledgerMonth(200).taken).toBe(0);
    });

    it('is progressive: each rate applies only to the Beans in its bracket', () => {
        // 300: 100 Beans over the line at 1 %. 1500: 300 at 1 % + 500 at 1.5 % + 500 at 2 %.
        expect(monthlyCirculation(300)).toBeCloseTo(1, 10);
        expect(monthlyCirculation(1500)).toBeCloseTo(3 + 7.5 + 10, 10);
    });
});
