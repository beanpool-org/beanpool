/**
 * Repeating events on the web (scratch/global-node/DESIGN-event-times-fable.md §3, §4, §8; slice 5): the form's Repeats and
 * Until, what create and edit send, the ↻ caption on the card and Home, and the detail's Next dates with the host's Cancel
 * this date / Bring it back / Change this date only (the node mocked). At 320px with text at 130%.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { seriesDatesShown, type RepeatChoiceKey } from '@beanpool/core';
import { EventCard, EventDetail } from './EventCard';
import { EventRepeatFields, eventRepeatProblem, type KeptRepeat } from './EventRepeatFields';
import * as api from '../lib/api';
import {
    eventEditForm, eventEditPayload, eventRepeatCreate, movedCopyContext, parseCopyEventContext, withMovedFromLine,
} from '../lib/events';
import { homeEventRepeats } from '../lib/home-cards';
import { myEventAsPost } from './YourEvents';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, rsvpEvent: vi.fn(), removeMarketplacePost: vi.fn(), getMarketplacePosts: vi.fn(async () => []), setEventDateCancelled: vi.fn() };
});

const identity: any = { publicKey: 'host-pk', privateKey: 'priv', callsign: 'Hana' };
// Fri 16 Oct 2027 does not exist (2027-10-16 is a Saturday); the series is on Fridays from 15 Oct 2027.
const series: any = {
    id: 'ev-s', type: 'event', category: 'community', title: 'Friday dinner', description: 'Bring a plate', credits: 0, priceType: 'fixed',
    authorPublicKey: 'host-pk', authorCallsign: 'Hana', createdAt: new Date().toISOString(), active: true, status: 'active', repeatable: false,
    lat: -28.65, lng: 153.56, eventPlaceName: 'Bangalow Hall', eventState: 'scheduled', goingCount: 2, interestedCount: 0,
    eventStartAt: '2027-10-15T07:50:00.000Z', eventEndAt: '2027-10-15T09:50:00.000Z',
    eventStartLocal: '2027-10-15T18:50', eventEndLocal: '2027-10-15T20:50', eventTz: 'Australia/Sydney',
    eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR', time: '18:50', minutes: 120 },
    eventNextDates: [
        { date: '2027-10-15', startLocal: '2027-10-15T18:50', startAt: '2027-10-15T07:50:00.000Z', cancelled: false },
        { date: '2027-10-22', startLocal: '2027-10-22T18:50', startAt: '2027-10-22T07:50:00.000Z', cancelled: true },
        { date: '2027-10-29', startLocal: '2027-10-29T18:50', startAt: '2027-10-29T07:50:00.000Z', cancelled: false },
    ],
};
const hostView = { ...series, eventRsvps: [] };
// The node's answer once the current 15 Oct is cancelled: the event rolls past the cancelled 22 Oct to 29 Oct, and the node
// lists both cancelled dates it has passed first, each with its end, until then (confirmation 2 of #1993, NB2).
const rolledView = {
    ...hostView, eventStartLocal: '2027-10-29T18:50', eventEndLocal: '2027-10-29T20:50', eventStartAt: '2027-10-29T07:50:00.000Z', eventEndAt: '2027-10-29T09:50:00.000Z',
    eventNextDates: [
        { date: '2027-10-15', startLocal: '2027-10-15T18:50', startAt: '2027-10-15T07:50:00.000Z', endAt: '2027-10-15T09:50:00.000Z', cancelled: true },
        { date: '2027-10-22', startLocal: '2027-10-22T18:50', startAt: '2027-10-22T07:50:00.000Z', endAt: '2027-10-22T09:50:00.000Z', cancelled: true },
        { date: '2027-10-29', startLocal: '2027-10-29T18:50', startAt: '2027-10-29T07:50:00.000Z', endAt: '2027-10-29T09:50:00.000Z', cancelled: false },
    ],
};

function at320(ui: React.ReactElement) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}>{ui}</div>);
}

function Fields({ start, end = '', initial = 'never' as RepeatChoiceKey, initialUntil = '', kept = null }: { start: string; end?: string; initial?: RepeatChoiceKey; initialUntil?: string; kept?: KeptRepeat | null }) {
    const [repeat, setRepeat] = useState<RepeatChoiceKey>(initial);
    const [until, setUntil] = useState(initialUntil);
    return <EventRepeatFields start={start} end={end} repeat={repeat} until={until} onRepeatChange={setRepeat} onUntilChange={setUntil} kept={kept} />;
}

/** Every button's accessible name starts with the words it shows (WCAG 2.5.3, label in name). */
function expectLabelInName(buttons: HTMLElement[]) {
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
        const shown = (b.textContent ?? '').trim();
        const name = b.getAttribute('aria-label') ?? shown;
        expect(shown).not.toBe('');
        expect(name.startsWith(shown), `"${name}" starts with "${shown}"`).toBe(true);
    }
}

afterEach(() => { document.documentElement.style.fontSize = ''; });

describe('the form: Repeats and Until', () => {
    it('offers the choices of the first date, in the words core gives both apps', () => {
        at320(<Fields start="2026-10-16T20:50" />);
        const options = within(screen.getByTestId('event-repeat-select')).getAllByRole('option').map(o => o.textContent);
        expect(options).toEqual(['Does not repeat', 'Every week on Friday', 'Every 2 weeks on Friday', 'Every month on the 16th', 'Every month on the third Friday']);
        expect(screen.queryByTestId('event-repeat-until')).not.toBeInTheDocument();
    });

    it('the last Friday, and Until once it repeats, bounded by the first date and five years', () => {
        at320(<Fields start="2026-10-30T20:50" />);
        const select = screen.getByTestId('event-repeat-select');
        expect(within(select).getByRole('option', { name: 'Every month on the last Friday' })).toBeInTheDocument();
        fireEvent.change(select, { target: { value: 'weekly' } });
        const until = screen.getByTestId('event-repeat-until') as HTMLInputElement;
        expect(until.min).toBe('2026-10-30');
        expect(until.max).toBe('2031-10-30');
        expect(screen.getByText('Blank: it repeats until you cancel it.')).toBeInTheDocument();
        fireEvent.change(until, { target: { value: '2026-10-29' } });
        expect(screen.getByTestId('event-repeat-until-problem')).toHaveTextContent('The last date must be a date on or after the first one');
    });

    it('monthly on the 31st says which months are skipped', () => {
        at320(<Fields start="2026-10-31T10:00" initial="monthly-day" />);
        expect(screen.getByTestId('event-repeat-note')).toHaveTextContent('(months without a 31st are skipped)');
    });

    it('a choice the new first date does not offer stays chosen and says so', () => {
        at320(<Fields start="2026-10-16T20:50" initial="monthly-last" />);
        expect(screen.getByTestId('event-repeat-problem')).toHaveTextContent('Choose how the event repeats from the list');
        expect(eventRepeatProblem('2026-10-16T20:50', 'monthly-last', '')).toBe('repeat');
        expect(eventRepeatProblem('2026-10-30T20:50', 'monthly-last', '')).toBeNull();
        expect(eventRepeatProblem('2026-10-30T20:50', 'weekly', '2032-01-01')).toBe('until');
    });

    it("a date as long as the gap to the next is said before Save, in the node's sentence (review of #1993, N7)", () => {
        at320(<Fields start="2026-10-16T20:50" end="2026-10-23T20:50" initial="weekly" />);
        expect(screen.getByTestId('event-repeat-length-problem')).toHaveTextContent('An event that repeats must end before its next date starts');
        expect(eventRepeatProblem('2026-10-16T20:50', 'weekly', '', '2026-10-23T20:50')).toBe('length');
        expect(eventRepeatProblem('2026-10-16T20:50', 'weekly', '', '2026-10-23T20:49')).toBeNull();
        expect(eventRepeatProblem('2026-10-16T20:50', 'monthly-day', '', '2026-11-13T20:50')).toBe('length');
        expect(eventRepeatProblem('2026-10-16T20:50', 'monthly-day', '', '')).toBeNull();
        fireEvent.change(screen.getByTestId('event-repeat-select'), { target: { value: 'monthly-day' } });
        expect(screen.queryByTestId('event-repeat-length-problem')).not.toBeInTheDocument();
    });
});

describe('a rule the form cannot make: every 3 weeks, every 3 months (review of #1993, N3)', () => {
    const threeWeekly = { ...series, eventRepeat: { freq: 'weekly', interval: 3, byDay: 'FR', time: '18:50', minutes: 120 } };
    const quarterly = { ...series, eventRepeat: { freq: 'monthly', interval: 3, byMonthDay: 15, time: '18:50', minutes: 120 } };

    it('the card says it as it is', () => {
        at320(<EventCard post={quarterly} identity={identity} />);
        expect(screen.getByTestId('event-repeat-caption')).toHaveTextContent('↻ Every 3 months on the 15th');
    });

    it('the form reads it as none of its choices and asks', () => {
        expect(eventEditForm(threeWeekly).repeat).toBe('other');
        expect(eventEditForm(quarterly).repeat).toBe('other');
        at320(<Fields start="2027-10-15T18:50" initial="other" />);
        expect(screen.getByTestId('event-repeat-problem')).toHaveTextContent('Choose how the event repeats from the list');
    });

    it('on its own date the form names the kept rule in a plain line, with Until; red only once the date moves (confirmation of #1993, NB1)', () => {
        const before = eventEditForm({ ...quarterly, eventRepeatUntil: '2028-12-15' });
        const kept = { repeat: before.repeat!, firstDate: before.start.slice(0, 10), rule: before.repeatRule };
        const view = at320(<Fields start={before.start} end={before.end} initial="other" initialUntil="2028-12-15" kept={kept} />);
        expect(screen.getByTestId('event-repeat-kept')).toHaveTextContent('Every 3 months on the 15th — kept unless you choose another');
        expect(screen.getByTestId('event-repeat-kept')).not.toHaveAttribute('role');
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByTestId('event-repeat-problem')).toBeNull();
        const select = screen.getByTestId('event-repeat-select') as HTMLSelectElement;
        expect(select.className).not.toContain('border-red-400');
        expect(select.selectedOptions[0]?.textContent).toBe('Every 3 months on the 15th');
        expect((screen.getByTestId('event-repeat-until') as HTMLInputElement).value).toBe('2028-12-15');
        // Its Until is still checked: past five years it is said, and the form won't save it.
        expect(eventRepeatProblem(before.start, 'other', '2033-01-01', before.end, kept)).toBe('until');
        expect(eventRepeatProblem(before.start, 'other', '2028-12-15', before.end, kept)).toBeNull();
        // The date moved a week on: now it asks, in red.
        view.rerender(<div style={{ width: 320 }}><Fields start="2027-10-22T18:50" end="2027-10-22T20:50" initial="other" initialUntil="2028-12-15" kept={kept} /></div>);
        expect(screen.queryByTestId('event-repeat-kept')).toBeNull();
        expect(screen.getByTestId('event-repeat-problem')).toHaveTextContent('Choose how the event repeats from the list');
        expect(screen.getByRole('alert')).toBe(screen.getByTestId('event-repeat-problem'));
        expect((screen.getByTestId('event-repeat-select') as HTMLSelectElement).className).toContain('border-red-400');
    });

    it('editing the date keeps the rule or asks: never re-sends a different one', () => {
        for (const post of [threeWeekly, quarterly]) {
            const before = eventEditForm(post);
            const kept = { repeat: before.repeat!, firstDate: before.start.slice(0, 10) };
            // A title fix: nothing about the series goes, so the node keeps it.
            expect(eventEditPayload(before, { ...before, title: 'Dinner' })).toEqual({ title: 'Dinner' });
            expect(eventRepeatProblem(before.start, 'other', '', before.end, kept)).toBeNull();
            // The date moved a week on: the form asks for a choice, and what it would send still names no rule.
            const moved = { ...before, start: '2027-10-22T18:50', end: '2027-10-22T20:50' };
            expect(eventRepeatProblem(moved.start, 'other', '', moved.end, kept)).toBe('repeat');
            const out = eventEditPayload(before, moved);
            expect('eventRepeat' in out).toBe(false);
            expect(out.eventStartLocal).toBe('2027-10-22T18:50');
            // Choosing from the list sends that choice, on purpose.
            expect(eventEditPayload(before, { ...moved, repeat: 'weekly' }).eventRepeat).toEqual({ freq: 'weekly', interval: 1, byDay: 'FR' });
        }
    });
});

describe('what create and edit send', () => {
    it('create: the pattern from the first date, and Until only when set', () => {
        expect(eventRepeatCreate('never', '2026-10-16T20:50', '')).toEqual({});
        expect(eventRepeatCreate('weekly', '2026-10-16T20:50', '')).toEqual({ eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR' } });
        expect(eventRepeatCreate('monthly-nth', '2026-10-16T20:50', '2026-12-18')).toEqual({
            eventRepeat: { freq: 'monthly', interval: 1, byDay: 'FR', pos: 3 }, eventRepeatUntil: '2026-12-18',
        });
    });

    it('edit: the form reads the rule back; an unchanged series sends nothing about it', () => {
        const before = eventEditForm(series);
        expect(before.repeat).toBe('weekly');
        expect(before.repeatUntil).toBe('');
        expect(eventEditPayload(before, { ...before, title: 'Friday dinner!' })).toEqual({ title: 'Friday dinner!' });
    });

    it('edit: moved to a Saturday, the series goes as every Saturday (what the select then says)', () => {
        const before = eventEditForm(series);
        const out = eventEditPayload(before, { ...before, start: '2027-10-16T18:50', end: '2027-10-16T20:50' });
        expect(out.eventRepeat).toEqual({ freq: 'weekly', interval: 1, byDay: 'SA' });
    });

    it('edit: Does not repeat sends null; a new Until sends it; a cleared Until sends null', () => {
        const before = eventEditForm({ ...series, eventRepeatUntil: '2027-12-17' });
        expect(eventEditPayload(before, { ...before, repeat: 'never' }).eventRepeat).toBeNull();
        expect(eventEditPayload(before, { ...before, repeatUntil: '2027-12-24' }).eventRepeatUntil).toBe('2027-12-24');
        expect(eventEditPayload(before, { ...before, repeatUntil: '' }).eventRepeatUntil).toBeNull();
    });

    it('Change this date only: the copy is asked for with a mark, and gets the moved-from line on top', () => {
        expect(parseCopyEventContext(movedCopyContext('ev-s'))).toEqual({ id: 'ev-s', moved: true });
        expect(parseCopyEventContext('ev-s')).toEqual({ id: 'ev-s', moved: false });
        expect(withMovedFromLine('Moved from the regular Friday', 'Bring a plate')).toBe('Moved from the regular Friday\n\nBring a plate');
        expect(withMovedFromLine('Moved from the regular Friday', '')).toBe('Moved from the regular Friday');
    });
});

describe('the ↻ caption: card, map popup (the same card) and Home', () => {
    it('the card shows the next date and the caption under it', () => {
        at320(<EventCard post={series} identity={identity} />);
        expect(screen.getByTestId('event-repeat-caption')).toHaveTextContent('↻ Every Friday');
        expect(screen.getByTestId('event-repeat-caption').className).toMatch(/break-words/);
    });

    it('with a last date', () => {
        at320(<EventCard post={{ ...series, eventRepeatUntil: '2027-12-17' }} identity={identity} />);
        expect(screen.getByTestId('event-repeat-caption')).toHaveTextContent('↻ Every Friday · until 17 Dec 2027');
    });

    it('a one-off has none', () => {
        at320(<EventCard post={{ ...series, eventRepeat: undefined, eventNextDates: undefined }} identity={identity} />);
        expect(screen.queryByTestId('event-repeat-caption')).not.toBeInTheDocument();
    });

    it("Your events shows the caption from the node's row (review of #1993, N5)", () => {
        const row = { postId: 'ev-s', title: 'Friday dinner', startAt: series.eventStartAt, endAt: series.eventEndAt, placeName: 'Bangalow Hall',
            rsvp: 'going' as const, photo: null, reminderOffsets: null, startLocal: series.eventStartLocal, endLocal: series.eventEndLocal, tz: series.eventTz,
            repeat: { freq: 'weekly' as const, interval: 1, byDay: 'FR' as const }, repeatUntil: '2027-12-17' };
        at320(<EventCard post={myEventAsPost(row)} identity={identity} />);
        expect(screen.getByTestId('event-repeat-caption')).toHaveTextContent('↻ Every Friday · until 17 Dec 2027');
        const oneOff = { ...row, repeat: undefined, repeatUntil: undefined };
        expect(myEventAsPost(oneOff).eventRepeat).toBeUndefined();
    });

    it('Home reads the pattern the node sends', () => {
        expect(homeEventRepeats({ repeat: { freq: 'monthly', interval: 1, byDay: 'FR', pos: -1 } })).toBe('Monthly, last Friday');
        expect(homeEventRepeats({})).toBe('');
    });
});

describe('the detail: Next dates', () => {
    beforeEach(() => { vi.mocked(api.setEventDateCancelled).mockReset(); });

    it('a member sees the dates, the cancelled one marked, and no host controls', () => {
        at320(<EventDetail post={series} identity={{ ...identity, publicKey: 'me-pk' }} />);
        const list = screen.getByTestId('event-next-dates');
        const dates = within(list).getAllByTestId('event-next-date');
        expect(dates.map(d => d.textContent)).toEqual(['Fri 15 Oct', 'Fri 22 OctCancelled', 'Fri 29 Oct']);
        expect(within(list).queryByTestId('event-date-cancel')).not.toBeInTheDocument();
        expect(within(list).queryByTestId('event-date-restore')).not.toBeInTheDocument();
    });

    it('the host cancels the current date: POST skip, and the page says what the node told those going', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const rolled = rolledView;
        vi.mocked(api.setEventDateCancelled).mockResolvedValue({ success: true, post: rolled, skips: ['2027-10-15', '2027-10-22'] });
        const onChange = vi.fn();
        at320(<EventDetail post={hostView} identity={identity} onChange={onChange} />);
        fireEvent.click(screen.getAllByTestId('event-date-cancel')[0]);
        await waitFor(() => expect(api.setEventDateCancelled).toHaveBeenCalledWith('ev-s', '2027-10-15', true));
        expect(await screen.findByTestId('event-date-cancelled-line')).toHaveTextContent('Fri 15 Oct is cancelled. Next: Fri 29 Oct');
        expect(onChange).toHaveBeenCalledWith(rolled);
    });

    it('the host brings a cancelled date back: DELETE skip', async () => {
        vi.mocked(api.setEventDateCancelled).mockResolvedValue({ success: true, post: hostView, skips: [] });
        at320(<EventDetail post={hostView} identity={identity} />);
        fireEvent.click(screen.getByTestId('event-date-restore'));
        await waitFor(() => expect(api.setEventDateCancelled).toHaveBeenCalledWith('ev-s', '2027-10-22', false));
    });

    it('each host control is named from the words it shows (WCAG 2.5.3; review of #1993, N1)', () => {
        at320(<EventDetail post={hostView} identity={identity} onChangeThisDateOnly={() => {}} />);
        const list = screen.getByTestId('event-next-dates');
        expectLabelInName([...within(list).getAllByTestId('event-date-cancel'), ...within(list).getAllByTestId('event-date-move'), within(list).getByTestId('event-date-restore')]);
        expect(within(list).getAllByTestId('event-date-cancel')[0]).toHaveAccessibleName('Cancel this date: Fri 15 Oct');
        expect(within(list).getAllByTestId('event-date-move')[0]).toHaveAccessibleName('Change this date only: Fri 15 Oct');
        expect(within(list).getByTestId('event-date-restore')).toHaveAccessibleName('Bring it back: Fri 22 Oct');
    });

    it(`the cancelled current date can be brought back from the node's list: DELETE skip, and "… is back on" (review of #1993, N2)`, async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.mocked(api.setEventDateCancelled).mockResolvedValueOnce({ success: true, post: rolledView, skips: ['2027-10-15', '2027-10-22'] });
        vi.mocked(api.setEventDateCancelled).mockResolvedValueOnce({ success: true, post: hostView, skips: ['2027-10-22'] });
        at320(<EventDetail post={hostView} identity={identity} />);
        fireEvent.click(screen.getAllByTestId('event-date-cancel')[0]);
        expect(await screen.findByTestId('event-date-cancelled-line')).toHaveTextContent('Fri 15 Oct is cancelled. Next: Fri 29 Oct');
        // One Bring it back per date, on the list: the line only says what happened.
        const back = screen.getByRole('button', { name: 'Bring it back: Fri 15 Oct' });
        expect(screen.getAllByRole('button', { name: 'Bring it back: Fri 15 Oct' })).toHaveLength(1);
        expectLabelInName([back]);
        fireEvent.click(back);
        await waitFor(() => expect(api.setEventDateCancelled).toHaveBeenLastCalledWith('ev-s', '2027-10-15', false));
        await waitFor(() => expect(screen.getByTestId('event-date-cancelled-line')).toHaveTextContent('Fri 15 Oct is back on'));
        expect(screen.queryByRole('button', { name: 'Bring it back: Fri 15 Oct' })).not.toBeInTheDocument();
    });

    it("after a reload Bring it back is still there, from the node's list alone (confirmation 2 of #1993, NB2)", async () => {
        vi.mocked(api.setEventDateCancelled).mockResolvedValue({ success: true, post: hostView, skips: ['2027-10-22'] });
        at320(<EventDetail post={rolledView} identity={identity} />);
        const list = screen.getByTestId('event-next-dates');
        expect(within(list).getAllByTestId('event-next-date').map(d => d.textContent)).toEqual([
            'Fri 15 OctCancelledBring it back', 'Fri 22 OctCancelledBring it back', 'Fri 29 OctCancel this date',
        ]);
        fireEvent.click(within(list).getByRole('button', { name: 'Bring it back: Fri 15 Oct' }));
        await waitFor(() => expect(api.setEventDateCancelled).toHaveBeenCalledWith('ev-s', '2027-10-15', false));
        expect(await screen.findByTestId('event-date-cancelled-line')).toHaveTextContent('Fri 15 Oct is back on');
    });

    it('a member sees the passed cancelled date marked, with no control', () => {
        // A member's read carries no RSVP list (the host's view does).
        at320(<EventDetail post={{ ...rolledView, eventRsvps: undefined }} identity={{ ...identity, publicKey: 'me-pk' }} />);
        const list = screen.getByTestId('event-next-dates');
        expect(within(list).getAllByTestId('event-next-date').map(d => d.textContent)).toEqual(['Fri 15 OctCancelled', 'Fri 22 OctCancelled', 'Fri 29 Oct']);
        expect(within(list).queryByRole('button')).not.toBeInTheDocument();
    });

    it('a passed cancelled date leaves the list at its end; the line stays', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const end = Date.parse(rolledView.eventNextDates[0].endAt);
        const now = vi.spyOn(Date, 'now').mockReturnValue(end - 1000);
        try {
            vi.mocked(api.setEventDateCancelled).mockResolvedValue({ success: true, post: rolledView, skips: ['2027-10-15', '2027-10-22'] });
            at320(<EventDetail post={hostView} identity={identity} />);
            fireEvent.click(screen.getAllByTestId('event-date-cancel')[0]);
            expect(await screen.findByRole('button', { name: 'Bring it back: Fri 15 Oct' })).toBeInTheDocument();
            now.mockReturnValue(end + 1000);
            await waitFor(() => expect(screen.queryByRole('button', { name: 'Bring it back: Fri 15 Oct' })).not.toBeInTheDocument(), { timeout: 3000 });
            expect(screen.getAllByTestId('event-next-date').map(d => d.textContent?.slice(0, 10))).toEqual(['Fri 22 Oct', 'Fri 29 Oct']);
            expect(screen.getByTestId('event-date-cancelled-line')).toHaveTextContent('Fri 15 Oct is cancelled. Next: Fri 29 Oct');
        } finally {
            now.mockRestore();
        }
    });

    it("an older node's list (no ends) shows as it is", () => {
        const old = rolledView.eventNextDates.map((d: { date: string; startLocal: string; startAt: string; cancelled: boolean }) => ({ date: d.date, startLocal: d.startLocal, startAt: d.startAt, cancelled: d.cancelled }));
        expect(seriesDatesShown(old, '2027-10-29', Date.parse('2030-01-01T00:00:00Z'))).toEqual(old);
        expect(seriesDatesShown(rolledView.eventNextDates, '2027-10-29', Date.parse('2027-10-15T10:00:00Z')).map(d => d.date)).toEqual(['2027-10-22', '2027-10-29']);
    });

    it("the node's refusal shows in its own words", async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.mocked(api.setEventDateCancelled).mockRejectedValue(new Error('This is the last date: change when the event ends, or cancel the event'));
        at320(<EventDetail post={hostView} identity={identity} />);
        fireEvent.click(screen.getAllByTestId('event-date-cancel')[1]);
        expect(await screen.findByTestId('event-next-dates-problem')).toHaveTextContent('This is the last date: change when the event ends, or cancel the event');
    });

    it('Change this date only: cancels the date, then opens the copy for it', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.mocked(api.setEventDateCancelled).mockResolvedValue({ success: true, post: hostView, skips: ['2027-10-29'] });
        const onMove = vi.fn();
        at320(<EventDetail post={hostView} identity={identity} onChangeThisDateOnly={onMove} />);
        fireEvent.click(screen.getAllByTestId('event-date-move')[1]);
        await waitFor(() => expect(onMove).toHaveBeenCalledWith(hostView, '2027-10-29'));
        expect(api.setEventDateCancelled).toHaveBeenCalledWith('ev-s', '2027-10-29', true);
    });

    it('a one-off has no Next dates', () => {
        at320(<EventDetail post={{ ...series, eventRepeat: undefined, eventNextDates: undefined }} identity={identity} />);
        expect(screen.queryByTestId('event-next-dates')).not.toBeInTheDocument();
    });
});
