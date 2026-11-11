/**
 * The Market and Learn (slice K2; DESIGN-local-knowledge-amend-fable.md §2.7, §3.9, A8): the Market keeps its six pills and
 * reads nothing about Local knowledge. It never asks for a page, on any pill, with or without words. While words are typed and
 * Learn has a match it shows ONE line that opens Learn; and a link to a page, which the Market cannot open as a listing, lands
 * in Learn instead of "That listing can no longer be opened". The real page, the node stubbed at lib/api.
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
const knowledgePage = (id: string) => ({
    id, type: 'knowledge', category: 'local-services', title: 'How the tip works', description: 'Sort glass.', authorPublicKey: 'ada-pk', authorCallsign: 'Ada',
    createdAt: AT, status: 'active', knowledge: { sources: [], place: null, lang: null, checkedAt: AT, outdatedAt: null, outdatedNote: null, helped: 0, gathered: false },
});

const node = { feed: [listing('l1', 'Eggs')] as unknown[], learn: { total: 2, fail: false }, pages: [] as unknown[] };
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
async function typeWords(words: string) {
    fireEvent.change(screen.getByPlaceholderText('Search marketplace...'), { target: { value: words } });
    await wait(380);
}

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    info.current = { features: { knowledge: true } };
    node.feed = [listing('l1', 'Eggs')];
    node.learn = { total: 2, fail: false };
    node.pages = [];
    stubNode();
});
afterEach(() => { cleanup(); });

describe('the one line about Learn', () => {
    it('sits above the results while words are typed and Learn has a match, and opens Learn with the words', async () => {
        const onNavigate = vi.fn();
        await openMarket({ onNavigate });
        expect(screen.queryByTestId('market-learn-line')).toBeNull();
        await typeWords('tip');
        const line = screen.getByTestId('market-learn-line');
        expect(line.textContent).toBe('📖 In Learn: 2 for "tip" ›');
        expect(learnAsked()).toEqual(['/api/knowledge/front?q=tip']);
        const results = screen.getByTestId('card-stub');
        expect(line.compareDocumentPosition(results) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        fireEvent.click(line);
        expect(onNavigate).toHaveBeenCalledWith('learn-search', 'tip');
    });

    it('is there in the empty state too, and goes when the words are cleared', async () => {
        node.feed = [];
        await openMarket({ onNavigate: vi.fn() });
        await typeWords('tip');
        expect(screen.getByTestId('market-learn-line')).toBeInTheDocument();
        fireEvent.change(screen.getByPlaceholderText('Search marketplace...'), { target: { value: '' } });
        await wait(60);
        expect(screen.queryByTestId('market-learn-line')).toBeNull();
    });

    it('shows nothing for no match, nothing for a failed count (never an error), nothing where Learn is off, nothing to a non-member', async () => {
        node.learn = { total: 0, fail: false };
        await openMarket({ onNavigate: vi.fn() });
        await typeWords('tip');
        expect(screen.queryByTestId('market-learn-line')).toBeNull();

        node.learn = { total: 2, fail: true };
        await typeWords('bins');
        expect(screen.queryByTestId('market-learn-line')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
        cleanup();

        info.current = { features: { knowledge: false } };
        const asksSoFar = learnAsked();
        await openMarket({ onNavigate: vi.fn() });
        await typeWords('tip');
        expect(screen.queryByTestId('market-learn-line')).toBeNull();
        expect(learnAsked()).toEqual(asksSoFar); // Learn off: not asked at all
        cleanup();

        info.current = { features: { knowledge: true } };
        request.mockClear();
        await openMarket({ onNavigate: vi.fn(), isMember: false });
        await typeWords('tip');
        expect(screen.queryByTestId('market-learn-line')).toBeNull();
        expect(learnAsked()).toEqual([]);
    });

    it('asks once for a word typed, not for every letter', async () => {
        await openMarket({ onNavigate: vi.fn() });
        for (const w of ['t', 'ti', 'tip']) fireEvent.change(screen.getByPlaceholderText('Search marketplace...'), { target: { value: w } });
        await wait(380);
        expect(learnAsked()).toEqual(['/api/knowledge/front?q=tip']);
    });
});

describe('the Market reads nothing about Local knowledge', () => {
    it('asks for no page on any pill, with or without words', async () => {
        await openMarket({ onNavigate: vi.fn() });
        await typeWords('tip');
        const pillCount = screen.getByTestId('feed-type-filter').querySelectorAll('button').length;
        expect(pillCount).toBe(6);
        for (let i = 0; i < pillCount; i++) {
            fireEvent.click(screen.getByTestId('feed-type-filter').querySelectorAll('button')[i]);
            await wait(380);
        }
        const reads = marketReads();
        expect(reads.length).toBeGreaterThan(pillCount);
        for (const r of reads) {
            expect(String(r.types ?? ''), JSON.stringify(r)).not.toContain('knowledge');
            expect(r.type).not.toBe('knowledge');
        }
        expect(screen.queryAllByRole('button', { name: /^Learn$/ })).toHaveLength(0);
    });

    it('has the same six pills: no Learn pill', async () => {
        await openMarket({ onNavigate: vi.fn() });
        const pills = within6();
        expect(pills).toEqual(['All', '★ For You', '🟢 Offers', '🟠 Needs', 'Events', '🗳️ Polls']);
    });

    function within6(): string[] {
        return Array.from(screen.getByTestId('feed-type-filter').querySelectorAll('button')).map((b) => b.textContent ?? '');
    }
});

describe('a link to a page of Local knowledge', () => {
    it('lands in Learn when the Market cannot open it as a listing', async () => {
        node.pages = [knowledgePage('know-1')];
        const onNavigate = vi.fn();
        const onPostOpened = vi.fn();
        await openMarket({ openPostId: 'know-1', onPostOpened, onNavigate, sayWhenPostUnopened: true });
        expect(onNavigate).toHaveBeenCalledWith('learn-page', 'know-1');
        expect(onPostOpened).toHaveBeenCalled();
        expect(screen.queryByText('That listing can no longer be opened. It may have been taken down.')).toBeNull();
    });

    it('is still "no longer opened" for an id that is neither a listing nor a page', async () => {
        const onNavigate = vi.fn();
        await openMarket({ openPostId: 'nothing-here', onPostOpened: vi.fn(), onNavigate, sayWhenPostUnopened: true });
        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.getByText('That listing can no longer be opened. It may have been taken down.')).toBeInTheDocument();
    });

    it('is still "no longer opened" when Learn cannot be asked', async () => {
        request.mockRejectedValue(new Error('offline'));
        const onNavigate = vi.fn();
        await openMarket({ openPostId: 'know-1', onPostOpened: vi.fn(), onNavigate, sayWhenPostUnopened: true });
        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.getByText('That listing can no longer be opened. It may have been taken down.')).toBeInTheDocument();
    });
});
