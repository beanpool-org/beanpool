/**
 * The map's two filter rows: which chips the second row carries for each type pill, and that picking a
 * category actually takes pins off the map — the job the old modal sheet did.
 */

import { describe, it, expect } from 'vitest';
import {
    CATEGORY_FILTER_CHIPS, mapSecondRow, visibleMarketPins, visibleEventPins, mapFiltersActive,
    categoryChipLabel, categoryPanelReducer,
    type MapFilterState, type MapTypeFilter, type CategoryPanelState,
} from '../map-filters';
import { tilePanelColumns, TILE_GAP, TILE_BASE_MIN_WIDTH, TILE_PANEL_PADDING } from '../filter-chips';
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

describe('the category chip and its panel', () => {
    it('collapsed, the chip names the current category and points down; open, it points up', () => {
        expect(categoryChipLabel('all', false)).toBe('🏷️ All Categories ▾');
        expect(categoryChipLabel('food', false)).toBe('🥕 Food ▾');
        expect(categoryChipLabel('food', true)).toBe('🥕 Food ▴');
        // An unknown id never leaves the chip blank.
        expect(categoryChipLabel('nope', false)).toBe('🏷️ All Categories ▾');
    });

    const closed: CategoryPanelState = { category: 'all', open: false };

    it('the panel starts closed, so the map keeps its space', () => {
        expect(closed.open).toBe(false);
    });

    it('tapping the chip opens the panel; tapping it again closes it with the category unchanged', () => {
        const opened = categoryPanelReducer({ category: 'food', open: false }, { kind: 'toggle' });
        expect(opened).toEqual({ category: 'food', open: true });
        expect(categoryPanelReducer(opened, { kind: 'toggle' })).toEqual({ category: 'food', open: false });
    });

    it('picking a tile applies it and collapses the panel', () => {
        const opened = categoryPanelReducer(closed, { kind: 'toggle' });
        expect(categoryPanelReducer(opened, { kind: 'pick', category: 'garden' })).toEqual({ category: 'garden', open: false });
    });

    it('picking All Categories clears the category', () => {
        const opened = { category: 'garden', open: true };
        expect(categoryPanelReducer(opened, { kind: 'pick', category: 'all' })).toEqual({ category: 'all', open: false });
    });

    it('a tap on the map closes the panel without changing anything', () => {
        expect(categoryPanelReducer({ category: 'tools', open: true }, { kind: 'dismiss' })).toEqual({ category: 'tools', open: false });
        // Closed already: the same object back, so React skips the render.
        const s = { category: 'tools', open: false };
        expect(categoryPanelReducer(s, { kind: 'dismiss' })).toBe(s);
    });

    it('the category picked in the panel is the one that filters pins', () => {
        const picked = categoryPanelReducer({ category: 'all', open: true }, { kind: 'pick', category: 'food' });
        expect(ids(visibleMarketPins(POSTS, state('offers', picked.category)))).toEqual(['honey']);
    });

    it('the panel carries every category, All Categories first', () => {
        expect(mapSecondRow('offers').chips.map(c => c.id)).toEqual(Object.keys(CATEGORY_META));
    });
});

describe('tiles per row', () => {
    const tile = (inner: number, cols: number) => (inner - TILE_GAP * (cols - 1)) / cols;
    // The panel is the screen less 8dp a side, less TILE_PANEL_PADDING inside.
    const inner = (screenDp: number) => screenDp - 16 - 2 * TILE_PANEL_PADDING;

    it('four per row on a normal phone at normal text', () => {
        expect(tilePanelColumns(inner(411), 1)).toBe(4);
    });

    it('four on a 320dp phone at 1.3x text, so 18 categories take five rows, not six', () => {
        const cols = tilePanelColumns(inner(320), 1.3);
        expect(cols).toBe(4);
        expect(tile(inner(320), cols)).toBeGreaterThanOrEqual(TILE_BASE_MIN_WIDTH * 1.3);
        expect(Math.ceil(CATEGORY_FILTER_CHIPS.length / cols)).toBe(5);
    });

    it('fewer per row when the text is larger still, rather than squeeze a label', () => {
        const cols = tilePanelColumns(inner(320), 1.5);
        expect(cols).toBe(3);
        expect(tile(inner(320), 4)).toBeLessThan(TILE_BASE_MIN_WIDTH * 1.5);
    });

    it('never fewer than two', () => {
        expect(tilePanelColumns(100, 2)).toBe(2);
    });

    it('text smaller than default does not add columns past four', () => {
        expect(tilePanelColumns(600, 0.85)).toBe(4);
    });
});
