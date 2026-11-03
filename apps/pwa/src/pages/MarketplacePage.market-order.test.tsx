/**
 * The web Market's order is the phone's (market order S2, DESIGN-market-order-fable.md; core market-order):
 * - newest LISTED first under Today / Yesterday / This Week / Older Listings, by the LOCAL CALENDAR DAY (not rolling 24 h);
 * - an event posted weeks ago comes back among the day's posts the day before it starts, and on a local community it is read
 *   beside the listings (the page is the newest changed 50, which it is not in) and merged by id;
 * - no author takes more than two places in a day until the others have had theirs;
 * - the Events pill stays soonest first, under no heading.
 * The clock is fixed (Date only) at 15:00 local on 3 Nov 2026.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
vi.mock('../components/MarketplaceCard', () => ({
    MarketplaceCard: ({ post }: { post: any }) => <div data-testid="market-post-card">{post.title}</div>,
}));
vi.mock('../components/EventCard', () => ({
    EventCard: ({ post }: { post: any }) => <div data-testid="market-post-card">{post.title}</div>,
    EventDetail: () => null,
}));

const ME = 'member-me';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'mock-key', callsign: 'Me', createdAt: '2026-09-01T00:00:00.000Z' };

// 15:00 local on Tuesday 3 Nov 2026.
const NOW = new Date(2026, 10, 3, 15, 0, 0);
const local = (month: number, day: number, hour = 12, minute = 0) => new Date(2026, month, day, hour, minute).toISOString();

const offer = (id: string, title: string, author: string, createdAt: string) => ({
    id, type: 'offer', category: 'goods', title, description: '', credits: 5, priceType: 'fixed', status: 'active', active: true,
    authorPublicKey: author, authorCallsign: author, createdAt, updatedAt: createdAt,
});
const event = (id: string, title: string, createdAt: string, start: Date) => ({
    ...offer(id, title, 'host', createdAt), type: 'event', category: 'events',
    eventStartAt: start.toISOString(), eventEndAt: new Date(start.getTime() + 2 * 3600_000).toISOString(), eventState: 'scheduled',
});

// Today: Ana posted three (14:00, 13:30, 13:00), Lee one (12:00). Yesterday 23:59 (under 24 h ago: a rolling block says Today).
const anaFirst = offer('ana-1', 'Ana first', 'ana', local(10, 3, 14, 0));
const anaSecond = offer('ana-2', 'Ana second', 'ana', local(10, 3, 13, 30));
const anaThird = offer('ana-3', 'Ana third', 'ana', local(10, 3, 13, 0));
const lee = offer('lee-1', 'Lee lemons', 'lee', local(10, 3, 12, 0));
const lateLastNight = offer('sam-1', 'Late last night', 'sam', local(10, 2, 23, 59));
// An event posted six weeks ago, starting tomorrow 10:00: listed again today at 10:00 (24 h before). Not in the node's page.
const repairCafe = event('ev-1', 'Repair Cafe', local(8, 20, 9, 0), new Date(2026, 10, 4, 10, 0));
// Posted 30 Oct (four days ago), starts next week: not yet back; it sits where it was posted.
const gardenDay = event('ev-2', 'Garden day', local(9, 30, 9, 0), new Date(2026, 10, 10, 9, 0));

function stubNode(feed: any[], events: any[]) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) => {
        if (f?.author) return [] as any;
        if (f?.id) return [...feed, ...events].filter(p => p.id === f.id) as any;
        if (f?.type === 'event') return events as any;
        return feed as any;
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

/** The headings and the cards, in the order they are on the page. */
const page = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-testid="market-post-card"], span.tracking-widest')).map(e => e.textContent?.trim() ?? '');

describe('MarketplacePage: the Market\'s order (market order S2)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        info.current = { profile: 'local', features: { beans: true } };
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
    });
    afterEach(() => { vi.useRealTimers(); });

    it('list view: newest listed first under the calendar days, an event back the day before, the third post of a day after the others', async () => {
        localStorage.setItem('marketplace_view_mode', 'list');
        // The node's page is the newest changed: it has no Repair Cafe (posted six weeks ago, not changed since).
        stubNode([lee, anaThird, lateLastNight, anaFirst, gardenDay, anaSecond], [repairCafe, gardenDay]);
        const { container } = render(<MarketplacePage identity={identity} isMember={true} />);
        await waitFor(() => expect(screen.getAllByTestId('market-post-card').length).toBe(7));

        expect(page(container)).toEqual([
            'Today', 'Ana first', 'Ana second', 'Lee lemons', 'Repair Cafe', 'Ana third',
            // 23:59 last night is Yesterday by the calendar day, though it is under 24 hours ago.
            'Yesterday', 'Late last night',
            'This Week', 'Garden day',
        ]);
    });

    it('a pinned post is out of the stream: it is the Pinned block, and does not count towards its author\'s two places', async () => {
        localStorage.setItem('marketplace_view_mode', 'list');
        const pinned = { ...offer('ana-pin', 'Ana pinned', 'ana', local(10, 3, 14, 30)), pinnedAt: local(10, 3, 14, 31), pinnedUntil: local(10, 10, 14, 31) };
        stubNode([lee, anaThird, anaFirst, pinned, anaSecond], []);
        const { container } = render(<MarketplacePage identity={identity} isMember={true} />);
        await waitFor(() => expect(screen.getAllByTestId('market-post-card').length).toBe(5));
        // Ana's first two are still the first two of the day, and her third after Lee, as if the pin were not there.
        expect(page(container)).toEqual(['Pinned', 'Ana pinned', 'Today', 'Ana first', 'Ana second', 'Lee lemons', 'Ana third']);
    });

    it('grid view: the same order, no headings', async () => {
        localStorage.setItem('marketplace_view_mode', 'grid');
        stubNode([lee, anaThird, lateLastNight, anaFirst, gardenDay, anaSecond], [repairCafe, gardenDay]);
        const { container } = render(<MarketplacePage identity={identity} isMember={true} />);
        await waitFor(() => expect(screen.getAllByTestId('market-post-card').length).toBe(7));
        expect(page(container)).toEqual(['Ana first', 'Ana second', 'Lee lemons', 'Repair Cafe', 'Ana third', 'Late last night', 'Garden day']);
    });

    it('on a local community the events are read beside the listings, as type=event, and merged by id', async () => {
        stubNode([lee], [repairCafe, gardenDay]);
        render(<MarketplacePage identity={identity} isMember={true} />);
        await waitFor(() => expect(screen.getAllByTestId('market-post-card').length).toBe(3));
        const reads = vi.mocked(api.getMarketplacePosts).mock.calls.map(c => c[0] as any);
        expect(reads.filter(f => f?.type === 'event' && !f?.types)).toHaveLength(1);
    });

    it('the Events pill is soonest first under no heading', async () => {
        localStorage.setItem('marketplace_view_mode', 'list');
        stubNode([lee], [gardenDay, repairCafe]);
        const { container } = render(<MarketplacePage identity={identity} isMember={true} />);
        await waitFor(() => expect(screen.getAllByTestId('market-post-card').length).toBe(3));
        fireEvent.click(await screen.findByRole('button', { name: /events/i }));
        await waitFor(() => expect(page(container)).toEqual(['Repair Cafe', 'Garden day']));
    });
});
