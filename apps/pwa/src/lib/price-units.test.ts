/**
 * Web (PWA) price unit words and old-node feature gating, by what the functions return (no source text is read):
 * every unit in PRICE_UNITS has its Home, visitor-lobby and shopfront line, and its own deal words on the Market and an
 * enterprise's page (lib/price-unit-words.ts), and an old node's features answer hides yearly and per_kg. The screens
 * themselves are rendered in pages/MarketplacePage.price-units.test.tsx and pages/TreasuryDetailPage.price-units.test.tsx.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PRICE_UNITS, dealQuantityUnit, priceUnitTakesQuantity, priceUnitsOffered, setLanguage, type PriceUnit } from '@beanpool/core';
import { actualWorkedLabel, enterpriseReleaseCopy, estimatedLabel, estimateLength, priceUnitSuffix, requestQuantityWords } from './price-unit-words';
import { askedUnit } from './home-cards';
import { visitorPriceText } from './visitor-lobby';
import { listingPriceLine, shopSectionsOf, type ShopfrontListing } from './shopfront';

afterEach(() => setLanguage('en'));

const shopListing = (overrides: Partial<ShopfrontListing> = {}): ShopfrontListing => ({
    id: 'p1',
    type: 'offer',
    title: 'Apples',
    category: 'food',
    price_c: 1000,
    priceType: 'fixed',
    status: 'active',
    lendable: false,
    featuredAt: null,
    shopId: null,
    audienceScope: 'public',
    photo: null,
    authorTierCredit: null,
    ...overrides,
});

describe('web labels for every price unit (old and new)', () => {
    it('askedUnit covers every unit in PRICE_UNITS', () => {
        const expected: Record<PriceUnit, string> = {
            fixed: '',
            each: '',
            hourly: '/hr',
            daily: '/day',
            weekly: '/wk',
            monthly: '/mo',
            yearly: '/yr',
            per_kg: '/kg',
        };
        for (const unit of PRICE_UNITS) {
            expect(askedUnit(unit), unit).toBe(expected[unit]);
        }
        expect(askedUnit('unknown')).toBe('');
    });

    it('visitorPriceText renders every unit in PRICE_UNITS without a bean symbol', () => {
        const expected: Record<PriceUnit, string> = {
            fixed: '10 Beans',
            each: '10 Beans each · 5 left',
            hourly: '10 Beans an hour',
            daily: '10 Beans a day',
            weekly: '10 Beans a week',
            monthly: '10 Beans a month',
            yearly: '10 Beans a year',
            per_kg: '10 Beans a kilo',
        };
        for (const unit of PRICE_UNITS) {
            const text = visitorPriceText(
                { price_c: 1000, priceType: unit, ...(unit === 'each' ? { unitsLeft: 5, lot: null } : {}) },
                true,
            );
            expect(text, unit).toBe(expected[unit]);
            expect(text, `${unit} never uses bean symbol`).not.toContain('🫘');
        }
    });

    it('shopfront listingPriceLine and sections handle yearly (byTime) and per_kg (toBuy) with Beans word', () => {
        expect(listingPriceLine(shopListing({ priceType: 'yearly' }), true)).toBe('10 Beans a year');
        expect(listingPriceLine(shopListing({ priceType: 'per_kg' }), true)).toBe('10 Beans a kilo');
        expect(listingPriceLine(shopListing({ priceType: 'yearly' }), true)).not.toContain('🫘');
        expect(listingPriceLine(shopListing({ priceType: 'per_kg' }), true)).not.toContain('🫘');

        const sections = shopSectionsOf([
            shopListing({ id: 'yr', priceType: 'yearly' }),
            shopListing({ id: 'kg', priceType: 'per_kg' }),
        ]);
        expect(sections.find((s) => s.id === 'byTime')?.listings.map((l) => l.id)).toEqual(['yr']);
        expect(sections.find((s) => s.id === 'toBuy')?.listings.map((l) => l.id)).toEqual(['kg']);
    });

    it('table: every unit has its own deal words on the web (take-up label, quantity, request, release label, keeper prompt)', () => {
        // One row per unit: what MarketplacePage and TreasuryDetailPage draw for it (lib/price-unit-words.ts). A unit that
        // takes a quantity has a label naming it; one that doesn't (Total, Each) has none in the commitment sentence.
        const expected: Record<PriceUnit, {
            suffix: string; takeUp: string; length: string | null; request: string; release: string; prompt: string; invalid: string;
        }> = {
            fixed: { suffix: '', takeUp: 'ESTIMATED UNITS', length: null, request: '', release: 'ACTUAL UNITS WORKED', prompt: 'Enter units worked for "Eggs":', invalid: 'Please enter a valid positive quantity.' },
            each: { suffix: '', takeUp: 'ESTIMATED UNITS', length: null, request: '', release: 'ACTUAL UNITS WORKED', prompt: 'Enter units worked for "Eggs":', invalid: 'Please enter a valid positive quantity.' },
            hourly: { suffix: '/Hr', takeUp: 'ESTIMATED HOURS', length: '2.5 hr', request: '2.5 hours estimated', release: 'ACTUAL HOURS WORKED', prompt: 'Enter hours worked for "Eggs":', invalid: 'Please enter a valid positive number of hours.' },
            daily: { suffix: '/Dy', takeUp: 'ESTIMATED DAYS', length: '2.5 d', request: '2.5 days', release: 'ACTUAL DAYS WORKED', prompt: 'Enter days worked for "Eggs":', invalid: 'Please enter a valid positive number of days.' },
            weekly: { suffix: '/Wk', takeUp: 'ESTIMATED WEEKS', length: '2.5 w', request: '2.5 weeks', release: 'ACTUAL WEEKS WORKED', prompt: 'Enter weeks worked for "Eggs":', invalid: 'Please enter a valid positive number of weeks.' },
            monthly: { suffix: '/Mo', takeUp: 'ESTIMATED MONTHS', length: '2.5 m', request: '2.5 months', release: 'ACTUAL MONTHS WORKED', prompt: 'Enter months worked for "Eggs":', invalid: 'Please enter a valid positive number of months.' },
            yearly: { suffix: '/Yr', takeUp: 'ESTIMATED YEARS', length: '2.5 yr', request: '2.5 years', release: 'ACTUAL YEARS WORKED', prompt: 'Enter years worked for "Eggs":', invalid: 'Please enter a valid positive number of years.' },
            per_kg: { suffix: '/kg', takeUp: 'WEIGHT (KILOS)', length: '2.5 kg', request: '2.5 kilos', release: 'ACTUAL WEIGHT (KILOS)', prompt: 'Enter the weight in kilos for "Eggs":', invalid: 'Please enter a valid positive number of kilos.' },
        };
        expect(Object.keys(expected)).toEqual([...PRICE_UNITS]);
        for (const unit of PRICE_UNITS) {
            const row = expected[unit];
            expect(priceUnitSuffix(unit), unit).toBe(row.suffix);
            expect(estimatedLabel(unit), unit).toBe(row.takeUp);
            expect(estimateLength(unit, 2.5), unit).toBe(row.length);
            expect(requestQuantityWords(dealQuantityUnit(unit), false, 2.5), unit).toBe(row.request);
            expect(actualWorkedLabel(unit), unit).toBe(row.release);
            expect(enterpriseReleaseCopy(unit, 'Eggs'), unit).toEqual({ question: row.prompt, invalid: row.invalid });
            // A unit priced by quantity has words naming it on every deal screen; the rest fall back to units.
            expect(row.length !== null, `${unit} names its quantity`).toBe(priceUnitTakesQuantity(unit));
        }
        // One kilo, singular; a loan by the week or day; an unknown unit falls back without throwing.
        expect(requestQuantityWords('kilo', false, 1)).toBe('1 kilo');
        expect(requestQuantityWords('week', true, 2)).toBe('for 2 weeks');
        expect(priceUnitSuffix('per_litre')).toBe('');
        expect(estimatedLabel('per_litre')).toBe('ESTIMATED UNITS');
        expect(enterpriseReleaseCopy('per_litre').question).toBe('Enter units worked for "deal":');
        expect(enterpriseReleaseCopy('per_kg').question).toBe('Enter the weight in kilos for "deal":');
    });

    it('every unit has its words in every language: none falls back to the fallback unit words in the pseudo-locale', () => {
        setLanguage('xx' as any);
        for (const unit of ['hourly', 'daily', 'weekly', 'monthly', 'yearly', 'per_kg'] as const) {
            expect(estimatedLabel(unit), unit).not.toBe(estimatedLabel('fixed'));
            expect(actualWorkedLabel(unit), unit).not.toBe(actualWorkedLabel('fixed'));
            expect(estimatedLabel(unit), unit).toMatch(/^\[.*\]$/su);
        }
    });

    it('old node features answer hides yearly and per_kg on both Offers and Needs', () => {
        const oldNode = { beans: true, escrow: true, perItem: true };
        expect(priceUnitsOffered(oldNode, 'offer')).toEqual(['fixed', 'each', 'hourly', 'daily', 'weekly', 'monthly']);
        expect(priceUnitsOffered(oldNode, 'need')).toEqual(['fixed', 'hourly', 'daily', 'weekly', 'monthly']);

        const newNode = { ...oldNode, priceUnitsKgYear: true as const };
        expect(priceUnitsOffered(newNode, 'offer')).toEqual(['fixed', 'each', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'per_kg']);
        expect(priceUnitsOffered(newNode, 'need')).toEqual(['fixed', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'per_kg']);
    });
});
