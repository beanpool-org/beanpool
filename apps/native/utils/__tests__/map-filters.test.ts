/**
 * The map's two filter rows: which chips the second row carries for each type pill, and that picking a
 * category actually takes pins off the map — the job the old modal sheet did.
 */

import { describe, it, expect } from 'vitest';
import {
    CATEGORY_FILTER_CHIPS, mapSecondRow, visibleMarketPins, visibleEventPins, mapFiltersActive,
    type MapFilterState, type MapTypeFilter,
} from '../map-filters';
import { CATEGORY_META } from '../../constants/categories';

const HOUR = 60 * 60 * 1000;
/** Wednesday 2026-09-16, 10:00 local. */
const WED = new Date(2026, 8, 16, 10, 0, 0, 0).getTime();

function post(id: string, type: string, category: string, extra: Record<string, unknown> = {}) {
    return { id, type, category, status: 'active', lat: -28.55, lng: 153.5, ...extra };
}
function event(id: string, startMs: number, extra: Record<string, unknown> = {}) {
    return post(id, 'event', 'community', {
        event_start_at: new Date(startMs).toISOString(),
        event_end_at: new Date(startMs + 2 * HOUR).toISOString(),
        ...extra,
    });
}

const POSTS = [
    post('honey', 'offer', 'food'),
    post('beans', 'need', 'food'),
    post('lift', 'offer', 'transport'),
    post('fence', 'need', 'labour'),
    event('market-today', WED + 2 * HOUR),
    event('working-bee-next-month', WED + 30 * 24 * HOUR),
];

function state(type: MapTypeFilter, category = 'all', eventWindow: MapFilterState['eventWindow'] = 'all'): MapFilterState {
    return { type, category, eventWindow };
}
const ids = (xs: Array<{ id: string }>) => xs.map(x => x.id).sort();

describe('second row contents per type', () => {
    it.each(['all', 'offers', 'needs'] as const)('%s shows the category chips', (type) => {
        const row = mapSecondRow(type);
        expect(row.kind).toBe('categories');
        expect(row.chips).toBe(CATEGORY_FILTER_CHIPS);
    });

    it('the category chips are All Categories first, then all 17 categories, each with emoji and label', () => {
        expect(CATEGORY_FILTER_CHIPS).toHaveLength(18);
        expect(CATEGORY_FILTER_CHIPS[0]).toEqual({ id: 'all', label: 'All Categories', emoji: '🏷️' });
        expect(CATEGORY_FILTER_CHIPS[1]).toEqual({ id: 'food', label: 'Food', emoji: '🥕' });
        expect(CATEGORY_FILTER_CHIPS.map(c => c.id)).toEqual(Object.keys(CATEGORY_META));
        for (const c of CATEGORY_FILTER_CHIPS) {
            expect(c.emoji).toBeTruthy();
            expect(c.label).toBeTruthy();
        }
    });

    it('Events shows the date chips, unchanged, and no categories', () => {
        const row = mapSecondRow('events');
        expect(row.kind).toBe('eventWindows');
        expect(row.chips.map(c => c.id)).toEqual(['all', 'today', 'weekend', 'week']);
        expect(row.chips.map(c => c.label)).toEqual(['All', 'Today', 'This weekend', 'Next 7 days']);
    });
});

describe('category filter takes pins off the map', () => {
    it('with no category every offer and need pins', () => {
        expect(ids(visibleMarketPins(POSTS, state('all')))).toEqual(['beans', 'fence', 'honey', 'lift']);
    });

    it('Food under All keeps only food offers and needs', () => {
        expect(ids(visibleMarketPins(POSTS, state('all', 'food')))).toEqual(['beans', 'honey']);
    });

    it('Food under Offers keeps only the food offer', () => {
        expect(ids(visibleMarketPins(POSTS, state('offers', 'food')))).toEqual(['honey']);
    });

    it('Labour under Needs keeps only the labour need', () => {
        expect(ids(visibleMarketPins(POSTS, state('needs', 'labour')))).toEqual(['fence']);
    });

    it('a category nothing is filed under empties the map', () => {
        expect(visibleMarketPins(POSTS, state('all', 'energy'))).toEqual([]);
    });

    it('a legacy alias sits under the chip whose emoji its pin wears', () => {
        const legacy = [post('ute', 'offer', 'Transport')];
        expect(ids(visibleMarketPins(legacy, state('offers', 'transport')))).toEqual(['ute']);
    });

    it('under All a chosen category hides events filed elsewhere', () => {
        expect(visibleEventPins(POSTS, state('all', 'food'), WED)).toEqual([]);
    });

    it('still drops inactive and unpinned posts', () => {
        const odd = [post('sold', 'offer', 'food', { status: 'completed' }), post('nowhere', 'offer', 'food', { lat: null })];
        expect(visibleMarketPins(odd, state('all', 'food'))).toEqual([]);
    });
});

describe('switching type with a category chosen', () => {
    it('Events ignores the remembered category (its row is not on screen) and filters by date', () => {
        expect(visibleMarketPins(POSTS, state('events', 'food', 'today'))).toEqual([]);
        expect(ids(visibleEventPins(POSTS, state('events', 'food', 'today'), WED))).toEqual(['market-today']);
        expect(ids(visibleEventPins(POSTS, state('events', 'food', 'all'), WED))).toEqual(['market-today', 'working-bee-next-month']);
    });

    it('back on Offers the remembered category filters again', () => {
        expect(ids(visibleMarketPins(POSTS, state('offers', 'food', 'today')))).toEqual(['honey']);
    });

    it('a remembered date window does not filter events under All', () => {
        expect(ids(visibleEventPins(POSTS, state('all', 'all', 'today'), WED))).toEqual(['market-today', 'working-bee-next-month']);
    });

    it('Offers and Needs show no event pins', () => {
        expect(visibleEventPins(POSTS, state('offers'), WED)).toEqual([]);
        expect(visibleEventPins(POSTS, state('needs'), WED)).toEqual([]);
    });

    it('the clear button shows while a type or category is chosen', () => {
        expect(mapFiltersActive(state('all'))).toBe(false);
        expect(mapFiltersActive(state('all', 'food'))).toBe(true);
        expect(mapFiltersActive(state('events'))).toBe(true);
    });
});
