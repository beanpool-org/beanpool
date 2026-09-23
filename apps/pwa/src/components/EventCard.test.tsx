import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventCard, EventDetail } from './EventCard';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, rsvpEvent: vi.fn(), removeMarketplacePost: vi.fn(), getMarketplacePosts: vi.fn(async () => []) };
});

const HOUR = 60 * 60 * 1000;
const start = new Date(2030, 8, 28, 9, 0).getTime(); // SAT 28 SEP 2030, local time

const baseEvent: any = {
    id: 'ev-1', type: 'event', category: 'community', title: 'Working bee at the hall — bring gloves, hats and a long-handled shovel',
    description: 'Clearing the back garden', credits: 0, priceType: 'fixed', authorPublicKey: 'host-pk', authorCallsign: 'Hazel',
    createdAt: new Date().toISOString(), active: true, status: 'active', repeatable: false, lat: -28.55, lng: 153.5,
    eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 3 * HOUR).toISOString(),
    eventPlaceName: 'Bindarrabi Hall', eventState: 'scheduled', goingCount: 7, interestedCount: 3, myRsvp: 'going',
};
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

/** The floor the design holds to: a 320px-wide card. jsdom does no layout, so the layout contract is the classes. */
function renderAt320(ui: React.ReactElement) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}>{ui}</div>);
}

describe('EventCard at 320px (docs/events-on-the-map.md §3)', () => {
    beforeEach(() => { vi.mocked(api.rsvpEvent).mockReset(); });
    afterEach(() => { document.documentElement.style.fontSize = ''; });

    it('leads with the date and time in the largest text, then title, place and distance, counts', () => {
        renderAt320(<EventCard post={baseEvent} identity={identity} distanceKm={2.4} />);
        const card = screen.getByTestId('event-card');
        const lines = within(card).getByRole('button', { name: /Open event/ }).querySelectorAll(':scope > span');
        expect(lines[0].textContent).toBe('SAT 28 SEP ·9:00–12:00');
        expect(screen.getByTestId('event-when').getAttribute('aria-label')).toBe('SAT 28 SEP · 9:00–12:00');
        expect(lines[0].className).toMatch(/flex-wrap/);
        expect(lines[1].textContent).toBe(baseEvent.title);
        expect(lines[2].textContent).toBe('📍 Bindarrabi Hall · 2.4 km');
        expect(lines[3].textContent).toBe('👥 7 going · 3 interested');

        const when = screen.getByTestId('event-when');
        // The time is never cut off: day and time are whole pieces, in the largest text, that wrap onto a
        // second line if they must.
        expect(Array.from(when.children).map(c => [c.textContent, /whitespace-nowrap/.test(c.className), /text-lg/.test(c.className)])).toEqual([
            ['SAT 28 SEP ·', true, true], ['9:00–12:00', true, true],
        ]);
        // Every other row gives way before the card does: nothing may push it past 320px.
        for (const line of Array.from(lines).slice(1)) expect((line as HTMLElement).className).toMatch(/truncate/);
        expect(card.className).toMatch(/min-w-0/);
        expect(card.className).toMatch(/overflow-hidden/);
    });

    it('shows my status on the filled button, with 48px targets that share the row', () => {
        renderAt320(<EventCard post={baseEvent} identity={identity} />);
        const going = screen.getByRole('button', { name: 'Going ✓' });
        const interested = screen.getByRole('button', { name: 'Interested' });
        expect(going).toHaveAttribute('aria-pressed', 'true');
        expect(interested).toHaveAttribute('aria-pressed', 'false');
        for (const b of [going, interested]) {
            expect(b.className).toContain('min-h-[48px]');
            // They share the row by *growing* into it, never by shrinking below their own label: `min-w-0`
            // here is what split "Intereste / d" (Marty, 2026-09-24). See the wrapping test below.
            expect(b.className).toContain('grow');
            expect(b.className).not.toContain('min-w-0');
        }
    });

    /**
     * Marty, 2026-09-24: on the 5-column desktop Market grid the button read "Intereste / d". jsdom does no
     * layout, so the contract is the classes: nothing may give the label permission to break inside a word, the
     * button may not shrink below that label, and the row wraps so a button that no longer fits beside its
     * neighbour takes a full-width row instead of being squeezed.
     */
    it.each([
        ['the card', (p: any) => <EventCard post={p} identity={identity} />],
        ['the event page', (p: any) => <EventDetail post={p} identity={identity} />],
    ])('never lets a button label break mid-word, and wraps the row instead — %s', (_where, ui) => {
        renderAt320(ui(baseEvent));
        const going = screen.getByRole('button', { name: 'Going ✓' });
        const interested = screen.getByRole('button', { name: 'Interested' });

        for (const b of [going, interested]) {
            // No mid-word break permission of any kind.
            expect(b.className).not.toMatch(/break-words|break-all|anywhere/);
            // The label stays on one line, and the button is at least as wide as that label.
            expect(b.className).toContain('whitespace-nowrap');
            expect(b.className).toContain('min-w-fit');
            expect(b.className).toContain('basis-auto');
            expect(b.className).not.toContain('min-w-0');
        }

        // Too narrow for both side by side => Interested drops to its own full-width row.
        const row = interested.parentElement!;
        expect(row).toBe(going.parentElement);
        expect(row.className).toMatch(/flex-wrap/);
    });

    it('does not show the host name on the card', () => {
        renderAt320(<EventCard post={baseEvent} identity={identity} />);
        expect(screen.queryByText(/Hazel/)).not.toBeInTheDocument();
    });

    it('one tap RSVPs, and the counts follow the node', async () => {
        vi.mocked(api.rsvpEvent).mockResolvedValueOnce({ success: true, post: { ...baseEvent, myRsvp: 'interested', goingCount: 6, interestedCount: 4 } });
        const onRsvpChange = vi.fn();
        renderAt320(<EventCard post={baseEvent} identity={identity} onRsvpChange={onRsvpChange} />);
        fireEvent.click(screen.getByRole('button', { name: 'Interested' }));
        await waitFor(() => expect(api.rsvpEvent).toHaveBeenCalledWith('ev-1', 'interested'));
        expect(await screen.findByText(/6 going · 4 interested/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Interested ✓' })).toHaveAttribute('aria-pressed', 'true');
        expect(onRsvpChange).toHaveBeenCalled();
    });

    it('tapping my current status again is "not going"', async () => {
        vi.mocked(api.rsvpEvent).mockResolvedValueOnce({ success: true, post: { ...baseEvent, myRsvp: null, goingCount: 6 } });
        renderAt320(<EventCard post={baseEvent} identity={identity} />);
        fireEvent.click(screen.getByRole('button', { name: 'Going ✓' }));
        await waitFor(() => expect(api.rsvpEvent).toHaveBeenCalledWith('ev-1', null));
        expect(await screen.findByRole('button', { name: 'Going' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('marks UPDATED and CANCELLED on the first line; a cancelled event cannot be RSVPd', () => {
        const { unmount } = renderAt320(<EventCard post={{ ...baseEvent, eventState: 'updated' }} identity={identity} />);
        expect(screen.getByTestId('event-state-badge')).toHaveTextContent('UPDATED');
        // On the first line with the date, as one more piece of the wrapping row, so it never covers the time.
        expect(screen.getByTestId('event-state-badge').parentElement).toBe(screen.getByTestId('event-when').parentElement);
        unmount();
        renderAt320(<EventCard post={{ ...baseEvent, eventState: 'cancelled' }} identity={identity} />);
        expect(screen.getByTestId('event-state-badge')).toHaveTextContent('CANCELLED');
        expect(screen.getByRole('button', { name: 'Going ✓' })).toBeDisabled();
    });

    it('a viewer with no identity cannot RSVP', () => {
        renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null }} identity={null} />);
        expect(screen.getByRole('button', { name: 'Going' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Interested' })).toBeDisabled();
    });

    it('hides decorative emojis from screen readers with aria-hidden="true"', () => {
        const { container } = renderAt320(<EventCard post={baseEvent} identity={identity} distanceKm={2.4} />);
        const hiddenEmojis = container.querySelectorAll('[aria-hidden="true"]');
        const hiddenTexts = Array.from(hiddenEmojis).map(e => e.textContent?.trim());
        expect(hiddenTexts).toContain('📍');
        expect(hiddenTexts).toContain('👥');
    });
});

describe("The event's photo on the card (Damo, 2026-09-23)", () => {
    const withPhoto: any = { ...baseEvent, photos: ['/uploads/working-bee.jpg', '/uploads/second.jpg'] };

    it('shows the first photo, with the title as its alt text', () => {
        renderAt320(<EventCard post={withPhoto} identity={identity} distanceKm={2.4} />);
        const img = within(screen.getByTestId('event-card')).getByRole('img');
        expect(img).toHaveAttribute('src', '/uploads/working-bee.jpg');
        expect(img).toHaveAttribute('alt', baseEvent.title);
    });

    it('shows no photo at all when the event has none, and the card reads as it always did', () => {
        renderAt320(<EventCard post={baseEvent} identity={identity} distanceKm={2.4} />);
        const card = screen.getByTestId('event-card');
        expect(within(card).queryByRole('img')).toBeNull();
        const lines = within(card).getByRole('button', { name: /Open event/ }).querySelectorAll(':scope > span');
        expect(lines[0].textContent).toBe('SAT 28 SEP ·9:00–12:00');
        expect(lines[1].textContent).toBe(baseEvent.title);
    });

    it('treats an empty photo list as no photo', () => {
        renderAt320(<EventCard post={{ ...baseEvent, photos: [] }} identity={identity} />);
        expect(within(screen.getByTestId('event-card')).queryByRole('img')).toBeNull();
    });

    // Decision 3: the photo lives inside the tap target that opens the event. It must not become a second one —
    // an offer card's photo opens a lightbox, and a second target here would put two answers under one thumb.
    it('is inside the card’s one tap target, not a second one', () => {
        renderAt320(<EventCard post={withPhoto} identity={identity} onOpen={() => {}} />);
        const card = screen.getByTestId('event-card');
        const open = within(card).getByRole('button', { name: /Open event/ });
        const img = within(card).getByRole('img');
        expect(open.contains(img)).toBe(true);
        expect(img.closest('button')).toBe(open);
        expect(within(card).queryByRole('button', { name: /photo/i })).toBeNull();
    });

    // Decision 1: an event should sit among the offers, so the photo takes the same size, crop and rounding the
    // offer card uses in that view — MarketplaceCard's 110px banner in the grid, its 64px square in the list.
    it('matches the offer card: a banner in the grid, a square thumbnail in the list', () => {
        const { unmount } = renderAt320(<EventCard post={withPhoto} identity={identity} />);
        const grid = within(screen.getByTestId('event-card')).getByRole('img');
        expect(grid.className).toMatch(/h-\[110px\]/);
        expect(grid.className).toMatch(/w-full/);
        expect(grid.className).toMatch(/object-cover/);
        expect(grid.className).toMatch(/rounded-xl/);
        unmount();

        renderAt320(<EventCard post={withPhoto} identity={identity} viewMode="list" />);
        const list = within(screen.getByTestId('event-card')).getByRole('img');
        expect(list.className).toMatch(/w-16/);
        expect(list.className).toMatch(/h-16/);
        expect(list.className).toMatch(/object-cover/);
        expect(list.className).toMatch(/rounded-xl/);
        expect(list.className).toMatch(/flex-shrink-0/);
    });

    // Decision 1 again, in the one view where matching the offer card means showing nothing: MarketplaceCard's
    // compact branch is a condensed row with no photo at all, built to double the listings on screen. A thumbnail
    // only the event had would make it the odd card out again, in the view with the least room for it.
    it('shows no photo in the compact view, where the offer cards beside it have none either', () => {
        renderAt320(<EventCard post={withPhoto} identity={identity} viewMode="compact" />);
        const card = screen.getByTestId('event-card');
        expect(within(card).queryByRole('img')).toBeNull();
        // And the lines stay the stack they have always been, not a column beside an empty gap.
        const lines = within(card).getByRole('button', { name: /Open event/ }).querySelectorAll(':scope > span');
        expect(lines[0].textContent).toBe('SAT 28 SEP ·9:00–12:00');
        expect(lines[1].textContent).toBe(baseEvent.title);
    });

    // Decision 4: at 320px with 1.3× text the photo gives way before the card does, and the RSVP row keeps the
    // card's full width under it rather than being squeezed into the column beside the thumbnail.
    it('holds at 320px: the photo cannot push the card wider, and the RSVP row keeps its own row', () => {
        renderAt320(<EventCard post={withPhoto} identity={identity} viewMode="list" />);
        const card = screen.getByTestId('event-card');
        expect(card.className).toMatch(/overflow-hidden/);
        const img = within(card).getByRole('img');
        const going = screen.getByRole('button', { name: 'Going ✓' });
        expect(going.className).toContain('min-h-[48px]');
        // The RSVP buttons are siblings of the row that holds the photo, never inside it.
        expect(img.parentElement?.contains(going)).toBe(false);
    });
});

describe('EventDetail', () => {
    beforeEach(() => {
        vi.mocked(api.rsvpEvent).mockReset();
        vi.mocked(api.removeMarketplacePost).mockReset();
    });

    it('keeps the private note hidden until the viewer taps Going, then shows it', async () => {
        const notGoing = { ...baseEvent, myRsvp: null, goingCount: 6 };
        vi.mocked(api.rsvpEvent).mockResolvedValueOnce({ success: true, post: { ...baseEvent, eventPrivateNote: 'Gate code 1234' } });
        render(<EventDetail post={notGoing} identity={identity} />);
        expect(screen.queryByTestId('event-private-note')).not.toBeInTheDocument();
        expect(screen.queryByText(/Gate code/)).not.toBeInTheDocument();
        expect(screen.getByText(/shows here once you tap Going/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Going' }));
        await waitFor(() => expect(api.rsvpEvent).toHaveBeenCalledWith('ev-1', 'going'));
        expect(await screen.findByTestId('event-private-note')).toHaveTextContent('Gate code 1234');
    });

    it('shows the host line, but not the host panel, to an attendee', () => {
        render(<EventDetail post={{ ...baseEvent, eventPrivateNote: 'Gate code 1234' }} identity={identity} />);
        expect(screen.getByText('Hazel')).toBeInTheDocument();
        expect(screen.getByTestId('event-private-note')).toBeInTheDocument();
        expect(screen.queryByTestId('event-host-panel')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Cancel event' })).not.toBeInTheDocument();
    });

    it("gives the host who's going and Cancel event", async () => {
        const hosted = {
            ...baseEvent, myRsvp: null, eventPrivateNote: 'Gate code 1234',
            eventRsvps: [
                { memberPubkey: 'a', memberCallsign: 'Ari', status: 'interested', updatedAt: '' },
                { memberPubkey: 'b', memberCallsign: 'Bo', status: 'going', updatedAt: '' },
            ],
        };
        vi.mocked(api.removeMarketplacePost).mockResolvedValueOnce({ success: true });
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const onCancelled = vi.fn();
        render(<EventDetail post={hosted} identity={identity} onCancelled={onCancelled} />);
        const panel = screen.getByTestId('event-host-panel');
        const rows = within(panel).getAllByRole('listitem').map(li => li.textContent);
        expect(rows).toEqual(['BoGoing', 'AriInterested']);
        fireEvent.click(within(panel).getByRole('button', { name: 'Cancel event' }));
        await waitFor(() => expect(api.removeMarketplacePost).toHaveBeenCalledWith('ev-1', 'host-pk'));
        expect(onCancelled).toHaveBeenCalled();
        confirm.mockRestore();
    });

    it('offers Show on map for a pinned event', () => {
        const onShowOnMap = vi.fn();
        render(<EventDetail post={baseEvent} identity={identity} onShowOnMap={onShowOnMap} />);
        fireEvent.click(screen.getByRole('button', { name: 'Show on map' }));
        expect(onShowOnMap).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev-1' }));
    });
});

describe('Copy to a new date (docs/events-on-the-map.md §3, slice 5)', () => {
    const hosted: any = {
        ...baseEvent, myRsvp: null, eventPrivateNote: 'Gate code 1234',
        eventRsvps: [{ memberPubkey: 'b', memberCallsign: 'Bo', status: 'going', updatedAt: '' }],
    };

    it('is offered to the host, next to Cancel event', () => {
        const onCopy = vi.fn();
        render(<EventDetail post={hosted} identity={identity} onCopyToNewDate={onCopy} />);
        const panel = screen.getByTestId('event-host-panel');
        fireEvent.click(within(panel).getByTestId('event-copy-to-new-date'));
        expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev-1' }));
    });

    it('is offered on an event that has already finished — which is when a host wants it', () => {
        const finished = { ...hosted, eventStartAt: new Date(2020, 0, 1, 9).toISOString(), eventEndAt: new Date(2020, 0, 1, 11).toISOString() };
        render(<EventDetail post={finished} identity={identity} onCopyToNewDate={vi.fn()} />);
        const panel = screen.getByTestId('event-host-panel');
        expect(within(panel).getByTestId('event-copy-to-new-date')).toBeTruthy();
        // Cancel is gone once it is over; Copy is not.
        expect(within(panel).queryByRole('button', { name: 'Cancel event' })).toBeNull();
    });

    it('is not offered to anyone but the host', () => {
        render(<EventDetail post={baseEvent} identity={identity} onCopyToNewDate={vi.fn()} />);
        expect(screen.queryByTestId('event-copy-to-new-date')).toBeNull();
    });

    it('keeps a 48px target and does not overflow at 320px', () => {
        renderAt320(<EventDetail post={hosted} identity={identity} onCopyToNewDate={vi.fn()} />);
        const btn = screen.getByTestId('event-copy-to-new-date');
        expect(btn.className).toMatch(/min-h-\[48px\]/);
    });
});

describe('Events round 2: the host (A1, A3, A4, B4)', () => {
    const hosted: any = {
        ...baseEvent, myRsvp: null, eventPrivateNote: 'Gate code 1234',
        eventRsvps: [{ memberPubkey: 'b', memberCallsign: 'Bo', status: 'going', updatedAt: '' }],
    };
    beforeEach(() => {
        vi.mocked(api.removeMarketplacePost).mockReset();
        vi.mocked(api.getMarketplacePosts).mockReset();
        vi.mocked(api.getMarketplacePosts).mockResolvedValue([]);
    });

    it('does not show Going / Interested to the host on the card or the page (B4)', () => {
        const { unmount } = render(<EventCard post={hosted} identity={identity} />);
        expect(screen.queryByRole('button', { name: 'Going' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Interested' })).toBeNull();
        expect(screen.getByTestId('event-hosting')).toHaveTextContent("You're hosting this event");
        unmount();
        render(<EventDetail post={hosted} identity={identity} />);
        expect(screen.queryByRole('button', { name: 'Going' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Interested' })).toBeNull();
        expect(screen.getByTestId('event-hosting')).toBeInTheDocument();
    });

    it('still shows Going / Interested to everyone else', () => {
        render(<EventCard post={baseEvent} identity={identity} />);
        expect(screen.getByRole('button', { name: /Going/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Interested/ })).toBeInTheDocument();
        expect(screen.queryByTestId('event-hosting')).toBeNull();
    });

    it('offers Edit event to the host of an open event, as a 48px target (A1)', () => {
        const onEdit = vi.fn();
        renderAt320(<EventDetail post={hosted} identity={identity} onEdit={onEdit} />);
        const btn = within(screen.getByTestId('event-host-panel')).getByRole('button', { name: 'Edit event' });
        expect(btn.className).toMatch(/min-h-\[48px\]/);
        fireEvent.click(btn);
        expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev-1' }));
    });

    it('does not offer Edit to anyone but the host', () => {
        render(<EventDetail post={baseEvent} identity={identity} onEdit={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Edit event' })).toBeNull();
        expect(screen.queryByTestId('event-edit-blocked')).toBeNull();
    });

    it('says plainly that an ended event cannot be edited, instead of a button that would fail (A3)', () => {
        const ended = { ...hosted, eventStartAt: new Date(2020, 0, 1, 9).toISOString(), eventEndAt: new Date(2020, 0, 1, 11).toISOString() };
        render(<EventDetail post={ended} identity={identity} onEdit={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Edit event' })).toBeNull();
        expect(screen.getByTestId('event-edit-blocked')).toHaveTextContent('This event has ended, so it can no longer be edited.');
    });

    it('says plainly that a cancelled event cannot be edited (A3)', () => {
        const cancelled = { ...hosted, status: 'cancelled', eventState: 'cancelled', active: false };
        render(<EventDetail post={cancelled} identity={identity} onEdit={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Edit event' })).toBeNull();
        expect(screen.getByTestId('event-edit-blocked')).toHaveTextContent('This event was cancelled, so it can no longer be edited.');
    });

    it('after cancelling, the host stays on the event page and sees it CANCELLED (A4)', async () => {
        const nowCancelled = { ...hosted, status: 'cancelled', eventState: 'cancelled', active: false };
        vi.mocked(api.removeMarketplacePost).mockResolvedValueOnce({ success: true });
        vi.mocked(api.getMarketplacePosts).mockResolvedValueOnce([nowCancelled]);
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const onCancelled = vi.fn();
        render(<EventDetail post={hosted} identity={identity} onCancelled={onCancelled} onEdit={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel event' }));
        await waitFor(() => expect(onCancelled).toHaveBeenCalledWith(nowCancelled));
        expect(api.getMarketplacePosts).toHaveBeenCalledWith({ id: 'ev-1', types: 'offer,need,poll,event' });
        expect(screen.getByTestId('event-detail')).toBeInTheDocument();
        expect(screen.getAllByTestId('event-state-badge')[0]).toHaveTextContent('CANCELLED');
        expect(screen.queryByRole('button', { name: 'Cancel event' })).toBeNull();
        expect(screen.getByTestId('event-edit-blocked')).toBeInTheDocument();
        confirm.mockRestore();
    });

    it('marks it CANCELLED on the page even when the re-read fails (offline)', async () => {
        vi.mocked(api.removeMarketplacePost).mockResolvedValueOnce({ success: true });
        vi.mocked(api.getMarketplacePosts).mockRejectedValueOnce(new Error('offline'));
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        render(<EventDetail post={hosted} identity={identity} />);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel event' }));
        await waitFor(() => expect(screen.getAllByTestId('event-state-badge')[0]).toHaveTextContent('CANCELLED'));
        confirm.mockRestore();
    });
});
