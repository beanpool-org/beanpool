/**
 * The Market's active-filter chip: the one line that stays on screen while the controls are scrolled
 * away. It names every filter that is narrowing the feed, and nothing when nothing is.
 */

import { describe, it, expect } from 'vitest';
import { marketFilterSummary, marketFiltersActive, DEFAULT_MARKET_FILTERS, type MarketFilterState } from '../market-filters';

const f = (over: Partial<MarketFilterState>): MarketFilterState => ({ ...DEFAULT_MARKET_FILTERS, ...over });
const labels = {
    trustLabel: (id: string) => ({ steward: 'Stewards', new: 'Newcomers' } as Record<string, string>)[id],
    groupName: (id: string) => ({ g1: 'Mullum Growers' } as Record<string, string>)[id],
};

describe('marketFilterSummary', () => {
    it('is null when nothing is filtered, so the chip never shows', () => {
        expect(marketFilterSummary(DEFAULT_MARKET_FILTERS, '')).toBeNull();
        expect(marketFilterSummary(DEFAULT_MARKET_FILTERS, '   ')).toBeNull();
    });

    it('reads search · category · distance, the example from the brief', () => {
        expect(marketFilterSummary(f({ category: 'food', radiusKm: 5 }), 'honey')).toBe('🔍 honey · Food · 5km');
    });

    it('names the type pill, trust, beans only and group', () => {
        expect(marketFilterSummary(f({ type: 'offers', trust: 'steward', beansOnly: true, groupId: 'g1' }), '', labels))
            .toBe('Offers · Stewards · Beans only · Mullum Growers');
    });

    it('shows sub-kilometre radii in metres, as the distance chip does', () => {
        expect(marketFilterSummary(f({ radiusKm: 0.5 }), '')).toBe('500m');
    });

    it('cuts a long search term with an ellipsis and collapses its whitespace', () => {
        expect(marketFilterSummary(DEFAULT_MARKET_FILTERS, '  fresh   eggs  ')).toBe('🔍 fresh eggs');
        const s = marketFilterSummary(DEFAULT_MARKET_FILTERS, 'organic free range duck eggs')!;
        expect(s.endsWith('…')).toBe(true);
        expect(s.length).toBeLessThanOrEqual('🔍 '.length + 16);
    });

    it('under Events names the date window and not the goods filters it hides', () => {
        const s = marketFilterSummary(f({ type: 'events', eventWindow: 'weekend', category: 'food', beansOnly: true, radiusKm: 5 }), '');
        expect(s).toBe('Events · This weekend');
    });

    it('under Polls leaves out the category and Beans only it does not show', () => {
        expect(marketFilterSummary(f({ type: 'polls', category: 'food', beansOnly: true, trust: 'new' }), '', labels))
            .toBe('Polls · Newcomers');
    });

    it('is non-null exactly when marketFiltersActive (or a search) says the feed is narrowed', () => {
        const states: MarketFilterState[] = [
            DEFAULT_MARKET_FILTERS,
            f({ type: 'for-you' }),
            f({ type: 'events', category: 'food' }),
            f({ type: 'polls', beansOnly: true }),
            f({ radiusKm: 2 }),
            f({ groupId: 'x' }),
            f({ type: 'events', eventWindow: 'today' }),
        ];
        for (const s of states) {
            expect(marketFilterSummary(s, '') !== null).toBe(marketFiltersActive(s));
        }
    });
});
