/**
 * The event form's zone helpers (DESIGN-event-times §3, slice 2) and the edit payload with a stored clock.
 */
import { describe, expect, it } from 'vitest';
import {
    approxInstantMs, eventAdjustedWords, eventClockBody, eventLinkProblem, eventZoneLine, zoneOptionText, zoneOptions,
} from './event-zone';
import { eventEditForm, eventEditNotifies, eventEditPayload } from './events';
import type { MarketplacePost } from './api';

const LAGOS = { tz: 'Africa/Lagos', label: 'Lagos time', offsetMinutes: 60 };
const SYDNEY = { tz: 'Australia/Sydney', label: 'Sydney time', offsetMinutes: 660 };
const KOLKATA = { tz: 'Asia/Kolkata', label: 'Kolkata time', offsetMinutes: 330 };

describe('the zone line under the times (§3)', () => {
    it('in person in this device\'s zone: nothing', () => {
        expect(eventZoneLine(false, SYDNEY, 'pin', 'Australia/Sydney')).toBeNull();
        expect(eventZoneLine(false, null, null, 'Australia/Sydney')).toBeNull();
    });
    it('in person elsewhere: Lagos time, because of the pin', () => {
        expect(eventZoneLine(false, LAGOS, 'pin', 'Australia/Sydney')).toEqual({ label: 'Lagos time', why: 'pin' });
    });
    it('a picked zone always shows, even the device\'s own', () => {
        expect(eventZoneLine(false, SYDNEY, 'picked', 'Australia/Sydney')).toEqual({ label: 'Sydney time', why: null });
    });
    it('online: always, because of this device; with no zone, the line asks for one', () => {
        expect(eventZoneLine(true, SYDNEY, 'device', 'Australia/Sydney')).toEqual({ label: 'Sydney time', why: 'device' });
        expect(eventZoneLine(true, null, null, null)).toEqual({ label: null, why: null });
    });
});

describe('the picker', () => {
    it('reads "Lagos (UTC+1)", half hours too, sorted by name, each zone once', () => {
        expect(zoneOptionText(LAGOS)).toBe('Lagos (UTC+1)');
        expect(zoneOptionText(KOLKATA)).toBe('Kolkata (UTC+5:30)');
        expect(zoneOptionText({ tz: 'America/New_York', label: 'New York time', offsetMinutes: -240 })).toBe('New York (UTC−4)');
        expect(zoneOptions([SYDNEY, LAGOS, KOLKATA, LAGOS]).map(o => o.text)).toEqual(['Kolkata (UTC+5:30)', 'Lagos (UTC+1)', 'Sydney (UTC+11)']);
    });
});

describe('what goes to the node', () => {
    it('the typed clock, with the zone when there is one, and this device\'s instants beside it for a node from before clocks', () => {
        expect(eventClockBody('2030-10-19T20:50', '', false, LAGOS)).toEqual({
            eventStartLocal: '2030-10-19T20:50', eventTz: 'Africa/Lagos', eventStartAt: new Date('2030-10-19T20:50').toISOString(),
        });
        expect(eventClockBody('2030-10-19T20:50', '2030-10-19T22:50', false, null)).toEqual({
            eventStartLocal: '2030-10-19T20:50', eventEndLocal: '2030-10-19T22:50',
            eventStartAt: new Date('2030-10-19T20:50').toISOString(), eventEndAt: new Date('2030-10-19T22:50').toISOString(),
        });
    });
    it('online with no zone this device can name: the instant, so a one-off still saves', () => {
        const body = eventClockBody('2030-10-19T20:50', '', true, null);
        expect(body).toEqual({ eventStartAt: new Date('2030-10-19T20:50').toISOString() });
    });
    it('the form\'s future check reads the clock in the zone\'s offset', () => {
        expect(approxInstantMs('2030-10-19T20:50', LAGOS)).toBe(Date.parse('2030-10-19T19:50:00Z'));
        expect(approxInstantMs('', LAGOS)).toBeNaN();
    });
    it('a link is blank or http(s)', () => {
        expect(eventLinkProblem('')).toBeNull();
        expect(eventLinkProblem('https://meet.example/abc')).toBeNull();
        expect(eventLinkProblem('ftp://x')).toMatch(/must start with https:\/\//);
        expect(eventLinkProblem(`https://x.example/${'a'.repeat(500)}`)).toMatch(/at most 500/);
    });
});

describe('the DST words (§3, §7)', () => {
    it('a gap moves forward; an overlap takes the first; the end says it is the end', () => {
        expect(eventAdjustedWords({
            start: { kind: 'gap', asked: '2026-10-04T02:30', saved: '2026-10-04T03:30' },
            end: { kind: 'overlap', asked: '2027-04-04T02:30', saved: '2027-04-04T02:30' },
        }, 'Sydney time')).toEqual([
            '2:30 does not exist on 4 Oct in Sydney (clocks go forward). It was saved as 3:30.',
            'The end, 2:30, happens twice on 4 Apr in Sydney (clocks go back). The first one is used.',
        ]);
        expect(eventAdjustedWords(undefined, 'Sydney time')).toEqual([]);
    });
});

describe('editing an event with a stored clock (§2 Edit)', () => {
    const post = {
        id: 'ev', type: 'event', category: 'community', title: 'Working bee', description: '', credits: 0, priceType: 'fixed',
        authorPublicKey: 'host', authorCallsign: 'Host', createdAt: '', active: true, status: 'active', repeatable: false,
        lat: 6.5, lng: 3.4, eventStartAt: '2030-10-19T19:50:00.000Z', eventEndAt: '2030-10-19T21:50:00.000Z',
        eventStartLocal: '2030-10-19T20:50', eventEndLocal: '2030-10-19T22:50', eventTz: 'Africa/Lagos', eventOnline: false,
    } as MarketplacePost;

    it('opens on the place clock and its zone', () => {
        expect(eventEditForm(post)).toMatchObject({ start: '2030-10-19T20:50', end: '2030-10-19T22:50', tz: 'Africa/Lagos', online: false, link: '' });
    });
    it('a moved start goes as a clock, its end with it; a cleared end as an empty clock', () => {
        const before = eventEditForm(post);
        expect(eventEditPayload(before, { ...before, start: '2030-10-19T21:00' })).toEqual({ eventStartLocal: '2030-10-19T21:00', eventEndLocal: '2030-10-19T22:50' });
        expect(eventEditPayload(before, { ...before, end: '' })).toEqual({ eventEndLocal: '' });
    });
    it('a new zone with the clock kept goes as the zone alone, and notifies', () => {
        const before = eventEditForm(post);
        const payload = eventEditPayload(before, { ...before, tz: 'Africa/Accra' });
        expect(payload).toEqual({ eventTz: 'Africa/Accra' });
        expect(eventEditNotifies(payload)).toBe(true);
    });
    it('going online drops the pin and sends the link; coming back sends the pin', () => {
        const before = eventEditForm(post);
        const online = eventEditPayload(before, { ...before, online: true, link: ' https://meet.example/a ', lat: null, lng: null });
        expect(online).toEqual({ eventOnline: true, eventLink: 'https://meet.example/a' });
        expect(eventEditNotifies(online)).toBe(true);
        const wasOnline = eventEditForm({ ...post, eventOnline: true, lat: undefined, lng: undefined, eventLink: 'https://meet.example/a' });
        expect(eventEditPayload(wasOnline, { ...wasOnline, online: false, lat: 6.5, lng: 3.4 })).toEqual({ eventOnline: false, lat: 6.5, lng: 3.4 });
    });
    it('a link edit on an online event is silent', () => {
        const before = eventEditForm({ ...post, eventOnline: true, lat: undefined, lng: undefined, eventLink: 'https://meet.example/a' });
        const payload = eventEditPayload(before, { ...before, link: 'https://meet.example/b' });
        expect(payload).toEqual({ eventLink: 'https://meet.example/b' });
        expect(eventEditNotifies(payload)).toBe(false);
    });
});
