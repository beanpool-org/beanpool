/** A community's area on a map: a line that closes, sits on the radius and reads on the map under it (map-area-ring.ts). */
import { describe, expect, it } from 'vitest';
import { BRAND_COLOURS, MAP_GROUNDS, contrastRatio } from '../brand-colours.js';
import { AREA_RING_DASH, AREA_RING_POINTS, AREA_RING_WIDTH, areaRingColour, areaRingDash, areaRingLeafletStyle, areaRingPoints, type RingPoint } from '../map-area-ring.js';

const rad = Math.PI / 180;

/** Great-circle km on the same sphere, worked out the other way round from how the ring is made. */
function haversineKm(a: RingPoint, b: RingPoint): number {
    const dLat = (b.latitude - a.latitude) * rad;
    const dLng = (b.longitude - a.longitude) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

/** The compass bearing from a to b, in degrees. */
function bearing(a: RingPoint, b: RingPoint): number {
    const y = Math.sin((b.longitude - a.longitude) * rad) * Math.cos(b.latitude * rad);
    const x = Math.cos(a.latitude * rad) * Math.sin(b.latitude * rad) - Math.sin(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.cos((b.longitude - a.longitude) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
}

const BANGALOW = { latitude: -28.5398, longitude: 153.4996 };
/** A line on a map is a graphic, not words: WCAG's bar for those. */
const LINE_MIN = 3;

describe('the ring as a line', () => {
    it('closes on itself', () => {
        const ring = areaRingPoints(BANGALOW, 20);
        expect(ring).toHaveLength(AREA_RING_POINTS + 1);
        expect(ring[ring.length - 1]).toEqual(ring[0]);
    });

    it.each([
        ['Bangalow, 20 km', BANGALOW, 20],
        ['a tiny area', BANGALOW, 0.2],
        ['a wide area', BANGALOW, 400],
        ['high up, where a degree of longitude is short', { latitude: 69.65, longitude: 18.96 }, 150],
        ['on the equator', { latitude: 0, longitude: 0 }, 50],
    ])('sits on the radius on a sphere, all the way round: %s', (_, centre, km) => {
        for (const point of areaRingPoints(centre, km)) expect(haversineKm(centre, point) / km).toBeCloseTo(1, 6);
    });

    it('is a circle on the ground, not in degrees: at 69° N it spans nearly three times the degrees east-west as north-south', () => {
        const centre = { latitude: 69.65, longitude: 18.96 };
        const ring = areaRingPoints(centre, 100);
        const lats = ring.map((p) => p.latitude);
        const lngs = ring.map((p) => p.longitude);
        expect((Math.max(...lngs) - Math.min(...lngs)) / (Math.max(...lats) - Math.min(...lats))).toBeGreaterThan(2.8);
    });

    it('reads round: even steps round the compass, so no corner turns more than a degree or two', () => {
        const ring = areaRingPoints(BANGALOW, 20);
        const stepKm = 2 * Math.PI * 20 / AREA_RING_POINTS;
        for (let i = 1; i < ring.length; i += 1) {
            expect(haversineKm(ring[i - 1], ring[i]) / stepKm).toBeCloseTo(1, 3);
            if (i < 2) continue;
            const turn = Math.abs(bearing(ring[i - 1], ring[i]) - bearing(ring[i - 2], ring[i - 1]));
            expect(Math.min(turn, 360 - turn)).toBeLessThan(1.5);
        }
    });

    it('keeps neighbours neighbours across the 180th meridian', () => {
        const ring = areaRingPoints({ latitude: -17.7, longitude: 179.9 }, 50);
        expect(Math.max(...ring.map((p) => p.longitude))).toBeGreaterThan(180);
        for (let i = 1; i < ring.length; i += 1) expect(Math.abs(ring[i].longitude - ring[i - 1].longitude)).toBeLessThan(0.1);
    });
});

describe('how it is drawn', () => {
    it('stays thin and dashed', () => {
        expect(AREA_RING_WIDTH).toBeLessThan(2);
        expect(AREA_RING_DASH).toEqual([8, 5]);
    });

    it('turns Google\'s dashes into pixels, and leaves Apple\'s in points', () => {
        expect(areaRingDash('android', 3)).toEqual([24, 15]);
        expect(areaRingDash('android', 1.5)).toEqual([12, 7.5]);
        expect(areaRingDash('ios', 3)).toEqual([8, 5]);
    });

    it('has no fill on Leaflet, and the light map\'s colour, in either app theme, because OSM has no dark map', () => {
        const style = areaRingLeafletStyle();
        expect(style.fill).toBe(false);
        expect(style).not.toHaveProperty('fillColor');
        expect(style).not.toHaveProperty('fillOpacity');
        expect(style).toEqual({ color: BRAND_COLOURS.map.ring.light, weight: AREA_RING_WIDTH, dashArray: '8 5', fill: false });
    });

    it('takes its colour from the map under it', () => {
        expect(areaRingColour(false)).toBe(BRAND_COLOURS.map.ring.light);
        expect(areaRingColour(true)).toBe(BRAND_COLOURS.map.ring.dark);
    });
});

describe('visible, and quiet on the dark map (Marty, 2 Nov)', () => {
    const on = (theme: 'light' | 'dark') => MAP_GROUNDS[theme].map((ground) => contrastRatio(BRAND_COLOURS.map.ring[theme], ground));

    it('on the light map it is easy to find on every ground, where the old amber was 2:1 at best', () => {
        expect(Math.min(...on('light'))).toBeGreaterThanOrEqual(4);
        expect(Math.max(...MAP_GROUNDS.light.map((ground) => contrastRatio('#f59e0b', ground)))).toBeLessThan(2.2);
    });

    it('on the dark map it clears the bar for a line on land and water, and stays under the bright amber', () => {
        expect(Math.min(...on('dark'))).toBeGreaterThanOrEqual(LINE_MIN);
        const land = contrastRatio(BRAND_COLOURS.map.ring.dark, MAP_GROUNDS.dark[0]);
        expect(land).toBeLessThan(4);
        expect(land).toBeLessThan(contrastRatio(BRAND_COLOURS.ink.warning.dark, MAP_GROUNDS.dark[0]));
    });
});
