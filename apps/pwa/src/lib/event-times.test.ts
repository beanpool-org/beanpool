/**
 * Event times on the web app (DESIGN-event-times §4, slice 2): the node sends the host's clock and its zone beside the
 * instant, and the card, the detail, the share text and the calendar entry read them. The reader here is in New York, so
 * a Lagos or Sydney event reads differently from the reader's own clock; every string is the design's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventShareWhen, eventWhenParts, formatEventWhen } from './events';
import { buildIcs, buildShareText, googleCalendarUrl, type ShareableEvent } from './event-extras';
import type { MarketplacePost } from './api';

const savedTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/New_York'; });
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

type Times = Pick<MarketplacePost, 'eventStartAt' | 'eventEndAt' | 'eventStartLocal' | 'eventEndLocal' | 'eventTz' | 'eventOnline'>;

/** Lagos (UTC+1, no DST): Sat 17 Oct 2026 20:50–22:50 at the place is 19:50Z, 15:50 in New York (EDT). */
const LAGOS: Times = {
    eventStartAt: '2026-10-17T19:50:00.000Z', eventEndAt: '2026-10-17T21:50:00.000Z',
    eventStartLocal: '2026-10-17T20:50', eventEndLocal: '2026-10-17T22:50', eventTz: 'Africa/Lagos', eventOnline: false,
};
/** An online event a Sydney host set for Fri 16 Oct 2026 20:50 (AEDT, UTC+11): 09:50Z, 5:50 in New York. */
const ONLINE_SYDNEY: Times = {
    eventStartAt: '2026-10-16T09:50:00.000Z', eventEndAt: '2026-10-16T11:50:00.000Z',
    eventStartLocal: '2026-10-16T20:50', eventEndLocal: '2026-10-16T22:50', eventTz: 'Australia/Sydney', eventOnline: true,
};

describe('the time on a card (§4)', () => {
    it('in person, where the reader is: the place clock and nothing more', () => {
        const here: Times = {
            eventStartAt: '2026-10-17T00:50:00.000Z', eventEndAt: '2026-10-17T02:50:00.000Z',
            eventStartLocal: '2026-10-16T20:50', eventEndLocal: '2026-10-16T22:50', eventTz: 'America/New_York',
        };
        expect(eventWhenParts(here)).toMatchObject({ first: 'FRI 16 OCT', sep: ' · ', second: '20:50–22:50', note: null, hostLine: null });
        expect(formatEventWhen(here)).toBe('FRI 16 OCT · 20:50–22:50');
    });

    it('in person, somewhere else: the place clock first, then "Lagos time · 15:50 your time"', () => {
        expect(eventWhenParts(LAGOS)).toMatchObject({ first: 'SAT 17 OCT', second: '20:50–22:50', note: 'Lagos time · 15:50 your time' });
        expect(formatEventWhen(LAGOS)).toBe('SAT 17 OCT · 20:50–22:50 · Lagos time · 15:50 your time');
    });

    it("names the reader's own date when it is another day there", () => {
        // Tokyo Sat 17 Oct 08:00 (UTC+9) is Fri 16 Oct 19:00 in New York.
        const tokyo: Times = {
            eventStartAt: '2026-10-16T23:00:00.000Z', eventEndAt: '2026-10-17T01:00:00.000Z',
            eventStartLocal: '2026-10-17T08:00', eventEndLocal: '2026-10-17T10:00', eventTz: 'Asia/Tokyo',
        };
        expect(eventWhenParts(tokyo)?.note).toBe('Tokyo time · FRI 16 OCT 19:00 your time');
    });

    it("online: the reader's own clock, \"your time\", and the host's clock for the detail", () => {
        expect(eventWhenParts(ONLINE_SYDNEY)).toMatchObject({
            first: 'FRI 16 OCT', second: '5:50–7:50 your time', note: null, hostLine: '20:50 for the host (Sydney time)',
        });
        expect(formatEventWhen(ONLINE_SYDNEY)).toBe('FRI 16 OCT · 5:50–7:50 your time');
    });

    it('a node that sends no clock reads as before, in the reader\'s own time', () => {
        const old: Times = { eventStartAt: '2026-10-17T19:50:00.000Z', eventEndAt: '2026-10-17T21:50:00.000Z' };
        expect(formatEventWhen(old)).toBe('SAT 17 OCT · 15:50–17:50');
        // No end: start + 2 hours, as the node defaults it.
        expect(formatEventWhen({ eventStartAt: '2026-10-17T19:50:00.000Z' })).toBe('SAT 17 OCT · 15:50–17:50');
    });

    it('a place clock with no end clock keeps the length on the clock', () => {
        expect(formatEventWhen({ ...LAGOS, eventEndLocal: undefined })).toBe('SAT 17 OCT · 20:50–22:50 · Lagos time · 15:50 your time');
    });

    it('a span across midnight at the place keeps both dates', () => {
        const late: Times = { ...LAGOS, eventEndAt: '2026-10-18T01:50:00.000Z', eventEndLocal: '2026-10-18T02:50' };
        expect(eventWhenParts(late)).toMatchObject({ first: 'SAT 17 OCT 20:50', sep: ' – ', second: 'SUN 18 OCT 2:50' });
    });
});

describe('the share text names its zone (§4)', () => {
    it('in person: "Sat 17 Oct, 20:50 Lagos time"', () => {
        expect(eventShareWhen(LAGOS)).toBe('Sat 17 Oct, 20:50 Lagos time');
        const event: ShareableEvent = { id: 'ev-1', title: 'Working bee', startAt: LAGOS.eventStartAt!, placeName: 'Bindarrabi Hall' };
        expect(buildShareText(event, eventShareWhen(LAGOS), 'https://n.example/?post=ev-1'))
            .toBe('Working bee\nSat 17 Oct, 20:50 Lagos time\nBindarrabi Hall\nhttps://n.example/?post=ev-1');
    });

    it('online: "Fri 16 Oct, 20:50 Sydney time (online)", with no place line', () => {
        expect(eventShareWhen(ONLINE_SYDNEY)).toBe('Fri 16 Oct, 20:50 Sydney time (online)');
        const event: ShareableEvent = { id: 'ev-2', title: 'Vibe coding', startAt: ONLINE_SYDNEY.eventStartAt!, online: true };
        expect(buildShareText(event, eventShareWhen(ONLINE_SYDNEY), 'https://n.example/?post=ev-2'))
            .toBe('Vibe coding\nFri 16 Oct, 20:50 Sydney time (online)\nhttps://n.example/?post=ev-2');
    });

    it('a node that sends no clock: the card line, as before', () => {
        expect(eventShareWhen({ eventStartAt: LAGOS.eventStartAt, eventEndAt: LAGOS.eventEndAt })).toBe('SAT 17 OCT · 15:50–17:50');
    });
});

describe('the calendar entry (§4, director amendment 1.5)', () => {
    const lagos: ShareableEvent = {
        id: 'ev-1', title: 'Working bee', startAt: LAGOS.eventStartAt!, endAt: LAGOS.eventEndAt, placeName: 'Bindarrabi Hall',
        whenText: eventShareWhen(LAGOS), tz: 'Africa/Lagos',
    };
    const link = 'https://n.example/?post=ev-1';

    it('.ics: UTC Z times, no RRULE and no VTIMEZONE; the description says the place time', () => {
        const ics = buildIcs(lagos, link, Date.parse('2026-10-01T00:00:00Z'));
        expect(ics).toContain('DTSTART:20261017T195000Z');
        expect(ics).toContain('DTEND:20261017T215000Z');
        expect(ics).not.toMatch(/RRULE|VTIMEZONE|TZID/);
        expect(ics.replace(/\r\n /g, '')).toContain('DESCRIPTION:Starts Sat 17 Oct\\, 20:50 Lagos time\\n\\nhttps://n.example/?post=ev-1');
        expect(ics).toContain('LOCATION:Bindarrabi Hall');
    });

    it('Google: the same UTC stamps, with ctz the host zone', () => {
        const url = new URL(googleCalendarUrl(lagos, link));
        expect(url.searchParams.get('dates')).toBe('20261017T195000Z/20261017T215000Z');
        expect(url.searchParams.get('ctz')).toBe('Africa/Lagos');
        expect(url.searchParams.get('details')).toBe(`Starts Sat 17 Oct, 20:50 Lagos time\n\n${link}`);
    });

    it('online: the place is where to join, for someone who may see it, and "Online" otherwise', () => {
        const online: ShareableEvent = {
            id: 'ev-2', title: 'Vibe coding', startAt: ONLINE_SYDNEY.eventStartAt!, online: true, tz: 'Australia/Sydney',
            whenText: eventShareWhen(ONLINE_SYDNEY), joinLink: 'https://meet.example/abc',
        };
        const ics = buildIcs(online, link, Date.parse('2026-10-01T00:00:00Z')).replace(/\r\n /g, '');
        expect(ics).toContain('LOCATION:https://meet.example/abc');
        expect(ics).toContain('Join: https://meet.example/abc');
        expect(buildIcs({ ...online, joinLink: null }, link)).toContain('LOCATION:Online');
        expect(new URL(googleCalendarUrl({ ...online, joinLink: null }, link)).searchParams.get('location')).toBe('Online');
    });

    it('an entry with no zone carries no ctz, as before', () => {
        expect(new URL(googleCalendarUrl({ id: 'x', title: 't', startAt: LAGOS.eventStartAt! }, link)).searchParams.has('ctz')).toBe(false);
    });
});

describe('Home\'s "Coming up" line (§4)', () => {
    it('the place clock; its zone named only when it is not the reader\'s; online in the reader\'s time', async () => {
        const { homeEventWhen } = await import('./home-cards');
        expect(homeEventWhen({ startsAt: LAGOS.eventStartAt!, startLocal: LAGOS.eventStartLocal, tz: LAGOS.eventTz })).toBe('SAT 17 OCT · 20:50 · Lagos time');
        expect(homeEventWhen({ startsAt: '2026-10-17T00:50:00.000Z', startLocal: '2026-10-16T20:50', tz: 'America/New_York' })).toBe('FRI 16 OCT · 20:50');
        expect(homeEventWhen({ startsAt: ONLINE_SYDNEY.eventStartAt!, startLocal: ONLINE_SYDNEY.eventStartLocal, tz: ONLINE_SYDNEY.eventTz, online: true }))
            .toBe('FRI 16 OCT · 5:50 your time');
        // A node before clocks: the reader's own.
        expect(homeEventWhen({ startsAt: LAGOS.eventStartAt! })).toBe('SAT 17 OCT · 15:50');
    });
});

describe('"Your events" reads as the card does (review of #1952, finding 10)', () => {
    it('a row with the clock, zone and online maps onto the post the card reads', async () => {
        const { myEventAsPost } = await import('../components/YourEvents');
        const base = { postId: 'ev-1', title: 'Working bee', rsvp: 'going' as const, photo: null, reminderOffsets: null, placeName: 'The hall' };
        const hall = myEventAsPost({ ...base, startAt: LAGOS.eventStartAt!, endAt: LAGOS.eventEndAt!, startLocal: LAGOS.eventStartLocal, endLocal: LAGOS.eventEndLocal, tz: LAGOS.eventTz });
        expect(formatEventWhen(hall)).toBe('SAT 17 OCT · 20:50–22:50 · Lagos time · 15:50 your time');
        const online = myEventAsPost({ ...base, placeName: null, startAt: ONLINE_SYDNEY.eventStartAt!, endAt: ONLINE_SYDNEY.eventEndAt!,
            startLocal: ONLINE_SYDNEY.eventStartLocal, endLocal: ONLINE_SYDNEY.eventEndLocal, tz: ONLINE_SYDNEY.eventTz, online: true });
        expect(online.eventOnline).toBe(true);
        expect(formatEventWhen(online)).toBe('FRI 16 OCT · 5:50–7:50 your time');
        // A node from before clocks: the reader's own time, as before.
        expect(formatEventWhen(myEventAsPost({ ...base, startAt: LAGOS.eventStartAt!, endAt: LAGOS.eventEndAt! }))).toBe('SAT 17 OCT · 15:50–17:50');
    });
});
