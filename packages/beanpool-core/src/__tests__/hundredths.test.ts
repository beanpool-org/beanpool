/**
 * Beans as whole hundredths (hundredths.ts; DESIGN-atomic-beans-fable.md §5 T2, T6, T9, and the ledger's half of T1/T3).
 * Each case is one that a float, a double rounding, a rounding toward the Commons or a dropped hundredth would fail.
 */
import { describe, expect, it } from 'vitest';
import {
    FEE_DEN, FEE_NUM, MINUS_SIGN, beans, feeOf, formatHundredths, halves, hundredthsAsDecimalText, isHundredths, isMoveAmount,
    parseHundredths, shareOf,
} from '../hundredths.js';
import { COMMONS_BALANCE, ESCROW_FLOOR, LedgerManager, setCommonsBalance } from '../ledger.js';
import { CIRCULATION_FREE_BEANS, circulationChargeOf, monthlyCirculation } from '../circulation.js';
import { OFFER_BANDS, PROTOCOL_CONSTANTS, KNOWN_FLOOR_DEFAULT, CREDIT_CAP_MAX, usableAllowance } from '../protocol.js';
import { VOUCH_PRESETS, isVouchPreset, isBudgetLevel } from '../vouch-presets.js';

describe('isHundredths: the check every boundary asks', () => {
    it('takes safe integers of any sign, nothing else', () => {
        for (const ok of [0, 1, -1, 4925, -982, 2 ** 53 - 1]) expect(isHundredths(ok)).toBe(true);
        for (const bad of [0.5, 20.5, '2000', NaN, Infinity, -Infinity, 2 ** 53, null, undefined, {}]) expect(isHundredths(bad)).toBe(false);
    });
    it('a move carries 0 or more', () => {
        expect(isMoveAmount(0)).toBe(true);
        expect(isMoveAmount(-1)).toBe(false);
    });
});

describe('beans(): whole Beans to hundredths, for constants only', () => {
    it('multiplies by 100 and refuses anything that is not whole Beans', () => {
        expect(beans(500)).toBe(50000);
        expect(beans(0)).toBe(0);
        expect(() => beans(1.5)).toThrow();
        expect(() => beans(2 ** 52)).toThrow();
    });
});

describe('T2 the fee: truncated once, the remainder stays with the payee', () => {
    it('is 15/1000 read only through feeOf', () => {
        expect([FEE_NUM, FEE_DEN]).toEqual([15, 1000]);
    });
    it.each([
        [1, 0], [66, 0], [67, 1], [100, 1], [199, 2], [200, 3], [6667, 100], [1_000_000, 15_000],
    ])('feeOf(%i) is %i', (amount, fee) => {
        expect(feeOf(amount)).toBe(fee);
    });
    it('fee + net === amount over 10,000 random amounts, and never more than the amount', () => {
        let seed = 12345;
        const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
        for (let i = 0; i < 10_000; i++) {
            const amount = next() % 10_000_000;
            const fee = feeOf(amount);
            expect(Number.isSafeInteger(fee)).toBe(true);
            expect(fee + (amount - fee)).toBe(amount);
            expect(fee).toBeLessThanOrEqual(amount);
            // Truncation, never rounding up: the exact share is at least the fee and less than the fee plus one.
            expect(amount * 15).toBeGreaterThanOrEqual(fee * 1000);
            expect(amount * 15).toBeLessThan((fee + 1) * 1000);
        }
    });
    it('shareOf refuses a negative, a float or a product past 2^53', () => {
        expect(() => shareOf(-1, 15, 1000)).toThrow();
        expect(() => shareOf(1.5, 15, 1000)).toThrow();
        expect(() => shareOf(2 ** 52, 4, 1)).toThrow();
        expect(() => shareOf(10, 1, 0)).toThrow();
    });
});

describe('T9 halves: the first share truncated, the last takes the rest', () => {
    it('splits odd amounts without losing a hundredth', () => {
        expect(halves(1235)).toEqual([617, 618]);
        expect(halves(1)).toEqual([0, 1]);
        expect(halves(0)).toEqual([0, 0]);
        for (let t = 0; t < 2000; t++) {
            const [a, b] = halves(t);
            expect(a + b).toBe(t);
            expect(b - a === 0 || b - a === 1).toBe(true);
        }
    });
});

describe('T6 display: formatHundredths and parseHundredths', () => {
    it.each([
        [1, '0.01'], [100, '1'], [4925, '49.25'], [-982, `${MINUS_SIGN}9.82`], [50000, '500'], [123456, '1,234.56'], [4950, '49.50'],
    ])('en %i → %s', (c, text) => {
        expect(formatHundredths(c, 'en')).toBe(text);
    });
    it('fr writes a decimal comma and no grouping', () => {
        expect(formatHundredths(123456, 'fr')).toBe('1234,56');
        expect(formatHundredths(-982, 'fr')).toBe(`${MINUS_SIGN}9,82`);
    });
    it('never writes a number for something that is not whole hundredths', () => {
        expect(formatHundredths(49.25, 'en')).toBe('—');
        expect(formatHundredths('4925', 'en')).toBe('—');
        expect(formatHundredths(undefined, 'en')).toBe('—');
    });
    it('parses the five back exactly, by string work', () => {
        expect(parseHundredths('0.01', 'en')).toEqual({ ok: true, value: 1 });
        expect(parseHundredths('1', 'en')).toEqual({ ok: true, value: 100 });
        expect(parseHundredths('49.25', 'en')).toEqual({ ok: true, value: 4925 });
        expect(parseHundredths('500', 'en')).toEqual({ ok: true, value: 50000 });
        expect(parseHundredths('49,25', 'fr')).toEqual({ ok: true, value: 4925 });
        expect(parseHundredths('0.5', 'en')).toEqual({ ok: true, value: 50 });
        // 0.29 * 100 is 28.999999999999996 as a float: the string work never makes it.
        expect(parseHundredths('0.29', 'en')).toEqual({ ok: true, value: 29 });
        expect(parseHundredths('1.15', 'en')).toEqual({ ok: true, value: 115 });
    });
    it('refuses what a member could not mean, as parseAmount does', () => {
        expect(parseHundredths('', 'en')).toEqual({ ok: false, refusal: 'empty' });
        expect(parseHundredths('1,000', 'en')).toEqual({ ok: false, refusal: 'grouped' });
        expect(parseHundredths('1.2.3', 'en')).toEqual({ ok: false, refusal: 'two-separators' });
        expect(parseHundredths('-5', 'en')).toEqual({ ok: false, refusal: 'negative' });
        expect(parseHundredths('1.234', 'en')).toEqual({ ok: false, refusal: 'too-many-decimals' });
        expect(parseHundredths('abc', 'en')).toEqual({ ok: false, refusal: 'not-a-number' });
        expect(parseHundredths('9999999999999999', 'en')).toEqual({ ok: false, refusal: 'not-a-number' });
    });
    it('round-trips every figure from 0 to 100,000 through the words', () => {
        for (let c = 0; c <= 100_000; c += 7) {
            expect(parseHundredths(formatHundredths(c, 'fr'), 'fr')).toEqual({ ok: true, value: c });
        }
    });
    it('machine text is plain ASCII', () => {
        expect(hundredthsAsDecimalText(-982)).toBe('-9.82');
        expect(hundredthsAsDecimalText(4950)).toBe('49.50');
        expect(hundredthsAsDecimalText(100)).toBe('1');
    });
});

describe('the constants are hundredths (Q3: credit room too)', () => {
    it('reads 25, 50, 75, 100 and holds 2500 to 10000', () => {
        expect(VOUCH_PRESETS).toEqual([2500, 5000, 7500, 10000]);
        expect(isVouchPreset(2500)).toBe(true);
        expect(isVouchPreset(25)).toBe(false);
        expect(isBudgetLevel(10000)).toBe(true);
        expect(isBudgetLevel(100)).toBe(false);
    });
    it('caps, floors and bands are in the one unit', () => {
        expect(OFFER_BANDS).toEqual([0, 20000, 50000, 100000, 150000, 200000]);
        expect(PROTOCOL_CONSTANTS.CREDIT_FLOOR_CAP).toBe(200000);
        expect(PROTOCOL_CONSTANTS.PER_COUNTERPARTY_VOLUME_CAP).toBe(50000);
        expect(KNOWN_FLOOR_DEFAULT).toBe(100000);
        expect(CREDIT_CAP_MAX).toBe(500000);
        // T3: a vouch of 2,500 with one live offer is usable whole.
        expect(usableAllowance({ knownGrant: 0, roomHeld: 2500, otherAllowance: 0, cap: 200000, liveOffers: 1 })).toBe(2500);
    });
});

describe('the core ledger moves whole hundredths', () => {
    it('T3 a send landing exactly on the floor passes; one hundredth more is refused', () => {
        const l = new LedgerManager();
        l.initializeGenesisAccount('a');
        l.initializeGenesisAccount('b');
        expect(l.transfer('a', 'b', 4925, -4925, true)).toEqual({ ok: true, fee: 0 });
        expect(l.getAccount('a').balance).toBe(-4925);
        expect(l.transfer('a', 'b', 1, -4925, true).ok).toBe(false);
        expect(l.getAccount('a').balance).toBe(-4925);
    });
    it('a 1-Bean deal pays 99 to the seller and 1 to the pot, and returns the fee it took', () => {
        setCommonsBalance(0);
        const l = new LedgerManager();
        l.initializeGenesisAccount('buyer');
        l.initializeGenesisAccount('seller');
        expect(l.transfer('buyer', 'seller', 100, -100)).toEqual({ ok: true, fee: 1 });
        expect(l.getAccount('buyer').balance).toBe(-100);
        expect(l.getAccount('seller').balance).toBe(99);
        expect(COMMONS_BALANCE).toBe(1);
    });
    it('refuses a float, a string or a negative before anything moves', () => {
        const l = new LedgerManager();
        for (const bad of [20.5, '2000' as unknown as number, -1, NaN]) {
            expect(l.transfer('a', 'b', bad, -100000).ok).toBe(false);
        }
        expect(l.getAccount('a').balance).toBe(0);
    });
    it('an escrow pays out exactly what it holds, never a hundredth more', () => {
        expect(ESCROW_FLOOR).toBe(0);
        const l = new LedgerManager([{ id: 'escrow_x', balance: 1235, lastDemurrageEpoch: 0 }]);
        const [buyer, seller] = halves(1235);
        expect(l.transfer('escrow_x', 'b', buyer, -Infinity, true).ok).toBe(true);
        expect(l.transfer('escrow_x', 's', seller + 1, -Infinity, true).ok).toBe(false);
        expect(l.transfer('escrow_x', 's', seller, -Infinity, true).ok).toBe(true);
        expect(l.getAccount('escrow_x').balance).toBe(0);
    });
    it('T1 (core) 20,000 random moves with fees over 50 accounts conserve to the hundredth', () => {
        setCommonsBalance(0);
        const ids = Array.from({ length: 50 }, (_, i) => `m${i}`);
        const l = new LedgerManager(ids.map((id) => ({ id, balance: 0, lastDemurrageEpoch: l0() })));
        let seed = 7;
        const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
        for (let i = 1; i <= 20_000; i++) {
            const from = ids[next() % 50];
            const to = ids[next() % 50];
            const amount = next() % 50_000;
            l.transfer(from, to, amount, -200000, next() % 3 === 0);
            if (i % 1000 === 0) {
                const sum = ids.reduce((s, id) => s + l.getAccount(id).balance, 0) + COMMONS_BALANCE;
                expect(sum).toBe(0);
                for (const id of ids) expect(Number.isSafeInteger(l.getAccount(id).balance)).toBe(true);
            }
        }
    });
});

function l0(): number {
    return Math.floor(Date.now() / 86_400_000);
}

describe('T8 circulation: a whole charge, truncated once', () => {
    it('charges nothing at or under the free 200 Beans', () => {
        expect(CIRCULATION_FREE_BEANS).toBe(20000);
        expect(monthlyCirculation(20000)).toBe(0);
    });
    it('1,000 Beans for 30 days is a whole charge the account and pot share exactly', () => {
        const charge = circulationChargeOf(100000, 1);
        expect(Number.isSafeInteger(charge)).toBe(true);
        expect(charge).toBeGreaterThan(0);
        setCommonsBalance(0);
        const today = l0();
        const l = new LedgerManager([{ id: 'holder', balance: 100000, lastDemurrageEpoch: today - 30 }]);
        const after = l.getAccount('holder').balance;
        expect(after).toBe(100000 - charge);
        expect(after + COMMONS_BALANCE).toBe(100000);
        const [event] = l.drainDecayEvents();
        expect(event.amount).toBe(charge);
    });
    it('a charge below one hundredth is forfeited and the epoch stamped', () => {
        setCommonsBalance(0);
        const today = l0();
        // 200.01 Beans for a day: 1 hundredth at 1 % a month for a thirtieth of a month is far below one hundredth.
        const l = new LedgerManager([{ id: 'h', balance: 20001, lastDemurrageEpoch: today - 1 }]);
        expect(l.getAccount('h').balance).toBe(20001);
        expect(l.getAccount('h').lastDemurrageEpoch).toBe(today);
        expect(COMMONS_BALANCE).toBe(0);
        expect(l.drainDecayEvents()).toEqual([]);
    });
});
