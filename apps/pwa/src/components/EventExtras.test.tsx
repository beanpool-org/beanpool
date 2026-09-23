import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventDetail } from './EventCard';
import { YourEvents } from './YourEvents';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        rsvpEvent: vi.fn(),
        removeMarketplacePost: vi.fn(),
        getMarketplacePosts: vi.fn(async () => []),
        getMyEvents: vi.fn(async () => []),
        setEventReminder: vi.fn(async () => ({ success: true })),
        getNotificationPreferences: vi.fn(async () => ({})),
        getNodeApiUrl: () => 'https://mullum.beanpool.org',
    };
});

const HOUR = 60 * 60 * 1000;
const start = new Date(2030, 8, 28, 9, 0).getTime(); // SAT 28 SEP 2030, local time
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

const event: any = {
    id: 'ev-1', type: 'event', category: 'community', title: 'Working bee at the hall',
    description: 'Clearing the back garden', credits: 0, priceType: 'fixed', authorPublicKey: 'host-pk',
    authorCallsign: 'Hazel', createdAt: new Date().toISOString(), active: true, status: 'active',
    repeatable: false, lat: -28.55, lng: 153.5,
    eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 3 * HOUR).toISOString(),
    eventPlaceName: 'Bindarrabi Hall', eventState: 'scheduled', goingCount: 7, interestedCount: 3, myRsvp: 'going',
};

const mine = (over: Partial<api.MyEvent> = {}): any => ({
    postId: 'ev-1', title: 'Working bee at the hall', startAt: new Date(start).toISOString(),
    endAt: new Date(start + 3 * HOUR).toISOString(), placeName: 'Bindarrabi Hall', rsvp: 'going',
    photo: null, reminderOffsets: null, ...over,
});

/** What the node throws for a route it does not have — an older community. */
function notFound(): Error {
    const e = new Error('Not Found');
    (e as Error & { status?: number }).status = 404;
    return e;
}

beforeEach(() => {
    vi.mocked(api.getMyEvents).mockReset().mockResolvedValue([]);
    vi.mocked(api.setEventReminder).mockReset().mockResolvedValue({ success: true } as any);
    vi.mocked(api.getNotificationPreferences).mockReset().mockResolvedValue({} as any);
});

describe('"Your events" (decision 1)', () => {
    it('renders the node’s list, soonest first, on the event card', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([
            mine({ postId: 'ev-later', title: 'Seed swap', startAt: new Date(start + 48 * HOUR).toISOString(), rsvp: 'interested' }),
            mine(),
        ]);
        render(<YourEvents identity={identity} />);

        const row = await screen.findByTestId('your-events');
        expect(within(row).getByRole('heading', { name: 'Your events' })).toBeInTheDocument();
        const cards = within(row).getAllByTestId('event-card');
        expect(cards).toHaveLength(2);
        expect(within(cards[0]).getByRole('button', { name: /Open event/ }).textContent).toContain('Working bee at the hall');
        expect(within(cards[1]).getByRole('button', { name: /Open event/ }).textContent).toContain('Seed swap');
        // The viewer's own RSVP is on the filled button, from the row the node sent.
        expect(within(cards[0]).getByRole('button', { name: 'Going ✓' })).toHaveAttribute('aria-pressed', 'true');
        expect(within(cards[1]).getByRole('button', { name: 'Interested ✓' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('never claims nobody is going: this route carries no counts, so the card leaves the line out', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([mine()]);
        render(<YourEvents identity={identity} />);
        const row = await screen.findByTestId('your-events');
        expect(within(row).queryByText(/going ·/)).toBeNull();
        expect(within(row).queryByText(/0 going/)).toBeNull();
    });

    it('is not there at all when you have nothing coming up', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([]);
        render(<YourEvents identity={identity} />);
        await waitFor(() => expect(api.getMyEvents).toHaveBeenCalled());
        expect(screen.queryByTestId('your-events')).toBeNull();
    });

    it('hides itself quietly on a node that has no such route (decision 7)', async () => {
        vi.mocked(api.getMyEvents).mockRejectedValue(notFound());
        render(<YourEvents identity={identity} />);
        await waitFor(() => expect(api.getMyEvents).toHaveBeenCalled());
        expect(screen.queryByTestId('your-events')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says nothing when the node cannot be reached either', async () => {
        vi.mocked(api.getMyEvents).mockRejectedValue(new Error('Failed to fetch'));
        render(<YourEvents identity={identity} />);
        await waitFor(() => expect(api.getMyEvents).toHaveBeenCalled());
        expect(screen.queryByTestId('your-events')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('opens the event it was tapped on', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([mine()]);
        const onOpen = vi.fn();
        render(<YourEvents identity={identity} onOpen={onOpen} />);
        const row = await screen.findByTestId('your-events');
        fireEvent.click(within(row).getByRole('button', { name: /Open event/ }));
        expect(onOpen).toHaveBeenCalledWith('ev-1');
    });
});

describe('"Remind me" on an event (decision 2)', () => {
    it('reads the member’s default while they have chosen nothing for this event', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([mine({ reminderOffsets: null })]);
        vi.mocked(api.getNotificationPreferences).mockResolvedValue({ eventReminderOffsets: [120] } as any);
        render(<EventDetail post={event} identity={identity} />);
        await waitFor(() => expect(screen.getByTestId('event-reminder-current').textContent).toBe('2 hours before (your default)'));
    });

    it('reads this event’s own choice when there is one', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([mine({ reminderOffsets: [10080, 60] })]);
        render(<EventDetail post={event} identity={identity} />);
        await waitFor(() => expect(screen.getByTestId('event-reminder-current').textContent).toBe('1 week and 1 hour before'));
    });

    it('sends the override for this event only', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([mine({ reminderOffsets: null })]);
        render(<EventDetail post={event} identity={identity} />);
        await screen.findByTestId('event-reminder');

        fireEvent.click(screen.getByTestId('event-reminder-change'));
        fireEvent.click(screen.getByLabelText('1 day before'));   // the default, off again
        fireEvent.click(screen.getByLabelText('2 hours before'));
        fireEvent.click(screen.getByTestId('event-reminder-save'));

        await waitFor(() => expect(api.setEventReminder).toHaveBeenCalledWith('ev-1', [120]));
        await waitFor(() => expect(screen.getByTestId('event-reminder-current').textContent).toBe('2 hours before'));
    });

    it('saves an empty list when every tick is cleared — no reminder for this one', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([mine({ reminderOffsets: [1440] })]);
        render(<EventDetail post={event} identity={identity} />);
        await screen.findByTestId('event-reminder');

        fireEvent.click(screen.getByTestId('event-reminder-change'));
        fireEvent.click(screen.getByLabelText('1 day before'));
        fireEvent.click(screen.getByTestId('event-reminder-save'));

        await waitFor(() => expect(api.setEventReminder).toHaveBeenCalledWith('ev-1', []));
        await waitFor(() => expect(screen.getByTestId('event-reminder-current').textContent).toBe('Off'));
    });

    it('sends null to hand the event back to the member’s default', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([mine({ reminderOffsets: [30] })]);
        render(<EventDetail post={event} identity={identity} />);
        await waitFor(() => expect(screen.getByTestId('event-reminder-current').textContent).toBe('30 minutes before'));

        fireEvent.click(screen.getByTestId('event-reminder-change'));
        fireEvent.click(screen.getByTestId('event-reminder-reset'));

        await waitFor(() => expect(api.setEventReminder).toHaveBeenCalledWith('ev-1', null));
        await waitFor(() => expect(screen.getByTestId('event-reminder-current').textContent).toBe('1 day before (your default)'));
    });

    it('offers no reset while the event is already on the member’s default', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([mine({ reminderOffsets: null })]);
        render(<EventDetail post={event} identity={identity} />);
        await screen.findByTestId('event-reminder');
        fireEvent.click(screen.getByTestId('event-reminder-change'));
        expect(screen.queryByTestId('event-reminder-reset')).toBeNull();
    });

    it('is not offered without an RSVP, nor to the host on their own event', async () => {
        const { unmount } = render(<EventDetail post={{ ...event, myRsvp: null }} identity={identity} />);
        await waitFor(() => expect(screen.queryByTestId('event-reminder')).toBeNull());
        unmount();

        render(<EventDetail post={{ ...event, myRsvp: null, eventRsvps: [] }} identity={identity} />);
        expect(screen.getByTestId('event-hosting')).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByTestId('event-reminder')).toBeNull());
    });

    it('disappears on a node that has no such route, rather than showing an error (decision 7)', async () => {
        vi.mocked(api.getMyEvents).mockRejectedValue(notFound());
        render(<EventDetail post={event} identity={identity} />);
        await waitFor(() => expect(api.getMyEvents).toHaveBeenCalled());
        expect(screen.queryByTestId('event-reminder')).toBeNull();
    });

    it('takes itself away if the save is the thing that finds the older node', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([mine({ reminderOffsets: null })]);
        vi.mocked(api.setEventReminder).mockRejectedValue(notFound());
        render(<EventDetail post={event} identity={identity} />);
        await screen.findByTestId('event-reminder');
        fireEvent.click(screen.getByTestId('event-reminder-change'));
        fireEvent.click(screen.getByTestId('event-reminder-save'));
        await waitFor(() => expect(screen.queryByTestId('event-reminder')).toBeNull());
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says so when a save fails for any other reason', async () => {
        vi.mocked(api.getMyEvents).mockResolvedValue([mine({ reminderOffsets: null })]);
        vi.mocked(api.setEventReminder).mockRejectedValue(new Error('You are not going to this event.'));
        render(<EventDetail post={event} identity={identity} />);
        await screen.findByTestId('event-reminder');
        fireEvent.click(screen.getByTestId('event-reminder-change'));
        fireEvent.click(screen.getByTestId('event-reminder-save'));
        expect(await screen.findByRole('alert')).toHaveTextContent('You are not going to this event.');
    });
});

describe('Share and Add to calendar (decisions 3 and 4)', () => {
    const LINK = 'https://mullum.beanpool.org/?post=ev-1';
    const TEXT = `Working bee at the hall\nSAT 28 SEP · 9:00–12:00\nBindarrabi Hall\n${LINK}`;

    it('hands the title, when, where and the link to the share sheet', async () => {
        const share = vi.fn(async () => {});
        Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
        render(<EventDetail post={event} identity={identity} />);
        fireEvent.click(screen.getByTestId('event-share'));
        await waitFor(() => expect(share).toHaveBeenCalledWith({ title: 'Working bee at the hall', text: TEXT, url: LINK }));
        delete (navigator as any).share;
    });

    it('copies the same text and says so where there is no share sheet', async () => {
        delete (navigator as any).share;
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
        render(<EventDetail post={event} identity={identity} />);
        fireEvent.click(screen.getByTestId('event-share'));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(TEXT));
        expect(await screen.findByTestId('event-share-note')).toHaveTextContent('Link copied.');
    });

    it('says nothing when the member closes the share sheet without sending it', async () => {
        const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
        Object.defineProperty(navigator, 'share', { value: vi.fn(async () => { throw abort; }), configurable: true, writable: true });
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
        render(<EventDetail post={event} identity={identity} />);
        fireEvent.click(screen.getByTestId('event-share'));
        await waitFor(() => expect((navigator as any).share).toHaveBeenCalled());
        expect(writeText).not.toHaveBeenCalled();
        expect(screen.queryByTestId('event-share-note')).toBeNull();
        delete (navigator as any).share;
    });

    it('downloads a calendar file named after the event', async () => {
        const created: Blob[] = [];
        Object.defineProperty(URL, 'createObjectURL', { value: (b: Blob) => { created.push(b); return 'blob:ics'; }, configurable: true, writable: true });
        Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });
        const clicks: HTMLAnchorElement[] = [];
        const realClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () { clicks.push(this as HTMLAnchorElement); };

        render(<EventDetail post={event} identity={identity} />);
        fireEvent.click(screen.getByTestId('event-add-to-calendar'));

        expect(clicks).toHaveLength(1);
        expect(clicks[0].download).toBe('working-bee-at-the-hall.ics');
        expect(created[0].type).toBe('text/calendar;charset=utf-8');
        const ics = await created[0].text();
        expect(ics).toContain('BEGIN:VEVENT');
        expect(ics).toContain('UID:ev-1@mullum.beanpool.org');
        expect(ics).toContain('SUMMARY:Working bee at the hall');
        expect(ics).toContain(`URL:${LINK}`);
        expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);

        HTMLAnchorElement.prototype.click = realClick;
    });

    it('offers both to a member with no RSVP — you do not have to be going to pass it on', () => {
        render(<EventDetail post={{ ...event, myRsvp: null }} identity={identity} />);
        expect(screen.getByTestId('event-share')).toBeInTheDocument();
        expect(screen.getByTestId('event-add-to-calendar')).toBeInTheDocument();
    });
});
