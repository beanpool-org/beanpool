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
import { memoryIndexedDB, type MemoryIndexedDB } from '../lib/memory-indexeddb';

const hooks = vi.hoisted(() => ({ sync: [] as Array<() => unknown>, open: [] as Array<() => void>, announce: [] as Array<(a: unknown) => void> }));

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
    onSystemAnnouncement: vi.fn((cb: (a: unknown) => void) => { hooks.announce.push(cb); return () => { hooks.announce = hooks.announce.filter(c => c !== cb); }; }),
}));

import * as api from '../lib/api';
import { HomePage, HOME_HINT, HOME_NOT_ON_NODE, HOME_OFFLINE, HOME_SIGNED_OUT, TIPS_DONE_WORDS, hiddenWords, tipsKey } from './HomePage';
import { localDay, tipsFor } from '@beanpool/core';
import { NOTICES_SEEN_EVENT } from '../lib/home-cards';
import { homeCacheKey, resetHomeCacheForTest, writeCachedHome } from '../lib/home-cache';
import { resetAccountEpochForTest } from '../lib/account-epoch';
import { clearInAnotherTab, signOutInAnotherTab, signOutOnChannelOnly } from '../lib/another-tab';

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
    resetAccountEpochForTest();
    hooks.sync = [];
    hooks.open = [];
    hooks.announce = [];
    vi.mocked(api.getHome).mockReset();
    // As the mock's own default: a test that stood a node in (nodeKeepingLayout) leaves nothing behind.
    vi.mocked(api.saveHomePreferences).mockReset().mockImplementation(async (_pk, prefs) => ({ success: true, ...prefs }) as never);
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
        // Tips with the first draw (bundled, never asked of the node), after First steps' place.
        expect(cardIds()).toEqual(['tips', 'events', 'market', 'pulse', 'beans', 'community']);
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
        // A new member's first movable card is Tips (after First steps, which this member has done).
        const first = await screen.findByTestId('home-card-tips');
        const dots = within(first).getByRole('button', { name: 'Card options for Tips · 1 of 15' });
        fireEvent.click(dots);
        expect(within(first).getByRole('button', { name: 'Move up' })).toBeDisabled();
        fireEvent.keyDown(within(first).getByRole('button', { name: 'Hide' }), { key: 'Escape' });
        expect(within(first).queryByRole('button', { name: 'Hide' })).toBeNull();
        await waitFor(() => expect(dots).toHaveFocus());
    });

    it('Move down swaps a card with the next one, and the community card stays last with no "…"', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const market = await screen.findByTestId('home-card-market');
        fireEvent.click(within(market).getByRole('button', { name: 'Card options for New in the Market' }));
        fireEvent.click(within(market).getByRole('button', { name: 'Move down' }));
        await waitFor(() => expect(cardIds()).toEqual(['tips', 'events', 'pulse', 'market', 'beans', 'community']));
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

    it("the account's interests become this browser's Market favourites; favourites kept only here move up, and order the card", async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ me: { ...answer().me!, interests: ['tools'] } })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(JSON.parse(localStorage.getItem('bp_fav_categories')!)).toEqual(['tools']);
        cleanup();
        localStorage.clear();
        resetHomeCacheForTest();
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        localStorage.setItem('bp_fav_categories', JSON.stringify(['food']));
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ me: { ...answer().me!, interests: [] } })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        await waitFor(() => expect(api.saveHomePreferences).toHaveBeenCalledWith(ME.publicKey, { interests: ['food'] }));
        expect(marketTitles()[0]).toBe('Offer, Sourdough, 12 Beans');
        // Their own choice, made before: not asked again.
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

/**
 * The node as the server is: it keeps the account's layout (the last write by `updatedAt` wins, an equal one replaces),
 * and builds only the cards asked for (`cards=`), or, asked for none, every card the account's layout doesn't hide.
 */
function nodeKeepingLayout(full: HomeAnswer) {
    let account: HomeLayout | null = null;
    /** The member's other device (or tab) saves `l` on the account. */
    const savedElsewhere = (l: HomeLayout) => { account = l; };
    vi.mocked(api.saveHomePreferences).mockImplementation(async (_pk, prefs) => {
        const l = prefs['home.layout'];
        if (l && (!account || Date.parse(l.updatedAt!) >= Date.parse(account.updatedAt!))) account = l;
        return { success: true, ...(l ? { 'home.layout': account } : {}), ...(prefs.interests ? { interests: prefs.interests } : {}) } as never;
    });
    vi.mocked(api.getHome).mockImplementation(async (params = {}) => {
        const asked = params.cards ?? Object.keys(full.cards).filter(id => !(account?.hidden ?? []).includes(id as never));
        const cards = Object.fromEntries(Object.entries(full.cards).filter(([id]) => asked.includes(id)));
        return fresh({ ...full, layout: account, cards }, `W/"home-${asked.join('.')}-${account?.updatedAt ?? ''}"`);
    });
    return { reads: () => vi.mocked(api.getHome).mock.calls.map(c => c[0]?.cards ?? null), savedElsewhere };
}

describe('a card hidden on an earlier visit comes back at once (PR #1479 review, BLOCKING 2)', () => {
    async function hidePulseThenComeBack() {
        const node = nodeKeepingLayout(answer());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const pulse = await screen.findByTestId('home-card-pulse');
        fireEvent.click(within(pulse).getByRole('button', { name: 'Card options for The Pulse' }));
        fireEvent.click(within(pulse).getByRole('button', { name: 'Hide' }));
        await waitFor(() => expect(screen.queryByTestId('home-card-pulse')).toBeNull());
        await waitFor(() => expect(api.saveHomePreferences).toHaveBeenCalled());
        // A Hide is drawn from the answer in hand: no read for it.
        expect(api.getHome).toHaveBeenCalledTimes(1);
        // Leave Home (the Market), and come back: the landing leaves the Pulse out of `cards=`, and the node with it.
        cleanup();
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(2));
        expect(node.reads()[1]).not.toContain('pulse');
        await screen.findByTestId('home-card-market');
        return node;
    }

    it('Show in Edit home reads Home again with the Pulse in cards=, and the card is drawn, no timer waited for', async () => {
        const node = await hidePulseThenComeBack();
        fireEvent.click(screen.getByTestId('home-edit-open'));
        const dialog = screen.getByRole('dialog', { name: 'Edit home' });
        fireEvent.click(within(dialog).getByRole('switch', { name: 'Show The Pulse' }));
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(3));
        expect(node.reads()[2]).toContain('pulse');
        fireEvent.click(within(dialog).getByTestId('home-edit-done'));
        expect(await screen.findByTestId('home-card-pulse')).toHaveTextContent('How our LETS started');
        // Hiding it again and showing it again needs no read: the answer in hand has it now.
        fireEvent.click(within(screen.getByTestId('home-card-pulse')).getByRole('button', { name: 'Card options for The Pulse' }));
        fireEvent.click(within(screen.getByTestId('home-card-pulse')).getByRole('button', { name: 'Hide' }));
        fireEvent.click(screen.getByTestId('home-edit-open'));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit home' })).getByRole('switch', { name: 'Show The Pulse' }));
        expect(await screen.findByTestId('home-card-pulse')).toBeInTheDocument();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(api.getHome).toHaveBeenCalledTimes(3);
    });

    it('Reset to defaults does the same', async () => {
        const node = await hidePulseThenComeBack();
        fireEvent.click(screen.getByTestId('home-edit-open'));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit home' })).getByTestId('home-edit-reset'));
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(3));
        expect(node.reads()[2]).toContain('pulse');
        expect(await screen.findByTestId('home-card-pulse')).toBeInTheDocument();
    });

    it('a Move, or a Hide of another card, after coming back reads nothing', async () => {
        await hidePulseThenComeBack();
        const market = screen.getByTestId('home-card-market');
        fireEvent.click(within(market).getByRole('button', { name: 'Card options for New in the Market' }));
        fireEvent.click(within(market).getByRole('button', { name: 'Move up' }));
        const beans = screen.getByTestId('home-card-beans');
        fireEvent.click(within(beans).getByRole('button', { name: 'Card options for Your Beans' }));
        fireEvent.click(within(beans).getByRole('button', { name: 'Hide' }));
        await waitFor(() => expect(screen.queryByTestId('home-card-beans')).toBeNull());
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(api.getHome).toHaveBeenCalledTimes(2);
    });

    it('a layout save on its way is not sent twice by the read Show starts', async () => {
        await hidePulseThenComeBack();
        vi.mocked(api.saveHomePreferences).mockClear();
        fireEvent.click(screen.getByTestId('home-edit-open'));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit home' })).getByRole('switch', { name: 'Show The Pulse' }));
        await screen.findByTestId('home-card-pulse');
        expect(vi.mocked(api.saveHomePreferences).mock.calls.filter(c => c[1]['home.layout'])).toHaveLength(1);
    });
});

describe('after Hide, focus goes to the nearest card left, and the page says where the card went (PR #1479 review)', () => {
    it("the next card's \"…\"; Edit home when the hidden card was the last above the community card", async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const pulse = await screen.findByTestId('home-card-pulse');
        fireEvent.click(within(pulse).getByRole('button', { name: 'Card options for The Pulse' }));
        fireEvent.click(within(pulse).getByRole('button', { name: 'Hide' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Card options for Your Beans' })).toHaveFocus());
        expect(screen.getByTestId('home-live')).toHaveTextContent(hiddenWords('The Pulse'));
        await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
        expect(document.activeElement).not.toBe(document.body);
        const beans = screen.getByTestId('home-card-beans');
        fireEvent.click(within(beans).getByRole('button', { name: 'Card options for Your Beans' }));
        fireEvent.click(within(beans).getByRole('button', { name: 'Hide' }));
        await waitFor(() => expect(screen.getByTestId('home-edit-open')).toHaveFocus());
        expect(screen.getByTestId('home-live')).toHaveTextContent(hiddenWords('Your Beans'));
    });
});

describe('the doorbells Home answers (§5.2, PR #1479 review)', () => {
    it('a new notice (system_announcement) rings Home: one read 3 s later', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(hooks.announce).toHaveLength(1);
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({}, { notices: { unseen: 1, first: { id: 'n1', title: 'Market day moved', line: 'Saturday, not Sunday.' } } })));
        vi.useFakeTimers();
        hooks.announce.forEach(cb => cb({ type: 'system_announcement', title: 'Market day moved' }));
        await vi.advanceTimersByTimeAsync(2_900);
        expect(api.getHome).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(200);
        expect(api.getHome).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
        expect(await screen.findByTestId('home-card-notices')).toHaveTextContent('Market day moved');
    });

    it('a notice put away (the alert, or Mark as read) reads Home at once, so the card goes with it', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({}, { notices: { unseen: 1, first: { id: 'n1', title: 'Market day moved', line: '' } } })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-notices');
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await waitFor(() => expect(screen.queryByTestId('home-card-notices')).toBeNull());
        expect(api.getHome).toHaveBeenCalledTimes(2);
    });
});

describe('interests changed while the node is out of reach (PR #1479 review)', () => {
    it('tapped on Home while saves fail, then the Market opened: back on Home, the change is sent, not overwritten', async () => {
        localStorage.setItem('bp_fav_categories', JSON.stringify(['food']));
        localStorage.setItem(`beanpool_interests_synced_${ME.publicKey}`, '1');
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ me: { ...answer().me!, interests: ['food'] } })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        fireEvent.click(screen.getByTestId('home-tune'));
        vi.mocked(api.saveHomePreferences).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        fireEvent.click(await screen.findByTestId('home-interest-arts'));
        await waitFor(() => expect(api.saveHomePreferences).toHaveBeenCalledWith(ME.publicKey, { interests: ['food', 'arts'] }));
        // The Market tab: Home is not drawn while another tab is.
        cleanup();
        vi.mocked(api.saveHomePreferences).mockClear();
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        await waitFor(() => expect(api.saveHomePreferences).toHaveBeenCalledWith(ME.publicKey, { interests: ['food', 'arts'] }));
        expect(JSON.parse(localStorage.getItem('bp_fav_categories')!)).toEqual(['food', 'arts']);
        // Starred first: Pottery (arts) and Sourdough (food) before the drill.
        expect(marketTitles()[2]).toBe('Need, Borrow a drill, Free');
    });
});

describe('First steps on the global node, on the web (PR #1479 review)', () => {
    const globalAnswer = (stepsOver: Partial<NonNullable<HomeAnswer['cards']['steps']>>) => answer({
        profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false, guestListingsOnly: true },
        me: { ...answer().me!, joinedAt: '2026-08-10T00:00:00.000Z', firstOffer: true },
    }, {
        beans: undefined,
        find: { point: 'area', communities: [{ key: 'b', name: 'Byron Shire BeanPool', url: 'https://byron.example.org', memberCount: 40, distanceKm: 12 }], communityCount: 2, nearbyPosts: null, watches: null, knock: null, directoryFetchedAt: null },
        steps: { joinedAt: '2026-08-10T00:00:00.000Z', firstOffer: true, firstPost: true, photo: false, interests: true, invited: null, area: false, knocked: null, ...stepsOver },
    });

    it('a member a month in who has posted: no First steps, though the node sends it for the area the web cannot set', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({})));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-find');
        expect(screen.queryByTestId('home-card-steps')).toBeNull();
    });

    it('before the first post it is there, with the ask as a link to the community', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ firstPost: false })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const steps = await screen.findByTestId('home-card-steps');
        expect(within(steps).getByRole('button', { name: 'To do: Post something free or for swap' })).toBeInTheDocument();
        expect(within(steps).getByRole('link', { name: 'To do: Ask Byron Shire BeanPool to let you in' })).toHaveAttribute('href', 'https://byron.example.org');
    });
});

describe('a card shown on another device is drawn on this browser\'s next read, at once (PR #1479 review, round 2)', () => {
    /** This browser hid the Pulse; the member's phone then showed it again, saved on the account with a later stamp. */
    async function hiddenHereShownElsewhere() {
        const node = nodeKeepingLayout(answer());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const pulse = await screen.findByTestId('home-card-pulse');
        fireEvent.click(within(pulse).getByRole('button', { name: 'Card options for The Pulse' }));
        fireEvent.click(within(pulse).getByRole('button', { name: 'Hide' }));
        await waitFor(() => expect(api.saveHomePreferences).toHaveBeenCalled());
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        node.savedElsewhere({ v: 1, order: [], hidden: [], dismissed: {}, updatedAt: new Date(Date.now() + 60_000).toISOString() });
        return node;
    }

    it('the next landing: its first read leaves the Pulse out, so Home reads again with it, and draws it, no poll waited for', async () => {
        const node = await hiddenHereShownElsewhere();
        cleanup();
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(3), { timeout: 2_000 });
        expect(node.reads()[1]).not.toContain('pulse');
        expect(node.reads()[2]).toContain('pulse');
        expect(await screen.findByTestId('home-card-pulse')).toHaveTextContent('How our LETS started');
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(api.getHome).toHaveBeenCalledTimes(3);
    });

    it('two tabs: the doorbell read that brings the newer layout reads again at once', async () => {
        const node = await hiddenHereShownElsewhere();
        expect(api.getHome).toHaveBeenCalledTimes(1);
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(3), { timeout: 2_000 });
        expect(node.reads()[2]).toContain('pulse');
        expect(await screen.findByTestId('home-card-pulse')).toBeInTheDocument();
    });

    it('a newer layout that only hides or moves a card needs no second read', async () => {
        const node = nodeKeepingLayout(answer());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-pulse');
        node.savedElsewhere({ v: 1, order: ['beans'], hidden: ['pulse'], dismissed: {}, updatedAt: new Date(Date.now() + 60_000).toISOString() });
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await waitFor(() => expect(screen.queryByTestId('home-card-pulse')).toBeNull());
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(api.getHome).toHaveBeenCalledTimes(2);
    });
});

describe('Sign Out in another tab: this tab drops her Home, reads nothing more as her, and writes nothing back (PR #1479 review, round 2)', () => {
    const idb = () => globalThis.indexedDB as unknown as MemoryIndexedDB;
    const kept = () => idb().peek('beanpool-home', 'answers', homeCacheKey(ME.publicKey)) as { etag?: string } | undefined;
    const storedKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);
    /** What the reviewer found written back: her Beans, "Unread message from Kofi", her group, her layout. */
    const herHome = (over: Partial<HomeAnswer> = {}) => answer({ layout: { v: 1, order: [], hidden: ['joined'], dismissed: {}, updatedAt: NOW }, ...over }, {
        needs: { items: [{ kind: 'message', count: 1, accent: false, label: 'Unread message from Kofi', target: { to: 'unread-messages' } }] },
        groups: { items: [{ id: 'g1', kind: 'group', name: 'Garden group', unread: 2, muted: false }], total: 1 },
    });

    async function onHome(a: HomeAnswer = herHome()) {
        vi.mocked(api.getHome).mockResolvedValue(fresh(a));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByText('Unread message from Kofi');
        await waitFor(() => expect(kept()).toBeDefined());
    }
    const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

    it('a Hide in this tab afterwards has nothing to write back: her Home is gone from the page at once', async () => {
        await onHome();
        await act(async () => { await signOutInAnotherTab(); });
        expect(kept()).toBeUndefined();
        // What the reviewer did in tab B: "…" → Hide.
        const menu = screen.queryAllByRole('button', { name: /^Card options for / })[0];
        if (menu) {
            fireEvent.click(menu);
            fireEvent.click(screen.getAllByRole('button', { name: 'Hide' })[0]);
        }
        await settle();
        expect(kept()).toBeUndefined();
        expect(storedKeys().filter(k => k.includes(ME.publicKey))).toEqual([]);
        expect(screen.queryByText(/Unread message from Kofi/)).toBeNull();
        expect(screen.getByTestId('home-signed-out')).toHaveTextContent(HOME_SIGNED_OUT);
    });

    it('a read still out when she signs out lands afterwards: nothing of it is drawn or kept', async () => {
        await onHome();
        let answerNode!: (r: HomeRead) => void;
        vi.mocked(api.getHome).mockReturnValueOnce(new Promise(r => { answerNode = r; }));
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        expect(api.getHome).toHaveBeenCalledTimes(2);
        await act(async () => { await signOutInAnotherTab(); });
        await act(async () => { answerNode(fresh(herHome({}))); });
        await settle();
        expect(kept()).toBeUndefined();
        expect(screen.queryByText(/Unread message from Kofi/)).toBeNull();
    });

    it('her next read is never made: on global, an unsigned one would have kept the visitors\' answer under her key, with her layout', async () => {
        await onHome(herHome({ profile: 'global', features: { beans: false, guestListingsOnly: true } }));
        await act(async () => { await signOutInAnotherTab(); });
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ profile: 'global', welcome: true, me: null, layout: null })));
        // A doorbell, the notices put away, the tab coming back: every way Home asks again.
        vi.useFakeTimers();
        hooks.sync.forEach(cb => cb());
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await vi.advanceTimersByTimeAsync(130_000);
        vi.useRealTimers();
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        await settle();
        expect(api.getHome).toHaveBeenCalledTimes(1);
        expect(kept()).toBeUndefined();
    });

    it('a Home opened after it (the Market was in front) reads nothing and shows nothing of hers', async () => {
        await signOutInAnotherTab();
        vi.mocked(api.getHome).mockResolvedValue(fresh(herHome()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await settle();
        expect(api.getHome).not.toHaveBeenCalled();
        expect(screen.getByTestId('home-signed-out')).toHaveTextContent(HOME_SIGNED_OUT);
        expect(kept()).toBeUndefined();
    });

    it('heard on the BroadcastChannel alone (a browser whose storage the tabs can\'t share), it is the same', async () => {
        await onHome();
        signOutOnChannelOnly();
        await waitFor(() => expect(screen.queryByText(/Unread message from Kofi/)).toBeNull(), { timeout: 2_000 });
        expect(screen.getByTestId('home-signed-out')).toBeInTheDocument();
    });

    it('Force Clear (or leaving a community) in another tab: the copy drawn goes, and Home is read afresh, with no tag', async () => {
        await onHome();
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({}, { community: { name: 'Read afresh', members: 82 } }), 'W/"home-fresh"'));
        await act(async () => { await clearInAnotherTab(); });
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(2), { timeout: 2_000 });
        expect(vi.mocked(api.getHome).mock.calls[1][1]).toBeNull();
        expect(await screen.findByText('Read afresh')).toBeInTheDocument();
        expect(screen.queryByText(/Unread message from Kofi/)).toBeNull();
        await waitFor(() => expect(kept()?.etag).toBe('W/"home-fresh"'));
    });
});

describe('a clear this tab is the first to hear of, inside its own next call: nothing it held is kept or sent (PR #1479 review, round 3)', () => {
    const idb = () => globalThis.indexedDB as unknown as MemoryIndexedDB;
    /** The web app pointed at community X (Settings → Sovereign Node Connection); the page's own node is P. */
    const X = 'https://x.example.org';
    const P = window.location.origin;
    const kept = (node: string) => idb().peek('beanpool-home', 'answers', `${node}|${ME.publicKey}`) as { answer?: HomeAnswer; etag?: string | null } | undefined;
    const keptText = (node: string) => JSON.stringify(kept(node)?.answer ?? null);
    /** Her Home at X: what the reviewer found written back after the delete there (her balance, Kofi's message). */
    const atX = () => answer({}, {
        needs: { items: [{ kind: 'message', count: 1, accent: false, label: 'Unread message from Kofi', target: { to: 'unread-messages' } }] },
        community: { name: 'Kept only at X', members: 12 },
    });
    const atP = () => answer({}, { community: { name: 'Read at P', members: 81 } });
    const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });
    /** The node's next read, held until `answerNode` is called: what a Home re-read afresh would get. */
    function holdNextRead() {
        let answerNode!: (r: HomeRead) => void;
        vi.mocked(api.getHome).mockReturnValueOnce(new Promise(r => { answerNode = r; }));
        return (r: HomeRead) => act(async () => { answerNode(r); });
    }
    function hide(card: string) {
        const el = screen.getByTestId(`home-card-${card}`);
        fireEvent.click(within(el).getByRole('button', { name: /^Card options for / }));
        fireEvent.click(within(el).getByRole('button', { name: 'Hide' }));
    }

    beforeEach(() => {
        // As lib/api.ts reads it: the node Settings points the web app at, else the page's own.
        vi.mocked(api.getNodeApiUrl).mockImplementation(() => localStorage.getItem('bp_node_url') ?? '');
    });
    afterEach(() => {
        vi.mocked(api.getNodeApiUrl).mockImplementation(() => '');
    });

    /** Her Home at X, kept in this browser, in a tab that will hear nothing of the delete there. */
    async function onHomeAtX() {
        localStorage.setItem('bp_node_url', X);
        vi.mocked(api.getHome).mockResolvedValue(fresh(atX(), 'W/"home-x"'));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByText('Kept only at X');
        await waitFor(() => expect(kept(X)).toBeDefined());
        vi.mocked(api.saveHomePreferences).mockClear();
    }

    it('Force Clear in a tab this one never hears, then a Hide here: the answer from before the clear is not put back, and Home is read afresh', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({}, { community: { name: 'Read before the clear', members: 81 } }), 'W/"home-before"'));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByText('Read before the clear');
        await waitFor(() => expect(kept(P)).toBeDefined());
        vi.mocked(api.saveHomePreferences).mockClear();
        const callsBefore = vi.mocked(api.getHome).mock.calls.length;
        await act(async () => { await clearInAnotherTab({ heard: false }); });
        expect(kept(P)).toBeUndefined();
        // This tab heard nothing: it still draws what it read before.
        expect(screen.getByText('Read before the clear')).toBeInTheDocument();
        const afresh = holdNextRead();
        hide('pulse');
        await settle();
        // The Hide was the first to hear of it: the answer and the layout it was made on are gone, kept and sent nowhere.
        expect(kept(P)).toBeUndefined();
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
        expect(screen.queryByText('Read before the clear')).toBeNull();
        // Read afresh, with no tag, and that answer is the one kept.
        expect(vi.mocked(api.getHome).mock.calls.length).toBe(callsBefore + 1);
        expect(vi.mocked(api.getHome).mock.calls.at(-1)![1]).toBeNull();
        await afresh(fresh(answer({}, { community: { name: 'Read afresh', members: 82 } }), 'W/"home-afresh"'));
        expect(await screen.findByText('Read afresh')).toBeInTheDocument();
        await waitFor(() => expect(kept(P)?.etag).toBe('W/"home-afresh"'));
        expect(keptText(P)).not.toContain('Read before the clear');
    });

    it('the delete at community X (the web app pointed there) in a tab this one never hears, then a Hide here: nothing of her Home at X is put back under X', async () => {
        await onHomeAtX();
        await act(async () => { await clearInAnotherTab({ heard: false, leaving: true }); });
        expect(kept(X)).toBeUndefined();
        const atPage = holdNextRead();
        hide('pulse');
        await settle();
        expect(kept(X)).toBeUndefined();
        // Nor is X's layout sent to her account at P, where the web app now talks.
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
        expect(screen.queryByText(/Unread message from Kofi/)).toBeNull();
        // She is still this browser's, at P: Home is read there afresh and kept there.
        await atPage(fresh(atP(), 'W/"home-p"'));
        expect(await screen.findByText('Read at P')).toBeInTheDocument();
        await waitFor(() => expect(kept(P)?.etag).toBe('W/"home-p"'));
        await settle();
        expect(kept(X)).toBeUndefined();
    });

    it('the same delete, then a doorbell here: P\'s answer is kept under P, never under X\'s key', async () => {
        await onHomeAtX();
        await act(async () => { await clearInAnotherTab({ heard: false, leaving: true }); });
        vi.mocked(api.getHome).mockResolvedValue(fresh(atP(), 'W/"home-p"'));
        const callsBefore = vi.mocked(api.getHome).mock.calls.length;
        vi.useFakeTimers();
        hooks.sync.forEach(cb => cb());
        await vi.advanceTimersByTimeAsync(3_100);
        vi.useRealTimers();
        expect(await screen.findByText('Read at P')).toBeInTheDocument();
        await waitFor(() => expect(kept(P)?.etag).toBe('W/"home-p"'));
        await settle();
        expect(kept(X)).toBeUndefined();
        // One read, afresh (no tag), as the page landing again makes it.
        expect(vi.mocked(api.getHome).mock.calls.length).toBe(callsBefore + 1);
        expect(vi.mocked(api.getHome).mock.calls.at(-1)![1]).toBeNull();
    });

    it('the same delete, then a chip tap here: X\'s interests are neither kept as this browser\'s nor sent to her account at P', async () => {
        await onHomeAtX();
        localStorage.removeItem('bp_fav_categories');
        await act(async () => { await clearInAnotherTab({ heard: false, leaving: true }); });
        holdNextRead();
        fireEvent.click(within(screen.getByTestId('home-card-market')).getByRole('button', { name: /Tune/ }));
        fireEvent.click(await screen.findByTestId('home-interest-food'));
        await settle();
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
        expect(localStorage.getItem('bp_fav_categories')).toBeNull();
        expect(Object.keys(localStorage).filter(k => k.includes(ME.publicKey))).toEqual([]);
    });
});

describe('the Tips card (scratch/home/TIPS-DESIGN-fable.md §1, §5, §6 item 5)', () => {
    const LOCAL = tipsFor({ profile: 'local', features: answer().features }, null);
    const record = () => JSON.parse(localStorage.getItem(tipsKey(ME.publicKey)) ?? 'null');
    const tipsCard = () => screen.getByTestId('home-card-tips');

    it('a new member lands on the first tip, after First steps; Next draws the next in place, says it, and keeps focus', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-tips');
        expect(within(card).getByRole('heading', { name: 'Tips · 1 of 15' })).toBeInTheDocument();
        expect(within(card).getByTestId('home-tip-text')).toHaveTextContent(LOCAL[0].text);
        // Shown on landing is kept, with the local day it was first shown.
        expect(record()).toMatchObject({ v: 1, seen: [], current: LOCAL[0].id, dismissedAt: null });
        const next = within(card).getByRole('button', { name: 'Next tip' });
        next.focus();
        fireEvent.click(next);
        expect(within(tipsCard()).getByRole('heading', { name: 'Tips · 2 of 15' })).toBeInTheDocument();
        expect(within(tipsCard()).getByTestId('home-tip-text')).toHaveTextContent(LOCAL[1].text);
        expect(screen.getByTestId('home-live')).toHaveTextContent(LOCAL[1].text);
        // The same element: focus stays on it.
        expect(within(tipsCard()).getByRole('button', { name: 'Next tip' })).toBe(next);
        expect(next).toHaveFocus();
        expect(record()).toMatchObject({ seen: [LOCAL[0].id], current: LOCAL[1].id });
    });

    it('a landing on a later day advances once; Home in front never moves it', async () => {
        localStorage.setItem(tipsKey(ME.publicKey), JSON.stringify({ v: 1, seen: [], current: LOCAL[0].id, currentShownOn: '2000-01-01', dismissedAt: null }));
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-tips');
        expect(within(card).getByRole('heading', { name: 'Tips · 2 of 15' })).toBeInTheDocument();
        expect(record()).toMatchObject({ seen: [LOCAL[0].id], current: LOCAL[1].id });
        // A poll's read while Home is in front: the same tip.
        await act(async () => { hooks.sync.forEach(cb => cb()); });
        expect(within(tipsCard()).getByRole('heading', { name: 'Tips · 2 of 15' })).toBeInTheDocument();
    });

    it('Done on the last tip takes the card away, says so, moves focus on; Edit home then says All tips seen', async () => {
        localStorage.setItem(tipsKey(ME.publicKey), JSON.stringify({ v: 1, seen: LOCAL.slice(0, -1).map(t => t.id), current: null, currentShownOn: null, dismissedAt: null }));
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-tips');
        expect(within(card).getByRole('heading', { name: 'Tips · 15 of 15' })).toBeInTheDocument();
        const done = within(card).getByRole('button', { name: 'Done with tips. The card goes.' });
        expect(done).toHaveTextContent('Done');
        fireEvent.click(done);
        expect(screen.queryByTestId('home-card-tips')).toBeNull();
        expect(screen.getByTestId('home-live')).toHaveTextContent(TIPS_DONE_WORDS);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Card options for Coming up' })).toHaveFocus());
        fireEvent.click(screen.getByTestId('home-edit-open'));
        const dialog = screen.getByRole('dialog', { name: 'Edit home' });
        expect(within(dialog).getByRole('switch', { name: 'Show Tips' })).toHaveAttribute('aria-checked', 'true');
        expect(within(within(dialog).getByTestId('home-edit-row-tips')).getByTestId('home-edit-tips-all-seen')).toHaveTextContent('All tips seen');
        // Off and on again starts over from the first tip.
        fireEvent.click(within(dialog).getByRole('switch', { name: 'Show Tips' }));
        fireEvent.click(within(dialog).getByRole('switch', { name: 'Show Tips' }));
        fireEvent.click(within(dialog).getByTestId('home-edit-done'));
        expect(within(await screen.findByTestId('home-card-tips')).getByRole('heading', { name: 'Tips · 1 of 15' })).toBeInTheDocument();
    });

    it("Don't show tips again: gone at once, the record and the layout say so, focus to the nearest card; a node that dropped the id keeps it gone", async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-tips');
        fireEvent.click(within(card).getByRole('button', { name: "Don't show tips again. Edit home brings them back." }));
        expect(screen.queryByTestId('home-card-tips')).toBeNull();
        expect(record().dismissedAt).toEqual(expect.any(String));
        const saved = vi.mocked(api.saveHomePreferences).mock.calls.at(-1)![1]['home.layout']!;
        expect(saved.hidden).toContain('tips');
        expect(screen.getByTestId('home-live')).toHaveTextContent(hiddenWords('Tips'));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Card options for Coming up' })).toHaveFocus());
        cleanup();
        // An older node stored the layout without `tips` (it drops ids it does not know): the record still holds.
        resetHomeCacheForTest();
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ layout: { v: 1, order: [], hidden: [], dismissed: {}, updatedAt: new Date(Date.now() + 60_000).toISOString() } as never })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-community');
        expect(screen.queryByTestId('home-card-tips')).toBeNull();
    });

    it("the card's own Hide does what Don't show does; Edit home's switch brings it back from the first tip", async () => {
        localStorage.setItem(tipsKey(ME.publicKey), JSON.stringify({ v: 1, seen: [LOCAL[0].id, LOCAL[1].id], current: LOCAL[2].id, currentShownOn: '2999-01-01', dismissedAt: null }));
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-tips');
        fireEvent.click(within(card).getByRole('button', { name: 'Card options for Tips · 3 of 15' }));
        fireEvent.click(within(card).getByRole('button', { name: 'Hide' }));
        expect(screen.queryByTestId('home-card-tips')).toBeNull();
        expect(record().dismissedAt).toEqual(expect.any(String));
        fireEvent.click(screen.getByTestId('home-edit-open'));
        const dialog = screen.getByRole('dialog', { name: 'Edit home' });
        fireEvent.click(within(dialog).getByRole('switch', { name: 'Show Tips' }));
        fireEvent.click(within(dialog).getByTestId('home-edit-done'));
        expect(within(await screen.findByTestId('home-card-tips')).getByRole('heading', { name: 'Tips · 1 of 15' })).toBeInTheDocument();
        expect(record()).toMatchObject({ seen: [], dismissedAt: null });
    });

    // PR #1694 review 6: the tip a restart draws is the record's, from that day, so the next day's landing moves on.
    it('Tips switched on again records tip 1 as shown today', async () => {
        localStorage.setItem(tipsKey(ME.publicKey), JSON.stringify({ v: 1, seen: [LOCAL[0].id], current: null, currentShownOn: null, dismissedAt: '2026-10-01T00:00:00.000Z' }));
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ layout: { v: 1, order: [], hidden: ['tips'], dismissed: {}, updatedAt: new Date().toISOString() } as never })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-community');
        expect(screen.queryByTestId('home-card-tips')).toBeNull();
        fireEvent.click(screen.getByTestId('home-edit-open'));
        const dialog = screen.getByRole('dialog', { name: 'Edit home' });
        fireEvent.click(within(dialog).getByRole('switch', { name: 'Show Tips' }));
        fireEvent.click(within(dialog).getByTestId('home-edit-done'));
        expect(within(await screen.findByTestId('home-card-tips')).getByTestId('home-tip-text')).toHaveTextContent(LOCAL[0].text);
        expect(record()).toEqual({ v: 1, seen: [], current: LOCAL[0].id, currentShownOn: localDay(), dismissedAt: null });
    });

    // PR #1694 review 3: Reset to defaults shows Tips again, so it starts the tips over (as switching it on does).
    it("Reset to defaults after Don't show tips again draws the card again, from tip 1", async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-tips');
        fireEvent.click(within(card).getByRole('button', { name: 'Next tip' }));
        fireEvent.click(within(tipsCard()).getByRole('button', { name: "Don't show tips again. Edit home brings them back." }));
        expect(screen.queryByTestId('home-card-tips')).toBeNull();
        fireEvent.click(screen.getByTestId('home-edit-open'));
        const dialog = screen.getByRole('dialog', { name: 'Edit home' });
        fireEvent.click(within(dialog).getByTestId('home-edit-reset'));
        expect(within(dialog).getByRole('switch', { name: 'Show Tips' })).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(within(dialog).getByTestId('home-edit-done'));
        expect(within(await screen.findByTestId('home-card-tips')).getByRole('heading', { name: 'Tips · 1 of 15' })).toBeInTheDocument();
        expect(record()).toEqual({ v: 1, seen: [], current: LOCAL[0].id, currentShownOn: localDay(), dismissedAt: null });
    });

    // PR #1694 review 4: the tip follows the reader's text size (a rem size, as every other line on Home), never fixed px.
    it("the tip's text is sized in rem, so it grows with the reader's text size", async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const text = within(await screen.findByTestId('home-card-tips')).getByTestId('home-tip-text');
        expect(text.className).not.toMatch(/text-\[\d+(\.\d+)?px\]/);
        expect(text.className).toMatch(/(^| )text-(\[0\.9375rem\]|base)( |$)/);
    });

    it('Read more opens the guide at the tip\'s page, labelled with the page title', async () => {
        localStorage.setItem(tipsKey(ME.publicKey), JSON.stringify({ v: 1, seen: LOCAL.slice(0, 4).map(t => t.id), current: null, currentShownOn: null, dismissedAt: null }));
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        const nav = vi.fn();
        render(<HomePage identity={ME} onNavigate={nav} />);
        const card = await screen.findByTestId('home-card-tips');
        expect(LOCAL[4].id).toBe('words');
        fireEvent.click(within(card).getByRole('button', { name: /^Read more in the guide: / }));
        expect(nav).toHaveBeenCalledWith('guide', 'your-12-words');
    });

    it('the worldwide community: 11 tips; a visitor gets none; a suspended member still does', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false, guestListingsOnly: false } })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(within(await screen.findByTestId('home-card-tips')).getByRole('heading', { name: 'Tips · 1 of 11' })).toBeInTheDocument();
        cleanup();
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ profile: 'global', welcome: true, me: null, layout: null })));
        render(<HomePage identity={null} onNavigate={vi.fn()} visitor={{ joinCard: <div>Join</div>, beans: false }} />);
        await screen.findByText('Join');
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(2));
        expect(screen.queryByTestId('home-card-tips')).toBeNull();
        cleanup();
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ me: { ...answer().me!, standing: 'suspended' } })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('home-card-tips')).toBeInTheDocument();
    });

    it('cards= never names tips: the address, and so its tag, is what it was', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-tips');
        // Move it, so the layout names it, and read again.
        fireEvent.click(within(card).getByRole('button', { name: /^Card options for Tips/ }));
        fireEvent.click(within(card).getByRole('button', { name: 'Move down' }));
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await waitFor(() => expect(vi.mocked(api.getHome).mock.calls.length).toBeGreaterThan(1));
        for (const [q] of vi.mocked(api.getHome).mock.calls) expect((q as { cards?: string[] }).cards ?? []).not.toContain('tips');
    });
});
