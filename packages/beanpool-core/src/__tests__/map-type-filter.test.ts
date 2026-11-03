import { describe, expect, it } from 'vitest';
import { MAP_TYPE_FILTERS, mapFiltersActive, marketPinMatchesFilter, visibleEventPins, visibleMarketPins, type MapFilterState } from '../map-type-filter.js';

const at = { lat: -28.6, lng: 153.5 };
const posts = [
    { id: 'o-food', type: 'offer', category: 'food', status: 'active', ...at },
    { id: 'o-tools', type: 'offer', category: 'tools', status: 'active', ...at },
    { id: 'n-food', type: 'need', category: 'food', status: 'active', ...at },
    { id: 'o-old', type: 'offer', category: 'food', status: 'fulfilled', ...at },
    { id: 'o-nowhere', type: 'offer', category: 'food', status: 'active', lat: null, lng: null },
    { id: 'e-1', type: 'event', category: 'community', status: 'active', ...at },
    { id: 'e-2', type: 'event', category: 'community', status: 'active', ...at },
    { id: 'poll', type: 'poll', category: 'community', status: 'active', ...at },
];
const state = (over: Partial<MapFilterState> = {}): MapFilterState => ({ type: 'all', category: 'all', eventWindow: 'all', ...over });
const ids = (list: any[]) => list.map(p => p.id);
const everyEvent = () => true;

describe('the map type filter (one rule for the phone and the web)', () => {
    it('the pills are All, Offers, Needs, Events, in that order', () => {
        expect(MAP_TYPE_FILTERS).toEqual(['all', 'offers', 'needs', 'events']);
    });

    it('All shows offers, needs and polls with a place, never an event, a finished post or one with no place', () => {
        expect(ids(visibleMarketPins(posts, state()))).toEqual(['o-food', 'o-tools', 'n-food', 'poll']);
    });

    it('Offers shows offers only', () => {
        expect(ids(visibleMarketPins(posts, state({ type: 'offers' })))).toEqual(['o-food', 'o-tools']);
    });

    it('Needs shows needs only', () => {
        expect(ids(visibleMarketPins(posts, state({ type: 'needs' })))).toEqual(['n-food']);
    });

    it('a category under Offers narrows the offers, and under Needs the needs', () => {
        expect(ids(visibleMarketPins(posts, state({ type: 'offers', category: 'tools' })))).toEqual(['o-tools']);
        expect(ids(visibleMarketPins(posts, state({ type: 'needs', category: 'food' })))).toEqual(['n-food']);
        expect(ids(visibleMarketPins(posts, state({ type: 'needs', category: 'tools' })))).toEqual([]);
    });

    it('a post filed under a legacy category name sits under the category it was renamed to', () => {
        const legacy = [{ id: 'old', type: 'offer', category: 'food_produce', status: 'active', ...at }];
        expect(ids(visibleMarketPins(legacy, state({ type: 'offers', category: 'food' })))).toEqual(['old']);
    });

    it('a listing with no place still matches the filter (the web pins it near the community), and visibleMarketPins alone wants a place', () => {
        const nowhere = posts.find(p => p.id === 'o-nowhere');
        expect(marketPinMatchesFilter(nowhere, state({ type: 'offers' }))).toBe(true);
        expect(marketPinMatchesFilter(nowhere, state({ type: 'needs' }))).toBe(false);
        expect(marketPinMatchesFilter(nowhere, state({ type: 'offers', category: 'tools' }))).toBe(false);
        expect(marketPinMatchesFilter(posts.find(p => p.id === 'o-old'), state())).toBe(false);
        expect(marketPinMatchesFilter(posts.find(p => p.id === 'e-1'), state())).toBe(false);
        expect(ids(visibleMarketPins([nowhere], state()))).toEqual([]);
    });

    it('Events shows no offer or need pin, and under Events the remembered category stops filtering', () => {
        expect(visibleMarketPins(posts, state({ type: 'events', category: 'tools' }))).toEqual([]);
        expect(ids(visibleEventPins(posts, state({ type: 'events', category: 'tools' }), everyEvent))).toEqual(['e-1', 'e-2']);
    });

    it('event pins show under All and Events only, never under Offers or Needs', () => {
        expect(ids(visibleEventPins(posts, state(), everyEvent))).toEqual(['e-1', 'e-2']);
        expect(visibleEventPins(posts, state({ type: 'offers' }), everyEvent)).toEqual([]);
        expect(visibleEventPins(posts, state({ type: 'needs' }), everyEvent)).toEqual([]);
    });

    it("the date window applies under Events, and under All every event is asked about with 'all'", () => {
        const asked: string[] = [];
        const onlyE2Today = (p: any, w: string) => { asked.push(`${p.id}:${w}`); return p.id === 'e-2' || w === 'all'; };
        expect(ids(visibleEventPins(posts, state({ type: 'events', eventWindow: 'today' }), onlyE2Today))).toEqual(['e-2']);
        expect(ids(visibleEventPins(posts, state({ type: 'all', eventWindow: 'today' }), onlyE2Today))).toEqual(['e-1', 'e-2']);
        expect(asked).toContain('e-1:today');
        expect(asked).toContain('e-1:all');
    });

    it('an event with no place never pins', () => {
        const online = [{ id: 'on', type: 'event', status: 'active', lat: null, lng: null }];
        expect(visibleEventPins(online, state({ type: 'events' }), everyEvent)).toEqual([]);
    });

    it('the ✕ has something to clear once the type or the category is set, and not before', () => {
        expect(mapFiltersActive(state())).toBe(false);
        expect(mapFiltersActive(state({ type: 'offers' }))).toBe(true);
        expect(mapFiltersActive(state({ type: 'events' }))).toBe(true);
        expect(mapFiltersActive(state({ category: 'food' }))).toBe(true);
    });
});
