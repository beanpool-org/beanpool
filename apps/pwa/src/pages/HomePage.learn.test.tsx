/**
 * Learn something local on the web's Home (DESIGN-local-knowledge-amend-fable.md §3.6, slice K7), the phone's card in the web's
 * frame: the day's pages in Learn's row card (each opening its page in Learn, the newest led by NEW), "See all ›" spoken "See
 * all of Learn", the card arriving once on a Home its member already arranged (after their own cards; Keep on Home and Remove
 * each saving its stamp, nothing saved by itself), no card for a member with nothing to show, and the community card's
 * "{n} things worth knowing ›" opening Learn. The node is lib/api.ts mocked, as in HomePage.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { HomeAnswer, HomeLayoutV2 } from '../lib/home-cards';
import type { HomeRead } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

const hooks = vi.hoisted(() => ({ sync: [] as Array<() => unknown>, open: [] as Array<() => void>, announce: [] as Array<(a: unknown) => void> }));

vi.mock('../lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    getHome: vi.fn(),
    // This file saves version-2 lists only (the v2() layouts below).
    saveHomePreferences: vi.fn(async (_pk: string, prefs: { 'home.layout'?: HomeLayoutV2; interests?: string[] }) => ({ success: true, ...prefs })),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 1 })),
    getCommunityMe: vi.fn(async () => ({ probation: { rules: 'ordinary', keptPosts: 0, ageEndsAt: null } })),
    // The reader's role, asked only for Welcome's "Invite someone ›" where only admins invite (core readerMayInvite).
    myNodeRoleOnce: vi.fn(async () => null),
    // A chosen chat's list (read as its settings open) and the group keys' transport (never called by the card: no read).
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getYourGroups: vi.fn(async () => ({ items: [] })),
    groupKeysNet: { get: vi.fn(async () => { throw new Error('the chat card never reads keys'); }), post: vi.fn(async () => { throw new Error('the chat card never reads keys'); }) },
}));
// The shared town search (components/AddressSearch.tsx over @beanpool/core createAddressLookup), stood in for by one
// match: what is tested here is where a picked town goes, never OpenStreetMap.
vi.mock('../components/AddressSearch', () => ({
    AddressSearch: ({ onPick, words }: { onPick: (r: unknown) => void; words?: { label: string } }) => (
        <button type="button" data-testid="town-search" aria-label={words?.label}
            onClick={() => onPick({ lat: -28.8135, lng: 153.2773, displayName: 'Lismore, New South Wales, Australia', shortName: 'Lismore' })}>
            pick Lismore
        </button>
    ),
}));
// The community's price guide the starter dialog reads as it opens (slice O2): stood in for, so a test says what the guide holds.
vi.mock('../lib/starter-offers', () => ({ readPricingGuide: vi.fn(async () => null) }));
vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn((cb: () => unknown) => { hooks.sync.push(cb); return () => { hooks.sync = hooks.sync.filter(c => c !== cb); }; }),
    onSocketOpen: vi.fn((cb: () => void) => { hooks.open.push(cb); return () => { hooks.open = hooks.open.filter(c => c !== cb); }; }),
    onSystemAnnouncement: vi.fn((cb: (a: unknown) => void) => { hooks.announce.push(cb); return () => { hooks.announce = hooks.announce.filter(c => c !== cb); }; }),
}));


import * as api from '../lib/api';
import { HomePage } from './HomePage';
import { cardsToAsk } from '../lib/home-layout';
import { resetHomeCacheForTest } from '../lib/home-cache';
import { resetAccountEpochForTest } from '../lib/account-epoch';

const ME: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const NOW = new Date().toISOString();
const AT = '2026-11-01T00:00:00.000Z';
const TOUR_ENDED = { v: 1 as const, state: 'skipped' as const, at: '2026-10-01T00:00:00.000Z' };
const row = (id: string, title: string, isNew?: true) => ({
    id, title, line: 'The first line of the page.', topic: 'services', photo: null, checkedAt: NOW, helped: 2, pinned: false, outdated: false, ...(isNew ? { isNew } : {}),
});
const THREE = [row('k-tip', 'How recycling works at the tip', true), row('k-bins', 'Bins day'), row('k-water', 'Water restrictions')];
const v2 = (types: string[], dismissed: Record<string, string> = {}) => ({ v: 2, cards: types.map(t => ({ id: t, type: t })), dismissed, updatedAt: AT });

function answer(cards: HomeAnswer['cards'] = {}, knowledge = true): HomeAnswer {
    return {
        generatedAt: NOW, profile: 'local',
        features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false, knowledge },
        me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: ['arts'], area: null, firstOffer: false, standing: 'member', tour: TOUR_ENDED },
        layout: null,
        cards: {
            market: { items: [{ id: 'p1', type: 'offer', title: 'Pottery lessons', category: 'arts', price_c: 2000, photoUrl: null }], total14d: 1, more: false },
            beans: { balance_c: 1200, room_c: 20000, tier: 'Resident', activated: true, frozen: false },
            community: { name: 'Riverside', members: 81, tradesThisMonth: 23, knowledge: 6 },
            learn: { rows: THREE },
            ...cards,
        },
    } as HomeAnswer;
}
const fresh = (a: HomeAnswer): HomeRead => ({ notModified: false, answer: a, etag: 'W/"home-test"' });
type Layout = ReturnType<typeof v2>;
/** A node from after the frame: it keeps the newer version-2 list and answers it, building only the cards asked for. */
function nodeV2(full: HomeAnswer, start: Layout | null) {
    let account: Layout | null = start;
    vi.mocked(api.saveHomePreferences).mockImplementation(async (_pk, prefs) => {
        const l = prefs['home.layout'] as unknown as Layout | undefined;
        if (l && (!account || Date.parse(l.updatedAt!) >= Date.parse(account.updatedAt!))) account = l;
        return { success: true, ...(l ? { 'home.layout': account } : {}) } as never;
    });
    vi.mocked(api.getHome).mockImplementation(async (params = {}) => {
        const asked = params.cards ? [...params.cards] : Object.keys(full.cards);
        const cards = Object.fromEntries(Object.entries(full.cards).filter(([id]) => asked.includes(id)));
        return fresh({ ...full, layout: account as never, cards });
    });
    return { account: () => account };
}
const cardIds = () => Array.from(document.querySelectorAll('[data-testid^="home-card-"]')).map(e => e.getAttribute('data-testid')!.replace('home-card-', '')).filter(id => id !== 'menu');
const savedLayouts = () => vi.mocked(api.saveHomePreferences).mock.calls.map(c => c[1]['home.layout'] as unknown as Layout).filter(Boolean);

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetHomeCacheForTest();
    localStorage.clear();
    resetAccountEpochForTest();
    vi.mocked(api.getHome).mockReset();
    vi.mocked(api.saveHomePreferences).mockReset().mockImplementation(async (_pk, prefs) => ({ success: true, ...prefs }) as never);
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('the Learn card on an arranged Home', () => {
    it('arrives once, after the member\'s own cards; asked of the node; nothing saved by itself', async () => {
        nodeV2(answer(), v2(['market', 'beans']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-learn');
        expect(cardIds()).toEqual(['market', 'beans', 'learn', 'community']);
        // Asked of the node by name (cards=) on every read made from the list, so the node builds it though the list lacks it.
        expect(cardsToAsk(v2(['market', 'beans']) as never)).toContain('learn');
        expect(within(screen.getByTestId('home-card-learn')).getByTestId('home-learn-keep')).toHaveTextContent('Keep on Home');
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it('its rows open their page in Learn, the newest led by NEW; See all opens Learn, spoken "See all of Learn"', async () => {
        nodeV2(answer(), v2(['market', 'learn']));
        const nav = vi.fn();
        render(<HomePage identity={ME} onNavigate={nav} />);
        const card = await screen.findByTestId('home-card-learn');
        expect(within(card).getByTestId('home-learn-k-tip')).toHaveTextContent('NEW');
        expect(within(card).getByTestId('home-learn-k-bins')).not.toHaveTextContent('NEW');
        expect(within(card).getByTestId('home-learn-k-bins')).toHaveTextContent('Bins day');
        fireEvent.click(within(card).getByTestId('home-learn-k-bins'));
        expect(nav).toHaveBeenLastCalledWith('learn-page', 'k-bins');
        const all = within(card).getByTestId('home-learn-all');
        expect(all).toHaveTextContent('See all ›');
        expect(all).toHaveAttribute('aria-label', 'See all of Learn');
        fireEvent.click(all);
        expect(nav).toHaveBeenLastCalledWith('learn');
        // On the list already: no Keep on Home, and it stands where the member put it.
        expect(within(card).queryByTestId('home-learn-keep')).toBeNull();
        expect(cardIds()).toEqual(['market', 'learn', 'community']);
        // Neither owner row: the node sent neither (a member).
        expect(within(card).queryByTestId('home-learn-check')).toBeNull();
        expect(within(card).queryByTestId('home-learn-first')).toBeNull();
    });

    it('an owner\'s or admin\'s rows (slice K4): "2 to check ›" opens To check; "Add the first thing…" opens the form', async () => {
        nodeV2(answer({ learn: { rows: THREE, toCheck: 2 } }), v2(['market', 'learn']));
        const nav = vi.fn();
        render(<HomePage identity={ME} onNavigate={nav} />);
        const card = await screen.findByTestId('home-card-learn');
        const check = within(card).getByTestId('home-learn-check');
        expect(check).toHaveTextContent('2 to check ›');
        fireEvent.click(check);
        expect(nav).toHaveBeenLastCalledWith('learn-check');
        cleanup();
        nodeV2(answer({ learn: { rows: [], first: true } }), v2(['market', 'learn']));
        render(<HomePage identity={ME} onNavigate={nav} />);
        const first = within(await screen.findByTestId('home-card-learn')).getByTestId('home-learn-first');
        expect(first).toHaveTextContent('Add the first thing worth knowing about Riverside');
        fireEvent.click(first);
        expect(nav).toHaveBeenLastCalledWith('learn-suggest');
    });

    it('Keep on Home saves it last on the list with its stamp, in one save', async () => {
        const node = nodeV2(answer(), v2(['market', 'beans']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-learn');
        fireEvent.click(within(card).getByTestId('home-learn-keep'));
        await waitFor(() => expect(savedLayouts()).toHaveLength(1));
        expect(savedLayouts()[0].cards.map(c => c.id)).toEqual(['market', 'beans', 'learn']);
        expect(Object.keys(savedLayouts()[0].dismissed)).toEqual(['new:learn']);
        await waitFor(() => expect(within(screen.getByTestId('home-card-learn')).queryByTestId('home-learn-keep')).toBeNull());
        expect(node.account()!.cards.map(c => c.id)).toEqual(['market', 'beans', 'learn']);
    });

    it('Remove writes its stamp alone: the list as it was, and the card gone for good', async () => {
        nodeV2(answer(), v2(['market', 'beans']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-card-learn');
        fireEvent.click(within(card).getByTestId('home-card-menu'));
        fireEvent.click(within(card).getByTestId('home-menu-remove'));
        await waitFor(() => expect(savedLayouts()).toHaveLength(1));
        expect(savedLayouts()[0].cards.map(c => c.id)).toEqual(['market', 'beans']);
        expect(Object.keys(savedLayouts()[0].dismissed)).toEqual(['new:learn']);
        await waitFor(() => expect(screen.queryByTestId('home-card-learn')).toBeNull());
    });

    it('stamped: never again; a member with nothing to show gets no card, and Arrange\'s strip doesn\'t list it', async () => {
        nodeV2(answer(), v2(['market', 'beans'], { 'new:learn': AT }));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(cardIds()).not.toContain('learn');
        cleanup();
        nodeV2(answer({ learn: { rows: [] } }), v2(['market', 'beans']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');
        expect(cardIds()).not.toContain('learn');
        fireEvent.click(screen.getByTestId('home-arrange-open'));
        expect(screen.queryByText('Learn something local')).toBeNull();
    });

    it('in Arrange, ↓ on the card above it moves that card under it: Learn kept first with its stamp, in one save, and said', async () => {
        const node = nodeV2(answer(), v2(['market', 'beans']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-learn');
        fireEvent.click(screen.getByTestId('home-arrange-open'));
        // Learn is among the cards that move, so the card above it has a ↓ that is on, and it does what it shows.
        const down = await screen.findByTestId('home-arrange-down-beans');
        expect(down).not.toBeDisabled();
        fireEvent.click(down);
        await waitFor(() => expect(savedLayouts()).toHaveLength(1));
        expect(savedLayouts()[0].cards.map(c => c.id)).toEqual(['market', 'learn', 'beans']);
        expect(Object.keys(savedLayouts()[0].dismissed)).toEqual(['new:learn']);
        await waitFor(() => expect(cardIds()).toEqual(['market', 'learn', 'beans', 'community']));
        expect(screen.getByTestId('home-live').textContent).toMatch(/ moved to 3 of 3$/);
        expect(node.account()!.cards.map(c => c.id)).toEqual(['market', 'learn', 'beans']);
    });
});

describe('"{n} things worth knowing" on the community card', () => {
    it('opens Learn, from 1; absent where the node left it out', async () => {
        nodeV2(answer(), v2(['market']));
        const nav = vi.fn();
        render(<HomePage identity={ME} onNavigate={nav} />);
        const figure = await screen.findByTestId('home-community-learn');
        expect(figure).toHaveTextContent('6 things worth knowing');
        fireEvent.click(figure);
        expect(nav).toHaveBeenLastCalledWith('learn');
        cleanup();
        nodeV2(answer({ community: { name: 'Riverside', members: 81, tradesThisMonth: 23, knowledge: 1 } }), v2(['market']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('home-community-learn')).toHaveTextContent('1 thing worth knowing');
        cleanup();
        nodeV2(answer({ community: { name: 'Riverside', members: 81, tradesThisMonth: 23 } }), v2(['market']));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-community');
        expect(screen.queryByTestId('home-community-learn')).toBeNull();
    });
});
