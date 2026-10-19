/**
 * An event's card and page in the member's language (words S3, web sweep W1): the RSVP buttons, the badges, the counts,
 * the host line and the host's panel through t(), with the phone's keys where it has them ("{label} ✓", "CANCELLED"
 * in the 'event' context, "{going} going · {interested} interested"). The event's title, place, note and the members'
 * names are theirs. What is SENT is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EventCard, EventDetail } from './EventCard';
import * as api from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        rsvpEvent: vi.fn(),
        removeMarketplacePost: vi.fn(async () => ({ success: true })),
        getMarketplacePosts: vi.fn(async () => []),
        // An older node: no "Remind me" row here (its choice is written by lib/event-extras.ts, EventExtras.words.test.tsx).
        getMyEvents: vi.fn(async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); }),
        getNotificationPreferences: vi.fn(async () => ({})),
    };
});

const HOUR = 60 * 60 * 1000;
const start = new Date(2030, 8, 28, 9, 0).getTime(); // SAT 28 SEP 2030, the reader's own clock: no second time line
const event: any = {
    id: 'ev-1', type: 'event', category: 'community', title: 'Working bee at the hall', description: 'Clearing the back garden',
    credits: 0, priceType: 'fixed', authorPublicKey: 'host-pk', authorCallsign: 'Hazel', createdAt: new Date().toISOString(),
    active: true, status: 'active', repeatable: false, lat: -28.55, lng: 153.5,
    eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 3 * HOUR).toISOString(),
    eventPlaceName: 'Bindarrabi Hall', eventState: 'scheduled', goingCount: 7, interestedCount: 3, myRsvp: 'going',
    eventPrivateNote: 'Gate code 1234',
};
const hosted: any = {
    ...event, myRsvp: null, audienceScope: 'group', targetGroupName: 'Garden Club',
    eventRsvps: [
        { memberPubkey: 'a', memberCallsign: 'Ari', status: 'interested', updatedAt: '' },
        { memberPubkey: 'b', memberCallsign: 'Bo', status: 'going', updatedAt: '' },
    ],
};
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

/** What members wrote: the event's title, place, description and note, the group's name, and the members' names. */
const OTHERS = ['Working bee at the hall', 'Bindarrabi Hall', 'Clearing the back garden', 'Gate code 1234', 'Garden Club', 'Hazel', 'Ari', 'Bo'];

beforeEach(() => { vi.mocked(api.rsvpEvent).mockReset(); });
afterEach(() => { cleanup(); backToEnglish(); vi.restoreAllMocks(); });

describe('an event in the pseudo-locale', () => {
    it('the card: the time, the counts and Going ✓ / Interested; a cancelled one', async () => {
        await showIn('xx');
        const { unmount } = render(<EventCard post={event} identity={identity} onOpen={vi.fn()} />);
        expect(bracketed()).toBeGreaterThan(2);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByRole('button', { pressed: true }).textContent).toBe(xx('{label} ✓').replace('{label}', xx('Going')));
        expect(screen.getByText(xx('{going} going · {interested} interested').replace('{going}', '7').replace('{interested}', '3'))).toBeInTheDocument();
        unmount();

        render(<EventCard post={{ ...event, eventState: 'cancelled', status: 'cancelled' }} identity={identity} />);
        expect(screen.getByTestId('event-state-badge').textContent).toBe(xx('CANCELLED'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it("an attendee's page: the host line, the note, Share and Add to calendar, the chat entry", async () => {
        await showIn('xx');
        render(<EventDetail post={event} identity={identity} onShowOnMap={vi.fn()} onOpenChat={vi.fn()} />);
        await waitFor(() => expect(api.getMyEvents).toHaveBeenCalled());
        await waitFor(() => expect(screen.queryByTestId('event-reminder')).toBeNull());
        expect(bracketed()).toBeGreaterThan(8);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByText(xx('Note for people who are going'))).toBeInTheDocument();
        expect(screen.getByTestId('event-open-chat')).toHaveTextContent(xx('Open event chat'));
    });

    it("the host's page: who's going, the host's buttons, and the question before cancelling", async () => {
        await showIn('xx');
        const said: string[] = [];
        vi.spyOn(window, 'confirm').mockImplementation((q) => { said.push(String(q)); return true; });
        render(<EventDetail post={hosted} identity={identity} onEdit={vi.fn()} onCopyToNewDate={vi.fn()} />);
        const panel = screen.getByTestId('event-host-panel');
        expect(within(panel).getAllByRole('listitem').map((li) => li.textContent)).toEqual([`Bo${xx('Going')}`, `Ari${xx('Interested')}`]);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        fireEvent.click(within(panel).getByRole('button', { name: xx('Cancel event') }));
        await waitFor(() => expect(api.removeMarketplacePost).toHaveBeenCalledWith('ev-1', 'host-pk'));
        expect(said).toEqual([xx('Cancel this event? Everyone will see it as cancelled.')]);
        expect(await screen.findAllByText(xx('CANCELLED'))).not.toHaveLength(0);
        expect(screen.getByTestId('event-edit-blocked').textContent).toBe(xx('This event was cancelled, so it can no longer be edited.'));
        expect(bypassing(document.body, { others: OTHERS, said })).toEqual([]);
    });
});

describe('an event in English', () => {
    it('in English nothing is bracketed, and the words are as they were', async () => {
        const { unmount } = render(<EventCard post={event} identity={identity} onOpen={vi.fn()} />);
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('button', { name: 'Open event: Working bee at the hall' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Going ✓' })).toBeInTheDocument();
        expect(screen.getByText('7 going · 3 interested')).toBeInTheDocument();
        unmount();

        render(<EventDetail post={hosted} identity={identity} onEdit={vi.fn()} />);
        await waitFor(() => expect(screen.getByText('Hazel').closest('p')!.textContent).toBe('Hosted by Hazel · for Garden Club only'));
        expect(bracketed()).toBe(0);
        expect(screen.getByText("You're hosting this event")).toBeInTheDocument();
        expect(screen.getByText("Who's going")).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Edit event' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel event' })).toBeInTheDocument();
    });
});
