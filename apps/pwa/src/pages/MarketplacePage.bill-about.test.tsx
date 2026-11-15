/**
 * Round 2 of #3210 (getting paid B2), finding 3: a bill's "About: <listing> ›" from Your deals → Bills opens that listing by
 * id, as the phone's /post/<id> does: the one in the feed, else the node's read of it by id (a filter, a search or a read by
 * area need not hold it); one gone says so, and so does a read that failed. And no way out of Your deals leaves a door's
 * Bills tab as where it opens next time. The real page, the node stubbed at lib/api (the harness of
 * MarketplacePage.pulse-door.test.tsx); Your deals is a stub that hands back the page's own props.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

const info = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const deals = vi.hoisted(() => ({ props: null as null | Record<string, any> }));

vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => info.current), joinInFlight: vi.fn(async () => false) }));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useFeatureMode: () => 'live',
}));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null), saveRadiusSettings: vi.fn(), clearRadiusSettings: vi.fn(), haversineDistance: vi.fn(() => 0),
}));
vi.mock('../lib/peer-prefs', () => ({ loadEnabledPeers: vi.fn(() => new Set<string>()), togglePeer: vi.fn() }));
vi.mock('../lib/profile-status', async (orig) => ({
    ...(await orig<typeof import('../lib/profile-status')>()),
    getProfileStatus: vi.fn(async () => ({ complete: true, missingName: false, missingAvatar: false })),
}));
vi.mock('../components/MarketplaceCard', () => ({ MarketplaceCard: ({ post }: { post: { title: string } }) => <div data-testid="card-stub">{post.title}</div> }));
vi.mock('../components/PollCard', () => ({ PollCard: () => null }));
vi.mock('../components/EventCard', () => ({ EventCard: () => null, EventDetail: () => null }));
vi.mock('../components/YourEvents', () => ({ YourEvents: () => null }));
vi.mock('../components/CategoryPickerModal', () => ({ CategoryPickerModal: () => null }));
vi.mock('../components/MyDealsModal', () => ({
    MyDealsModal: (props: Record<string, any>) => {
        deals.props = props;
        return props.visible ? <div data-testid="deals-stub" data-tab={props.initialTab} /> : null;
    },
}));
vi.mock('../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));
vi.mock('../components/ExampleListings', () => ({ ExampleListings: () => null }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Kim', createdAt: '2026-09-17T00:00:00.000Z' };
const AT = new Date(Date.now() - 60_000).toISOString();
const listing = (id: string, title: string) => ({
    id, type: 'offer', category: 'general', title, description: '', price_c: 500, priceType: 'fixed', status: 'active', active: true,
    authorPublicKey: 'rob-pk', authorCallsign: 'Rob', createdAt: AT, updatedAt: AT, photos: [], audienceScope: 'public',
});

// The feed holds Eggs only; the node can read "Room at Rob's" by id (not in the feed: a filter, a search, a read by area).
const node = { feed: [listing('l1', 'Eggs')] as unknown[], byId: [listing('room-1', "Room at Rob's")] as unknown[], byIdFails: false };

function stubNode() {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) => {
        if (f?.id) {
            if (node.byIdFails) throw new TypeError('Failed to fetch');
            return ([...node.feed, ...node.byId] as Array<{ id: string }>).filter(p => p.id === f.id) as any;
        }
        if (f?.author) return [] as any;
        return node.feed as any;
    });
    vi.spyOn(api, 'request').mockImplementation((async (_m: string, path: string) => {
        if (path.startsWith('/api/knowledge/front?q=')) return { total: 0, rows: [] };
        throw new Error(`unexpected ${path}`);
    }) as never);
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
    vi.spyOn(api, 'getTreasury').mockResolvedValue(null);
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance_c: 10000, isBlockedFromTrading: false, keeperOf: [] } as any);
    vi.spyOn(api, 'getGroups').mockResolvedValue([]);
    vi.spyOn(api, 'getCommissionCapacity').mockResolvedValue({ links: [] });
    vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: ME } as any);
    vi.spyOn(api, 'getMemberProfile').mockResolvedValue({ avatar: null, bio: '' } as any);
    vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ ratings: [], average: 0, count: 0 } as any);
    vi.spyOn(api, 'getRatingsGiven').mockResolvedValue({ ratings: [] });
    vi.spyOn(api, 'getMyMarketplaceTransactions').mockResolvedValue([]);
    vi.spyOn(api, 'getRemotePosts').mockResolvedValue([]);
}

const wait = async (ms: number) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };

/** The Market, opened by a bill's door: Your deals on its Bills tab. */
async function openOnABill() {
    render(<MarketplacePage identity={identity} isMember={true} transactions={[]} onNavigate={vi.fn()} openPostId="bill:bill-0001" onPostOpened={vi.fn()} />);
    await wait(60);
    expect(screen.getByTestId('deals-stub').getAttribute('data-tab')).toBe('bills');
}
/** The bill's About, as the Bills panel calls it (MyDealsModal hands BillsPanel `onNavigateToPost` as its `onOpenPost`). */
async function about(postId: string) {
    await act(async () => { deals.props!.onNavigateToPost(postId); });
    await wait(30);
}

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    info.current = { features: { bills: true } };
    node.feed = [listing('l1', 'Eggs')];
    node.byIdFails = false;
    deals.props = null;
    stubNode();
});
afterEach(() => { cleanup(); });

describe('a bill\'s "About: <listing> ›" opens the listing by id, and leaves no Bills tab behind', () => {
    it('a listing not in the feed: Your deals closes, the node reads it by id, and its page opens', async () => {
        await openOnABill();
        await about('room-1');
        expect(screen.queryByTestId('deals-stub')).toBeNull();
        expect(vi.mocked(api.getMarketplacePosts).mock.calls.some(([f]) => (f as any)?.id === 'room-1')).toBe(true);
        expect(screen.getAllByText("Room at Rob's").length).toBeGreaterThan(0);
        expect(screen.queryByTestId('card-stub')).toBeNull();
    });

    it('a listing in the feed opens at once, with no read', async () => {
        await openOnABill();
        const reads = vi.mocked(api.getMarketplacePosts).mock.calls.length;
        await about('l1');
        expect(vi.mocked(api.getMarketplacePosts).mock.calls.length).toBe(reads);
        expect(screen.getAllByText('Eggs').length).toBeGreaterThan(0);
        expect(screen.queryByTestId('card-stub')).toBeNull();
    });

    it('a listing gone says so on the Market; a read that failed says so', async () => {
        await openOnABill();
        await about('gone-1');
        expect(screen.getByRole('status').textContent).toContain('That listing can no longer be opened. It may have been taken down.');
        cleanup();
        node.byIdFails = true;
        await openOnABill();
        await about('room-1');
        expect(screen.getByRole('status').textContent).toContain("That listing couldn't be loaded. Check your connection and try again.");
    });

    it("the Market's own Your deals opens on In Progress after any way out, never on a door's Bills", async () => {
        for (const leave of [() => deals.props!.onNavigateToPost('l1'), () => deals.props!.onPromptReview({ txId: 't', targetPubkey: 'p', targetCallsign: 'R', targetRole: 'provider' }),
            () => deals.props!.onNearYou(), () => deals.props!.onGuide('bills'), () => deals.props!.onClose()]) {
            await openOnABill();
            await act(async () => { leave(); });
            await wait(30);
            expect(deals.props!.visible).toBe(false);
            expect(deals.props!.initialTab, String(leave)).toBe('pending');
            cleanup();
        }
    });
});
