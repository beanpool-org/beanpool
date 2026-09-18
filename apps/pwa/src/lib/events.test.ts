import { describe, it, expect } from 'vitest';
import {
    buildEventCopy, eventEditBlockedReason, eventEditForm, eventEditNotifies, eventEditPayload, eventInWindow, eventWindowRange,
    eventsFeedFilter, formatDistance, formatEventWhen, isEventOpen, isoToLocalInput, localInputToIso,
} from './events';
import type { MarketplacePost } from './api';

// Local-time constructors keep these independent of the machine's time zone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const HOUR = 60 * 60 * 1000;

function event(startMs: number, endMs?: number, extra: Partial<MarketplacePost> = {}): MarketplacePost {
    return {
        id: `ev-${startMs}`, type: 'event', category: 'community', title: 'Working bee', description: '',
        credits: 0, priceType: 'fixed', authorPublicKey: 'host', authorCallsign: 'Host', createdAt: new Date(0).toISOString(),
        active: true, status: 'active', repeatable: false, lat: -28.5, lng: 153.5,
        eventStartAt: new Date(startMs).toISOString(),
        ...(endMs != null ? { eventEndAt: new Date(endMs).toISOString() } : {}),
        eventState: 'scheduled',
        ...extra,
    };
}

describe('formatEventWhen', () => {
    it('leads with the day and gives a same-day range', () => {
        expect(formatEventWhen(event(at(2026, 9, 26, 9), at(2026, 9, 26, 12)))).toBe('SAT 26 SEP · 9:00–12:00');
    });

    it('uses start + 2 hours when there is no end', () => {
        expect(formatEventWhen(event(at(2026, 9, 26, 18, 30)))).toBe('SAT 26 SEP · 18:30–20:30');
    });

    it('names both days when the event runs past midnight', () => {
        expect(formatEventWhen(event(at(2026, 9, 26, 22), at(2026, 9, 27, 2)))).toBe('SAT 26 SEP 22:00 – SUN 27 SEP 2:00');
    });
});

describe('isEventOpen', () => {
    const now = at(2026, 9, 23, 10);
    it('is open until it ends', () => {
        expect(isEventOpen(event(now + HOUR), now)).toBe(true);
        expect(isEventOpen(event(now - HOUR, now + HOUR), now)).toBe(true);
        expect(isEventOpen(event(now - 3 * HOUR, now - HOUR), now)).toBe(false);
    });
    it('is closed when cancelled, and for anything that is not an event', () => {
        expect(isEventOpen(event(now + HOUR, undefined, { eventState: 'cancelled' }), now)).toBe(false);
        expect(isEventOpen(event(now + HOUR, undefined, { status: 'cancelled' }), now)).toBe(false);
        expect(isEventOpen({ ...event(now + HOUR), type: 'offer' }, now)).toBe(false);
    });
});

describe('the map chips: Today / This weekend / Next 7 days / All', () => {
    // Wednesday 23 September 2026, 10:00.
    const wed = at(2026, 9, 23, 10);

    it('Today keeps events starting before midnight that have not ended', () => {
        expect(eventInWindow(event(at(2026, 9, 23, 18)), 'today', wed)).toBe(true);
        expect(eventInWindow(event(at(2026, 9, 23, 8), at(2026, 9, 23, 11)), 'today', wed)).toBe(true);
        expect(eventInWindow(event(at(2026, 9, 24, 9)), 'today', wed)).toBe(false);
        expect(eventInWindow(event(at(2026, 9, 23, 6), at(2026, 9, 23, 8)), 'today', wed)).toBe(false);
    });

    it('This weekend is the coming Saturday and Sunday on a weekday', () => {
        const { from, to } = eventWindowRange('weekend', wed);
        expect(new Date(from).getDay()).toBe(6);
        expect(to).toBe(at(2026, 9, 28));
        expect(eventInWindow(event(at(2026, 9, 26, 9)), 'weekend', wed)).toBe(true);
        expect(eventInWindow(event(at(2026, 9, 27, 15)), 'weekend', wed)).toBe(true);
        expect(eventInWindow(event(at(2026, 9, 25, 18)), 'weekend', wed)).toBe(false);
        expect(eventInWindow(event(at(2026, 9, 28, 9)), 'weekend', wed)).toBe(false);
    });

    it('This weekend is the current one on a Sunday', () => {
        const sun = at(2026, 9, 27, 10);
        expect(eventInWindow(event(at(2026, 9, 27, 14)), 'weekend', sun)).toBe(true);
        expect(eventInWindow(event(at(2026, 10, 3, 9)), 'weekend', sun)).toBe(false);
    });

    it('Next 7 days runs from now for a week', () => {
        expect(eventInWindow(event(at(2026, 9, 29, 9)), 'week', wed)).toBe(true);
        expect(eventInWindow(event(at(2026, 9, 30, 9)), 'week', wed)).toBe(true);
        expect(eventInWindow(event(at(2026, 10, 1, 9)), 'week', wed)).toBe(false);
    });

    it('All keeps every open event and no chip keeps a cancelled or ended one', () => {
        expect(eventInWindow(event(at(2027, 1, 1, 9)), 'all', wed)).toBe(true);
        for (const w of ['today', 'weekend', 'week', 'all'] as const) {
            expect(eventInWindow(event(at(2026, 9, 23, 18), undefined, { eventState: 'cancelled' }), w, wed)).toBe(false);
            expect(eventInWindow(event(at(2026, 9, 22, 9), at(2026, 9, 22, 11)), w, wed)).toBe(false);
        }
    });
});

describe('small helpers', () => {
    it('formats distance', () => {
        expect(formatDistance(2.43)).toBe('2.4 km');
        expect(formatDistance(0.8)).toBe('800 m');
        expect(formatDistance(23.6)).toBe('24 km');
    });
    it('turns a datetime-local value into ISO UTC', () => {
        expect(localInputToIso('')).toBeNull();
        expect(localInputToIso('2026-09-26T09:00')).toBe(new Date(at(2026, 9, 26, 9)).toISOString());
    });
});

describe('Copy to a new date', () => {
    const base = event(at(2026, 9, 26, 9), at(2026, 9, 26, 12), {
        title: 'Working bee at the hall',
        description: 'Bring gloves',
        eventPlaceName: 'Bindarrabi Hall',
        eventPrivateNote: 'Gate code 1234',
        lat: -28.55,
        lng: 153.49,
        authorPublicKey: 'host',
    });

    it('carries everything the host typed last time', () => {
        const copy = buildEventCopy(base, 'host');
        expect(copy.title).toBe('Working bee at the hall');
        expect(copy.description).toBe('Bring gloves');
        expect(copy.placeName).toBe('Bindarrabi Hall');
        expect(copy.privateNote).toBe('Gate code 1234');
        expect(copy.lat).toBe(-28.55);
        expect(copy.lng).toBe(153.49);
    });

    it('never carries a date — picking the new one is the whole point', () => {
        const copy = buildEventCopy(base, 'host') as unknown as Record<string, unknown>;
        expect(copy.eventStartAt).toBeUndefined();
        expect(copy.eventEndAt).toBeUndefined();
        expect(Object.keys(copy).some(k => /start|end|date/i.test(k))).toBe(false);
    });

    it('a member copying their own event posts as themselves', () => {
        expect(buildEventCopy(base, 'host').enterprisePubkey).toBeNull();
        expect(buildEventCopy(base, 'host').groupId).toBeNull();
    });

    it('a keeper copying an enterprise event keeps the enterprise as the host', () => {
        const copy = buildEventCopy({ ...base, authorPublicKey: 'enterprise-pk' }, 'keeper-pk');
        expect(copy.enterprisePubkey).toBe('enterprise-pk');
        expect(copy.groupId).toBeNull();
    });

    it('a group-only event is copied back to the same group, not to an enterprise', () => {
        const copy = buildEventCopy(
            { ...base, audienceScope: 'group', targetGroupId: 'grp-1', authorPublicKey: 'convenor-a' },
            'convenor-b',
        );
        expect(copy.groupId).toBe('grp-1');
        expect(copy.enterprisePubkey).toBeNull();
    });

    it('carries no note when the node did not send one (nobody but a host or Going gets it)', () => {
        const { eventPrivateNote: _drop, ...noNote } = base;
        expect(buildEventCopy(noNote as MarketplacePost, 'host').privateNote).toBe('');
    });

    it('survives an event with no pin or place name', () => {
        const copy = buildEventCopy({ ...base, lat: undefined, lng: undefined, eventPlaceName: undefined } as MarketplacePost, 'host');
        expect(copy.lat).toBeNull();
        expect(copy.lng).toBeNull();
        expect(copy.placeName).toBe('');
    });
});

describe('editing an event (events round 2, decision 29)', () => {
    const start = at(2030, 9, 28, 9);
    const ev = event(start, start + 3 * HOUR, {
        description: 'Clearing the back garden', eventPlaceName: 'The hall', eventPrivateNote: 'Gate 1234',
        photos: ['https://node/api/marketplace/posts/ev/photos/0?v=1'],
    });

    it('fills every field of the form, the dates in local time', () => {
        const form = eventEditForm(ev);
        expect(form).toEqual({
            title: 'Working bee', description: 'Clearing the back garden', start: '2030-09-28T09:00', end: '2030-09-28T12:00',
            placeName: 'The hall', lat: -28.5, lng: 153.5, privateNote: 'Gate 1234',
            photos: ['https://node/api/marketplace/posts/ev/photos/0?v=1'],
        });
        expect(localInputToIso(isoToLocalInput(ev.eventStartAt))).toBe(ev.eventStartAt);
    });

    it('sends nothing when nothing changed', () => {
        const form = eventEditForm(ev);
        expect(eventEditPayload(form, { ...form })).toEqual({});
    });

    it('sends only the title for a title fix — never the dates, so it cannot mark the event UPDATED', () => {
        const before = eventEditForm(ev);
        const payload = eventEditPayload(before, { ...before, title: 'Working bee and lunch' });
        expect(payload).toEqual({ title: 'Working bee and lunch' });
        expect(eventEditNotifies(payload)).toBe(false);
    });

    it('description, note and photo edits are silent too', () => {
        const before = eventEditForm(ev);
        const payload = eventEditPayload(before, { ...before, description: 'Bring a hat', privateNote: 'Gate 9999', photos: [] });
        expect(payload).toEqual({ description: 'Bring a hat', eventPrivateNote: 'Gate 9999', photos: [] });
        expect(eventEditNotifies(payload)).toBe(false);
    });

    it('a new start is sent as ISO UTC and is a change people going hear about', () => {
        const before = eventEditForm(ev);
        const payload = eventEditPayload(before, { ...before, start: '2030-09-28T10:00' });
        expect(payload).toEqual({ eventStartAt: new Date(at(2030, 9, 28, 10)).toISOString() });
        expect(eventEditNotifies(payload)).toBe(true);
    });

    it('a moved pin or a renamed place is a place change', () => {
        const before = eventEditForm(ev);
        expect(eventEditNotifies(eventEditPayload(before, { ...before, lat: -28.6 }))).toBe(true);
        expect(eventEditPayload(before, { ...before, lat: -28.6 })).toEqual({ lat: -28.6, lng: 153.5 });
        expect(eventEditNotifies(eventEditPayload(before, { ...before, placeName: 'The old bowls club' }))).toBe(true);
    });

    it('a cleared end goes as an empty string, which the node turns into start + 2 hours', () => {
        const before = eventEditForm(ev);
        expect(eventEditPayload(before, { ...before, end: '' })).toEqual({ eventEndAt: '' });
    });

    it('can be edited while open; not once cancelled or ended, and says which', () => {
        const now = at(2030, 9, 27, 12);
        expect(eventEditBlockedReason(ev, now)).toBeNull();
        expect(eventEditBlockedReason({ ...ev, eventState: 'cancelled', status: 'cancelled' }, now)).toBe('This event was cancelled, so it can no longer be edited.');
        expect(eventEditBlockedReason(ev, start + 4 * HOUR)).toBe('This event has ended, so it can no longer be edited.');
        // Under way is still editable: the note often needs fixing on the day.
        expect(eventEditBlockedReason(ev, start + HOUR)).toBeNull();
    });
});

describe('the feed\'s Events filter (B5, same as the phone)', () => {
    const now = at(2026, 9, 23, 10); // a Wednesday
    const today = event(at(2026, 9, 23, 18));
    const saturday = event(at(2026, 9, 26, 9));
    const nextMonth = event(at(2026, 10, 20, 9));
    const cancelled = event(at(2026, 9, 24, 9), undefined, { eventState: 'cancelled', status: 'cancelled' });
    const offer: MarketplacePost = { ...event(at(2026, 9, 24, 9)), id: 'offer-1', type: 'offer' };
    const remote = { ...event(at(2026, 9, 24, 9)), id: 'remote-1', _remoteNode: 'https://elsewhere' } as MarketplacePost;
    const all = [nextMonth, offer, saturday, cancelled, today, remote];

    it('shows events only, soonest first, never cancelled ones or another community\'s', () => {
        expect(eventsFeedFilter(all, 'all', now).map(p => p.id)).toEqual([today.id, saturday.id, nextMonth.id]);
    });

    it('narrows by the date chips', () => {
        expect(eventsFeedFilter(all, 'today', now).map(p => p.id)).toEqual([today.id]);
        expect(eventsFeedFilter(all, 'weekend', now).map(p => p.id)).toEqual([saturday.id]);
        expect(eventsFeedFilter(all, 'week', now).map(p => p.id)).toEqual([today.id, saturday.id]);
    });
});
