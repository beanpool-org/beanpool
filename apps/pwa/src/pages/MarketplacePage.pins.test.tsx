/**
 * Tests for web Market pinning (pinning-s3):
 * - Pinned block at top of Market with live pinned posts.
 * - Up to 3 pins (PINS_MAX = 3), ordered newest pin first (pinnedAt DESC).
 * - Pins excluded from the main feed below (no duplication).
 * - Suppressed under member-narrowing: search query, tags, or distance setting (near.from === 'setting').
 * - Preserved on global area read (near.from === 'area').
 * - Real-time expiration without reload.
 */
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

const info = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const radiusMock = vi.hoisted(() => ({ current: null as any }));

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => info.current),
    joinInFlight: vi.fn(async () => false),
}));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => radiusMock.current),
    saveRadiusSettings: vi.fn(),
    clearRadiusSettings: vi.fn(),
    haversineDistance: vi.fn(() => 10),
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

// Mock MarketplaceCard and EventCard
vi.mock('../components/MarketplaceCard', () => ({
    MarketplaceCard: ({ post }: { post: any }) => (
        <div data-testid="market-post-card" data-post-id={post.id}>
            {post.title}
        </div>
    ),
}));
vi.mock('../components/EventCard', () => ({
    EventCard: ({ post }: { post: any }) => (
        <div data-testid="market-post-card" data-post-id={post.id}>
            {post.title}
        </div>
    ),
    EventDetail: () => null,
}));

const ME = 'member-me';
const identity: BeanPoolIdentity = {
    publicKey: ME,
    privateKey: 'mock-key',
    callsign: 'Me',
    createdAt: '2026-09-01T00:00:00.000Z',
};

const NOW = Date.now();
const FUTURE_3D = new Date(NOW + 3 * 86_400_000).toISOString();
const PAST_1D = new Date(NOW - 86_400_000).toISOString();

function makePost(id: string, title: string, opts: { pinnedAt?: string; pinnedUntil?: string; createdAt?: string; lat?: number; lng?: number } = {}) {
    return {
        id,
        type: 'offer',
        category: 'goods',
        title,
        description: 'Test description',
        credits: 10,
        priceType: 'fixed',
        status: 'active',
        active: true,
        authorPublicKey: 'author-alice',
        authorCallsign: 'Alice',
        createdAt: opts.createdAt ?? new Date(NOW - 50_000).toISOString(),
        updatedAt: opts.createdAt ?? new Date(NOW - 50_000).toISOString(),
        pinnedUntil: opts.pinnedUntil ?? null,
        pinnedAt: opts.pinnedAt ?? null,
        lat: opts.lat ?? 51.5,
        lng: opts.lng ?? -0.1,
    };
}

function stubNode(feedPosts: any[]) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) => {
        if (f?.author) return [] as any;
        if (f?.id) return feedPosts.filter(p => p.id === f.id) as any;
        return feedPosts as any;
    });
    vi.spyOn(api, 'myNodeRoleOnce').mockResolvedValue('owner');
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

describe('MarketplacePage pinning (pinning-s3)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        radiusMock.current = null;
        info.current = { profile: 'local', features: { beans: true, pins: true } };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders the Pinned block with live pinned posts ordered newest pin first, capped at 3', async () => {
        // 4 live pinned posts + 2 normal posts
        const pin1 = makePost('pin-1', 'First Pin (Oldest)', {
            pinnedAt: new Date(NOW - 4000).toISOString(),
            pinnedUntil: FUTURE_3D,
        });
        const pin2 = makePost('pin-2', 'Second Pin', {
            pinnedAt: new Date(NOW - 3000).toISOString(),
            pinnedUntil: FUTURE_3D,
        });
        const pin3 = makePost('pin-3', 'Third Pin', {
            pinnedAt: new Date(NOW - 2000).toISOString(),
            pinnedUntil: FUTURE_3D,
        });
        const pin4 = makePost('pin-4', 'Fourth Pin (Newest)', {
            pinnedAt: new Date(NOW - 1000).toISOString(),
            pinnedUntil: FUTURE_3D,
        });
        const regular1 = makePost('reg-1', 'Regular Post 1', {
            createdAt: new Date(NOW - 10_000).toISOString(),
        });
        const regular2 = makePost('reg-2', 'Regular Post 2', {
            createdAt: new Date(NOW - 20_000).toISOString(),
        });

        stubNode([pin1, pin2, pin3, pin4, regular1, regular2]);

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            expect(screen.getByTestId('market-pinned-block')).toBeInTheDocument();
            expect(screen.getByTestId('market-pinned-heading')).toHaveTextContent(/Pinned/i);
        });

        // Inside market-pinned-block, only 3 posts should appear, newest pin first:
        // pin4 (newest: -1000), pin3 (-2000), pin2 (-3000). pin1 is 4th so drops to unpinned feed.
        const pinnedBlock = screen.getByTestId('market-pinned-block');
        const pinnedCards = pinnedBlock.querySelectorAll('[data-testid="market-post-card"]');
        expect(pinnedCards.length).toBe(3);
        expect(pinnedCards[0].textContent).toBe('Fourth Pin (Newest)');
        expect(pinnedCards[1].textContent).toBe('Third Pin');
        expect(pinnedCards[2].textContent).toBe('Second Pin');

        // Check that pin4, pin3, pin2 are NOT duplicated in the whole document:
        const allCards = screen.getAllByTestId('market-post-card');
        expect(allCards.length).toBe(6); // 3 in pinned block + 3 in unpinned feed (pin1 + reg1 + reg2)
        const allTitles = allCards.map(c => c.textContent);
        expect(new Set(allTitles).size).toBe(6);
    });

    it('suppresses the Pinned block under search narrowing', async () => {
        const pin1 = makePost('pin-1', 'Pinned Post', {
            pinnedAt: new Date(NOW - 1000).toISOString(),
            pinnedUntil: FUTURE_3D,
        });
        const reg1 = makePost('reg-1', 'Regular Post');

        stubNode([pin1, reg1]);

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            expect(screen.getByTestId('market-pinned-block')).toBeInTheDocument();
        });

        // Type into search box
        const searchInput = screen.getByPlaceholderText(/Search/i);
        fireEvent.change(searchInput, { target: { value: 'Post' } });

        await waitFor(() => {
            expect(screen.queryByTestId('market-pinned-block')).not.toBeInTheDocument();
            expect(screen.queryByTestId('market-pinned-heading')).not.toBeInTheDocument();
        });
    });

    it('suppresses the Pinned block when user has selected distance setting (near.from === "setting")', async () => {
        radiusMock.current = { lat: 51.5, lng: -0.1, radiusKm: 25 };
        const pin1 = makePost('pin-1', 'Pinned Post', {
            pinnedAt: new Date(NOW - 1000).toISOString(),
            pinnedUntil: FUTURE_3D,
        });
        const reg1 = makePost('reg-1', 'Regular Post');

        stubNode([pin1, reg1]);

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            const cards = screen.getAllByTestId('market-post-card');
            expect(cards.length).toBe(2);
        });

        // Under radiusSettings, pinned block must be suppressed
        expect(screen.queryByTestId('market-pinned-block')).not.toBeInTheDocument();
    });

    it('does NOT render expired pins in the Pinned block', async () => {
        const expiredPin = makePost('pin-exp', 'Expired Pin', {
            pinnedAt: new Date(NOW - 100_000).toISOString(),
            pinnedUntil: PAST_1D,
        });
        const regular1 = makePost('reg-1', 'Regular Post');

        stubNode([expiredPin, regular1]);

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            const cards = screen.getAllByTestId('market-post-card');
            expect(cards.length).toBe(2);
        });

        // No live pins -> no pinned block
        expect(screen.queryByTestId('market-pinned-block')).not.toBeInTheDocument();
    });

    it('shows the Pinned block on global area read where near.from === "area"', async () => {
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({
            nearbyListings: { radiusKm: 250 },
        } as any);
        vi.spyOn(api, 'getMemberProfile').mockResolvedValue({
            avatar: null,
            bio: '',
            area: { lat: 51.5, lng: -0.1 },
        } as any);

        const pin1 = makePost('pin-1', 'Pinned Post', {
            pinnedAt: new Date(NOW - 1000).toISOString(),
            pinnedUntil: FUTURE_3D,
        });
        const reg1 = makePost('reg-1', 'Regular Post');

        stubNode([pin1, reg1]);

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            // Pinned block is retained because near.from === 'area' (not 'setting')
            expect(screen.getByTestId('market-pinned-block')).toBeInTheDocument();
        });
    });

    it('renders PostPinDetail banner and actions when opening a pinned post in detail view', async () => {
        const pin1 = makePost('pin-1', 'Pinned Post Title', {
            pinnedAt: new Date(NOW - 1000).toISOString(),
            pinnedUntil: FUTURE_3D,
        });

        stubNode([pin1]);

        render(<MarketplacePage identity={identity} isMember={true} openPostId="pin-1" />);

        await waitFor(() => {
            expect(screen.getByTestId('post-pinned-detail-banner')).toBeInTheDocument();
            expect(screen.getByTestId('post-pinned-detail-line')).toHaveTextContent(/Pinned by your community/);
            expect(screen.getByTestId('take-pin-off-inline-btn')).toBeInTheDocument();
        });
    });

    it('does not grant owner/admin pin controls to unauthenticated guest even if role cached', async () => {
        vi.spyOn(api, 'myNodeRoleOnce').mockResolvedValue('owner');
        const pin1 = makePost('pin-1', 'Pinned Post Title', {
            pinnedAt: new Date(NOW - 1000).toISOString(),
            pinnedUntil: FUTURE_3D,
        });
        stubNode([pin1]);

        render(<MarketplacePage identity={null} isMember={false} openPostId="pin-1" />);

        await waitFor(() => {
            expect(screen.getByTestId('post-pinned-detail-banner')).toBeInTheDocument();
        });
        expect(screen.queryByTestId('take-pin-off-inline-btn')).not.toBeInTheDocument();
        expect(screen.queryByTestId('post-menu-trigger')).not.toBeInTheDocument();
    });
});
