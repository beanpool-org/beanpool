import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventCard, EventDetail } from './EventCard';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, rsvpEvent: vi.fn(), removeMarketplacePost: vi.fn() };
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
            expect(b.className).toContain('flex-1');
            expect(b.className).toContain('min-w-0');
        }
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
        expect(await screen.findByText('👥 6 going · 4 interested')).toBeInTheDocument();
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
