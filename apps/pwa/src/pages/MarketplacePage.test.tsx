import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null),
    saveRadiusSettings: vi.fn(),
    clearRadiusSettings: vi.fn(),
    haversineDistance: vi.fn(() => 0),
}));

vi.mock('../lib/peer-prefs', () => ({
    loadEnabledPeers: vi.fn(() => new Set()),
    togglePeer: vi.fn(),
}));

vi.mock('../lib/profile-status', () => ({
    getProfileStatus: vi.fn(async () => ({ complete: true })),
    describeMissing: vi.fn(() => ''),
}));

vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: () => null,
}));

vi.mock('../components/ActivityWaterfall', () => ({
    ActivityWaterfall: () => null,
}));

const identity: BeanPoolIdentity = {
    publicKey: 'guest-pubkey',
    privateKey: 'mock-private-key-hex',
    callsign: 'Guest',
    createdAt: '2026-09-17T00:00:00.000Z',
};

const posts = [{
    id: 'post-1', title: 'Bicycle Repair', description: 'Fix gears', type: 'offer', category: 'services',
    credits: 20, status: 'active', authorPublicKey: 'member-david', authorCallsign: 'David',
    createdAt: '2026-09-15T00:00:00Z',
}];

// A guest is a local key the node has no member for: the node answers "Member not found" for its balance,
// so on a slow connection the request is pure waste. App tells the page with isMember.
describe('MarketplacePage: the viewer balance is a member-only request', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue(posts as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('never asks for the balance of a guest', async () => {
        render(<MarketplacePage identity={identity} isMember={false} />);
        await screen.findByText('Bicycle Repair');
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(api.getBalance).not.toHaveBeenCalled();
    });

    it('waits while membership is unknown, then asks once for a member', async () => {
        const view = render(<MarketplacePage identity={identity} isMember={null} />);
        await screen.findByText('Bicycle Repair');
        expect(api.getBalance).not.toHaveBeenCalled();

        view.rerender(<MarketplacePage identity={identity} isMember={true} />);
        await waitFor(() => expect(api.getBalance).toHaveBeenCalledTimes(1));
        expect(api.getBalance).toHaveBeenCalledWith(identity.publicKey);
    });

    it('still asks for a member when isMember is omitted', async () => {
        render(<MarketplacePage identity={identity} />);
        await waitFor(() => expect(api.getBalance).toHaveBeenCalledTimes(1));
    });
});

describe('MarketplacePage: events in the feed (docs/events-on-the-map.md §3, slice 2)', () => {
    const HOUR = 60 * 60 * 1000;
    const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
    const event = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
        id, type: 'event', category: 'community', title, description: 'Bring gloves', credits: 0, priceType: 'fixed',
        status: 'active', active: true, authorPublicKey: 'host-pk', authorCallsign: 'Hazel', createdAt: new Date().toISOString(),
        lat: -28.55, lng: 153.5, eventStartAt: inHours(30), eventPlaceName: 'Bindarrabi Hall', eventState: 'scheduled',
        goingCount: 7, interestedCount: 3, myRsvp: null, ...extra,
    });

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([
            ...posts,
            event('ev-open', 'Working bee'),
            event('ev-updated', 'Repair café', { eventState: 'updated' }),
            event('ev-ended', 'Last week', { eventStartAt: inHours(-30), eventEndAt: inHours(-28) }),
        ] as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('asks the node for events, shows them as event cards, and leaves out ended ones', async () => {
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Working bee');
        expect(api.getMarketplacePosts).toHaveBeenCalledWith(expect.objectContaining({ types: 'offer,need,poll,event' }));
        const cards = screen.getAllByTestId('event-card');
        expect(cards).toHaveLength(2);
        expect(cards.some(c => c.textContent?.includes('UPDATED'))).toBe(true);
        expect(screen.queryByText('Last week')).not.toBeInTheDocument();
        expect(screen.getByText('Bicycle Repair')).toBeInTheDocument();
    });

    it('has an Events pill that shows events only, with the map\'s date chips in place of the listing filters (B5)', async () => {
        vi.mocked(api.getMarketplacePosts).mockResolvedValue([
            ...posts,
            event('ev-open', 'Working bee'),
            event('ev-far', 'Spring fair', { eventStartAt: inHours(24 * 30) }),
            event('ev-ended', 'Last week', { eventStartAt: inHours(-30), eventEndAt: inHours(-28) }),
        ] as any);
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Working bee');
        const pills = screen.getByTestId('feed-type-filter');
        expect(Array.from(pills.querySelectorAll('button')).map(b => b.textContent)).toEqual(
            ['All', '★ For You', '🟢 Offers', '🟠 Needs', 'Events', '🗳️ Polls']);
        expect(screen.queryByTestId('feed-event-window-chips')).toBeNull();

        await act(async () => { screen.getByRole('button', { name: 'Events' }).click(); });
        await waitFor(() => expect(api.getMarketplacePosts).toHaveBeenCalledWith(expect.objectContaining({ type: 'event' })));
        expect(screen.getByRole('button', { name: 'Events' }).getAttribute('aria-pressed')).toBe('true');
        await waitFor(() => expect(screen.queryByText('Bicycle Repair')).not.toBeInTheDocument());
        // Soonest first, and never an ended one.
        expect(screen.getAllByTestId('event-card').map(c => c.textContent?.includes('Working bee') ? 'open' : 'far')).toEqual(['open', 'far']);
        expect(screen.queryByText('Last week')).not.toBeInTheDocument();

        // The date chips replace Category / Distance / Beans only, as on the phone.
        const chips = screen.getByTestId('feed-event-window-chips');
        expect(Array.from(chips.querySelectorAll('button')).map(b => b.textContent)).toEqual(['Today', 'This weekend', 'Next 7 days', 'All']);
        expect(Array.from(chips.querySelectorAll('button')).every(b => /min-h-\[48px\]/.test(b.className))).toBe(true);
        expect(screen.queryByText(/Beans only/)).toBeNull();
        expect(screen.queryByText('Category')).toBeNull();
        expect(screen.queryByText('Distance')).toBeNull();

        await act(async () => { screen.getByRole('button', { name: 'Next 7 days' }).click(); });
        expect(screen.getByText('Working bee')).toBeInTheDocument();
        expect(screen.queryByText('Spring fair')).not.toBeInTheDocument();
    });

    it('opens an event that has left the feed when a link names it (the chat\'s View event), asking the node by id (A4)', async () => {
        const cancelled = event('ev-cancelled', 'Cancelled working bee', { status: 'cancelled', eventState: 'cancelled', active: false, eventRsvps: [] });
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (filter?: any) =>
            (filter?.id === 'ev-cancelled' ? [cancelled] : [...posts]) as any);
        const onPostOpened = vi.fn();
        render(<MarketplacePage identity={identity} openPostId="ev-cancelled" onPostOpened={onPostOpened} />);
        const detail = await screen.findByTestId('event-detail');
        expect(detail).toHaveTextContent('Cancelled working bee');
        expect(detail).toHaveTextContent('CANCELLED');
        expect(api.getMarketplacePosts).toHaveBeenCalledWith({ id: 'ev-cancelled', types: 'offer,need,poll,event' });
        expect(onPostOpened).toHaveBeenCalled();
    });

    it('opens the event detail from the card, with the host line', async () => {
        render(<MarketplacePage identity={identity} />);
        const open = await screen.findByRole('button', { name: 'Open event: Working bee' });
        await act(async () => { open.click(); });
        const detail = await screen.findByTestId('event-detail');
        expect(detail).toHaveTextContent('Hosted by Hazel');
        expect(detail).toHaveTextContent('Bindarrabi Hall');
    });
});
