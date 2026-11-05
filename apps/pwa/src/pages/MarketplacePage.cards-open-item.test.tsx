/**
 * A tap anywhere on a small card opens the ITEM, never the owner's profile (Marty, 4 Nov 2026: "from small cards you should be
 * able to click anywhere on the card and have the card come up and then be able to click on the profile pic from there").
 *
 * The real Market page with its real cards (MarketplaceCard, PollCard), in each of its three views. A press on the author's
 * name opens the listing and calls no profile opener; the poll's poster is shown, not pressed; and on the listing's own page
 * "Posted by" is the button that opens the profile.
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
    id: 'offer-course', type: 'offer', category: 'education', title: 'Pottery course', description: 'Six weeks on the wheel', credits: 45,
    priceType: 'fixed', status: 'active', active: true, authorPublicKey: 'damo-pk', authorCallsign: 'Damo', createdAt: TODAY,
};
const poll = {
    id: 'poll-shed', type: 'poll', category: 'community', title: 'Where does the tool shed go?', description: 'North gate or south barn',
    credits: 0, priceType: 'fixed', status: 'active', active: true, authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: TODAY,
    pollOptions: [{ id: 'a', text: 'North gate', votes: 1, percentage: 50 }, { id: 'b', text: 'South barn', votes: 1, percentage: 50 }],
    pollClosesAt: new Date(Date.now() + 86_400_000).toISOString(), totalVotes: 2, userVotedOptionId: null,
};

function stubNode(posts: unknown[]) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) =>
        (f?.id ? (posts as Array<{ id: string }>).filter(p => p.id === f.id) : f?.author ? [] : posts) as any);
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

async function settle() {
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
});
afterEach(() => { cleanup(); });

describe('the Market: a small card opens its item, not its owner', () => {
    it.each(['grid', 'list', 'compact'] as const)('%s view: a press on the owner\'s name opens the listing; no profile opens', async (mode) => {
        localStorage.setItem('marketplace_view_mode', mode);
        stubNode([course]);
        const onOpenProfile = vi.fn();
        render(<MarketplacePage identity={identity} isMember={true} transactions={[]} onRefreshTransactions={() => {}} onOpenProfile={onOpenProfile} />);
        // One accessible element per card: a button that reads out as the listing, not as its owner.
        const card = await screen.findByRole('button', { name: 'Open listing: Pottery course' });
        expect(within(card).queryByRole('button', { name: /profile/i })).toBeNull();
        fireEvent.click(within(card).getByText(/Damo/));
        await screen.findByRole('heading', { name: /Pottery course/ });
        expect(onOpenProfile).not.toHaveBeenCalled();
    });

    it.each(['grid', 'list'] as const)('%s view: the photo is part of the card; a press on it opens the listing, and it holds no enlarge button', async (mode) => {
        localStorage.setItem('marketplace_view_mode', mode);
        stubNode([{ ...course, photos: ['/api/marketplace/posts/offer-course/photos/0?v=1&k=KEY0'] }]);
        render(<MarketplacePage identity={identity} isMember={true} transactions={[]} onRefreshTransactions={() => {}} onOpenProfile={() => {}} />);
        const card = await screen.findByRole('button', { name: 'Open listing: Pottery course' });
        // One accessible element per card: nothing inside it is a button, the photo included.
        expect(within(card).queryAllByRole('button')).toEqual([]);
        expect(screen.queryByRole('button', { name: /View enlarged photo/ })).toBeNull();
        const photo = within(card).getByAltText('Pottery course');
        expect(photo.closest('button')).toBeNull();
        fireEvent.click(photo);
        await screen.findByRole('heading', { name: /Pottery course/ });
    });

    it.each(['grid', 'list'] as const)('%s view: the card\'s owner is shown with nothing to press to reach a profile', async (mode) => {
        localStorage.setItem('marketplace_view_mode', mode);
        stubNode([course]);
        render(<MarketplacePage identity={identity} isMember={true} transactions={[]} onRefreshTransactions={() => {}} onOpenProfile={() => {}} />);
        await screen.findByRole('button', { name: 'Open listing: Pottery course' });
        expect(screen.queryByRole('button', { name: "View Damo's profile" })).toBeNull();
    });

    // Compact is below: since C1 the poll there is a compact row (the question, its status, your answer), with no poster on it.
    it.each(['grid', 'list'] as const)('%s view: a poll card shows its poster, with no profile button', async (mode) => {
        localStorage.setItem('marketplace_view_mode', mode);
        stubNode([poll]);
        const onOpenProfile = vi.fn();
        render(<MarketplacePage identity={identity} isMember={true} transactions={[]} onRefreshTransactions={() => {}} onOpenProfile={onOpenProfile} />);
        await screen.findByText('Where does the tool shed go?');
        expect(screen.getByText('Ada')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: "View Ada's profile" })).toBeNull();
        fireEvent.click(screen.getByText('Ada'));
        expect(onOpenProfile).not.toHaveBeenCalled();
    });

    // C1 (DESIGN-card-style-box-fable.md §2): the compact view's poll is a row like a listing's that opens the poll's page, as a
    // listing's row opens its own; its answers are on that page, never reachable from the row.
    it('compact view: the poll is one row with no poster and nothing to vote with; a press opens the poll\'s page', async () => {
        localStorage.setItem('marketplace_view_mode', 'compact');
        stubNode([poll]);
        const onOpenProfile = vi.fn();
        render(<MarketplacePage identity={identity} isMember={true} transactions={[]} onRefreshTransactions={() => {}} onOpenProfile={onOpenProfile} />);
        const row = await screen.findByRole('button', { name: /^Open poll: Where does the tool shed go\?/ });
        expect(within(row).queryAllByRole('button')).toEqual([]);
        expect(screen.queryByText('Ada')).toBeNull();
        expect(screen.queryByRole('button', { name: /North gate/ })).toBeNull();
        expect(screen.queryByRole('progressbar')).toBeNull();
        expect(api.getMarketplacePosts).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'poll-shed' }));
        fireEvent.click(row);
        // The poll's page: Back to Market, and the poll with its answers to press.
        await screen.findByRole('button', { name: /Back to Market/ });
        expect(screen.getByRole('button', { name: /North gate/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Open poll: / })).toBeNull();
        expect(onOpenProfile).not.toHaveBeenCalled();
    });

    it('on the listing\'s own page the person is the button that opens the profile', async () => {
        stubNode([course]);
        const onOpenProfile = vi.fn();
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-course" onPostOpened={() => {}}
            transactions={[]} onRefreshTransactions={() => {}} onOpenProfile={onOpenProfile} />);
        await screen.findByRole('heading', { name: /Pottery course/ });
        await settle();
        const posted = screen.getByText('Posted by').parentElement as HTMLElement;
        fireEvent.click(within(posted).getByRole('button'));
        expect(onOpenProfile).toHaveBeenCalledWith('damo-pk');
    });
});
