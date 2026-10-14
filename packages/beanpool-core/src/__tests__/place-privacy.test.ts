import { describe, expect, it } from 'vitest';
import { looksLikeStreetAddress, placeShownRoughly, neighbourhoodOf, neighbourhoodLngStep, NEIGHBOURHOOD_LAT_STEP } from '../index';

// What a member sees of other people's places where anyone can join (DESIGN-global-member-privacy-fable.md §4).
const ME = 'a'.repeat(64);
const THEM = 'b'.repeat(64);
const at = { lat: -28.65, lng: 153.55 };

describe('placeShownRoughly: when a listing says its place is to about 1 km', () => {
    it('only where anyone can join, only with a place, never on your own', () => {
        expect(placeShownRoughly({ authorPublicKey: THEM, type: 'offer', ...at }, ME, true)).toBe(true);
        expect(placeShownRoughly({ authorPublicKey: THEM, type: 'offer', ...at }, ME, false)).toBe(false);
        expect(placeShownRoughly({ authorPublicKey: THEM, type: 'offer', lat: null, lng: null }, ME, true)).toBe(false);
        expect(placeShownRoughly({ authorPublicKey: ME, type: 'offer', ...at }, ME, true)).toBe(false);
    });
    it('an event: not to its host nor to someone Going who has the spot; yes while waiting or not going', () => {
        const ev = { authorPublicKey: THEM, type: 'event', ...at };
        expect(placeShownRoughly({ ...ev, eventRsvps: [] }, ME, true)).toBe(false);
        expect(placeShownRoughly({ ...ev, myRsvp: 'going', myLetIn: true }, ME, true)).toBe(false);
        expect(placeShownRoughly({ ...ev, myRsvp: 'going' }, ME, true)).toBe(false);
        expect(placeShownRoughly({ ...ev, myRsvp: 'going', myLetIn: false }, ME, true)).toBe(true);
        expect(placeShownRoughly({ ...ev, myRsvp: 'interested', myLetIn: null }, ME, true)).toBe(true);
        expect(placeShownRoughly(ev, ME, true)).toBe(true);
    });
});

describe('looksLikeStreetAddress: the gentle nudge under an event\'s place name', () => {
    it('catches a house number and a street', () => {
        for (const s of ['12 Example St', 'Alice back garden, 12 Example St', '4/21 Station Road', 'Unit 3, 9 Hill Cres', '7a Byron Bay Rd.', '100 Main Street']) {
            expect(looksLikeStreetAddress(s), s).toBe(true);
        }
    });
    it('leaves a hall, a club and a numbered shed alone', () => {
        for (const s of ['Bangalow Hall', 'The old bowls club', 'Shed 2', 'Lot 12', 'Park, near the 3 big trees', '']) {
            expect(looksLikeStreetAddress(s), s).toBe(false);
        }
    });
});

/** Great-circle km, as the node measures. */
function km(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const r = (d: number) => d * Math.PI / 180;
    const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}
/** A row's east–west width in km, measured along the row from one cell edge to the next. */
const widthKm = (cellLat: number) => km(cellLat, 0, cellLat, neighbourhoodLngStep(cellLat));

describe('neighbourhoodOf: a cell about 1 km across both ways, everywhere (Marty, 15 Oct: "Widen by latitude")', () => {
    it('east–west at 60° is at least 0.9 km (a fixed 0.01° was 0.56 km)', () => {
        expect(widthKm(60.2)).toBeGreaterThanOrEqual(0.9);
        // Measured from the cells themselves: walking east along 60.2°N, the centre moves on by the row's step.
        const centres = [...new Set(Array.from({ length: 400 }, (_, i) => neighbourhoodOf(60.2, 24.9 + i * 0.0001).lng))];
        const gaps = centres.slice(1).map((c, i) => km(60.2, centres[i], 60.2, c));
        expect(gaps.length).toBeGreaterThan(0);
        for (const g of gaps) expect(g).toBeGreaterThanOrEqual(0.9);
    });
    it('between 0.9 and 1.3 km east–west at 0°, 45°, 60°, 70° and on both sides of a band edge; 1.11 km north–south', () => {
        for (const lat of [0.3, -0.3, 45.3, -45.3, 60.3, 70.3, -70.3, 60.99, 61.0, 61.01, 84.5]) {
            expect(widthKm(lat), `at ${lat}°`).toBeGreaterThanOrEqual(0.9);
            expect(widthKm(lat), `at ${lat}°`).toBeLessThanOrEqual(1.3);
        }
        expect(km(60, 0, 60 + NEIGHBOURHOOD_LAT_STEP, 0)).toBeCloseTo(1.112, 2);
    });
    it('banded: every row of a 1° band shares one step, a whole number of cells round the Earth, at least 0.01°', () => {
        for (const band of [-90, -61, -1, 0, 44, 60, 61, 89]) {
            const step = neighbourhoodLngStep(band + 0.005);
            expect(neighbourhoodLngStep(band + 0.99)).toBe(step);
            expect(Math.abs(360 / step - Math.round(360 / step))).toBeLessThan(1e-9);
            expect(step).toBeGreaterThanOrEqual(0.01);
        }
        expect(neighbourhoodLngStep(60.99)).not.toBe(neighbourhoodLngStep(61.0));
    });
    it('clamped by the poles: the step stops widening at about 1.15°, and the pole rows have one', () => {
        expect(neighbourhoodLngStep(89.99)).toBeCloseTo(360 / 314, 9);
        expect(neighbourhoodLngStep(90)).toBe(neighbourhoodLngStep(89.5));
        expect(neighbourhoodLngStep(-90)).toBe(neighbourhoodLngStep(-89.5));
        expect(Number.isFinite(neighbourhoodOf(90, 12.3).lng) && Number.isFinite(neighbourhoodOf(-90, -170).lng)).toBe(true);
    });
    it('the centre is the rule restated: latitude to 0.01°, longitude to the row\'s step, six decimals, never -0', () => {
        const spec = (lat: number, lng: number) => {
            const cellLat = Math.round(lat * 100) / 100 + 0;
            const band = Math.min(89, Math.max(-90, Math.floor(cellLat)));
            const cells = Math.max(1, Math.min(36000, Math.round(36000 * Math.cos((band + 0.5) * Math.PI / 180))));
            let k = Math.round(lng / (360 / cells));
            if (k > cells / 2) k -= cells;
            if (k < -cells / 2) k += cells;
            return { lat: cellLat, lng: Math.max(-180, Math.min(180, Math.round(k * 360 / cells * 1e6) / 1e6 + 0)) };
        };
        let seed = 20261015;
        const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        for (let i = 0; i < 2000; i++) {
            const lat = (rand() - 0.5) * 180, lng = (rand() - 0.5) * 360;
            expect(neighbourhoodOf(lat, lng)).toEqual(spec(lat, lng));
        }
        expect(neighbourhoodOf(-28.654312, 153.552181).lat).toBe(-28.65);
        expect(Object.is(neighbourhoodOf(-0.001, -0.0001).lat, -0)).toBe(false);
        expect(Object.is(neighbourhoodOf(-0.001, -0.0001).lng, -0)).toBe(false);
    });
    it('a place is never more than half a cell from its centre: 0.005° north–south, half the row\'s step east–west', () => {
        let seed = 77;
        const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        for (let i = 0; i < 2000; i++) {
            const lat = (rand() - 0.5) * 170, lng = (rand() - 0.5) * 359;
            const c = neighbourhoodOf(lat, lng);
            expect(Math.abs(c.lat - lat)).toBeLessThanOrEqual(0.005 + 1e-9);
            expect(Math.abs(c.lng - lng)).toBeLessThanOrEqual(neighbourhoodLngStep(c.lat) / 2 + 1e-6);
        }
    });
    it('the antimeridian: the cells meet there, and nothing is served past ±180', () => {
        for (const lat of [-16.5, 0.2, 60.3, 70.3]) {
            for (const lng of [179.9999, -179.9999, 180, -180]) {
                const c = neighbourhoodOf(lat, lng);
                expect(c.lng).toBeGreaterThanOrEqual(-180);
                expect(c.lng).toBeLessThanOrEqual(180);
                expect(km(lat, lng, c.lat, c.lng)).toBeLessThan(1.2);
            }
        }
    });
});
