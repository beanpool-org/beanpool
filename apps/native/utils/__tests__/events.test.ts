import { describe, it, expect } from 'vitest';
import {
    buildEventDraft, buildEventCopy, defaultEventEnd, formatEventWhen, formatPickerValue, isEventInFeed, eventBadge,
    nextRsvp, applyRsvp, formatDistance, eventCacheColumns, approximatePin, rsvpSignedMessage, eventCoverPhoto,
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

describe('Copy to a new date', () => {
    // The node's shape (camelCase); the phone's cached row (snake_case) is covered below, because the event
    // screen paints from the cache before the signed fetch lands.
    const server = {
        id: 'ev-1', type: 'event', title: 'Working bee at the hall', description: 'Bring gloves',
        eventStartAt: '2026-09-26T09:00:00.000Z', eventEndAt: '2026-09-26T12:00:00.000Z',
        eventPlaceName: 'Bindarrabi Hall', eventPrivateNote: 'Gate code 1234',
        lat: -28.55, lng: 153.49, authorPublicKey: 'host', audienceScope: 'public',
    };

    it('carries everything the host typed last time', () => {
        const copy = buildEventCopy(server, 'host');
        expect(copy.title).toBe('Working bee at the hall');
        expect(copy.description).toBe('Bring gloves');
        expect(copy.placeName).toBe('Bindarrabi Hall');
        expect(copy.privateNote).toBe('Gate code 1234');
        expect(copy.lat).toBe(-28.55);
        expect(copy.lng).toBe(153.49);
    });

    it('never carries a date — picking the new one is the whole point', () => {
        const copy = buildEventCopy(server, 'host') as unknown as Record<string, unknown>;
        expect(Object.keys(copy).some(k => /start|end|date/i.test(k))).toBe(false);
    });

    it("reads the phone's cached row too", () => {
        const cached = {
            id: 'ev-1', type: 'event', title: 'Working bee', description: '',
            event_place_name: 'The old bowls club', event_private_note: 'Back gate',
            lat: '-28.61', lng: '153.51', author_pubkey: 'host', audience_scope: 'public',
        };
        const copy = buildEventCopy(cached, 'host');
        expect(copy.placeName).toBe('The old bowls club');
        expect(copy.privateNote).toBe('Back gate');
        expect(copy.lat).toBe(-28.61);
        expect(copy.lng).toBe(153.51);
    });

    it('a member copying their own event posts as themselves', () => {
        expect(buildEventCopy(server, 'host').enterprisePubkey).toBeNull();
        expect(buildEventCopy(server, 'host').groupId).toBeNull();
    });

    it('a keeper copying an enterprise event keeps the enterprise as the host', () => {
        const copy = buildEventCopy({ ...server, authorPublicKey: 'enterprise-pk' }, 'keeper-pk');
        expect(copy.enterprisePubkey).toBe('enterprise-pk');
        expect(copy.groupId).toBeNull();
    });

    it('a group-only event is copied back to the same group, not to an enterprise', () => {
        const copy = buildEventCopy(
            { ...server, audienceScope: 'group', targetGroupId: 'grp-1', authorPublicKey: 'convenor-a' },
            'convenor-b',
        );
        expect(copy.groupId).toBe('grp-1');
        expect(copy.enterprisePubkey).toBeNull();
    });

    it('carries no note when the node did not send one', () => {
        const { eventPrivateNote: _drop, ...noNote } = server;
        expect(buildEventCopy(noNote, 'host').privateNote).toBe('');
    });

    it('survives an event with no pin or place name', () => {
        const copy = buildEventCopy({ ...server, lat: null, lng: null, eventPlaceName: undefined }, 'host');
        expect(copy.lat).toBeNull();
        expect(copy.lng).toBeNull();
        expect(copy.placeName).toBe('');
    });

    it('the copy still passes the create form check once a future date is picked', () => {
        const copy = buildEventCopy(server, 'host');
        const built = buildEventDraft({
            title: copy.title, description: copy.description, placeName: copy.placeName,
            lat: copy.lat, lng: copy.lng, privateNote: copy.privateNote,
            audienceGroupId: copy.groupId, authorPubkey: copy.enterprisePubkey ?? 'host',
            start: new Date(2026, 9, 24, 9, 0), end: null,
        }, new Date(2026, 8, 20, 8, 0));
        expect(built.ok).toBe(true);
        if (built.ok) {
            expect(built.draft.eventPlaceName).toBe('Bindarrabi Hall');
            expect(built.draft.eventPrivateNote).toBe('Gate code 1234');
            expect(built.draft.reach).toBe('local');
        }
    });

    it('a copy with no date picked is refused, the same as any other new event', () => {
        const copy = buildEventCopy(server, 'host');
        const built = buildEventDraft({
            title: copy.title, description: copy.description, placeName: copy.placeName,
            lat: copy.lat, lng: copy.lng, privateNote: copy.privateNote,
            audienceGroupId: copy.groupId, authorPubkey: 'host', start: null, end: null,
        }, new Date(2026, 8, 20, 8, 0));
        expect(built.ok).toBe(false);
    });
});

/**
 * The feed card shows the event's photo, as the offer cards beside it do (Damo, 2026-09-23).
 *
 * This runner is node-only on purpose — screens need a device (see vitest.config.ts) — so what is held here is
 * the card's decision, not its render: which URL EventCard hands to <Image>, and when it hands over nothing.
 * That the card then draws it is covered on the web client, whose EventCard test renders the real thing.
 */
describe("the event's photo on the feed card (Damo, 2026-09-23)", () => {
    it('is the first photo when the event has one', () => {
        expect(eventCoverPhoto({ photos: ['https://node.example/uploads/a.jpg', 'https://node.example/uploads/b.jpg'] }))
            .toBe('https://node.example/uploads/a.jpg');
    });

    it('reads a cache row that still holds the raw JSON string', () => {
        expect(eventCoverPhoto({ photos: '["https://node.example/uploads/a.jpg"]' }))
            .toBe('https://node.example/uploads/a.jpg');
    });

    it('is nothing when the event has no photo, so the card stays exactly as it was', () => {
        expect(eventCoverPhoto({ photos: [] })).toBeNull();
        expect(eventCoverPhoto({ photos: '[]' })).toBeNull();
        expect(eventCoverPhoto({})).toBeNull();
        expect(eventCoverPhoto(null)).toBeNull();
    });

    it('never shows a placeholder as if it were a picture', () => {
        for (const junk of ['', '   ', 'null', 'undefined']) {
            expect(eventCoverPhoto({ photos: [junk] })).toBeNull();
        }
        expect(eventCoverPhoto({ photos: 'not json' })).toBeNull();
        expect(eventCoverPhoto({ photos: [{ url: 'a.jpg' }] })).toBeNull();
    });

    it('hands back the URL the loader resolved, untouched — this is not a second resolver', () => {
        // db.ts getPosts has already turned '/uploads/a.jpg' into an absolute URL against the anchor.
        expect(eventCoverPhoto({ photos: ['https://mullum.beanpool.org/uploads/a.jpg'] }))
            .toBe('https://mullum.beanpool.org/uploads/a.jpg');
    });
});
