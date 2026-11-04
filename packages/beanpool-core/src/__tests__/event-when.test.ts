import { describe, expect, it } from 'vitest';
import { CURRENT_ZONE_IDS, eventPlaceTimeText, eventTileWhen, eventWhenParts, offsetMinutesOf, zoneLabelFor } from '../event-when.js';

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

// The Market grid tile's date row and time row (DESIGN-market-grid-sizes-fable.md §2.2), each short enough to stay whole.
describe('eventTileWhen — the grid tile\'s two rows', () => {
    // Byron's twilight market, Sat 7 Nov 2026 16:00–21:00 in NSW on daylight time (UTC+11) = 05:00Z–10:00Z.
    const byron = {
        startAt: '2026-11-07T05:00:00.000Z', endAt: '2026-11-07T10:00:00.000Z',
        startLocal: '2026-11-07T16:00', endLocal: '2026-11-07T21:00', tz: 'Australia/Sydney', online: false,
    };

    it('in person, the reader in the place\'s clock: the place\'s date and its span, nothing to label', () => {
        expect(eventTileWhen({ ...byron, deviceStart: '2026-11-07T16:00', deviceEnd: '2026-11-07T21:00' }))
            .toEqual({ date: 'SAT 7 NOV', time: '16:00–21:00', yours: false });
    });

    it('in person, a reader in Queensland (an hour behind): the reader\'s own clock, marked as theirs, never the place\'s bare 16:00', () => {
        const rows = eventTileWhen({ ...byron, deviceStart: '2026-11-07T15:00', deviceEnd: '2026-11-07T20:00' });
        expect(rows).toEqual({ date: 'SAT 7 NOV', time: '15:00–20:00', yours: true });
        // The card's own line still leads with the place's clock and notes the reader's: the two agree on the instant.
        expect(eventWhenParts({ ...byron, deviceStart: '2026-11-07T15:00', deviceEnd: '2026-11-07T20:00' })!.note).toBe('Sydney time · 15:00 your time');
    });

    it('in person, a reader whose date differs (Lagos read in Sydney): the reader\'s own date and time', () => {
        expect(eventTileWhen({ ...lagos, deviceStart: '2026-10-18T06:50', deviceEnd: '2026-10-18T08:50' }))
            .toEqual({ date: 'SUN 18 OCT', time: '6:50–8:50', yours: true });
    });

    it('an event that ends on a later date: the start\'s date, then its start time (the end is on the page)', () => {
        const twoDay = {
            startAt: '2026-11-05T23:26:00.000Z', endAt: '2026-11-07T01:26:00.000Z',
            startLocal: '2026-11-06T10:26', endLocal: '2026-11-07T12:26', tz: 'Australia/Sydney', online: false,
        };
        expect(eventTileWhen({ ...twoDay, deviceStart: '2026-11-06T10:26', deviceEnd: '2026-11-07T12:26' }))
            .toEqual({ date: 'FRI 6 NOV', time: '10:26', yours: false });
        // A reader in Queensland: their own start, marked as theirs.
        expect(eventTileWhen({ ...twoDay, deviceStart: '2026-11-06T09:26', deviceEnd: '2026-11-07T11:26' }))
            .toEqual({ date: 'FRI 6 NOV', time: '9:26', yours: true });
        // The reader's span crosses midnight where the place's does not: still the start alone.
        expect(eventTileWhen({ ...byron, deviceStart: '2026-11-07T23:00', deviceEnd: '2026-11-08T04:00' }))
            .toEqual({ date: 'SAT 7 NOV', time: '23:00', yours: true });
    });

    it('online: the reader\'s own clock with "your time" in the row, as the card\'s line; nothing more to label', () => {
        expect(eventTileWhen({ ...byron, online: true, deviceStart: '2026-11-07T05:00', deviceEnd: '2026-11-07T10:00' }))
            .toEqual({ date: 'SAT 7 NOV', time: '5:00–10:00 your time', yours: false });
    });

    it('a node that sends no local clock: the device\'s rows, as the card; an unreadable start: null', () => {
        expect(eventTileWhen({ startAt: lagos.startAt, endAt: lagos.endAt, deviceStart: '2026-10-17T15:50', deviceEnd: '2026-10-17T17:50' }))
            .toEqual({ date: 'SAT 17 OCT', time: '15:50–17:50', yours: false });
        expect(eventTileWhen({ deviceStart: 'not a clock' })).toBeNull();
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
        // Ontario's Atikokan, which CLDR spells America/Coral_Harbour (review #1937 finding 6).
        expect(zoneLabelFor('America/Coral_Harbour', -300)).toBe('Atikokan time');
    });

    it('an old spelling and the current id it is stored as read the same', () => {
        expect(Object.keys(CURRENT_ZONE_IDS)).toHaveLength(19);
        for (const [old, current] of Object.entries(CURRENT_ZONE_IDS)) {
            expect(zoneLabelFor(old, 0), old).toBe(zoneLabelFor(current, 0));
        }
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
