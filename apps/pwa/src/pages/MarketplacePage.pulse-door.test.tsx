/**
 * The Pulse's door at the top of the Market on the web (scratch/fable-design/DESIGN-pulse-home-fable.md §3.1, slice P3;
 * Marty's pick 1 of 14 Nov 2026): "📡 Pulse ›" is the first chip under the type pills, in the row that wraps, under every
 * pill (Events too). Blue from the central tokens (the Pulse card's band), it opens the Pulse and asks the node for nothing
 * itself; the Market's feed, its pills and its filters are untouched. Reading the Pulse is members' only: no door for a
 * visitor. The real page, the node stubbed at lib/api (the harness of MarketplacePage.learn.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

const info = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

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
vi.mock('../components/MyDealsModal', () => ({ MyDealsModal: () => null }));
vi.mock('../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));
vi.mock('../components/ExampleListings', () => ({ ExampleListings: () => <p>the example cards</p> }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Damo', createdAt: '2026-09-17T00:00:00.000Z' };
const AT = new Date(Date.now() - 60_000).toISOString();
const listing = (id: string, title: string) => ({
    id, type: 'offer', category: 'general', title, description: '', price_c: 500, priceType: 'fixed', status: 'active', active: true,
    authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: AT, updatedAt: AT, photos: [], audienceScope: 'public',
});

const node = { feed: [listing('l1', 'Eggs')] as unknown[], learn: { total: 2, fail: false }, pages: [] as unknown[], pageFail: false };
let request: MockInstance<typeof api.request>;

function stubNode() {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) => {
        if (f?.id) return (node.feed as Array<{ id: string }>).filter(p => p.id === f.id) as any;
        if (f?.author) return [] as any;
        return node.feed as any;
    });
    request = vi.spyOn(api, 'request').mockImplementation((async (_m: string, path: string) => {
        if (path.startsWith('/api/knowledge/front?q=')) {
            if (node.learn.fail) throw new Error('offline');
            return { total: node.learn.total, rows: [] };
        }
        if (path.startsWith('/api/marketplace/posts?type=knowledge')) {
            if (node.pageFail) throw new Error('offline');
            const id = new URLSearchParams(path.split('?')[1]).get('id');
            return (node.pages as Array<{ id: string }>).filter((p) => p.id === id);
        }
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
const learnAsked = () => request.mock.calls.map((c) => String(c[1])).filter((p) => p.startsWith('/api/knowledge/front'));
const marketReads = () => vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => (f ?? {}) as Record<string, any>);
async function openMarket(props: Record<string, unknown> = {}) {
    render(<MarketplacePage identity={identity} isMember={true} transactions={[]} {...props} />);
    await wait(60);
}

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    info.current = { features: {} };
    node.feed = [listing('l1', 'Eggs')];
    stubNode();
});
afterEach(() => { cleanup(); });

const door = () => screen.queryByTestId('market-pulse-door');

describe('the Pulse door under the type pills (P3)', () => {
    it('is the first chip of the row under the pills, blue from the tokens, and opens the Pulse', async () => {
        const onNavigate = vi.fn();
        await openMarket({ onNavigate });
        const d = door()!;
        expect(d).not.toBeNull();
        expect(d.parentElement!.firstElementChild).toBe(d);
        // The row under the type pills, and the row wraps rather than scrolling sideways (320 px).
        const pills = screen.getByTestId('feed-type-filter');
        expect(pills.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        expect(d.parentElement!.className).toMatch(/\bflex-wrap\b/);
        expect(d.textContent).toBe('📡 Pulse ›');
        expect(d).toHaveAttribute('aria-label', 'Open the Pulse');
        expect(d.style.backgroundColor).toBe('var(--bp-card-blue-tint)');
        expect(d.style.color).toBe('var(--bp-card-blue-ink)');
        expect(d.className).toMatch(/min-h-\[44px\]/);
        const reads = vi.mocked(api.getMarketplacePosts).mock.calls.length;
        fireEvent.click(d);
        expect(onNavigate).toHaveBeenCalledWith('pulse');
        // The door asks the node for nothing itself.
        expect(vi.mocked(api.getMarketplacePosts).mock.calls.length).toBe(reads);
    });

    it('is still there, still first, under Events; the six pills are as they were', async () => {
        await openMarket({ onNavigate: vi.fn() });
        expect(Array.from(screen.getByTestId('feed-type-filter').querySelectorAll('button')).map((b) => b.textContent ?? ''))
            .toEqual(['All', '★ For You', '🟢 Offers', '🟠 Needs', 'Events', '🗳️ Polls']);
        fireEvent.click(screen.getByRole('button', { name: 'Events' }));
        await wait(30);
        const d = door()!;
        expect(d).not.toBeNull();
        expect(d.parentElement!.firstElementChild).toBe(d);
    });

    it('a visitor, who cannot read the Pulse, is not shown the door', async () => {
        await openMarket({ onNavigate: vi.fn(), visitor: { joinCard: null, onJoin: vi.fn(), beans: false } });
        expect(door()).toBeNull();
    });
});
