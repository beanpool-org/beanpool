import { describe, it, expect } from 'vitest';
import { summariseLedger } from '../audit.js';

// Balances are whole hundredths (@beanpool/core hundredths.ts): integers sum exactly, so the compensated float sum that
// stood here (and its tests) went with the floats.
describe('Ledger summary in whole hundredths', () => {
    it('sums exactly, however large the balances that cancel', () => {
        const s = summariseLedger([
            { publicKey: 'a', balance_c: 9_000_000_000_000 },
            { publicKey: 'eve', balance_c: 1000 },
            { publicKey: 'b', balance_c: -9_000_000_000_000 },
        ]);
        expect(s.sum).toBe(1000);
        expect(s.accounts).toBe(3);
        expect(s.holdings).toBe(18_000_000_001_000);
    });

    it('fingerprints key and hundredths, in any order, and leaves an empty account out', () => {
        const one = summariseLedger([{ publicKey: 'a', balance_c: 4925 }, { publicKey: 'b', balance_c: -982 }, { publicKey: 'z', balance_c: 0 }]);
        const two = summariseLedger([{ publicKey: 'b', balance_c: -982 }, { publicKey: 'a', balance_c: 4925 }]);
        expect(one.digest).toBe(two.digest);
        expect(one.accounts).toBe(2);
        // One hundredth anywhere is another ledger.
        expect(summariseLedger([{ publicKey: 'a', balance_c: 4926 }, { publicKey: 'b', balance_c: -982 }]).digest).not.toBe(one.digest);
    });

    it('counts a balance that is not whole hundredths as none', () => {
        const s = summariseLedger([{ publicKey: 'a', balance_c: 49.25 }, { publicKey: 'b', balance_c: '4925' }, { publicKey: 'c', balance_c: 100 }]);
        expect(s.sum).toBe(100);
        expect(s.accounts).toBe(1);
    });
});
