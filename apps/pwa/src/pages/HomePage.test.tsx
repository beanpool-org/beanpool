/**
 * The web Home page (DESIGN-home-dashboard-fable.md, slice H3): one request, the cached answer drawn first, the "…" menu
 * and Edit home, interests that reorder the Market card in place, the doorbell's single re-read, offline, and the
 * visitor's Home. The node is lib/api.ts mocked; IndexedDB is the in-memory stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { HomeAnswer, HomeLayout } from '../lib/home-cards';
import type { HomeRead } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

const hooks = vi.hoisted(() => ({ sync: [] as Array<() => unknown>, open: [] as Array<() => void> }));

vi.mock('../lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    getHome: vi.fn(),
    saveHomePreferences: vi.fn(async (_pk: string, prefs: { 'home.layout'?: HomeLayout; interests?: string[] }) => ({ success: true, ...prefs })),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 1 })),
    getCommunityMe: vi.fn(async () => ({ probation: { rules: 'ordinary', keptPosts: 0, ageEndsAt: null } })),
}));
vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn((cb: () => unknown) => { hooks.sync.push(cb); return () => { hooks.sync = hooks.sync.filter(c => c !== cb); }; }),
    onSocketOpen: vi.fn((cb: () => void) => { hooks.open.push(cb); return () => { hooks.open = hooks.open.filter(c => c !== cb); }; }),
}));

import * as api from '../lib/api';
import { HomePage, HOME_HINT, HOME_NOT_ON_NODE, HOME_OFFLINE } from './HomePage';
import { homeCacheKey, resetHomeCacheForTest, writeCachedHome } from '../lib/home-cache';

const ME: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const NOW = new Date().toISOString();

function answer(over: Partial<HomeAnswer> = {}, cards: HomeAnswer['cards'] = {}): HomeAnswer {
    return {
        generatedAt: NOW, profile: 'local',
        features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false },
        me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: ['arts'], area: null, firstOffer: false, standing: 'member' },
        layout: null,
        cards: {
            events: { items: [{ id: 'e1', title: 'Seed swap', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: null, place: 'Town Hall', rsvp: 'going' }], radiusKm: null },
            market: {
                items: [
                    { id: 'p1', type: 'offer', title: 'Pottery lessons', category: 'arts', credits: 20, photoUrl: null },
                    { id: 'p2', type: 'offer', title: 'Sourdough', category: 'food', credits: 12, photoUrl: null },
                    { id: 'p3', type: 'need', title: 'Borrow a drill', category: 'tools', photoUrl: null, credits: 0 },
                ], total14d: 3, more: false,
            },
            pulse: { items: [{ id: 'u1', title: 'How our LETS started', thumbnailUrl: null, platform: 'youtube', callsign: 'River Folk', category: 'education', url: null }] },
            beans: { balance: 12, room: 200, tier: 'Resident', activated: true, frozen: false },
            community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
            ...cards,
        },
        ...over,
    };
}

/** A 200 from the node: the answer and its tag. */
const fresh = (a: HomeAnswer, etag = 'W/"home-test"'): HomeRead => ({ notModified: false, answer: a, etag });

const cardIds = () => Array.from(document.querySelectorAll('[data-testid^="home-card-"]')).map(e => e.getAttribute('data-testid')!.replace('home-card-', '')).filter(id => id !== 'menu');
/** The Market card's rows, as a screen reader names them. */
const marketTitles = () => within(screen.getByTestId('home-card-market')).getAllByTestId('home-market-item').map(e => e.getAttribute('aria-label') ?? '');

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetHomeCacheForTest();
    localStorage.clear();
    hooks.sync = [];
    hooks.open = [];
    vi.mocked(api.getHome).mockReset();
    vi.mocked(api.saveHomePreferences).mockClear();
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('one request, the cached answer first (§5)', () => {
    it('lands with one GET /api/home and draws the cards the answer holds, in the default order', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        const nav = vi.fn();
        render(<HomePage identity={ME} onNavigate={nav} />);
        await screen.findByTestId('home-card-community');
        expect(api.getHome).toHaveBeenCalledTimes(1);
        // No layout in this browser yet: the node applies the account's own (no `cards=`).
        expect(vi.mocked(api.getHome).mock.calls[0][0]).toEqual({});
        expect(cardIds()).toEqual(['events', 'market', 'pulse', 'beans', 'community']);
        expect(screen.getByTestId('home-card-beans')).toHaveTextContent('12 Beans · room to spend 200');
        expect(screen.getByTestId('home-card-community')).toHaveTextContent('81 members · 23 trades this month.');
    });

    it('draws the copy this browser kept before the node answers, and asks for the cards its layout shows', async () => {
        const layout: HomeLayout = { v: 1, order: [], hidden: ['pulse'], dismissed: {}, updatedAt: '2026-10-01T00:00:00.000Z' };
        await writeCachedHome(homeCacheKey(ME.publicKey), { etag: null, answer: answer({ layout }, { community: { name: 'Cached town', members: 5 } }), layout, layoutUnsaved: false, savedAt: 1 });
        let answerNode!: (r: HomeRead) => void;
        vi.mocked(api.getHome).mockReturnValue(new Promise(r => { answerNode = r; }));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByText('Cached town')).toBeInTheDocument();
        expect(screen.queryByTestId('home-card-pulse')).toBeNull();
        const asked = vi.mocked(api.getHome).mock.calls[0][0]!.cards!;
        expect(asked).not.toContain('pulse');
        expect(asked).toContain('needs');
        expect(asked).not.toContain('interests');
        await act(async () => { answerNode(fresh(answer({ layout }))); });
        expect(await screen.findByText('Mullumbimby')).toBeInTheDocument();
    });

    it('sends the tag of the copy it keeps; a 304 keeps the copy drawn, and the next read sends the new tag after a 200', async () => {
        await writeCachedHome(homeCacheKey(ME.publicKey), { etag: 'W/"home-kept"', answer: answer({}, { community: { name: 'Kept town', members: 5 } }), layout: null, layoutUnsaved: false, savedAt: 1 });
        vi.mocked(api.getHome).mockResolvedValueOnce({ notModified: true, etag: 'W/"home-kept"' });
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByText('Kept town')).toBeInTheDocument();
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(1));
        expect(vi.mocked(api.getHome).mock.calls[0][1]).toBe('W/"home-kept"');
        expect(screen.queryByTestId('home-offline')).toBeNull();
        // A change: a 200 with a new tag, drawn, and its tag sent next.
        vi.mocked(api.getHome).mockResolvedValueOnce(fresh(answer(), 'W/"home-new"'));
        vi.useFakeTimers();
        hooks.sync.forEach(cb => cb());
        await vi.advanceTimersByTimeAsync(3_100);
        vi.useRealTimers();
        expect(await screen.findByText('Mullumbimby')).toBeInTheDocument();
        vi.mocked(api.getHome).mockResolvedValueOnce({ notModified: true, etag: 'W/"home-new"' });
        vi.useFakeTimers();
        hooks.sync.forEach(cb => cb());
        await vi.advanceTimersByTimeAsync(3_100);
        expect(vi.mocked(api.getHome).mock.calls[2][1]).toBe('W/"home-new"');
        expect(screen.getByText('Mullumbimby')).toBeInTheDocument();
    });

    it('a first read with no copy sends no tag', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(vi.mocked(api.getHome).mock.calls[0][1]).toBeNull();
    });

    it('offline with a copy: the copy stays, and the page says so, politely', async () => {
        await writeCachedHome(homeCacheKey(ME.publicKey), { etag: null, answer: answer(), layout: null, layoutUnsaved: false, savedAt: 1 });
        vi.mocked(api.getHome).mockRejectedValue(new TypeError('Failed to fetch'));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('home-offline')).toHaveTextContent(HOME_OFFLINE);
        expect(screen.getByTestId('home-live')).toHaveTextContent(HOME_OFFLINE);
        expect(screen.getByTestId('home-card-market')).toBeInTheDocument();
    });

    it('offline with no copy: a sentence and Try again, never a blank page; a node older than Home says that', async () => {
        vi.mocked(api.getHome).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('home-failed')).toHaveTextContent("Couldn't reach your community");
        vi.mocked(api.getHome).mockResolvedValueOnce(fresh(answer()));
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByTestId('home-card-market')).toBeInTheDocument();
        cleanup();
        resetHomeCacheForTest();
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        vi.mocked(api.getHome).mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('home-failed')).toHaveTextContent(HOME_NOT_ON_NODE);
    });

    it('an answer that is not Home (a proxy page, an empty object) is a failed read, not a crash', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh({} as HomeAnswer));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('home-failed')).toBeInTheDocument();
    });

    it('a burst of doorbells is one re-read, 3 s after the last; none while the tab is hidden', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(api.getHome).toHaveBeenCalledTimes(1);
        vi.useFakeTimers();
        for (let i = 0; i < 20; i++) { hooks.sync.forEach(cb => cb()); await vi.advanceTimersByTimeAsync(100); }
        expect(api.getHome).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(api.getHome).toHaveBeenCalledTimes(2);
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        hooks.sync.forEach(cb => cb());
        await vi.advanceTimersByTimeAsync(5_000);
        expect(api.getHome).toHaveBeenCalledTimes(2);
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        await vi.advanceTimersByTimeAsync(10);
        expect(api.getHome).toHaveBeenCalledTimes(3);
    });

    it("the socket's own first sync, right after landing, is not a change: no second read", async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        vi.useFakeTimers();
        hooks.open.forEach(cb => cb());
        hooks.sync.forEach(cb => cb());
        await vi.advanceTimersByTimeAsync(5_000);
        expect(api.getHome).toHaveBeenCalledTimes(1);
    });
});

describe('tailoring (§4)', () => {
    it('"…" says which card it is for; Hide takes the card away and saves the layout on the account', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const pulse = await screen.findByTestId('home-card-pulse');
        const dots = within(pulse).getByRole('button', { name: 'Card options for The Pulse' });
        expect(dots).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(dots);
        expect(dots).toHaveAttribute('aria-expanded', 'true');
        expect(within(pulse).getByRole('button', { name: 'Hide' })).toHaveFocus();
        fireEvent.click(within(pulse).getByRole('button', { name: 'Hide' }));
        await waitFor(() => expect(screen.queryByTestId('home-card-pulse')).toBeNull());
        const saved = vi.mocked(api.saveHomePreferences).mock.calls.at(-1)!;
        expect(saved[0]).toBe(ME.publicKey);
        expect(saved[1]['home.layout']!.hidden).toEqual(['pulse']);
        expect(Date.parse(saved[1]['home.layout']!.updatedAt!)).toBeGreaterThan(0);
    });

    it('the menu closes on Escape and gives focus back to its "…"; Move up is off for the first movable card', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const events = await screen.findByTestId('home-card-events');
        const dots = within(events).getByRole('button', { name: 'Card options for Coming up' });
        fireEvent.click(dots);
        expect(within(events).getByRole('button', { name: 'Move up' })).toBeDisabled();
        fireEvent.keyDown(within(events).getByRole('button', { name: 'Hide' }), { key: 'Escape' });
        expect(within(events).queryByRole('button', { name: 'Hide' })).toBeNull();
        await waitFor(() => expect(dots).toHaveFocus());
    });

    it('Move down swaps a card with the next one, and the community card stays last with no "…"', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const market = await screen.findByTestId('home-card-market');
        fireEvent.click(within(market).getByRole('button', { name: 'Card options for New in the Market' }));
        fireEvent.click(within(market).getByRole('button', { name: 'Move down' }));
        await waitFor(() => expect(cardIds()).toEqual(['events', 'pulse', 'market', 'beans', 'community']));
        expect(within(screen.getByTestId('home-card-community')).queryByTestId('home-card-menu')).toBeNull();
    });

    it('Edit home is a real dialog: labelled, focus inside, a switch per card, Hidden apart, Reset, Escape back to Edit home', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const open = await screen.findByTestId('home-edit-open');
        open.focus();
        fireEvent.click(open);
        const dialog = screen.getByRole('dialog', { name: 'Edit home' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog.contains(document.activeElement)).toBe(true);
        const pulseSwitch = within(dialog).getByRole('switch', { name: 'Show The Pulse' });
        expect(pulseSwitch).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(pulseSwitch);
        expect(within(dialog).getByRole('switch', { name: 'Show The Pulse' })).toHaveAttribute('aria-checked', 'false');
        // The row moved to "Hidden" and was drawn anew: focus went with it, not to the page.
        await waitFor(() => expect(within(dialog).getByRole('switch', { name: 'Show The Pulse' })).toHaveFocus());
        expect(within(within(dialog).getByRole('list', { name: 'Hidden' })).getByText('The Pulse')).toBeInTheDocument();
        expect(screen.queryByTestId('home-card-pulse')).toBeNull();
        // Needs you and the community card are never in the list: they always stay.
        expect(within(dialog).queryByText('Your community')).toBeNull();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Move Coming up down' }));
        fireEvent.click(within(dialog).getByTestId('home-edit-reset'));
        expect(within(dialog).getByRole('switch', { name: 'Show The Pulse' })).toHaveAttribute('aria-checked', 'true');
        const last = vi.mocked(api.saveHomePreferences).mock.calls.at(-1)![1]['home.layout']!;
        expect(last.order).toEqual([]);
        expect(last.hidden).toEqual([]);
        // Tab stays inside.
        const done = within(dialog).getByTestId('home-edit-done');
        done.focus();
        fireEvent.keyDown(done, { key: 'Tab' });
        expect(dialog.contains(document.activeElement)).toBe(true);
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        await waitFor(() => expect(open).toHaveFocus());
    });

    it('a newer layout from another device wins over this browser\'s older copy', async () => {
        const older: HomeLayout = { v: 1, order: [], hidden: ['beans'], dismissed: {}, updatedAt: '2026-09-01T00:00:00.000Z' };
        const newer: HomeLayout = { v: 1, order: [], hidden: ['pulse'], dismissed: {}, updatedAt: '2026-10-01T00:00:00.000Z' };
        await writeCachedHome(homeCacheKey(ME.publicKey), { etag: null, answer: answer({ layout: older }), layout: older, layoutUnsaved: false, savedAt: 1 });
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ layout: newer })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByText('Mullumbimby');
        await waitFor(() => expect(screen.queryByTestId('home-card-pulse')).toBeNull());
        expect(screen.getByTestId('home-card-beans')).toBeInTheDocument();
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it("this browser's newer layout that never reached the node is sent again after the next read", async () => {
        const mine: HomeLayout = { v: 1, order: [], hidden: ['beans'], dismissed: {}, updatedAt: '2026-10-02T00:00:00.000Z' };
        await writeCachedHome(homeCacheKey(ME.publicKey), { etag: null, answer: answer(), layout: mine, layoutUnsaved: true, savedAt: 1 });
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ layout: { ...mine, hidden: [], updatedAt: '2026-09-01T00:00:00.000Z' } })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(api.saveHomePreferences).toHaveBeenCalledWith(ME.publicKey, { 'home.layout': mine }));
        expect(screen.queryByTestId('home-card-beans')).toBeNull();
    });
});

describe('interests (§4.3, §6.2)', () => {
    it('a member with none sees the chips; a tap reorders the Market card in place and saves on the account and in the Market', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ me: { ...answer().me!, interests: [] } })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const chips = await screen.findByTestId('home-card-interests');
        expect(marketTitles()[0]).toBe('Offer, Pottery lessons, 20 Beans');
        fireEvent.click(within(chips).getByTestId('home-interest-food'));
        expect(within(chips).getByTestId('home-interest-food')).toHaveAttribute('aria-pressed', 'true');
        // The same second: Sourdough (food) first, nothing dropped.
        expect(marketTitles()).toEqual(['Offer, Sourdough, 12 Beans', 'Offer, Pottery lessons, 20 Beans', 'Need, Borrow a drill, Free']);
        expect(api.saveHomePreferences).toHaveBeenCalledWith(ME.publicKey, { interests: ['food'] });
        expect(JSON.parse(localStorage.getItem('bp_fav_categories')!)).toEqual(['food']);
        // The card stays for the visit after the first tap, with Done.
        expect(screen.getByTestId('home-card-interests')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('home-interests-done'));
        expect(screen.queryByTestId('home-card-interests')).toBeNull();
    });

    it('Tune on the Market card opens the chips for a member who has some', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(screen.queryByTestId('home-card-interests')).toBeNull();
        fireEvent.click(screen.getByTestId('home-tune'));
        expect(await screen.findByTestId('home-card-interests')).toBeInTheDocument();
        expect(screen.getByTestId('home-interest-arts')).toHaveAttribute('aria-pressed', 'true');
    });
});

describe('the cards say real things, plainly (§3, §6.3)', () => {
    it('Needs you: amber ▲ and the words for what waits, never red; one tap into the deal', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({}, {
            needs: { items: [
                { kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you: Sourdough', target: { to: 'deal', postId: 'p2', txId: 't1' } },
                { kind: 'message', count: 2, accent: false, label: '3 unread from 2 people', target: { to: 'unread-messages' } },
            ] },
        })));
        const nav = vi.fn();
        render(<HomePage identity={ME} onNavigate={nav} />);
        const needs = await screen.findByTestId('home-card-needs');
        expect(cardIds()[0]).toBe('needs');
        expect(within(needs).queryByTestId('home-card-menu')).toBeNull();
        const deal = within(needs).getByRole('button', { name: 'A deal is waiting for you: Sourdough. Waiting on you.' });
        expect(deal).toHaveTextContent('▲');
        expect(needs.innerHTML).not.toMatch(/\bred-|danger/);
        fireEvent.click(deal);
        expect(nav).toHaveBeenCalledWith('marketplace', 'p2');
        fireEvent.click(within(needs).getByRole('button', { name: '3 unread from 2 people' }));
        expect(nav).toHaveBeenCalledWith('messages');
    });

    it('a new member\'s Beans: nothing to repay, how credit opens; the steps link to where each is done', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({}, {
            beans: { balance: 0, room: 0, tier: 'Newcomer', activated: false, frozen: false },
            steps: { joinedAt: NOW, firstOffer: false, firstPost: false, photo: false, interests: true, invited: false, area: false, knocked: null },
        })));
        const nav = vi.fn();
        render(<HomePage identity={ME} onNavigate={nav} />);
        expect(await screen.findByTestId('home-card-beans')).toHaveTextContent('0 Beans · nothing to repayYour credit opens with a first trade.');
        const steps = screen.getByTestId('home-card-steps');
        fireEvent.click(within(steps).getByRole('button', { name: 'To do: Post your first Offer' }));
        expect(nav).toHaveBeenCalledWith('map-post');
        fireEvent.click(within(steps).getByRole('button', { name: 'To do: Add a photo to your profile' }));
        expect(nav).toHaveBeenCalledWith('settings-profile');
        expect(within(steps).getByRole('button', { name: 'Done: Pick a few things you like' })).toBeInTheDocument();
        // Invite only after the first Offer.
        expect(within(steps).queryByText('Invite someone')).toBeNull();
    });

    it('the one-time hint, once: closed, it does not come back', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('home-hint')).toHaveTextContent(HOME_HINT);
        fireEvent.click(screen.getByRole('button', { name: 'Close this tip' }));
        expect(screen.queryByTestId('home-hint')).toBeNull();
        cleanup();
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(screen.queryByTestId('home-hint')).toBeNull();
    });
});

describe("a visitor's Home in the global lobby (§5.3)", () => {
    const visitorAnswer = (): HomeAnswer => ({
        generatedAt: NOW, profile: 'global', welcome: true, me: null, layout: null,
        features: { beans: false, guestListingsOnly: true, exampleListings: true, invites: false },
        cards: {
            find: { point: null, communities: [], communityCount: 38, nearbyPosts: null, watches: null, knock: null, directoryFetchedAt: null },
            market: { items: [{ id: 'p1', type: 'offer', title: 'Seedlings to give away', category: 'garden', photoUrl: null }], total14d: 1, more: false, examples: true },
            events: { items: [{ id: 'e1', title: 'Beach clean', startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), endsAt: null, place: null, rsvp: null }], radiusKm: null },
            community: { name: null, members: 2310, communities: 38 },
        },
    });

    it('the Join card first, then the public cards; no "…", no Edit home, nothing of a member\'s, examples marked Example', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(visitorAnswer()));
        render(<HomePage identity={null} visitor={{ joinCard: <section data-testid="lobby-join-card">Join BeanPool</section>, beans: false }} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-community');
        const page = screen.getByTestId('home-page');
        expect(page.querySelector('[data-testid]:not([data-testid="home-live"])')!.getAttribute('data-testid')).toBe('lobby-join-card');
        expect(cardIds()).toEqual(['find', 'events', 'market', 'community']);
        expect(screen.queryAllByTestId('home-card-menu')).toHaveLength(0);
        expect(screen.queryByTestId('home-edit-open')).toBeNull();
        expect(screen.queryByTestId('home-hint')).toBeNull();
        expect(screen.getByRole('heading', { name: 'Near you' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'What people post' })).toBeInTheDocument();
        expect(screen.getByTestId('home-card-market')).toHaveTextContent('Free, a swap, or ask');
        expect(screen.getByTestId('home-card-market')).toHaveTextContent('Names, photos of people and exact places appear when you join.');
        // Each example says "Example" first to a screen reader (the visible words are hidden from it), and can't be tapped.
        const examples = within(screen.getByTestId('home-examples')).getAllByTestId('home-example');
        expect(examples).toHaveLength(2);
        for (const ex of examples) {
            expect(ex.querySelector('.sr-only')!.textContent).toMatch(/^Example, not a real listing\. (Offer|Need): /);
            expect(ex.querySelectorAll('button, a')).toHaveLength(0);
        }
        expect(screen.getByTestId('home-card-events')).toHaveTextContent('Place shown after you join');
        expect(screen.getByTestId('home-card-community')).toHaveTextContent('The worldwide community');
        expect(screen.getByTestId('home-card-community')).toHaveTextContent('2,310 members · 38 communities listed.');
        expect(page.textContent).not.toMatch(/Beans|Tune/);
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it('"Share my area" asks the browser once and reads Home again with the area rounded to about 10 km', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(visitorAnswer()));
        const getCurrentPosition = vi.fn((ok: PositionCallback) => ok({ coords: { latitude: -28.5543, longitude: 153.4999 } } as GeolocationPosition));
        vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } });
        render(<HomePage identity={null} visitor={{ joinCard: null, beans: false }} onNavigate={vi.fn()} />);
        fireEvent.click(await screen.findByTestId('home-share-area'));
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(2));
        expect(vi.mocked(api.getHome).mock.calls[1][0]).toEqual({ lat: -28.6, lng: 153.5 });
    });
});
