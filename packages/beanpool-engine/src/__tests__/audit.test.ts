import { describe, it, expect } from 'vitest';
import { compensatedSum, summariseLedger } from '../audit.js';

describe('Ledger sums', () => {
    it('keeps what a running sum of doubles loses between two large balances that cancel', () => {
        // The review's numbers (4116975493): a running sum gives 0.
        expect([1e20, 1000, -1e20].reduce((t, v) => t + v, 0)).toBe(0);
        expect(compensatedSum([1e20, 1000, -1e20])).toBe(1000);
        expect(compensatedSum([1000, 1e20, -1e20])).toBe(1000);
        expect(compensatedSum([-1e20, 1e20, 1000])).toBe(1000);
    });

    it('keeps many small balances under the step of a large running total', () => {
        // 10,000 at 9e11 take a running total to 9e15, where a double's step is 1: each 0.4 after it adds nothing.
        const values = [...Array(10_000).fill(9e11), ...Array(2_500).fill(0.4), ...Array(10_000).fill(-9e11)];
        expect(values.reduce((t, v) => t + v, 0)).toBe(0);
        expect(Math.abs(compensatedSum(values) - 1000)).toBeLessThan(1e-6);
    });

    it('is a plain sum on an ordinary ledger', () => {
        expect(compensatedSum([])).toBe(0);
        expect(compensatedSum([12.5, -9.82, 0.075, -2.755])).toBeCloseTo(0, 12);
    });

    it('overflows to Infinity as SQLite SUM does, not NaN (4117256520)', () => {
        // SQLite 3.51.3 (better-sqlite3 12.8.0), measured: SUM of 1e308, 1e308 is Infinity, and with -1e308 after it too.
        expect(compensatedSum([1e308, 1e308])).toBe(Infinity);
        expect(compensatedSum([1e308, 1e308, -1e308])).toBe(Infinity);
        expect(compensatedSum([-1e308, -1e308])).toBe(-Infinity);
        expect(compensatedSum([Infinity])).toBe(Infinity);
        expect(compensatedSum([-Infinity, 5])).toBe(-Infinity);
    });

    it('summarises a ledger with its sum as the accounts hold it', () => {
        const s = summariseLedger([
            { publicKey: 'a', balance: 1e20 },
            { publicKey: 'eve', balance: 1000 },
            { publicKey: 'b', balance: -1e20 },
        ]);
        expect(s.sum).toBe(1000);
        expect(s.accounts).toBe(3);
    });
});
