/**
 * The sky card's sums against published values (CARD-FRAME-DESIGN §5.2 item 21). Every expected value below was read
 * on 9 Oct 2026 from:
 *
 * - **New moons and the other phases**: U.S. Naval Observatory, Astronomical Applications, "Phases of the Moon"
 *   (https://aa.usno.navy.mil/api/moon/phases/date?date=2025-12-01&nump=60), times in UTC to the minute.
 * - **How much of the moon is lit**: NASA JPL Horizons, target 301 (the Moon), geocentric, quantity 10 "Illu%"
 *   (https://ssd.jpl.nasa.gov/api/horizons.api, TLIST of the ten moments below, TIME_TYPE UT).
 * - **Sunrise and sunset**: U.S. Naval Observatory, "Sun and Moon Data for One Day"
 *   (https://aa.usno.navy.mil/api/rstt/oneday?date=…&coords=lat,lng&tz=…), local times to the minute at the zone given.
 */
import { describe, expect, it } from 'vitest';
import {
    SYNODIC_MONTH_DAYS, moonAt, moonPercentShown, moonPicture, newMoonAt, readSkyPlace, readSkySettings, skyPlaceFor, skyToday, sunDay,
    type SkyClock,
} from '../sky.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;

/** USNO's new moons, UTC. */
const NEW_MOONS = [
    '2025-12-20T01:43Z', '2026-01-18T19:52Z', '2026-02-17T12:01Z', '2026-03-19T01:23Z', '2026-04-17T11:52Z', '2026-05-16T20:01Z',
    '2026-06-15T02:54Z', '2026-07-14T09:43Z', '2026-08-12T17:37Z', '2026-09-11T03:27Z', '2026-10-10T15:50Z', '2026-11-09T07:02Z',
    '2026-12-09T00:52Z', '2027-01-07T20:24Z',
].map((s) => Date.parse(s));

/** Ten moments across 2026, with JPL Horizons' Illu% at each. */
const LIT: [string, number][] = [
    ['2026-01-05T12:00Z', 94.08181],
    ['2026-01-31T00:00Z', 94.97307],
    ['2026-02-13T18:00Z', 14.07173],
    ['2026-03-21T06:00Z', 6.41766],
    ['2026-04-19T12:00Z', 6.00316],
    ['2026-05-23T00:00Z', 45.08739],
    ['2026-06-22T12:00Z', 56.11331],
    ['2026-07-27T18:00Z', 96.69426],
    ['2026-09-02T00:00Z', 75.29152],
    ['2026-10-09T06:00Z', 2.28685],
];

describe('the moon (§5.2 item 21)', () => {
    it('puts every 2026 new moon within 3 minutes of the USNO table', () => {
        for (const published of NEW_MOONS) {
            const k = Math.round((published - Date.parse('2000-01-06T18:14Z')) / (SYNODIC_MONTH_DAYS * DAY));
            expect(Math.abs(newMoonAt(k) - published), new Date(published).toISOString()).toBeLessThan(3 * MINUTE);
        }
    });

    it('gives the age and how much is lit within 1% on ten dates across 2026', () => {
        for (const [at, illu] of LIT) {
            const ms = Date.parse(at);
            const lastNew = Math.max(...NEW_MOONS.filter((n) => n <= ms));
            const publishedAge = (ms - lastNew) / DAY;
            const moon = moonAt(ms);
            // Age: within 1% of the lunar month (about 7 hours); lit: within 1 point of the percentage.
            expect(Math.abs(moon.age - publishedAge), `${at} age`).toBeLessThan(0.01 * SYNODIC_MONTH_DAYS);
            expect(Math.abs(moon.lit * 100 - illu), `${at} lit`).toBeLessThan(1);
        }
    });

    it('names each phase as USNO does at its moment, and the time between by waxing or waning', () => {
        expect(moonAt(Date.parse('2026-08-12T17:37Z')).phase).toBe('new');
        expect(moonAt(Date.parse('2026-01-26T04:47Z')).phase).toBe('first-quarter');
        expect(moonAt(Date.parse('2026-03-03T11:38Z')).phase).toBe('full');
        expect(moonAt(Date.parse('2026-10-03T13:25Z')).phase).toBe('last-quarter');
        // Two days either side of a named moment is the time between.
        expect(moonAt(Date.parse('2026-08-14T17:37Z')).phase).toBe('waxing-crescent');
        expect(moonAt(Date.parse('2026-01-28T04:47Z')).phase).toBe('waxing-gibbous');
        expect(moonAt(Date.parse('2026-03-05T11:38Z')).phase).toBe('waning-gibbous');
        expect(moonAt(Date.parse('2026-10-05T13:25Z')).phase).toBe('waning-crescent');
        expect(moonAt(Date.parse('2026-01-05T12:00Z'))).toMatchObject({ phase: 'waning-gibbous', waxing: false });
        expect(moonAt(Date.parse('2026-07-27T18:00Z'))).toMatchObject({ phase: 'waxing-gibbous', waxing: true });
    });

    it('draws the moon the way round it looks from each side of the equator', () => {
        expect(moonPicture('waxing-gibbous', 51.5)).toBe('\u{1F314}');
        expect(moonPicture('waxing-gibbous', -28.55)).toBe('\u{1F316}');
        expect(moonPicture('waning-crescent', -37)).toBe('\u{1F312}');
        expect(moonPicture('full', -37)).toBe('\u{1F315}');
        expect(moonPicture('new', 64)).toBe('\u{1F311}');
    });
});

/** A place's civil day at a fixed zone, and its clock. */
const dayAt = (date: string, zone: number) => {
    const from = Date.parse(`${date}T00:00Z`) - zone * HOUR;
    return { from, to: from + DAY };
};
const clockAt = (zone: number): SkyClock => (ms) => {
    const d = new Date(ms + zone * HOUR);
    return { hours: d.getUTCHours(), minutes: d.getUTCMinutes() };
};
const minutesOfDay = (ms: number, zone: number) => {
    const { hours, minutes } = clockAt(zone)(Math.round(ms / MINUTE) * MINUTE);
    return hours * 60 + minutes;
};
const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

/** USNO's sunrise and sunset, local time at the zone given. */
const PLACES: { name: string; lat: number; lng: number; zone: number; days: [string, string, string][] }[] = [
    { name: 'Mullumbimby', lat: -28.55, lng: 153.5, zone: 10, days: [
        ['2026-01-15', '05:02', '18:48'], ['2026-04-15', '06:04', '17:28'], ['2026-06-21', '06:38', '16:57'], ['2026-12-21', '04:45', '18:43'],
    ] },
    { name: 'Castlemaine', lat: -37.07, lng: 144.22, zone: 10, days: [
        ['2026-01-15', '05:19', '19:45'], ['2026-04-15', '06:49', '17:57'], ['2026-06-21', '07:37', '17:13'], ['2026-12-21', '05:00', '19:42'],
    ] },
    // On 21 June the sun sets at 00:04, just after midnight, and rises again at 02:55: the day's one setting is that one.
    { name: 'Reykjavík', lat: 64.15, lng: -21.94, zone: 0, days: [
        ['2026-01-15', '10:55', '16:20'], ['2026-04-15', '05:56', '21:01'], ['2026-06-21', '02:55', '00:04'], ['2026-12-21', '11:22', '15:29'],
    ] },
    { name: 'Nairobi', lat: -1.29, lng: 36.82, zone: 3, days: [
        ['2026-01-15', '06:36', '18:48'], ['2026-04-15', '06:30', '18:35'], ['2026-06-21', '06:33', '18:36'], ['2026-12-21', '06:25', '18:37'],
    ] },
];

describe('the sun (§5.2 item 21)', () => {
    for (const place of PLACES) {
        it(`puts sunrise and sunset in ${place.name} within 3 minutes of the USNO table on four dates`, () => {
            for (const [date, rise, set] of place.days) {
                const day = dayAt(date, place.zone);
                const sun = sunDay(place.lat, place.lng, day.from, day.to);
                expect(sun.allDay).toBeNull();
                expect(Math.abs(minutesOfDay(sun.rise!, place.zone) - hm(rise)), `${date} rise`).toBeLessThanOrEqual(3);
                expect(Math.abs(minutesOfDay(sun.set!, place.zone) - hm(set)), `${date} set`).toBeLessThanOrEqual(3);
            }
        });
    }

    const TROMSO = { lat: 69.65, lng: 18.96 };

    it('says a polar day is up all day and a polar night down all day (Tromsø, where USNO lists no rising or setting)', () => {
        const june = dayAt('2026-06-21', 1);
        expect(sunDay(TROMSO.lat, TROMSO.lng, june.from, june.to)).toEqual({ rise: null, set: null, allDay: 'up' });
        const december = dayAt('2026-12-21', 1);
        expect(sunDay(TROMSO.lat, TROMSO.lng, december.from, december.to)).toEqual({ rise: null, set: null, allDay: 'down' });
        expect(skyToday(TROMSO, june.from + 12 * HOUR, { day: june, clock: clockAt(1) }).text).toMatch(/ · Sun up all day$/);
        expect(skyToday(TROMSO, december.from + 12 * HOUR, { day: december, clock: clockAt(1) }).label).toMatch(/ Sun down all day\.$/);
    });

    it('finds a day with a sunrise and no sunset (Tromsø, 16 May 2026: USNO lists a rising at 01:32 and no setting)', () => {
        const day = dayAt('2026-05-16', 2);
        const sun = sunDay(TROMSO.lat, TROMSO.lng, day.from, day.to);
        expect(sun.allDay).toBeNull();
        expect(sun.set).toBeNull();
        expect(Math.abs(minutesOfDay(sun.rise!, 2) - hm('01:32'))).toBeLessThanOrEqual(3);
        const sky = skyToday(TROMSO, day.from + 12 * HOUR, { day, clock: clockAt(2) });
        expect(sky.text).toMatch(/ · Sunrise 1:3\d · No sunset today$/);
        expect(sky.label).toMatch(/ Sunrise 1:3\d am\. No sunset today\.$/);
    });

    it('catches a short dip and a short day (Tromsø 18 May: set 00:28, rise 00:53; 27 Nov: rise 12:21, set 12:42)', () => {
        const may = dayAt('2026-05-18', 2);
        const dip = sunDay(TROMSO.lat, TROMSO.lng, may.from, may.to);
        expect(Math.abs(minutesOfDay(dip.set!, 2) - hm('00:28'))).toBeLessThanOrEqual(3);
        expect(Math.abs(minutesOfDay(dip.rise!, 2) - hm('00:53'))).toBeLessThanOrEqual(3);
        const nov = dayAt('2026-11-27', 2);
        const short = sunDay(TROMSO.lat, TROMSO.lng, nov.from, nov.to);
        expect(Math.abs(minutesOfDay(short.rise!, 2) - hm('12:21'))).toBeLessThanOrEqual(3);
        expect(Math.abs(minutesOfDay(short.set!, 2) - hm('12:42'))).toBeLessThanOrEqual(3);
    });
});

describe('the card line', () => {
    it('reads "🌖 Waxing gibbous, 87% · Sunrise 4:45 · Sunset 18:43" in Mullumbimby on 21 Dec, and says it in words', () => {
        const day = dayAt('2026-12-21', 10);
        const sky = skyToday({ lat: -28.55, lng: 153.5 }, day.from + 12 * HOUR, { day, clock: clockAt(10) });
        expect(sky.moon.phase).toBe('waxing-gibbous');
        expect(sky.text).toMatch(/^\u{1F316} Waxing gibbous, \d{2}% · Sunrise 4:4\d · Sunset 18:4\d$/u);
        expect(sky.label).toMatch(/^Moon waxing gibbous, \d{2} percent lit\. Sunrise 4:4\d am\. Sunset 6:4\d pm\.$/);
        expect(sky.label).not.toMatch(/[\u{1F311}-\u{1F318}]/u);
    });

    it('says a full or new moon once, not "Moon full moon"', () => {
        const day = dayAt('2026-03-03', 0);
        const sky = skyToday({ lat: 51.5, lng: 0 }, Date.parse('2026-03-03T11:38Z'), { day, clock: clockAt(0) });
        expect(sky.text.startsWith('\u{1F315} Full moon, 100% · ')).toBe(true);
        expect(sky.label.startsWith('Full moon, 100 percent lit. Sunrise ')).toBe(true);
    });

    it('uses the device clock and day when none is given', () => {
        const now = Date.parse('2026-06-21T12:00Z');
        const sky = skyToday({ lat: -1.29, lng: 36.82 }, now);
        expect(sky.sun.allDay).toBeNull();
        expect(sky.text).toMatch(/ · Sunrise \d{1,2}:\d\d · Sunset \d{1,2}:\d\d$/);
    });
});

describe('the place and the settings', () => {
    it('reads a place tolerantly', () => {
        expect(readSkyPlace({ lat: -28.55, lng: 153.5 })).toEqual({ lat: -28.55, lng: 153.5 });
        expect(readSkyPlace({ lat: 64.15, lon: -21.94 })).toEqual({ lat: 64.15, lng: -21.94 });
        for (const bad of [null, undefined, 'x', [1, 2], { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: '1', lng: 2 }, { lat: NaN, lng: 0 }, {}]) {
            expect(readSkyPlace(bad)).toBeNull();
        }
    });

    it("reads its settings tolerantly: anything but 'me' is the community's place", () => {
        expect(readSkySettings(undefined)).toEqual({ place: 'community' });
        expect(readSkySettings({ place: 'me' })).toEqual({ place: 'me' });
        expect(readSkySettings({ place: 'mars' })).toEqual({ place: 'community' });
        expect(readSkySettings([1])).toEqual({ place: 'community' });
    });

    it("takes the community's place, else the member's area, else the device's; 'me' puts the member first", () => {
        const community = { lat: -28.55, lng: 153.5 };
        const member = { lat: -28.64, lng: 153.62 };
        const device = { lat: -28.7, lng: 153.6 };
        const c = { place: 'community' as const };
        const me = { place: 'me' as const };
        expect(skyPlaceFor(c, { community, member, device })).toEqual(community);
        expect(skyPlaceFor(c, { member, device })).toEqual(member);
        expect(skyPlaceFor(c, { device })).toEqual(device);
        expect(skyPlaceFor(c, {})).toBeNull();
        expect(skyPlaceFor(me, { community, member, device })).toEqual(member);
        expect(skyPlaceFor(me, { community, device })).toEqual(device);
        expect(skyPlaceFor(me, { community })).toEqual(community);
    });
});

describe("the percentage beside the phase (#1720 review, finding 1)", () => {
    it("never says a crescent or a gibbous moon is 0% or 100% lit", () => {
        expect(moonPercentShown({ lit: 0.0027, phase: "waxing-crescent" })).toBe(1);
        expect(moonPercentShown({ lit: 0.9973, phase: "waxing-gibbous" })).toBe(99);
        expect(moonPercentShown({ lit: 0.0027, phase: "new" })).toBe(0);
        expect(moonPercentShown({ lit: 0.9999, phase: "full" })).toBe(100);
        expect(moonPercentShown({ lit: 0.72, phase: "waxing-gibbous" })).toBe(72);
    });
    it("holds just outside the named new and full days, on the real moon", () => {
        const step = 10 * 60 * 1000;
        let t = Date.parse("2026-08-12T17:37Z");
        while (moonAt(t).phase === "new") t += step;
        expect(moonAt(t).phase).toBe("waxing-crescent");
        expect(skyToday({ lat: -28.55, lng: 153.5 }, t).text).toMatch(/Waxing crescent, [1-9]\d?%/);
        let u = Date.parse("2026-08-12T17:37Z") + (29.53 / 2) * 86400000;
        while (moonAt(u).phase !== "full") u += step;
        while (moonAt(u).phase === "full") u += step;
        expect(skyToday({ lat: -28.55, lng: 153.5 }, u).text).toMatch(/Waning gibbous, (9\d|[1-8]\d)%/);
    });
});
