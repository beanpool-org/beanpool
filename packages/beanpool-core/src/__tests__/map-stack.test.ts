import { describe, expect, it } from 'vitest';
import { MAP_TAP_CAP_ZOOM, bubbleLandingZoom, bubbleTap, orderStack, stackHeading } from '../map-stack.js';

describe('a tap on a map bubble', () => {
    it('zooms while the cap can part the bubble, and lists it past that', () => {
        expect(bubbleTap(MAP_TAP_CAP_ZOOM - 1, MAP_TAP_CAP_ZOOM)).toBe('zoom');
        expect(bubbleTap(MAP_TAP_CAP_ZOOM, MAP_TAP_CAP_ZOOM)).toBe('zoom');
        expect(bubbleTap(MAP_TAP_CAP_ZOOM + 1, MAP_TAP_CAP_ZOOM)).toBe('list');
        expect(bubbleTap(Infinity, MAP_TAP_CAP_ZOOM)).toBe('list');
    });

    it('lands where the pins fit, deep enough to part them, and never past the cap', () => {
        expect(bubbleLandingZoom(15.4, 14, 17)).toBe(15.4);
        expect(bubbleLandingZoom(12, 14, 17)).toBe(14);
        expect(bubbleLandingZoom(20, 14, 17)).toBe(17);
        expect(bubbleLandingZoom(Infinity, 14, 17)).toBe(17);
    });
});

describe('the order of a bubble\'s list', () => {
    type Row = { id: string; eventStartMs: number | null; createdMs: number };
    const row = (id: string, eventStartMs: number | null, createdMs: number): Row => ({ id, eventStartMs, createdMs });
    const order = (rows: Row[]) => orderStack(rows, (r) => r).map((r) => r.id);

    it('puts the soonest events first, then Offers and Needs together, newest first', () => {
        expect(order([row('old', null, 1), row('later', 900, 5), row('new', null, 3), row('soon', 500, 9), row('mid', null, 2)]))
            .toEqual(['soon', 'later', 'new', 'mid', 'old']);
    });

    it('puts an event with no readable date after the dated ones and before the listings', () => {
        expect(order([row('listing', null, 9), row('undated', NaN, 1), row('dated', 500, 1)])).toEqual(['dated', 'undated', 'listing']);
    });

    it('puts a listing with no readable date last, and keeps ties in the order they came', () => {
        expect(order([row('unknown', null, NaN), row('a', null, 5), row('b', null, 5)])).toEqual(['a', 'b', 'unknown']);
    });
});

describe('the list\'s header', () => {
    it('counts the pins', () => {
        expect(stackHeading(3)).toBe('3 at this spot');
        expect(stackHeading(100)).toBe('100 at this spot');
    });
});
