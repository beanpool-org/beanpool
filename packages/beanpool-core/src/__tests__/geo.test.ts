import { describe, it, expect } from 'vitest';
import { roundToArea, roundPointToArea } from '../geo.js';
import * as barrel from '../index.js';
import { areaWhyLine, describeArea, placelessListingNote, PLACELESS_NO_AREA_NOTE, PLACELESS_AT_AREA_NOTE, AREA_STEP_WORDS } from '../member-area-words.js';

// The apps round a position to its 0.1° area with this function BEFORE it leaves the device (signup's area step,
// Settings → Your area); the node rounds again with the engine's roundToArea, which is this same function re-exported
// (packages/beanpool-engine/src/geo.ts; its posts.test.ts asserts the identity). These values are the ones the engine's
// own implementation gave before the move (`Math.round(deg * 10) / 10 + 0`), so a phone's area is the node's area.
const ENGINE_BEFORE_THE_MOVE = (deg: number) => Math.round(deg * 10) / 10 + 0;

describe('roundToArea (0.1°, shared by the apps and the engine)', () => {
    it('rounds to the nearest 0.1°, halves up, never -0', () => {
        expect(roundToArea(-28.53417)).toBe(-28.5);
        expect(roundToArea(153.45)).toBe(153.5);
        expect(roundToArea(-0.04)).toBe(0);
        expect(Object.is(roundToArea(-0.04), -0)).toBe(false);
        expect(roundToArea(179.97)).toBe(180);
        expect(roundToArea(-179.97)).toBe(-180);
        expect(roundToArea(-28.65)).toBe(-28.6); // a half rounds up, not away from zero (SQL round() would say -28.7)
        for (const x of [-89.96, 0.3, 12.34, -45.55]) expect(roundToArea(roundToArea(x))).toBe(roundToArea(x));
    });

    it('gives exactly what the engine gave, across the whole globe', () => {
        let seed = 7;
        const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        for (let i = 0; i < 20000; i++) {
            const lat = rand() * 180 - 90;
            const lng = rand() * 360 - 180;
            expect(Object.is(roundToArea(lat), ENGINE_BEFORE_THE_MOVE(lat))).toBe(true);
            expect(Object.is(roundToArea(lng), ENGINE_BEFORE_THE_MOVE(lng))).toBe(true);
        }
        // Every half-step boundary near the places people live, where a different rule would disagree.
        for (let t = -1800; t <= 1800; t++) {
            const half = t / 10 + 0.05;
            expect(Object.is(roundToArea(half), ENGINE_BEFORE_THE_MOVE(half))).toBe(true);
        }
    });

    it('rounds a point on both axes and is exported from the barrel', () => {
        expect(roundPointToArea(-28.64741, 153.61203)).toEqual({ lat: -28.6, lng: 153.6 });
        expect(barrel.roundToArea).toBe(roundToArea);
        expect(barrel.roundPointToArea).toBe(roundPointToArea);
    });
});

describe('the area step\'s words, shared by both apps', () => {
    it('says the node\'s numbers, else the decided 500 within 250 km; no currency', () => {
        expect(areaWhyLine({ radiusKm: 100, max: 300 })).toBe("The worldwide community shows you what's on offer near you: the nearest 300 listings within 100 km.");
        expect(areaWhyLine(null)).toContain('the nearest 500 listings within 250 km');
        expect(JSON.stringify(AREA_STEP_WORDS)).not.toMatch(/Ʀ|Beans/);
    });

    it('describeArea: a town, else two numbers to 0.1°, else Not set', () => {
        expect(describeArea(null)).toBe('Not set');
        expect(describeArea({ lat: -28.6, lng: 153.6 }, 'Byron Bay')).toBe('About 10 km around Byron Bay');
        expect(describeArea({ lat: 51.5, lng: -0.1 })).toBe('About 10 km around 51.5, -0.1');
    });

    it('the placeless note: only on a by-area community; says the poll is shown at the area when the author has one', () => {
        expect(placelessListingNote(true, null)).toBe(PLACELESS_NO_AREA_NOTE);
        expect(placelessListingNote(true, undefined)).toBeNull(); // couldn't ask: say nothing rather than something false
        expect(placelessListingNote(true, { lat: 1, lng: 2 })).toBe(PLACELESS_AT_AREA_NOTE);
        expect(PLACELESS_AT_AREA_NOTE).toBe('This poll is shown at your area (about 10 km around it) to everyone who can read it.');
        expect(placelessListingNote(false, null)).toBeNull();
        expect(placelessListingNote(false, { lat: 1, lng: 2 })).toBeNull();
    });

    it('the privacy line says a poll is shown at the area, never that a distance is all others see (review B1)', () => {
        expect(AREA_STEP_WORDS.privacy).toBe('We keep your area to about 10 km, never your exact spot. Other members see how far away you are, and a poll you make is shown at your area.');
        expect(AREA_STEP_WORDS.privacy).not.toMatch(/only a distance/);
    });
});
