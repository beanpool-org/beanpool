/**
 * Where anyone can join in a minute (features.openMembership, the global node), an event says its spot is the host's to
 * give (scratch/global-node/DESIGN-global-member-privacy-fable.md §4, Marty's call 1, 15 Oct 2026), on the web, at 320px
 * with text at 130%, as EventHostLetsIn.test.tsx draws the event: "Shown to about 1 km. Ask <name> for the spot when you
 * arrange to meet." for a member not going and one still waiting; never the person let in, the host, or a local
 * community. It wraps (break-words) and has its own colour in the light and the dark theme.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventDetail } from './EventCard';

const info = vi.hoisted(() => ({ features: { openMembership: true } as Record<string, unknown> }));
vi.mock('../lib/visitor-lobby-gate', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../lib/visitor-lobby-gate');
    return { ...actual, communityInfoOnce: vi.fn(async () => ({ features: info.features })) };
});
vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, rsvpEvent: vi.fn(), removeMarketplacePost: vi.fn(), getMarketplacePosts: vi.fn(async () => []), letInToEvent: vi.fn(), getEventChat: vi.fn() };
});

const HOUR = 60 * 60 * 1000;
const start = Date.now() + 48 * HOUR;
const ev: any = {
    id: 'ev-1', type: 'event', category: 'community', title: 'Garden dinner', description: 'Bring a plate', credits: 0, priceType: 'fixed',
    authorPublicKey: 'host-pk', authorCallsign: 'Hana', createdAt: new Date().toISOString(), active: true, status: 'active', repeatable: false,
    lat: -28.65, lng: 153.56, eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 2 * HOUR).toISOString(),
    eventPlaceName: 'Bangalow Hall', eventState: 'scheduled', goingCount: 3, interestedCount: 1, eventHostLetsIn: true,
};
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
const LINE = 'Shown to about 1 km. Ask Hana for the spot when you arrange to meet.';

function renderAt320(ui: React.ReactElement) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}>{ui}</div>);
}

describe("an event's spot where anyone can join (320px, 130%)", () => {
    afterEach(() => { document.documentElement.style.fontSize = ''; info.features = { openMembership: true }; });

    it('a member not going is told the spot is the host\'s to give; the line wraps, light and dark', async () => {
        renderAt320(<EventDetail post={{ ...ev, myRsvp: null, myLetIn: null }} identity={identity} onOpenChat={() => {}} />);
        const line = await screen.findByTestId('rough-place-line');
        expect(line).toHaveTextContent(LINE);
        expect(line.className).toMatch(/break-words/);
        expect(line.className).toMatch(/(^|\s)text-nature-600(\s|$)/);
        expect(line.className).toMatch(/(^|\s)dark:text-nature-300(\s|$)/);
    });
    it('and so is one Going but still waiting', async () => {
        renderAt320(<EventDetail post={{ ...ev, myRsvp: 'going', myLetIn: false }} identity={identity} onOpenChat={() => {}} />);
        expect(await screen.findByTestId('rough-place-line')).toHaveTextContent(LINE);
    });
    it('never the person let in, the host, or a local community', async () => {
        const { rerender } = renderAt320(<EventDetail post={{ ...ev, myRsvp: 'going', myLetIn: true, eventPrivateNote: 'Blue gate' }} identity={identity} onOpenChat={() => {}} />);
        await waitFor(() => expect(screen.getByText('Blue gate')).toBeInTheDocument());
        expect(screen.queryByTestId('rough-place-line')).not.toBeInTheDocument();
        rerender(<div style={{ width: 320 }}><EventDetail post={{ ...ev, authorPublicKey: 'me-pk', eventRsvps: [] }} identity={identity} onOpenChat={() => {}} /></div>);
        await new Promise(r => setTimeout(r, 20));
        expect(screen.queryByTestId('rough-place-line')).not.toBeInTheDocument();
    });
    it('on a local community, nothing new', async () => {
        info.features = {};
        renderAt320(<EventDetail post={{ ...ev, myRsvp: null }} identity={identity} onOpenChat={() => {}} />);
        await new Promise(r => setTimeout(r, 20));
        expect(screen.queryByTestId('rough-place-line')).not.toBeInTheDocument();
    });
});
