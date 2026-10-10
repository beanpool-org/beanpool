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
import { HomePage, HOME_HINT, HOME_NOT_ON_NODE, HOME_OFFLINE, HOME_SIGNED_OUT, TIPS_DONE_WORDS, tipsKey } from './HomePage';
import { defaultCards, localDay, skyToday, tipsFor } from '@beanpool/core';
import { removedLine } from '../lib/home-layout';
import { NOTICES_SEEN_EVENT, SKY_NO_PLACE_LINE } from '../lib/home-cards';
import { homeCacheKey, resetHomeCacheForTest, writeCachedHome } from '../lib/home-cache';
import { resetAccountEpochForTest } from '../lib/account-epoch';
import { clearInAnotherTab, signOutInAnotherTab, signOutOnChannelOnly } from '../lib/another-tab';

const ME: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const NOW = new Date().toISOString();

const EVERY_CARD = { v: 2, cards: ['safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'beans', 'notices', 'invite'].map(t => ({ id: t, type: t })), dismissed: {}, updatedAt: null };

function answer(over: Partial<HomeAnswer> = {}, cards: HomeAnswer['cards'] = {}): HomeAnswer {
    return {
        generatedAt: NOW, profile: 'local',
        features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false },
        me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: ['arts'], area: null, firstOffer: false, standing: 'member' },
        // A member whose account list holds every card (what version 1 drew by default); the frame's own cases set theirs.
        layout: EVERY_CARD,
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
        await writeCachedHome(homeCacheKey(ME.publicKey), { etag: null, answer: answer({ layout }, { community: { name: 'Cached town', members: 5 } }), layout: layout as never /* an older web app's cached copy (v1): read through the tolerant reader */, layoutUnsaved: false, savedAt: 1 });
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
    it('"…" says which card it is for; Remove takes the card away and saves the list on the account without it', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const pulse = await screen.findByTestId('home-card-pulse');
        const dots = within(pulse).getByRole('button', { name: 'Card options for The Pulse' });
        expect(dots).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(dots);
        expect(dots).toHaveAttribute('aria-expanded', 'true');
        // The first item takes focus: Move up (the Pulse has no settings).
        expect(within(pulse).getByRole('button', { name: 'Move up' })).toHaveFocus();
        fireEvent.click(within(pulse).getByTestId('home-menu-remove'));
        await waitFor(() => expect(screen.queryByTestId('home-card-pulse')).toBeNull());
        const saved = vi.mocked(api.saveHomePreferences).mock.calls.at(-1)!;
        expect(saved[0]).toBe(ME.publicKey);
        const l = saved[1]['home.layout'] as unknown as ReturnType<typeof v2>;
        expect(l.v).toBe(2);
        expect(l.cards.map(c => c.type)).toEqual(EVERY_CARD.cards.map(c => c.type).filter(t => t !== 'pulse'));
        expect(Date.parse(l.updatedAt!)).toBeGreaterThan(0);
    });

    it('the menu closes on Escape and gives focus back to its "…"; Move up is off for the first movable card', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        // A new member's first movable card is Tips (after First steps, which this member has done).
        const first = await screen.findByTestId('home-card-tips');
        const dots = within(first).getByRole('button', { name: 'Card options for Tips · 1 of 15' });
        fireEvent.click(dots);
        expect(within(first).getByRole('button', { name: 'Move up' })).toBeDisabled();
        // The frame's menu ends with Remove where version 1 had Hide.
        fireEvent.keyDown(within(first).getByTestId('home-menu-remove'), { key: 'Escape' });
        expect(within(first).queryByTestId('home-menu-remove')).toBeNull();
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

    it('Edit home is a real dialog: labelled, focus inside, ＋ Add a card first, ↑ ↓ … per card, no switches, no Hidden, Reset, Escape back to Edit home', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const open = await screen.findByTestId('home-edit-open');
        open.focus();
        fireEvent.click(open);
        const dialog = screen.getByRole('dialog', { name: 'Edit home' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog.contains(document.activeElement)).toBe(true);
        expect(within(dialog).getAllByRole('button')[0]).toBe(within(dialog).getByTestId('home-edit-add'));
        expect(within(dialog).queryAllByRole('switch')).toHaveLength(0);
        expect(within(dialog).queryByRole('list', { name: 'Hidden' })).toBeNull();
        // Its "…" removes the card: the row goes, focus to the nearest row's "…", never to the page.
        fireEvent.click(within(dialog).getByRole('button', { name: 'Options for The Pulse' }));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Remove The Pulse from Home' }));
        expect(within(dialog).queryByRole('button', { name: 'Options for The Pulse' })).toBeNull();
        await waitFor(() => expect(dialog.contains(document.activeElement) && document.activeElement !== dialog).toBe(true));
        expect(screen.queryByTestId('home-card-pulse')).toBeNull();
        // Needs you and the community card are never in the list: they always stay.
        expect(within(dialog).queryByText('Your community')).toBeNull();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Move Coming up down' }));
        fireEvent.click(within(dialog).getByTestId('home-edit-reset'));
        // Reset gives the newcomer's list: no Pulse until added.
        expect(within(dialog).queryByRole('button', { name: 'Options for The Pulse' })).toBeNull();
        const last = vi.mocked(api.saveHomePreferences).mock.calls.at(-1)![1]['home.layout'] as unknown as ReturnType<typeof v2>;
        expect(last.v).toBe(2);
        expect(last.cards.map(c => c.type)).toEqual(newcomerTypes());
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
        await writeCachedHome(homeCacheKey(ME.publicKey), { etag: null, answer: answer({ layout: older }), layout: older as never /* an older web app's cached copy (v1) */, layoutUnsaved: false, savedAt: 1 });
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ layout: newer })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByText('Mullumbimby');
        await waitFor(() => expect(screen.queryByTestId('home-card-pulse')).toBeNull());
        expect(screen.getByTestId('home-card-beans')).toBeInTheDocument();
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it("this browser's newer layout that never reached the node is sent again after the next read", async () => {
        const mine = v2(['market', 'events', 'pulse'], '2026-10-02T00:00:00.000Z');
        await writeCachedHome(homeCacheKey(ME.publicKey), { etag: null, answer: answer({ layout: mine as never }), layout: mine as never, layoutUnsaved: true, savedAt: 1 });
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ layout: v2(['market', 'events', 'pulse', 'beans'], '2026-09-01T00:00:00.000Z') as never })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(api.saveHomePreferences).toHaveBeenCalledWith(ME.publicKey, { 'home.layout': mine }));
        expect(api.saveHomePreferences).toHaveBeenCalledTimes(1);
        await screen.findByTestId('home-card-pulse');
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
 * The node as the server is: it keeps the account's version-2 list (the last write by `updatedAt` wins, an equal one
 * replaces), and builds only the cards asked for (`cards=`), or, asked for none, every card on the account's list; the
 * community card always.
 */
function nodeKeepingLayout(full: HomeAnswer, start: ReturnType<typeof v2> = v2(['events', 'market', 'pulse', 'beans'])) {
    let account = start;
    /** The member's other device (or tab) saves `l` on the account. */
    const savedElsewhere = (l: ReturnType<typeof v2>) => { account = l; };
    vi.mocked(api.saveHomePreferences).mockImplementation(async (_pk, prefs) => {
        const l = prefs['home.layout'] as unknown as ReturnType<typeof v2> | undefined;
        if (l && Date.parse(l.updatedAt!) >= Date.parse(account.updatedAt!)) account = l;
        return { success: true, ...(l ? { 'home.layout': account } : {}), ...(prefs.interests ? { interests: prefs.interests } : {}) } as never;
    });
    vi.mocked(api.getHome).mockImplementation(async (params = {}) => {
        const asked: string[] = params.cards ? [...params.cards] : account.cards.map(c => c.type);
        const cards = Object.fromEntries(Object.entries(full.cards).filter(([id]) => id === 'community' || asked.includes(id)));
        return fresh({ ...full, layout: account as never, cards }, `W/"home-${asked.join('.')}-${account.updatedAt ?? ''}"`);
    });
    return { reads: () => vi.mocked(api.getHome).mock.calls.map(c => (c[0]?.cards ? [...c[0].cards] : null)), savedElsewhere };
}

describe('a card removed on an earlier visit comes back at once when added (PR #1479 review, BLOCKING 2)', () => {
    async function removePulseThenComeBack() {
        const node = nodeKeepingLayout(answer());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const pulse = await screen.findByTestId('home-card-pulse');
        fireEvent.click(within(pulse).getByRole('button', { name: 'Card options for The Pulse' }));
        fireEvent.click(within(pulse).getByTestId('home-menu-remove'));
        await waitFor(() => expect(screen.queryByTestId('home-card-pulse')).toBeNull());
        await waitFor(() => expect(api.saveHomePreferences).toHaveBeenCalled());
        // A Remove is drawn from the answer in hand: no read for it.
        expect(api.getHome).toHaveBeenCalledTimes(1);
        // Leave Home (the Market), and come back: the landing leaves the Pulse out of `cards=`, and the node with it.
        cleanup();
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(2));
        expect(node.reads()[1]).not.toContain('pulse');
        await screen.findByTestId('home-card-market');
        return node;
    }

    it('Add a card (from Edit home) reads Home again with the Pulse in cards= once the save is answered, and the card is drawn, no timer waited for', async () => {
        const node = await removePulseThenComeBack();
        fireEvent.click(screen.getByTestId('home-edit-open'));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit home' })).getByTestId('home-edit-add'));
        fireEvent.click(screen.getByTestId('home-add-pulse'));
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(3));
        expect(node.reads()[2]).toContain('pulse');
        expect(lastCall(vi.mocked(api.getHome))).toBeGreaterThan(lastCall(vi.mocked(api.saveHomePreferences)));
        expect(await screen.findByTestId('home-card-pulse')).toHaveTextContent('How our LETS started');
        // Removing it again reads nothing: the answer in hand has it.
        fireEvent.click(within(screen.getByTestId('home-card-pulse')).getByRole('button', { name: 'Card options for The Pulse' }));
        fireEvent.click(within(screen.getByTestId('home-card-pulse')).getByTestId('home-menu-remove'));
        await waitFor(() => expect(screen.queryByTestId('home-card-pulse')).toBeNull());
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(api.getHome).toHaveBeenCalledTimes(3);
        // Added again, it is drawn at once from the answer in hand, and read once more after its save (add-then-read, §1.3).
        fireEvent.click(screen.getByTestId('home-add-open'));
        fireEvent.click(screen.getByTestId('home-add-pulse'));
        expect(await screen.findByTestId('home-card-pulse')).toBeInTheDocument();
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(4));
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(api.getHome).toHaveBeenCalledTimes(4);
    });

    it("Reset to defaults gives the newcomer's list and reads Home again for it once the save is answered", async () => {
        const node = await removePulseThenComeBack();
        fireEvent.click(screen.getByTestId('home-edit-open'));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit home' })).getByTestId('home-edit-reset'));
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(3));
        expect(savedLayouts().at(-1)!.cards.map(c => c.type)).toEqual(newcomerTypes());
        expect(lastCall(vi.mocked(api.getHome))).toBeGreaterThan(lastCall(vi.mocked(api.saveHomePreferences)));
        expect(node.reads()[2]).toEqual(expect.arrayContaining(['market', 'events']));
        expect(node.reads()[2]).not.toContain('pulse');
        expect(node.reads()[2]).not.toContain('beans');
        await waitFor(() => expect(screen.queryByTestId('home-card-beans')).toBeNull());
        expect(screen.getByTestId('home-card-market')).toBeInTheDocument();
    });

    it('a Move, or a Remove of another card, after coming back reads nothing', async () => {
        await removePulseThenComeBack();
        const market = screen.getByTestId('home-card-market');
        fireEvent.click(within(market).getByRole('button', { name: 'Card options for New in the Market' }));
        fireEvent.click(within(market).getByRole('button', { name: 'Move up' }));
        const beans = screen.getByTestId('home-card-beans');
        fireEvent.click(within(beans).getByRole('button', { name: 'Card options for Your Beans' }));
        fireEvent.click(within(beans).getByTestId('home-menu-remove'));
        await waitFor(() => expect(screen.queryByTestId('home-card-beans')).toBeNull());
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(api.getHome).toHaveBeenCalledTimes(2);
    });

    it('a layout save on its way is not sent twice by the read Add starts', async () => {
        await removePulseThenComeBack();
        vi.mocked(api.saveHomePreferences).mockClear();
        fireEvent.click(screen.getByTestId('home-add-open'));
        fireEvent.click(screen.getByTestId('home-add-pulse'));
        await screen.findByTestId('home-card-pulse');
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(vi.mocked(api.saveHomePreferences).mock.calls.filter(c => c[1]['home.layout'])).toHaveLength(1);
    });
});

describe('after Remove, focus goes to the nearest card left, and the page says where the card went (PR #1479 review)', () => {
    it("the next card's \"…\"; Edit home when the removed card was the last above the community card", async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const pulse = await screen.findByTestId('home-card-pulse');
        fireEvent.click(within(pulse).getByRole('button', { name: 'Card options for The Pulse' }));
        fireEvent.click(within(pulse).getByTestId('home-menu-remove'));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Card options for Your Beans' })).toHaveFocus());
        expect(screen.getByTestId('home-live')).toHaveTextContent(removedLine('The Pulse'));
        await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
        expect(document.activeElement).not.toBe(document.body);
        const beans = screen.getByTestId('home-card-beans');
        fireEvent.click(within(beans).getByRole('button', { name: 'Card options for Your Beans' }));
        fireEvent.click(within(beans).getByTestId('home-menu-remove'));
        await waitFor(() => expect(screen.getByTestId('home-edit-open')).toHaveFocus());
        expect(screen.getByTestId('home-live')).toHaveTextContent(removedLine('Your Beans'));
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

describe('a card added on another device is drawn on this browser\'s next read, at once (PR #1479 review, round 2)', () => {
    /** This browser removed the Pulse; the member's phone then added it again, saved on the account with a later stamp. */
    async function removedHereAddedElsewhere() {
        const node = nodeKeepingLayout(answer());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const pulse = await screen.findByTestId('home-card-pulse');
        fireEvent.click(within(pulse).getByRole('button', { name: 'Card options for The Pulse' }));
        fireEvent.click(within(pulse).getByTestId('home-menu-remove'));
        await waitFor(() => expect(api.saveHomePreferences).toHaveBeenCalled());
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        node.savedElsewhere(v2(['pulse', 'events', 'market', 'beans'], new Date(Date.now() + 60_000).toISOString()));
        return node;
    }

    it('the next landing: its first read leaves the Pulse out, so Home reads again with it, and draws it, no poll waited for', async () => {
        const node = await removedHereAddedElsewhere();
        cleanup();
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(3), { timeout: 2_000 });
        expect(node.reads()[1]).not.toContain('pulse');
        expect(node.reads()[2]).toContain('pulse');
        expect(await screen.findByTestId('home-card-pulse')).toHaveTextContent('How our LETS started');
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(api.getHome).toHaveBeenCalledTimes(3);
    });

    it('two tabs: the doorbell read that brings the newer list reads again at once', async () => {
        const node = await removedHereAddedElsewhere();
        expect(api.getHome).toHaveBeenCalledTimes(1);
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(3), { timeout: 2_000 });
        expect(node.reads()[2]).toContain('pulse');
        expect(await screen.findByTestId('home-card-pulse')).toBeInTheDocument();
    });

    it('a newer list that only removes or moves a card needs no second read', async () => {
        const node = nodeKeepingLayout(answer());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-pulse');
        node.savedElsewhere(v2(['beans', 'events', 'market'], new Date(Date.now() + 60_000).toISOString()));
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
    function remove(card: string) {
        const el = screen.getByTestId(`home-card-${card}`);
        fireEvent.click(within(el).getByRole('button', { name: /^Card options for / }));
        fireEvent.click(within(el).getByTestId('home-menu-remove'));
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

    it('Force Clear in a tab this one never hears, then a Remove here: the answer from before the clear is not put back, and Home is read afresh', async () => {
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
        remove('pulse');
        await settle();
        // The Remove was the first to hear of it: the answer and the layout it was made on are gone, kept and sent nowhere.
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

    it('the delete at community X (the web app pointed there) in a tab this one never hears, then a Remove here: nothing of her Home at X is put back under X', async () => {
        await onHomeAtX();
        await act(async () => { await clearInAnotherTab({ heard: false, leaving: true }); });
        expect(kept(X)).toBeUndefined();
        const atPage = holdNextRead();
        remove('pulse');
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
        // Written just after the first draw: wait for it (a busy CI runner once read it before the write, #1696).
        await waitFor(() => expect(record()).toMatchObject({ v: 1, seen: [], current: LOCAL[0].id, dismissedAt: null }));
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
        await waitFor(() => expect(record()).toMatchObject({ seen: [LOCAL[0].id], current: LOCAL[1].id }));
        // A poll's read while Home is in front: the same tip.
        await act(async () => { hooks.sync.forEach(cb => cb()); });
        expect(within(tipsCard()).getByRole('heading', { name: 'Tips · 2 of 15' })).toBeInTheDocument();
    });

    it('Done on the last tip takes the card away, says so, moves focus on; Edit home then says All tips seen; Remove and Add a card again starts over', async () => {
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
        expect(within(within(dialog).getByTestId('home-edit-row-tips')).getByText('All tips seen')).toBeInTheDocument();
        // Removed and added again, it starts over from the first tip.
        fireEvent.click(within(dialog).getByTestId('home-edit-menu-tips'));
        fireEvent.click(within(dialog).getByTestId('home-edit-remove-tips'));
        expect(within(dialog).queryByTestId('home-edit-row-tips')).toBeNull();
        fireEvent.click(within(dialog).getByTestId('home-edit-add'));
        fireEvent.click(screen.getByTestId('home-add-tips'));
        expect(within(await screen.findByTestId('home-card-tips')).getByRole('heading', { name: 'Tips · 1 of 15' })).toBeInTheDocument();
    });

    it("Don't show tips again: gone at once, the record and the layout say so, focus to the nearest card; a node that dropped the id keeps it gone", async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-tips');
        fireEvent.click(within(card).getByRole('button', { name: "Don't show tips again. Edit home brings them back." }));
        expect(screen.queryByTestId('home-card-tips')).toBeNull();
        expect(record().dismissedAt).toEqual(expect.any(String));
        const saved = vi.mocked(api.saveHomePreferences).mock.calls.at(-1)![1]['home.layout'] as unknown as ReturnType<typeof v2>;
        expect(saved.cards.map(c => c.type)).not.toContain('tips');
        expect(screen.getByTestId('home-live')).toHaveTextContent(removedLine('Tips'));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Card options for Coming up' })).toHaveFocus());
        cleanup();
        // A newer list from another device that still holds Tips (it never heard): the record still holds.
        resetHomeCacheForTest();
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ layout: { ...EVERY_CARD, updatedAt: new Date(Date.now() + 60_000).toISOString() } as never })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-community');
        expect(screen.queryByTestId('home-card-tips')).toBeNull();
    });

    it("the card's own Remove does what Don't show does; Add a card brings it back from the first tip", async () => {
        localStorage.setItem(tipsKey(ME.publicKey), JSON.stringify({ v: 1, seen: [LOCAL[0].id, LOCAL[1].id], current: LOCAL[2].id, currentShownOn: '2999-01-01', dismissedAt: null }));
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-tips');
        fireEvent.click(within(card).getByRole('button', { name: 'Card options for Tips · 3 of 15' }));
        fireEvent.click(within(card).getByTestId('home-menu-remove'));
        expect(screen.queryByTestId('home-card-tips')).toBeNull();
        expect(record().dismissedAt).toEqual(expect.any(String));
        fireEvent.click(screen.getByTestId('home-edit-open'));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit home' })).getByTestId('home-edit-add'));
        fireEvent.click(screen.getByTestId('home-add-tips'));
        expect(within(await screen.findByTestId('home-card-tips')).getByRole('heading', { name: 'Tips · 1 of 15' })).toBeInTheDocument();
        expect(record()).toMatchObject({ seen: [], dismissedAt: null });
    });

    // PR #1694 review 6: the tip a restart draws is the record's, from that day, so the next day's landing moves on.
    it('Tips added again records tip 1 as shown today', async () => {
        localStorage.setItem(tipsKey(ME.publicKey), JSON.stringify({ v: 1, seen: [LOCAL[0].id], current: null, currentShownOn: null, dismissedAt: '2026-10-01T00:00:00.000Z' }));
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ layout: v2(['events', 'market', 'pulse', 'beans'], new Date().toISOString()) as never })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-community');
        expect(screen.queryByTestId('home-card-tips')).toBeNull();
        fireEvent.click(screen.getByTestId('home-edit-open'));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit home' })).getByTestId('home-edit-add'));
        fireEvent.click(screen.getByTestId('home-add-tips'));
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
        expect(within(dialog).queryByTestId('home-edit-row-tips')).toBeNull();
        fireEvent.click(within(dialog).getByTestId('home-edit-reset'));
        // The newcomer's list holds Tips.
        expect(within(dialog).getAllByRole('listitem').filter(li => li.textContent?.startsWith('Tips'))).toHaveLength(1);
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

describe('Home tips: Reset keeps a member part-way through on their tip (PR #1694 confirmation 1)', () => {
    const LOCAL = tipsFor({ profile: 'local', features: answer().features }, null);
    it('Reset to defaults while Tips is on, part-way (tip 4): the same tip stays', async () => {
        localStorage.setItem(tipsKey(ME.publicKey), JSON.stringify({ v: 1, seen: LOCAL.slice(0, 3).map(t => t.id), current: LOCAL[3].id, currentShownOn: localDay(), dismissedAt: null }));
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer()));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-tips');
        const before = within(card).getByTestId('home-tip-text').textContent;
        fireEvent.click(screen.getByTestId('home-edit-open'));
        const dialog = screen.getByRole('dialog', { name: 'Edit home' });
        fireEvent.click(within(dialog).getByTestId('home-edit-reset'));
        fireEvent.click(within(dialog).getByTestId('home-edit-done'));
        const after = within(await screen.findByTestId('home-card-tips')).getByTestId('home-tip-text').textContent;
        expect(after).toBe(before);
    });
});

// ── The card frame (CARD-FRAME §1–§2, slice F3): the phone's rules on the web ─────────────────────────────────────────

const AT = '2026-10-01T00:00:00.000Z';
const v2 = (types: string[], at: string | null = AT, extra: Array<{ id: string; type: string; settings?: unknown }> = []) =>
    ({ v: 2, cards: [...types.map(t => ({ id: t, type: t })), ...extra], dismissed: {}, updatedAt: at });

/** A node from after the frame: it keeps the newer version-2 list and answers it, building only the cards asked for. */
function nodeV2(full: HomeAnswer, start: ReturnType<typeof v2> | null) {
    let account: ReturnType<typeof v2> | null = start;
    vi.mocked(api.saveHomePreferences).mockImplementation(async (_pk, prefs) => {
        const l = prefs['home.layout'] as unknown as ReturnType<typeof v2> | undefined;
        if (l && (!account || Date.parse(l.updatedAt!) >= Date.parse(account.updatedAt!))) account = l;
        return { success: true, ...(l ? { 'home.layout': account } : {}) } as never;
    });
    vi.mocked(api.getHome).mockImplementation(async (params = {}) => {
        const asked = params.cards ? [...params.cards] : Object.keys(full.cards);
        const cards = Object.fromEntries(Object.entries(full.cards).filter(([id]) => asked.includes(id)));
        return fresh({ ...full, layout: account, cards });
    });
    return { account: () => account };
}
/**
 * A node that keeps what a real one keeps (review of #1701): the newer version-2 list, or any row it starts with (an
 * empty version-1 one), answered raw; it builds the cards asked for, or with no `cards=` every card it has. Its log is
 * the requests in order.
 */
function nodeKeeping(full: HomeAnswer, start: unknown) {
    let account: unknown = start;
    const log: string[] = [];
    const at = (x: unknown) => (x && typeof x === 'object' && typeof (x as { updatedAt?: unknown }).updatedAt === 'string' ? Date.parse((x as { updatedAt: string }).updatedAt) : -Infinity);
    vi.mocked(api.saveHomePreferences).mockImplementation(async (_pk, prefs) => {
        const l = prefs['home.layout'] as unknown as ReturnType<typeof v2> | undefined;
        log.push('POST');
        if (l && at(l) >= at(account)) account = l;
        return { success: true, 'home.layout': account } as never;
    });
    vi.mocked(api.getHome).mockImplementation(async (params = {}) => {
        log.push(params.cards ? `GET ${params.cards.join(',')}` : 'GET');
        const asked = params.cards ? [...params.cards] : Object.keys(full.cards);
        return fresh({ ...full, layout: account as never, cards: Object.fromEntries(Object.entries(full.cards).filter(([id]) => asked.includes(id))) });
    });
    return { log, account: () => account as ReturnType<typeof v2> };
}
const pause = async (ms = 50) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
/** An empty version-1 row: "Your way back in" put away on the web app before the frame, or its Reset. */
const EMPTY_V1 = { v: 1, order: [], hidden: [], dismissed: { safety: '2026-09-01T00:00:00.000Z' }, updatedAt: '2026-09-01T00:00:00.000Z' };
const newcomerTypes = () => defaultCards('local').map(c => c.type);
const savedLayouts = () => vi.mocked(api.saveHomePreferences).mock.calls.map(c => c[1]['home.layout'] as unknown as ReturnType<typeof v2>).filter(Boolean);
const lastCall = (m: { mock: { invocationCallOrder: number[] } }) => m.mock.invocationCallOrder.at(-1) ?? 0;

describe('the card frame (F3)', () => {
    it('a newcomer with no layout gets the newcomer list: no Beans or Pulse card until added', async () => {
        nodeV2(answer(), null);
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(cardIds()).not.toContain('beans');
        expect(cardIds()).not.toContain('pulse');
        expect(cardIds().at(-1)).toBe('community');
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it('Add a card: the picker lists this node\'s types with On Home; the card goes first, is said, saved, then Home is read again', async () => {
        nodeV2(answer(), v2(['market', 'events']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        fireEvent.click(screen.getByTestId('home-add-open'));
        expect(screen.getByTestId('home-add-on-market')).toHaveTextContent('On Home');
        const reads = vi.mocked(api.getHome).mock.calls.length;
        fireEvent.click(screen.getByTestId('home-add-beans'));
        await waitFor(() => expect(cardIds()).toContain('beans'));
        expect(cardIds().indexOf('beans')).toBeLessThan(cardIds().indexOf('market'));
        expect(screen.getByTestId('home-live').textContent).toMatch(/added to Home$/);
        expect(savedLayouts().at(-1)!.cards[0].type).toBe('beans');
        // POST, then GET with the new card asked.
        await waitFor(() => expect(vi.mocked(api.getHome).mock.calls.length).toBeGreaterThan(reads));
        expect(lastCall(vi.mocked(api.getHome))).toBeGreaterThan(lastCall(vi.mocked(api.saveHomePreferences)));
        expect(vi.mocked(api.getHome).mock.calls.at(-1)![0]!.cards).toContain('beans');
        expect(document.activeElement).toBe(within(screen.getByTestId('home-card-beans')).getByTestId('home-card-menu'));
    });

    it('Remove: the card goes, is said by name, the list is saved without it; a move swaps it in the saved list', async () => {
        nodeV2(answer(), v2(['market', 'events', 'pulse']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-pulse');
        fireEvent.click(within(screen.getByTestId('home-card-market')).getByTestId('home-card-menu'));
        fireEvent.click(screen.getByText('Move down'));
        await waitFor(() => expect(savedLayouts().at(-1)!.cards.map(c => c.type)).toEqual(['events', 'market', 'pulse']));
        fireEvent.click(within(screen.getByTestId('home-card-pulse')).getByTestId('home-card-menu'));
        fireEvent.click(screen.getByTestId('home-menu-remove'));
        await waitFor(() => expect(cardIds()).not.toContain('pulse'));
        expect(screen.getByTestId('home-live').textContent).toMatch(/removed\. Add a card brings it back\.$/);
        await waitFor(() => expect(savedLayouts().at(-1)!.cards.map(c => c.type)).toEqual(['events', 'market']));
    });

    it('a card type this app does not know is kept byte for byte through every save, and never drawn or asked', async () => {
        const future = { id: 'fut1', type: 'future-card', settings: { a: [1, { b: 'é' }] } };
        nodeV2(answer(), v2(['market', 'events', 'pulse'], AT, [future]));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-pulse');
        expect(cardIds()).not.toContain('fut1');
        fireEvent.click(within(screen.getByTestId('home-card-pulse')).getByTestId('home-card-menu'));
        fireEvent.click(screen.getByTestId('home-menu-remove'));
        await waitFor(() => expect(savedLayouts()).toHaveLength(1));
        expect(JSON.stringify(savedLayouts()[0].cards.find(c => c.id === 'fut1'))).toBe(JSON.stringify(future));
        for (const c of vi.mocked(api.getHome).mock.calls) expect(c[0]?.cards ?? []).not.toContain('fut1');
    });

    it('an empty version-1 list (a standby) draws the newcomer list; when the real list returns it stands and nothing is sent', async () => {
        const node = nodeV2(answer(), null);
        vi.mocked(api.getHome).mockResolvedValueOnce(fresh(answer({ layout: { v: 1, order: [], hidden: [], dismissed: {}, updatedAt: AT } as never })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(cardIds()).not.toContain('beans');
        // The primary is back with the member's real list.
        (node as unknown as { account: () => unknown }).account();
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ layout: v2(['beans', 'market'], '2026-10-02T00:00:00.000Z') })));
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await waitFor(() => expect(cardIds()).toContain('beans'));
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it('a node from before the frame refuses the list: kept here, Edit home says so, sent again once per landing only', async () => {
        const v1Answer = answer({ layout: { v: 1, order: ['market', 'events', 'pulse'], hidden: [], dismissed: {}, updatedAt: AT } as never });
        vi.mocked(api.getHome).mockResolvedValue(fresh(v1Answer));
        vi.mocked(api.saveHomePreferences).mockImplementation(async () => { throw Object.assign(new Error('bad layout'), { status: 400 }); });
        const first = render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-pulse');
        fireEvent.click(within(screen.getByTestId('home-card-pulse')).getByTestId('home-card-menu'));
        fireEvent.click(screen.getByTestId('home-menu-remove'));
        await waitFor(() => expect(api.saveHomePreferences).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(cardIds()).not.toContain('pulse'));
        fireEvent.click(screen.getByTestId('home-edit-open'));
        expect(screen.getByTestId('home-edit-not-on-account')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('home-edit-done'));
        // More reads on this landing send nothing.
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(2));
        expect(api.saveHomePreferences).toHaveBeenCalledTimes(1);
        expect(cardIds()).not.toContain('pulse');
        // The next landing sends it once more.
        first.unmount();
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(api.saveHomePreferences).toHaveBeenCalledTimes(2));
        expect(cardIds()).not.toContain('pulse');
    });

    it('the standby tie: a version-1 copy dated like this browser\'s never wins, and nothing is sent', async () => {
        const mine = v2(['beans', 'market']);
        await writeCachedHome(homeCacheKey(ME.publicKey), { etag: null, answer: answer({ layout: mine }), layout: mine as never, layoutUnsaved: false, savedAt: 1 });
        vi.mocked(api.getHome).mockResolvedValue(fresh(answer({ layout: { v: 1, order: ['market', 'events'], hidden: [], dismissed: {}, updatedAt: AT } as never })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(api.getHome).toHaveBeenCalled());
        await waitFor(() => expect(cardIds()).toContain('beans'));
        expect(cardIds()).not.toContain('events');
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it('a member here before the frame who never edited sees the fewer-cards line once', async () => {
        nodeV2(answer(), null);
        const first = render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('home-fewer')).toHaveTextContent('Home now starts with fewer cards. Add a card brings the rest back.');
        first.unmount();
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(screen.queryByTestId('home-fewer')).toBeNull();
    });

    it('on the global node, cards= never asks for Beans or deals once the answer says it is global', async () => {
        const g = answer({ profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false, guestListingsOnly: false } as never });
        nodeV2(g, v2(['beans', 'deals', 'market']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await waitFor(() => expect(vi.mocked(api.getHome).mock.calls.length).toBeGreaterThan(1));
        const asked = vi.mocked(api.getHome).mock.calls.at(-1)![0]!.cards!;
        expect(asked).not.toContain('beans');
        expect(asked).not.toContain('deals');
        expect(cardIds()).not.toContain('beans');
    });
});

describe('an empty version-1 account list, no copy here: every edit stands once the first is saved (review of #1701, finding 1)', () => {
    const posts = (log: string[]) => log.filter(l => l === 'POST').length;

    it('R1: Add Your Beans, then Remove Coming up: the second edit is sent and stays', async () => {
        const node = nodeKeeping(answer(), EMPTY_V1);
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-events');
        fireEvent.click(screen.getByTestId('home-add-open'));
        fireEvent.click(screen.getByTestId('home-add-beans'));
        await waitFor(() => expect(posts(node.log)).toBe(1));
        await pause();
        await waitFor(() => expect(cardIds()).toContain('beans'));
        fireEvent.click(within(screen.getByTestId('home-card-events')).getByTestId('home-card-menu'));
        fireEvent.click(screen.getByTestId('home-menu-remove'));
        await pause(100);
        expect(posts(node.log)).toBe(2);
        expect(cardIds()).not.toContain('events');
        expect(node.account().cards.map(c => c.id)).not.toContain('events');
        expect(node.account().cards.map(c => c.id)).toContain('beans');
    });

    it('R1b: Remove Coming up, then add a saved search: the search and its words stay', async () => {
        const node = nodeKeeping(answer(), EMPTY_V1);
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-events');
        fireEvent.click(within(screen.getByTestId('home-card-events')).getByTestId('home-card-menu'));
        fireEvent.click(screen.getByTestId('home-menu-remove'));
        await waitFor(() => expect(posts(node.log)).toBe(1));
        await pause();
        fireEvent.click(screen.getByTestId('home-add-open'));
        fireEvent.click(screen.getByTestId('home-add-search'));
        fireEvent.change(screen.getByTestId('home-settings-q'), { target: { value: 'eggs' } });
        fireEvent.click(screen.getByTestId('home-settings-submit'));
        await pause(100);
        expect(posts(node.log)).toBe(2);
        expect(cardIds().some(id => id.startsWith('search-'))).toBe(true);
        expect((node.account().cards.find(c => c.type === 'search') as { settings?: unknown } | undefined)?.settings).toMatchObject({ q: 'eggs' });
    });

    it('R1c: the fewer-cards line shows; Your Beans, The Pulse and Your groups added one after another all stay', async () => {
        const node = nodeKeeping(answer({}, { groups: { items: [{ id: 'g1', name: 'Garden', unread: 1, muted: false }] } } as never), EMPTY_V1);
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-events');
        expect(screen.getByTestId('home-fewer')).toBeInTheDocument();
        for (const t of ['beans', 'pulse', 'groups']) {
            fireEvent.click(screen.getByTestId('home-add-open'));
            fireEvent.click(screen.getByTestId(`home-add-${t}`));
            await pause(80);
        }
        for (const t of ['beans', 'pulse', 'groups']) expect(cardIds()).toContain(t);
        expect(posts(node.log)).toBe(3);
        expect(node.account().cards.map(c => c.type)).toEqual(expect.arrayContaining(['beans', 'pulse', 'groups']));
    });
});

describe('a read that overtakes the first save\'s answer on an empty version-1 list: the newer edit stands and is sent (review of #1701 confirmation, finding 2)', () => {
    const ids = (l: unknown) => ((l as { cards?: Array<{ id: string }> } | null)?.cards ?? []).map(c => c.id);
    /**
     * nodeKeeping, but a save is applied at once and answered `delayMs` later. As home-preferences.ts, a date ahead of the
     * node's clock is held to its now; `behindMs`: the node's clock is that far behind this browser's.
     */
    function nodeSlowSave(full: HomeAnswer, start: unknown, delayMs: number, behindMs = 0) {
        let account: unknown = start;
        const log: string[] = [];
        const at = (x: unknown) => (x && typeof x === 'object' && typeof (x as { updatedAt?: unknown }).updatedAt === 'string' ? Date.parse((x as { updatedAt: string }).updatedAt) : -Infinity);
        vi.mocked(api.saveHomePreferences).mockImplementation(async (_pk, prefs) => {
            const sent = prefs['home.layout'] as unknown;
            log.push(`POST ${ids(sent).join(',')}`);
            const nodeNow = Date.now() - behindMs;
            const l = sent && at(sent) > nodeNow ? { ...(sent as object), updatedAt: new Date(nodeNow).toISOString() } : sent;
            if (l && at(l) >= at(account)) account = l;
            await new Promise(r => setTimeout(r, delayMs));
            log.push('answered');
            return { success: true, 'home.layout': account } as never;
        });
        vi.mocked(api.getHome).mockImplementation(async (params = {}) => {
            log.push(params.cards ? 'GET cards=' : 'GET');
            const asked = params.cards ? [...params.cards] : Object.keys(full.cards);
            return fresh({ ...full, layout: account as never, cards: Object.fromEntries(Object.entries(full.cards).filter(([id]) => asked.includes(id))) });
        });
        return { log, account: () => account };
    }
    const add = (t: string) => {
        fireEvent.click(screen.getByTestId('home-add-open'));
        fireEvent.click(screen.getByTestId(`home-add-${t}`));
    };
    const posts = (log: string[]) => log.filter(l => l.startsWith('POST ')).length;

    it('X1: Add Your Beans, then Add The Pulse before the first save answers, and the second edit\'s read answers first: both stand, on the account too', async () => {
        const node = nodeSlowSave(answer(), EMPTY_V1, 400);
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-events');
        add('beans');
        await waitFor(() => expect(posts(node.log)).toBe(1));
        await pause(20);
        // The node has the first save; its answer is still out. The second edit's read answers before it.
        add('pulse');
        await pause(60);
        expect(node.log).not.toContain('answered');
        expect(cardIds()).toEqual(expect.arrayContaining(['beans', 'pulse']));
        await pause(900);
        expect(cardIds()).toEqual(expect.arrayContaining(['beans', 'pulse']));
        expect(ids(node.account())).toEqual(expect.arrayContaining(['beans', 'pulse']));
        // The second edit is sent once, after the first save's answer (one save out at a time).
        expect(posts(node.log)).toBe(2);
        expect(node.log.indexOf('answered')).toBeLessThan(node.log.map(l => l.startsWith('POST ')).lastIndexOf(true));
        expect(screen.getByTestId('home-live').textContent).toContain('The Pulse');
    });

    it('X1, the mark kept in this browser: closed before either answer, opened again, the account\'s list is this browser\'s own save, so the newer edit wins and is sent', async () => {
        const node = nodeSlowSave(answer(), EMPTY_V1, 400);
        const first = render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-events');
        add('beans');
        await waitFor(() => expect(posts(node.log)).toBe(1));
        await pause(20);
        add('pulse');
        // Closed at once: the second edit's read and the first save's answer reach no page.
        first.unmount();
        await pause(20);
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-pulse');
        await pause(900);
        expect(cardIds()).toEqual(expect.arrayContaining(['beans', 'pulse']));
        expect(ids(node.account())).toEqual(expect.arrayContaining(['beans', 'pulse']));
        expect(posts(node.log)).toBe(2);
    });

    it('a standby\'s refusal keeps the mark, and the primary back with the member\'s real list still wins: nothing more is sent', async () => {
        const real = v2(['market', 'events', 'pulse'], AT);
        let primary = false;
        let account: unknown = { v: 1, order: [], hidden: [], dismissed: {}, updatedAt: AT };
        vi.mocked(api.saveHomePreferences).mockImplementation(async (_pk, prefs) => {
            if (!primary) throw Object.assign(new Error('A Home layout is …'), { status: 400 });
            account = prefs['home.layout'];
            return { success: true, 'home.layout': account } as never;
        });
        vi.mocked(api.getHome).mockImplementation(async (params = {}) => {
            const full = answer();
            const asked = params.cards ? [...params.cards] : Object.keys(full.cards);
            return fresh({ ...full, layout: (primary ? real : account) as never, cards: Object.fromEntries(Object.entries(full.cards).filter(([id]) => asked.includes(id))) });
        });
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-events');
        add('beans');
        await pause(80);
        fireEvent.click(within(screen.getByTestId('home-card-events')).getByTestId('home-card-menu'));
        fireEvent.click(screen.getByTestId('home-menu-remove'));
        await pause(80);
        expect(api.saveHomePreferences).toHaveBeenCalledTimes(1);
        primary = true;
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await pause(100);
        expect(api.saveHomePreferences).toHaveBeenCalledTimes(1);
        expect(cardIds()).toEqual(expect.arrayContaining(['market', 'events', 'pulse']));
        expect(cardIds()).not.toContain('beans');
    });

    for (const behind of [200, 5_000]) {
        it(`S1: X1 with the node's clock ${behind} ms behind this browser's, so the node dates the first save earlier than sent: both edits stand, on the account too (review of #1715, finding 1)`, async () => {
            const node = nodeSlowSave(answer(), EMPTY_V1, 400, behind);
            render(<HomePage identity={ME} onNavigate={vi.fn()} />);
            await screen.findByTestId('home-card-events');
            add('beans');
            await waitFor(() => expect(posts(node.log)).toBe(1));
            await pause(20);
            // The second edit's read carries the first save back with the node's date, not the one this browser sent.
            add('pulse');
            await pause(60);
            expect(node.log).not.toContain('answered');
            await pause(900);
            expect(cardIds()).toEqual(expect.arrayContaining(['beans', 'pulse']));
            expect(ids(node.account())).toEqual(expect.arrayContaining(['beans', 'pulse']));
            expect(posts(node.log)).toBe(2);
            expect(screen.getByTestId('home-live').textContent).toContain('The Pulse');
            await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
            await pause(300);
            expect(cardIds()).toEqual(expect.arrayContaining(['beans', 'pulse']));
            expect(ids(node.account())).toEqual(expect.arrayContaining(['beans', 'pulse']));
            // The copy took the node's date from the save's answer: the read sends nothing more (review of #1715, note 1).
            expect(posts(node.log)).toBe(2);
        });
    }

    it('S2: the member\'s own list, the node\'s clock 5 s behind this browser\'s: one Add is sent once, and the reads after it send nothing (review of #1715, note 1)', async () => {
        const node = nodeSlowSave(answer(), v2(['events', 'market', 'pulse'], AT), 0, 5_000);
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-events');
        add('beans');
        await pause(200);
        expect(posts(node.log)).toBe(1);
        for (let i = 0; i < 4; i++) {
            await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
            await pause(300);
        }
        expect(node.log.filter(l => l.startsWith('GET')).length).toBeGreaterThanOrEqual(5);
        expect(posts(node.log)).toBe(1);
        expect(cardIds()).toEqual(expect.arrayContaining(['events', 'market', 'pulse', 'beans']));
        expect(ids(node.account())).toEqual(expect.arrayContaining(['events', 'market', 'pulse', 'beans']));
    });

    it('S1, the mark kept in this browser: the node\'s clock 5 s behind, closed before either answer, opened again: the node\'s copy of the first save is still this browser\'s own, so the newer edit wins and is sent', async () => {
        const node = nodeSlowSave(answer(), EMPTY_V1, 400, 5_000);
        const first = render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-events');
        add('beans');
        await waitFor(() => expect(posts(node.log)).toBe(1));
        await pause(20);
        add('pulse');
        first.unmount();
        await pause(20);
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-pulse');
        await pause(900);
        expect(cardIds()).toEqual(expect.arrayContaining(['beans', 'pulse']));
        expect(ids(node.account())).toEqual(expect.arrayContaining(['beans', 'pulse']));
        expect(posts(node.log)).toBe(2);
    });

    it('W2b: another device\'s list lands just before the first save, which the node drops as older: that list stands, and the edit that waited is not sent (review of #1715, finding 2)', async () => {
        const full = answer();
        const at = (x: unknown) => (x && typeof x === 'object' && typeof (x as { updatedAt?: unknown }).updatedAt === 'string' ? Date.parse((x as { updatedAt: string }).updatedAt) : -Infinity);
        let account: unknown = EMPTY_V1;
        const log: string[] = [];
        vi.mocked(api.saveHomePreferences).mockImplementation(async (_pk, prefs) => {
            const l = prefs['home.layout'] as unknown;
            log.push(`POST ${ids(l).join(',')}`);
            if (log.filter(x => x.startsWith('POST ')).length === 1) {
                // The first save is applied only as it answers; another device's list, dated 5 ms after it, lands first.
                await new Promise(r => setTimeout(r, 400));
                const other = {
                    v: 2, dismissed: {}, updatedAt: new Date(at(l) + 5).toISOString(),
                    cards: [{ id: 'market', type: 'market' }, { id: 'decide', type: 'decide' }, { id: 'search-k2x7', type: 'search', settings: { q: 'eggs', kind: 'any' } }],
                };
                if (at(other) >= at(account)) account = other;
            }
            if (at(l) >= at(account)) account = l;
            log.push('answered');
            return { success: true, 'home.layout': account } as never;
        });
        vi.mocked(api.getHome).mockImplementation(async (params = {}) => {
            log.push(params.cards ? 'GET cards=' : 'GET');
            const asked = params.cards ? [...params.cards] : Object.keys(full.cards);
            return fresh({ ...full, layout: account as never, cards: Object.fromEntries(Object.entries(full.cards).filter(([id]) => asked.includes(id))) });
        });
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-events');
        add('beans');
        await waitFor(() => expect(posts(log)).toBe(1));
        await pause(40);
        // The second edit's read still sees the empty row: the first save is not applied yet.
        add('pulse');
        await pause(920);
        expect(log).toContain('answered');
        expect(posts(log)).toBe(1);
        expect(ids(account)).toEqual(['market', 'decide', 'search-k2x7']);
        expect(cardIds()).toEqual(expect.arrayContaining(['market', 'search-k2x7']));
        expect(cardIds()).not.toContain('pulse');
        // Nothing more is sent at the next read either.
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await pause(300);
        expect(posts(log)).toBe(1);
        expect(ids(account)).toEqual(['market', 'decide', 'search-k2x7']);
    });
});

describe('what a never-edited member asks, and the old web app\'s empty copy (review of #1701, findings 6 and 4)', () => {
    it('R3: no row and no copy: the first read has no cards=, every read after it asks the newcomer\'s cards', async () => {
        const node = nodeKeeping(answer(), null);
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        await pause();
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await pause();
        expect(node.log[0]).toBe('GET');
        const later = node.log.slice(1).filter(l => l.startsWith('GET'));
        expect(later.length).toBeGreaterThanOrEqual(1);
        for (const l of later) {
            const asked = l.slice(4).split(',');
            expect(asked).toEqual(expect.arrayContaining(['needs', 'market', 'events', 'community']));
            expect(asked).not.toContain('pulse');
            expect(asked).not.toContain('beans');
        }
        expect(node.log).not.toContain('POST');
    });

    it('R5: the old web app\'s Reset (an empty version-1 list on the account and in this browser\'s copy) is unknown: the newcomer\'s list, the fewer line, the newcomer\'s ask', async () => {
        const empty = { v: 1, order: [], hidden: [], dismissed: {}, updatedAt: AT };
        await writeCachedHome(homeCacheKey(ME.publicKey), { etag: null, answer: answer({ layout: empty as never }), layout: empty as never, layoutUnsaved: false, savedAt: 1 });
        const node = nodeKeeping(answer(), empty);
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        await pause();
        expect(cardIds()).not.toContain('pulse');
        expect(cardIds()).not.toContain('beans');
        expect(screen.getByTestId('home-fewer')).toBeInTheDocument();
        const asked = node.log.find(l => l.startsWith('GET'))!.slice(4).split(',');
        expect(asked).not.toContain('pulse');
        expect(asked).not.toContain('beans');
        expect(node.log).not.toContain('POST');
    });
});

describe('a saved search shows its listings (CARD-FRAME §4, §5.2 item 20; slice F4)', () => {
    const row = (id: string, title: string, type: 'offer' | 'need', km: number) => ({ id, type, title, category: 'food', credits: 5, photoUrl: null, distanceKm: km });
    const layout = (q = 'eggs') => v2(['market', 'events'], AT, [{ id: 'search-k7mq', type: 'search', settings: { q, kind: 'any', km: 5 } }]);
    const withBody = (body: unknown) => answer({}, { ...answer().cards, 'search-k7mq': body } as never);

    it('the words and distance first, four Market rows each opening its listing, See more opening the Market with the words', async () => {
        const onNavigate = vi.fn();
        nodeKeeping(withBody({ q: 'eggs', kind: 'any', category: null, km: 5, more: true, items: [
            row('p1', 'Chicken coop wanted', 'need', 0.2), row('p2', 'Fresh eggs', 'offer', 0.5), row('p3', 'Duck eggs', 'offer', 1.4), row('p4', 'Quail eggs', 'offer', 3),
        ] }), layout());
        render(<HomePage identity={ME} onNavigate={onNavigate} />);
        const card = await screen.findByTestId('home-card-search-k7mq');
        await waitFor(() => expect(within(card).getAllByTestId('home-search-item')).toHaveLength(4));
        // The caption is the type's, never the member's words.
        expect(within(card).getByRole('heading', { name: 'A saved search' })).toBeInTheDocument();
        expect(within(card).getByTestId('home-search-words')).toHaveTextContent(/^eggs · within 5 km$/);
        const items = within(card).getAllByTestId('home-search-item');
        expect(items[0]).toHaveAccessibleName('Need, Chicken coop wanted, 5 Beans, under 1 km away');
        expect(items[1]).toHaveTextContent('5 Beans');
        fireEvent.click(items[2]);
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'p3');
        const more = within(card).getByTestId('home-search-more');
        expect(more).toHaveTextContent('See more ›');
        expect(more).toHaveAccessibleName('See more listings for eggs in the Market');
        fireEvent.click(more);
        expect(onNavigate).toHaveBeenCalledWith('marketplace-search', 'eggs');
        expect(within(card).queryByTestId('home-search-offline')).toBeNull();
    });

    it('nothing found says so in its own words; no See more without more', async () => {
        nodeKeeping(withBody({ q: 'eggs', kind: 'any', category: null, km: 5, more: false, items: [] }), layout());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-search-k7mq');
        await waitFor(() => expect(within(card).getByTestId('home-search-empty')).toHaveTextContent('No eggs within 5 km right now'));
        expect(within(card).queryByTestId('home-search-more')).toBeNull();
    });

    it('with no point the node ignored the distance: the words alone', async () => {
        nodeKeeping(withBody({ q: 'eggs', kind: 'any', category: null, km: null, more: false, items: [row('p2', 'Fresh eggs', 'offer', 0.5)] }), layout());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-search-k7mq');
        await waitFor(() => expect(within(card).getAllByTestId('home-search-item')).toHaveLength(1));
        expect(within(card).getByTestId('home-search-words')).toHaveTextContent(/^eggs$/);
    });

    it('no body for these words (an older node, or a kept answer for other words): it shows when the community answers', async () => {
        nodeKeeping(withBody({ q: 'rye', kind: 'any', category: null, km: 5, more: false, items: [row('p9', 'Rye loaf', 'offer', 1)] }), layout());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-search-k7mq');
        await waitFor(() => expect(within(card).getByTestId('home-search-offline')).toHaveTextContent('Shows when your community answers'));
        expect(card).not.toHaveTextContent('Rye loaf');
        expect(card).not.toHaveTextContent('coming app update');
    });

    it('a kept answer for another kind is no answer after Settings… changes it: no old rows (review of #1716, finding 2)', async () => {
        nodeKeeping(withBody({ q: 'eggs', kind: 'offer', category: null, km: 5, more: false, items: [row('p2', 'Fresh eggs', 'offer', 0.5)] }), layout());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-search-k7mq');
        // The node has answered (with the kept Offers rows), not merely not yet.
        await waitFor(() => expect(api.getHome).toHaveBeenCalled());
        await pause();
        await waitFor(() => expect(within(card).getByTestId('home-search-offline')).toHaveTextContent('Shows when your community answers'));
        expect(within(card).queryAllByTestId('home-search-item')).toHaveLength(0);
        expect(card).not.toHaveTextContent('Fresh eggs');
    });

    it('Edit home names the row by its words, so two searches are two rows', async () => {
        nodeKeeping(answer(), v2(['market'], AT, [
            { id: 'search-k7mq', type: 'search', settings: { q: 'eggs', kind: 'any' } },
            { id: 'search-m4p9', type: 'search', settings: { q: 'duck eggs', kind: 'any' } },
        ]));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-search-k7mq');
        fireEvent.click(screen.getByTestId('home-edit-open'));
        expect(screen.getByTestId('home-edit-row-search-k7mq')).toHaveTextContent('eggs');
        expect(screen.getByTestId('home-edit-row-search-m4p9')).toHaveTextContent('duck eggs');
        expect(screen.getByTestId('home-edit-row-search-k7mq')).not.toHaveTextContent('A saved search');
    });

    it('Edit home: two searches with the same words and another kind read differently, rows and labels (review of #1716)', async () => {
        nodeKeeping(answer(), v2(['market'], AT, [
            { id: 'search-k7mq', type: 'search', settings: { q: 'eggs', kind: 'offer' } },
            { id: 'search-m4p9', type: 'search', settings: { q: 'eggs', kind: 'need' } },
            { id: 'search-r8t2', type: 'search', settings: { q: 'eggs', kind: 'any' } },
        ]));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-search-k7mq');
        fireEvent.click(screen.getByTestId('home-edit-open'));
        expect(screen.getByTestId('home-edit-row-search-k7mq')).toHaveTextContent('Offers · eggs');
        expect(screen.getByTestId('home-edit-row-search-m4p9')).toHaveTextContent('Needs · eggs');
        expect(screen.getByTestId('home-edit-row-search-r8t2')).toHaveTextContent('eggs');
        expect(screen.getByTestId('home-edit-row-search-r8t2')).not.toHaveTextContent(/Offers|Needs|Both/);
        expect(screen.getByTestId('home-edit-up-search-k7mq')).toHaveAccessibleName('Move "eggs" (Offers) up');
        expect(screen.getByTestId('home-edit-up-search-m4p9')).toHaveAccessibleName('Move "eggs" (Needs) up');
        expect(screen.getByTestId('home-edit-up-search-r8t2')).toHaveAccessibleName('Move "eggs" up');
    });
});

describe('Home\'s dialogs: only the one in front has the keys, and focus never drops to the page (review of #1701, findings 2 and 3)', () => {
    const withSearch = () => v2(['market', 'events'], AT, [{ id: 'search-k7mq', type: 'search', settings: { q: 'eggs', kind: 'any' } }]);
    const focused = () => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName;
    const openSearchSettingsFromEditHome = async () => {
        nodeKeeping(answer(), withSearch());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-search-k7mq');
        // As a keyboard user does: each control has focus as it is pressed (a click in jsdom moves none).
        const press = (id: string) => { const el = screen.getByTestId(id); el.focus(); fireEvent.click(el); };
        press('home-edit-open');
        press('home-edit-menu-search-k7mq');
        press('home-edit-settings-search-k7mq');
        return screen.getByTestId('home-settings-dialog');
    };

    it('D1: Escape in a saved search\'s Settings… opened from Edit home closes only the settings; focus to the row\'s "…"', async () => {
        await openSearchSettingsFromEditHome();
        fireEvent.keyDown(document, { key: 'Escape' });
        await pause();
        expect(screen.queryByTestId('home-settings-dialog')).toBeNull();
        expect(screen.getByTestId('home-edit-dialog')).toBeInTheDocument();
        expect(focused()).toBe('home-edit-menu-search-k7mq');
    });

    it('D2: Tab in that sheet goes round its own controls: Edit home underneath leaves the key alone', async () => {
        const sheet = await openSearchSettingsFromEditHome();
        const tab = (from: HTMLElement) => {
            from.focus();
            const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
            document.dispatchEvent(ev);
            return ev.defaultPrevented;
        };
        // Neither is the sheet's last control: the browser moves on to the next one.
        expect(tab(within(sheet).getByTestId('home-settings-q'))).toBe(false);
        expect(tab(within(sheet).getByTestId('home-settings-dialog-done'))).toBe(false);
        // From its last control, round to its first (never out to Edit home's).
        const submit = within(sheet).getByTestId('home-settings-submit');
        submit.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(sheet.contains(document.activeElement)).toBe(true);
    });

    it('D3: a card\'s "…" → Settings… → Save: focus to that card\'s "…"', async () => {
        nodeKeeping(answer(), withSearch());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-search-k7mq');
        fireEvent.click(within(card).getByTestId('home-card-menu'));
        fireEvent.click(within(card).getByTestId('home-menu-settings'));
        fireEvent.change(screen.getByTestId('home-settings-q'), { target: { value: 'duck eggs' } });
        fireEvent.click(screen.getByTestId('home-settings-submit'));
        await pause(60);
        expect(document.activeElement).toBe(within(screen.getByTestId('home-card-search-k7mq')).getByTestId('home-card-menu'));
    });

    it('D4: the picker opened from Edit home, closed with Done: focus to the community card\'s Add a card', async () => {
        nodeKeeping(answer(), withSearch());
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-search-k7mq');
        fireEvent.click(screen.getByTestId('home-edit-open'));
        fireEvent.click(screen.getByTestId('home-edit-add'));
        await pause();
        fireEvent.click(screen.getByTestId('home-add-dialog-done'));
        await pause();
        expect(focused()).toBe('home-add-open');
    });

    it('D5: a card added with nothing to show yet: focus to Add a card, and it stays there once the add\'s read is in', async () => {
        nodeKeeping(answer(), v2(['market', 'events']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        fireEvent.click(screen.getByTestId('home-add-open'));
        fireEvent.click(screen.getByTestId('home-add-joined'));
        await pause(80);
        expect(screen.getByTestId('home-live').textContent).toBe('Who joined added to Home');
        expect(focused()).toBe('home-add-open');
    });

    it('D6: the picker\'s saved-search sheet, Escape: back in the picker, focus on that row\'s Add', async () => {
        nodeKeeping(answer(), v2(['market', 'events']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        fireEvent.click(screen.getByTestId('home-add-open'));
        fireEvent.click(screen.getByTestId('home-add-search'));
        fireEvent.keyDown(document, { key: 'Escape' });
        await pause();
        const picker = screen.getByTestId('home-add-dialog');
        expect(picker.contains(document.activeElement)).toBe(true);
        expect(focused()).toBe('home-add-search');
    });
});

describe('sun and moon: worked out in the browser, from the place the answer holds (CARD-FRAME §4, §5.2 item 22)', () => {
    const MULLUM = { lat: -28.55, lng: 153.5 };
    const REYKJAVIK = { lat: 64.15, lng: -21.94 };
    /** The sun's half of the line, which can't tick over between the page's moment and the test's (the moon's percent could). */
    const sunPart = (text: string) => text.slice(text.indexOf(' · '));
    const skyLayout = (settings?: Record<string, unknown>, withSky = true) => ({
        v: 2 as const, dismissed: {}, updatedAt: '2026-10-01T00:00:00.000Z',
        cards: [...(withSky ? [{ id: 'sky', type: 'sky', ...(settings ? { settings } : {}) }] : []), { id: 'market', type: 'market' }, { id: 'events', type: 'events' }],
    });
    const placed = (opts: { community?: typeof MULLUM; area?: typeof MULLUM; settings?: Record<string, unknown>; withSky?: boolean }) => answer(
        { me: { ...answer().me!, area: opts.area ?? null }, layout: skyLayout(opts.settings, opts.withSky ?? true) as never },
        { community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23, ...(opts.community ? { place: opts.community } : {}) } },
    );
    const visible = () => screen.getByTestId('home-sky-line').querySelector('[aria-hidden="true"]')!.textContent!;
    const said = () => screen.getByTestId('home-sky-line').querySelector('.sr-only')!.textContent!;

    it("draws the community's place on this browser's clock; a screen reader hears it in words, never the picture", async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(placed({ community: MULLUM, area: REYKJAVIK })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-sky');
        expect(cardIds()[0]).toBe('sky');
        expect(screen.getByTestId('home-card-sky')).toHaveTextContent('Sun and moon');
        const there = skyToday(MULLUM, Date.now());
        expect(visible()).toMatch(/^\S+ (New moon|Waxing crescent|First quarter|Waxing gibbous|Full moon|Waning gibbous|Last quarter|Waning crescent), \d{1,3}% · /);
        expect(sunPart(visible())).toBe(sunPart(there.text));
        expect(sunPart(visible())).not.toBe(sunPart(skyToday(REYKJAVIK, Date.now()).text));
        expect(said()).toMatch(/^(Moon [a-z ]+|New moon|Full moon), \d{1,3} percent lit\. /);
        expect(said()).not.toMatch(/[\u{1F311}-\u{1F318}]/u);
        expect(said().slice(said().indexOf('lit. '))).toBe(there.label.slice(there.label.indexOf('lit. ')));
        // Nothing on it to open: its only button is its "…". At 320 px the line wraps at word breaks, never cut.
        expect(within(screen.getByTestId('home-card-sky')).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Card options for Sun and moon']);
        expect(screen.getByTestId('home-sky-line')).toHaveClass('break-words');
        expect(screen.getByTestId('home-sky-line').className).not.toMatch(/truncate|line-clamp|whitespace-nowrap|overflow-hidden/);
    });

    it("with no community place, the member's area; and 'Your area' puts the member's first", async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(placed({ area: REYKJAVIK })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-sky');
        expect(sunPart(visible())).toBe(sunPart(skyToday(REYKJAVIK, Date.now()).text));
        cleanup();
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        resetHomeCacheForTest();
        vi.mocked(api.getHome).mockResolvedValue(fresh(placed({ community: MULLUM, area: REYKJAVIK, settings: { place: 'me' } })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-sky');
        expect(sunPart(visible())).toBe(sunPart(skyToday(REYKJAVIK, Date.now()).text));
    });

    it('with no place at all, it is not drawn, and Edit home says why', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(placed({})));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(screen.queryByTestId('home-card-sky')).toBeNull();
        fireEvent.click(screen.getByTestId('home-edit-open'));
        expect(within(screen.getByTestId('home-edit-row-sky')).getByText(SKY_NO_PLACE_LINE)).toBeInTheDocument();
    });

    it('makes no request of its own: a landing with it asks exactly what a landing without it asks', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(placed({ community: MULLUM, withSky: false })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        const without = { reads: vi.mocked(api.getHome).mock.calls.map(c => c[0]), saves: vi.mocked(api.saveHomePreferences).mock.calls.length };
        cleanup();
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        resetHomeCacheForTest();
        vi.mocked(api.getHome).mockClear();
        vi.mocked(api.saveHomePreferences).mockClear();
        vi.mocked(api.getHome).mockResolvedValue(fresh(placed({ community: MULLUM })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-sky');
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(vi.mocked(api.getHome).mock.calls.map(c => c[0])).toEqual(without.reads);
        expect(vi.mocked(api.saveHomePreferences).mock.calls.length).toBe(without.saves);
    });

    it('Add a card: Sun and moon under Around you; its dialog asks whose place; Add to Home saves it and reads nothing', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(placed({ community: MULLUM, area: REYKJAVIK, withSky: false })));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        fireEvent.click(screen.getByTestId('home-add-open'));
        const around = screen.getByRole('region', { name: 'Around you' });
        expect(within(around).getByTestId('home-add-row-sky')).toHaveTextContent('Sunrise, sunset and the moon tonight.');
        fireEvent.click(screen.getByRole('button', { name: 'Add Sun and moon to Home' }));
        const dialog = await screen.findByTestId('home-settings-dialog');
        const place = within(dialog).getByTestId('home-settings-place');
        expect(within(place).getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Your community', 'true'], ['Your area', 'false']]);
        expect(within(dialog).queryByTestId('home-settings-q')).toBeNull();
        fireEvent.click(within(place).getByRole('button', { name: 'Your area' }));
        const reads = vi.mocked(api.getHome).mock.calls.length;
        fireEvent.click(within(dialog).getByTestId('home-settings-submit'));
        expect(await screen.findByTestId('home-card-sky')).toBeInTheDocument();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(cardIds()[0]).toBe('sky');
        expect(sunPart(visible())).toBe(sunPart(skyToday(REYKJAVIK, Date.now()).text));
        expect(savedLayouts().at(-1)!.cards[0]).toEqual({ id: 'sky', type: 'sky', settings: { place: 'me' } });
        expect(vi.mocked(api.getHome).mock.calls.length).toBe(reads);
        expect(screen.getByTestId('home-live')).toHaveTextContent('Sun and moon added to Home');
    });
});
