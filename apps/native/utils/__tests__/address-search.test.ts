import { describe, it, expect } from 'vitest';
import { parseNominatimResults } from '@beanpool/core';
import { nominatimHeaders, placeNameAfterPick } from '../address-search';

const [hall, house] = parseNominatimResults([
    { display_name: 'Bindarrabi Hall, 12, Main Street, Mullumbimby', name: 'Bindarrabi Hall', lat: '-28.55437', lon: '153.50261', type: 'community_centre' },
    { display_name: '12, Main Street, Mullumbimby', name: '', lat: '-28.554', lon: '153.502', type: 'house' },
]);

describe('nominatimHeaders', () => {
    it('names the app, its version and platform in User-Agent, as Nominatim policy asks', () => {
        expect(nominatimHeaders('1.2.36', 'android')).toEqual({ 'User-Agent': 'BeanPool/1.2.36 (android; +https://beanpool.org)' });
        expect(nominatimHeaders('1.2.36', 'ios')['User-Agent']).toContain('BeanPool/1.2.36 (ios;');
    });
    it('still names the app when the version is unknown or odd', () => {
        expect(nominatimHeaders(null, 'android')['User-Agent']).toBe('BeanPool/unknown (android; +https://beanpool.org)');
        expect(nominatimHeaders('1.2 (x)\r\nX: y', 'android')['User-Agent']).toMatch(/^BeanPool\/unknown /);
    });
});

describe('placeNameAfterPick', () => {
    it('fills an empty Place name with the short name of the result', () => {
        expect(placeNameAfterPick('', hall, 80)).toBe('Bindarrabi Hall');
        expect(placeNameAfterPick('   ', house, 80)).toBe('12 Main Street');
    });
    it('never overwrites what the member typed', () => {
        expect(placeNameAfterPick('The old bowls club', hall, 80)).toBe('The old bowls club');
    });
    it('respects the field limit', () => {
        expect(placeNameAfterPick('', { ...hall, shortName: 'x'.repeat(100) }, 80)).toHaveLength(80);
    });
});
