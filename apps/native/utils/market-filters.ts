/**
 * The Market feed's filter rows — the same shape as the map's (utils/map-filters.ts), plus the feed's own
 * extra filters. No React Native imports, so vitest can hold it to the design.
 *
 * Type row: All / ★ For You / Offers / Needs / Events / Polls. It wraps onto a second line when the phone
 * is narrow or the text is large, so every type stays on screen; it never scrolls sideways.
 *
 * Second row, always in the same place, changes with the type:
 * - All, For You, Offers, Needs: the map's category chip (one chip naming the current category, opening a
 *   panel of every category as tiles), then 📍 Distance, 🤝 Trust and 🫘 Beans only.
 * - Polls: Distance and Trust. Polls carry no goods category and no price, so the category chip and Beans
 *   only never applied to them; they are not shown there.
 * - Events: the map's date chips (All / Today / This weekend / Next 7 days), and nothing else.
 *
 * As on the map, every choice is REMEMBERED across type switches but filters only while its chip is on
 * screen: a filter the member cannot see never hides a post.
 */

import { normalizeCategory } from '../constants/categories';
import { EVENT_WINDOWS, eventInWindow, isEventInFeed, type EventWindow } from './events';
import type { FilterChip } from './filter-chips';

export type MarketTypeFilter = 'all' | 'for-you' | 'offers' | 'needs' | 'events' | 'polls';

export const MARKET_TYPE_PILLS: ReadonlyArray<{ id: MarketTypeFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'for-you', label: '★ For You' },
    { id: 'offers', label: 'Offers' },
    { id: 'needs', label: 'Needs' },
    { id: 'events', label: 'Events' },
    { id: 'polls', label: 'Polls' },
];

export type MarketExtraFilter = 'distance' | 'trust' | 'beans';

export type MarketSecondRow =
    | { kind: 'filters'; category: boolean; extras: MarketExtraFilter[] }
    | { kind: 'eventWindows'; chips: FilterChip<EventWindow>[] };

const EVENT_WINDOW_CHIPS: FilterChip<EventWindow>[] = EVENT_WINDOWS.map(w => ({ id: w.id, label: w.label }));

export function marketSecondRow(type: MarketTypeFilter): MarketSecondRow {
    if (type === 'events') return { kind: 'eventWindows', chips: EVENT_WINDOW_CHIPS };
    if (type === 'polls') return { kind: 'filters', category: false, extras: ['distance', 'trust'] };
    return { kind: 'filters', category: true, extras: ['distance', 'trust', 'beans'] };
}

export interface MarketFilterState {
    type: MarketTypeFilter;
    /** 'all' or a category id from CATEGORY_META. */
    category: string;
    eventWindow: EventWindow;
    /** 'all' or a TRUST_FILTERS id. */
    trust: string;
    beansOnly: boolean;
    radiusKm: number | null;
    /** Where the radius is measured from; null falls back to the default centre. */
    center: { lat: number; lng: number } | null;
    /** 'all' or a group id. The group chips are their own row and always on screen. */
    groupId: string;
}

export const DEFAULT_MARKET_FILTERS: MarketFilterState = {
    type: 'all', category: 'all', eventWindow: 'all', trust: 'all', beansOnly: false, radiusKm: null, center: null, groupId: 'all',
};

/** The radius centre when the member has not picked one (kept from the feed's original filter). */
const DEFAULT_CENTER = { lat: -28.5523, lng: 153.4991 };

function deg2rad(deg: number) {
    return deg * (Math.PI / 180);
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Which of the state's filters are on screen, and so allowed to hide posts. */
function onScreen(state: MarketFilterState) {
    const row = marketSecondRow(state.type);
    const extras = row.kind === 'filters' ? row.extras : [];
    return {
        category: row.kind === 'filters' && row.category,
        eventWindow: row.kind === 'eventWindows',
        distance: extras.includes('distance'),
        trust: extras.includes('trust'),
        beans: extras.includes('beans'),
    };
}

export interface MarketFilterContext {
    blockedUsers: ReadonlyArray<string>;
    /** Category ids the member starred under For You. */
    favCategories: ReadonlyArray<string>;
    nowMs?: number;
}

/**
 * Whether a post shows in the feed under the current filters — everything except the search box, which
 * stays with the screen (it depends on whether the server answered the search).
 */
export function feedPostVisible(p: any, state: MarketFilterState, ctx: MarketFilterContext): boolean {
    const nowMs = ctx.nowMs ?? Date.now();
    const show = onScreen(state);
    const type = p.type;

    if (type === 'poll') {
        if (p.status !== 'active' && p.status !== 'completed') return false;
    } else if (type === 'event') {
        // Ended and cancelled events leave the feed (the sync pull still carries them).
        if (!isEventInFeed(p, nowMs)) return false;
        if (state.type !== 'all' && state.type !== 'events') return false;
        if (show.eventWindow && !eventInWindow(p, state.eventWindow, nowMs)) return false;
    } else if (p.status !== 'active') {
        return false;
    }
    if (ctx.blockedUsers.includes(p.author_pubkey)) return false;

    if (state.groupId !== 'all' && (p.target_group_id || p.targetGroupId) !== state.groupId) return false;

    // Type pills
    if (state.type === 'offers' && type !== 'offer') return false;
    if (state.type === 'needs' && type !== 'need') return false;
    if (state.type === 'polls' && type !== 'poll') return false;
    if (state.type === 'events' && type !== 'event') return false;
    if (state.type === 'for-you' && (type === 'poll' || !ctx.favCategories.includes(normalizeCategory(p.category)))) return false;

    // Compared normalised, so a post filed under a legacy alias sits under the tile its card's emoji matches.
    if (show.category && state.category !== 'all' && normalizeCategory(p.category) !== state.category) return false;

    // #108: beans-only browse hides anything that also asks for cash, and polls and events (no price).
    if (show.beans && state.beansOnly && (type === 'poll' || type === 'event' || p.cash_also_needed === 1)) return false;

    if (show.trust && state.trust !== 'all') {
        const cycled = p.author_energy_cycled ?? 0;
        if (state.trust === 'founding' && (type === 'poll' || type === 'event' || !p.authorFoundingNeeded)) return false;
        if (state.trust === 'new' && cycled >= 120) return false;
        if (state.trust === 'resident' && cycled < 120) return false;
        if (state.trust === 'steward' && cycled < 520) return false;
        if (state.trust === 'elder' && cycled < 1320) return false;
    }

    // A post with no location is kept, as before: the radius cannot place it.
    if (show.distance && state.radiusKm && p.lat && p.lng) {
        const c = state.center ?? DEFAULT_CENTER;
        if (distanceKm(c.lat, c.lng, p.lat, p.lng) > state.radiusKm) return false;
    }
    return true;
}

/**
 * Whether anything the member can see is narrowing the feed — picks the empty state ("No items found" with
 * Clear All Filters rather than the first-run loader). The search box is added by the screen.
 */
export function marketFiltersActive(state: MarketFilterState): boolean {
    const show = onScreen(state);
    return state.type !== 'all'
        || state.groupId !== 'all'
        || (show.category && state.category !== 'all')
        || (show.eventWindow && state.eventWindow !== 'all')
        || (show.distance && state.radiusKm !== null)
        || (show.trust && state.trust !== 'all')
        || (show.beans && state.beansOnly);
}

export function distanceChipLabel(radiusKm: number | null): string {
    if (radiusKm === null) return '📍 Distance ▾';
    return `📍 ${radiusKm < 1 ? `${Math.round(radiusKm * 1000)}m` : `${radiusKm}km`} ▾`;
}

/** `trust` is the chosen TRUST_FILTERS entry (components/TrustPickerSheet). */
export function trustChipLabel(trust: { id: string; emoji: string; label: string } | undefined): string {
    return trust && trust.id !== 'all' ? `${trust.emoji} ${trust.label} ▾` : '🤝 Trust ▾';
}

export function beansChipLabel(beansOnly: boolean): string {
    return beansOnly ? '🫘 Beans only ✓' : '🫘 Beans only';
}
