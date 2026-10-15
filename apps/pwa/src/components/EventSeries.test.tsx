/**
 * Repeating events on the web (scratch/global-node/DESIGN-event-times-fable.md §3, §4, §8; slice 5): the form's Repeats and
 * Until, what create and edit send, the ↻ caption on the card and Home, and the detail's Next dates with the host's Cancel
 * this date / Bring it back / Change this date only (the node mocked). At 320px with text at 130%.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import type { RepeatChoiceKey } from '@beanpool/core';
import { EventCard, EventDetail } from './EventCard';
import { EventRepeatFields, eventRepeatProblem } from './EventRepeatFields';
import * as api from '../lib/api';
import {
    eventEditForm, eventEditPayload, eventRepeatCreate, movedCopyContext, parseCopyEventContext, withMovedFromLine,
} from '../lib/events';
import { homeEventRepeats } from '../lib/home-cards';

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

function at320(ui: React.ReactElement) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}>{ui}</div>);
}

function Fields({ start, initial = 'never' as RepeatChoiceKey, initialUntil = '' }: { start: string; initial?: RepeatChoiceKey; initialUntil?: string }) {
    const [repeat, setRepeat] = useState<RepeatChoiceKey>(initial);
    const [until, setUntil] = useState(initialUntil);
    return <EventRepeatFields start={start} repeat={repeat} until={until} onRepeatChange={setRepeat} onUntilChange={setUntil} />;
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
        expect(screen.getByTestId('event-repeat-caption')).toHaveTextContent('↻ Every Friday · until 17 Dec');
    });

    it('a one-off has none', () => {
        at320(<EventCard post={{ ...series, eventRepeat: undefined, eventNextDates: undefined }} identity={identity} />);
        expect(screen.queryByTestId('event-repeat-caption')).not.toBeInTheDocument();
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
        const rolled = { ...hostView, eventStartLocal: '2027-10-29T18:50', eventStartAt: '2027-10-29T07:50:00.000Z', eventNextDates: hostView.eventNextDates.slice(2) };
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
