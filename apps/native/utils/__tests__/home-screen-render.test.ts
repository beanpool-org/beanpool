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
vi.mock('../../components/NeedsYouIcons', () => ({ goToNeedsTarget: vi.fn() }));
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ start: vi.fn(), dialog: null }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ callsign }: { callsign: string }) => createElement('span', { 'data-avatar': callsign }) }));
vi.mock('../../components/ExampleListings', () => ({ ExampleListings: () => createElement('div', { 'data-testid': 'example-listings' }, 'Examples of what people post') }));
vi.mock('../db', () => ({ getMarketplaceTransactions: vi.fn(async () => []), getUnreadByConversation: vi.fn(async () => []) }));
vi.mock('../pulse', () => ({ resolvePulseThumbnailUrl: (u: string | null, i: { id: string }) => (u ? `${u}/api/pulse/items/${i.id}/thumbnail` : null) }));

import HomeScreen from '../../app/(tabs)/index';
import { draftIdentity } from '../identity';
import { resetHomeStoreForTests } from '../home-store';
import { homeAnswerStoreKey, homeLayoutStoreKey } from '../storage-keys';
import type { HomeAnswer } from '../home-cards';
import { boundSignatureValid } from './server-signature-check';

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

const node = { answer: localMember(), status: 200, down: false, hang: false, requests: [] as { url: string; method: string; headers: Record<string, string>; body: string; status: number }[] };
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
    node.requests = [];
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
