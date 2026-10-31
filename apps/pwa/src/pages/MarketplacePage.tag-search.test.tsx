/**
 * The web Market's search and tag filter on the real page, the node stubbed at lib/api (review of #2663). The node's answer
 * is added to what the page held, never put in its place, so a search finds at least what the filter over the feed found:
 * synonyms and peers' listings. It reads from where the list reads, and stays true as the list moves. A tag filter leaves the
 * search box working, and is a filter to the example cards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { searchTermsFor } from '@beanpool/core';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { routeLivePostChange } from '../lib/live-posts';

const info = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const doorbell = vi.hoisted(() => ({ ring: null as null | (() => unknown) }));
const peers = vi.hoisted(() => ({ enabled: [] as string[] }));
const beansMode = vi.hoisted(() => ({ now: 'live' }));

vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => info.current), joinInFlight: vi.fn(async () => false) }));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn((ring: () => unknown) => { doorbell.ring = ring; return () => {}; }) }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useFeatureMode: (feature: string) => (feature === 'beans' ? beansMode.now : 'live'),
}));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null), saveRadiusSettings: vi.fn(), clearRadiusSettings: vi.fn(), haversineDistance: vi.fn(() => 0),
}));
vi.mock('../lib/peer-prefs', () => ({ loadEnabledPeers: vi.fn(() => new Set(peers.enabled)), togglePeer: vi.fn() }));
vi.mock('../lib/profile-status', async (orig) => ({
    ...(await orig<typeof import('../lib/profile-status')>()),
    getProfileStatus: vi.fn(async () => ({ complete: true, missingName: false, missingAvatar: false })),
}));
vi.mock('../components/MarketplaceCard', () => ({ MarketplaceCard: ({ post }: { post: { title: string } }) => <div data-testid="card-stub">{post.title}</div> }));
vi.mock('../components/PollCard', () => ({ PollCard: () => null }));
vi.mock('../components/EventCard', () => ({
    EventCard: () => null,
    EventDetail: ({ onOpenTag }: { onOpenTag?: (id: string) => void }) => <button type="button" onClick={() => onOpenTag?.(LEMON)}>the event's chip</button>,
}));
vi.mock('../components/YourEvents', () => ({ YourEvents: () => null }));
vi.mock('../components/CategoryPickerModal', () => ({ CategoryPickerModal: () => null }));
vi.mock('../components/MyDealsModal', () => ({ MyDealsModal: () => null }));
vi.mock('../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));
vi.mock('../components/ExampleListings', () => ({ ExampleListings: () => <p>the example cards</p> }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));

const LEMON = 'food.fruit.lemon';
const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Damo', createdAt: '2026-09-17T00:00:00.000Z' };
const AT = new Date(Date.now() - 60_000).toISOString();
const listing = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, type: 'offer', category: 'general', title, description: '', credits: 5, priceType: 'fixed', status: 'active', active: true,
    authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: AT, updatedAt: AT, photos: [], audienceScope: 'public', ...extra,
});

type Read = Record<string, any>;
/** The node: the feed for a plain read, `answer` for a search's. */
const node = { feed: [] as unknown[], answer: (() => []) as (f: Read) => unknown[] | Promise<unknown[]> };

function stubNode() {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) => {
        if (f?.id) return (node.feed as Array<{ id: string }>).filter(p => p.id === f.id) as any;
        if (f?.author) return [] as any;
        return (f?.q || f?.tags ? node.answer(f) : node.feed) as any;
    });
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
    vi.spyOn(api, 'getTreasury').mockResolvedValue(null);
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 100, isBlockedFromTrading: false, keeperOf: [] } as any);
    vi.spyOn(api, 'getGroups').mockResolvedValue([]);
    vi.spyOn(api, 'getCommissionCapacity').mockResolvedValue({ links: [] });
    vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: ME } as any);
    vi.spyOn(api, 'getMemberProfile').mockResolvedValue({ avatar: null, bio: '' } as any);
    vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ ratings: [], average: 0, count: 0 } as any);
    vi.spyOn(api, 'getRatingsGiven').mockResolvedValue({ ratings: [] });
    vi.spyOn(api, 'getMyMarketplaceTransactions').mockResolvedValue([]);
    vi.spyOn(api, 'getRemotePosts').mockResolvedValue([]);
}

const searches = () => vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f as Read).filter(f => f?.q || f?.tags);
const cards = () => screen.queryAllByTestId('card-stub').map(c => c.textContent);
const wait = async (ms: number) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
async function openMarket(props: Record<string, unknown> = {}) {
    render(<MarketplacePage identity={identity} isMember={true} transactions={[]} {...props} />);
    await wait(40);
}
/** The debounce gone by and the read landed. */
async function search(words: string) {
    fireEvent.change(screen.getByPlaceholderText('Search marketplace...'), { target: { value: words } });
    await wait(340);
}
/** Open a listing and tap its #Lemon chip: the Market filtered by it. */
async function filterByLemon(id: string) {
    await openMarket({ openPostId: id, onPostOpened: () => {} });
    fireEvent.click(await screen.findByRole('button', { name: 'Filter marketplace by tag Lemon' }));
    await wait(340);
}

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    info.current = {};
    peers.enabled = [];
    beansMode.now = 'live';
    doorbell.ring = null;
    node.feed = [];
    node.answer = () => [];
    stubNode();
});
afterEach(() => { cleanup(); });

describe('a search finds at least what the filter over the feed found', () => {
    it('asks with the terms the phone asks with: "sofa" reaches a listing that holds "couch"', async () => {
        const couch = listing('couch', 'Old couch');
        node.answer = f => (String(f.q).split(' ').includes('couch') ? [couch] : []);
        await openMarket();
        await search('sofa');
        expect(searches().at(-1)?.q).toBe(searchTermsFor('sofa').join(' '));
        expect(cards()).toEqual(['Old couch']);
    });

    it('a peer community\'s listing the words match stays: the node\'s read never holds it', async () => {
        peers.enabled = ['https://peer.example'];
        vi.mocked(api.getRemotePosts).mockResolvedValue([listing('peer-1', 'Peer eggs')] as any);
        await openMarket();
        await search('eggs');
        expect(cards()).toEqual(['Peer eggs']);
    });

    it('what the feed holds and the node left out stays; what the words don\'t match does not', async () => {
        node.feed = [listing('couch', 'Old couch'), listing('kettle', 'Kettle')];
        await openMarket();
        await search('sofa');
        expect(cards()).toEqual(['Old couch']);
    });

    it('a listing in both shows once, in the node\'s order, the feed\'s others after it', async () => {
        const a = listing('a', 'Lemon jam');
        const b = listing('b', 'Lemon cake');
        const c = listing('c', 'Lemon curd');
        node.feed = [c, a];
        node.answer = () => [a, b];
        await openMarket();
        await search('lemon');
        expect(cards()).toEqual(['Lemon jam', 'Lemon cake', 'Lemon curd']);
    });

    it('on a node that reads by area it reads from the same point, nearest first', async () => {
        info.current = { profile: 'global', features: { beans: false, nearbyListings: { radiusKm: 250, max: 500 } } };
        vi.mocked(api.getCommunityMe).mockResolvedValue({ publicKey: ME, area: { lat: -28.5, lng: 153.5 } } as any);
        await openMarket();
        await search('eggs');
        expect(searches().at(-1)).toMatchObject({ lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance' });
    });

    it('words that leave nothing to ask (quote marks alone) are no read, so never every listing', async () => {
        node.feed = [listing('a', 'Lemon jam')];
        await openMarket();
        await search('"');
        expect(searches()).toEqual([]);
        expect(cards()).toEqual([]);
    });
});

describe('a search stays true as the list moves', () => {
    const jam = listing('jam', 'Lemon jam');

    it('a listing edited or removed over the live feed changes in the results, and a new one the words match joins', async () => {
        node.answer = () => [jam];
        await openMarket();
        await search('lemon');
        expect(cards()).toEqual(['Lemon jam']);

        const later = new Date().toISOString();
        await act(async () => { routeLivePostChange({ kind: 'upsert', created: false, post: { ...jam, title: 'Lemon jam, last jars', updatedAt: later } } as any, ME); });
        expect(cards()).toEqual(['Lemon jam, last jars']);

        await act(async () => { routeLivePostChange({ kind: 'upsert', created: true, post: listing('curd', 'Lemon curd') } as any, ME); });
        await act(async () => { routeLivePostChange({ kind: 'upsert', created: true, post: listing('kettle', 'Kettle') } as any, ME); });
        expect(cards().sort()).toEqual(['Lemon curd', 'Lemon jam, last jars']);

        await act(async () => { routeLivePostChange({ kind: 'remove', id: 'jam' } as any, ME); });
        expect(cards()).toEqual(['Lemon curd']);
    });

    it('a read of the list reads the search again: an edit the member made shows without new words', async () => {
        node.answer = () => [jam];
        await openMarket();
        await search('lemon');
        const before = searches().length;

        node.answer = () => [{ ...jam, title: 'Lemon marmalade' }];
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
        await act(async () => { await doorbell.ring?.(); });
        await wait(40);
        expect(searches().length).toBe(before + 1);
        expect(cards()).toEqual(['Lemon marmalade']);
    });

    it('a read of the list landing mid-typing asks nothing: half a word never goes to the node', async () => {
        await openMarket();
        fireEvent.change(screen.getByPlaceholderText('Search marketplace...'), { target: { value: 'lem' } });
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
        await act(async () => { await doorbell.ring?.(); });
        await wait(40);
        expect(searches()).toEqual([]);
        await wait(320);
        expect(searches()).toHaveLength(1);
    });

    it('a read still out is left to land: list reads quicker than the node answers don\'t throw it away', async () => {
        let land: (rows: unknown[]) => void = () => {};
        node.answer = () => new Promise<unknown[]>(resolve => { land = resolve; });
        await openMarket();
        await search('lemon');
        const before = searches().length;

        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
        await act(async () => { await doorbell.ring?.(); });
        await wait(40);
        expect(searches().length).toBe(before);
        await act(async () => { land([jam]); });
        expect(cards()).toEqual(['Lemon jam']);
    });
});

describe('a tag filter', () => {
    const jam = listing('jam', 'Lemon jam', { tags: [LEMON] });
    const cake = listing('cake', 'Lemon cake', { tags: [LEMON] });

    it('leaves the search box working: the words narrow the tag\'s listings', async () => {
        node.feed = [jam, cake];
        node.answer = () => [jam, cake];
        await filterByLemon('jam');
        expect(cards()).toEqual(['Lemon jam', 'Lemon cake']);
        await search('jam');
        expect(cards()).toEqual(['Lemon jam']);
    });

    it('is a filter to the example cards: they stay away, as they do under any other', async () => {
        info.current = { profile: 'global', features: { beans: false, exampleListings: true } };
        node.feed = [jam];
        node.answer = () => [jam];
        await openMarket();
        expect(screen.getByText('the example cards')).toBeInTheDocument();
        cleanup();

        await filterByLemon('jam');
        expect(cards()).toEqual(['Lemon jam']);
        expect(screen.queryByText('the example cards')).toBeNull();
    });

    it('opens from an event\'s chip as from a listing\'s', async () => {
        const event = listing('fair', 'Lemon fair', { type: 'event', tags: [LEMON] });
        node.feed = [jam, event];
        node.answer = () => [jam];
        await openMarket({ openPostId: 'fair', onPostOpened: () => {} });
        fireEvent.click(await screen.findByRole('button', { name: "the event's chip" }));
        await wait(340);
        expect(searches().at(-1)).toMatchObject({ tags: [LEMON] });
        expect(cards()).toEqual(['Lemon jam']);
    });
});

describe('Beans only where its chip is hidden', () => {
    it('a Beans only picked before does not reach the node\'s search, as it does not reach the feed', async () => {
        beansMode.now = 'preview';
        localStorage.setItem('bp_beans_only', 'true');
        await openMarket();
        await search('eggs');
        expect(searches().at(-1)?.beansOnly).toBeFalsy();
    });
});
