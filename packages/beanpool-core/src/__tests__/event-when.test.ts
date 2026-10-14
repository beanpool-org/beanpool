import { describe, expect, it } from 'vitest';
import { eventPlaceTimeText, eventWhenParts, offsetMinutesOf, zoneLabelFor } from '../event-when.js';

const line = (p: ReturnType<typeof eventWhenParts>) => p ? `${p.first}${p.sep}${p.second}` : null;

// A Lagos meetup, Sat 17 Oct 2026 20:50–22:50 West Africa Time (UTC+1) = 19:50Z–21:50Z.
const lagos = {
    startAt: '2026-10-17T19:50:00.000Z', endAt: '2026-10-17T21:50:00.000Z',
    startLocal: '2026-10-17T20:50', endLocal: '2026-10-17T22:50', tz: 'Africa/Lagos', online: false,
};

describe('eventWhenParts — every §4 string at a fixed device zone', () => {
    it("in person, the reader's clock is the place's: today's line and nothing more", () => {
        const sydney = {
            startAt: '2026-10-16T09:50:00.000Z', endAt: '2026-10-16T11:50:00.000Z',
            startLocal: '2026-10-16T20:50', endLocal: '2026-10-16T22:50', tz: 'Australia/Sydney', online: false,
        };
        const p = eventWhenParts({ ...sydney, deviceStart: '2026-10-16T20:50', deviceEnd: '2026-10-16T22:50' });
        expect(line(p)).toBe('FRI 16 OCT · 20:50–22:50');
        expect(p!.note).toBeNull();
    });

    it('in person, a reader in New York: the place clock first, theirs second', () => {
        const p = eventWhenParts({ ...lagos, deviceStart: '2026-10-17T15:50', deviceEnd: '2026-10-17T17:50' });
        expect(line(p)).toBe('SAT 17 OCT · 20:50–22:50');
        expect(p!.note).toBe('Lagos time · 15:50 your time');
    });

    it("in person, a reader in Sydney whose date differs: their day is named", () => {
        const p = eventWhenParts({ ...lagos, deviceStart: '2026-10-18T06:50', deviceEnd: '2026-10-18T08:50' });
        expect(line(p)).toBe('SAT 17 OCT · 20:50–22:50');
        expect(p!.note).toBe('Lagos time · SUN 18 OCT 6:50 your time');
    });

    it("online, a Sydney host's 20:50 read in London: the reader's own clock, with 'your time'", () => {
        const p = eventWhenParts({
            startAt: '2026-10-16T09:50:00.000Z', endAt: '2026-10-16T11:50:00.000Z',
            startLocal: '2026-10-16T20:50', endLocal: '2026-10-16T22:50', tz: 'Australia/Sydney', online: true,
            deviceStart: '2026-10-16T10:50', deviceEnd: '2026-10-16T12:50',
        });
        expect(line(p)).toBe('FRI 16 OCT · 10:50–12:50 your time');
        expect(p!.note).toBeNull();
        expect(p!.hostLine).toBe('20:50 for the host (Sydney time)');
    });

    it('across midnight keeps the two-day shape', () => {
        const p = eventWhenParts({
            startAt: '2026-09-27T12:00:00.000Z', endAt: '2026-09-27T16:00:00.000Z',
            startLocal: '2026-09-27T22:00', endLocal: '2026-09-28T02:00', tz: 'Australia/Sydney',
            deviceStart: '2026-09-27T22:00', deviceEnd: '2026-09-28T02:00',
        });
        expect(line(p)).toBe('SUN 27 SEP 22:00 – MON 28 SEP 2:00');
    });

    it("a node that sends no local clock: the device's lines, as today", () => {
        const p = eventWhenParts({ startAt: lagos.startAt, endAt: lagos.endAt, deviceStart: '2026-10-17T15:50', deviceEnd: '2026-10-17T17:50' });
        expect(line(p)).toBe('SAT 17 OCT · 15:50–17:50');
        expect(p!.note).toBeNull();
    });
});

describe('zoneLabelFor', () => {
    it('names the place, with old spellings mapped to the name used now', () => {
        expect(zoneLabelFor('Australia/Sydney', 660)).toBe('Sydney time');
        expect(zoneLabelFor('America/Argentina/Buenos_Aires', -180)).toBe('Buenos Aires time');
        expect(zoneLabelFor('Europe/Kiev', 180)).toBe('Kyiv time');
        expect(zoneLabelFor('Europe/Kyiv', 180)).toBe('Kyiv time');
        expect(zoneLabelFor('Asia/Calcutta', 330)).toBe('Kolkata time');
        expect(zoneLabelFor('Asia/Saigon', 420)).toBe('Ho Chi Minh time');
    });

    it('a zone that is not a place reads as its offset', () => {
        expect(zoneLabelFor('Etc/GMT-1', 60)).toBe('UTC+1 time');
        expect(zoneLabelFor('Etc/GMT+5', -300)).toBe('UTC−5 time');
        expect(zoneLabelFor('UTC', 0)).toBe('UTC time');
        expect(zoneLabelFor('America/North_Dakota/Center', -300)).toBe('UTC−5 time');
        expect(zoneLabelFor('America/Indiana/Tell_City', -300)).toBe('UTC−5 time');
        expect(zoneLabelFor('America/Argentina/ComodRivadavia', -180)).toBe('UTC−3 time');
        expect(zoneLabelFor('Asia/Kathmandu', 345)).toBe('Kathmandu time');
        expect(zoneLabelFor('Etc/GMT-5', 330)).toBe('UTC+5:30 time');
    });

    it('reads the offset from the stored pair', () => {
        expect(offsetMinutesOf('2026-10-17T20:50', '2026-10-17T19:50:00.000Z')).toBe(60);
        expect(offsetMinutesOf('2026-10-16T20:50', '2026-10-16T09:50:00.000Z')).toBe(660);
    });
});

describe('eventPlaceTimeText — the push line', () => {
    it("says the place's weekday and clock with the zone's name", () => {
        expect(eventPlaceTimeText(lagos.startLocal, lagos.tz, lagos.startAt)).toBe('Sat 20:50 Lagos time');
    });
    it('says nothing when the node holds no local clock', () => {
        expect(eventPlaceTimeText(null, 'Africa/Lagos', lagos.startAt)).toBeNull();
    });
});
