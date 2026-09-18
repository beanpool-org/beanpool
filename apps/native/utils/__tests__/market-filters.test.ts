/**
 * The Market feed's filter rows: what each row carries for each type pill, and that the category chip —
 * now the map's chip and tile panel, not the old white sheet — actually takes posts out of the feed.
 */

import { describe, it, expect } from 'vitest';
import {
    MARKET_TYPE_PILLS, marketSecondRow, feedPostVisible, marketFiltersActive, DEFAULT_MARKET_FILTERS,
    distanceChipLabel, trustChipLabel, beansChipLabel,
    type MarketFilterState,
} from '../market-filters';
import { CATEGORY_FILTER_CHIPS, categoryPanelReducer } from '../map-filters';
import { CATEGORY_META } from '../../constants/categories';

const HOUR = 60 * 60 * 1000;
/** Wednesday 2026-09-16, 10:00 local. */
const WED = new Date(2026, 8, 16, 10, 0, 0, 0).getTime();

function post(id: string, type: string, category: string, extra: Record<string, unknown> = {}) {
    return { id, type, category, status: 'active', author_pubkey: `pk-${id}`, author_energy_cycled: 0, ...extra };
}
function event(id: string, startMs: number, extra: Record<string, unknown> = {}) {
    return post(id, 'event', 'community', {
        event_start_at: new Date(startMs).toISOString(),
        event_end_at: new Date(startMs + 2 * HOUR).toISOString(),
        lat: -28.55, lng: 153.5,
        ...extra,
    });
}

const FEED = [
    post('honey', 'offer', 'food'),
    post('beans', 'need', 'food'),
    post('lift', 'offer', 'transport', { cash_also_needed: 1 }),
    post('fence', 'need', 'labour', { author_energy_cycled: 600 }),
    post('ute', 'offer', 'Transport'),
    post('vote', 'poll', 'governance'),
    event('market-today', WED + 2 * HOUR),
    event('working-bee-next-month', WED + 30 * 24 * HOUR),
];

const ctx = { blockedUsers: [] as string[], favCategories: ['food'], nowMs: WED };
function state(over: Partial<MarketFilterState> = {}): MarketFilterState {
    return { ...DEFAULT_MARKET_FILTERS, ...over };
}
const shown = (s: MarketFilterState, posts = FEED) => posts.filter(p => feedPostVisible(p, s, ctx)).map(p => p.id).sort();

describe('the type row', () => {
    it('keeps All, For You and Polls, and gains Events', () => {
        expect(MARKET_TYPE_PILLS.map(p => p.id)).toEqual(['all', 'for-you', 'offers', 'needs', 'events', 'polls']);
        expect(MARKET_TYPE_PILLS.map(p => p.label)).toEqual(['All', '★ For You', 'Offers', 'Needs', 'Events', 'Polls']);
    });
});

describe('the second row per type', () => {
    it.each(['all', 'for-you', 'offers', 'needs'] as const)('%s: the category chip, then Distance, Trust, Beans only', (type) => {
        expect(marketSecondRow(type)).toEqual({ kind: 'filters', category: true, extras: ['distance', 'trust', 'beans'] });
    });

    it('Polls: Distance and Trust only (polls have no goods category and no price)', () => {
        expect(marketSecondRow('polls')).toEqual({ kind: 'filters', category: false, extras: ['distance', 'trust'] });
    });

    it("Events: the map's date chips and nothing else", () => {
        const row = marketSecondRow('events');
        expect(row.kind).toBe('eventWindows');
        if (row.kind !== 'eventWindows') return;
        expect(row.chips.map(c => c.label)).toEqual(['All', 'Today', 'This weekend', 'Next 7 days']);
    });

    it("the category panel is the map's: All Categories first, then every category", () => {
        expect(CATEGORY_FILTER_CHIPS.map(c => c.id)).toEqual(Object.keys(CATEGORY_META));
    });
});

describe('the category chip filters the feed', () => {
    it('with no category, All shows every live post, poll and upcoming event', () => {
        expect(shown(state())).toEqual(['beans', 'fence', 'honey', 'lift', 'market-today', 'ute', 'vote', 'working-bee-next-month']);
    });

    it('a tile picked in the panel is the category that filters', () => {
        const picked = categoryPanelReducer({ category: 'all', open: true }, { kind: 'pick', category: 'food' });
        expect(picked.open).toBe(false);
        expect(shown(state({ category: picked.category }))).toEqual(['beans', 'honey']);
    });

    it('Food under Offers keeps only the food offer', () => {
        expect(shown(state({ type: 'offers', category: 'food' }))).toEqual(['honey']);
    });

    it('a legacy alias sits under the tile its card shows', () => {
        expect(shown(state({ type: 'offers', category: 'transport' }))).toEqual(['lift', 'ute']);
    });

    it('a category nothing is filed under empties the feed', () => {
        expect(shown(state({ category: 'energy' }))).toEqual([]);
    });

    it('All Categories clears it', () => {
        const cleared = categoryPanelReducer({ category: 'food', open: true }, { kind: 'pick', category: 'all' });
        expect(shown(state({ category: cleared.category }))).toHaveLength(8);
    });
});

describe('a remembered choice filters only while its chip is on screen', () => {
    it('Polls ignores the remembered category and Beans only', () => {
        expect(shown(state({ type: 'polls', category: 'food', beansOnly: true }))).toEqual(['vote']);
    });

    it('Events ignores category, Trust and Beans only, and filters by date', () => {
        const s = state({ type: 'events', category: 'food', trust: 'founding', beansOnly: true });
        expect(shown(s)).toEqual(['market-today', 'working-bee-next-month']);
        expect(shown({ ...s, eventWindow: 'today' })).toEqual(['market-today']);
    });

    it('a remembered date window does not filter events under All', () => {
        expect(shown(state({ eventWindow: 'today' }))).toContain('working-bee-next-month');
    });

    it('back on Offers the remembered category filters again', () => {
        expect(shown(state({ type: 'offers', category: 'food', eventWindow: 'today' }))).toEqual(['honey']);
    });
});

describe("the feed's own filters still work", () => {
    it('Beans only drops cash-too listings, polls and events', () => {
        expect(shown(state({ beansOnly: true }))).toEqual(['beans', 'fence', 'honey', 'ute']);
    });

    it('Trust keeps authors at or past the level', () => {
        expect(shown(state({ type: 'needs', trust: 'steward' }))).toEqual(['fence']);
        expect(shown(state({ type: 'needs', trust: 'new' }))).toEqual(['beans']);
    });

    it('Distance drops located posts outside the radius and keeps posts with no location', () => {
        const near = post('near', 'offer', 'food', { lat: -28.55, lng: 153.5 });
        const far = post('far', 'offer', 'food', { lat: -37.07, lng: 144.21 });
        const nowhere = post('nowhere', 'offer', 'food');
        const s = state({ radiusKm: 10, center: { lat: -28.55, lng: 153.5 } });
        expect(shown(s, [near, far, nowhere])).toEqual(['near', 'nowhere']);
    });

    it('For You keeps starred categories and never polls or events', () => {
        expect(shown(state({ type: 'for-you' }))).toEqual(['beans', 'honey']);
    });

    it('a group chip keeps only that group', () => {
        const g = post('guild', 'offer', 'food', { target_group_id: 'g1' });
        expect(shown(state({ groupId: 'g1' }), [...FEED, g])).toEqual(['guild']);
    });

    it('blocked authors, sold listings and ended events stay out', () => {
        const sold = post('sold', 'offer', 'food', { status: 'completed' });
        const ended = event('ended', WED - 5 * HOUR);
        const blocked = post('blocked', 'offer', 'food');
        const s = state();
        expect([sold, ended, blocked].filter(p => feedPostVisible(p, s, { ...ctx, blockedUsers: ['pk-blocked'] }))).toEqual([]);
    });
});

describe('chip labels and the empty state', () => {
    it('Distance, Trust and Beans only name their setting', () => {
        expect(distanceChipLabel(null)).toBe('📍 Distance ▾');
        expect(distanceChipLabel(5)).toBe('📍 5km ▾');
        expect(distanceChipLabel(0.5)).toBe('📍 500m ▾');
        expect(trustChipLabel(undefined)).toBe('🤝 Trust ▾');
        expect(trustChipLabel({ id: 'all', emoji: '👥', label: 'All Users' })).toBe('🤝 Trust ▾');
        expect(trustChipLabel({ id: 'elder', emoji: '⛰️', label: 'Elders' })).toBe('⛰️ Elders ▾');
        expect(beansChipLabel(false)).toBe('🫘 Beans only');
        expect(beansChipLabel(true)).toBe('🫘 Beans only ✓');
    });

    it('counts only filters on screen as narrowing the feed', () => {
        expect(marketFiltersActive(state())).toBe(false);
        expect(marketFiltersActive(state({ category: 'food' }))).toBe(true);
        expect(marketFiltersActive(state({ eventWindow: 'today' }))).toBe(false);
        expect(marketFiltersActive(state({ type: 'events', eventWindow: 'today' }))).toBe(true);
        expect(marketFiltersActive(state({ groupId: 'g1' }))).toBe(true);
    });
});
