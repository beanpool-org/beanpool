/**
 * Web (PWA) price unit labels and old-node feature gating:
 * verifies every unit in PRICE_UNITS has its card, Home, visitor-lobby, shopfront, and composer/edit label,
 * and that an old node's features answer hides yearly and per_kg.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PRICE_UNITS, priceUnitsOffered, setLanguage, type PriceUnit } from '@beanpool/core';
import { askedUnit } from './home-cards';
import { visitorPriceText } from './visitor-lobby';
import { listingPriceLine, shopSectionsOf, type ShopfrontListing } from './shopfront';

afterEach(() => setLanguage('en'));

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

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

    it('web forms and card render yearly and per_kg gated by priceUnitsOffered and use priceUnitTakesQuantity', () => {
        const mapSrc = read('../pages/MapPage.tsx');
        const marketSrc = read('../pages/MarketplacePage.tsx');
        const cardSrc = read('../components/MarketplaceCard.tsx');

        expect(mapSrc).toContain("postUnits.includes('yearly')");
        expect(mapSrc).toContain("postUnits.includes('per_kg')");
        expect(marketSrc).toContain("editUnits.includes('yearly')");
        expect(marketSrc).toContain("editUnits.includes('per_kg')");
        expect(marketSrc).toContain('priceUnitTakesQuantity(selectedPost.priceType)');
        expect(marketSrc).toContain("case 'yearly': return t('/Yr'");
        expect(marketSrc).toContain("case 'per_kg': return t('/kg'");
        expect(cardSrc).toContain("case 'yearly': return t('/yr'");
        expect(cardSrc).toContain("case 'per_kg': return t('/kg'");
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
