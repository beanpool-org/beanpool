// Where the web Market and Map read from (S5): the pure rule, every branch.
import { describe, it, expect } from 'vitest';
import { nearRead, nearParams, listingDistanceKm } from './listings-near';

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
            .toEqual({ lat: -37.1, lng: 144.2, radiusKm: 30, sort: 'distance', from: 'setting' });
        expect(nearRead({ nearbyListings: NEARBY, setting: null, area: AREA, visitor: false }))
            .toEqual({ lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance', from: 'area' });
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
    });
});

describe('nearRead: the Distance centre goes to the node at 4 dp, as the phone sends its position (about 11 m)', () => {
    it('rounds a live-GPS-precise centre, and a wrapped one', () => {
        const read = (lat: number, lng: number) => nearRead({ nearbyListings: NEARBY, setting: { ...SETTING, lat, lng }, area: null, visitor: false });
        expect(read(-28.612345678901, 153.598765432109)).toMatchObject({ lat: -28.6123, lng: 153.5988, from: 'setting' });
        expect(read(-28.643187, 153.612349)).toMatchObject({ lat: -28.6432, lng: 153.6123 });
        expect(read(-21.123456, 185.123456)).toMatchObject({ lat: -21.1235, lng: -174.8765 });
        // The area is the node's own, already rounded to 0.1°: sent exactly as stored.
        expect(nearRead({ nearbyListings: NEARBY, setting: null, area: { lat: -28.6, lng: 153.6 }, visitor: false }))
            .toMatchObject({ lat: -28.6, lng: 153.6, from: 'area' });
    });
});

describe('nearParams and listingDistanceKm', () => {
    it('the read\'s four parameters, or none', () => {
        expect(nearParams(null)).toEqual({});
        expect(nearParams({ lat: 1, lng: 2, radiusKm: 3, sort: 'distance', from: 'area' })).toEqual({ lat: 1, lng: 2, radiusKm: 3, sort: 'distance' });
    });
    it('the node\'s distance first, else measured here, else unknown', () => {
        const measure = () => 99;
        expect(listingDistanceKm({ distanceKm: 12.3, lat: 0, lng: 0 }, measure)).toBe(12.3);
        expect(listingDistanceKm({ distanceKm: null, lat: 0, lng: 0 }, measure)).toBe(99);
        expect(listingDistanceKm({ lat: 0, lng: 0 }, null)).toBeNull();
        expect(listingDistanceKm({ distanceKm: null }, measure)).toBeNull();
    });
});
