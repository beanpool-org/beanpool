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
        getMyEvents: vi.fn(async () => []),
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
        // The Market's card: the chip, my answer as text, and no buttons.
        const market = render(<EventCard post={event} identity={identity} onOpen={vi.fn()} viewMode="list" />);
        expect(bracketed()).toBeGreaterThan(2);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByTestId('event-type-chip').textContent).toBe(xx('EVENT'));
        expect(screen.getByTestId('event-my-answer').textContent).toBe(xx('{label} ✓').replace('{label}', xx('Going')));
        expect(screen.queryByRole('button', { pressed: true })).toBeNull();
        market.unmount();

        // Nobody's answer but the counts, once someone has answered.
        const counts = render(<EventCard post={{ ...event, myRsvp: null }} identity={identity} onOpen={vi.fn()} viewMode="list" />);
        expect(screen.getByText(xx('{going} going · {interested} interested').replace('{going}', '7').replace('{interested}', '3'))).toBeInTheDocument();
        counts.unmount();

        // The map's preview card: the buttons and the counts.
        const { unmount } = render(<EventCard post={event} identity={identity} onOpen={vi.fn()} rsvpOnCard />);
        expect(bracketed()).toBeGreaterThan(2);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByRole('button', { pressed: true }).textContent).toBe(xx('{label} ✓').replace('{label}', xx('Going')));
        expect(screen.getByText(xx('{going} going · {interested} interested').replace('{going}', '7').replace('{interested}', '3'))).toBeInTheDocument();
        unmount();

        render(<EventCard post={{ ...event, eventState: 'cancelled', status: 'cancelled' }} identity={identity} viewMode="list" />);
        expect(screen.getByTestId('event-state-badge').textContent).toBe(xx('CANCELLED'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    // W3': the grid's tile (DESIGN-grid-event-rows-fable.md): the chip, the pills, the mark, the date and the time, the lock's
    // sentence as its pill's name, "Online", a copy's "from {community}" and the reader's "your time", each through t().
    it('the grid tile: EVENT, the pills and the mark, the rows, the lock, Online, a copy and "your time"', async () => {
        await showIn('xx');
        const pinned = { pinnedAt: new Date().toISOString(), pinnedUntil: new Date(Date.now() + 3 * 24 * HOUR).toISOString() };
        const pin = render(<EventCard post={{ ...event, ...pinned }} identity={identity} onOpen={vi.fn()} />);
        expect(screen.getByTestId('event-pinned-chip').textContent).toBe(xx('📌 PINNED'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        pin.unmount();

        // A group-only event (never pinned: only a public one can be).
        const grid = render(<EventCard post={{ ...hosted, myRsvp: 'going', eventRsvps: undefined, eventState: 'updated', targetGroupId: 'g-1' }} identity={identity} onOpen={vi.fn()} />);
        expect(bracketed()).toBeGreaterThan(3);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByTestId('event-type-chip').textContent).toBe(xx('EVENT'));
        expect(screen.getByTestId('event-state-badge').textContent).toBe(xx('UPDATED'));
        expect(screen.getByTestId('event-mark').textContent).toBe(xx('{label} ✓').replace('{label}', xx('Going')));
        expect(screen.getByTestId('event-lock-pill').getAttribute('aria-label')).toBe(xx('🔒 Only {group} can see this').replace('{group}', 'Garden Club'));
        grid.unmount();

        const online = render(<EventCard post={{ ...event, eventOnline: true, eventPlaceName: undefined }} identity={identity} />);
        expect(screen.getByTestId('grid-row-4').textContent).toBe(`🌐 ${xx('Online')}`);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        online.unmount();

        const from = { host: 'mullum.example.org', postId: 'home-1', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' };
        const copy = render(<EventCard post={{ ...event, myRsvp: null, shownCopy: true, shownFrom: from } as any} identity={identity} />);
        expect(screen.getByTestId('grid-row-4').textContent).toBe(xx('from {community}').replace('{community}', 'Mullumbimby'));
        expect(bypassing(document.body, { others: [...OTHERS, 'Mullumbimby'] })).toEqual([]);
        copy.unmount();

        // Read across a zone line (the place's clock is Sydney's, the reader's is not): the tile says whose clock it shows.
        const savedTz = process.env.TZ;
        process.env.TZ = 'Australia/Brisbane';
        try {
            render(<EventCard post={{ ...event, eventStartAt: '2030-11-09T05:00:00.000Z', eventEndAt: '2030-11-09T10:00:00.000Z', eventStartLocal: '2030-11-09T16:00', eventEndLocal: '2030-11-09T21:00', eventTz: 'Australia/Sydney' }} identity={identity} />);
            expect(screen.getByTestId('event-your-time').textContent).toBe(xx('{time} your time').replace('{time}', '🕒'));
            expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        } finally {
            if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
        }
    });

    it("an attendee's page: the host line, the note, Share and Add to calendar, the chat entry", async () => {
        await showIn('xx');
        render(<EventDetail post={event} identity={identity} onShowOnMap={vi.fn()} onOpenChat={vi.fn()} />);
        await waitFor(() => expect(api.getMyEvents).toHaveBeenCalled());
        await screen.findByTestId('event-reminder');
        expect(bracketed()).toBeGreaterThan(8);
        // The "Remind me" row's choice line is lib/event-extras.ts's, held to its words by EventExtras.words.test.tsx.
        expect(bypassing(document.body, { others: [...OTHERS, '1 day before (your default)'] })).toEqual([]);
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
        // The Market's card: one button, my answer in its label and as text, the chip.
        const market = render(<EventCard post={event} identity={identity} onOpen={vi.fn()} viewMode="list" />);
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('button', { name: 'Open event: Working bee at the hall, Going ✓' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Going ✓' })).toBeNull();
        expect(screen.getByTestId('event-my-answer').textContent).toBe('Going ✓');
        expect(screen.getByTestId('event-type-chip').textContent).toBe('EVENT');
        market.unmount();

        // The map's preview card keeps its two buttons and the counts.
        const { unmount } = render(<EventCard post={event} identity={identity} onOpen={vi.fn()} rsvpOnCard />);
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('button', { name: 'Open event: Working bee at the hall' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Going ✓' })).toBeInTheDocument();
        expect(screen.getByText('7 going · 3 interested')).toBeInTheDocument();
        unmount();

        render(<EventDetail post={hosted} identity={identity} onEdit={vi.fn()} />);
        // The host is the box a listing's "Posted by" is (components/AuthorCard.tsx); a group-only event says who can see it under it.
        // The box is the label above the button that opens the host: the button's parent holds both.
        await waitFor(() => expect(within(screen.getByTestId('event-host-open').parentElement!).getByText('Hosted by')).toBeInTheDocument());
        expect(within(screen.getByTestId('event-host-open')).getByText('Hazel')).toBeInTheDocument();
        expect(screen.getByTestId('event-host-audience').textContent).toBe('🔒 Only Garden Club can see this');
        expect(bracketed()).toBe(0);
        expect(screen.getByText("You're hosting this event")).toBeInTheDocument();
        expect(screen.getByText("Who's going")).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Edit event' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel event' })).toBeInTheDocument();
    });
});
