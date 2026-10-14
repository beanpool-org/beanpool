import { describe, expect, it } from 'vitest';
import { canonicalZone, instantToLocal, isKnownZone, zoneLabel, zonedToInstant } from '../event-time.js';

describe('zonedToInstant — the design vectors (DESIGN-event-times §0, §7)', () => {
    it('Sydney, Fri 16 Oct 2026 20:50 → 09:50Z', () => {
        expect(zonedToInstant('2026-10-16T20:50', 'Australia/Sydney')).toEqual({
            instant: '2026-10-16T09:50:00.000Z', local: '2026-10-16T20:50', adjusted: null,
        });
    });

    it('Sydney DST gap, 4 Oct 2026 02:30 does not exist: forward to 03:30 AEDT', () => {
        expect(zonedToInstant('2026-10-04T02:30', 'Australia/Sydney')).toEqual({
            instant: '2026-10-03T16:30:00.000Z', local: '2026-10-04T03:30', adjusted: 'gap',
        });
    });

    it('Sydney DST overlap, 5 Apr 2026 02:30 happens twice: the earlier, 15:30Z', () => {
        expect(zonedToInstant('2026-04-05T02:30', 'Australia/Sydney')).toEqual({
            instant: '2026-04-04T15:30:00.000Z', local: '2026-04-05T02:30', adjusted: 'overlap',
        });
    });

    it('a weekly Friday 20:50 in Sydney is an hour apart in UTC across the DST start', () => {
        expect(zonedToInstant('2026-10-02T20:50', 'Australia/Sydney')!.instant).toBe('2026-10-02T10:50:00.000Z');
        expect(zonedToInstant('2026-10-09T20:50', 'Australia/Sydney')!.instant).toBe('2026-10-09T09:50:00.000Z');
    });

    it('Lagos has no DST: 20:50 is 19:50Z in any month', () => {
        expect(zonedToInstant('2026-10-17T20:50', 'Africa/Lagos')!.instant).toBe('2026-10-17T19:50:00.000Z');
        expect(zonedToInstant('2026-01-17T20:50', 'Africa/Lagos')!.instant).toBe('2026-01-17T19:50:00.000Z');
    });

    it('an unknown zone or a malformed clock is refused', () => {
        expect(zonedToInstant('2026-10-16T20:50', 'Mars/Olympus')).toBeNull();
        expect(zonedToInstant('2026-10-16 20:50', 'Australia/Sydney')).toBeNull();
        expect(zonedToInstant('2026-10-16T20:50:00', 'Australia/Sydney')).toBeNull();
    });
});

describe('instantToLocal / zones', () => {
    it("renders an instant in a zone's clock", () => {
        expect(instantToLocal('2026-10-16T09:50:00.000Z', 'Australia/Sydney')).toBe('2026-10-16T20:50');
        expect(instantToLocal('2026-10-17T19:50:00.000Z', 'America/New_York')).toBe('2026-10-17T15:50');
        expect(instantToLocal('2026-10-16T14:00:00.000Z', 'Australia/Sydney')).toBe('2026-10-17T01:00');
        expect(instantToLocal('2026-10-16T13:00:00.000Z', 'Australia/Sydney')).toBe('2026-10-17T00:00');
    });

    it('knows real zones, refuses made-up ones, and spells a legacy alias the canonical way', () => {
        expect(isKnownZone('Australia/Sydney')).toBe(true);
        expect(isKnownZone('Mars/Olympus')).toBe(false);
        expect(isKnownZone('')).toBe(false);
        expect(isKnownZone(42)).toBe(false);
        expect(canonicalZone('US/Pacific')).toBe('America/Los_Angeles');
    });

    it('labels: places in plain words (Kiev → Kyiv, Calcutta → Kolkata), and zones that are not places by offset', () => {
        expect(zoneLabel('Australia/Sydney', '2026-10-16T09:50:00.000Z')).toBe('Sydney time');
        expect(zoneLabel('Africa/Lagos')).toBe('Lagos time');
        expect(zoneLabel(canonicalZone('Europe/Kyiv')!)).toBe('Kyiv time');
        expect(zoneLabel(canonicalZone('Asia/Kolkata')!)).toBe('Kolkata time');
        expect(zoneLabel('Etc/GMT-1')).toBe('UTC+1 time');
        expect(zoneLabel('UTC')).toBe('UTC time');
        expect(zoneLabel('America/North_Dakota/Center', '2026-01-15T12:00:00.000Z')).toBe('UTC−6 time');
        expect(zoneLabel('America/Indiana/Knox', '2026-07-15T12:00:00.000Z')).toBe('UTC−5 time');
    });
});
