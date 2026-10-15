/**
 * Repeating events on the phone (scratch/global-node/DESIGN-event-times-fable.md §3, §4, §8; slice 5), the logic: what the
 * create draft and the edit patch send, the cache's two columns, the ↻ caption and the Home line. The same choices and words
 * as the web app (both read @beanpool/core event-repeat).
 */
import { describe, expect, it } from 'vitest';
import { buildEventDraft, buildEventEditPatch, eventCacheColumns, eventEditValues, eventPinCard, eventRepeatCaption, eventRepeatOf, withMovedFromLine } from '../events';
import { eventLine } from '../home-cards';

const NOW = new Date(2026, 9, 1, 9, 0);
// Fri 16 Oct 2026, 20:50 on this phone's clock.
const FRI = new Date(2026, 9, 16, 20, 50);
const input = {
    title: 'Friday dinner', description: '', start: FRI, end: null, placeName: 'The hall', lat: -28.6, lng: 153.5, privateNote: '',
    audienceGroupId: null, authorPubkey: 'me', tz: 'Australia/Sydney', tzOffsetMinutes: null, hostLetsIn: false,
};

describe('the create draft', () => {
    it('a one-off sends nothing about repeating', () => {
        const out = buildEventDraft(input, NOW);
        expect(out.ok && out.draft.eventRepeat).toBeUndefined();
    });
    it('every week: the pattern from the first date; Until when set', () => {
        const out = buildEventDraft({ ...input, repeat: 'weekly' }, NOW);
        expect(out.ok && out.draft.eventRepeat).toEqual({ freq: 'weekly', interval: 1, byDay: 'FR' });
        const until = buildEventDraft({ ...input, repeat: 'monthly-nth', repeatUntil: '2026-12-18' }, NOW);
        expect(until.ok && until.draft).toMatchObject({ eventRepeat: { freq: 'monthly', interval: 1, byDay: 'FR', pos: 3 }, eventRepeatUntil: '2026-12-18' });
    });
    it('refuses what the node would, in its words', () => {
        expect(buildEventDraft({ ...input, repeat: 'monthly-last' }, NOW)).toEqual({ ok: false, error: 'Choose how the event repeats from the list' });
        expect(buildEventDraft({ ...input, repeat: 'weekly', repeatUntil: '2026-10-15' }, NOW)).toEqual({ ok: false, error: 'The last date must be a date on or after the first one' });
        expect(buildEventDraft({ ...input, repeat: 'weekly', repeatUntil: '2031-10-17' }, NOW)).toEqual({ ok: false, error: 'The last date can be at most 5 years after the first one' });
    });
});

describe('the edit patch', () => {
    const post = {
        type: 'event', title: 'Friday dinner', description: '', eventStartAt: '2026-10-16T09:50:00.000Z', eventEndAt: '2026-10-16T11:50:00.000Z',
        eventStartLocal: '2026-10-16T20:50', eventEndLocal: '2026-10-16T22:50', eventTz: 'Australia/Sydney', eventPlaceName: 'The hall',
        lat: -28.6, lng: 153.5, eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR', time: '20:50', minutes: 120 },
    };
    it('reads the rule back, and a title fix sends nothing about it', () => {
        const before = eventEditValues(post);
        expect(before.repeat).toBe('weekly');
        const out = buildEventEditPatch(before, { ...before, title: 'Friday dinner!' }, NOW);
        expect(out.ok && out.patch).toEqual({ title: 'Friday dinner!' });
    });
    it('moved to a Saturday goes as every Saturday', () => {
        const before = eventEditValues(post);
        const sat = new Date(2026, 9, 17, 20, 50);
        const out = buildEventEditPatch(before, { ...before, start: sat, end: new Date(2026, 9, 17, 22, 50) }, NOW);
        expect(out.ok && out.patch.eventRepeat).toEqual({ freq: 'weekly', interval: 1, byDay: 'SA' });
    });
    it('Does not repeat sends null; Until sends the date, a cleared one null', () => {
        const before = eventEditValues({ ...post, eventRepeatUntil: '2026-12-18' });
        expect(before.repeatUntil).toBe('2026-12-18');
        const never = buildEventEditPatch(before, { ...before, repeat: 'never' }, NOW);
        expect(never.ok && never.patch.eventRepeat).toBeNull();
        const later = buildEventEditPatch(before, { ...before, repeatUntil: '2026-12-25' }, NOW);
        expect(later.ok && later.patch.eventRepeatUntil).toBe('2026-12-25');
        const cleared = buildEventEditPatch(before, { ...before, repeatUntil: '' }, NOW);
        expect(cleared.ok && cleared.patch.eventRepeatUntil).toBeNull();
    });
});

describe('the cache, the caption and Home', () => {
    it('the node row and the cached row read the same rule (the pattern only)', () => {
        const node = { type: 'event', eventRepeat: { freq: 'weekly', interval: 2, byDay: 'FR', time: '20:50', minutes: 120 }, eventRepeatUntil: '2026-12-18' };
        const cols = eventCacheColumns(node);
        expect(cols.slice(10)).toEqual(['{"freq":"weekly","interval":2,"byDay":"FR"}', '2026-12-18']);
        const cached = { type: 'event', event_repeat: cols[10], event_repeat_until: cols[11] };
        expect(eventRepeatOf(cached)).toEqual({ rule: { freq: 'weekly', interval: 2, byDay: 'FR' }, until: '2026-12-18' });
        expect(eventRepeatCaption(cached)).toBe('Every 2 weeks on Friday · until 18 Dec 2026');
        expect(eventCacheColumns({ type: 'event' }).slice(10)).toEqual([null, null]);
        expect(eventRepeatCaption({ type: 'event', event_repeat: 'not json' })).toBe('');
    });
    it('Home: the rule after the next date', () => {
        const line = eventLine({ id: 'e', title: 'Friday dinner', startsAt: '2026-10-16T09:50:00.000Z', endsAt: null, place: 'The hall', rsvp: null,
            startLocal: '2026-10-16T20:50', tz: 'Australia/Sydney', repeat: { freq: 'weekly', interval: 1, byDay: 'FR' } });
        expect(line).toContain(' · ↻ Every Friday · Friday dinner, The hall');
    });
    it('the map popup (map.tsx is protected): the caption after the time on its one line; a one-off has none', () => {
        const ev = { type: 'event', title: 'Friday dinner', eventStartAt: '2026-10-16T09:50:00.000Z', eventEndAt: '2026-10-16T11:50:00.000Z',
            event_repeat: '{"freq":"weekly","interval":1,"byDay":"FR"}' };
        expect(eventPinCard(ev).when.endsWith(' · ↻ Every Friday')).toBe(true);
        expect(eventPinCard({ ...ev, event_repeat: null }).when).not.toContain('↻');
    });
    it('Change this date only: the moved-from line on top of the copy', () => {
        expect(withMovedFromLine('Moved from the regular Friday', 'Bring a plate')).toBe('Moved from the regular Friday\n\nBring a plate');
    });
});
