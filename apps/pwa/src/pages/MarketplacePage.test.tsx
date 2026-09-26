import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { livePostChange } from '@beanpool/core';
import { routeLivePostChange, resetLivePostsForTest } from '../lib/live-posts';

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

vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: () => null,
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

    it('opens the event detail from the card, with the host line', async () => {
        render(<MarketplacePage identity={identity} />);
        const open = await screen.findByRole('button', { name: 'Open event: Working bee' });
        await act(async () => { open.click(); });
        const detail = await screen.findByTestId('event-detail');
        expect(detail).toHaveTextContent('Hosted by Hazel');
        expect(detail).toHaveTextContent('Bindarrabi Hall');
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

    it('does not stretch a tile, or its cell, to the height of the row', async () => {
        await openGrid();
        for (const title of ['Bicycle Repair', 'Chainsaw']) {
            // Anchor: this really is the tile's own root, not some wrapper.
            expect(tileOf(title).className).toContain('flex flex-col');
            expect(tileOf(title).className).not.toMatch(/(^|\s)h-full(\s|$)/);
            expect(cellOf(title).className).not.toMatch(/(^|\s)h-full(\s|$)/);
            // Dropping `h-full` is only half of it. The cell IS the grid item, and a grid with no `items-*`
            // stretches its items to the row, so the cell stayed row-tall while the tile shrank — and the cell
            // is what carries the click and the focus ring. `self-start` is what actually shrinks the cell.
            // jsdom does no layout, so the height itself is measured in e2e/market-grid-shots.mjs.
            expect(cellOf(title).className).toMatch(/(^|\s)self-start(\s|$)/);
        }
    });

    it('reserves the clamped description line instead of letting it absorb the row', async () => {
        await openGrid();
        for (const title of ['Bicycle Repair', 'Chainsaw']) {
            const description = tileOf(title).querySelector('p') as HTMLElement;
            expect(description.className).toContain('line-clamp-1');
            expect(description.className).toContain('min-h-[1.625em]');
            // `flex-1` is the stretch: in a cell taller than the tile it swallowed the difference.
            expect(description.className).not.toMatch(/(^|\s)flex-1(\s|$)/);
        }
    });

    it('gives a tile with a photo and one without the same media height, so VIEW lines up', async () => {
        await openGrid();
        const mediaHeight = (title: string) =>
            (tileOf(title).querySelector('div.relative.w-full') as HTMLElement).className.match(/h-\[\d+px\]/)?.[0];
        expect(mediaHeight('Bicycle Repair')).toBe('h-[110px]'); // emoji placeholder
        expect(mediaHeight('Chainsaw')).toBe('h-[110px]');       // photo
    });

    it('gives the poll two of the columns from md up, and lays its answers out in two', async () => {
        await openGrid();
        expect(pollCard().parentElement!.className).toContain('md:col-span-2');
        expect(pollOptions().className).toContain('md:grid-cols-2');
    });

    // A two-column tile cannot start in the last column of a row: auto-placement moves it down and leaves that
    // cell empty. Where the poll falls depends on the feed and the window, so the hole walks about. Dense flow
    // lets the tiles after it take the cell instead (Marty on #1092).
    it('lets the tiles after the poll fill a cell its two columns are too wide for', async () => {
        await openGrid();
        const gridEl = pollCard().parentElement!.parentElement as HTMLElement;
        // Anchor: this really is the Card View grid, not a wrapper.
        expect(gridEl.className).toContain('grid-cols-1');
        expect(gridEl.className).toContain('xl:grid-cols-5');
        expect(gridEl.className).toContain('grid-flow-row-dense');
    });

    it('shows poll answers in full in the grid — a ballot option you cannot read is not a choice', async () => {
        await openGrid();
        const label = screen.getByText('It is Amazing and we should start on it this weekend');
        expect(label.className).toContain('break-words');
        expect(label.className).not.toMatch(/(^|\s)truncate(\s|$)/);
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
        // The feed read and the viewer's-own read are both held until the push has landed.
        const pending: Array<(v: any) => void> = [];
        vi.mocked(api.getMarketplacePosts).mockImplementation(() => new Promise(r => { pending.push(r); }));
        render(<MarketplacePage identity={identity} />);
        await waitFor(() => expect(pending.length).toBe(2));

        // The list was read before this listing existed.
        await push({ type: 'new_post', post: pushed() });
        await act(async () => { pending[0](posts); pending[1]([]); });

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
