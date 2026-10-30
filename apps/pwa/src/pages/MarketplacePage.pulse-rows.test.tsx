/**
 * The full Community Pulse list on an empty Market opens what a row names (Marty, 30 Oct): MarketplacePage hands the full
 * view the same two openers it hands the Live Pulse strip. ActivityWaterfall is a stand-in that records what it was given;
 * the rows themselves are tested in components/ActivityWaterfall.rows.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('../components/MarketplaceCard', () => ({ MarketplaceCard: () => null }));
vi.mock('../components/PollCard', () => ({ PollCard: () => null }));
vi.mock('../components/EventCard', () => ({ EventCard: () => null, EventDetail: () => null }));
vi.mock('../components/YourEvents', () => ({ YourEvents: () => null }));
vi.mock('../components/CategoryPickerModal', () => ({ CategoryPickerModal: () => null }));
vi.mock('../components/MyDealsModal', () => ({ MyDealsModal: () => null }));
vi.mock('../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../components/ExampleListings', () => ({ ExampleListings: () => null }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));

const given = vi.hoisted(() => ({ full: null as null | Record<string, unknown> }));
vi.mock('../components/ActivityWaterfall', () => ({
    ActivityWaterfall: (props: Record<string, unknown>) => {
        if (props.isFullView) given.full = props;
        return null;
    },
}));

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Mia', createdAt: '2026-09-17T00:00:00.000Z' };
const fair = {
    id: 'post-1', type: 'offer', category: 'goods', title: 'Record Fair', description: 'Vinyl swap', credits: 10,
    priceType: 'fixed', status: 'active', active: true, authorPublicKey: 'damo-pk', authorCallsign: 'Damo', createdAt: new Date().toISOString(),
};

function stubNode(posts: unknown[]) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) =>
        (f?.id ? (posts as Array<{ id: string }>).filter(p => p.id === f.id) : []) as any);
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

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    given.full = null;
});
afterEach(() => { cleanup(); });

describe('the empty Market\'s full Community Pulse list', () => {
    it('is handed an opener for listings and one for profiles', async () => {
        stubNode([fair]);
        const onOpenProfile = vi.fn();
        render(<MarketplacePage identity={identity} isMember={true} transactions={[]} onRefreshTransactions={() => {}} onOpenProfile={onOpenProfile} />);
        await waitFor(() => expect(given.full).not.toBeNull());
        expect(typeof given.full!.onOpenPost).toBe('function');
        expect(given.full!.onOpenProfile).toBe(onOpenProfile);
    });

    it('opening a row\'s listing asks the node for it and shows it', async () => {
        stubNode([fair]);
        render(<MarketplacePage identity={identity} isMember={true} transactions={[]} onRefreshTransactions={() => {}} onOpenProfile={() => {}} />);
        await waitFor(() => expect(given.full).not.toBeNull());
        await act(async () => { (given.full!.onOpenPost as (id: string) => void)('post-1'); });
        await screen.findByRole('heading', { name: /Record Fair/ });
    });
});
