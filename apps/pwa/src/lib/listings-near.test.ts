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
