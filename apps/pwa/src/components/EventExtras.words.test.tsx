/**
 * Share, Add to calendar and Remind me on an event, in the member's language (words S3, web sweep W1): the buttons,
 * the lines they say, the reminder picker and its errors through t(). What is shared and saved (the text, the .ics,
 * the offsets sent) is unchanged.
 *
 * The reminder's current choice ("1 day before (your default)") and each tick's span ("1 day") are written by
 * lib/event-extras.ts, which this sweep does not own (SettingsPage shares it): its line is pinned below as the one
 * English left on this screen, so the sweep of that file sees it go.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EventReminder, EventShareAndCalendar } from './EventExtras';
import * as api from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getMyEvents: vi.fn(async () => []),
        setEventReminder: vi.fn(),
        getNotificationPreferences: vi.fn(async () => ({})),
        getNodeApiUrl: () => 'https://mullum.beanpool.org',
    };
});

const start = new Date(2030, 8, 28, 9, 0).getTime();
const event: any = {
    id: 'ev-1', type: 'event', title: 'Working bee at the hall', description: 'Clearing the back garden',
    authorPublicKey: 'host-pk', authorCallsign: 'Hazel', status: 'active', eventState: 'scheduled',
    eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 3 * 3600 * 1000).toISOString(),
    eventPlaceName: 'Bindarrabi Hall', myRsvp: 'going',
};
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

/** lib/event-extras.ts's English: the reminder's current choice (see the note above). */
const LIB_CHOICE = 'text: "1 day before (your default)"';

beforeEach(() => {
    vi.mocked(api.setEventReminder).mockReset().mockRejectedValue(new Error(''));
    delete (navigator as any).share;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true, writable: true });
});
afterEach(() => { cleanup(); backToEnglish(); });

describe('Share, Add to calendar and Remind me in the pseudo-locale', () => {
    it('the buttons and the line Share says: every word came through t()', async () => {
        await showIn('xx');
        render(<EventShareAndCalendar post={event} />);
        expect(bracketed()).toBeGreaterThan(1);
        expect(bypassing(document.body)).toEqual([]);
        fireEvent.click(screen.getByTestId('event-share'));
        expect(await screen.findByTestId('event-share-note')).toHaveTextContent(xx('Link copied.'));
        expect(bypassing(document.body)).toEqual([]);
    });

    it('Remind me, its picker and a failed save', async () => {
        await showIn('xx');
        render(<EventReminder post={event} identity={identity} myRsvp="going" />);
        await screen.findByTestId('event-reminder');
        expect(bypassing(document.body)).toEqual([LIB_CHOICE]);

        fireEvent.click(screen.getByTestId('event-reminder-change'));
        expect(screen.getByText(xx('Tell me before it starts'))).toBeInTheDocument();
        expect(screen.getByText(xx('With none ticked you get no reminder for this event.'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(5);
        fireEvent.click(screen.getByTestId('event-reminder-save'));
        expect(await screen.findByRole('alert')).toHaveTextContent(xx('Could not save your reminder.'));
        expect(bypassing(document.body)).toEqual([LIB_CHOICE]);
    });
});

describe('Share, Add to calendar and Remind me in English', () => {
    it('in English nothing is bracketed, and the words are as they were', async () => {
        render(<><EventShareAndCalendar post={event} /><EventReminder post={event} identity={identity} myRsvp="going" /></>);
        const reminder = await screen.findByTestId('event-reminder');
        expect(bracketed()).toBe(0);
        expect(screen.getByTestId('event-share').textContent).toBe('🔗 Share');
        expect(screen.getByTestId('event-add-to-calendar').textContent).toBe('📅 Add to calendar');
        expect(reminder.querySelector('p')!.textContent).toBe('⏰ Remind me: 1 day before (your default)');
        fireEvent.click(screen.getByTestId('event-reminder-change'));
        expect(screen.getByLabelText('1 day before')).toBeInTheDocument();
        expect(screen.getByTestId('event-reminder-save').textContent).toBe('Save for this event');
        expect(screen.getByTestId('event-reminder-change').textContent).toBe('Close');
    });
});
