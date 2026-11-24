/**
 * Price units table tests (`packages/beanpool-core/src/price-units.ts` + consumers):
 * verifies every unit in PRICE_UNITS (old and new) has an explicit deal rule, quantity rule,
 * standing-deal rule, Beans label, release behaviour, and old-node feature gate.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
    PRICE_UNITS,
    beansPriceWords,
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
            quantityUnit: 'hour' | 'day' | 'week' | 'month' | 'year' | null;
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
            per_kg: { dealKind: 'fixed', takesQuantity: false, quantityUnit: null, standingUnit: null, label10: '10 Beans a kilo' },
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
    });

    it('releaseAmount re-rates quantity units (including yearly) and never re-rates fixed/each/per_kg', () => {
        // Booked 2 units at 1,000 c each -> 2,000 c held; confirmed 1.5 -> 1,500 c for quantity units, 2,000 c for fixed-amount units.
        for (const unit of PRICE_UNITS) {
            const released = releaseAmount({ amount_c: 2000, hours: 2 }, 1.5, { priceType: unit });
            if (priceUnitDealKind(unit) === 'quantity') {
                expect(released, unit).toBe(1500);
            } else {
                expect(released, unit).toBe(2000);
            }
        }
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
