/**
 * The web Market's width by view (style box V1: DESIGN-card-style-box-fable.md §0.1 item 4, §4 row V1; Marty, 4 Nov 2026: "the
 * three views on pwa ... maybe if it was in phone view size it might?").
 *
 * The grid uses the width (max-w-7xl, as before: 2 to 5 columns). The list and the compact view are a phone-width column, 672 px
 * at most (max-w-2xl), centred beside the sidebar, so a card never stretches across a 2,500 px window. The search row, the
 * filters, the headings and the cards are all in that one column. The detail pages keep their own max-w-3xl column.
 *
 * The real Market page with its real cards (MarketplaceCard, PollCard), as in MarketplacePage.cards-open-item.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null), saveRadiusSettings: vi.fn(), clearRadiusSettings: vi.fn(), haversineDistance: vi.fn(() => 0),
}));
vi.mock('../lib/peer-prefs', () => ({ loadEnabledPeers: vi.fn(() => new Set()), togglePeer: vi.fn() }));
vi.mock('../lib/profile-status', async (orig) => ({
    ...(await orig<typeof import('../lib/profile-status')>()),
    getProfileStatus: vi.fn(async () => ({ complete: true, missingName: false, missingAvatar: false })),
}));
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => ({})), joinInFlight: vi.fn(async () => false) }));
vi.mock('../components/EventCard', () => ({ EventCard: () => null, EventDetail: () => null }));
vi.mock('../components/YourEvents', () => ({ YourEvents: () => null }));
vi.mock('../components/CategoryPickerModal', () => ({ CategoryPickerModal: () => null }));
vi.mock('../components/MyDealsModal', () => ({ MyDealsModal: () => null }));
vi.mock('../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));
vi.mock('../components/ExampleListings', () => ({ ExampleListings: () => null }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Mia', createdAt: '2026-09-17T00:00:00.000Z' };
const TODAY = new Date().toISOString();

const course = {
    id: 'offer-course', type: 'offer', category: 'education', title: 'Pottery course', description: 'Six weeks on the wheel', price_c: 4500,
    priceType: 'fixed', status: 'active', active: true, authorPublicKey: 'damo-pk', authorCallsign: 'Damo', createdAt: TODAY,
};
const poll = {
    id: 'poll-shed', type: 'poll', category: 'community', title: 'Where does the tool shed go?', description: 'North gate or south barn',
    price_c: 0, priceType: 'fixed', status: 'active', active: true, authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: TODAY,
    pollOptions: [{ id: 'a', text: 'North gate', votes: 1, percentage: 50 }, { id: 'b', text: 'South barn', votes: 1, percentage: 50 }],
    pollClosesAt: new Date(Date.now() + 86_400_000).toISOString(), totalVotes: 2, userVotedOptionId: null,
};
// One pinned listing, so the list and compact views draw their Pinned heading and block.
const pinned = {
    ...course, id: 'offer-pinned', title: 'Pinned honey', pinnedAt: new Date(Date.now() - 1000).toISOString(),
    pinnedUntil: new Date(Date.now() + 3 * 86_400_000).toISOString(),
};

function stubNode(posts: unknown[]) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) =>
        (f?.id ? (posts as Array<{ id: string }>).filter(p => p.id === f.id) : f?.author ? [] : posts) as any);
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

async function settle() {
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

function renderMarket(mode?: 'grid' | 'list' | 'compact') {
    if (mode) localStorage.setItem('marketplace_view_mode', mode);
    stubNode([course, poll, pinned]);
    return render(<MarketplacePage identity={identity} isMember={true} transactions={[]} onRefreshTransactions={() => {}} onOpenProfile={() => {}} />);
}

/** The one column the Market page draws in. */
const column = () => screen.getByTestId('market-view-column');
const widthClass = (el: HTMLElement) => el.className.split(/\s+/).filter(c => /^max-w-/.test(c));

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
});
afterEach(() => { cleanup(); });

describe('the web Market: the grid uses the width, the list and the compact view are a phone-width column', () => {
    it('grid (the default): the page column is max-w-7xl, centred and full width, as before', async () => {
        renderMarket();
        await screen.findByText('Pottery course');
        expect(widthClass(column())).toEqual(['max-w-7xl']);
        expect(column().className).toMatch(/\bmx-auto\b/);
        expect(column().className).toMatch(/\bw-full\b/);
    });

    it.each(['list', 'compact'] as const)('%s view: the page column is max-w-2xl (672 px at most), centred and full width', async (mode) => {
        renderMarket(mode);
        await screen.findByText('Pottery course');
        expect(widthClass(column())).toEqual(['max-w-2xl']);
        expect(column().className).toMatch(/\bmx-auto\b/);
        expect(column().className).toMatch(/\bw-full\b/);
    });

    it.each(['grid', 'list', 'compact'] as const)('%s view: the search row, the filters, the headings and every card are inside the column', async (mode) => {
        renderMarket(mode);
        await screen.findByText('Pottery course');
        const col = column();
        expect(col.contains(screen.getByPlaceholderText('Search marketplace...'))).toBe(true);
        expect(col.contains(screen.getByTestId('feed-type-filter'))).toBe(true);
        for (const title of ['Pottery course', 'Where does the tool shed go?', 'Pinned honey']) {
            expect(col.contains(screen.getByText(title))).toBe(true);
        }
        if (mode !== 'grid') {
            // The Pinned and day headings of the list and compact views.
            expect(col.contains(screen.getByTestId('market-pinned-heading'))).toBe(true);
            expect(col.contains(screen.getByTestId('market-pinned-block'))).toBe(true);
        }
        // Nothing of the Market page sits beside the column: it is the page's one wrapper.
        expect(col.parentElement?.children.length).toBe(1);
    });

    it('the view button changes the column: grid, list, compact, back to grid', async () => {
        renderMarket();
        await screen.findByText('Pottery course');
        const toggle = () => screen.getByRole('button', { name: /^Switch to (List|Compact|Card) View$/ });
        expect(widthClass(column())).toEqual(['max-w-7xl']);
        fireEvent.click(toggle());
        expect(widthClass(column())).toEqual(['max-w-2xl']);
        fireEvent.click(toggle());
        expect(widthClass(column())).toEqual(['max-w-2xl']);
        fireEvent.click(toggle());
        expect(widthClass(column())).toEqual(['max-w-7xl']);
        // The same page throughout: the search box keeps what was typed while the column changes.
        fireEvent.change(screen.getByPlaceholderText('Search marketplace...'), { target: { value: 'pot' } });
        fireEvent.click(toggle());
        expect(widthClass(column())).toEqual(['max-w-2xl']);
        expect(screen.getByPlaceholderText('Search marketplace...')).toHaveValue('pot');
    });

    it('a listing\'s own page keeps its max-w-3xl column; it is not the view column', async () => {
        renderMarket('list');
        const card = await screen.findByRole('button', { name: 'Open listing: Pottery course' });
        fireEvent.click(card);
        const heading = await screen.findByRole('heading', { name: /Pottery course/ });
        await settle();
        expect(screen.queryByTestId('market-view-column')).toBeNull();
        const page = heading.closest('.max-w-3xl') as HTMLElement | null;
        expect(page).not.toBeNull();
        expect(within(page!).getByRole('heading', { name: /Pottery course/ })).toBeInTheDocument();
        expect(page!.className).not.toMatch(/max-w-2xl|max-w-7xl/);
    });
});
