/**
 * Repeating events on the phone (scratch/global-node/DESIGN-event-times-fable.md §3, §4, §8; slice 5), the logic: what the
 * create draft and the edit patch send, the cache's two columns, the ↻ caption and the Home line. The same choices and words
 * as the web app (both read @beanpool/core event-repeat).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEventDraft, buildEventEditPatch, eventCacheColumns, eventEditValues, eventPinCard, eventRepeatCaption, eventRepeatOf, withMovedFromLine } from '../events';
import { eventLine } from '../home-cards';
import { myEventAsPost } from '../event-extras';

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
    it("a date as long as the gap to the next is refused before Save, in the node's sentence (review of #1993, N7)", () => {
        const week = new Date(2026, 9, 23, 20, 50);
        expect(buildEventDraft({ ...input, repeat: 'weekly', end: week }, NOW)).toEqual({ ok: false, error: 'An event that repeats must end before its next date starts' });
        expect(buildEventDraft({ ...input, repeat: 'fortnightly', end: week }, NOW).ok).toBe(true);
        expect(buildEventDraft({ ...input, repeat: 'weekly', end: new Date(2026, 9, 23, 20, 49) }, NOW).ok).toBe(true);
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
    it('a series made a week long is refused before Save (review of #1993, N7)', () => {
        const before = eventEditValues(post);
        const out = buildEventEditPatch(before, { ...before, end: new Date(2026, 9, 23, 21, 0) }, NOW);
        expect(out).toEqual({ ok: false, error: 'An event that repeats must end before its next date starts' });
    });
    it('a rule the form cannot make carries its words to the form, and its Until is the host\'s to change (confirmation of #1993, NB1)', () => {
        const before = eventEditValues({ ...post, eventRepeat: { freq: 'monthly', interval: 3, byMonthDay: 16, time: '20:50', minutes: 120 }, eventRepeatUntil: '2027-10-16' });
        expect(before.repeat).toBe('other');
        expect(before.repeatRule).toEqual({ freq: 'monthly', interval: 3, byMonthDay: 16 });
        const later = buildEventEditPatch(before, { ...before, repeatUntil: '2028-01-16' }, NOW);
        expect(later.ok && later.patch).toEqual({ eventRepeatUntil: '2028-01-16' });
        const src = readFileSync(join(__dirname, '../../components/NewEventModal.tsx'), 'utf8');
        expect(src).toContain("kept={editOf?.values.start ? { firstDate: deviceLocalClock(editOf.values.start).slice(0, 10), rule: editOf.values.repeatRule ?? null } : null}");
    });
    it('every 3 weeks or every 3 months (a rule the form cannot make): kept or asked about, never re-sent as another (review of #1993, N3)', () => {
        for (const rule of [{ freq: 'weekly', interval: 3, byDay: 'FR' }, { freq: 'monthly', interval: 3, byMonthDay: 16 }]) {
            const before = eventEditValues({ ...post, eventRepeat: { ...rule, time: '20:50', minutes: 120 } });
            expect(before.repeat).toBe('other');
            const title = buildEventEditPatch(before, { ...before, title: 'Dinner' }, NOW);
            expect(title.ok && title.patch).toEqual({ title: 'Dinner' });
            const moved = { ...before, start: new Date(2026, 9, 23, 20, 50), end: new Date(2026, 9, 23, 22, 50) };
            expect(buildEventEditPatch(before, moved, NOW)).toEqual({ ok: false, error: 'Choose how the event repeats from the list' });
            const chosen = buildEventEditPatch(before, { ...moved, repeat: 'weekly' }, NOW);
            expect(chosen.ok && chosen.patch.eventRepeat).toEqual({ freq: 'weekly', interval: 1, byDay: 'FR' });
        }
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
    it("Your events: the card's caption from the node's row (review of #1993, N5)", () => {
        const row = { postId: 'ev-s', title: 'Friday dinner', startAt: '2027-10-15T07:50:00.000Z', endAt: '2027-10-15T09:50:00.000Z', placeName: 'Hall',
            rsvp: 'going' as const, photo: null, reminderOffsets: null, repeat: { freq: 'weekly', interval: 1, byDay: 'FR' }, repeatUntil: '2027-12-17' };
        expect(eventRepeatCaption(myEventAsPost(row))).toBe('Every Friday · until 17 Dec 2027');
        const oneOff = { ...row, repeat: undefined, repeatUntil: undefined };
        expect(eventRepeatCaption(myEventAsPost(oneOff))).toBe('');
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
