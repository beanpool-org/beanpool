// Where the web Market and Map read from (S5): the pure rule, every branch.
import { describe, it, expect } from 'vitest';
import { nearRead, nearParams, listingDistanceKm, nearestInCircle } from './listings-near';
import { haversineDistance } from './geo';

const NEARBY = { radiusKm: 250 };
const SETTING = { lat: -37.1, lng: 144.2, radiusKm: 30, label: 'Castlemaine' };
const AREA = { lat: -28.5, lng: 153.5 };

describe('nearRead', () => {
    it('a node without the switch reads as before, whatever the member has set', () => {
        expect(nearRead({ nearbyListings: undefined, setting: SETTING, area: AREA, visitor: false })).toBeNull();
        expect(nearRead({ nearbyListings: null, setting: SETTING, area: AREA, visitor: false })).toBeNull();
    });
    it('a visitor, and a member who asked for everywhere, read as before', () => {
        expect(nearRead({ nearbyListings: NEARBY, setting: SETTING, area: AREA, visitor: true })).toBeNull();
        expect(nearRead({ nearbyListings: NEARBY, setting: SETTING, area: AREA, visitor: false, everywhere: true })).toBeNull();
    });
    it('the distance setting first, then the area at the node\'s radius, then nothing', () => {
        expect(nearRead({ nearbyListings: NEARBY, setting: SETTING, area: AREA, visitor: false }))
            .toEqual({ lat: -37.1, lng: 144.2, radiusKm: 33, sort: 'distance', from: 'setting', circle: { lat: -37.1, lng: 144.2, radiusKm: 30 } });
        expect(nearRead({ nearbyListings: NEARBY, setting: null, area: AREA, visitor: false }))
            .toEqual({ lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance', from: 'area', circle: { lat: -28.5, lng: 153.5, radiusKm: 250 } });
        expect(nearRead({ nearbyListings: NEARBY, setting: null, area: null, visitor: false })).toBeNull();
    });
    it('a stored setting that is not a real place or radius is passed over, never sent (the node would 400)', () => {
        const broken = { ...SETTING, radiusKm: 0 };
        expect(nearRead({ nearbyListings: NEARBY, setting: broken, area: AREA, visitor: false })?.from).toBe('area');
        const garbage = { ...SETTING, lat: Number.NaN };
        expect(nearRead({ nearbyListings: NEARBY, setting: garbage, area: null, visitor: false })).toBeNull();
    });
});

describe('nearRead: a centre past ±180° (the picker\'s map gives 185 for Tonga panned from Fiji)', () => {
    it('wraps the longitude into [-180, 180], so the node does not refuse the read', () => {
        const at = (lng: number) => nearRead({ nearbyListings: NEARBY, setting: { ...SETTING, lat: -21.1, lng }, area: null, visitor: false })?.lng;
        expect(at(185)).toBeCloseTo(-175, 9);
        expect(at(181.6)).toBeCloseTo(-178.4, 9);
        expect(at(-190)).toBeCloseTo(170, 9);
        expect(at(540)).toBeCloseTo(-180, 9);
        expect(at(144.2)).toBe(144.2);
        for (const lng of [185, 181.6, -190, 540, 900.5]) {
            const got = at(lng)!;
            expect(got >= -180 && got <= 180).toBe(true);
        }
        // The exact circle the browser measures from is wrapped too.
        const wrapped = nearRead({ nearbyListings: NEARBY, setting: { ...SETTING, lat: -21.1, lng: 185 }, area: null, visitor: false })!;
        expect(wrapped.circle.lng).toBeCloseTo(-175, 9);
    });
});

// The Distance centre goes to the node only as precisely as its radius needs (scratch/fable-redo/verdict-privacy.md §6,
// N5): the stored area is a 0.1° cell by design, and a query string is what proxies, tunnels and CDNs log by default.
describe('nearRead: the centre sent is rounded by the radius, and the radius widened by a tenth (N5)', () => {
    const FIX = { lat: -28.612345678901, lng: 153.598765432109 };
    const read = (radiusKm: number, at: { lat: number; lng: number } = FIX) =>
        nearRead({ nearbyListings: NEARBY, setting: { ...SETTING, ...at, radiusKm }, area: null, visitor: false })!;

    it.each([
        // radius picked → centre sent (lat, lng) and radius asked for
        [0.1, -28.6123, 153.5988, 0.11],
        [0.5, -28.6123, 153.5988, 0.55],
        [0.999, -28.6123, 153.5988, 1.099],
        [1, -28.612, 153.599, 1.1],
        [5, -28.612, 153.599, 5.5],
        [9.99, -28.612, 153.599, 10.989],
        [10, -28.61, 153.6, 11],
        [25, -28.61, 153.6, 27.5],
        [50, -28.61, 153.6, 55],
    ])('a %s km radius sends the centre as %s, %s and asks for %s km', (radiusKm, lat, lng, asked) => {
        const near = read(radiusKm);
        expect(nearParams(near)).toEqual({ lat, lng, radiusKm: asked, sort: 'distance' });
        expect(near.from).toBe('setting');
    });

    it('the circle keeps the exact centre and radius, for the browser only: it is never a read parameter', () => {
        const near = read(25);
        expect(near.circle).toEqual({ lat: FIX.lat, lng: FIX.lng, radiusKm: 25 });
        expect(Object.keys(nearParams(near)).sort()).toEqual(['lat', 'lng', 'radiusKm', 'sort']);
        expect(JSON.stringify(nearParams(near))).not.toContain('612345');
    });

    it('a wrapped centre is rounded after it is wrapped', () => {
        expect(nearParams(read(30, { lat: -21.123456, lng: 185.123456 }))).toMatchObject({ lat: -21.12, lng: -174.88 });
        expect(nearParams(read(0.2, { lat: -21.123456, lng: 185.123456 }))).toMatchObject({ lat: -21.1235, lng: -174.8765 });
    });

    it('everywhere on Earth, at every radius the picker offers, the exact circle sits inside what the node is asked for', () => {
        const PICKER = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 25, 50];
        for (const lat of [-85, -60, -28.6, -0.4, 0, 28.6, 45, 60, 85]) {
            for (let k = 0; k < 25; k++) {
                const at = { lat: lat + k * 0.0000371, lng: -179.9 + k * 14.3792593 };
                for (const r of PICKER) {
                    const near = read(r, at);
                    const shift = haversineDistance(near.circle.lat, near.circle.lng, near.lat, near.lng);
                    // Under 8 % of the radius (7.9 % at worst, on the equator at a band's smallest radius).
                    expect(shift / r).toBeLessThan(0.08);
                    expect(shift + r).toBeLessThanOrEqual(near.radiusKm);
                }
            }
        }
    });

    it('the area is the node\'s own, already rounded to 0.1°: sent exactly as stored, at the node\'s radius', () => {
        const near = nearRead({ nearbyListings: NEARBY, setting: null, area: { lat: -28.6, lng: 153.6 }, visitor: false })!;
        expect(nearParams(near)).toEqual({ lat: -28.6, lng: 153.6, radiusKm: 250, sort: 'distance' });
        expect(near.circle).toEqual({ lat: -28.6, lng: 153.6, radiusKm: 250 });
    });
});

describe('nearParams and listingDistanceKm', () => {
    const CIRCLE = { lat: 9, lng: 9, radiusKm: 9 };
    it('the read\'s four parameters, or none', () => {
        expect(nearParams(null)).toEqual({});
        expect(nearParams({ lat: 1, lng: 2, radiusKm: 3, sort: 'distance', from: 'area', circle: CIRCLE })).toEqual({ lat: 1, lng: 2, radiusKm: 3, sort: 'distance' });
    });
    it('the node\'s distance first, else measured here, else unknown', () => {
        const measure = () => 99;
        expect(listingDistanceKm({ distanceKm: 12.3, lat: 0, lng: 0 }, measure)).toBe(12.3);
        expect(listingDistanceKm({ distanceKm: null, lat: 0, lng: 0 }, measure)).toBe(99);
        expect(listingDistanceKm({ lat: 0, lng: 0 }, null)).toBeNull();
        expect(listingDistanceKm({ distanceKm: null }, measure)).toBeNull();
        expect(listingDistanceKm({ distanceKm: 12.3, lat: 0, lng: 0 }, measure, { from: 'area' })).toBe(12.3);
    });
    it('a read from the setting is measured here, from the exact centre: the node measured from the rounded one', () => {
        const measure = () => 99;
        expect(listingDistanceKm({ distanceKm: 12.3, lat: 0, lng: 0 }, measure, { from: 'setting' })).toBe(99);
        expect(listingDistanceKm({ distanceKm: null }, measure, { from: 'setting' })).toBeNull();
    });
});

describe('nearestInCircle: what a read from the setting brought back, cut to the exact circle, nearest first from its centre', () => {
    // A 5 km setting at a GPS-precise centre: the node was asked for 5.5 km round -28.612, 153.599.
    const near = nearRead({ nearbyListings: NEARBY, setting: { lat: -28.612345, lng: 153.598765, radiusKm: 5, label: '5km radius' }, area: null, visitor: false })!;
    const at = (id: string, lng: number | null) => ({ id, lat: lng === null ? null : -28.612345, lng });
    // From the exact centre: 2.07 km; 5.20 km (inside 5.5 km of the rounded centre); 1.10 km; 5.001 km east (4.98 km
    // from the rounded centre); 4.995 km west (5.018 km from the rounded centre: 5 km round it would have lost it); and
    // one with no place.
    const sent = [at('two', 153.62), at('ring', 153.652), at('one', 153.61), at('east', 153.65), at('west', 153.5476), at('none', null)];

    it('drops what the wider read brought in past the edge, and orders by the exact centre', () => {
        const exact = (lng: number) => haversineDistance(-28.612345, 153.598765, -28.612345, lng);
        const rounded = (lng: number) => haversineDistance(near.lat, near.lng, -28.612345, lng);
        expect([exact(153.65), rounded(153.65)].map(d => d > 5)).toEqual([true, false]);
        expect([exact(153.5476), rounded(153.5476)].map(d => d > 5)).toEqual([false, true]);
        expect(nearestInCircle(sent, near).map(p => p.id)).toEqual(['one', 'two', 'west']);
    });

    it('a read from the area, and no read, are left as the node sent them', () => {
        const area = nearRead({ nearbyListings: NEARBY, setting: null, area: AREA, visitor: false })!;
        expect(nearestInCircle(sent, area)).toBe(sent);
        expect(nearestInCircle(sent, null)).toBe(sent);
    });
});
