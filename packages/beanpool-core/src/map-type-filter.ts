/**
 * The map's type filter — All / Offers / Needs / Events — and which pins it leaves, one rule for the phone and the web
 * (the web map gained the phone's filter on 3 Nov; before that the two kept their own). The chips and the panel are each
 * app's own drawing; what decides a pin lives here, so a pin the phone shows under Offers is a pin the web shows.
 *
 * The chosen category and the chosen date window are both REMEMBERED across type switches, but each only applies while
 * its row is on screen. Events carry no marketplace category of their own (they post as 'community'), so under Events the
 * category row gives way to the date row and the category stops filtering; switch back to Offers and it filters again. A
 * filter the member cannot see never hides pins — that is the rule that makes the remembering safe.
 *
 * Whether an event falls in a date window is each app's own (the phone's posts are snake_case, the web's camelCase), so
 * it is passed in as `inWindow`; it also drops ended and cancelled events.
 */
import { normalizeCategory } from './pricing-catalog.js';

export type MapTypeFilter = 'all' | 'offers' | 'needs' | 'events';

/** The type pills, in the order both apps draw them. */
export const MAP_TYPE_FILTERS: readonly MapTypeFilter[] = ['all', 'offers', 'needs', 'events'];

export interface MapFilterState<W extends string = string> {
    type: MapTypeFilter;
    /** 'all' or a category id. */
    category: string;
    eventWindow: W;
}

function hasCoords(p: any): boolean {
    if (p.lat == null || p.lng == null) return false;
    return !isNaN(Number(p.lat)) && !isNaN(Number(p.lng));
}

/**
 * Compared normalised, so a post filed under a legacy alias sits under the chip whose emoji its pin wears (the pin
 * resolves its emoji through the same normaliser).
 */
function inCategory(p: any, state: MapFilterState): boolean {
    if (state.type === 'events' || state.category === 'all') return true;
    return normalizeCategory(p.category) === state.category;
}

/** Offer and Need pins. Events come from visibleEventPins; both draw together. */
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
 * Event pins, under All and under Events. Under Events the date chips filter them; under All every upcoming event shows
 * (`inWindow(post, 'all')`).
 */
export function visibleEventPins<T = any, W extends string = string>(
    posts: T[],
    state: MapFilterState<W>,
    inWindow: (post: T, window: W | 'all') => boolean,
): T[] {
    if (state.type !== 'all' && state.type !== 'events') return [];
    return posts.filter((p: any) => {
        if ((p.type || '').toLowerCase() !== 'event') return false;
        if (!hasCoords(p)) return false;
        if (!inCategory(p, state)) return false;
        return inWindow(p, state.type === 'events' ? state.eventWindow : 'all');
    });
}

/**
 * Whether the ✕ in the top row has anything to clear. A date window only filters under Events, which is already
 * type !== 'all', so it needs no clause of its own.
 */
export function mapFiltersActive(state: Pick<MapFilterState, 'type' | 'category'>): boolean {
    return state.type !== 'all' || state.category !== 'all';
}
