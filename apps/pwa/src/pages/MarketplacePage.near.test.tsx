// The web Market on a node that reads by area (DESIGN-global-sync-by-area §5, S5): with `features.nearbyListings` it
// asks for the nearest within the member's distance setting, else within the node's radius of their stored area, and
// shows the distance the node returns. A local node, a visitor and a member with no point read exactly as before.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { loadRadiusSettings } from '../lib/geo';
import { CLIENT_POST_TYPES } from '../lib/events';

const info = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => info.current),
    joinInFlight: vi.fn(async () => false),
}));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null), saveRadiusSettings: vi.fn(), clearRadiusSettings: vi.fn(), haversineDistance: vi.fn(() => 0),
}));
vi.mock('../lib/peer-prefs', () => ({ loadEnabledPeers: vi.fn(() => new Set()), togglePeer: vi.fn() }));
vi.mock('../lib/profile-status', () => ({ getProfileStatus: vi.fn(async () => ({ complete: true })), describeMissing: vi.fn(() => '') }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));

const identity: BeanPoolIdentity = {
    publicKey: 'member-me', privateKey: 'mock-private-key-hex', callsign: 'Me', createdAt: '2026-09-17T00:00:00.000Z',
};
const offer = {
    id: 'offer-1', type: 'offer', category: 'services', title: 'Bicycle Repair', description: 'Fix gears',
    credits: 20, priceType: 'fixed', status: 'active', active: true, lat: -28.6, lng: 153.4,
    authorPublicKey: 'member-ada', authorCallsign: 'Ada', createdAt: '2026-09-16T00:00:00Z',
};
const GLOBAL = { profile: 'global', features: { beans: false, nearbyListings: { radiusKm: 250, max: 500 } } };
const LOCAL = { profile: 'local', features: { beans: true } };
const AREA = { lat: -28.5, lng: 153.5, updatedAt: '2026-10-01T00:00:00Z' };

/** The feed's reads of the node (not the viewer's own, which names an author). */
const feedReads = () => vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f).filter(f => !f?.author && !f?.id);
const ownReads = () => vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f).filter(f => !!f?.author);

describe('MarketplacePage: where the list is read from (S5)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.mocked(loadRadiusSettings).mockReturnValue(null);
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f) => (f?.author ? [] : [
            // The node measured it: the card shows the node's number, not one worked out here (haversine is 0 here).
            f?.lat != null ? { ...offer, distanceKm: 12.3 } : offer,
        ]) as any);
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: 'member-me', area: AREA } as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('on a by-area node, reads the nearest within the node\'s radius of the member\'s area, once, and shows the node\'s distance', async () => {
        info.current = GLOBAL;
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES, lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance' }]);
        // The viewer's own listings wherever they are: no point on that read.
        expect(ownReads()).toEqual([{ types: CLIENT_POST_TYPES, author: 'member-me' }]);
        expect(screen.getByTestId('card-distance')).toHaveTextContent('12 km');
        expect(screen.getByTestId('market-near-line')).toHaveTextContent('Nearest to your area first, within 250 km.');
    });

    it('the member\'s distance setting wins over their area', async () => {
        info.current = GLOBAL;
        vi.mocked(loadRadiusSettings).mockReturnValue({ lat: -37.1, lng: 144.2, radiusKm: 30, label: 'Castlemaine' });
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES, lat: -37.1, lng: 144.2, radiusKm: 30, sort: 'distance' }]);
        expect(screen.getByTestId('market-near-line')).toHaveTextContent('Nearest first, within 30 km of Castlemaine.');
    });

    it('a member with no area and no distance setting reads the newest, with a way to what is near', async () => {
        info.current = GLOBAL;
        vi.mocked(api.getCommunityMe).mockResolvedValue({ publicKey: 'member-me', area: null } as any);
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES }]);
        expect(screen.queryByTestId('card-distance')).toBeNull();
        const line = screen.getByTestId('market-near-line');
        expect(line).toHaveTextContent('Newest from everywhere.');
        expect(screen.getByRole('button', { name: "See what's near you" })).toBeInTheDocument();
    });

    it('Show everywhere reads the newest, and Near your area goes back', async () => {
        info.current = GLOBAL;
        render(<MarketplacePage identity={identity} />);
        await screen.findByTestId('card-distance');
        fireEvent.click(screen.getByRole('button', { name: 'Show everywhere' }));
        await waitFor(() => expect(feedReads().at(-1)).toEqual({ types: CLIENT_POST_TYPES }));
        await waitFor(() => expect(screen.queryByTestId('card-distance')).toBeNull());
        fireEvent.click(screen.getByRole('button', { name: 'Near your area' }));
        await waitFor(() => expect(feedReads().at(-1)).toEqual({ types: CLIENT_POST_TYPES, lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance' }));
    });

    it('a local node reads exactly as before, asks for no area, and says nothing about where', async () => {
        info.current = LOCAL;
        vi.mocked(loadRadiusSettings).mockReturnValue({ lat: -37.1, lng: 144.2, radiusKm: 30, label: 'Castlemaine' });
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES }]);
        expect(api.getCommunityMe).not.toHaveBeenCalled();
        expect(screen.queryByTestId('market-near-line')).toBeNull();
        expect(screen.queryByTestId('card-distance')).toBeNull();
    });

    it('a visitor on a by-area node reads the lobby\'s list as before', async () => {
        info.current = GLOBAL;
        render(<MarketplacePage identity={null} visitor={{ beans: false, joinCard: null, onJoin: () => {} } as any} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES }]);
        expect(api.getCommunityMe).not.toHaveBeenCalled();
        expect(screen.queryByTestId('market-near-line')).toBeNull();
    });

    it('a link to one listing opens it when nothing is near: the by-id read once the first read has settled', async () => {
        info.current = GLOBAL;
        // Nothing within the radius of the member's area; the listing itself is far away.
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => (f?.id === 'offer-1' ? [offer] : []) as any);
        const onPostOpened = vi.fn();
        render(<MarketplacePage identity={identity} openPostId="offer-1" onPostOpened={onPostOpened} />);
        await waitFor(() => expect(onPostOpened).toHaveBeenCalledTimes(1));
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES, lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance' }]);
        expect(vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f).filter(f => !!f?.id))
            .toEqual([{ id: 'offer-1', types: CLIENT_POST_TYPES }]);
        expect(await screen.findByText('Bicycle Repair')).toBeInTheDocument();
    });

    it('Events are never cut by the area or the distance: no point on their read, every event shown, no line', async () => {
        info.current = GLOBAL;
        const farEvent = {
            ...offer, id: 'ev-oslo', type: 'event', category: 'events', title: 'Oslo choir night', lat: 59.9, lng: 10.7,
            eventStartAt: new Date(Date.now() + 86_400_000).toISOString(), eventEndAt: new Date(Date.now() + 90_000_000).toISOString(),
        };
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => (f?.author ? [] : f?.type === 'event' ? [farEvent] : [offer]) as any);
        vi.spyOn(api, 'getMyEvents').mockResolvedValue([]);
        for (const setting of [null, { lat: -37.1, lng: 144.2, radiusKm: 30, label: '30km radius' }]) {
            vi.mocked(loadRadiusSettings).mockReturnValue(setting);
            vi.mocked(api.getMarketplacePosts).mockClear();
            const { unmount } = render(<MarketplacePage identity={identity} />);
            await screen.findByText('Bicycle Repair');
            fireEvent.click(screen.getByRole('button', { name: 'Events' }));
            await screen.findByText('Oslo choir night');
            expect(feedReads().filter(f => f?.type === 'event')).toEqual([{ type: 'event' }]);
            expect(ownReads().filter(f => f?.type === 'event')).toEqual([{ type: 'event', author: 'member-me' }]);
            expect(screen.queryByTestId('market-near-line')).toBeNull();
            unmount();
        }
    });

    it('a node that never answers its info still gets a list, read as before', async () => {
        info.current = GLOBAL;
        const gate = await import('../lib/visitor-lobby-gate');
        vi.mocked(gate.communityInfoOnce).mockImplementationOnce(() => new Promise(() => {}));
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES }]);
    });
});
