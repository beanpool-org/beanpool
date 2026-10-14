import { describe, expect, it } from 'vitest';
import { approximateLocation, roundToRoughly100m } from './geo';

describe('geo utility', () => {
    describe('approximateLocation', () => {
        it('rounds latitude and longitude to 3 decimal places (~100m precision)', () => {
            const result = approximateLocation(37.774929, -122.419416);
            expect(result).toEqual({
                lat: 37.775,
                lng: -122.419,
            });
        });

        it('handles integer coordinates without altering values', () => {
            const result = approximateLocation(40, -74);
            expect(result).toEqual({
                lat: 40,
                lng: -74,
            });
        });

        it('handles negative coordinates correctly', () => {
            const result = approximateLocation(-33.8688197, 151.2092955);
            expect(result).toEqual({
                lat: -33.869,
                lng: 151.209,
            });
        });

        it('handles zero coordinates', () => {
            const result = approximateLocation(0, 0);
            expect(result).toEqual({
                lat: 0,
                lng: 0,
            });
        });

        it('handles extreme coordinate boundaries (poles and anti-meridian)', () => {
            const northPole = approximateLocation(90.000001, -180.000001);
            expect(northPole).toEqual({ lat: 90, lng: -180 });

            const southPole = approximateLocation(-90.000001, 180.000001);
            expect(southPole).toEqual({ lat: -90, lng: 180 });
        });

        it('rounds values based on standard 3-decimal-place thresholds', () => {
            // Rounds up when 4th digit >= 5
            expect(approximateLocation(12.3455, 67.8905)).toEqual({ lat: 12.346, lng: 67.891 });
            // Rounds down when 4th digit < 5
            expect(approximateLocation(12.3454, 67.8904)).toEqual({ lat: 12.345, lng: 67.89 });
        });
    });

    describe('roundToRoughly100m', () => {
        it('is an alias for approximateLocation and yields identical results', () => {
            expect(roundToRoughly100m).toBe(approximateLocation);
            expect(roundToRoughly100m(12.34567, 98.76543)).toEqual(approximateLocation(12.34567, 98.76543));
        });
    });
});
