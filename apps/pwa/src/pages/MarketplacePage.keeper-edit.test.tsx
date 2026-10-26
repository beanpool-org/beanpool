/**
 * A keeper editing their enterprise's Offer or Need on the web, as on the phone (apps/native app/post/[id].tsx shows Edit to
 * the enterprise's keepers; Damo, 26 Oct). The listing page shows Edit to a member whose balance says they keep the
 * enterprise that listed it (keeperOf), opens the same form as for their own listing, and saves through the same call, the
 * member's own key named (the node takes it from a keeper: apps/server test-enterprise-post-edit-http). Pausing and deleting
 * it stay the author's here. A member who keeps nothing sees no Edit, and neither does a keeper of another enterprise.
 *
 * The listing's own words only: the cards, sheets and modals it draws are stubbed, as in MarketplacePage.deal-open.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('../components/MarketplaceCard', () => ({ MarketplaceCard: ({ post }: { post: { title: string } }) => <div data-testid="card-stub">{post.title}</div> }));
vi.mock('../components/PollCard', () => ({ PollCard: () => null }));
vi.mock('../components/EventCard', () => ({ EventCard: () => null, EventDetail: () => null }));
vi.mock('../components/YourEvents', () => ({ YourEvents: () => null }));
vi.mock('../components/CategoryPickerModal', () => ({ CategoryPickerModal: () => null }));
vi.mock('../components/MyDealsModal', () => ({ MyDealsModal: () => null }));
vi.mock('../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));
vi.mock('../components/ExampleListings', () => ({ ExampleListings: () => null }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));

const ME = 'me-pk';
const ENT = 'eggs-enterprise-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Damo', createdAt: '2026-09-17T00:00:00.000Z' };
const TODAY = new Date().toISOString();
const PHOTO = '/api/marketplace/posts/offer-eggs/photos/0?k=abc';

/** The enterprise's Offer, with a photo: written by the enterprise, listed by a keeper. */
const eggs = {
    id: 'offer-eggs', type: 'offer', category: 'food', title: 'Dozen eggs', description: 'Laid this week', credits: 6, priceType: 'fixed',
    status: 'active', active: true, repeatable: true, authorPublicKey: ENT, authorCallsign: 'Mullum Eggs', createdAt: TODAY, photos: [PHOTO],
    audienceScope: 'public',
};

function stubNode(posts: unknown[], keeperOf: string[]) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) =>
        (f?.id ? (posts as Array<{ id: string }>).filter(p => p.id === f.id) : f?.author ? [] : posts) as any);
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
    vi.spyOn(api, 'getTreasury').mockResolvedValue(null);
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 100, isBlockedFromTrading: false, keeperOf } as any);
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
async function openEggs() {
    render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-eggs" onPostOpened={() => {}} transactions={[]} />);
    await screen.findByRole('heading', { name: /Dozen eggs/ });
    await settle();
}

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
});
afterEach(() => { cleanup(); });

describe("a keeper editing their enterprise's listing on the web", () => {
    it('Edit for a keeper of the enterprise that listed it: the same form, saved with the member\'s own key, the saved listing shown', async () => {
        // The node's listings, as it answers them: the edit saved changes what it answers next.
        const listings: Array<Record<string, unknown>> = [eggs];
        stubNode(listings, [ENT]);
        const saved = { ...eggs, title: 'Dozen free-range eggs' };
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => {
            listings[0] = saved;
            return { success: true, post: saved } as any;
        });
        await openEggs();

        await waitFor(() => expect(screen.getByText('✏️ Edit Post')).toBeInTheDocument());
        // Edit only: pausing and deleting the enterprise's listing stay the author's on this page.
        expect(screen.queryByText('⏸️ Pause Offer')).toBeNull();
        expect(screen.queryByText('🗑️ Delete Post')).toBeNull();

        fireEvent.click(screen.getByText('✏️ Edit Post'));
        const title = screen.getByPlaceholderText('Title') as HTMLInputElement;
        expect(title.value).toBe('Dozen eggs');
        fireEvent.change(title, { target: { value: 'Dozen free-range eggs' } });
        await act(async () => { fireEvent.click(screen.getByText('💾 Save')); });

        await waitFor(() => expect(update).toHaveBeenCalled());
        expect(update).toHaveBeenCalledWith('offer-eggs', ME, {
            type: 'offer', category: 'food', title: 'Dozen free-range eggs', description: 'Laid this week', credits: 6, priceType: 'fixed',
            repeatable: true, photos: [PHOTO],
        });
        await waitFor(() => expect(screen.getByRole('heading', { name: /Dozen free-range eggs/ })).toBeInTheDocument());
        expect(screen.queryByText('💾 Save')).toBeNull();
    });

    it('a member who keeps nothing, or keeps another enterprise: no Edit', async () => {
        stubNode([eggs], []);
        await openEggs();
        expect(screen.queryByText('✏️ Edit Post')).toBeNull();
        cleanup();

        stubNode([eggs], ['another-enterprise-pk']);
        await openEggs();
        expect(screen.queryByText('✏️ Edit Post')).toBeNull();
    });

    it("a keeper and a listing that isn't for everyone here (a group's): no Edit, as the node takes none", async () => {
        const forGroup = { ...eggs, audienceScope: 'group', targetGroupId: 'g1' };
        stubNode([forGroup], [ENT]);
        await openEggs();
        expect(screen.queryByText('✏️ Edit Post')).toBeNull();
    });
});
