import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { SAVE_SEARCH_BUTTON, livePostChange, setLanguage } from '@beanpool/core';
import { routeLivePostChange, resetLivePostsForTest } from '../lib/live-posts';
import { ACCOUNT_EPOCH_KEY, resetAccountEpochForTest } from '../lib/account-epoch';
import { epochEndsInAnotherTab } from '../lib/another-tab';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null),
    saveRadiusSettings: vi.fn(),
    clearRadiusSettings: vi.fn(),
    haversineDistance: vi.fn(() => 0),
}));

vi.mock('../lib/peer-prefs', () => ({
    loadEnabledPeers: vi.fn(() => new Set()),
    togglePeer: vi.fn(),
}));

vi.mock('../lib/profile-status', () => ({
    getProfileStatus: vi.fn(async () => ({ complete: true })),
    describeMissing: vi.fn(() => ''),
}));

// The lightbox draws nothing here; what the page hands it is read from its props (DW3's several-photos case).
const lightboxProps = vi.hoisted(() => ({ last: null as null | { photos: string[]; initialIndex?: number } }));
vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: (props: { photos: string[]; initialIndex?: number }) => { lightboxProps.last = props; return null; },
}));

vi.mock('../components/ActivityWaterfall', () => ({
    ActivityWaterfall: () => null,
}));

const identity: BeanPoolIdentity = {
    publicKey: 'guest-pubkey',
    privateKey: 'mock-private-key-hex',
    callsign: 'Guest',
    createdAt: '2026-09-17T00:00:00.000Z',
};

const posts = [{
    id: 'post-1', title: 'Bicycle Repair', description: 'Fix gears', type: 'offer', category: 'services',
    credits: 20, status: 'active', authorPublicKey: 'member-david', authorCallsign: 'David',
    createdAt: '2026-09-15T00:00:00Z',
}];

// A guest is a local key the node has no member for: the node answers "Member not found" for its balance,
// so on a slow connection the request is pure waste. App tells the page with isMember.
describe('MarketplacePage: the viewer balance is a member-only request', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue(posts as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('never asks for the balance of a guest', async () => {
        render(<MarketplacePage identity={identity} isMember={false} />);
        await screen.findByText('Bicycle Repair');
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(api.getBalance).not.toHaveBeenCalled();
    });

    it('waits while membership is unknown, then asks once for a member', async () => {
        const view = render(<MarketplacePage identity={identity} isMember={null} />);
        await screen.findByText('Bicycle Repair');
        expect(api.getBalance).not.toHaveBeenCalled();

        view.rerender(<MarketplacePage identity={identity} isMember={true} />);
        await waitFor(() => expect(api.getBalance).toHaveBeenCalledTimes(1));
        expect(api.getBalance).toHaveBeenCalledWith(identity.publicKey);
    });

    it('still asks for a member when isMember is omitted', async () => {
        render(<MarketplacePage identity={identity} />);
        await waitFor(() => expect(api.getBalance).toHaveBeenCalledTimes(1));
    });
});

describe("MarketplacePage: a saved search's See more on Home fills the search (CARD-FRAME §4; slice F4)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([
            ...posts,
            { ...posts[0], id: 'post-2', title: 'Fresh eggs', description: 'A dozen', category: 'food' },
        ] as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('opens with the words in the search box, once, and the list narrowed to them', async () => {
        // The node narrows a search to its words, as the real one does. A node that answered every search with every listing
        // would put Bicycle Repair back when the page's debounced read (300 ms after the words went in) landed, and "the list
        // narrowed to them" would hold only until then: a runner that took longer than that to reach the check failed it.
        const everything = [...posts, { ...posts[0], id: 'post-2', title: 'Fresh eggs', description: 'A dozen', category: 'food' }];
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation((async (filter: { q?: string }) => {
            const words = (filter?.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
            return everything.filter(p => words.length === 0 || words.some(w => `${p.title} ${p.description}`.toLowerCase().includes(w)));
        }) as any);
        const onSearchOpened = vi.fn();
        render(<MarketplacePage identity={identity} openSearch="  eggs " onSearchOpened={onSearchOpened} />);
        await screen.findByText('Fresh eggs');
        expect(screen.getByPlaceholderText('Search marketplace...')).toHaveValue('eggs');
        await waitFor(() => expect(screen.queryByText('Bicycle Repair')).not.toBeInTheDocument());
        expect(onSearchOpened).toHaveBeenCalledTimes(1);
    });

    it('no words leaves the search as it was', async () => {
        render(<MarketplacePage identity={identity} openSearch="   " onSearchOpened={vi.fn()} />);
        await screen.findByText('Bicycle Repair');
        expect(screen.getByPlaceholderText('Search marketplace...')).toHaveValue('');
    });

    it('Save this search to Home: shown while there are words, it hands Home the words and the Offers tab (Marty, 7 Oct)', async () => {
        const onSaveSearch = vi.fn();
        render(<MarketplacePage identity={identity} onSaveSearch={onSaveSearch} />);
        await screen.findByText('Bicycle Repair');
        expect(screen.queryByTestId('market-save-search')).toBeNull();
        fireEvent.change(screen.getByPlaceholderText('Search marketplace...'), { target: { value: '  fresh eggs ' } });
        fireEvent.click(screen.getByRole('button', { name: /Offers/ }));
        const save = await screen.findByTestId('market-save-search');
        expect(save).toHaveTextContent('Save this search to Home');
        expect(save).toHaveAccessibleName('Save the search "fresh eggs" to Home');
        fireEvent.click(save);
        expect(onSaveSearch).toHaveBeenCalledWith({ q: 'fresh eggs', kind: 'offer', tags: ['food.eggs'] });
    });

    it('Save this search to Home: the words shown and the screen-reader name are one language (review of #2166)', async () => {
        // A French catalog that gives both keys a value (the drafting pass will write the real ones).
        setLanguage('fr', [{
            [SAVE_SEARCH_BUTTON]: 'Garder cette recherche sur l’Accueil',
            'Save the search "{q}" to Home': 'Garder la recherche « {q} » sur l’Accueil',
        }]);
        try {
            render(<MarketplacePage identity={identity} onSaveSearch={vi.fn()} />);
            await screen.findByText('Bicycle Repair');
            fireEvent.change(screen.getByPlaceholderText('Search marketplace...'), { target: { value: 'eggs' } });
            const save = await screen.findByTestId('market-save-search');
            expect(save).toHaveTextContent('Garder cette recherche sur l’Accueil');
            expect(save).toHaveAccessibleName('Garder la recherche « eggs » sur l’Accueil');
        } finally {
            setLanguage('en');
        }
    });

    it('Save this search to Home: none under Events or Polls, none without the way to Home, none for a non-member', async () => {
        const view = render(<MarketplacePage identity={identity} onSaveSearch={vi.fn()} />);
        await screen.findByText('Bicycle Repair');
        fireEvent.change(screen.getByPlaceholderText('Search marketplace...'), { target: { value: 'eggs' } });
        expect(await screen.findByTestId('market-save-search')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Events' }));
        expect(screen.queryByTestId('market-save-search')).toBeNull();
        view.rerender(<MarketplacePage identity={identity} />);
        fireEvent.click(screen.getByRole('button', { name: 'Events' }));
        expect(screen.queryByTestId('market-save-search')).toBeNull();
        view.rerender(<MarketplacePage identity={identity} onSaveSearch={vi.fn()} isMember={false} />);
        expect(screen.queryByTestId('market-save-search')).toBeNull();
    });
});

describe('MarketplacePage: events in the feed (docs/events-on-the-map.md §3, slice 2)', () => {
    const HOUR = 60 * 60 * 1000;
    const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
    const event = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
        id, type: 'event', category: 'community', title, description: 'Bring gloves', credits: 0, priceType: 'fixed',
        status: 'active', active: true, authorPublicKey: 'host-pk', authorCallsign: 'Hazel', createdAt: new Date().toISOString(),
        lat: -28.55, lng: 153.5, eventStartAt: inHours(30), eventPlaceName: 'Bindarrabi Hall', eventState: 'scheduled',
        goingCount: 7, interestedCount: 3, myRsvp: null, ...extra,
    });

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([
            ...posts,
            event('ev-open', 'Working bee'),
            event('ev-updated', 'Repair café', { eventState: 'updated' }),
            event('ev-ended', 'Last week', { eventStartAt: inHours(-30), eventEndAt: inHours(-28) }),
        ] as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('asks the node for events, shows them as event cards, and leaves out ended ones', async () => {
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Working bee');
        expect(api.getMarketplacePosts).toHaveBeenCalledWith(expect.objectContaining({ types: 'offer,need,poll,event' }));
        const cards = screen.getAllByTestId('event-card');
        expect(cards).toHaveLength(2);
        expect(cards.some(c => c.textContent?.includes('UPDATED'))).toBe(true);
        expect(screen.queryByText('Last week')).not.toBeInTheDocument();
        expect(screen.getByText('Bicycle Repair')).toBeInTheDocument();
    });

    it('has an Events pill that shows events only, with the map\'s date chips in place of the listing filters (B5)', async () => {
        vi.mocked(api.getMarketplacePosts).mockResolvedValue([
            ...posts,
            event('ev-open', 'Working bee'),
            event('ev-far', 'Spring fair', { eventStartAt: inHours(24 * 30) }),
            event('ev-ended', 'Last week', { eventStartAt: inHours(-30), eventEndAt: inHours(-28) }),
        ] as any);
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Working bee');
        const pills = screen.getByTestId('feed-type-filter');
        expect(Array.from(pills.querySelectorAll('button')).map(b => b.textContent)).toEqual(
            ['All', '★ For You', '🟢 Offers', '🟠 Needs', 'Events', '🗳️ Polls']);
        expect(screen.queryByTestId('feed-event-window-chips')).toBeNull();

        await act(async () => { screen.getByRole('button', { name: 'Events' }).click(); });
        await waitFor(() => expect(api.getMarketplacePosts).toHaveBeenCalledWith(expect.objectContaining({ type: 'event' })));
        expect(screen.getByRole('button', { name: 'Events' }).getAttribute('aria-pressed')).toBe('true');
        await waitFor(() => expect(screen.queryByText('Bicycle Repair')).not.toBeInTheDocument());
        // Soonest first, and never an ended one.
        expect(screen.getAllByTestId('event-card').map(c => c.textContent?.includes('Working bee') ? 'open' : 'far')).toEqual(['open', 'far']);
        expect(screen.queryByText('Last week')).not.toBeInTheDocument();

        // The date chips replace Category / Distance / Beans only, as on the phone.
        const chips = screen.getByTestId('feed-event-window-chips');
        expect(Array.from(chips.querySelectorAll('button')).map(b => b.textContent)).toEqual(['Today', 'This weekend', 'Next 7 days', 'All']);
        expect(Array.from(chips.querySelectorAll('button')).every(b => /min-h-\[48px\]/.test(b.className))).toBe(true);
        expect(screen.queryByText(/Beans only/)).toBeNull();
        expect(screen.queryByText('Category')).toBeNull();
        expect(screen.queryByText('Distance')).toBeNull();

        await act(async () => { screen.getByRole('button', { name: 'Next 7 days' }).click(); });
        expect(screen.getByText('Working bee')).toBeInTheDocument();
        expect(screen.queryByText('Spring fair')).not.toBeInTheDocument();
    });

    it('calendar-s4: openFilter="event" selects Events pill and calendar button calls onNavigate("map-calendar")', async () => {
        const onNavigate = vi.fn();
        const onFilterOpened = vi.fn();
        render(
            <MarketplacePage
                identity={identity}
                openFilter="event"
                onFilterOpened={onFilterOpened}
                onNavigate={onNavigate}
            />
        );
        await screen.findByText('Working bee');
        expect(onFilterOpened).toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Events' }).getAttribute('aria-pressed')).toBe('true');
        const calButton = screen.getByTestId('market-calendar-button');
        expect(calButton).toBeInTheDocument();
        fireEvent.click(calButton);
        expect(onNavigate).toHaveBeenCalledWith('map-calendar');
    });

    it('opens an event that has left the feed when a link names it (the chat\'s View event), asking the node by id (A4)', async () => {
        const cancelled = event('ev-cancelled', 'Cancelled working bee', { status: 'cancelled', eventState: 'cancelled', active: false, eventRsvps: [] });
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (filter?: any) =>
            (filter?.id === 'ev-cancelled' ? [cancelled] : [...posts]) as any);
        const onPostOpened = vi.fn();
        render(<MarketplacePage identity={identity} openPostId="ev-cancelled" onPostOpened={onPostOpened} />);
        const detail = await screen.findByTestId('event-detail');
        expect(detail).toHaveTextContent('Cancelled working bee');
        expect(detail).toHaveTextContent('CANCELLED');
        expect(api.getMarketplacePosts).toHaveBeenCalledWith({ id: 'ev-cancelled', types: 'offer,need,poll,event' });
        expect(onPostOpened).toHaveBeenCalled();
    });

    it.each([['new-poll', 'map-post-poll'], ['new-event', 'map-post-event']])('Commons\' Start something → %s opens the composer on that kind (%s), not on Need (#2471)', async (openPostId, tab) => {
        const onNavigate = vi.fn();
        const onPostOpened = vi.fn();
        render(<MarketplacePage identity={identity} openPostId={openPostId} onPostOpened={onPostOpened} onNavigate={onNavigate} />);
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(tab));
        expect(onNavigate).not.toHaveBeenCalledWith('map-post');
        expect(onPostOpened).toHaveBeenCalled();
    });

    it("opens the event detail from the card, with the host's box", async () => {
        render(<MarketplacePage identity={identity} />);
        const open = await screen.findByRole('button', { name: /^Open event: Working bee(,|$)/ });
        await act(async () => { open.click(); });
        const detail = await screen.findByTestId('event-detail');
        // The host is the box a listing's "Posted by" is (components/AuthorCard.tsx): the label above the button that opens them.
        expect(within(screen.getByTestId('event-host-open').parentElement!).getByText('Hosted by')).toBeInTheDocument();
        expect(screen.getByTestId('event-host-open')).toHaveTextContent('Hazel');
        expect(detail).toHaveTextContent('Bindarrabi Hall');
    });

    it('item and event detail pages use full width on narrow screens and cap at readable max-w-3xl on wide screens', async () => {
        render(<MarketplacePage identity={identity} />);
        const open = await screen.findByRole('button', { name: /^Open event: Working bee(,|$)/ });
        await act(async () => { open.click(); });
        const detail = await screen.findByTestId('event-detail');
        const container = detail.parentElement as HTMLElement;
        const classes = container.className.split(/\s+/);
        expect(classes).toContain('w-full');
        expect(classes).toContain('max-w-3xl');
        expect(classes).toContain('mx-auto');
    });

    it('Pricing Guide chip on Market: choosing an item carries its price into the form via onComposer', async () => {
        vi.spyOn(api, 'getPricingGuideApi').mockResolvedValue({ items: [], config: {} } as any);
        const onComposer = vi.fn();
        const onNavigate = vi.fn();
        render(<MarketplacePage identity={identity} onComposer={onComposer} onNavigate={onNavigate} />);

        const guideChip = await screen.findByRole('button', { name: /Pricing Guide/i });
        await act(async () => { guideChip.click(); });

        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();

        const selectBtn = within(dialog).getByRole('button', { name: /Select Artisan Sourdough Loaf for offer at 8 Beans/i });
        await act(async () => { selectBtn.click(); });

        expect(onComposer).toHaveBeenCalledWith({
            type: 'offer',
            title: 'Artisan Sourdough Loaf',
            description: 'Naturally leavened fresh whole wheat or white sourdough',
            category: 'food',
            credits: 8,
            priceType: 'fixed',
            repeatable: false,
            cashAlsoNeeded: false,
        });
    });
});

// "Your events" — the row at the top of ★ For You (decision 1). It is its own read of /api/events/mine,
// and it is deliberately outside the feed's empty state: the starred feed having nothing in it today says
// nothing about what you have said you will be at.
describe('MarketplacePage: "Your events" under ★ For You', () => {
    const HOUR = 60 * 60 * 1000;
    const mine = (postId: string, title: string, hours = 30) => ({
        postId, title, startAt: new Date(Date.now() + hours * HOUR).toISOString(),
        endAt: null, placeName: 'Bindarrabi Hall', rsvp: 'going' as const, photo: null, reminderOffsets: null,
    });

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue(posts as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getMyEvents').mockResolvedValue([mine('ev-1', 'Working bee')] as any);
    });

    const openForYou = async () => {
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        await act(async () => { screen.getByRole('button', { name: '★ For You' }).click(); });
    };

    it('shows the row above the starred feed, and nowhere else', async () => {
        await openForYou();
        const row = await screen.findByTestId('your-events');
        expect(row).toHaveTextContent('Working bee');

        await act(async () => { screen.getByRole('button', { name: 'All' }).click(); });
        expect(screen.queryByTestId('your-events')).toBeNull();
    });

    it('stays there when no starred listing matches, which is when it is most use', async () => {
        await openForYou();
        // Nothing is starred in this test, so the ★ For You feed is empty and says so.
        expect(await screen.findByTestId('your-events')).toHaveTextContent('Working bee');
        expect(screen.getByText('No items found')).toBeInTheDocument();
    });

    it('a filter with no matches shows main\'s no-matches state and no tiles', async () => {
        await openForYou();
        expect(screen.getByText('No items found')).toBeInTheDocument();
        expect(screen.queryByText('Nothing here yet. Be the first:')).toBeNull();
        expect(screen.queryByTestId('market-empty-tiles')).toBeNull();
    });

    it('the truly empty Market shows the four category tiles, "Nothing here yet. Be the first:" and + ADD POST', async () => {
        vi.mocked(api.getMarketplacePosts).mockResolvedValue([]);
        render(<MarketplacePage identity={identity} />);
        expect(await screen.findByText('Nothing here yet. Be the first:')).toBeInTheDocument();
        const emptyTiles = screen.getByTestId('market-empty-tiles');
        expect(emptyTiles).toBeInTheDocument();
        expect(emptyTiles.querySelectorAll('[data-testid="category-tile"]').length).toBe(4);
        expect(within(emptyTiles.parentElement!).getByRole('button', { name: /\+ ADD POST/ })).toBeInTheDocument();
        expect(screen.queryByText('No items found')).toBeNull();
    });

    it("a category starred here is kept on the member's account too, one truth with Home's interests (Home design §4.3)", async () => {
        localStorage.removeItem('bp_fav_categories');
        const save = vi.spyOn(api, 'saveHomePreferences').mockResolvedValue({ success: true });
        await openForYou();
        await act(async () => { screen.getByRole('button', { name: /Food & Produce/ }).click(); });
        expect(JSON.parse(localStorage.getItem('bp_fav_categories')!)).toEqual(['food']);
        await waitFor(() => expect(save).toHaveBeenCalledWith(identity.publicKey, { interests: ['food'] }));
        localStorage.removeItem('bp_fav_categories');
    });

    it('after Sign Out in another tab, a star in this Market keeps no favourites and sends nothing (PR #1479 round 2)', async () => {
        localStorage.removeItem('bp_fav_categories');
        const save = vi.spyOn(api, 'saveHomePreferences').mockResolvedValue({ success: true });
        await openForYou();
        epochEndsInAnotherTab('signed-out');
        try {
            await act(async () => { screen.getByRole('button', { name: /Food & Produce/ }).click(); });
            expect(localStorage.getItem('bp_fav_categories')).toBeNull();
            expect(save).not.toHaveBeenCalled();
        } finally {
            localStorage.removeItem(ACCOUNT_EPOCH_KEY);
            resetAccountEpochForTest();
        }
    });

    it('is not there at all on a node without the route (decision 7)', async () => {
        const missing = Object.assign(new Error('Not Found'), { status: 404 });
        vi.mocked(api.getMyEvents).mockRejectedValue(missing);
        await openForYou();
        await waitFor(() => expect(api.getMyEvents).toHaveBeenCalled());
        expect(screen.queryByTestId('your-events')).toBeNull();
    });
});

// Card View used to stretch every tile to the tallest cell in its row. A poll — four answers, the open-ballot
// note, the turnout row — is much taller than a listing tile, so the tiles sharing its row grew a dead gap
// between their description and VIEW (Marty, 2026-09-24). The grid still stretches cells; a tile no longer opts
// into it, and the poll is given two columns so it is less often the reason a row is tall at all.
describe('MarketplacePage: Card View gives tiles their own height', () => {
    const poll = {
        id: 'poll-1', type: 'poll', category: 'community', title: 'Where should the tool shed go?',
        description: 'North gate or south barn?', credits: 0, priceType: 'fixed', status: 'active', active: true,
        authorPublicKey: 'member-ada', authorCallsign: 'Ada', createdAt: '2026-09-16T00:00:00Z',
        pollOptions: [
            { id: 'o1', text: 'It is Amazing and we should start on it this weekend', votes: 2, percentage: 50 },
            { id: 'o2', text: 'By the north gate', votes: 1, percentage: 25 },
            { id: 'o3', text: 'Behind the south barn', votes: 1, percentage: 25 },
            { id: 'o4', text: 'Neither', votes: 0, percentage: 0 },
        ],
        totalVotes: 4, pollVotes: [],
    };
    // One tile with a photo and a long description, one with neither: the two extremes of a tile's own height.
    const chainsaw = {
        id: 'post-2', title: 'Chainsaw', description: 'A very long description. '.repeat(20), type: 'offer',
        category: 'tools', credits: 5, status: 'active', authorPublicKey: 'member-eve', authorCallsign: 'Eve',
        createdAt: '2026-09-14T00:00:00Z', photos: ['/assets/bean.png'],
    };

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([...posts, chainsaw, poll] as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    /** The clickable grid cell around a listing, and the card inside it. */
    const cellOf = (title: string) => screen.getByRole('button', { name: new RegExp(`^Open listing: ${title}`) });
    const tileOf = (title: string) => cellOf(title).firstElementChild as HTMLElement;
    const pollCard = () => screen.getByText('Where should the tool shed go?').closest('div') as HTMLElement;
    const pollOptions = () => screen.getByText('Neither').closest('button')!.parentElement as HTMLElement;

    const openGrid = async () => {
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
    };

    // G2 (DESIGN-market-grid-sizes-fable.md §0.3, §2.2) replaces #1092's rule. #1092 kept every tile at its own height and
    // shrank its cell with `self-start`, so a click or the focus ring never covered blank cell space; the price was a grid of
    // four tile sizes with blank under every short one (Marty, 4 Nov). Now the cell IS the card: the grid stretches the
    // cell to its row and the tile fills the cell, so there is still no blank space around a card, and a row's tiles are one
    // height. jsdom does no layout: the heights are measured in e2e/market-grid-shots.mjs, which fails on a `self-start`.
    it('makes the cell the card: the cell stretches to its row and the tile fills the cell', async () => {
        await openGrid();
        for (const title of ['Bicycle Repair', 'Chainsaw']) {
            // Anchor: this really is the tile's own root, not some wrapper.
            expect(tileOf(title).className).toContain('flex flex-col');
            expect(tileOf(title).className).toMatch(/(^|\s)h-full(\s|$)/);
            expect(cellOf(title).className).toMatch(/(^|\s)h-full(\s|$)/);
            expect(cellOf(title).className).not.toMatch(/(^|\s)self-(start|end|center)(\s|$)/);
            // The cell's focus ring follows the card's corners.
            expect(cellOf(title).className).toContain('rounded-[14px]');
        }
    });

    it('removes the description line on non-Pulse grid cards (Pictures S5)', async () => {
        await openGrid();
        for (const title of ['Bicycle Repair', 'Chainsaw']) {
            const description = tileOf(title).querySelector('p');
            expect(description).toBeNull();
        }
    });

    it('gives a tile with a photo and one without the same 4:3 landscape media (aspect-[4/3]), and no VIEW button (Pictures S5, market-card-43)', async () => {
        await openGrid();
        for (const title of ['Bicycle Repair', 'Chainsaw']) {
            const media = tileOf(title).querySelector('div.relative.w-full') as HTMLElement;
            expect(media.className).toContain('aspect-[4/3]');
            expect(media.className).not.toContain('aspect-square');
            expect(tileOf(title).textContent).not.toContain('VIEW');
        }
    });

    // Marty, 5 Nov 2026 (a desktop screenshot of the grid): the 2 x 2 square left half the poll empty beside the taller event
    // tiles. "yes two wide it is but make sure it filled correctly. we dont want 2 wide with heaps of space." This replaces G2's
    // whole row at two and three columns and 2 x 2 from four (DESIGN-market-grid-sizes-fable.md §2.3), for the grid only.
    it('gives the poll two cells at every column count and one row, a summary with nothing to vote with that opens the poll', async () => {
        await openGrid();
        const cell = pollCard().parentElement!;
        expect(cell.className.split(/\s+/).filter(c => /(col|row)-span-/.test(c))).toEqual(['col-span-2']);
        // Nothing on the grid's poll votes: no answer is a button, and the tile is the one button, named as the poll.
        expect(screen.getByText('Neither').closest('button')).toBeNull();
        const tile = screen.getByRole('button', { name: /^Poll: Where should the tool shed go\?\. 4 answers, 4 votes\. Opens to vote$/ });
        expect(within(tile).queryAllByRole('button')).toHaveLength(0);
        fireEvent.click(within(tile).getByText('Neither'));
        // The poll's page: the full card, where it is voted.
        expect(await screen.findByRole('button', { name: /Back to Market/ })).toBeInTheDocument();
        expect(screen.getByText('Neither').closest('button')).not.toBeNull();
    });

    // A two-column tile cannot start in the last column of a row: auto-placement moves it down and leaves that
    // cell empty. Where the poll falls depends on the feed and the window, so the hole walks about. Dense flow
    // lets the tiles after it take the cell instead (Marty on #1092).
    it('lets the tiles after the poll fill a cell its two columns are too wide for', async () => {
        await openGrid();
        const gridEl = pollCard().parentElement!.parentElement as HTMLElement;
        // Anchor: this really is the Card View grid, not a wrapper.
        expect(gridEl.className).toContain('grid-cols-2');
        expect(gridEl.className).toContain('xl:grid-cols-5');
        expect(gridEl.className).toContain('grid-flow-row-dense');
    });

    // The grid's tile is a summary (an answer one line, ending in "…"), never a ballot; the poll is voted on its page, and there
    // every answer is shown in full — a ballot option you cannot read is not a choice.
    it('shows poll answers in full on the poll\'s page, where the grid\'s tile opens it to be voted', async () => {
        await openGrid();
        const onTile = screen.getByText('It is Amazing and we should start on it this weekend');
        expect(onTile.className).toMatch(/(^|\s)truncate(\s|$)/);
        expect(onTile.closest('button')).toBeNull();
        fireEvent.click(onTile);
        await screen.findByRole('button', { name: /Back to Market/ });
        const onPage = screen.getByText('It is Amazing and we should start on it this weekend');
        expect(onPage.closest('button')).not.toBeNull();
        expect(onPage.className).toContain('break-words');
        expect(onPage.className).not.toMatch(/(^|\s)truncate(\s|$)/);
    });

    it('leaves List View exactly as it was', async () => {
        await openGrid();
        await act(async () => { screen.getByRole('button', { name: 'Switch to List View' }).click(); });
        await screen.findByRole('button', { name: 'Switch to Compact View' }); // the toggle has moved on: List View it is

        expect(pollCard().parentElement!.className).toBe('w-full my-1');
        expect(pollOptions().className).toBe('space-y-2 mb-3 mt-1');
        expect(screen.getByText('It is Amazing and we should start on it this weekend').className)
            .toMatch(/(^|\s)truncate(\s|$)/);
    });
});

// A listing the node pushed over /ws, applied to the list this page holds, the same list its refresh writes
// (lib/live-posts). The live feed itself is mocked out in this file, so the change is routed exactly as
// lib/sync.ts routes it.
describe('MarketplacePage: a listing pushed over the live feed', () => {
    const pushed = (extra: Record<string, unknown> = {}) => ({
        id: 'post-9', type: 'offer', category: 'food', title: 'Spare lemons', description: 'A bag of them', credits: 5,
        priceType: 'fixed', authorPublicKey: 'member-erin', authorCallsign: 'Erin', createdAt: '2026-09-24T01:00:00.000Z',
        updatedAt: '2026-09-24T01:00:00.000Z', active: true, status: 'active', audienceScope: 'public', repeatable: false,
        ...extra,
    });
    const push = (event: unknown) => act(async () => {
        const change = livePostChange(event);
        expect(change).not.toBeNull();
        routeLivePostChange(change!, identity.publicKey);
    });

    beforeEach(() => {
        vi.restoreAllMocks();
        resetLivePostsForTest();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue(posts as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('a new listing appears without asking the node for the list again', async () => {
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        const calls = vi.mocked(api.getMarketplacePosts).mock.calls.length;

        await push({ type: 'new_post', post: pushed() });

        expect(await screen.findByText('Spare lemons')).toBeTruthy();
        expect(screen.getByText('Bicycle Repair')).toBeTruthy();
        expect(vi.mocked(api.getMarketplacePosts).mock.calls.length).toBe(calls);
    });

    it('an edit replaces it and a removal takes it away, still without a fetch', async () => {
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        const calls = vi.mocked(api.getMarketplacePosts).mock.calls.length;

        await push({ type: 'new_post', post: pushed() });
        await screen.findByText('Spare lemons');
        await push({ type: 'post_updated', post: pushed({ title: 'Lemons and limes', updatedAt: '2026-09-24T02:00:00.000Z' }) });
        await screen.findByText('Lemons and limes');
        expect(screen.queryByText('Spare lemons')).toBeNull();

        await push({ type: 'post_removed', id: 'post-9', audienceScope: 'public' });
        await waitFor(() => expect(screen.queryByText('Lemons and limes')).toBeNull());
        expect(vi.mocked(api.getMarketplacePosts).mock.calls.length).toBe(calls);
    });

    it('a later refresh that returns the same listing shows it once', async () => {
        const view = render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        await push({ type: 'new_post', post: pushed() });
        await screen.findByText('Spare lemons');

        // The node now lists it too; a filter change makes the page fetch again.
        vi.mocked(api.getMarketplacePosts).mockResolvedValue([pushed(), ...posts] as any);
        await act(async () => { screen.getByRole('button', { name: '🟢 Offers' }).click(); });
        await waitFor(() => expect(vi.mocked(api.getMarketplacePosts).mock.calls.some(([f]) => (f as any)?.type === 'offer')).toBe(true));
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(view.getAllByText('Spare lemons')).toHaveLength(1);
    });

    it('a listing pushed while the page was still loading survives the load', async () => {
        // The feed read, the viewer's-own read and the events read beside the feed (market order S2) are held until the push has landed.
        const pending: Array<(v: any) => void> = [];
        vi.mocked(api.getMarketplacePosts).mockImplementation(() => new Promise(r => { pending.push(r); }));
        render(<MarketplacePage identity={identity} />);
        await waitFor(() => expect(pending.length).toBe(3));

        // The list was read before this listing existed.
        await push({ type: 'new_post', post: pushed() });
        await act(async () => { pending[0](posts); pending[1]([]); pending[2]([]); });

        expect(await screen.findByText('Bicycle Repair')).toBeTruthy();
        expect(await screen.findByText('Spare lemons')).toBeTruthy();
    });

    it('my own listing is not applied here: it goes to the doorbell, and the full refresh', async () => {
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        const change = livePostChange({ type: 'new_post', post: pushed({ authorPublicKey: identity.publicKey }) })!;
        let applied = true;
        await act(async () => { applied = routeLivePostChange(change, identity.publicKey); });
        expect(applied).toBe(false);
        expect(screen.queryByText('Spare lemons')).toBeNull();
    });

    it('removing a listing this page holds as a poll or event is left to the doorbell', async () => {
        vi.mocked(api.getMarketplacePosts).mockResolvedValue([
            ...posts,
            { ...pushed({ id: 'poll-1', type: 'poll', title: 'Market day?' }), pollOptions: [{ id: 'a', text: 'Saturday' }] },
        ] as any);
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Market day?');
        let applied = true;
        await act(async () => { applied = routeLivePostChange(livePostChange({ type: 'post_removed', id: 'poll-1', audienceScope: 'public' })!, identity.publicKey); });
        expect(applied).toBe(false);
        await act(async () => { applied = routeLivePostChange(livePostChange({ type: 'post_removed', id: 'post-1', audienceScope: 'public' })!, identity.publicKey); });
        expect(applied).toBe(true);
    });
});

// A new account on the global node is a stranger at an open door (G11-e, design G11 §6): nothing a member writes in a
// post becomes a link on the web. A later "make links clickable" change meets this test and has to think about them.
describe('MarketplacePage: links in a post stay plain text (G11-e)', () => {
    const TITLE = 'Free bikes at www.phish.example';
    const DESCRIPTION = 'Claim yours: https://phish.example/win or <a href="https://phish.example/x">here</a>';
    const linkPost = {
        id: 'post-link', title: TITLE, description: DESCRIPTION, type: 'offer', category: 'services',
        credits: 5, status: 'active', active: true, authorPublicKey: 'member-eve', authorCallsign: 'Eve',
        createdAt: '2026-09-15T00:00:00Z',
    };
    const phishLinks = (root: ParentNode) =>
        Array.from(root.querySelectorAll('a')).filter(a => /phish/.test(a.getAttribute('href') ?? '') || /phish/.test(a.textContent ?? ''));

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([linkPost] as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('in every board view, a URL, a www. address and an <a> tag are text, never a link', async () => {
        for (const mode of ['grid', 'list', 'compact']) {
            try { localStorage.setItem('marketplace_view_mode', mode); } catch { /* */ }
            const { container, unmount } = render(<MarketplacePage identity={identity} />);
            await screen.findAllByText(TITLE);
            expect(phishLinks(container)).toHaveLength(0);
            unmount();
        }
    });

    it('in the opened post, the description is shown as written, with no link in it', async () => {
        const { container } = render(<MarketplacePage identity={identity} openPostId="post-link" />);
        await waitFor(() => expect(container.textContent).toContain(DESCRIPTION));
        expect(phishLinks(container)).toHaveLength(0);
        expect(phishLinks(document.body)).toHaveLength(0);
    });
});

// A local community's listings are its members' (2026-09-28): the node refuses them to anyone else with code members_only,
// and the Market says so, with the way to the global community, instead of an error or an empty board.
describe('MarketplacePage: a local community refuses its listings to a non-member', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        const refusal = Object.assign(new Error("Refused by the node."), { status: 403, code: 'members_only' });
        vi.spyOn(api, 'getMarketplacePosts').mockRejectedValue(refusal);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('shows the members-only card with a link to the global community, and no error box', async () => {
        render(<MarketplacePage identity={identity} isMember={false} />);
        const card = await screen.findByTestId('members-only-listings');
        expect(card.textContent).toContain("This community's listings are for its members");
        expect(screen.getByTestId('look-around-global').getAttribute('href')).toBe('https://global.beanpool.org');
        expect(screen.queryByText('Refused by the node.')).not.toBeInTheDocument();
    });
});

describe('MarketplacePage (deals-s1): recurring Offer and deal visibility', () => {
    const recurringOffer = {
        id: 'post-rec',
        title: 'Gardening Mentorship',
        description: 'Weekly advice and garden walkthrough',
        type: 'offer',
        category: 'services',
        credits: 45,
        priceType: 'fixed',
        status: 'active',
        repeatable: true,
        authorPublicKey: 'damo-pk',
        authorCallsign: 'Damo',
        createdAt: '2026-10-24T10:00:00.000Z',
    };

    const oneOffPending = {
        id: 'post-oneoff',
        title: 'Old Lawn Mower',
        description: 'Runs well',
        type: 'offer',
        category: 'goods',
        credits: 30,
        priceType: 'fixed',
        status: 'pending',
        repeatable: false,
        authorPublicKey: 'seller-pk',
        authorCallsign: 'Seller',
        pendingTransactionId: 'tx-oneoff',
        createdAt: '2026-10-24T10:00:00.000Z',
    };

    const myNeedPending = {
        id: 'post-myneed',
        title: 'Fix my fence',
        description: 'Two panels down',
        type: 'need',
        category: 'services',
        credits: 20,
        priceType: 'fixed',
        status: 'pending',
        repeatable: false,
        authorPublicKey: identity.publicKey,
        authorCallsign: identity.callsign,
        pendingTransactionId: 'tx-myneed',
        createdAt: '2026-10-03T10:00:00.000Z',
    };

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (filter?: any) => {
            if (filter?.id === 'post-myneed') return [myNeedPending] as any;
            if (filter?.id === 'post-rec') return [recurringOffer] as any;
            if (filter?.id === 'post-oneoff') return [oneOffPending] as any;
            return [recurringOffer, oneOffPending] as any;
        });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 100, isBlockedFromTrading: false } as any);
    });

    it('recurring Offer + my pending tx shows the trust hold panel with Release, the new payer words, and hides Accept', async () => {
        const myPendingTx: api.MarketplaceTransaction = {
            id: 'tx-damo',
            postId: 'post-rec',
            postTitle: 'Gardening Mentorship',
            credits: 45,
            status: 'pending',
            buyerPublicKey: identity.publicKey,
            buyerCallsign: identity.callsign,
            sellerPublicKey: 'damo-pk',
            sellerCallsign: 'Damo',
            createdAt: '2026-10-24T10:00:00.000Z',
        };

        render(
            <MarketplacePage
                identity={identity}
                openPostId="post-rec"
                transactions={[myPendingTx]}
            />
        );

        // Wait for post to open
        await screen.findByText('Gardening Mentorship');

        // Panel with Release button must be visible
        expect(await screen.findByRole('button', { name: /Release Credits/i }, { timeout: 5000 })).toBeInTheDocument();

        // The new payer words:
        expect(screen.getByText(/You took this up on.*45 Beans held in trust/)).toBeInTheDocument();
        expect(screen.getByText(/Release the Beans when it's done\./)).toBeInTheDocument();
        expect(screen.getByText(/You can take it up again once this one is done\./)).toBeInTheDocument();
        expect(screen.getByText(/All your deals ›/)).toBeInTheDocument();

        // Accept Offer button must stay hidden
        expect(screen.queryByRole('button', { name: /Accept Offer/i })).not.toBeInTheDocument();
    });

    // Deciding review on 9bf7d11d, finding 1: the link opens the deals sheet from the listing page itself.
    it('"All your deals ›" on the listing page opens Your deals there', async () => {
        const myPendingTx: api.MarketplaceTransaction = {
            id: 'tx-damo', postId: 'post-rec', postTitle: 'Gardening Mentorship', credits: 45, status: 'pending',
            buyerPublicKey: identity.publicKey, buyerCallsign: identity.callsign, sellerPublicKey: 'damo-pk', sellerCallsign: 'Damo',
            createdAt: '2026-10-24T10:00:00.000Z',
        };
        render(<MarketplacePage identity={identity} openPostId="post-rec" transactions={[myPendingTx]} />);
        await screen.findByText('Gardening Mentorship');
        expect(screen.queryByRole('heading', { name: 'Your deals' })).not.toBeInTheDocument();
        fireEvent.click(await screen.findByRole('button', { name: /All your deals ›/ }, { timeout: 5000 }));
        expect(await screen.findByRole('heading', { name: 'Your deals' })).toBeInTheDocument();
    });

    // Finding 2: on a Need the author pays, and is never told they "took this up".
    it("a Need's author, who pays, sees Release but not \"You took this up\"", async () => {
        const needTx: api.MarketplaceTransaction = {
            id: 'tx-myneed', postId: 'post-myneed', postTitle: 'Fix my fence', credits: 20, status: 'pending',
            buyerPublicKey: identity.publicKey, buyerCallsign: identity.callsign, sellerPublicKey: 'helper-pk', sellerCallsign: 'Helper',
            createdAt: '2026-10-24T10:00:00.000Z',
        };
        render(<MarketplacePage identity={identity} openPostId="post-myneed" transactions={[needTx]} />);
        await screen.findByText('Fix my fence');
        expect(await screen.findByRole('button', { name: /Release Credits/i }, { timeout: 5000 })).toBeInTheDocument();
        expect(screen.queryByText(/You took this up on/)).not.toBeInTheDocument();
    });

    // Finding 3: no deal loaded yet → no date at all (never the post's own date).
    it('with the deal not loaded, the payer line names no date', async () => {
        render(<MarketplacePage identity={identity} openPostId="post-myneed" transactions={[]} />);
        await screen.findByText('Fix my fence');
        await screen.findByRole('button', { name: /Release Credits/i }, { timeout: 5000 });
        expect(screen.queryByText(/You took this up on/)).not.toBeInTheDocument();
        expect(screen.queryByText(/3 Oct/)).not.toBeInTheDocument();
    });

    it("a stranger's pending tx on the same recurring Offer shows neither the panel nor my words, and shows Accept", async () => {
        const strangerTx: api.MarketplaceTransaction = {
            id: 'tx-stranger',
            postId: 'post-rec',
            postTitle: 'Gardening Mentorship',
            credits: 45,
            status: 'pending',
            buyerPublicKey: 'stranger-pk',
            buyerCallsign: 'Stranger',
            sellerPublicKey: 'damo-pk',
            sellerCallsign: 'Damo',
            createdAt: '2026-10-24T10:00:00.000Z',
        };

        render(
            <MarketplacePage
                identity={identity}
                openPostId="post-rec"
                transactions={[strangerTx]}
            />
        );

        await screen.findByText('Gardening Mentorship');
        await screen.findByRole('button', { name: /Accept Offer/i }, { timeout: 5000 });

        // Panel with Release button must NOT be visible
        expect(screen.queryByRole('button', { name: /Release Credits/i })).not.toBeInTheDocument();

        // My words must NOT be visible
        expect(screen.queryByText(/You took this up on/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Release the Beans when it's done\./)).not.toBeInTheDocument();

        // Accept button IS visible
        expect(screen.getByRole('button', { name: /Accept Offer/i })).toBeInTheDocument();
    });

    it('a one-off pending post shows Release panel with new payer words and hides Accept (unchanged)', async () => {
        const myOneOffTx: api.MarketplaceTransaction = {
            id: 'tx-oneoff',
            postId: 'post-oneoff',
            postTitle: 'Old Lawn Mower',
            credits: 30,
            status: 'pending',
            buyerPublicKey: identity.publicKey,
            buyerCallsign: identity.callsign,
            sellerPublicKey: 'seller-pk',
            sellerCallsign: 'Seller',
            createdAt: '2026-10-24T10:00:00.000Z',
        };

        render(
            <MarketplacePage
                identity={identity}
                openPostId="post-oneoff"
                transactions={[myOneOffTx]}
            />
        );

        await screen.findByText('Old Lawn Mower');

        // Panel with Release button is visible
        expect(await screen.findByRole('button', { name: /Release Credits/i }, { timeout: 5000 })).toBeInTheDocument();

        // Shows payer words
        expect(screen.getByText(/You took this up on.*30 Beans held in trust/)).toBeInTheDocument();
        expect(screen.getByText(/Release the Beans when it's done\./)).toBeInTheDocument();
        expect(screen.getByText(/All your deals ›/)).toBeInTheDocument();

        // NOT recurring, so "You can take it up again once this one is done." is NOT present
        expect(screen.queryByText(/You can take it up again once this one is done\./)).not.toBeInTheDocument();

        // Accept button is hidden
        expect(screen.queryByRole('button', { name: /Accept Offer/i })).not.toBeInTheDocument();
    });
});

describe('MarketplacePage: shop parity for editing offers', () => {
    const authorIdentity: BeanPoolIdentity = {
        publicKey: 'author-pubkey',
        privateKey: 'mock-private-key-hex',
        callsign: 'Author',
        createdAt: '2026-09-17T00:00:00.000Z',
    };

    const publicPost = {
        id: 'post-public',
        title: 'Public Offer',
        description: 'Open to all',
        type: 'offer',
        category: 'goods',
        credits: 10,
        status: 'active',
        active: true,
        authorPublicKey: 'author-pubkey',
        authorCallsign: 'Author',
        audienceScope: 'public',
        createdAt: '2026-09-15T00:00:00Z',
    };

    const groupPost = {
        id: 'post-group',
        title: 'Group Offer',
        description: 'For group only',
        type: 'offer',
        category: 'goods',
        credits: 10,
        status: 'active',
        active: true,
        authorPublicKey: 'author-pubkey',
        authorCallsign: 'Author',
        audienceScope: 'group',
        targetGroupId: 'group-1',
        createdAt: '2026-09-15T00:00:00Z',
    };

    const directPost = {
        id: 'post-direct',
        title: 'One-Person Offer',
        description: 'For one person',
        type: 'offer',
        category: 'goods',
        credits: 10,
        status: 'active',
        active: true,
        authorPublicKey: 'author-pubkey',
        authorCallsign: 'Author',
        audienceScope: 'direct',
        targetPubkey: 'other-pubkey',
        createdAt: '2026-09-15T00:00:00Z',
    };

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([publicPost, groupPost, directPost] as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.stubGlobal('fetch', async (url: string) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            if (path === '/api/shops/mine') {
                return { ok: true, status: 200, json: async () => ({ shop: null }) };
            }
            if (path.startsWith('/api/marketplace/posts')) {
                return { ok: true, status: 200, json: async () => [{ id: 'post-public', type: 'offer', status: 'active', audienceScope: 'public', shopId: null }] };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });
    });

    it('hides "Put this in your shop" row on group and one-person offers', async () => {
        // Group post
        const { unmount } = render(<MarketplacePage identity={authorIdentity} openPostId="post-group" />);
        const editBtn = await screen.findByRole('button', { name: /Edit Post/i });
        fireEvent.click(editBtn);

        // Wait to make sure async shop check would have resolved
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.queryByTestId('edit-post-shop')).not.toBeInTheDocument();
        unmount();

        // Direct/one-person post
        render(<MarketplacePage identity={authorIdentity} openPostId="post-direct" />);
        const editBtn2 = await screen.findByRole('button', { name: /Edit Post/i });
        fireEvent.click(editBtn2);

        await new Promise((r) => setTimeout(r, 50));
        expect(screen.queryByTestId('edit-post-shop')).not.toBeInTheDocument();
    });

    // Deciding review on 32d23da1, finding B (director's call, as the phone): a refused Save sends NO close — closing "the shop"
    // could delete one the member opened elsewhere meanwhile; an empty shop left open is visible and the member can close it.
    it('a refused Save never closes a shop', async () => {
        let shopOpened = false;
        let shopClosed = false;

        vi.stubGlobal('fetch', async (url: string, init?: any) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            if (path === '/api/shops/mine') {
                if (init?.method === 'PUT') {
                    shopOpened = true;
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            shop: {
                                id: 'new-shop-id',
                                name: "Author's Shop",
                                ownerName: 'Author',
                                ownerPublicKey: 'author-pubkey',
                                category: 'goods',
                                counts: { things: 0, available: 0, toBorrow: 0, toBuy: 0, out: 0, newThisWeek: 0 },
                                paused: false,
                                backOn: null,
                                photoUrl: null,
                            },
                        }),
                    };
                }
                return { ok: true, status: 200, json: async () => ({ shop: null }) };
            }
            if (path === '/api/shops/mine/close') {
                shopClosed = true;
                return { ok: true, status: 200, json: async () => ({ success: true, cleared: 0, ended: 0, resumed: 0 }) };
            }
            if (path.startsWith('/api/marketplace/posts')) {
                return { ok: true, status: 200, json: async () => [{ id: 'post-public', type: 'offer', status: 'active', audienceScope: 'public', shopId: null }] };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        // Simulate save refusal by the node
        vi.spyOn(api, 'updateMarketplacePost').mockRejectedValue(new Error('shop_public_only'));

        const view = render(<MarketplacePage identity={authorIdentity} openPostId="post-public" />);
        const editBtn = await screen.findByRole('button', { name: /Edit Post/i });
        // findBy* returns on the commit that shows the button, before React has run that commit's passive effects. One of them
        // (a listing's edit ends with it: MarketplacePage.tsx, keyed on selectedPost?.id) clears the form on the commit where
        // the id first appears. A click in that gap sets the form's state first and the queued effect clears it after: the
        // form never opens and the toggle never comes. React runs every pending effect before it renders again, so render once
        // more and the gap is closed on whatever clock this machine keeps (act(async () => {}) closes only the last millisecond
        // of it: RTL drains with a 0 ms timer, React flushes from setImmediate).
        view.rerender(<MarketplacePage identity={authorIdentity} openPostId="post-public" />);
        fireEvent.click(editBtn);

        // Put this in your shop should be visible for public offer
        const toggle = await screen.findByTestId('edit-post-shop');
        expect(toggle).toBeInTheDocument();

        // Tick "Put this in your shop"
        fireEvent.click(toggle);

        // Save
        const saveBtn = screen.getByRole('button', { name: /Save/i });
        fireEvent.click(saveBtn);

        // Error message appears
        expect(await screen.findByText('shop_public_only')).toBeInTheDocument();

        expect(shopOpened).toBe(true);   // the Save did open one before the node refused
        expect(shopClosed).toBe(false);
    });

    it('keeps shop toggle hidden when listing shop id cannot be read', async () => {
        vi.stubGlobal('fetch', async (url: string) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            if (path === '/api/shops/mine') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        shop: {
                            id: 'shop-1',
                            name: "Author's Shop",
                            ownerName: 'Author',
                            ownerPublicKey: 'author-pubkey',
                            category: 'goods',
                            counts: { things: 1, available: 1, toBorrow: 0, toBuy: 1, out: 0, newThisWeek: 0 },
                            paused: false,
                            backOn: null,
                            photoUrl: null,
                        },
                    }),
                };
            }
            if (path.startsWith('/api/marketplace/posts')) {
                return { ok: false, status: 500, json: async () => ({ error: 'timeout' }) };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        render(<MarketplacePage identity={authorIdentity} openPostId="post-public" />);
        const editBtn = await screen.findByRole('button', { name: /Edit Post/i });
        fireEvent.click(editBtn);

        await new Promise((r) => setTimeout(r, 50));
        expect(screen.queryByTestId('edit-post-shop')).not.toBeInTheDocument();
    });
});

/**
 * Deals S4 (scratch/fable-design/DESIGN-deals-fable.md §3.2, §3.3): every listing kind, by who is reading it. Payer, payee,
 * asker and author; a keeper of the enterprise that wrote it, acting at the enterprise's own doors (routes/treasury.ts);
 * a keeper of another enterprise and a stranger, who see nothing of anyone's deal. The feed's chip says only the reader's own.
 */
describe('MarketplacePage (deals-s4): a listing shows your deal for who you are', () => {
    const ME = identity.publicKey;
    const ENT = 'farm-co-pk';
    const at = '2026-10-24T10:00:00.000Z';
    const listing = (over: Record<string, unknown>) => ({
        id: 'p', title: 'Listing', description: 'Words', type: 'offer', category: 'services', credits: 45, priceType: 'fixed',
        status: 'active', repeatable: false, authorPublicKey: 'damo-pk', authorCallsign: 'Damo', createdAt: at, photos: ['/p.jpg'], ...over,
    });
    const deal = (over: Partial<api.MarketplaceTransaction>): api.MarketplaceTransaction => ({
        id: 'tx', postId: 'p', postTitle: 'Listing', credits: 45, status: 'pending', buyerPublicKey: ME, buyerCallsign: 'Guest',
        sellerPublicKey: 'damo-pk', sellerCallsign: 'Damo', createdAt: at, ...over,
    });
    let feed: any[] = [];
    let entDeals: api.MarketplaceTransaction[] = [];
    let keeperOf: string[] = [];

    beforeEach(() => {
        vi.restoreAllMocks();
        feed = [];
        entDeals = [];
        keeperOf = [];
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) => (f?.id ? feed.filter(p => p.id === f.id) : f?.author ? [] : feed) as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getTreasury').mockResolvedValue(null);
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockImplementation(async () => ({ balance: 100, isBlockedFromTrading: false, keeperOf }) as any);
        vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ ratings: [], average: 0, count: 0 } as any);
        // As the node answers (GET /api/marketplace/transactions): of one status when asked, its 50 newest.
        vi.spyOn(api, 'getMyMarketplaceTransactions').mockImplementation(async (pk: string, status?: string) => (pk === ENT
            ? entDeals.filter(d => !status || d.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50)
            : []));
    });
    const entReads = () => vi.mocked(api.getMyMarketplaceTransactions).mock.calls.filter(c => c[0] === ENT);

    async function open(post: any, txs: api.MarketplaceTransaction[], extra: Record<string, unknown> = {}) {
        feed = [post];
        const view = render(<MarketplacePage identity={identity} isMember={true} openPostId={post.id} onPostOpened={() => {}} transactions={txs} {...extra} />);
        await screen.findByRole('heading', { name: post.title });
        await act(async () => { await new Promise(r => setTimeout(r, 30)); });
        return view;
    }
    const noTakeUp = () => {
        expect(screen.queryByRole('button', { name: /Accept Offer/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /I can do this/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Ask to borrow/ })).not.toBeInTheDocument();
    };

    // ── Not the author ─────────────────────────────────────────────────────────────────────────────────────────────
    it('one-off Offer, payer, held: Release and Cancel, no Accept', async () => {
        await open(listing({ title: 'Lawn mower', status: 'pending', pendingTransactionId: 'tx' }), [deal({})]);
        expect(await screen.findByRole('button', { name: /Release Credits/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Cancel Hold/ })).toBeInTheDocument();
        expect(screen.queryByTestId('taken-by-other')).not.toBeInTheDocument();
        noTakeUp();
    });

    it("one-off Need, payee (helping, approved): \"You're helping with this\", the payer named, Cancel, never Release", async () => {
        await open(listing({ title: 'Fix the fence', type: 'need', status: 'pending', authorCallsign: 'Kofi', authorPublicKey: 'kofi-pk', pendingTransactionId: 'tx' }),
            [deal({ credits: 20, buyerPublicKey: 'kofi-pk', buyerCallsign: 'Kofi', sellerPublicKey: ME, sellerCallsign: 'Guest' })]);
        expect(await screen.findByText("You're helping with this · 20 Beans held for you")).toBeInTheDocument();
        expect(screen.getByText('⏳ Pending Release by Kofi')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Cancel Hold/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Release Credits/ })).not.toBeInTheDocument();
        noTakeUp();
    });

    it('repeatable Need, payee: the same, and the listing stays on the board with nothing to take up again', async () => {
        await open(listing({ title: 'Stall help', type: 'need', repeatable: true, authorCallsign: 'Kofi', authorPublicKey: 'kofi-pk' }),
            [deal({ credits: 20, buyerPublicKey: 'kofi-pk', buyerCallsign: 'Kofi', sellerPublicKey: ME, sellerCallsign: 'Guest' })]);
        expect(await screen.findByText("You're helping with this · 20 Beans held for you")).toBeInTheDocument();
        noTakeUp();
    });

    it('free Need, payee (helping, approved): no Beans held, never "0 Beans held for you"', async () => {
        await open(listing({ title: 'Carry chairs', type: 'need', credits: 0, status: 'pending', authorCallsign: 'Kofi', authorPublicKey: 'kofi-pk', pendingTransactionId: 'tx' }),
            [deal({ credits: 0, buyerPublicKey: 'kofi-pk', buyerCallsign: 'Kofi', sellerPublicKey: ME, sellerCallsign: 'Guest' })]);
        expect(await screen.findByText("You're helping with this · no Beans held")).toBeInTheDocument();
        expect(screen.queryByText(/0 Beans held/)).not.toBeInTheDocument();
    });

    it('Need, asked:"You offered to help · waiting on Kofi" and Cancel Offer, no second offer', async () => {
        await open(listing({ title: 'Stall help', type: 'need', repeatable: true, authorCallsign: 'Kofi', authorPublicKey: 'kofi-pk' }),
            [deal({ status: 'requested', buyerPublicKey: 'kofi-pk', buyerCallsign: 'Kofi', sellerPublicKey: ME })]);
        expect(await screen.findByText('You offered to help · waiting on Kofi')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel Offer' })).toBeInTheDocument();
        noTakeUp();
    });

    // Cold start N4: "I can do this" on a Need says the plain thing; the 1.5% fee is stated on the deal (the request card below, the Payee's line).
    describe('"I can do this" on a Need (cold start N4)', () => {
        const SAM = { authorPublicKey: 'sam-pk', authorCallsign: 'Sam' };
        const tapIt = async () => { fireEvent.click(await screen.findByRole('button', { name: '✋ I can do this' })); return screen.findByText('I can do this'); };

        it('a priced Need: the heading, the amount and the name, who agrees and when the Beans are yours, and no fee line', async () => {
            await open(listing({ title: 'Dig a bed', type: 'need', credits: 40, ...SAM }), []);
            expect(await tapIt()).toBeInTheDocument();
            expect(screen.getByText("You'd do it for 40 Beans. Sam agrees, you do it, Sam confirms, and the Beans are yours.")).toBeInTheDocument();
            expect(screen.queryByText(/Offer to Fulfill/)).not.toBeInTheDocument();
            expect(screen.queryByText(/1\.5%|transaction fee|Commons Pool/)).not.toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
        });

        it('priced by the hour: the total follows the hours typed, and no usable hours means no sentence rather than a wrong amount', async () => {
            await open(listing({ title: 'Dig a bed', type: 'need', credits: 20, priceType: 'hourly', ...SAM }), []);
            await tapIt();
            expect(screen.getByText("You'd do it for 20 Beans. Sam agrees, you do it, Sam confirms, and the Beans are yours.")).toBeInTheDocument();
            const hours = screen.getByRole('textbox');
            fireEvent.change(hours, { target: { value: '3' } });
            expect(screen.getByText("You'd do it for 60 Beans. Sam agrees, you do it, Sam confirms, and the Beans are yours.")).toBeInTheDocument();
            // The sentence's box goes with it: no empty bordered box where the sentence was (as the phone).
            const sentenceBox = () => screen.queryByText(/You'd do it for/)?.closest('div.rounded-lg') ?? null;
            const boxClass = sentenceBox()!.className;
            const boxes = () => Array.from(document.querySelectorAll('div')).filter((d) => d.className === boxClass).length;
            expect(boxes()).toBe(1);
            for (const none of ['', '0']) {
                fireEvent.change(hours, { target: { value: none } });
                expect(screen.queryByText(/You'd do it for/)).not.toBeInTheDocument();
                expect(boxes()).toBe(0);
            }
            // An ambiguous quantity keeps its box: the refusal words say how to type it, and no amount is said.
            fireEvent.change(hours, { target: { value: '1.2.3' } });
            expect(screen.getByText(/Type one decimal mark at most/)).toBeInTheDocument();
            expect(boxes()).toBe(1);
            expect(screen.queryByText(/You'd do it for/)).not.toBeInTheDocument();
        });

        it('a free Need says it is free, and never "0 Beans" or Beans that will not come', async () => {
            await open(listing({ title: 'Carry chairs', type: 'need', credits: 0, ...SAM }), []);
            await tapIt();
            expect(screen.getByText("You'd do it for free. Sam agrees, you do it, and Sam confirms.")).toBeInTheDocument();
            expect(screen.queryByText(/0 Beans|0 B\b|free listing/)).not.toBeInTheDocument();
        });

        it('a Need with no name on it says the person who asked, not a made-up name', async () => {
            await open(listing({ title: 'Dig a bed', type: 'need', credits: 40, authorPublicKey: 'sam-pk', authorCallsign: '' }), []);
            await tapIt();
            expect(screen.getByText("You'd do it for 40 Beans. The person who asked agrees, you do it, they confirm, and the Beans are yours.")).toBeInTheDocument();
        });

        it('an Offer keeps its own words', async () => {
            await open(listing({ title: 'Lawn mower', credits: 45 }), []);
            fireEvent.click(await screen.findByRole('button', { name: /Accept Offer/ }));
            expect(await screen.findByText('Accept this Offer?')).toBeInTheDocument();
            expect(screen.getByText(/By proceeding, you commit 45 B/)).toBeInTheDocument();
            expect(screen.queryByText(/I can do this|You'd do it for/)).not.toBeInTheDocument();
        });

        it('the helper whose request is waiting reads the fee on the deal: the Beans, the 1.5% and what is theirs net', async () => {
            await open(listing({ title: 'Dig a bed', type: 'need', repeatable: true, credits: 20, ...SAM }),
                [deal({ status: 'requested', credits: 20, buyerPublicKey: 'sam-pk', buyerCallsign: 'Sam', sellerPublicKey: ME })]);
            const card = (await screen.findByText('Offer Pending Approval')).parentElement!;
            expect(card).toHaveTextContent('You have requested to earn 20 credits (19.70 net after 1.5% transaction fee) (100% community owned) for fulfilling this need.');
        });

        it('a free request has no fee line to read', async () => {
            await open(listing({ title: 'Carry chairs', type: 'need', repeatable: true, credits: 0, ...SAM }),
                [deal({ status: 'requested', credits: 0, buyerPublicKey: 'sam-pk', buyerCallsign: 'Sam', sellerPublicKey: ME })]);
            const card = (await screen.findByText('Offer Pending Approval')).parentElement!;
            expect(card).not.toHaveTextContent(/1\.5%|transaction fee/);
        });
    });

    it('lendable Offer, asked: "You asked to borrow it · nothing is held until Damo says yes" and Withdraw', async () => {
        await open(listing({ title: 'Ladder', lendable: true }), [deal({ status: 'requested' })]);
        expect(await screen.findByText('You asked to borrow it · nothing is held until Damo says yes')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeInTheDocument();
        noTakeUp();
    });

    it('lendable Offer, borrowed (held): Release, never Ask again', async () => {
        await open(listing({ title: 'Ladder', lendable: true, status: 'pending', pendingTransactionId: 'tx' }), [deal({})]);
        expect(await screen.findByRole('button', { name: /Release Credits/ })).toBeInTheDocument();
        noTakeUp();
    });

    it('recurring Offer whose last deal is done: Accept again, "You\'ve had this before", and Leave Review when unrated', async () => {
        await open(listing({ title: 'Pottery course', repeatable: true }), [
            deal({ id: 'tx-old', status: 'completed', completedAt: '2026-10-02T10:00:00.000Z', ratedByBuyer: true }),
            deal({ id: 'tx-new', status: 'completed', completedAt: '2026-10-20T10:00:00.000Z', ratedByBuyer: false }),
        ]);
        expect(await screen.findByText("You've had this before · done 20 Oct")).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '⭐ Review' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Accept Offer/ })).toBeInTheDocument();
    });

    it('a one-off taken up by someone else, reached by a link: "Taken up by someone else for now.", nothing to take, nothing of theirs', async () => {
        await open(listing({ title: 'Lawn mower', status: 'pending', pendingTransactionId: 'tx-kofi' }), []);
        expect(await screen.findByText('Taken up by someone else for now.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Release Credits/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Cancel Hold/ })).not.toBeInTheDocument();
        noTakeUp();
    });

    it("a stranger on a recurring Offer with someone else's deals: nothing said, Accept shown", async () => {
        await open(listing({ title: 'Pottery course', repeatable: true }), [deal({ buyerPublicKey: 'kofi-pk', buyerCallsign: 'Kofi' })]);
        expect(await screen.findByRole('button', { name: /Accept Offer/ })).toBeInTheDocument();
        expect(screen.queryByTestId('deals-under-way')).not.toBeInTheDocument();
        expect(screen.queryByText(/Kofi/)).not.toBeInTheDocument();
        expect(screen.queryByTestId('taken-by-other')).not.toBeInTheDocument();
    });

    // ── The author ───────────────────────────────────────────────────────────────────────────────────────────────
    it('the author of a recurring Offer with two deals under way: one row each, the payer named, Cancel each, no Release', async () => {
        await open(listing({ title: 'Pottery course', repeatable: true, authorPublicKey: ME, authorCallsign: 'Guest' }), [
            deal({ id: 'tx-a', buyerPublicKey: 'marty-pk', buyerCallsign: 'Marty', sellerPublicKey: ME, createdAt: '2026-10-24T10:00:00.000Z' }),
            deal({ id: 'tx-b', buyerPublicKey: 'kofi-pk', buyerCallsign: 'Kofi', sellerPublicKey: ME, credits: 30, createdAt: '2026-10-26T10:00:00.000Z' }),
        ]);
        const rows = await screen.findByTestId('deals-under-way');
        expect(within(rows).getByText('Deals under way: 2')).toBeInTheDocument();
        expect(within(screen.getByTestId('deal-row-tx-a')).getByText('Marty · 45 Beans held · since 24 Oct')).toBeInTheDocument();
        expect(within(screen.getByTestId('deal-row-tx-a')).getByText('⏳ Pending Release by Marty')).toBeInTheDocument();
        expect(within(screen.getByTestId('deal-row-tx-b')).getByText('Kofi · 30 Beans held · since 26 Oct')).toBeInTheDocument();
        expect(within(rows).getAllByRole('button', { name: /Cancel Hold/ })).toHaveLength(2);
        expect(screen.queryByRole('button', { name: /Release Credits/ })).not.toBeInTheDocument();
        noTakeUp();
    });

    it("the author messages each deal's other side from its row, and reaches all their deals", async () => {
        const chat = vi.spyOn(api, 'createConversationApi').mockResolvedValue({ conversation: { id: 'conv-1' } } as any);
        const onNavigate = vi.fn();
        await open(listing({ title: 'Pottery course', repeatable: true, authorPublicKey: ME, authorCallsign: 'Guest' }), [
            deal({ id: 'tx-a', buyerPublicKey: 'marty-pk', buyerCallsign: 'Marty', sellerPublicKey: ME }),
            deal({ id: 'tx-b', buyerPublicKey: 'kofi-pk', buyerCallsign: 'Kofi', sellerPublicKey: ME }),
        ], { onNavigate });
        const rows = await screen.findByTestId('deals-under-way');
        expect(within(screen.getByTestId('deal-row-tx-b')).getByRole('button', { name: 'Message Kofi' })).toBeInTheDocument();
        expect(within(rows).getByRole('button', { name: 'All your deals ›' })).toBeInTheDocument();
        fireEvent.click(within(screen.getByTestId('deal-row-tx-a')).getByRole('button', { name: 'Message Marty' }));
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('messages', 'conv-1'));
        expect(chat).toHaveBeenCalledWith('dm', [ME, 'marty-pk'], ME, undefined, 'p');
    });

    // R1 (engine/request-limits.ts): reports cleared the member's message requests; every screen that starts a chat words the refusal.
    describe("403 dm_requests_limited on a Message button: the rule in the member's language, dated, not the node's English", () => {
        const LIMITED = "People you wrote to reported your message requests, so they were cleared and you can't send new ones until 2026-11-08. You can still answer people who wrote to you, and post.";
        const SPANISH = 'Personas a las que escribiste denunciaron tus solicitudes de mensaje, así que se borraron y no puedes enviar nuevas hasta el 2026-11-08. Todavía puedes responder a quienes te escribieron y publicar.';
        const refused = () => Object.assign(new Error(LIMITED), { status: 403, code: 'dm_requests_limited' });
        const inSpanish = () => {
            const es = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../packages/beanpool-core/words/es.json'), 'utf8'));
            setLanguage('es', [es]);
            return () => setLanguage('en');
        };

        it('Message on a listing', async () => {
            const undo = inSpanish();
            try {
                vi.spyOn(api, 'createConversationApi').mockRejectedValue(refused());
                await open(listing({ title: 'Pottery course' }), []);
                fireEvent.click(await screen.findByRole('button', { name: /💬/ }));
                expect(await screen.findByText(SPANISH)).toBeInTheDocument();
                expect(screen.queryByText(LIMITED)).not.toBeInTheDocument();
            } finally { undo(); }
        });

        it("Message on a deal's row (the author's)", async () => {
            const undo = inSpanish();
            try {
                vi.spyOn(api, 'createConversationApi').mockRejectedValue(refused());
                await open(listing({ title: 'Pottery course', repeatable: true, authorPublicKey: ME, authorCallsign: 'Guest' }), [
                    deal({ id: 'tx-a', buyerPublicKey: 'marty-pk', buyerCallsign: 'Marty', sellerPublicKey: ME }),
                ]);
                const row = await screen.findByTestId('deal-row-tx-a');
                fireEvent.click(within(row).getByRole('button', { name: /Marty/ }));
                expect(await screen.findByText(SPANISH)).toBeInTheDocument();
                expect(screen.queryByText(LIMITED)).not.toBeInTheDocument();
            } finally { undo(); }
        });
    });

    it('the author opened at one deal (Home, the header): that row comes first', async () => {
        await open(listing({ title: 'Pottery course', repeatable: true, authorPublicKey: ME, authorCallsign: 'Guest' }), [
            deal({ id: 'tx-a', buyerPublicKey: 'marty-pk', buyerCallsign: 'Marty', sellerPublicKey: ME, createdAt: '2026-10-26T10:00:00.000Z' }),
            deal({ id: 'tx-b', buyerPublicKey: 'kofi-pk', buyerCallsign: 'Kofi', sellerPublicKey: ME, createdAt: '2026-10-24T10:00:00.000Z' }),
        ], { openTxId: 'tx-b' });
        const rows = within(await screen.findByTestId('deals-under-way')).getAllByTestId(/^deal-row-/);
        expect(rows.map(r => r.getAttribute('data-testid'))).toEqual(['deal-row-tx-b', 'deal-row-tx-a']);
    });

    it("a Need's author, who pays: their row has Release and Cancel, and Release names the deal", async () => {
        const done = vi.spyOn(api, 'completeMarketplaceTransaction').mockResolvedValue({ success: true } as any);
        await open(listing({ title: 'Fix the fence', type: 'need', repeatable: true, authorPublicKey: ME, authorCallsign: 'Guest' }),
            [deal({ id: 'tx-h', credits: 20, buyerPublicKey: ME, sellerPublicKey: 'helper-pk', sellerCallsign: 'Helper' })]);
        const row = await screen.findByTestId('deal-row-tx-h');
        expect(within(row).getByRole('button', { name: /Cancel Hold/ })).toBeInTheDocument();
        fireEvent.click(within(row).getByRole('button', { name: /Release Credits/ }));
        fireEvent.click(within(row).getByRole('button', { name: 'Release Credits' }));
        await waitFor(() => expect(done).toHaveBeenCalledWith('tx-h', ME, undefined));
    });

    it("a daily Need's author changing 3 days to 5 on their row: the 100 Beans that will go, not the 60 held, then released for 5", async () => {
        const done = vi.spyOn(api, 'completeMarketplaceTransaction').mockResolvedValue({ success: true } as any);
        await open(listing({ title: 'Pick the olives', type: 'need', repeatable: true, priceType: 'daily', credits: 20, authorPublicKey: ME, authorCallsign: 'Guest' }),
            [deal({ id: 'tx-d', credits: 60, hours: 3, buyerPublicKey: ME, sellerPublicKey: 'helper-pk', sellerCallsign: 'Helper' })]);
        const row = await screen.findByTestId('deal-row-tx-d');
        fireEvent.click(within(row).getByRole('button', { name: /Release Credits/ }));
        const line = within(row).getByTestId('release-line-tx-d');
        expect(line).toHaveTextContent('Transferring 60 B to Helper');
        fireEvent.change(within(row).getByRole('textbox'), { target: { value: '5' } });
        expect(line).toHaveTextContent('Transferring 100 B to Helper');
        // A time that could mean two numbers says why, as the panel says it, and Release waits for one that can't.
        fireEvent.change(within(row).getByRole('textbox'), { target: { value: '1,000' } });
        expect(line).toHaveTextContent('Type the amount without thousands separators, like 1000.5.');
        fireEvent.change(within(row).getByRole('textbox'), { target: { value: '5' } });
        fireEvent.click(within(row).getByRole('button', { name: 'Release Credits' }));
        await waitFor(() => expect(done).toHaveBeenCalledWith('tx-d', ME, 5));
    });

    it("one who took up an hourly Offer: the panel's total is the deal's own rate for the hours typed", async () => {
        await open(listing({ title: 'Garden help', priceType: 'hourly', credits: 15, status: 'pending', pendingTransactionId: 'tx-g' }),
            [deal({ id: 'tx-g', credits: 30, hours: 2 })]);
        fireEvent.click(await screen.findByRole('button', { name: /Release Credits/ }));
        // Opened at the 2 hours the deal was struck for, as each row and the phone open it (it opened at 1: 15 B).
        expect(screen.getByRole('textbox')).toHaveValue('2');
        expect(await screen.findByText('Transferring 30 B to Damo')).toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox'), { target: { value: '3' } });
        expect(screen.getByText('Transferring 45 B to Damo')).toBeInTheDocument();
    });

    it('a door that named a deal over by now: the listing as it is, Accept again, and what became of that deal', async () => {
        await open(listing({ title: 'Lawn mower' }), [deal({ id: 'tx-c', status: 'cancelled' })], { openTxId: 'tx-c' });
        expect(await screen.findByTestId('pinned-deal-over')).toHaveTextContent('That deal was cancelled.');
        expect(screen.getByRole('button', { name: /Accept Offer/ })).toBeInTheDocument();
    });

    // The line says what became of the deal a door named, above a listing the member may take up again. Once they have (a deal
    // of their own held or asked for on it), the box of that deal is the page and the old line goes (review on #2588).
    it("a door that named a deal over, the listing since taken up again: the new deal's box, and no line on the old one", async () => {
        await open(listing({ title: 'Lawn mower', status: 'pending', pendingTransactionId: 'tx-n' }), [
            deal({ id: 'tx-c', status: 'cancelled', createdAt: '2026-10-20T10:00:00.000Z' }),
            deal({ id: 'tx-n', status: 'pending', createdAt: '2026-10-27T10:00:00.000Z' }),
        ], { openTxId: 'tx-c' });
        expect(await screen.findByRole('button', { name: /Release Credits/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Cancel Hold/ })).toBeInTheDocument();
        expect(screen.queryByTestId('pinned-deal-over')).not.toBeInTheDocument();
        noTakeUp();
    });

    it("a door that named a deal over, the member since asked to borrow it again: whom they wait on, Withdraw, and no line on the old deal", async () => {
        await open(listing({ title: 'Ladder', lendable: true }), [
            deal({ id: 'tx-c', status: 'cancelled', createdAt: '2026-10-20T10:00:00.000Z' }),
            deal({ id: 'tx-q', status: 'requested', createdAt: '2026-10-27T10:00:00.000Z' }),
        ], { openTxId: 'tx-c' });
        expect(await screen.findByText('You asked to borrow it · nothing is held until Damo says yes')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeInTheDocument();
        expect(screen.queryByTestId('pinned-deal-over')).not.toBeInTheDocument();
    });

    it('the line is there while the listing waits to be taken up, and goes the moment the member takes it up again', async () => {
        const over = deal({ id: 'tx-c', status: 'cancelled', createdAt: '2026-10-20T10:00:00.000Z' });
        const props = { identity, isMember: true, openPostId: 'p', onPostOpened: () => {}, openTxId: 'tx-c' };
        const mower = listing({ title: 'Lawn mower', repeatable: true });
        const view = await open(mower, [over], { openTxId: 'tx-c' });
        expect(await screen.findByTestId('pinned-deal-over')).toHaveTextContent('That deal was cancelled.');
        expect(screen.getByRole('button', { name: /Accept Offer/ })).toBeInTheDocument();
        // Taken up again: the app's deals now hold the new one (the take-up refreshes them).
        view.rerender(<MarketplacePage {...props} transactions={[over, deal({ id: 'tx-n', status: 'pending', createdAt: '2026-10-27T10:00:00.000Z' })]} />);
        await act(async () => { await new Promise(r => setTimeout(r, 30)); });
        expect(screen.queryByTestId('pinned-deal-over')).not.toBeInTheDocument();
        noTakeUp();
    });

    it("a stranger to the deal a link names (a deal that is not theirs): no line on it, and nothing of it", async () => {
        await open(listing({ title: 'Lawn mower' }), [], { openTxId: 'tx-someone-elses' });
        expect(await screen.findByRole('button', { name: /Accept Offer/ })).toBeInTheDocument();
        expect(screen.queryByTestId('pinned-deal-over')).not.toBeInTheDocument();
    });

    it("a recurring Offer's author opened on one finished deal by its alert, another deal under way: that deal's line stays (their rows are no take-up)", async () => {
        await open(listing({ title: 'Pottery course', repeatable: true, authorPublicKey: ME, authorCallsign: 'Guest' }), [
            deal({ id: 'tx-done', status: 'completed', buyerPublicKey: 'marty-pk', buyerCallsign: 'Marty', sellerPublicKey: ME, completedAt: '2026-10-27T10:00:00.000Z' }),
            deal({ id: 'tx-b', buyerPublicKey: 'kofi-pk', buyerCallsign: 'Kofi', sellerPublicKey: ME, createdAt: '2026-10-26T10:00:00.000Z' }),
        ], { openTxId: 'tx-done' });
        expect(await screen.findByTestId('pinned-deal-over')).toHaveTextContent('That deal is done.');
        expect(await screen.findByTestId('deal-row-tx-b')).toBeInTheDocument();
    });

    it('one who asked to borrow, opened on their request by its id (Your deals, Home): whom they wait on, and Withdraw', async () => {
        await open(listing({ title: 'Ladder', lendable: true }), [deal({ id: 'tx-q', status: 'requested' })], { openTxId: 'tx-q' });
        expect(await screen.findByText('You asked to borrow it · nothing is held until Damo says yes')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeInTheDocument();
        expect(screen.queryByTestId('pinned-deal-over')).not.toBeInTheDocument();
    });

    for (const [step, after] of [['Release', 'completed'], ['Cancel', 'active']] as const) {
        it(`a one-off Need's author, after ${step} from their row: the listing as the node has it now, no panel for a deal that is over`, async () => {
            vi.spyOn(api, 'completeMarketplaceTransaction').mockResolvedValue({ success: true } as any);
            vi.spyOn(api, 'cancelMarketplaceTransaction').mockResolvedValue({ success: true } as any);
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            const fence = listing({ title: 'Fix the fence', type: 'need', status: 'pending', pendingTransactionId: 'tx-h', authorPublicKey: ME, authorCallsign: 'Guest', credits: 20 });
            const held = deal({ id: 'tx-h', credits: 20, buyerPublicKey: ME, sellerPublicKey: 'helper-pk', sellerCallsign: 'Helper' });
            // Opened by its link, which the app then clears (App.tsx, onPostOpened): nothing re-selects the listing after.
            const view = await open(fence, [held]);
            view.rerender(<MarketplacePage identity={identity} isMember={true} transactions={[held]} />);
            const row = await screen.findByTestId('deal-row-tx-h');
            // The node, once the step is taken: the listing moved on, the deal over.
            feed = [{ ...fence, status: after }];
            if (step === 'Release') {
                fireEvent.click(within(row).getByRole('button', { name: /Release Credits/ }));
                fireEvent.click(within(row).getByRole('button', { name: 'Release Credits' }));
            } else {
                fireEvent.click(within(row).getByRole('button', { name: /Cancel Hold/ }));
            }
            await act(async () => { await new Promise(r => setTimeout(r, 30)); });
            view.rerender(<MarketplacePage identity={identity} isMember={true} transactions={[{ ...held, status: step === 'Release' ? 'completed' : 'cancelled' }]} />);
            await act(async () => { await new Promise(r => setTimeout(r, 30)); });
            expect(screen.queryByTestId('deals-under-way')).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /Release Credits/ })).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /Cancel Hold/ })).not.toBeInTheDocument();
        });
    }

    it("a Need's author with a request: Approve and Deny", async () => {
        await open(listing({ title: 'Fix the fence', type: 'need', authorPublicKey: ME, authorCallsign: 'Guest' }),
            [deal({ id: 'tx-r', status: 'requested', buyerPublicKey: ME, sellerPublicKey: 'helper-pk', sellerCallsign: 'Helper' })]);
        expect(await screen.findByText('✋ Fulfillment Requests (1)')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Approve & Hold in Trust' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    });

    it('a lender with a free loan out: the row says no Beans are held, never "0 Beans held"', async () => {
        await open(listing({ title: 'Ladder', lendable: true, credits: 0, status: 'pending', authorPublicKey: ME, authorCallsign: 'Guest', pendingTransactionId: 'tx-l' }),
            [deal({ id: 'tx-l', credits: 0, buyerPublicKey: 'mo-pk', buyerCallsign: 'Mo', sellerPublicKey: ME, sellerCallsign: 'Guest' })]);
        const row = await screen.findByTestId('deal-row-tx-l');
        expect(within(row).getByText('Mo · no Beans held · since 24 Oct')).toBeInTheDocument();
        expect(screen.queryByText(/0 Beans held/)).not.toBeInTheDocument();
    });

    // ── Keepers ──────────────────────────────────────────────────────────────────────────────────────────────────
    const farmNeed = listing({ title: 'Mend the polytunnel', type: 'need', repeatable: true, authorPublicKey: ENT, authorCallsign: 'Farm Co-op', credits: 20 });
    const farmOffer = listing({ title: 'Dozen eggs', repeatable: true, authorPublicKey: ENT, authorCallsign: 'Farm Co-op', credits: 6 });

    it("a keeper of the enterprise on its Need: the enterprise's deal (read for it), Release at its door, no Cancel, no Offer to fulfil", async () => {
        keeperOf = [ENT];
        entDeals = [deal({ id: 'tx-f', credits: 20, buyerPublicKey: ENT, buyerCallsign: 'Farm Co-op', sellerPublicKey: 'mo-pk', sellerCallsign: 'Mo' })];
        const done = vi.spyOn(api, 'treasuryComplete').mockResolvedValue({ success: true });
        const ownDoor = vi.spyOn(api, 'completeMarketplaceTransaction');
        await open(farmNeed, []);
        const row = await screen.findByTestId('deal-row-tx-f');
        // Its open deals only, each status read by itself.
        expect(entReads().map(c => c[1]).sort()).toEqual(['pending', 'requested']);
        expect(screen.getByText('You act for Farm Co-op here.')).toBeInTheDocument();
        expect(within(row).getByText('Mo · 20 Beans held · since 24 Oct')).toBeInTheDocument();
        // The node has no door for a keeper to cancel the enterprise's hold: none shown (Mo cancels as himself).
        expect(within(row).queryByRole('button', { name: /Cancel Hold/ })).not.toBeInTheDocument();
        // The keeper messages Mo as themselves.
        expect(within(row).getByRole('button', { name: 'Message Mo' })).toBeInTheDocument();
        noTakeUp();
        fireEvent.click(within(row).getByRole('button', { name: /Release Credits/ }));
        fireEvent.click(within(row).getByRole('button', { name: 'Release Credits' }));
        await waitFor(() => expect(done).toHaveBeenCalledWith(ENT, 'tx-f', undefined));
        expect(ownDoor).not.toHaveBeenCalled();
    });

    it("a keeper sees the enterprise's held deal behind 50 newer finished ones, with its Release", async () => {
        keeperOf = [ENT];
        const sold = Array.from({ length: 50 }, (_, i) => deal({ id: `tx-sold-${i}`, postId: 'other', status: 'completed', credits: 6,
            buyerPublicKey: `buyer-${i}`, sellerPublicKey: ENT, createdAt: new Date(Date.parse('2026-10-27T00:00:00.000Z') + i * 60_000).toISOString() }));
        entDeals = [...sold, deal({ id: 'tx-old', credits: 20, buyerPublicKey: ENT, buyerCallsign: 'Farm Co-op', sellerPublicKey: 'mo-pk', sellerCallsign: 'Mo' })];
        await open(farmNeed, []);
        const row = await screen.findByTestId('deal-row-tx-old');
        expect(within(row).getByRole('button', { name: /Release Credits/ })).toBeInTheDocument();
    });

    it("a keeper paid by the enterprise's own Need: their pay is another keeper's to release; they cancel as themselves", async () => {
        keeperOf = [ENT];
        entDeals = [deal({ id: 'tx-k', credits: 20, buyerPublicKey: ENT, buyerCallsign: 'Farm Co-op', sellerPublicKey: ME, sellerCallsign: 'Guest' })];
        await open(farmNeed, []);
        const row = await screen.findByTestId('deal-row-tx-k');
        expect(within(row).getByText('⏳ Pending Release by Farm Co-op')).toBeInTheDocument();
        expect(within(row).queryByRole('button', { name: /Release Credits/ })).not.toBeInTheDocument();
        expect(within(row).getByRole('button', { name: /Cancel Hold/ })).toBeInTheDocument();
    });

    it("a keeper on the enterprise's recurring Offer: each buyer's row, waiting on them to release; no Release, no Cancel, no Accept", async () => {
        keeperOf = [ENT];
        entDeals = [
            deal({ id: 'tx-1', credits: 6, buyerPublicKey: 'mo-pk', buyerCallsign: 'Mo', sellerPublicKey: ENT, sellerCallsign: 'Farm Co-op' }),
            deal({ id: 'tx-2', credits: 6, buyerPublicKey: 'ana-pk', buyerCallsign: 'Ana', sellerPublicKey: ENT, sellerCallsign: 'Farm Co-op', createdAt: '2026-10-25T10:00:00.000Z' }),
        ];
        await open(farmOffer, []);
        const rows = await screen.findByTestId('deals-under-way');
        expect(within(rows).getByText('Deals under way: 2')).toBeInTheDocument();
        expect(within(rows).getByText('⏳ Pending Release by Mo')).toBeInTheDocument();
        expect(within(rows).getByText('⏳ Pending Release by Ana')).toBeInTheDocument();
        expect(within(rows).queryByRole('button', { name: /Release Credits|Cancel Hold/ })).not.toBeInTheDocument();
        noTakeUp();
    });

    it("a keeper answers a request on the enterprise's Need at its door", async () => {
        keeperOf = [ENT];
        entDeals = [deal({ id: 'tx-q', status: 'requested', credits: 20, buyerPublicKey: ENT, buyerCallsign: 'Farm Co-op', sellerPublicKey: 'mo-pk', sellerCallsign: 'Mo' })];
        const yes = vi.spyOn(api, 'treasuryApprove').mockResolvedValue({ success: true });
        const ownYes = vi.spyOn(api, 'approveMarketplaceRequest');
        await open(farmNeed, []);
        fireEvent.click(await screen.findByRole('button', { name: 'Approve & Hold in Trust' }));
        await waitFor(() => expect(yes).toHaveBeenCalledWith(ENT, 'tx-q'));
        expect(ownYes).not.toHaveBeenCalled();
    });

    it("a keeper's own offer to help on the enterprise's Need: theirs to withdraw, never on the farm's list to approve or deny", async () => {
        keeperOf = [ENT];
        const mine = deal({ id: 'tx-mine', status: 'requested', credits: 20, buyerPublicKey: ENT, buyerCallsign: 'Farm Co-op', sellerPublicKey: ME, sellerCallsign: 'Guest' });
        entDeals = [mine, deal({ id: 'tx-mo', status: 'requested', credits: 20, buyerPublicKey: ENT, buyerCallsign: 'Farm Co-op', sellerPublicKey: 'mo-pk', sellerCallsign: 'Mo', createdAt: '2026-10-25T10:00:00.000Z' })];
        const withdraw = vi.spyOn(api, 'cancelMarketplaceRequest').mockResolvedValue({ success: true } as any);
        const deny = vi.spyOn(api, 'treasuryReject');
        await open(farmNeed, [mine]);
        // Mo's offer is the farm's to answer; the keeper's own is not.
        expect(await screen.findByText('✋ Fulfillment Requests (1)')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Approve & Hold in Trust' })).toHaveLength(1);
        expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(1);
        expect(screen.getByText('You offered to help · waiting on Farm Co-op')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel Offer' }));
        await waitFor(() => expect(withdraw).toHaveBeenCalledWith('tx-mine', ME));
        expect(deny).not.toHaveBeenCalled();
    });

    for (const [who, kept] of [['a keeper of another enterprise', ['other-co-pk']], ['a member who keeps nothing', []]] as const) {
        it(`${who}: a stranger to the farm's deals, never read for them, and may offer to help`, async () => {
            keeperOf = [...kept];
            entDeals = [deal({ id: 'tx-f', buyerPublicKey: ENT, sellerPublicKey: 'mo-pk', sellerCallsign: 'Mo' })];
            await open(farmNeed, []);
            expect(screen.queryByTestId('deals-under-way')).not.toBeInTheDocument();
            expect(await screen.findByRole('button', { name: /I can do this/ })).toBeInTheDocument();
            expect(entReads()).toEqual([]);
        });
    }

    // ── The feed ─────────────────────────────────────────────────────────────────────────────────────────────────
    it("the feed's chip: 🤝 IN TRUST on my deal held, ✋ ASKED on my request, nothing on a stranger's deal or a finished one", async () => {
        feed = [
            listing({ id: 'a', title: 'Held one', repeatable: true }),
            listing({ id: 'b', title: 'Asked one', lendable: true }),
            listing({ id: 'c', title: 'Someone else deal', repeatable: true }),
            listing({ id: 'd', title: 'Done one', repeatable: true }),
        ];
        render(<MarketplacePage identity={identity} isMember={true} transactions={[
            deal({ id: '1', postId: 'a' }),
            deal({ id: '2', postId: 'b', status: 'requested' }),
            deal({ id: '3', postId: 'c', buyerPublicKey: 'kofi-pk', sellerPublicKey: 'damo-pk' }),
            deal({ id: '4', postId: 'd', status: 'completed' }),
        ]} />);
        await screen.findByText('Held one');
        await waitFor(() => expect(screen.getAllByTestId('card-deal-chip')).toHaveLength(2));
        const chips = screen.getAllByTestId('card-deal-chip').map(c => c.textContent);
        expect(chips.sort()).toEqual(['✋ ASKED', '🤝 IN TRUST']);
        // Each on its own card: the card holding the chip carries that listing's title.
        const cardOf = (chip: HTMLElement) => { let el: HTMLElement | null = chip; while (el && !/Held one|Asked one/.test(el.textContent || '')) el = el.parentElement; return el?.textContent || ''; };
        const [first, second] = screen.getAllByTestId('card-deal-chip');
        const pairs = [first, second].map(c => [c.textContent, /Held one/.test(cardOf(c)) && !/Asked one/.test(cardOf(c)) ? 'a' : /Asked one/.test(cardOf(c)) && !/Held one/.test(cardOf(c)) ? 'b' : '?']);
        expect(pairs.sort()).toEqual([['✋ ASKED', 'b'], ['🤝 IN TRUST', 'a']]);
    });

    // DW3 (DESIGN-detail-pages-fable.md §2.1, as DESIGN-detail-pages-frame-fable.md §1.7 and §3 amend it): the listing's page in
    // the phone's order, which the DOM keeps (no order-*), so Tab follows what a phone shows: the chips, the title, the terms
    // box, the take-up, the photo, the quiet row (Message, Share), the description, Posted by, Report. From md the event page's
    // grid places the photo left, spanning three rows, and the head, the action and the rest right. No outer card.
    describe('the listing page keeps the phone\'s order (the take-up before the photo) and only moves columns on wide screens (DW3)', () => {
        const after = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        const cls = (el: Element) => el.className.split(/\s+/);

        it('at 320 px and 130% text, in the DOM: chips, title, terms, the take-up, the photo, Message and Share, the description, Posted by, Report', async () => {
            const width = window.innerWidth;
            Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
            document.documentElement.style.fontSize = '130%';
            try {
                await open(listing({}), []);
                const chips = screen.getByTestId('listing-chips');
                const title = screen.getByRole('heading', { name: 'Listing' });
                const price = screen.getByText('Asking Price');
                const takeUp = screen.getByRole('button', { name: /Accept Offer/ });
                const photo = screen.getByRole('button', { name: /View enlarged photo 1 of 1/ });
                const message = screen.getByRole('button', { name: /Message/ });
                const share = screen.getByTestId('share-button');
                const words = screen.getByText('Words');
                const postedBy = screen.getByText('Posted by');
                const report = screen.getByRole('button', { name: '🚩 Report' });
                const inOrder = [chips, title, price, takeUp, photo, message, share, words, postedBy, report];
                for (let i = 1; i < inOrder.length; i++) expect(after(inOrder[i - 1], inOrder[i])).toBe(true);
                // The take-up before Posted by and Share: the first screen's one commit.
                expect(after(takeUp, postedBy)).toBe(true);
                expect(after(takeUp, share)).toBe(true);
                // Message and Share are one quiet row, in the page's neutral outline.
                const row = screen.getByTestId('listing-quiet-row');
                expect(row.contains(message) && row.contains(share)).toBe(true);
                for (const b of [message, share]) expect(cls(b)).toEqual(expect.arrayContaining(['min-h-[48px]', 'grow', 'basis-auto', 'break-words', 'border-nature-300']));
                // The chips are the list card's, one node each, and "how long ago" at the row's end.
                expect(screen.getByTestId('listing-type-chip').textContent).toBe('OFFER');
                expect(screen.getByTestId('listing-category-chip').textContent).toMatch(/Services$/);
                expect(cls(screen.getByTestId('listing-ago'))).toContain('ms-auto');
                // The terms box on the shell, left-aligned, in the page's own font (no centring, no mono).
                const box = screen.getByTestId('listing-price');
                expect(cls(box)).toEqual(expect.arrayContaining(['rounded-[14px]', 'border', 'p-3']));
                expect(box.innerHTML).not.toMatch(/text-center|font-mono/);
                // The photo is 4:3 at the column's width, and nothing in the column is fixed wider than the screen.
                expect(cls(photo)).toEqual(expect.arrayContaining(['w-full', 'aspect-[4/3]']));
                const detail = screen.getByTestId('listing-detail');
                expect(detail.innerHTML).not.toMatch(/\b(w|min-w)-\[(3[3-9]\d|[4-9]\d\d)px\]/);
                // No outer card (main's was `rounded-2xl … shadow-soft` round the strip and the words): the column is the page.
                expect(detail.closest('.shadow-soft')).toBeNull();
                expect(detail.parentElement!.querySelector('.shadow-soft')).toBeNull();
                expect(detail.innerHTML).not.toMatch(/\border-\d/);
            } finally {
                document.documentElement.style.fontSize = '';
                Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
            }
        });

        it('a Need: I can do this comes before the photo, Posted by and Share too', async () => {
            await open(listing({ type: 'need', title: 'Apples needed' }), []);
            const takeUp = screen.getByRole('button', { name: /I can do this/ });
            expect(after(takeUp, screen.getByRole('button', { name: /View enlarged photo 1 of 1/ }))).toBe(true);
            expect(after(takeUp, screen.getByText('Posted by'))).toBe(true);
            expect(after(takeUp, screen.getByTestId('share-button'))).toBe(true);
            expect(screen.getByTestId('listing-type-chip').textContent).toBe('NEED');
        });

        it('places the photo left from md up, spanning the three rows, and the head, the action and the rest right, by the grid', async () => {
            await open(listing({}), []);
            const detail = screen.getByTestId('listing-detail');
            expect(cls(detail)).toEqual(expect.arrayContaining(['md:grid', 'md:grid-cols-2', 'md:grid-rows-[auto_auto_1fr]', 'md:gap-x-6']));
            expect(cls(screen.getByTestId('listing-photos'))).toEqual(expect.arrayContaining(['md:col-start-1', 'md:row-start-1', 'md:row-span-3']));
            expect(cls(screen.getByTestId('listing-head'))).toEqual(expect.arrayContaining(['md:col-start-2', 'md:row-start-1']));
            expect(cls(screen.getByTestId('listing-action'))).toEqual(expect.arrayContaining(['md:col-start-2', 'md:row-start-2']));
            expect(cls(screen.getByTestId('listing-body'))).toEqual(expect.arrayContaining(['md:col-start-2', 'md:row-start-3']));
            // The grid's children are those four, in the phone's order.
            expect(Array.from(detail.children).map(c => c.getAttribute('data-testid'))).toEqual(['listing-head', 'listing-action', 'listing-photos', 'listing-body']);
            expect(screen.getByRole('button', { name: /Accept Offer/ }).closest('[data-testid="listing-action"]')).not.toBeNull();
        });

        it('with no photos stays one column, nothing placed, and the category\'s tile stands in the photo\'s place', async () => {
            await open(listing({ photos: [] }), []);
            const detail = screen.getByTestId('listing-detail');
            expect(detail.className).not.toContain('md:grid');
            expect(detail.innerHTML).not.toMatch(/md:col-start/);
            expect(Array.from(detail.children).map(c => c.getAttribute('data-testid'))).toEqual(['listing-head', 'listing-action', 'listing-tile-banner', 'listing-body']);
            expect(screen.queryByRole('button', { name: /View enlarged photo/ })).toBeNull();
        });

        it('several photos: the first large, the others small under it, each opening the lightbox at its own place', async () => {
            await open(listing({ photos: ['/a.jpg', '/b.jpg', '/c.jpg'] }), []);
            const first = screen.getByRole('button', { name: /View enlarged photo 1 of 3/ });
            expect(cls(first)).toEqual(expect.arrayContaining(['w-full', 'aspect-[4/3]']));
            const third = screen.getByRole('button', { name: /View enlarged photo 3 of 3/ });
            expect(cls(third)).toEqual(expect.arrayContaining(['w-20', 'aspect-[4/3]']));
            expect(after(first, third)).toBe(true);
            lightboxProps.last = null;
            fireEvent.click(third);
            await waitFor(() => expect(lightboxProps.last).not.toBeNull());
            expect(lightboxProps.last!.photos).toEqual(['/a.jpg', '/b.jpg', '/c.jpg']);
            expect(lightboxProps.last!.initialIndex).toBe(2);
        });
    });
});
