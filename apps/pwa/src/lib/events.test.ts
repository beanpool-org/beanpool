import { describe, it, expect } from 'vitest';
import { buildEventCopy, eventInWindow, eventWindowRange, formatDistance, formatEventWhen, isEventOpen, localInputToIso } from './events';
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
