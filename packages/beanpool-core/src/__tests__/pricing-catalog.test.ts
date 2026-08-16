import { describe, it, expect } from 'vitest';
import {
    calculateEffectivePrice,
    filterPriceOutliers,
    aggregateObservedPrice,
    DEFAULT_PRICING_CATALOG,
    PRICING_CATEGORIES,
} from '../pricing-catalog.js';

describe('Pricing Catalog & Utilities (#206)', () => {
    it('contains all 15 valid categories with meta definitions', () => {
        expect(PRICING_CATEGORIES).toHaveLength(15);
        const ids = PRICING_CATEGORIES.map(c => c.id);
        expect(ids).toContain('food_produce');
        expect(ids).toContain('skilled_trade');
        expect(ids).toContain('events_community');
    });

    it('has well-formed seed items with unique IDs, valid categories, and reasonable prices', () => {
        expect(DEFAULT_PRICING_CATALOG.length).toBeGreaterThan(50);
        const idSet = new Set<string>();
        const categorySet = new Set(PRICING_CATEGORIES.map(c => c.id));

        for (const item of DEFAULT_PRICING_CATALOG) {
            expect(idSet.has(item.id)).toBe(false);
            idSet.add(item.id);

            expect(categorySet.has(item.category)).toBe(true);
            expect(item.name.length).toBeGreaterThan(2);
            expect(item.emoji.length).toBeGreaterThan(0);
            expect(item.priceBeans).toBeGreaterThan(0);
        }
    });

    it('calculates effective prices correctly with multipliers and clamping', () => {
        // Standard 1.0x
        expect(calculateEffectivePrice(10, 1.0)).toBe(10);
        // Rural high cost 1.3x
        expect(calculateEffectivePrice(10, 1.3)).toBe(13);
        // Affordable 0.8x
        expect(calculateEffectivePrice(15, 0.8)).toBe(12);
        // Clamp min 0.5x
        expect(calculateEffectivePrice(10, 0.1)).toBe(5);
        // Clamp max 2.0x
        expect(calculateEffectivePrice(10, 5.0)).toBe(20);
        // Zero remains zero
        expect(calculateEffectivePrice(0, 1.5)).toBe(0);
        // Minimum non-zero is 1
        expect(calculateEffectivePrice(1, 0.5)).toBe(1);
    });

    it('filters out joke prices and unrealistic outliers (>5x baseline)', () => {
        const baseline = 10;
        const prices = [10, 12, 8, 999, -5, 0, 48, 55]; // 999 and 55 (>50) should be dropped
        const filtered = filterPriceOutliers(prices, baseline);
        expect(filtered).toEqual([10, 12, 8, 48]);
    });

    it('aggregates observed prices with confidence levels', () => {
        const baseline = 20;

        // No observations -> returns baseline and low confidence
        const empty = aggregateObservedPrice([], baseline);
        expect(empty.price).toBe(20);
        expect(empty.count).toBe(0);
        expect(empty.confidence).toBe('low');

        // 1 observation -> medium confidence
        const single = aggregateObservedPrice([24], baseline);
        expect(single.price).toBe(24);
        expect(single.count).toBe(1);
        expect(single.confidence).toBe('medium');

        // 5 observations -> trimmed mean + high confidence
        const multiple = aggregateObservedPrice([18, 20, 22, 25, 100], baseline); // 100 is >5x (5*20=100) or at limit
        expect(multiple.count).toBe(5);
        expect(multiple.confidence).toBe('high');
        expect(multiple.price).toBeGreaterThan(15);
        expect(multiple.price).toBeLessThan(35);
    });
});
