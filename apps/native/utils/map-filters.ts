/**
 * The map's filter rows — which chips the second row carries for each type pill, and which pins survive
 * the filters. No React Native imports, so vitest can hold it to the design.
 *
 * Top row: the type pills (All / Offers / Needs / Events). Second row, always in the same place, changes
 * with the type: the category chips under All, Offers and Needs; the date chips under Events.
 *
 * The chosen category and the chosen date window are both REMEMBERED across type switches, but each only
 * applies while its row is on screen. Events carry no marketplace category of their own (they post as
 * 'community'), so under Events the category row gives way to the date row and the category stops
 * filtering; switch back to Offers and it filters again. A filter the member cannot see never hides
 * pins — that is the rule that makes the remembering safe. "All Categories" clears the category.
 */

import { CATEGORY_META, normalizeCategory } from '../constants/categories';
import { EVENT_WINDOWS, eventInWindow, type EventWindow } from './events';
import type { FilterChip } from './filter-chips';

export type MapTypeFilter = 'all' | 'offers' | 'needs' | 'events';

export type MapSecondRow =
    | { kind: 'categories'; chips: FilterChip[] }
    | { kind: 'eventWindows'; chips: FilterChip<EventWindow>[] };

/** 🏷️ All Categories first, then the 17 post categories in their constants order. */
export const CATEGORY_FILTER_CHIPS: FilterChip[] = Object.entries(CATEGORY_META)
    .map(([id, m]) => ({ id, label: m.label, emoji: m.emoji }));

const EVENT_WINDOW_CHIPS: FilterChip<EventWindow>[] = EVENT_WINDOWS.map(w => ({ id: w.id, label: w.label }));

export function mapSecondRow(type: MapTypeFilter): MapSecondRow {
    return type === 'events'
        ? { kind: 'eventWindows', chips: EVENT_WINDOW_CHIPS }
        : { kind: 'categories', chips: CATEGORY_FILTER_CHIPS };
}

export interface MapFilterState {
    type: MapTypeFilter;
    /** 'all' or a category id from CATEGORY_META. */
    category: string;
    eventWindow: EventWindow;
}

function hasCoords(p: any): boolean {
    if (p.lat == null || p.lng == null) return false;
    return !isNaN(Number(p.lat)) && !isNaN(Number(p.lng));
}

/**
 * Compared normalised, so a post filed under a legacy alias sits under the chip whose emoji its pin wears
 * (the pin resolves its emoji through the same normaliser).
 */
function inCategory(p: any, state: MapFilterState): boolean {
    if (state.type === 'events' || state.category === 'all') return true;
    return normalizeCategory(p.category) === state.category;
}

/** Offer and Need pins — the UnifiedMapPin layer. Events never go through it. */
export function visibleMarketPins<T = any>(posts: T[], state: MapFilterState): T[] {
    return posts.filter((p: any) => {
        if (p.status && p.status !== 'active') return false;
        if (!hasCoords(p)) return false;
        const pt = (p.type || '').toLowerCase();
        if (pt === 'event') return false;
        if (state.type === 'events') return false;
        if (state.type === 'offers' && pt !== 'offer') return false;
        if (state.type === 'needs' && pt !== 'need') return false;
        return inCategory(p, state);
    });
}

/**
 * Event pins — their own violet layer, under All and under Events. Under Events the date chips filter
 * them; under All every upcoming event shows. `eventInWindow` drops ended and cancelled events either way.
 */
export function visibleEventPins<T = any>(posts: T[], state: MapFilterState, nowMs: number = Date.now()): T[] {
    if (state.type !== 'all' && state.type !== 'events') return [];
    return posts.filter((p: any) => {
        if ((p.type || '').toLowerCase() !== 'event') return false;
        if (!hasCoords(p)) return false;
        if (!inCategory(p, state)) return false;
        return eventInWindow(p, state.type === 'events' ? state.eventWindow : 'all', nowMs);
    });
}

/**
 * Whether the ✕ in the top row has anything to clear. A date window only filters under Events, which is
 * already type !== 'all', so it needs no clause of its own.
 */
export function mapFiltersActive(state: MapFilterState): boolean {
    return state.type !== 'all' || state.category !== 'all';
}
