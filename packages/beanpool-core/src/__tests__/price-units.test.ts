/**
 * Price units table tests (`packages/beanpool-core/src/price-units.ts` + consumers):
 * verifies every unit in PRICE_UNITS (old and new) has an explicit deal rule, quantity rule,
 * standing-deal rule, Beans label, release behaviour, and old-node feature gate.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
    PRICE_UNITS,
    beansPriceWords,
    dealAmountFor,
    dealQuantityUnit,
    isPriceUnit,
    kgYearPriceUnitsOffered,
    priceUnitDealKind,
    priceUnitTakesQuantity,
    priceUnitsOffered,
    releaseAmount,
    setLanguage,
    standingUnitForListing,
    standingUnitOf,
    parseAmount,
    ANY_DECIMALS,
    weightTakeUpLine,
    type PriceUnit,
} from '../index';

afterEach(() => setLanguage('en'));

const ALL_UNITS: readonly PriceUnit[] = ['fixed', 'each', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'per_kg'];

describe('PRICE_UNITS canonical order and exhaustive rules', () => {
    it('lists every unit in the exact form order: Total, Each, /hr, /day, /wk, /mo, /yr, /kg', () => {
        expect(PRICE_UNITS).toEqual(ALL_UNITS);
        for (const u of ALL_UNITS) expect(isPriceUnit(u)).toBe(true);
        for (const bad of ['', 'free', 'per_litre', 'annual', 'kg', null, undefined, 42]) {
            expect(isPriceUnit(bad)).toBe(false);
        }
    });

    it('table: every unit in PRICE_UNITS has an explicit deal kind, quantity rule, standing rule, and Beans label', () => {
        const expected: Record<PriceUnit, {
            dealKind: 'fixed' | 'each' | 'quantity';
            takesQuantity: boolean;
            quantityUnit: 'hour' | 'day' | 'week' | 'month' | 'year' | 'kilo' | null;
            standingUnit: 'week' | 'month' | null;
            label10: string;
        }> = {
            fixed: { dealKind: 'fixed', takesQuantity: false, quantityUnit: null, standingUnit: null, label10: '10 Beans' },
            each: { dealKind: 'each', takesQuantity: false, quantityUnit: null, standingUnit: null, label10: '10 Beans each' },
            hourly: { dealKind: 'quantity', takesQuantity: true, quantityUnit: 'hour', standingUnit: null, label10: '10 Beans an hour' },
            daily: { dealKind: 'quantity', takesQuantity: true, quantityUnit: 'day', standingUnit: null, label10: '10 Beans a day' },
            weekly: { dealKind: 'quantity', takesQuantity: true, quantityUnit: 'week', standingUnit: 'week', label10: '10 Beans a week' },
            monthly: { dealKind: 'quantity', takesQuantity: true, quantityUnit: 'month', standingUnit: 'month', label10: '10 Beans a month' },
            yearly: { dealKind: 'quantity', takesQuantity: true, quantityUnit: 'year', standingUnit: null, label10: '10 Beans a year' },
            // The weight in kilos, asked for as hours are (Marty, 25 Nov 2026: "yes ask for the weight like hours").
            per_kg: { dealKind: 'quantity', takesQuantity: true, quantityUnit: 'kilo', standingUnit: null, label10: '10 Beans a kilo' },
        };

        expect(Object.keys(expected)).toEqual([...PRICE_UNITS]);
        for (const unit of PRICE_UNITS) {
            const row = expected[unit];
            expect(priceUnitDealKind(unit), unit).toBe(row.dealKind);
            expect(priceUnitTakesQuantity(unit), unit).toBe(row.takesQuantity);
            expect(dealQuantityUnit(unit), unit).toBe(row.quantityUnit);
            expect(standingUnitOf(unit), unit).toBe(row.standingUnit);
            expect(standingUnitForListing(unit, 1000), unit).toBe(row.standingUnit);
            expect(beansPriceWords({ price_c: 1000, per: unit }), unit).toBe(row.label10);
        }

        // Unknown / nullish defaults safely
        expect(priceUnitTakesQuantity(undefined)).toBe(false);
        expect(priceUnitTakesQuantity(null)).toBe(false);
        expect(priceUnitTakesQuantity('per_litre')).toBe(false);
        expect(standingUnitOf('yearly')).toBeNull();
        expect(standingUnitOf('per_kg')).toBeNull();
        // Runtime fallback when a deserialized payload carries an unrecognized unit: never throw
        expect(beansPriceWords({ price_c: 1000, per: 'per_litre' as PriceUnit })).toBe('10 Beans');
    });

    it('releaseAmount re-rates quantity units (including yearly and per_kg) and never re-rates fixed/each or unknown units', () => {
        // Booked 2 units at 1,000 c each -> 2,000 c held; confirmed 1.5 -> 1,500 c for quantity units, 2,000 c for fixed-amount units.
        for (const unit of PRICE_UNITS) {
            const released = releaseAmount({ amount_c: 2000, hours: 2 }, 1.5, { priceType: unit });
            if (priceUnitDealKind(unit) === 'quantity') {
                expect(released, unit).toBe(1500);
            } else {
                expect(released, unit).toBe(2000);
            }
        }
        // Fail-safe allow-list: an unrecognized/future unit holds what was paid and never fails open to re-rating.
        expect(releaseAmount({ amount_c: 2000, hours: 2 }, 1.5, { priceType: 'per_litre' })).toBe(2000);
    });

    it('per_kg: the amount held is price per kilo × kilos in whole hundredths, and release re-rates on the kilos confirmed', () => {
        // 7.50 Beans a kilo (750 hundredths). Kilos are counted in hundredths of a kilo (10 g), as hours are.
        const cases: Array<{ kilos: number; held: number }> = [
            { kilos: 1, held: 750 },
            { kilos: 2.5, held: 1875 },
            { kilos: 0.25, held: 187 },   // 187.5 truncated once: the payer keeps the part below a hundredth
            { kilos: 0.01, held: 7 },     // the least weight a deal may be for (POST_HOURS_MIN): 10 g
            { kilos: 1.234, held: 922 },  // 1.23 kg: the weight counted to 10 g (quantityHundredths), as hours are
            { kilos: 10_000, held: 7_500_000 },
        ];
        for (const c of cases) {
            expect(dealAmountFor(750, c.kilos), `${c.kilos} kg`).toBe(c.held);
            expect(Number.isSafeInteger(dealAmountFor(750, c.kilos)), `${c.kilos} kg is whole hundredths`).toBe(true);
        }
        // Release at the deal's own rate (what it holds over the kilos booked), as hours: more kilos pay more, fewer less.
        expect(releaseAmount({ amount_c: 1875, hours: 2.5 }, 3, { priceType: 'per_kg' })).toBe(2250);
        expect(releaseAmount({ amount_c: 1875, hours: 2.5 }, 2, { priceType: 'per_kg' })).toBe(1500);
        expect(releaseAmount({ amount_c: 187, hours: 0.25 }, 0.2, { priceType: 'per_kg' })).toBe(149);
        expect(releaseAmount({ amount_c: 1875, hours: 2.5 }, 2.5, { priceType: 'per_kg' })).toBe(1875);
        expect(releaseAmount({ amount_c: 1875, hours: 2.5 }, undefined, { priceType: 'per_kg' })).toBe(1875);
        expect(releaseAmount({ amount_c: 1875, hours: 2.5 }, 0, { priceType: 'per_kg' })).toBe(0);
        expect(releaseAmount({ amount_c: 1875, hours: 2.5 }, -1, { priceType: 'per_kg' })).toBe(0);
    });
});

describe('priceUnitsOffered feature gate for yearly and per_kg', () => {
    it('new node offering both perItem and priceUnitsKgYear offers all 8 for Offer and 7 for Need in exact order', () => {
        const features = { perItem: true, priceUnitsKgYear: true };
        expect(kgYearPriceUnitsOffered(features)).toBe(true);
        expect(priceUnitsOffered(features, 'offer')).toEqual([
            'fixed', 'each', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'per_kg',
        ]);
        expect(priceUnitsOffered(features, 'need')).toEqual([
            'fixed', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'per_kg',
        ]);
    });

    it('old node without priceUnitsKgYear hides yearly and per_kg on both Offers and Needs', () => {
        for (const features of [undefined, null, {}, { perItem: true }, { priceUnitsKgYear: false }, { priceUnitsKgYear: 'true' }]) {
            expect(kgYearPriceUnitsOffered(features)).toBe(false);
            for (const type of ['offer', 'need']) {
                const offered = priceUnitsOffered(features, type);
                expect(offered, `${type} ${JSON.stringify(features)}`).not.toContain('yearly');
                expect(offered, `${type} ${JSON.stringify(features)}`).not.toContain('per_kg');
            }
        }
    });

    it('editing a listing that already holds yearly or per_kg keeps its unit even if features omit the flag', () => {
        expect(priceUnitsOffered(undefined, 'offer', 'yearly')).toEqual(['fixed', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']);
        expect(priceUnitsOffered(undefined, 'need', 'per_kg')).toEqual(['fixed', 'hourly', 'daily', 'weekly', 'monthly', 'per_kg']);
    });
});

describe('weightTakeUpLine: the kilos and the total under the weight box, both apps', () => {
    const typed = (text: string) => parseAmount(text, undefined, ANY_DECIMALS);
    it('says the kilos typed, the price a kilo and the figure the node holds', () => {
        expect(weightTakeUpLine(750, typed('2.5'))).toBe('2.5 kilos at 7.50 Beans a kilo comes to 18.75 Beans.');
        expect(weightTakeUpLine(750, typed('1'))).toBe('1 kilo at 7.50 Beans a kilo comes to 7.50 Beans.');
        expect(weightTakeUpLine(750, typed('0.25'))).toBe('0.25 kilos at 7.50 Beans a kilo comes to 1.87 Beans.');
        expect(weightTakeUpLine(1000, typed('10000'))).toBe('10000 kilos at 10 Beans a kilo comes to 100,000 Beans.');
    });
    it('says nothing until the weight is one above 0, or for a price that is not whole hundredths', () => {
        for (const text of ['', '0', '-1', 'two']) expect(weightTakeUpLine(750, typed(text)), text).toBeNull();
        expect(weightTakeUpLine(750, null)).toBeNull();
        expect(weightTakeUpLine(7.5, typed('2'))).toBeNull();
        expect(weightTakeUpLine(undefined, typed('2'))).toBeNull();
    });
    it('in the member\'s language: the decimal mark and digits of the language (fr "2,5")', () => {
        setLanguage('fr');
        expect(weightTakeUpLine(750, parseAmount('2,5', 'fr', ANY_DECIMALS))).toContain('2,5');
    });
});
