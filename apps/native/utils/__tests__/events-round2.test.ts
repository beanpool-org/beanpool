import { describe, it, expect } from 'vitest';
import {
    buildEventEditPatch, eventEditBlockedReason, eventEditValues, eventPinCard, isEventHostView, isOwnEvent,
    type EventEditValues,
} from '../events';
import { eventFitCoordinates, eventFitPadding, EVENT_PIN_HEIGHT_DP } from '../map-filters';
import { feedSections, localDaysAgo, UPCOMING_EVENTS_HEADING } from '../feed-sections';
import { NEW_POST_TYPES } from '../compose-options';

// Local-time constructors keep these independent of the runner's time zone.
const HOUR = 60 * 60 * 1000;
const now = new Date(2026, 8, 23, 10, 0); // Wednesday 23 Sep 2026, 10:00

/** The node's view of an event, as the host gets it. */
const hostView: any = {
    id: 'ev-1', type: 'event', title: 'Working bee', description: 'Clearing the back garden',
    authorPublicKey: 'host-pk', status: 'active', active: true, eventState: 'scheduled',
    eventStartAt: new Date(2026, 8, 26, 9, 0).toISOString(), eventEndAt: new Date(2026, 8, 26, 12, 0).toISOString(),
    eventPlaceName: 'Bindarrabi Hall', eventPrivateNote: 'Gate code 1234', lat: -28.55, lng: 153.49,
    photos: ['https://node/api/marketplace/posts/ev-1/photos/0?v=1'], goingCount: 4, interestedCount: 2,
    eventRsvps: [{ memberPubkey: 'b', status: 'going' }],
};

describe('who is the host (round 2, A1 / B4)', () => {
    it('is the node\'s call on the event page: the RSVP list is sent to hosts only', () => {
        expect(isEventHostView(hostView)).toBe(true);
        expect(isEventHostView({ ...hostView, eventRsvps: undefined })).toBe(false);
        expect(isEventHostView(null)).toBe(false);
    });

    it('is the author on the feed card, which has only the cached row', () => {
        expect(isOwnEvent({ type: 'event', author_pubkey: 'me' }, 'me')).toBe(true);
        expect(isOwnEvent({ type: 'event', author_pubkey: 'someone' }, 'me')).toBe(false);
        expect(isOwnEvent({ type: 'offer', author_pubkey: 'me' }, 'me')).toBe(false);
        expect(isOwnEvent({ type: 'event', author_pubkey: 'me' }, null)).toBe(false);
    });
});

describe('editing is refused once the event is over or cancelled, and says why (A3)', () => {
    it('allows an open event, including one already under way', () => {
        expect(eventEditBlockedReason(hostView, now.getTime())).toBeNull();
        expect(eventEditBlockedReason(hostView, new Date(2026, 8, 26, 10, 0).getTime())).toBeNull();
    });
    it('refuses an ended event', () => {
        expect(eventEditBlockedReason(hostView, new Date(2026, 8, 26, 13, 0).getTime()))
            .toBe('This event has ended, so it can no longer be edited.');
    });
    it('refuses a cancelled event, from the node view or the cached row', () => {
        expect(eventEditBlockedReason({ ...hostView, eventState: 'cancelled' }, now.getTime()))
            .toBe('This event was cancelled, so it can no longer be edited.');
        expect(eventEditBlockedReason({ ...hostView, status: 'cancelled' }, now.getTime()))
            .toBe('This event was cancelled, so it can no longer be edited.');
    });
});

describe('the edit form and what Save sends (A2, decision 29)', () => {
    const before = eventEditValues(hostView);

    it('fills every field the create form has, dates and photo included', () => {
        expect(before).toEqual({
            title: 'Working bee', description: 'Clearing the back garden',
            start: new Date(2026, 8, 26, 9, 0), end: new Date(2026, 8, 26, 12, 0),
            placeName: 'Bindarrabi Hall', lat: -28.55, lng: 153.49, privateNote: 'Gate code 1234',
            photo: 'https://node/api/marketplace/posts/ev-1/photos/0?v=1',
        });
        // The cached row (snake_case, photos as JSON) fills it the same way, less the note it never holds.
        const cached = eventEditValues({
            title: 'Working bee', description: 'Clearing the back garden', event_start_at: hostView.eventStartAt,
            event_end_at: hostView.eventEndAt, event_place_name: 'Bindarrabi Hall', lat: '-28.55', lng: '153.49',
            photos: JSON.stringify(['https://node/p.jpg']),
        });
        expect(cached.start).toEqual(before.start);
        expect(cached.lat).toBe(-28.55);
        expect(cached.photo).toBe('https://node/p.jpg');
        expect(cached.privateNote).toBe('');
    });

    const save = (after: Partial<EventEditValues>) => buildEventEditPatch(before, { ...before, ...after }, now);

    it('sends nothing when nothing changed', () => {
        expect(save({})).toEqual({ ok: true, patch: {}, notifies: false });
    });

    it('a title, description, note or photo edit is silent and sends only that field', () => {
        expect(save({ title: 'Working bee and lunch' })).toEqual({ ok: true, patch: { title: 'Working bee and lunch' }, notifies: false });
        expect(save({ description: 'Bring a hat' })).toEqual({ ok: true, patch: { description: 'Bring a hat' }, notifies: false });
        expect(save({ privateNote: 'Gate 9999' })).toEqual({ ok: true, patch: { eventPrivateNote: 'Gate 9999' }, notifies: false });
        expect(save({ photo: null })).toEqual({ ok: true, patch: { photos: [] }, notifies: false });
        expect(save({ photo: 'data:image/jpeg;base64,xyz' })).toEqual({ ok: true, patch: { photos: ['data:image/jpeg;base64,xyz'] }, notifies: false });
    });

    it('a new time is sent and marks the edit as one people going will hear about', () => {
        const moved = save({ start: new Date(2026, 8, 26, 10, 0) });
        // The end the form shows goes too: left out, the node would keep the length and save 10:00–13:00.
        expect(moved).toEqual({ ok: true, patch: {
            eventStartAt: new Date(2026, 8, 26, 10, 0).toISOString(), eventEndAt: new Date(2026, 8, 26, 12, 0).toISOString(),
        }, notifies: true });
        expect(save({ end: new Date(2026, 8, 26, 13, 0) })).toMatchObject({ ok: true, notifies: true });
        // A cleared end goes as '', which the node turns into start + 2 hours.
        expect(save({ end: null })).toEqual({ ok: true, patch: { eventEndAt: '' }, notifies: true });
    });

    it('a moved pin or a renamed place is a place change', () => {
        expect(save({ lat: -28.6 })).toEqual({ ok: true, patch: { lat: -28.6, lng: 153.49 }, notifies: true });
        expect(save({ placeName: 'The old bowls club' })).toEqual({ ok: true, patch: { eventPlaceName: 'The old bowls club' }, notifies: true });
    });

    it('refuses what the node would refuse, in words', () => {
        expect(save({ title: '  ' })).toEqual({ ok: false, error: 'Give the event a title.' });
        expect(save({ start: new Date(2026, 8, 22, 9, 0) })).toMatchObject({ ok: false, error: expect.stringMatching(/already passed/) });
        expect(save({ end: new Date(2026, 8, 26, 8, 0) })).toEqual({ ok: false, error: 'The end time must be after the start.' });
        expect(save({ placeName: '' })).toMatchObject({ ok: false });
        expect(save({ lat: null })).toMatchObject({ ok: false, error: expect.stringMatching(/pin on the map/) });
    });

    it('does not re-check an untouched start against the clock: an event under way can have its note fixed', () => {
        const underWay = new Date(2026, 8, 26, 10, 0);
        expect(buildEventEditPatch(before, { ...before, privateNote: 'Round the back' }, underWay))
            .toEqual({ ok: true, patch: { eventPrivateNote: 'Round the back' }, notifies: false });
    });
});

describe('the map pin card for an event (B1)', () => {
    it('leads with the date and time, then title, place and how many are going — no category, no beans', () => {
        const card = eventPinCard({ ...hostView, category: 'general', credits: 0 });
        expect(card).toEqual({
            when: 'SAT 26 SEP · 9:00–12:00',
            badge: null,
            title: 'Working bee',
            place: 'Bindarrabi Hall',
            going: '4 going',
        });
        expect(JSON.stringify(card)).not.toMatch(/GENERAL|🫘|general/);
    });

    it('reads the cached row too, and shows UPDATED', () => {
        const card = eventPinCard({
            type: 'event', title: 'Repair café', event_start_at: hostView.eventStartAt, event_end_at: hostView.eventEndAt,
            event_place_name: '', event_state: 'updated', event_going_count: 0,
        });
        expect(card).toMatchObject({ when: 'SAT 26 SEP · 9:00–12:00', badge: 'UPDATED', place: null, going: '0 going' });
    });
});

describe('bringing event pins into view below the filter rows (B2)', () => {
    it('fits every visible pin, and a lone one with a small box around it rather than the street', () => {
        expect(eventFitCoordinates([])).toEqual([]);
        const two = eventFitCoordinates([{ lat: -28.5, lng: 153.5 }, { lat: '-28.6', lng: '153.4' }]);
        expect(two).toEqual([{ latitude: -28.5, longitude: 153.5 }, { latitude: -28.6, longitude: 153.4 }]);
        const lone = eventFitCoordinates([{ lat: -28.5, lng: 153.5 }]);
        expect(lone).toHaveLength(2);
        expect(lone[0].latitude).toBeLessThan(-28.5);
        expect(lone[1].latitude).toBeGreaterThan(-28.5);
        expect((lone[0].latitude + lone[1].latitude) / 2).toBeCloseTo(-28.5, 6);
    });

    it('pads the top by the filter rows plus the pin, so a pin is never drawn under the date chips', () => {
        // 320dp at 1.3x text: the two rows end around 150dp down.
        const pad = eventFitPadding(150);
        expect(pad.top).toBeGreaterThanOrEqual(150 + EVENT_PIN_HEIGHT_DP);
        expect(pad.bottom).toBeGreaterThan(0);
        // Not measured yet: still clear of the rows' usual height.
        expect(eventFitPadding(0).top).toBeGreaterThanOrEqual(120 + EVENT_PIN_HEIGHT_DP);
    });
});

describe('feed headings (B6)', () => {
    const at = (d: number, h: number, mi = 0) => new Date(2026, 8, d, h, mi).toISOString();
    // The bug: a Saturday event, posted this morning, sat under TODAY because headings were by posting time.
    const saturdayEvent = { id: 'ev-sat', type: 'event', created_at: at(23, 8), event_start_at: at(26, 9) };
    const tomorrowEvent = { id: 'ev-thu', type: 'event', created_at: at(20, 8), event_start_at: at(24, 18) };
    const offerThisMorning = { id: 'o-today', type: 'offer', created_at: at(23, 7) };
    const offerLastNight = { id: 'o-lastnight', type: 'offer', created_at: at(22, 23) };
    const needMonday = { id: 'n-mon', type: 'need', created_at: at(21, 12) };
    const pollOld = { id: 'p-old', type: 'poll', created_at: at(10, 12) };

    it('puts events under their own heading, soonest first — never under TODAY', () => {
        const sections = feedSections([offerThisMorning, saturdayEvent, offerLastNight, tomorrowEvent, needMonday, pollOld], now.getTime());
        expect(sections.map(s => [s.title, s.posts.map((p: any) => p.id)])).toEqual([
            [UPCOMING_EVENTS_HEADING, ['ev-thu', 'ev-sat']],
            ['Today', ['o-today']],
            ['Yesterday', ['o-lastnight']],
            ['This Week', ['n-mon']],
            ['Older Listings', ['p-old']],
        ]);
    });

    it('buckets by local calendar day, not rolling 24 hours: 11 pm last night is Yesterday at 10 am (every post type was affected)', () => {
        expect(localDaysAgo(new Date(2026, 8, 22, 23, 0).getTime(), now.getTime())).toBe(1);
        expect(localDaysAgo(new Date(2026, 8, 23, 0, 5).getTime(), now.getTime())).toBe(0);
        expect(localDaysAgo(now.getTime() - 25 * HOUR, now.getTime())).toBe(1);
        const sections = feedSections([offerLastNight], now.getTime());
        expect(sections.map(s => s.title)).toEqual(['Yesterday']);
    });

    it('leaves out empty headings', () => {
        expect(feedSections([], now.getTime())).toEqual([]);
        expect(feedSections([saturdayEvent], now.getTime()).map(s => s.title)).toEqual([UPCOMING_EVENTS_HEADING]);
    });
});

describe('no fake date on the Event chooser row (B7)', () => {
    it('does not use the 📅 emoji, which Android draws as "JUL 17"', () => {
        const event = NEW_POST_TYPES.find(o => o.id === 'event')!;
        expect(event.emoji).not.toBe('📅');
    });
});
