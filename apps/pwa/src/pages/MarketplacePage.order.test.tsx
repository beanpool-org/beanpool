/**
 * Tests for web Market ordering (pinning-s0):
 * The web Market orders held rows newest created first, as the phone does.
 * - A post edited or RSVPed later than a newer post stays below it.
 * - The Daily Pulse post stays first.
 * - On a nearest-first answer the node's distance order stands.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

const info = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => info.current),
    joinInFlight: vi.fn(async () => false),
}));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null),
    saveRadiusSettings: vi.fn(),
    clearRadiusSettings: vi.fn(),
    haversineDistance: vi.fn(() => 0),
}));
vi.mock('../lib/peer-prefs', () => ({ loadEnabledPeers: vi.fn(() => new Set()), togglePeer: vi.fn() }));
vi.mock('../lib/profile-status', () => ({
    getProfileStatus: vi.fn(async () => ({ complete: true })),
    describeMissing: vi.fn(() => ''),
}));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));
vi.mock('../components/PollCard', () => ({ PollCard: () => null }));
vi.mock('../components/YourEvents', () => ({ YourEvents: () => null }));
vi.mock('../components/CategoryPickerModal', () => ({ CategoryPickerModal: () => null }));
vi.mock('../components/MyDealsModal', () => ({ MyDealsModal: () => null }));
vi.mock('../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../components/ExampleListings', () => ({ ExampleListings: () => null }));

// Mock MarketplaceCard and EventCard to render identifiable title elements
vi.mock('../components/MarketplaceCard', () => ({
    MarketplaceCard: ({ post }: { post: any }) => <div data-testid="market-post-card">{post.title}</div>,
}));
vi.mock('../components/EventCard', () => ({
    EventCard: ({ post }: { post: any }) => <div data-testid="market-post-card">{post.title}</div>,
    EventDetail: () => null,
}));

const ME = 'member-me';
const identity: BeanPoolIdentity = {
    publicKey: ME,
    privateKey: 'mock-key',
    callsign: 'Me',
    createdAt: '2026-09-01T00:00:00.000Z',
};

const postOldEdited = {
    id: 'post-old',
    type: 'offer',
    category: 'goods',
    title: 'Older Post Edited Later',
    description: 'Vintage record player',
    credits: 10,
    priceType: 'fixed',
    status: 'active',
    active: true,
    authorPublicKey: 'author-bob',
    authorCallsign: 'Bob',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
};

const postNew = {
    id: 'post-new',
    type: 'offer',
    category: 'goods',
    title: 'Newer Post',
    description: 'Fresh honey',
    credits: 5,
    priceType: 'fixed',
    status: 'active',
    active: true,
    authorPublicKey: 'author-alice',
    authorCallsign: 'Alice',
    createdAt: '2026-10-10T10:00:00.000Z',
    updatedAt: '2026-10-10T10:00:00.000Z',
};

const eventOldRsvped = {
    id: 'event-old',
    type: 'event',
    category: 'events',
    title: 'Older Event RSVPed Later',
    description: 'Community gardening',
    credits: 0,
    priceType: 'fixed',
    status: 'active',
    active: true,
    authorPublicKey: 'author-charlie',
    authorCallsign: 'Charlie',
    createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt: '2026-10-16T12:00:00.000Z',
    eventStartAt: '2026-11-20T10:00:00.000Z',
    eventEndAt: '2026-11-20T12:00:00.000Z',
    eventState: 'scheduled',
};

const pulsePost = {
    id: 'post-pulse',
    type: 'offer',
    category: 'community',
    title: 'Daily Pulse Reflection',
    description: 'Thought for today',
    credits: 0,
    priceType: 'fixed',
    status: 'active',
    active: true,
    authorPublicKey: 'pulse-pk',
    authorCallsign: 'Daily Pulse',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
};

const postNear = {
    id: 'post-near',
    type: 'offer',
    category: 'goods',
    title: 'Near Listing',
    description: 'Nearby lemons',
    credits: 5,
    priceType: 'fixed',
    status: 'active',
    active: true,
    lat: -28.5,
    lng: 153.5,
    distanceKm: 1.2,
    authorPublicKey: 'author-dan',
    authorCallsign: 'Dan',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
};

const postFar = {
    id: 'post-far',
    type: 'offer',
    category: 'goods',
    title: 'Far Listing',
    description: 'Faraway apples',
    credits: 5,
    priceType: 'fixed',
    status: 'active',
    active: true,
    lat: -28.1,
    lng: 153.1,
    distanceKm: 45.0,
    authorPublicKey: 'author-eve',
    authorCallsign: 'Eve',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
};

function stubNode(feedPosts: any[]) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) => {
        if (f?.author) return [] as any;
        if (f?.id) return feedPosts.filter(p => p.id === f.id) as any;
        return feedPosts as any;
    });
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
    vi.spyOn(api, 'getTreasury').mockResolvedValue(null);
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 100, isBlockedFromTrading: false } as any);
    vi.spyOn(api, 'getGroups').mockResolvedValue([]);
    vi.spyOn(api, 'getCommissionCapacity').mockResolvedValue({ links: [] });
    vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: ME } as any);
    vi.spyOn(api, 'getMemberProfile').mockResolvedValue({ avatar: null, bio: '' } as any);
    vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ ratings: [], average: 0, count: 0 } as any);
    vi.spyOn(api, 'getRatingsGiven').mockResolvedValue({ ratings: [] });
    vi.spyOn(api, 'getMyMarketplaceTransactions').mockResolvedValue([]);
}

describe('MarketplacePage order (pinning-s0)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        info.current = { profile: 'local', features: { beans: true } };
    });

    it('a post edited later than a newer post stays below it', async () => {
        // Node returns in RECENT_ORDER (updated_at DESC): postOldEdited first, postNew second.
        stubNode([postOldEdited, postNew]);
        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            const cards = screen.getAllByTestId('market-post-card');
            expect(cards.length).toBe(2);
        });

        const titles = screen.getAllByTestId('market-post-card').map(el => el.textContent);
        // Newest created must be first; edited older post stays below it
        expect(titles).toEqual(['Newer Post', 'Older Post Edited Later']);
    });

    it('an event RSVPed later than a newer post stays below it', async () => {
        // Node returns in RECENT_ORDER (updated_at DESC): eventOldRsvped first, postNew second.
        stubNode([eventOldRsvped, postNew]);
        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            const cards = screen.getAllByTestId('market-post-card');
            expect(cards.length).toBe(2);
        });

        const titles = screen.getAllByTestId('market-post-card').map(el => el.textContent);
        // Newest created must be first; RSVPed older event stays below it
        expect(titles).toEqual(['Newer Post', 'Older Event RSVPed Later']);
    });

    it('the Daily Pulse post stays first even with an older creation date', async () => {
        // With fewer than 2 real member listings, Daily Pulse is pinned first.
        // Node returns postNew and pulsePost.
        stubNode([postNew, pulsePost]);
        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            const cards = screen.getAllByTestId('market-post-card');
            expect(cards.length).toBe(2);
        });

        const titles = screen.getAllByTestId('market-post-card').map(el => el.textContent);
        expect(titles).toEqual(['Daily Pulse Reflection', 'Newer Post']);
    });

    it('on a nearest-first answer the order is the node\'s', async () => {
        // Global node with nearbyListings feature and user area -> near is active.
        info.current = { profile: 'global', features: { beans: false, nearbyListings: { radiusKm: 250, max: 500 } } };
        stubNode([postNear, postFar]);
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue({
            publicKey: ME,
            area: { lat: -28.5, lng: 153.5 },
        } as any);

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            const cards = screen.getAllByTestId('market-post-card');
            expect(cards.length).toBe(2);
        });

        const titles = screen.getAllByTestId('market-post-card').map(el => el.textContent);
        // Distance order stands: postNear (nearest) remains first, postFar remains second
        expect(titles).toEqual(['Near Listing', 'Far Listing']);
    });

    it('under the Events tab, event start time order is preserved (soonest first) over creation time', async () => {
        const HOUR = 60 * 60 * 1000;
        const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

        // eventSooner: created EARLIER, but starts SOONER (in 24 hours)
        const eventSooner = {
            id: 'event-sooner',
            type: 'event',
            category: 'events',
            title: 'Soonest Event',
            description: 'Starts tomorrow',
            credits: 0,
            priceType: 'fixed',
            status: 'active',
            active: true,
            authorPublicKey: 'author-charlie',
            authorCallsign: 'Charlie',
            createdAt: '2026-10-01T10:00:00.000Z',
            updatedAt: '2026-10-01T10:00:00.000Z',
            eventStartAt: inHours(24),
            eventEndAt: inHours(26),
            eventState: 'scheduled',
        };

        // eventLater: created LATER, but starts LATER (in 72 hours)
        const eventLater = {
            id: 'event-later',
            type: 'event',
            category: 'events',
            title: 'Later Event',
            description: 'Starts in three days',
            credits: 0,
            priceType: 'fixed',
            status: 'active',
            active: true,
            authorPublicKey: 'author-alice',
            authorCallsign: 'Alice',
            createdAt: '2026-10-25T10:00:00.000Z',
            updatedAt: '2026-10-25T10:00:00.000Z',
            eventStartAt: inHours(72),
            eventEndAt: inHours(74),
            eventState: 'scheduled',
        };

        stubNode([eventLater, eventSooner]);
        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            const cards = screen.getAllByTestId('market-post-card');
            expect(cards.length).toBe(2);
        });

        // Click Events pill
        fireEvent.click(screen.getByRole('button', { name: 'Events' }));

        await waitFor(() => {
            const titles = screen.getAllByTestId('market-post-card').map(el => el.textContent);
            // Must preserve chronological start-time order (soonest first), NOT creation order
            expect(titles).toEqual(['Soonest Event', 'Later Event']);
        });
    });

    it('server search results order is preserved rather than overwritten by createdAt', async () => {
        // Two search results matching 'honey':
        // postSearchOld: created earlier, ranked first by server search
        // postSearchNew: created later, ranked second by server search
        const postSearchOld = {
            id: 'post-honey-1',
            type: 'offer',
            category: 'goods',
            title: 'Honey - Raw Forest',
            description: 'Pure forest honey',
            credits: 10,
            priceType: 'fixed',
            status: 'active',
            active: true,
            authorPublicKey: 'author-bob',
            authorCallsign: 'Bob',
            createdAt: '2026-10-01T10:00:00.000Z',
            updatedAt: '2026-10-01T10:00:00.000Z',
        };

        const postSearchNew = {
            id: 'post-honey-2',
            type: 'offer',
            category: 'goods',
            title: 'Honey - Creamed Clover',
            description: 'Sweet clover honey',
            credits: 12,
            priceType: 'fixed',
            status: 'active',
            active: true,
            authorPublicKey: 'author-alice',
            authorCallsign: 'Alice',
            createdAt: '2026-10-25T10:00:00.000Z',
            updatedAt: '2026-10-25T10:00:00.000Z',
        };

        const initialPost = {
            id: 'post-other',
            type: 'offer',
            category: 'goods',
            title: 'Unrelated Bicycle',
            description: 'Bicycle repair',
            credits: 10,
            priceType: 'fixed',
            status: 'active',
            active: true,
            authorPublicKey: 'author-david',
            authorCallsign: 'David',
            createdAt: '2026-10-05T10:00:00.000Z',
            updatedAt: '2026-10-05T10:00:00.000Z',
        };

        stubNode([initialPost]);
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) => {
            if (f?.author) return [] as any;
            if (f?.id) return [initialPost].filter(p => p.id === f.id) as any;
            if (f?.q) return [postSearchOld, postSearchNew] as any;
            return [initialPost] as any;
        });

        render(<MarketplacePage identity={identity} isMember={true} openSearch="honey" onSearchOpened={vi.fn()} />);

        // Wait until server search results resolve and replace the initial feed
        await waitFor(() => {
            expect(screen.queryByText('Unrelated Bicycle')).toBeNull();
            const cards = screen.getAllByTestId('market-post-card');
            expect(cards.length).toBe(2);
        });

        const titles = screen.getAllByTestId('market-post-card').map(el => el.textContent);
        // Server search result ranking stands: postSearchOld first, postSearchNew second
        expect(titles).toEqual(['Honey - Raw Forest', 'Honey - Creamed Clover']);
    });
});
