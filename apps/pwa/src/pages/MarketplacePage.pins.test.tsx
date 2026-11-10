/**
 * Tests for web Market pinning (pinning-s3; the grid's first cells: market-grid G1, DESIGN-market-grid-sizes-fable.md §2.1):
 * - The grid (the web's default) has no Pinned heading and no block: the pins are its first cells (market-pinned-tile).
 *   List and compact keep the Pinned heading and block.
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
        price_c: 1000,
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
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance_c: 10000, isBlockedFromTrading: false } as any);
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

    // Four live pins (the cap is three) and two ordinary posts. Newest pin first: pin4, pin3, pin2; pin1 is fourth and
    // drops to the stream.
    const fourPinsAndTwo = () => [
        makePost('pin-1', 'First Pin (Oldest)', { pinnedAt: new Date(NOW - 4000).toISOString(), pinnedUntil: FUTURE_3D }),
        makePost('pin-2', 'Second Pin', { pinnedAt: new Date(NOW - 3000).toISOString(), pinnedUntil: FUTURE_3D }),
        makePost('pin-3', 'Third Pin', { pinnedAt: new Date(NOW - 2000).toISOString(), pinnedUntil: FUTURE_3D }),
        makePost('pin-4', 'Fourth Pin (Newest)', { pinnedAt: new Date(NOW - 1000).toISOString(), pinnedUntil: FUTURE_3D }),
        makePost('reg-1', 'Regular Post 1', { createdAt: new Date(NOW - 10_000).toISOString() }),
        makePost('reg-2', 'Regular Post 2', { createdAt: new Date(NOW - 20_000).toISOString() }),
    ];
    /** The cells of the first grid on the page, in drawn order. */
    const firstGridCells = () => Array.from(document.querySelector('div.grid-flow-row-dense')!.children) as HTMLElement[];

    it('grid (the default): the pins are the first cells, newest pin first, capped at 3, and there is no Pinned heading or block', async () => {
        stubNode(fourPinsAndTwo());

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => expect(screen.getAllByTestId('market-pinned-tile').length).toBe(3));

        // pin4 (newest: -1000), pin3 (-2000), pin2 (-3000). pin1 is 4th so drops to the stream.
        const tiles = screen.getAllByTestId('market-pinned-tile');
        expect(tiles.map(t => t.textContent)).toEqual(['Fourth Pin (Newest)', 'Third Pin', 'Second Pin']);

        // No heading and no block in the grid: the pill and the position say it.
        expect(screen.queryByTestId('market-pinned-heading')).not.toBeInTheDocument();
        expect(screen.queryByTestId('market-pinned-block')).not.toBeInTheDocument();
        expect(screen.queryByText('Pinned')).not.toBeInTheDocument();

        // The first three cells of the first grid are the pins, in that order; the stream carries on in the same grid.
        const cells = firstGridCells();
        expect(cells.slice(0, 3)).toEqual(tiles);
        // (The stream is newest-listed first, so the 4th pin, listed 50 s ago, comes after the two posts listed 10 and 20 s ago.)
        expect(cells.slice(3).map(c => c.textContent)).toEqual(['Regular Post 1', 'Regular Post 2', 'First Pin (Oldest)']);
        expect(cells.slice(3).every(c => c.getAttribute('data-testid') !== 'market-pinned-tile')).toBe(true);
        expect(document.querySelectorAll('div.grid-flow-row-dense').length).toBe(1);

        // No post is drawn twice.
        const allCards = screen.getAllByTestId('market-post-card');
        expect(allCards.length).toBe(6);
        expect(new Set(allCards.map(c => c.textContent)).size).toBe(6);
    });

    it.each([['list'], ['compact']])('%s view keeps the Pinned heading and block, with the pins out of the stream below', async (mode) => {
        localStorage.setItem('marketplace_view_mode', mode);
        stubNode(fourPinsAndTwo());

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            expect(screen.getByTestId('market-pinned-block')).toBeInTheDocument();
            expect(screen.getByTestId('market-pinned-heading')).toHaveTextContent(/Pinned/i);
        });

        // Inside market-pinned-block, only 3 posts should appear, newest pin first.
        const pinnedBlock = screen.getByTestId('market-pinned-block');
        const pinnedCards = pinnedBlock.querySelectorAll('[data-testid="market-post-card"]');
        expect(pinnedCards.length).toBe(3);
        expect(pinnedCards[0].textContent).toBe('Fourth Pin (Newest)');
        expect(pinnedCards[1].textContent).toBe('Third Pin');
        expect(pinnedCards[2].textContent).toBe('Second Pin');

        // The grid's cell marker is the grid's alone.
        expect(screen.queryByTestId('market-pinned-tile')).not.toBeInTheDocument();

        // Check that pin4, pin3, pin2 are NOT duplicated in the whole document:
        const allCards = screen.getAllByTestId('market-post-card');
        expect(allCards.length).toBe(6); // 3 in pinned block + 3 in unpinned feed (pin1 + reg1 + reg2)
        expect(new Set(allCards.map(c => c.textContent)).size).toBe(6);
    });

    it.each([[1], [2], [3], [4]])('grid: %i live pin(s) draw min(pins, 3) market-pinned-tile cells', async (pins) => {
        const posts = fourPinsAndTwo();
        // Keep the first `pins` pins live; the others are ordinary posts.
        const shaped = posts.map((p, i) => (i < 4 && i >= pins ? { ...p, pinnedUntil: null, pinnedAt: null } : p));
        stubNode(shaped);

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => expect(screen.getAllByTestId('market-post-card').length).toBe(6));
        expect(screen.getAllByTestId('market-pinned-tile').length).toBe(Math.min(pins, 3));
        expect(firstGridCells().length).toBe(6);
    });

    it('grid: one pin and nothing else is still drawn, as the one cell of the grid', async () => {
        stubNode([makePost('pin-1', 'Only Pin', { pinnedAt: new Date(NOW - 1000).toISOString(), pinnedUntil: FUTURE_3D })]);

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => expect(screen.getAllByTestId('market-pinned-tile').length).toBe(1));
        expect(screen.getByTestId('market-pinned-tile')).toHaveTextContent('Only Pin');
        expect(firstGridCells().length).toBe(1);
        expect(screen.queryByTestId('market-pinned-heading')).not.toBeInTheDocument();
    });

    it('grid: "New since you last looked" counts the stream only, and the pins stay above the line', async () => {
        // The stamp is the second ordinary post's time: reg-1 is new, reg-2 is the first seen one, so the line goes between them.
        const stamp = NOW - 20_000;
        localStorage.setItem('bp_market_seen_listed', String(stamp));
        stubNode([
            makePost('pin-1', 'Pin One', { pinnedAt: new Date(NOW - 2000).toISOString(), pinnedUntil: FUTURE_3D, createdAt: new Date(NOW - 90_000).toISOString() }),
            makePost('pin-2', 'Pin Two', { pinnedAt: new Date(NOW - 1000).toISOString(), pinnedUntil: FUTURE_3D, createdAt: new Date(NOW - 95_000).toISOString() }),
            makePost('reg-1', 'Regular Post 1', { createdAt: new Date(NOW - 10_000).toISOString() }),
            makePost('reg-2', 'Regular Post 2', { createdAt: new Date(stamp).toISOString() }),
            makePost('reg-3', 'Regular Post 3', { createdAt: new Date(NOW - 30_000).toISOString() }),
        ]);

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => expect(screen.getAllByTestId('market-pinned-tile').length).toBe(2));
        const line = screen.getByTestId('market-new-since');
        const before = line.previousElementSibling as HTMLElement;
        const after = line.nextElementSibling as HTMLElement;
        // Two grids, the line between them; both pins in the first one, before the new tile; the seen tiles after.
        expect(Array.from(before.children).map(c => c.textContent)).toEqual(['Pin Two', 'Pin One', 'Regular Post 1']);
        expect(Array.from(after.children).map(c => c.textContent)).toEqual(['Regular Post 2', 'Regular Post 3']);
        for (const tile of screen.getAllByTestId('market-pinned-tile')) {
            expect(line.compareDocumentPosition(tile) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
        }
    });

    it('a pin that has ended leaves the grid at the next draw, in a tab left open', async () => {
        const ends = Date.now() + 60_000;
        const pin = makePost('pin-1', 'Ending Pin', { pinnedUntil: new Date(ends).toISOString(), pinnedAt: new Date(Date.now() - 1000).toISOString() });
        stubNode([pin, makePost('reg-1', 'Regular Post 1')]);
        const { rerender } = render(<MarketplacePage identity={identity} isMember={true} />);
        await waitFor(() => expect(screen.getByTestId('market-pinned-tile')).toBeInTheDocument());
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(ends + 1000));
        try {
            rerender(<MarketplacePage identity={identity} isMember={true} />);
            expect(screen.queryByTestId('market-pinned-tile')).toBeNull();
            // It is still a post in the Market: in the stream now, drawn once.
            expect(screen.getAllByText('Ending Pin').length).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a pin that has ended leaves the list view\'s Pinned block at the next draw', async () => {
        localStorage.setItem('marketplace_view_mode', 'list');
        const ends = Date.now() + 60_000;
        const pin = makePost('pin-1', 'Ending Pin', { pinnedUntil: new Date(ends).toISOString(), pinnedAt: new Date(Date.now() - 1000).toISOString() });
        stubNode([pin, makePost('reg-1', 'Regular Post 1')]);
        const { rerender } = render(<MarketplacePage identity={identity} isMember={true} />);
        await waitFor(() => expect(screen.getByTestId('market-pinned-block')).toBeInTheDocument());
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(ends + 1000));
        try {
            rerender(<MarketplacePage identity={identity} isMember={true} />);
            expect(screen.queryByTestId('market-pinned-block')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('suppresses the pins under search narrowing (grid)', async () => {
        const pin1 = makePost('pin-1', 'Pinned Post', {
            pinnedAt: new Date(NOW - 1000).toISOString(),
            pinnedUntil: FUTURE_3D,
        });
        const reg1 = makePost('reg-1', 'Regular Post');

        stubNode([pin1, reg1]);

        render(<MarketplacePage identity={identity} isMember={true} />);

        await waitFor(() => {
            expect(screen.getByTestId('market-pinned-tile')).toBeInTheDocument();
        });

        // Type into search box
        const searchInput = screen.getByPlaceholderText(/Search/i);
        fireEvent.change(searchInput, { target: { value: 'Post' } });

        await waitFor(() => {
            expect(screen.queryByTestId('market-pinned-tile')).not.toBeInTheDocument();
            expect(screen.queryByTestId('market-pinned-block')).not.toBeInTheDocument();
            expect(screen.queryByTestId('market-pinned-heading')).not.toBeInTheDocument();
        });
    });

    it('suppresses the Pinned block under search narrowing (list)', async () => {
        localStorage.setItem('marketplace_view_mode', 'list');
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

        const searchInput = screen.getByPlaceholderText(/Search/i);
        fireEvent.change(searchInput, { target: { value: 'Post' } });

        await waitFor(() => {
            expect(screen.queryByTestId('market-pinned-block')).not.toBeInTheDocument();
            expect(screen.queryByTestId('market-pinned-heading')).not.toBeInTheDocument();
        });
    });

    it.each([['grid'], ['list']])('suppresses the pins when user has selected distance setting (near.from === "setting"), %s view', async (mode) => {
        localStorage.setItem('marketplace_view_mode', mode);
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

        // Under radiusSettings, the pins must be suppressed
        expect(screen.queryByTestId('market-pinned-block')).not.toBeInTheDocument();
        expect(screen.queryByTestId('market-pinned-tile')).not.toBeInTheDocument();
    });

    it.each([['grid'], ['list']])('does NOT render expired pins as pins, %s view', async (mode) => {
        localStorage.setItem('marketplace_view_mode', mode);
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

        // No live pins -> no pinned block, no pinned cell
        expect(screen.queryByTestId('market-pinned-block')).not.toBeInTheDocument();
        expect(screen.queryByTestId('market-pinned-tile')).not.toBeInTheDocument();
    });

    it.each([['grid', 'market-pinned-tile'], ['list', 'market-pinned-block']])('shows the pins on global area read where near.from === "area", %s view', async (mode, testid) => {
        localStorage.setItem('marketplace_view_mode', mode);
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
            // The pin is retained because near.from === 'area' (not 'setting')
            expect(screen.getByTestId(testid)).toBeInTheDocument();
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
