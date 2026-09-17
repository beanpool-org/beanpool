import { describe, it, expect } from 'vitest';
import {
    buildEventDraft, defaultEventEnd, formatEventWhen, formatPickerValue, isEventInFeed, eventBadge,
    nextRsvp, applyRsvp, formatDistance, eventCacheColumns, approximatePin, rsvpSignedMessage,
    EVENT_TYPES_QUERY, type EventFormInput,
} from '../events';

// Dates are built with the local-time constructor so these hold in any TZ the runner has.
const now = new Date(2026, 8, 20, 8, 0);

function form(over: Partial<EventFormInput> = {}): EventFormInput {
    return {
        title: 'Working bee at the hall',
        description: 'Bring gloves',
        start: new Date(2026, 8, 26, 9, 0),
        end: new Date(2026, 8, 26, 12, 0),
        placeName: 'Bindarrabi Hall',
        lat: -28.55,
        lng: 153.49,
        privateNote: 'Gate code 1234',
        audienceGroupId: null,
        authorPubkey: 'me',
        ...over,
    };
}

describe('events: opt-in list parameter', () => {
    it('names every type including event', () => {
        expect(EVENT_TYPES_QUERY).toBe('types=offer,need,poll,event');
    });
});

describe('events: buildEventDraft', () => {
    it('builds a local-reach, zero-bean community post with the event fields', () => {
        const r = buildEventDraft(form(), now);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.draft).toMatchObject({
            type: 'event', category: 'community', credits: 0, price_type: 'fixed', reach: 'local',
            title: 'Working bee at the hall', eventPlaceName: 'Bindarrabi Hall', eventPrivateNote: 'Gate code 1234',
            lat: -28.55, lng: 153.49, author_pubkey: 'me',
        });
        expect(r.draft.eventStartAt).toBe(new Date(2026, 8, 26, 9, 0).toISOString());
        expect(r.draft).not.toHaveProperty('audienceScope');
    });

    it('defaults a blank end to start + 2 hours', () => {
        const r = buildEventDraft(form({ end: null }), now);
        expect(r.ok && r.draft.eventEndAt).toBe(new Date(2026, 8, 26, 11, 0).toISOString());
        expect(defaultEventEnd(new Date(2026, 0, 1, 23, 0)).getTime()).toBe(new Date(2026, 0, 2, 1, 0).getTime());
    });

    it('refuses a start in the past, an end before the start, a missing pin or place, and long fields', () => {
        expect(buildEventDraft(form({ start: new Date(2026, 8, 19, 9, 0), end: null }), now).ok).toBe(false);
        expect(buildEventDraft(form({ start: null }), now).ok).toBe(false);
        expect(buildEventDraft(form({ end: new Date(2026, 8, 26, 8, 0) }), now).ok).toBe(false);
        expect(buildEventDraft(form({ end: new Date(2026, 8, 26, 9, 0) }), now).ok).toBe(false);
        expect(buildEventDraft(form({ lat: null }), now).ok).toBe(false);
        expect(buildEventDraft(form({ placeName: '  ' }), now).ok).toBe(false);
        expect(buildEventDraft(form({ placeName: 'x'.repeat(81) }), now).ok).toBe(false);
        expect(buildEventDraft(form({ privateNote: 'x'.repeat(1001) }), now).ok).toBe(false);
        expect(buildEventDraft(form({ title: ' ' }), now).ok).toBe(false);
    });

    it('omits an empty note and sends group-only audience when a group is picked', () => {
        const r = buildEventDraft(form({ privateNote: '  ', audienceGroupId: 'g1' }), now);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.draft).not.toHaveProperty('eventPrivateNote');
        expect(r.draft).toMatchObject({ audienceScope: 'group', targetGroupId: 'g1' });
    });
});

describe('events: card text', () => {
    it('formats a same-day event as "SAT 26 SEP · 9:00–12:00"', () => {
        const s = new Date(2026, 8, 26, 9, 0).toISOString();
        const e = new Date(2026, 8, 26, 12, 0).toISOString();
        expect(formatEventWhen(s, e)).toBe('SAT 26 SEP · 9:00–12:00');
    });

    it('shows both days across midnight and falls back to start + 2 h without an end', () => {
        const s = new Date(2026, 8, 26, 22, 30).toISOString();
        expect(formatEventWhen(s, new Date(2026, 8, 27, 2, 0).toISOString())).toBe('SAT 26 SEP 22:30 – SUN 27 SEP 2:00');
        expect(formatEventWhen(new Date(2026, 8, 26, 9, 0).toISOString(), null)).toBe('SAT 26 SEP · 9:00–11:00');
        expect(formatEventWhen(undefined)).toBe('');
    });

    it('formats a picker row value', () => {
        expect(formatPickerValue(new Date(2026, 8, 26, 9, 5))).toBe('Sat 26 Sep, 9:05');
        expect(formatPickerValue(null)).toBe('');
    });

    it('badges CANCELLED and UPDATED, nothing when scheduled', () => {
        expect(eventBadge({ event_state: 'cancelled' })).toBe('CANCELLED');
        expect(eventBadge({ status: 'cancelled', event_state: 'scheduled' })).toBe('CANCELLED');
        expect(eventBadge({ eventState: 'updated' })).toBe('UPDATED');
        expect(eventBadge({ event_state: 'scheduled' })).toBeNull();
    });

    it('formats distance', () => {
        expect(formatDistance(2.43)).toBe('2.4 km');
        expect(formatDistance(0.234)).toBe('230 m');
        expect(formatDistance(23.6)).toBe('24 km');
        expect(formatDistance(null)).toBeNull();
    });

    it('approximates a pin to three decimals', () => {
        expect(approximatePin(-28.55234, 153.49918)).toEqual({ lat: -28.552, lng: 153.499 });
    });
});

describe('events: feed membership', () => {
    const base = {
        type: 'event', status: 'active', active: 1, event_state: 'scheduled',
        event_start_at: new Date(2026, 8, 26, 9, 0).toISOString(),
        event_end_at: new Date(2026, 8, 26, 12, 0).toISOString(),
    };
    it('keeps an upcoming or in-progress event', () => {
        expect(isEventInFeed(base, now.getTime())).toBe(true);
        expect(isEventInFeed(base, new Date(2026, 8, 26, 11, 59).getTime())).toBe(true);
        expect(isEventInFeed({ ...base, event_state: 'updated' }, now.getTime())).toBe(true);
    });
    it('drops an ended, cancelled or inactive event, and anything that is not an event', () => {
        expect(isEventInFeed(base, new Date(2026, 8, 26, 12, 0).getTime())).toBe(false);
        expect(isEventInFeed({ ...base, event_state: 'cancelled' }, now.getTime())).toBe(false);
        expect(isEventInFeed({ ...base, status: 'cancelled' }, now.getTime())).toBe(false);
        expect(isEventInFeed({ ...base, active: 0 }, now.getTime())).toBe(false);
        expect(isEventInFeed({ ...base, type: 'offer' }, now.getTime())).toBe(false);
    });
    it('uses start + 2 h when the cached row has no end', () => {
        const noEnd = { ...base, event_end_at: null };
        expect(isEventInFeed(noEnd, new Date(2026, 8, 26, 10, 59).getTime())).toBe(true);
        expect(isEventInFeed(noEnd, new Date(2026, 8, 26, 11, 0).getTime())).toBe(false);
    });
});

describe('events: RSVP', () => {
    it('tapping the held button clears it, the other switches', () => {
        expect(nextRsvp(null, 'going')).toBe('going');
        expect(nextRsvp('going', 'going')).toBeNull();
        expect(nextRsvp('going', 'interested')).toBe('interested');
    });
    it('moves counts optimistically without going negative', () => {
        const c = { going: 7, interested: 3, mine: null };
        const g = applyRsvp(c, 'going');
        expect(g).toEqual({ going: 8, interested: 3, mine: 'going' });
        const i = applyRsvp(g, 'interested');
        expect(i).toEqual({ going: 7, interested: 4, mine: 'interested' });
        expect(applyRsvp(i, null)).toEqual({ going: 7, interested: 3, mine: null });
        expect(applyRsvp({ going: 0, interested: 0, mine: 'going' }, null)).toEqual({ going: 0, interested: 0, mine: null });
    });
    it('signs the message the server verifies', () => {
        expect(rsvpSignedMessage('p1', 'going')).toBe('p1:going');
        expect(rsvpSignedMessage('p1', null)).toBe('p1:none');
    });
});

describe('events: cache columns', () => {
    it('maps a server row and leaves non-events empty', () => {
        expect(eventCacheColumns({
            type: 'event', eventStartAt: 's', eventEndAt: 'e', eventPlaceName: 'Hall', eventState: 'updated',
            goingCount: 7, interestedCount: 3, eventPrivateNote: 'secret', myRsvp: 'going',
        })).toEqual(['s', 'e', 'Hall', 'updated', 7, 3]);
        expect(eventCacheColumns({ type: 'offer', eventStartAt: 's' })).toEqual([null, null, null, null, 0, 0]);
    });
});
