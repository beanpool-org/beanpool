import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    buildEventDraft, buildEventEditPatch, eventCacheColumns, eventEditValues, eventHomeWhen, eventPinCard, eventPlaceLine,
    eventShareWhen, eventTimeAdjustedText, eventWhen, deviceTimeZone, eventZoneLine, filterZones, formatEventWhenFor,
    isOnlineEvent, sameZone, zonePickerEntry, EVENT_LINK_HINT, EVENT_ZONE_PROMPT, type EventFormInput,
} from '../events';

/**
 * Event times on the phone (DESIGN-event-times-fable.md §3, §4, slice 3). The reader here is in New York, so a Lagos
 * meetup and a Sydney online event each read in two clocks. The phone does no zone arithmetic: every place clock below
 * comes from the node's stored `eventStartLocal`, and the reader's from the Date getters.
 */
const savedTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/New_York'; });
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

// Lagos is UTC+1 all year: 20:50 there on Sat 17 Oct 2026 is 19:50Z, 15:50 in New York (EDT).
const lagos = {
    type: 'event', title: 'Working bee', eventStartAt: '2026-10-17T19:50:00.000Z', eventEndAt: '2026-10-17T21:50:00.000Z',
    eventStartLocal: '2026-10-17T20:50', eventEndLocal: '2026-10-17T22:50', eventTz: 'Africa/Lagos', eventOnline: false,
    eventPlaceName: 'Bindarrabi Hall', lat: 6.45, lng: 3.39,
};
// Sydney is AEDT (UTC+11) on Fri 16 Oct 2026: the host's 20:50 is 09:50Z, 5:50 in New York.
const vibe = {
    type: 'event', title: 'Vibe coding', eventStartAt: '2026-10-16T09:50:00.000Z', eventEndAt: '2026-10-16T11:50:00.000Z',
    eventStartLocal: '2026-10-16T20:50', eventEndLocal: '2026-10-16T22:50', eventTz: 'Australia/Sydney', eventOnline: true,
    eventLink: 'https://meet.example/vibe', lat: null, lng: null,
};

describe('event times: the card lines (§4)', () => {
    it('in person somewhere else: the place clock leads, the reader’s own follows', () => {
        expect(eventWhen(lagos)).toEqual({ first: 'SAT 17 OCT', second: '20:50–22:50', sep: ' · ', note: 'Lagos time · 15:50 your time', hostLine: null });
        expect(formatEventWhenFor(lagos)).toBe('SAT 17 OCT · 20:50–22:50');
    });

    it('in person where the reader is: one line, unchanged', () => {
        const local = { ...lagos, eventStartAt: '2026-10-18T00:50:00.000Z', eventEndAt: '2026-10-18T02:50:00.000Z', eventTz: 'America/New_York' };
        expect(eventWhen(local)).toEqual({ first: 'SAT 17 OCT', second: '20:50–22:50', sep: ' · ', note: null, hostLine: null });
    });

    it('online: the reader’s own clock, always with "your time", and the host’s clock for the detail', () => {
        expect(eventWhen(vibe)).toEqual({ first: 'FRI 16 OCT', second: '5:50–7:50 your time', sep: ' · ', note: null, hostLine: '20:50 for the host (Sydney time)' });
    });

    it('the cached row (snake_case) reads the same as the node’s', () => {
        const row = {
            type: 'event', event_start_at: lagos.eventStartAt, event_end_at: lagos.eventEndAt, event_start_local: lagos.eventStartLocal,
            event_end_local: lagos.eventEndLocal, event_tz: lagos.eventTz, event_online: 0,
        };
        expect(eventWhen(row)?.note).toBe('Lagos time · 15:50 your time');
        expect(isOnlineEvent({ event_online: 1 })).toBe(true);
        expect(isOnlineEvent({ event_online: 0 })).toBe(false);
    });

    it('a node from before zones sends no clock: the device lines, as today', () => {
        const old = { type: 'event', eventStartAt: '2026-10-17T19:50:00.000Z', eventEndAt: '2026-10-17T21:50:00.000Z' };
        expect(eventWhen(old)).toEqual({ first: 'SAT 17 OCT', second: '15:50–17:50', sep: ' · ', note: null, hostLine: null });
        expect(eventWhen({ type: 'event' })).toBeNull();
    });

    it('the place line says Online for an online event', () => {
        expect(eventPlaceLine(vibe, null)).toBe('Online');
        expect(eventPlaceLine(lagos, null)).toBe('Bindarrabi Hall');
    });

    it('the map’s pin card names the place’s zone when its clock is not the reader’s', () => {
        expect(eventPinCard(lagos).when).toBe('SAT 17 OCT · 20:50–22:50 · Lagos time');
    });
});

describe('event times: share text and Home', () => {
    it('share text carries a labelled time, so it is right outside the app', () => {
        expect(eventShareWhen(lagos)).toBe('Sat 17 Oct, 20:50 Lagos time');
        expect(eventShareWhen(vibe)).toBe('Fri 16 Oct, 20:50 Sydney time (online)');
        expect(eventShareWhen({ type: 'event', eventStartAt: '2026-10-17T19:50:00.000Z' })).toBe('Sat 17 Oct, 15:50');
    });

    it('Home’s Coming up line: the place’s zone only when different; online in the reader’s time', () => {
        expect(eventHomeWhen({ startsAt: lagos.eventStartAt, startLocal: lagos.eventStartLocal, tz: lagos.eventTz, online: false })).toBe('Sat 17 Oct, 20:50 Lagos time');
        expect(eventHomeWhen({ startsAt: vibe.eventStartAt, startLocal: vibe.eventStartLocal, tz: vibe.eventTz, online: true })).toBe('Fri 16 Oct, 5:50 your time');
        expect(eventHomeWhen({ startsAt: '2026-10-18T00:50:00.000Z', startLocal: '2026-10-17T20:50', tz: 'America/New_York', online: false })).toBe('Sat 17 Oct');
        expect(eventHomeWhen({ startsAt: lagos.eventStartAt })).toBe('Sat 17 Oct');
    });
});

describe('event times: the cache (amendment 1 item 3)', () => {
    it('caches the clock, zone and online flag, and never the join link', () => {
        const cols = eventCacheColumns({ ...vibe, eventState: 'scheduled', goingCount: 2, interestedCount: 1 });
        expect(cols).toEqual([vibe.eventStartAt, vibe.eventEndAt, null, 'scheduled', 2, 1, '2026-10-16T20:50', '2026-10-16T22:50', 'Australia/Sydney', 1]);
        expect(cols).not.toContain(vibe.eventLink);
        expect(eventCacheColumns({ type: 'event', event_start_local: 'a', event_end_local: 'b', event_tz: 'Africa/Lagos', event_online: 0 }).slice(6))
            .toEqual(['a', 'b', 'Africa/Lagos', 0]);
        // A node from before zones: NULL, so the card falls back to device time.
        expect(eventCacheColumns({ type: 'event', eventStartAt: 's' }).slice(6)).toEqual([null, null, null, null]);
        expect(eventCacheColumns({ type: 'offer' })).toEqual([null, null, null, null, 0, 0, null, null, null, null]);
    });
});

describe('event times: the device zone (Hermes, one call)', () => {
    const fakeIntl = (timeZone: unknown) => ({ DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) });
    it('reads resolvedOptions().timeZone, spelled the current way', () => {
        expect(deviceTimeZone(fakeIntl('Australia/Sydney'))).toBe('Australia/Sydney');
        expect(deviceTimeZone(fakeIntl('Europe/Kiev'))).toBe('Europe/Kyiv');
        expect(deviceTimeZone(fakeIntl('UTC'))).toBe('UTC');
    });
    it('anything unusable is unknown, never a guess', () => {
        expect(deviceTimeZone(fakeIntl(undefined))).toBeNull();
        expect(deviceTimeZone(fakeIntl(''))).toBeNull();
        expect(deviceTimeZone(fakeIntl('GMT+10:00'))).toBeNull();
        expect(deviceTimeZone({ DateTimeFormat: () => { throw new Error('no Intl'); } })).toBeNull();
        expect(deviceTimeZone(null)).toBeNull();
    });
    it('compares zones whichever way they are spelled', () => {
        expect(sameZone('Europe/Kiev', 'Europe/Kyiv')).toBe(true);
        expect(sameZone('Australia/Sydney', 'Australia/Brisbane')).toBe(false);
        expect(sameZone(null, 'Australia/Sydney')).toBe(false);
    });
});

describe('event times: the form’s zone line and picker (§3)', () => {
    it('in person, the pin’s zone is the device’s: nothing new', () => {
        expect(eventZoneLine({ online: false, tz: 'Australia/Sydney', source: 'pin', deviceTz: 'Australia/Sydney', offsetMinutes: 660 })).toBeNull();
    });
    it('in person, somewhere else: "Times are Lagos time (where the pin is)"', () => {
        expect(eventZoneLine({ online: false, tz: 'Africa/Lagos', source: 'pin', deviceTz: 'Australia/Sydney', offsetMinutes: 60 }))
            .toEqual({ zone: 'Lagos time', why: ' (where the pin is)', moved: false });
        expect(eventZoneLine({ online: false, tz: 'Africa/Accra', source: 'pin', deviceTz: 'Australia/Sydney', offsetMinutes: 0, moved: true }))
            .toEqual({ zone: 'Accra time', why: ' (where the pin is)', moved: true });
        expect(eventZoneLine({ online: false, tz: 'Australia/Brisbane', source: 'picked', deviceTz: 'Australia/Sydney', offsetMinutes: 600 }))
            .toEqual({ zone: 'Brisbane time', why: '', moved: false });
    });
    it('in person, no zone known yet (no pin, or a node from before zones): nothing', () => {
        expect(eventZoneLine({ online: false, tz: null, source: null, deviceTz: 'Australia/Sydney', offsetMinutes: null })).toBeNull();
    });
    it('online: always shown, because the zone anchors the clock', () => {
        expect(eventZoneLine({ online: true, tz: 'Australia/Sydney', source: 'device', deviceTz: 'Australia/Sydney', offsetMinutes: 660 }))
            .toEqual({ zone: 'Sydney time', why: ' (your device)', moved: false });
    });
    it('online, and the device cannot name its zone: ask', () => {
        expect(eventZoneLine({ online: true, tz: null, source: null, deviceTz: null, offsetMinutes: null })).toEqual({ prompt: EVENT_ZONE_PROMPT });
        expect(EVENT_ZONE_PROMPT).toBe('Pick the time zone these times are in');
    });
    it('picker entries read "Lagos (UTC+1)"', () => {
        expect(zonePickerEntry({ tz: 'Africa/Lagos', label: 'Lagos time', offsetMinutes: 60 })).toBe('Lagos (UTC+1)');
        expect(zonePickerEntry({ tz: 'Asia/Kolkata', label: 'Kolkata time', offsetMinutes: 330 })).toBe('Kolkata (UTC+5:30)');
        expect(zonePickerEntry({ tz: 'America/New_York', label: 'New York time', offsetMinutes: -240 })).toBe('New York (UTC−4)');
        expect(zonePickerEntry({ tz: 'Etc/GMT-1', label: 'UTC+1 time', offsetMinutes: 60 })).toBe('UTC+1');
    });
    it('the search box matches the place or the id', () => {
        const zones = [
            { tz: 'Africa/Lagos', label: 'Lagos time', offsetMinutes: 60 },
            { tz: 'Asia/Kolkata', label: 'Kolkata time', offsetMinutes: 330 },
            { tz: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires time', offsetMinutes: -180 },
        ];
        expect(filterZones(zones, 'lag').map(z => z.tz)).toEqual(['Africa/Lagos']);
        expect(filterZones(zones, 'buenos a').map(z => z.tz)).toEqual(['America/Argentina/Buenos_Aires']);
        expect(filterZones(zones, 'asia/').map(z => z.tz)).toEqual(['Asia/Kolkata']);
        expect(filterZones(zones, '  ').length).toBe(3);
    });
});

describe('event times: DST words (§3)', () => {
    it('a clock in the gap and one that happens twice', () => {
        expect(eventTimeAdjustedText({ start: { kind: 'gap', asked: '2026-10-04T02:30', saved: '2026-10-04T03:30' }, end: null }, 'Australia/Sydney'))
            .toEqual(['2:30 am does not exist on 4 Oct in Sydney (clocks go forward). It was saved as 3:30 am.']);
        expect(eventTimeAdjustedText({ start: { kind: 'overlap', asked: '2026-04-05T02:30', saved: '2026-04-05T02:30' }, end: null }, 'Australia/Sydney'))
            .toEqual(['2:30 am happens twice on 5 Apr in Sydney (clocks go back). The first one is used.']);
        expect(eventTimeAdjustedText({ start: null, end: { kind: 'gap', asked: '2026-10-04T02:15', saved: '2026-10-04T03:15' } }, 'Australia/Sydney'))
            .toEqual(['The end, 2:15 am, does not exist on 4 Oct in Sydney (clocks go forward). It was saved as 3:15 am.']);
        expect(eventTimeAdjustedText(undefined, 'Australia/Sydney')).toEqual([]);
    });
});

// Built with the local-time constructor: the picker's Date holds the clock the host chose in its getters.
const now = new Date(2026, 9, 1, 8, 0);
function form(over: Partial<EventFormInput> = {}): EventFormInput {
    return {
        title: 'Working bee', description: '', start: new Date(2026, 9, 17, 20, 50), end: new Date(2026, 9, 17, 22, 50),
        placeName: 'Bindarrabi Hall', lat: 6.45, lng: 3.39, privateNote: '', audienceGroupId: null, authorPubkey: 'me', ...over,
    };
}

describe('event times: the create draft', () => {
    it('in person: the clock the host picked, and the pin’s zone when the form knows it', () => {
        const r = buildEventDraft(form({ tz: 'Africa/Lagos', tzOffsetMinutes: 60 }), now);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.draft.eventStartLocal).toBe('2026-10-17T20:50');
        expect(r.draft.eventEndLocal).toBe('2026-10-17T22:50');
        expect(r.draft.eventTz).toBe('Africa/Lagos');
        expect(r.draft.eventOnline).toBeUndefined();
        expect(r.draft.lat).toBe(6.45);
    });
    it('in person, zone not known: the clock goes and the node reads it at the pin', () => {
        const r = buildEventDraft(form(), now);
        expect(r.ok && r.draft.eventStartLocal).toBe('2026-10-17T20:50');
        expect(r.ok && 'eventTz' in r.draft).toBe(false);
    });
    it('a blank end is the clock plus two hours', () => {
        const r = buildEventDraft(form({ end: null, tz: 'Africa/Lagos' }), now);
        expect(r.ok && r.draft.eventEndLocal).toBe('2026-10-17T22:50');
    });
    it('online: no pin or place name, a link, and the zone', () => {
        const r = buildEventDraft(form({ online: true, lat: null, lng: null, placeName: '', link: ' https://meet.example/vibe ', tz: 'Australia/Sydney', tzOffsetMinutes: 660 }), now);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.draft.eventOnline).toBe(true);
        expect(r.draft.eventLink).toBe('https://meet.example/vibe');
        expect(r.draft.eventTz).toBe('Australia/Sydney');
        expect(r.draft.eventStartLocal).toBe('2026-10-17T20:50');
        expect('lat' in r.draft || 'eventPlaceName' in r.draft).toBe(false);
    });
    it('online with no zone: a one-off still saves, with the instant only (the node cannot read a clock without a zone)', () => {
        const r = buildEventDraft(form({ online: true, lat: null, lng: null, placeName: '', tz: null }), now);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.draft.eventStartAt).toBe(new Date(2026, 9, 17, 20, 50).toISOString());
        expect('eventStartLocal' in r.draft || 'eventTz' in r.draft).toBe(false);
    });
    it('the link is checked as the node checks it', () => {
        const bad = (link: string) => buildEventDraft(form({ online: true, lat: null, lng: null, link, tz: 'UTC' }), now);
        expect(bad('javascript:alert(1)')).toEqual({ ok: false, error: 'The link to join must start with https:// or http://' });
        expect(bad('https://zoom.us@evil.example/j/1')).toEqual({ ok: false, error: 'The link to join must not hold a user name or password' });
        expect(bad(`https://meet.example/${'a'.repeat(500)}`)).toEqual({ ok: false, error: 'Keep the link to join under 500 characters.' });
        expect(EVENT_LINK_HINT).toBe('Link to join · only people who tap Going see it');
    });
    it('the past check uses the zone’s offset when the form knows it', () => {
        // At 19:00Z: 20:50 in Lagos (19:50Z) is still to come; 19:30 in Lagos (18:30Z) has passed, though 19:30 on this
        // New York phone (23:30Z) has not.
        const at = new Date('2026-10-01T19:00:00.000Z');
        expect(buildEventDraft(form({ start: new Date(2026, 9, 1, 20, 50), end: null, tz: 'Africa/Lagos', tzOffsetMinutes: 60 }), at).ok).toBe(true);
        expect(buildEventDraft(form({ start: new Date(2026, 9, 1, 19, 30), end: null, tz: 'Africa/Lagos', tzOffsetMinutes: 60 }), at))
            .toEqual({ ok: false, error: 'The start time has already passed. Pick a time in the future.' });
    });
});

describe('event times: editing', () => {
    it('the form holds the place clock, not the reader’s', () => {
        const v = eventEditValues(lagos);
        expect(v.start?.getHours()).toBe(20);
        expect(v.start?.getMinutes()).toBe(50);
        expect(v.tz).toBe('Africa/Lagos');
        expect(v.tzOffsetMinutes).toBe(60);
        expect(v.online).toBe(false);
    });
    it('a title edit sends no time at all', () => {
        const before = eventEditValues(lagos);
        const r = buildEventEditPatch(before, { ...before, title: 'Working bee 2' }, now);
        expect(r).toEqual({ ok: true, patch: { title: 'Working bee 2' }, notifies: false });
    });
    it('a moved start sends the clock, and a new zone sends the zone, and both tell Going', () => {
        const before = eventEditValues(lagos);
        const moved = buildEventEditPatch(before, { ...before, start: new Date(2026, 9, 17, 21, 0), end: new Date(2026, 9, 17, 23, 0) }, now);
        expect(moved.ok && moved.patch.eventStartLocal).toBe('2026-10-17T21:00');
        expect(moved.ok && moved.patch.eventEndLocal).toBe('2026-10-17T23:00');
        expect(moved.ok && moved.notifies).toBe(true);
        const rezoned = buildEventEditPatch(before, { ...before, tz: 'Africa/Accra', tzOffsetMinutes: 0 }, now);
        expect(rezoned).toEqual({ ok: true, patch: { eventTz: 'Africa/Accra' }, notifies: true });
    });
    it('switching to online sends the flag and the link, and needs no pin', () => {
        const before = eventEditValues(lagos);
        const r = buildEventEditPatch(before, { ...before, online: true, lat: null, lng: null, placeName: '', link: 'https://meet.example/x' }, now);
        expect(r.ok && r.patch.eventOnline).toBe(true);
        expect(r.ok && r.patch.eventLink).toBe('https://meet.example/x');
        expect(r.ok && r.notifies).toBe(true);
    });
});
