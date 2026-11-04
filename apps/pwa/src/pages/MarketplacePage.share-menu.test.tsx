/**
 * The Share menu on a real open listing (slice DW2, review of #2872): Escape closes the MENU and nothing else. The page closes
 * the open post on any Escape that reaches `window`; the menu's own Escape must not reach it, or the member who pressed Escape
 * to put the menu away is thrown back to the Market list. ShareMenu.test.tsx never renders the page, so it cannot see this.
 *
 * The cards, sheets and modals the page draws are stubbed, as in MarketplacePage.copy.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import * as features from '../lib/features';

vi.mock('../lib/features', async () => {
    const actual = await vi.importActual<typeof import('../lib/features')>('../lib/features');
    return { ...actual, useCommunityInfo: vi.fn() };
});
vi.mock('../lib/identity', async () => {
    const actual = await vi.importActual<typeof import('../lib/identity')>('../lib/identity');
    return { ...actual, loadIdentity: vi.fn(async () => ({ publicKey: 'me-pk', privateKey: 'sk', callsign: 'Mia', createdAt: '2026-09-17T00:00:00.000Z' })) };
});
vi.mock('../lib/invite-asks', async () => {
    const actual = await vi.importActual<typeof import('../lib/invite-asks')>('../lib/invite-asks');
    return { ...actual, askAnAdmin: vi.fn(async () => ({ ok: true })), readMyAsks: vi.fn(async () => null) };
});

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
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Mia', createdAt: '2026-09-17T00:00:00.000Z' };

const plain = {
    id: 'plain-1', type: 'offer', category: 'food', title: 'Plain loaves', description: 'Fresh this morning', credits: 12, priceType: 'fixed',
    status: 'active', active: true, repeatable: false, authorPublicKey: 'damo-pk', authorCallsign: 'Damo', createdAt: new Date().toISOString(),
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

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });
const openListing = async () => {
    render(<MarketplacePage identity={identity} isMember={true} openPostId="plain-1" onPostOpened={() => {}} transactions={[]} />);
    await screen.findByRole('heading', { name: /Plain loaves/ });
    await settle();
};

/** A community where only admins invite and this member is no admin: the Share menu holds Share with members and the Ask. */
const askOffered = () => {
    vi.mocked(features.useCommunityInfo).mockReturnValue({ profile: 'local', features: { door: 'admins', shareOutside: false, inviteAsks: true } } as any);
    vi.spyOn(api, 'myNodeRoleOnce').mockResolvedValue(null);
};

beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); vi.mocked(features.useCommunityInfo).mockReturnValue(null as any); });
afterEach(cleanup);

describe('the Share menu on an open listing (web)', () => {
    it('Escape closes the menu and leaves the listing open, with focus back on the Share button', async () => {
        stubNode([plain]);
        await openListing();

        fireEvent.click(screen.getByTestId('share-button'));
        const item = screen.getByTestId('share-members-button');
        await waitFor(() => expect(document.activeElement).toBe(item));

        fireEvent.keyDown(item, { key: 'Escape' });

        expect(screen.queryByRole('menu')).toBeNull();
        // Still on the listing: its heading and its Share button are there.
        expect(screen.getByRole('heading', { name: /Plain loaves/ })).toBeInTheDocument();
        expect(screen.getByTestId('share-button')).toBeInTheDocument();
        await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('share-button')));
    });

    it('with no menu open, Escape still closes the listing, as it always did', async () => {
        stubNode([plain]);
        await openListing();
        expect(screen.getByTestId('share-button')).toBeInTheDocument();

        fireEvent.keyDown(screen.getByTestId('share-button'), { key: 'Escape' });

        await waitFor(() => expect(screen.queryByTestId('share-button')).toBeNull());
    });

    it('Escape on the ask form closes the form and leaves the listing open', async () => {
        askOffered();
        stubNode([plain]);
        await openListing();

        fireEvent.click(screen.getByTestId('share-button'));
        await waitFor(() => expect(screen.getByTestId('share-ask-admin-button')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('share-ask-admin-button'));
        const first = await screen.findByTestId('invite-ask-first-name');
        await waitFor(() => expect(document.activeElement).toBe(first));

        fireEvent.keyDown(first, { key: 'Escape' });

        expect(screen.queryByTestId('invite-ask-sheet')).toBeNull();
        expect(screen.getByRole('heading', { name: /Plain loaves/ })).toBeInTheDocument();
        await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('share-button')));
    });
});
