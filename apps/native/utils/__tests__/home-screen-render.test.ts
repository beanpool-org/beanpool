// @vitest-environment jsdom
/**
 * Home (app/(tabs)/index.tsx, slice H2) rendered for real at the floor's window (320 x 569 dp, text at 1.3x): react-dom
 * in jsdom, React Native's host components as plain tags carrying their accessibility props, the real home-cards,
 * home-store and node-post signing, and a stubbed community answering GET /api/home as apps/server routes/home.ts does
 * (ETag, 304) and POST /api/members/preferences. Every request is recorded.
 *
 * Nothing here draws a frame (vitest.config.ts): what is checked is the screen's tree, its words and labels, and the
 * requests it makes. The emulator check at the floor is separate (scratch/home-phone, the PR's screenshots).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', summary: 'region' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, accessibilityState, disabled, value, onValueChange, accessible } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onValueChange) attrs.onClick = () => onValueChange(!value);
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(accessibilityState.selected);
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (value !== undefined && onValueChange) attrs['aria-checked'] = String(!!value);
        if (accessible) attrs['data-accessible'] = 'true';
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    class Value { constructor(public v: number) {} setValue(v: number) { this.v = v; } interpolate() { return 0; } }
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), Switch: el('button'),
        ActivityIndicator: () => createElement('span', null, '…'),
        RefreshControl: () => null,
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        Animated: { View: el('div'), Value, timing: () => ({ start: (cb?: () => void) => cb?.() }) },
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        AccessibilityInfo: { isReduceMotionEnabled: vi.fn(async () => true), announceForAccessibility: vi.fn(), sendAccessibilityEvent: vi.fn() },
        AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
        DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({
    focus: null as null | (() => void | (() => void)),
    params: {} as Record<string, string>,
    router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), setParams: vi.fn() },
}));
vi.mock('expo-router', () => ({
    router: nav.router,
    useLocalSearchParams: () => nav.params,
    useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
    useFocusEffect: (cb: () => void | (() => void)) => {
        useEffect(() => { nav.focus = cb; return cb() ?? undefined; }, [cb]);
    },
}));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined),
}));
const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ colors: lightColors, theme: 'light' }) };
});
vi.mock('../../components/PageTitle', () => ({
    PageTitle: ({ title }: { title: string }) => createElement('h1', null, title),
    useTabRetapScrollTop: () => {},
}));
const safety = vi.hoisted(() => ({ props: null as any }));
vi.mock('../../components/OneWayBackCard', () => ({
    OneWayBackCard: (props: any) => { safety.props = props; useEffect(() => { props.onUp?.(false); }, []); return null; },
}));
vi.mock('../../components/NewPostTypeSheet', () => ({ NewPostTypeSheet: ({ visible }: { visible: boolean }) => (visible ? createElement('div', { 'data-testid': 'post-type-sheet' }) : null) }));
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: () => null }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
// The header's own landing for a Needs you line runs as it is, through to the router, so every line on Home is pressed
// to the screen it opens; only the header's component is never drawn here (nor the phone lock its admin work asks for).
vi.mock('expo-local-authentication', () => ({}));
vi.mock('../../components/NeedsYouIcons', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../components/NeedsYouIcons')>();
    return { goToNeedsTarget: vi.fn(real.goToNeedsTarget) };
});
const manage = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ start: manage.start, dialog: null }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ callsign }: { callsign: string }) => createElement('span', { 'data-avatar': callsign }) }));
vi.mock('../../components/ExampleListings', () => ({ ExampleListings: () => createElement('div', { 'data-testid': 'example-listings' }, 'Examples of what people post') }));
vi.mock('../db', () => ({ getMarketplaceTransactions: vi.fn(async () => []), getUnreadByConversation: vi.fn(async () => []) }));
vi.mock('../pulse', () => ({ resolvePulseThumbnailUrl: (u: string | null, i: { id: string }) => (u ? `${u}/api/pulse/items/${i.id}/thumbnail` : null) }));

import HomeScreen from '../../app/(tabs)/index';
import { goToNeedsTarget } from '../../components/NeedsYouIcons';
import * as db from '../db';
import { draftIdentity } from '../identity';
import { resetHomeStoreForTests } from '../home-store';
import { homeAnswerStoreKey, homeHintStoreKey, homeLayoutStoreKey } from '../storage-keys';
import { decideOnNode, mergeNeeds, type HomeAnswer } from '../home-cards';
import { decisionsOn, hiddenTabsFor } from '../node-profile';
import { commonsSectionFor } from '../commons-sections';
import { marketFilterFromLink } from '../market-filters';
import { boundSignatureValid } from './server-signature-check';
import { paramsRead, resolves, tabOf } from './route-resolve';

const NODE = 'https://mullum.beanpool.org';
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3600_000;

function localMember(): HomeAnswer {
    const now = Date.now();
    return {
        generatedAt: iso(now), profile: 'local',
        features: { beans: true, escrow: true, invites: true, exampleListings: false, decisions: true },
        me: { joinedAt: iso(now - 3 * 24 * H), isKeeper: false, probation: null, interests: [], area: null, firstOffer: false, standing: 'member' },
        layout: null,
        cards: {
            steps: { joinedAt: iso(now - 3 * 24 * H), firstOffer: false, firstPost: false, photo: false, interests: false, invited: false, area: false, knocked: null },
            events: { items: [
                { id: 'e1', title: 'Seed swap', startsAt: iso(now + 24 * H), endsAt: null, place: 'Town Hall', rsvp: null },
                { id: 'e2', title: 'Repair café', startsAt: iso(now + 5 * 24 * H), endsAt: null, place: null, rsvp: 'going' },
            ], radiusKm: null },
            market: { items: [
                { id: 'p1', type: 'offer', title: 'Sourdough', category: 'goods', credits: 12, photoUrl: '/api/photos/p1.jpg' },
                { id: 'p2', type: 'need', title: 'Help moving a couch', category: 'labour', photoUrl: null },
                { id: 'p3', type: 'offer', title: 'Garlic', category: 'food', credits: 8, photoUrl: null },
            ], total14d: 3, more: false },
            joined: { count7d: 5, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }, { callsign: 'Kofi', avatarUrl: null }] },
            pulse: { items: [{ id: 'q1', title: 'How our LETS started', thumbnailUrl: '/x', platform: 'youtube', callsign: 'River Folk Studio', category: 'education', url: null }] },
            beans: { balance: 0, room: 0, tier: 'Newcomer', activated: false, frozen: false },
            community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
        },
    };
}

const node = { answer: localMember(), status: 200, down: false, hang: false, refuse: 0, requests: [] as { url: string; method: string; headers: Record<string, string>; body: string; status: number }[] };
const etagOf = (pk: string, a: HomeAnswer) => {
    const { generatedAt: _g, ...rest } = a;
    return `W/"home-${createHash('sha256').update(`${pk}\n${JSON.stringify(rest)}`).digest('hex').slice(0, 24)}"`;
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
    mem.store.clear();
    resetHomeStoreForTests();
    nav.params = {};
    Object.values(nav.router).forEach(f => f.mockClear());
    node.answer = localMember();
    node.status = 200;
    node.down = false;
    node.hang = false;
    node.refuse = 0;
    node.requests = [];
    manage.start.mockClear();
    vi.mocked(goToNeedsTarget).mockClear();
    vi.mocked(db.getMarketplaceTransactions).mockImplementation(async () => []);
    vi.mocked(db.getUnreadByConversation).mockImplementation(async () => []);
    who.identity = await draftIdentity();
    mem.store.set('beanpool_anchor_url', NODE);
    globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
        const url = String(input);
        const headers = { ...(init.headers ?? {}) } as Record<string, string>;
        const req = { url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : '' };
        const u = new URL(url);
        const record = (status: number) => node.requests.push({ ...req, status });
        if (node.hang) return new Promise<Response>(() => {});
        if (node.down) { record(0); throw new TypeError('Network request failed'); }
        if (!boundSignatureValid(req, who.identity.publicKey)) { record(401); return new Response('{}', { status: 401 }); }
        if (u.pathname === '/api/home') {
            if (node.status !== 200) { record(node.status); return new Response('{"code":"members_only"}', { status: node.status }); }
            const tag = etagOf(who.identity.publicKey, node.answer);
            if (headers['If-None-Match'] === tag) { record(304); return new Response(null, { status: 304 }); }
            record(200);
            return new Response(JSON.stringify(node.answer), { status: 200, headers: { ETag: tag } });
        }
        if (u.pathname === '/api/members/preferences') {
            if (node.refuse) { record(node.refuse); return new Response('{"error":"Only a member of this community keeps a Home here."}', { status: node.refuse }); }
            const body = JSON.parse(req.body);
            record(200);
            return new Response(JSON.stringify({ success: true, ...body.preferences }), { status: 200 });
        }
        record(404);
        return new Response('{}', { status: 404 });
    }) as any;
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

async function settle(rounds = 10) {
    for (let i = 0; i < rounds; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

async function render() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(HomeScreen) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}

const cards = () => Array.from(document.querySelectorAll('[data-testid^="home-card-"]'))
    .map(e => e.getAttribute('data-testid')!.replace('home-card-', ''))
    .filter(id => !id.endsWith('-menu'));
const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const homeReads = () => node.requests.filter(r => new URL(r.url).pathname === '/api/home');
const marketOrder = () => Array.from(document.querySelectorAll('[data-testid^="home-market-p"]')).map(e => e.getAttribute('data-testid')!.replace('home-market-', ''));

describe('a new local member\'s first landing (§3.2 (b) day one)', () => {
    it('one request for the whole screen, and the cards in the design\'s order', async () => {
        await render();
        expect(node.requests.map(r => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /api/home']);
        expect(cards()).toEqual(['steps', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
    });

    it('each card\'s caption is a heading, and each "…" says which card it is for; Needs you and the community card have none', async () => {
        await render();
        const headings = Array.from(document.querySelectorAll('h1, [role="heading"]')).map(h => h.textContent);
        expect(headings).toEqual(expect.arrayContaining(['Home', 'First steps', 'What are you into?', 'Coming up', 'New in the Market', 'Who joined', 'The Pulse', 'Your Beans', 'Mullumbimby']));
        for (const name of ['First steps', 'What are you into?', 'Coming up', 'New in the Market', 'Who joined', 'The Pulse', 'Your Beans']) {
            expect(byLabel(`Card options for ${name}`), name).not.toBeNull();
        }
        expect(byLabel('Card options for Mullumbimby')).toBeNull();
    });

    it('each line is one target with its whole text for the screen reader, and lines are bounded', async () => {
        await render();
        expect(byLabel('Offer: Sourdough. 12 Beans. Goods. Opens the listing.')).not.toBeNull();
        expect(byLabel('Need: Help moving a couch. Labour. Opens the listing.')).not.toBeNull();
        expect(Array.from(document.querySelectorAll('[aria-label*="Repair café"]')).map(e => e.getAttribute('aria-label'))[0])
            .toMatch(/Repair café\. You're marked going\. Opens the event\./);
        expect(byLabel('0 Beans · nothing to repay. Your credit opens with a first trade. Opens your Ledger.')).not.toBeNull();
        expect(byLabel('Post your first Offer, not done yet')).not.toBeNull();
        // Row text never runs on: every line has a line limit.
        const rows = Array.from(document.querySelectorAll('[data-testid^="home-market-p"] span[data-lines]'));
        expect(rows.length).toBeGreaterThan(0);
        // The Beans card says Beans, never Ʀ; nothing is worded as an unlock.
        expect(document.body.textContent).not.toMatch(/Ʀ|unlock/i);
    });

    it('"See all", "All events", "Edit home" go where they say; a step opens its screen', async () => {
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-events-all"]') as HTMLElement).click(); });
        expect(nav.router.push).toHaveBeenCalledWith({ pathname: '/(tabs)/market', params: { filter: 'events' } });
        await act(async () => { (document.querySelector('[data-testid="home-market-all"]') as HTMLElement).click(); });
        expect(nav.router.navigate).toHaveBeenCalledWith('/(tabs)/market');
        await act(async () => { (document.querySelector('[data-testid="home-step-post-offer"]') as HTMLElement).click(); });
        expect(nav.router.push).toHaveBeenCalledWith({ pathname: '/map', params: { newPost: 'offer' } });
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(document.querySelector('[data-testid="edit-home-done"]')).not.toBeNull();
    });
});

describe('tailoring: the "…" menu, Edit home, interests', () => {
    it('Hide: the card goes at once, the layout is kept on the phone and saved to the account', async () => {
        await render();
        await act(async () => { byLabel('Card options for Coming up')!.click(); });
        expect(document.querySelector('[data-modal]')?.textContent).toContain('Hide');
        expect(byLabel('Move Coming up up')).not.toBeNull();
        expect(byLabel('Move Coming up down')).not.toBeNull();
        await act(async () => { byLabel('Hide Coming up')!.click(); });
        await settle();
        expect(cards()).not.toContain('events');
        const phone = JSON.parse(mem.store.get(homeLayoutStoreKey(who.identity.publicKey, NODE))!);
        expect(phone.hidden).toEqual(['events']);
        const post = node.requests.find(r => r.method === 'POST')!;
        expect(JSON.parse(post.body).preferences['home.layout'].hidden).toEqual(['events']);
        expect(boundSignatureValid(post, who.identity.publicKey)).toBe(true);
    });

    it('Move down: the card swaps with the one below it on screen', async () => {
        await render();
        await act(async () => { byLabel('Card options for Coming up')!.click(); });
        await act(async () => { byLabel('Move Coming up down')!.click(); });
        await settle();
        expect(cards()).toEqual(['steps', 'interests', 'market', 'events', 'joined', 'pulse', 'beans', 'community']);
    });

    it('the first movable card can\'t move up; the last can\'t move down past the community card', async () => {
        await render();
        await act(async () => { byLabel('Card options for First steps')!.click(); });
        expect(byLabel('Move First steps up')!.getAttribute('aria-disabled')).toBe('true');
        await act(async () => { byLabel('Cancel')!.click(); });
        await act(async () => { byLabel('Card options for Your Beans')!.click(); });
        expect(byLabel('Move Your Beans down')!.getAttribute('aria-disabled')).toBe('true');
    });

    it('Edit home: a hidden card comes back from its switch, and Reset puts the default back', async () => {
        await render();
        await act(async () => { byLabel('Card options for The Pulse')!.click(); });
        await act(async () => { byLabel('Hide The Pulse')!.click(); });
        await settle();
        expect(cards()).not.toContain('pulse');
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        const sw = document.querySelector('[data-testid="edit-home-pulse-switch"]') as HTMLElement;
        expect(sw.getAttribute('aria-checked')).toBe('false');
        await act(async () => { sw.click(); });
        await settle();
        expect(cards()).toContain('pulse');
        await act(async () => { (document.querySelector('[data-testid="edit-home-reset"]') as HTMLElement).click(); });
        await settle();
        expect(cards()).toEqual(['steps', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
    });

    it('a tap on an interest reorders the Market card in place, before the save lands, and saves to both copies', async () => {
        await render();
        expect(marketOrder()).toEqual(['p1', 'p2', 'p3']);
        node.hang = true; // the save never answers: the reorder must not wait on it
        await act(async () => { (document.querySelector('[data-testid="home-interest-food"]') as HTMLElement).click(); });
        await settle(3);
        expect(marketOrder()).toEqual(['p3', 'p1', 'p2']);
        expect(JSON.parse(mem.store.get('bp_fav_categories')!)).toEqual(['food']);
        // The card stays while Home is in front, so "a few" can be picked: the second star reorders again.
        expect((document.querySelector('[data-testid="home-interest-food"]') as HTMLElement).getAttribute('aria-selected')).toBe('true');
        await act(async () => { (document.querySelector('[data-testid="home-interest-labour"]') as HTMLElement).click(); });
        await settle(3);
        expect(marketOrder()).toEqual(['p2', 'p3', 'p1']);
        expect(JSON.parse(mem.store.get('bp_fav_categories')!)).toEqual(['food', 'labour']);
    });
});

describe('the cached answer, the 304, and states that never block', () => {
    it('the last answer is drawn before the network answers (a node that never answers)', async () => {
        const a = localMember();
        mem.store.set(homeAnswerStoreKey(who.identity.publicKey, NODE), JSON.stringify({
            url: NODE, publicKey: who.identity.publicKey, asked: 'needs,safety,steps,deals,enterprise,events,market,decide,groups,joined,pulse,beans,notices,community',
            etag: 'W/"home-x"', answer: a, at: Date.now() - 60_000,
        }));
        node.hang = true;
        await render();
        expect(cards()).toEqual(['steps', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
    });

    it('returning to Home revalidates with the kept tag: a 304, no body, the same cards', async () => {
        await render();
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(homeReads().map(r => r.status)).toEqual([200, 304]);
        expect(homeReads()[1].headers['If-None-Match']).toMatch(/^W\/"home-/);
        expect(cards()).toEqual(['steps', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
    });

    it('no answer and none kept: a plain sentence and Try again, the Market one tap away (never a gate)', async () => {
        node.down = true;
        await render();
        expect(document.body.textContent).toContain("Couldn't reach your community yet. Home fills in when it answers.");
        expect(document.querySelector('[data-testid="home-retry"]')).not.toBeNull();
        expect(byLabel('Open the Market')).not.toBeNull();
        node.down = false;
        await act(async () => { (document.querySelector('[data-testid="home-retry"]') as HTMLElement).click(); });
        await settle();
        expect(cards()).toContain('community');
    });

    it('the account loads after the screen did: Home reads it then, without waiting for another focus', async () => {
        const account = who.identity;
        who.identity = null;
        await render();
        expect(node.requests).toHaveLength(0);
        expect(document.body.textContent).toContain('Getting your Home…');
        who.identity = account;
        await act(async () => { root!.render(createElement(HomeScreen) as unknown as Parameters<Root['render']>[0]); });
        await settle();
        expect(homeReads()).toHaveLength(1);
        expect(cards()).toContain('community');
    });

    it('a key that is no member here: a plain sentence, nothing else asked', async () => {
        node.status = 403;
        await render();
        expect(document.body.textContent).toContain("Home shows once you're a member of this community.");
        expect(node.requests).toHaveLength(1);
    });

    it('a kept answer and the node unreachable: what we had, said plainly', async () => {
        await render();
        node.down = true;
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(document.querySelector('[data-testid="home-offline-note"]')?.textContent).toBe("Couldn't reach your community; showing what we had.");
        expect(cards()).toContain('market');
    });
});

describe('links into Home, and the "one way back" card', () => {
    it('the map\'s `/` deals link is passed on to the Market (map.tsx is left as it is)', async () => {
        nav.params = { tab: 'deals', dealsTab: 'active' };
        await render();
        expect(nav.router.navigate).toHaveBeenCalledWith({ pathname: '/(tabs)/market', params: { tab: 'deals', dealsTab: 'active' } });
        expect(nav.router.setParams).toHaveBeenCalledWith({ tab: '', dealsTab: '' });
    });

    it('the card gets the community\'s word from Home\'s own answer, and the account\'s dismissal', async () => {
        node.answer = { ...localMember(), cards: { ...localMember().cards, safety: { words: true, signInLinked: false } }, layout: { v: 1, order: [], hidden: [], dismissed: { safety: '2026-10-01T00:00:00.000Z' }, updatedAt: '2026-10-01T00:00:00.000Z' } };
        await render();
        expect(safety.props.homeWord).toEqual({ url: NODE, standing: { words: true, joinedAt: Date.parse(node.answer.me!.joinedAt!) } });
        expect(safety.props.accountDismissedAt).toBe('2026-10-01T00:00:00.000Z');
        expect(node.requests.map(r => new URL(r.url).pathname)).toEqual(['/api/home']);
    });

    it('"+ ADD POST" opens the same chooser as the Market\'s', async () => {
        await render();
        await act(async () => { byLabel('Add a post')!.click(); });
        expect(document.querySelector('[data-testid="post-type-sheet"]')).not.toBeNull();
    });
});

// ── Every line's link, on each kind of node (PR #1483 review 4165383429) ──────────────────────────────────────────────

/** A local community's switches (config/node-profile.ts): its door takes invites, never 12 words. */
const LOCAL_FEATURES = { beans: true, escrow: true, enterprises: true, invites: true, exampleListings: false, decisions: true, wordsDoor: false };
/** The global node's switches: no Beans, escrow, enterprises, invites or formal Decisions; its open door takes 12 words. */
const GLOBAL_FEATURES = { beans: false, escrow: false, enterprises: false, invites: false, exampleListings: true, decisions: false, wordsDoor: true };

/**
 * Every card with something to say, as a node of this profile sends it. The global answer also carries the money cards,
 * a Decision and a vote waiting in Needs you, which the global node never sends, so the phone's own rules are what keep
 * them off its Home. Variant 2 takes each line's other branch (one deal or several, a Decision and no poll, the Offer not
 * yet posted).
 */
function everyCard(profile: 'local' | 'global', variant: 1 | 2): HomeAnswer {
    const now = Date.now();
    const local = profile === 'local';
    const needs: NonNullable<HomeAnswer['cards']['needs']>['items'] = variant === 1
        ? [
            { kind: 'admin', count: 2, accent: false, label: '2 reports to review', target: { to: 'admin', section: 'reports' as never } },
            ...(local ? [
                { kind: 'deal' as const, count: 1, accent: true, label: 'A deal is waiting for you: Sourdough', target: { to: 'deal' as const, postId: 'p1', txId: 't1' } },
            ] : []),
            { kind: 'vote' as const, count: 1, accent: true, label: 'Vote closes in 5 hours: Compost bay', target: { to: 'decide' as const }, closesAt: iso(now + 5 * H) },
            { kind: 'message', count: 1, accent: false, label: 'Unread message from Ana', target: { to: 'chat', conversationId: 'dm1' } },
            { kind: 'group', count: 1, accent: false, label: 'New in Garden Group', target: { to: 'chat', conversationId: 'g1', thread: 'group' } },
        ]
        : [
            ...(local ? [{ kind: 'deal' as const, count: 2, accent: true, label: '2 deals waiting for you', target: { to: 'my-deals' as const } }] : []),
            { kind: 'message', count: 2, accent: false, label: 'Unread messages from 2 people', target: { to: 'unread-messages' } },
            { kind: 'group', count: 3, accent: false, label: 'New in 3 groups', target: { to: 'your-groups' } },
        ];
    return {
        generatedAt: iso(now), profile,
        features: local ? LOCAL_FEATURES : GLOBAL_FEATURES,
        me: { joinedAt: iso(now - 3 * 24 * H), isKeeper: true, probation: null, interests: ['food'], area: null, firstOffer: variant === 1, standing: 'member' },
        layout: null,
        cards: {
            needs: { items: needs },
            steps: { joinedAt: iso(now - 3 * 24 * H), firstOffer: variant === 1, firstPost: variant === 1, photo: false, interests: false, invited: false, area: false, knocked: null },
            deals: { open: 2, waiting: 1, waitingOnMe: variant === 1 ? { txId: 't1', postId: 'p1', title: 'Sourdough' } : null },
            enterprise: { id: 'ent1', name: 'Tool Library', requests: 1, others: 0 },
            events: { items: [{ id: 'e1', title: 'Seed swap', startsAt: iso(now + 24 * H), endsAt: null, place: 'Town Hall', rsvp: null }], radiusKm: local ? null : 50 },
            market: { items: [{ id: 'p1', type: 'offer', title: 'Sourdough', category: 'food', credits: 12, photoUrl: null }], total14d: 1, more: false, ...(local ? {} : { examples: true as const }) },
            decide: variant === 1
                ? { open: local ? 1 : 0, soonestClosesAt: local ? iso(now + 30 * H) : null, polls: 2, pollsMore: false }
                : { open: 1, soonestClosesAt: iso(now + 30 * H), polls: 0, pollsMore: false },
            groups: { items: [
                { id: 'g1', kind: 'group', name: 'Garden Group', unread: 4, muted: false },
                { id: 'ent1', kind: 'enterprise', name: 'Tool Library', unread: 0, muted: false },
                { id: 'ev1', kind: 'event', name: 'Seed swap', unread: 1, muted: false },
            ], total: 5 },
            joined: local ? { count7d: 3, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }] } : { count7d: 14, radiusKm: 50 },
            pulse: { items: [{ id: 'q1', title: 'How our LETS started', thumbnailUrl: null, platform: 'youtube', callsign: 'River Folk Studio', category: 'education', url: null }] },
            beans: { balance: -35, room: 165, tier: 'Resident', activated: true, frozen: false },
            notices: { unseen: 1, first: { id: 'n1', title: 'Market day moved', line: 'Saturday, not Sunday.' } },
            community: local ? { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 } : { name: 'BeanPool', members: 2310, communities: 38 },
        },
    };
}

type Link = { card: string; control: string; href: { pathname: string; params?: Record<string, string> } };

/**
 * Press every control on Home, top to bottom, and note where each one went: a screen (`router.push`/`navigate`, Needs
 * you through the header's own landing), or nowhere (it acts in place: "…", Edit home, Tune, a chip, a notice, the
 * admin work).
 */
async function pressEverything(): Promise<{ links: Link[]; inPlace: string[] }> {
    const controls = Array.from(document.querySelectorAll('[data-testid="home-scroll"] button')).map(b => ({
        card: (b.closest('[data-testid^="home-card-"]')?.getAttribute('data-testid') ?? '').replace('home-card-', ''),
        key: b.getAttribute('data-testid') ?? b.getAttribute('aria-label') ?? '',
    }));
    const links: Link[] = [];
    const inPlace: string[] = [];
    for (const c of controls) {
        const el = Array.from(document.querySelectorAll('[data-testid="home-scroll"] button'))
            .find(b => (b.getAttribute('data-testid') ?? b.getAttribute('aria-label')) === c.key) as HTMLElement | undefined;
        if (!el) continue;
        Object.values(nav.router).forEach(f => f.mockClear());
        await act(async () => { el.click(); });
        await settle(2);
        const went = [nav.router.push, nav.router.navigate, nav.router.replace].flatMap(f => f.mock.calls.map(([to]) => (typeof to === 'string' ? { pathname: to } : to)));
        if (went.length) went.forEach(href => links.push({ card: c.card, control: c.key, href }));
        else inPlace.push(c.key);
        await act(async () => { byLabel('Cancel')?.click(); });
    }
    return { links, inPlace };
}

async function linksOn(profile: 'local' | 'global', variant: 1 | 2) {
    node.answer = everyCard(profile, variant);
    // Each line's own target, whatever the phone's database says: the node's lines are the ones drawn.
    vi.mocked(db.getMarketplaceTransactions).mockRejectedValue(new Error('no database here'));
    vi.mocked(db.getUnreadByConversation).mockRejectedValue(new Error('no database here'));
    mem.store.set(homeHintStoreKey(who.identity.publicKey), '1');
    await render();
    return { answer: node.answer, ...(await pressEverything()) };
}

const fmt = (l: Link) => `${l.control} → ${l.href.pathname}${l.href.params && Object.keys(l.href.params).length ? ` ${Object.entries(l.href.params).map(([k, v]) => `${k}=${v}`).join('&')}` : ''}`;

/** What each line leads to, on each kind of node: the table the review asked for, every row pressed on the real screen. */
const TABLE: Record<'local' | 'global', Record<1 | 2, string[]>> = {
    local: {
        1: [
            'home-needs-deal → /post/[id] id=p1&txId=t1',
            'home-needs-vote → /(tabs)/projects section=decide',
            'home-needs-message → /chat/[id] id=dm1',
            'home-needs-group → /chat/[id] id=g1&group=1',
            'home-step-photo → /(tabs)/settings section=profile',
            'home-step-invite → /(tabs)/people view=invites',
            'home-deals-line → /post/[id] id=p1&txId=t1',
            'home-enterprise-line → /treasury-detail publicKey=ent1&name=Tool Library',
            'home-event-e1 → /post/[id] id=e1',
            'home-events-all → /(tabs)/market filter=events',
            'home-market-p1 → /post/[id] id=p1',
            'home-market-all → /(tabs)/market',
            'home-decide-decisions → /(tabs)/projects section=decide',
            'home-decide-polls → /(tabs)/market filter=polls',
            'home-group-g1 → /chat/[id] id=g1&group=1',
            'home-group-ent1 → /chat/[id] id=ent1&enterprise=1',
            'home-group-ev1 → /chat/[id] id=ev1&event=1',
            'home-groups-all → /(tabs)/chats view=groups',
            'home-joined-line → /(tabs)/people',
            'home-pulse-q1 → /(tabs)/pulse',
            'home-pulse-all → /(tabs)/pulse',
            'home-beans-line → /(tabs)/ledger',
            'home-invite → /(tabs)/people view=invites',
        ],
        2: [
            'home-needs-deal → /(tabs)/market tab=deals',
            'home-needs-message → /(tabs)/chats view=messages&filter=unread',
            'home-needs-group → /(tabs)/chats view=groups',
            'home-step-offer → /map newPost=offer',
            'home-step-photo → /(tabs)/settings section=profile',
            'home-step-post-offer → /map newPost=offer',
            'home-deals-line → /(tabs)/market tab=deals',
            'home-enterprise-line → /treasury-detail publicKey=ent1&name=Tool Library',
            'home-event-e1 → /post/[id] id=e1',
            'home-events-all → /(tabs)/market filter=events',
            'home-market-p1 → /post/[id] id=p1',
            'home-market-all → /(tabs)/market',
            'home-decide-decisions → /(tabs)/projects section=decide',
            'home-group-g1 → /chat/[id] id=g1&group=1',
            'home-group-ent1 → /chat/[id] id=ent1&enterprise=1',
            'home-group-ev1 → /chat/[id] id=ev1&event=1',
            'home-groups-all → /(tabs)/chats view=groups',
            'home-joined-line → /(tabs)/people',
            'home-pulse-q1 → /(tabs)/pulse',
            'home-pulse-all → /(tabs)/pulse',
            'home-beans-line → /(tabs)/ledger',
        ],
    },
    // No First steps (its global words are H4's), no money cards and no invite whatever the answer holds, no Decisions
    // and no vote in Needs you (Commons is hidden there): the Decide card is polls only, and they open the Market's Polls.
    global: {
        1: [
            'home-needs-message → /chat/[id] id=dm1',
            'home-needs-group → /chat/[id] id=g1&group=1',
            'home-event-e1 → /post/[id] id=e1',
            'home-events-all → /(tabs)/market filter=events',
            'home-market-p1 → /post/[id] id=p1',
            'home-market-all → /(tabs)/market',
            'home-decide-polls → /(tabs)/market filter=polls',
            'home-group-g1 → /chat/[id] id=g1&group=1',
            'home-group-ent1 → /chat/[id] id=ent1&enterprise=1',
            'home-group-ev1 → /chat/[id] id=ev1&event=1',
            'home-groups-all → /(tabs)/chats view=groups',
            'home-pulse-q1 → /(tabs)/pulse',
            'home-pulse-all → /(tabs)/pulse',
        ],
        2: [
            'home-needs-message → /(tabs)/chats view=messages&filter=unread',
            'home-needs-group → /(tabs)/chats view=groups',
            'home-event-e1 → /post/[id] id=e1',
            'home-events-all → /(tabs)/market filter=events',
            'home-market-p1 → /post/[id] id=p1',
            'home-market-all → /(tabs)/market',
            'home-group-g1 → /chat/[id] id=g1&group=1',
            'home-group-ent1 → /chat/[id] id=ent1&enterprise=1',
            'home-group-ev1 → /chat/[id] id=ev1&event=1',
            'home-groups-all → /(tabs)/chats view=groups',
            'home-pulse-q1 → /(tabs)/pulse',
            'home-pulse-all → /(tabs)/pulse',
        ],
    },
};

/** Controls that act on Home itself rather than open a screen. */
const IN_PLACE = /^(home-card-[a-z]+-menu|home-edit|home-market-tune|home-notice-line|home-needs-admin|home-step-interests|home-interest-[a-z]+)$/;

/** Ids a link passes as they are; every other param's value must be one its screen names. */
const FREE_PARAMS = new Set(['id', 'txId', 'publicKey', 'name']);

/** Why a link is wrong on this node, or null: it must land on a screen this node shows, which reads what it is given and shows what the line names. */
function wrongOn(features: HomeAnswer['features'], l: Link): string | null {
    const file = resolves(l.href.pathname);
    if (!file) return 'no such screen';
    const tab = tabOf(l.href.pathname);
    if (tab && (hiddenTabsFor(features) as string[]).includes(tab)) return `the ${tab} tab, which this node hides`;
    const params = l.href.params ?? {};
    const read = paramsRead(file);
    for (const k of Object.keys(params)) if (!read.has(k)) return `${k}, which its screen never reads`;
    if (tab === 'projects' && params.section && commonsSectionFor(params.section, features) !== params.section) {
        return `Commons → ${params.section}, which this node shows as ${commonsSectionFor(params.section, features)}`;
    }
    if (tab === 'market' && params.filter && marketFilterFromLink(params.filter) !== params.filter) return `the Market's ${params.filter}, which it doesn't take`;
    const text = (fs.readFileSync(file, 'utf-8'));
    for (const [k, v] of Object.entries(params)) {
        if (FREE_PARAMS.has(k) || v === '1' || (tab === 'projects' && k === 'section') || (tab === 'market' && k === 'filter')) continue;
        if (!text.includes(`'${v}'`)) return `${k}=${v}, which its screen never names`;
    }
    return null;
}

describe('every line on Home opens a screen this node shows, with what the line names (PR #1483 review 4165383429)', () => {
    for (const profile of ['local', 'global'] as const) {
        for (const variant of [1, 2] as const) {
            it(`${profile} node, case ${variant}: the table, and every row checked`, async () => {
                const { answer, links, inPlace } = await linksOn(profile, variant);
                expect(links.map(fmt)).toEqual(TABLE[profile][variant]);
                expect(links.map(l => [fmt(l), wrongOn(answer.features, l)]).filter(([, why]) => why)).toEqual([]);
                expect(inPlace.filter(k => !IN_PLACE.test(k))).toEqual([]);
            });
        }
    }

    it('a poll on the global node: the line says where it goes, and goes there; never to Commons, which global hides', async () => {
        await linksOn('global', 1);
        expect(byLabel('2 polls open. Opens the polls, in the Market.')).not.toBeNull();
        expect(document.querySelector('[data-testid="home-decide-decisions"]')).toBeNull();
        expect((hiddenTabsFor(GLOBAL_FEATURES) as string[])).toContain('projects');
        expect(marketFilterFromLink('polls')).toBe('polls');
        // The check is not passing on nothing: the link this card had before is wrong on both kinds of node.
        const before: Link = { card: 'decide', control: 'home-decide-line', href: { pathname: '/(tabs)/projects', params: { section: 'decide' } } };
        expect(wrongOn(GLOBAL_FEATURES, before)).toBe('the projects tab, which this node hides');
        expect(wrongOn({ ...LOCAL_FEATURES, beans: true, decisions: false }, before)).toBe('Commons → decide, which this node shows as enterprises');
        expect(wrongOn(LOCAL_FEATURES, { ...before, href: { pathname: '/(tabs)/market', params: { filter: 'nope' } } })).toBe("the Market's nope, which it doesn't take");
        expect(wrongOn(LOCAL_FEATURES, { ...before, href: { pathname: '/(tabs)/people', params: { mode: 'x' } } })).toBe('mode, which its screen never reads');
        // The Market opens on its Polls pill from that link (app/(tabs)/market.tsx), as it does on Events for "All events".
        const market = fs.readFileSync(path.join(__dirname, '../../app/(tabs)/market.tsx'), 'utf-8');
        expect(market).toMatch(/const pill = marketFilterFromLink\(params\.filter\);\s*if \(pill\) \{\s*selectType\(pill\);/);
    });

    it('a poll and no Decision on a local node: the polls line opens the Market\'s polls, not Decide (which lists Decisions only)', async () => {
        node.answer = { ...localMember(), cards: { ...localMember().cards, decide: { open: 0, soonestClosesAt: null, polls: 1, pollsMore: false } } };
        mem.store.set(homeHintStoreKey(who.identity.publicKey), '1');
        await render();
        await act(async () => { byLabel('1 poll open. Opens the polls, in the Market.')!.click(); });
        expect(nav.router.push).toHaveBeenCalledWith({ pathname: '/(tabs)/market', params: { filter: 'polls' } });
        expect(nav.router.push).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: '/(tabs)/projects' }));
    });

    it('Home\'s rule for Commons → Decide is the tab strip\'s and Commons\' own, on every mix of switches', () => {
        for (const beans of [true, false, undefined]) {
            for (const decisions of [true, false, undefined]) {
                const f = { beans, decisions };
                expect(decideOnNode(f)).toBe(decisionsOn(f) && !(hiddenTabsFor(f) as string[]).includes('projects'));
            }
        }
    });

    it('a vote line the node sends where Commons → Decide isn\'t there is left out, on Home and in the header alike (both merge the same way)', () => {
        const vote = { kind: 'vote' as const, count: 1, accent: true, label: 'Vote closes in 5 hours: Compost bay', target: { to: 'decide' as const } };
        const dm = { kind: 'message' as const, count: 1, accent: false, label: 'Unread message from Ana', target: { to: 'chat' as const, conversationId: 'dm1' } };
        expect(mergeNeeds([vote, dm], null, Date.now(), GLOBAL_FEATURES).map(e => e.kind)).toEqual(['message']);
        expect(mergeNeeds([vote, dm], null, Date.now(), LOCAL_FEATURES).map(e => e.kind)).toEqual(['vote', 'message']);
        const header = fs.readFileSync(path.join(__dirname, '../../components/NeedsYouIcons.tsx'), 'utf-8');
        expect(header).toMatch(/mergeNeeds\(home\.current\.items, [^;]*, home\.current\.features\)/);
    });

    it('the "one way back" card\'s own link (drawn by OneWayBackCard) opens Settings, which no node hides, on a section it opens', () => {
        const card = fs.readFileSync(path.join(__dirname, '../../components/OneWayBackCard.tsx'), 'utf-8');
        const pushes = [...card.matchAll(/router\.push\(\{ pathname: '([^']+)', params: \{ section: '([^']+)' \} \}\)/g)];
        expect(pushes.map(m => `${m[1]} ${m[2]}`)).toEqual(['/(tabs)/settings protection']);
        for (const features of [LOCAL_FEATURES, GLOBAL_FEATURES]) {
            expect(wrongOn(features, { card: 'safety', control: 'one-way-back', href: { pathname: pushes[0][1], params: { section: pushes[0][2] } } })).toBeNull();
        }
    });
});

// ── A visitor tailors nothing; a refused save is not sent again (PR #1483 review 4165383753) ─────────────────────────

/** The global node's answer to a key with no account there (routes/home.ts): the public cards, `welcome`, no `me`. */
function visitorAnswer(): HomeAnswer {
    const now = Date.now();
    return {
        generatedAt: iso(now), profile: 'global', features: GLOBAL_FEATURES, welcome: true, me: null, layout: null,
        cards: {
            events: { items: [{ id: 'e1', title: 'Beach clean', startsAt: iso(now + 24 * H), endsAt: null, place: null, rsvp: null }], radiusKm: 50 },
            market: { items: [{ id: 'p1', type: 'offer', title: 'Seedlings to give away', category: 'garden', photoUrl: null, distanceKm: 3 }], total14d: 1, more: false, examples: true },
            community: { name: 'BeanPool', members: 2310, communities: 38 },
        },
    };
}

describe('a visitor on the global node: its public cards, nothing to tailor, nothing sent', () => {
    it('no "…", no Edit home, no hint, no Tune; a layout the phone has is neither drawn nor sent, read after read', async () => {
        node.answer = visitorAnswer();
        node.refuse = 400; // as the node refuses a Home save from a key that is no member there
        mem.store.set(homeLayoutStoreKey(who.identity.publicKey, NODE), JSON.stringify({ v: 1, order: [], hidden: ['events'], dismissed: {}, updatedAt: new Date().toISOString() }));
        await render();
        expect(cards()).toEqual(['events', 'market', 'community']);
        expect(document.querySelectorAll('[aria-label^="Card options for"]')).toHaveLength(0);
        expect(document.querySelector('[data-testid="home-edit"]')).toBeNull();
        expect(document.querySelector('[data-testid="home-hint"]')).toBeNull();
        expect(document.body.textContent).not.toContain('This is your Home');
        expect(document.querySelector('[data-testid="home-market-tune"]')).toBeNull();
        for (let i = 0; i < 3; i++) {
            await act(async () => { nav.focus?.(); });
            await settle();
        }
        expect(node.requests.filter(r => r.method === 'POST')).toEqual([]);
        expect(homeReads()).toHaveLength(4);
    });
});

describe('a layout save the node refuses is not sent again at every read', () => {
    it('the account\'s copy stands: drawn, kept on the phone, and the next reads send nothing', async () => {
        node.refuse = 400;
        mem.store.set(homeLayoutStoreKey(who.identity.publicKey, NODE), JSON.stringify({ v: 1, order: [], hidden: ['pulse'], dismissed: {}, updatedAt: new Date().toISOString() }));
        await render();
        expect(node.requests.filter(r => r.method === 'POST')).toHaveLength(1);
        for (let i = 0; i < 3; i++) {
            await act(async () => { nav.focus?.(); });
            await settle();
        }
        expect(node.requests.filter(r => r.method === 'POST')).toHaveLength(1);
        expect(cards()).toContain('pulse');
        expect(mem.store.get(homeLayoutStoreKey(who.identity.publicKey, NODE))).toBeUndefined();
    });
});

// ── Edit home offers only what this node can show (PR #1483 review 4165384151) ─────────────────────────────────────────

const editRows = () => Array.from(document.querySelectorAll('[data-testid^="edit-home-"]'))
    .map(e => e.getAttribute('data-testid')!.replace('edit-home-', ''))
    .filter(id => !/-(up|down|switch)$/.test(id) && id !== 'done' && id !== 'reset');

describe('Edit home offers only the cards this node can show', () => {
    it('the global node: no Your deals, Your enterprise, Your Beans, Grow your community, or First steps (H4)', async () => {
        node.answer = everyCard('global', 1);
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(editRows()).toEqual(['safety', 'interests', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'notices']);
        expect(document.body.textContent).not.toMatch(/Your deals|Your enterprise|Your Beans|Grow your community/);
    });

    it('a local community with Beans, escrow, enterprises and invites: every card but Find your community (H4) and "Your way back in" (no 12-words door)', async () => {
        node.answer = everyCard('local', 1);
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(editRows()).toEqual(['steps', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'beans', 'notices', 'invite']);
        expect(document.body.textContent).not.toContain('Your way back in');
    });

    it('a node whose 12-words door has shut still draws and offers the "Your way back in" it sends a member who came in by it', async () => {
        const a = everyCard('global', 1);
        node.answer = { ...a, features: { ...GLOBAL_FEATURES, wordsDoor: false }, cards: { ...a.cards, safety: { words: true, signInLinked: false } } };
        await render();
        // The card is drawn by OneWayBackCard, which decides when it is up: it is given the node's word.
        expect(safety.props.homeWord).toEqual({ url: NODE, standing: { words: true, joinedAt: Date.parse(a.me!.joinedAt!) } });
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(editRows()[0]).toBe('safety');
    });
});
