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
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, accessibilityState, disabled, value, onValueChange, onChangeText, accessible } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onValueChange) attrs.onClick = () => onValueChange(!value);
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(accessibilityState.selected);
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (value !== undefined && onValueChange) attrs['aria-checked'] = String(!!value);
        if (accessible) attrs['data-accessible'] = 'true';
        if (testID === 'card-settings-sheet') attrs['data-style'] = JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter(Boolean)));
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    class Value { constructor(public v: number) {} setValue(v: number) { this.v = v; } interpolate() { return 0; } }
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), Switch: el('button'), TextInput: el('input'),
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
// The keyboard as the root provider reports it (components/useModalKeyboardLift.ts reads it): down unless a test raises it.
const keyboard = vi.hoisted(() => ({ height: 0, isVisible: false }));
vi.mock('react-native-keyboard-controller', () => ({ useKeyboardState: (pick: (s: typeof keyboard) => unknown) => pick(keyboard) }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined),
}));
const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...mem.store.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach(k => mem.store.delete(k)); }),
    },
}));
vi.mock('../pulse-token-store', () => ({ forgetAllPulseTokens: vi.fn(async () => undefined) }));
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
// The phone's place (H4: the global node's "near you"): allowed or not, and the last one known. Home must never ask.
const loc = vi.hoisted(() => ({ status: 'denied', last: null as null | { coords: { latitude: number; longitude: number } }, asked: 0 }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: loc.status })),
    getLastKnownPositionAsync: vi.fn(async () => loc.last),
    requestForegroundPermissionsAsync: vi.fn(async () => { loc.asked += 1; return { status: 'denied' }; }),
    getCurrentPositionAsync: vi.fn(async () => { loc.asked += 1; return null; }),
}));

import HomeScreen from '../../app/(tabs)/index';
import { goToNeedsTarget } from '../../components/NeedsYouIcons';
import * as db from '../db';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { draftIdentity, wipeIdentityScopedStorage } from '../identity';
import { rememberKnock } from '../knock';
import { announceAccountOnPhone } from '../account-on-phone';
import { resetHomeStoreForTests } from '../home-store';
import { homeAnswerStoreKey, homeHintStoreKey, homeLayoutPhoneOnlySentStoreKey, homeLayoutPhoneOnlyStoreKey, homeLayoutStoreKey, homeTipsStoreKey } from '../storage-keys';
import { HOME_TIPS, localDay, translateV1 } from '@beanpool/core';
import { AccessibilityInfo, AppState, DeviceEventEmitter } from 'react-native';
import { FEWER_CARDS_LINE, HOME_SAFETY_POLL_MS, decideOnNode, mergeNeeds, type HomeAnswer } from '../home-cards';
import { decisionsOn, hiddenTabsFor } from '../node-profile';
import { commonsSectionFor } from '../commons-sections';
import { marketFilterFromLink } from '../market-filters';
import { boundSignatureValid } from './server-signature-check';
import { paramsRead, resolves, tabOf } from './route-resolve';
import { getBundledGuide } from '../guide';

const NODE = 'https://mullum.beanpool.org';
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3600_000;

/**
 * A member who has every card of version 1 on their list (as one who edited with an older app and hid nothing), so each
 * card's own rules are seen; a newcomer's Home (`layout: null`, CARD-FRAME §3) is its own case below.
 */
const everyV1Card = (now: number) => ({ ...translateV1({ order: [], hidden: [] }), updatedAt: iso(now - 72 * H) });

function localMember(): HomeAnswer {
    const now = Date.now();
    return {
        generatedAt: iso(now), profile: 'local',
        features: { beans: true, escrow: true, invites: true, exampleListings: false, decisions: true },
        me: { joinedAt: iso(now - 3 * 24 * H), isKeeper: false, probation: null, interests: [], area: null, firstOffer: false, standing: 'member' },
        layout: everyV1Card(now),
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

const node = {
    answer: localMember(), status: 200, down: false, hang: false, refuse: 0, requests: [] as { url: string; method: string; headers: Record<string, string>; body: string; status: number }[],
    /** While set, GET /api/home is answered (as it was when it arrived) only once this settles. */
    homeGate: null as Promise<void> | null,
    /** The reader's role, as GET /api/node-admin/me says it (routes/node-admin.ts). */
    role: null as string | null,
    /** While set, a save of the interests is kept in the member's row, and Home's answer says what the row holds. */
    keepsRow: false,
    /** What a community this phone knocked on says of the knock (GET /api/join/knock/status, routes/knocks.ts). */
    knockStatus: 'pending' as string,
};
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
    keyboard.height = 0;
    keyboard.isVisible = false;
    node.answer = localMember();
    node.status = 200;
    node.down = false;
    node.hang = false;
    node.refuse = 0;
    node.requests = [];
    node.homeGate = null;
    node.role = null;
    node.keepsRow = false;
    node.knockStatus = 'pending';
    loc.status = 'denied';
    loc.last = null;
    loc.asked = 0;
    manage.start.mockClear();
    vi.mocked(goToNeedsTarget).mockClear();
    vi.mocked(db.getMarketplaceTransactions).mockImplementation(async () => []);
    vi.mocked(db.getUnreadByConversation).mockImplementation(async () => []);
    who.identity = await draftIdentity();
    mem.store.set('beanpool_anchor_url', NODE);
    // The phone already holds the member's list (it landed here before): a landing is one read.
    mem.store.set(homeLayoutStoreKey(who.identity.publicKey, NODE), JSON.stringify(node.answer.layout));
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
            const body = JSON.stringify(node.answer);
            if (node.homeGate) await node.homeGate;
            if (headers['If-None-Match'] === tag) { record(304); return new Response(null, { status: 304 }); }
            record(200);
            return new Response(body, { status: 200, headers: { ETag: tag } });
        }
        if (u.pathname === '/api/global/watches' && req.method === 'POST') {
            const { lat, lng } = JSON.parse(req.body);
            record(200);
            return new Response(JSON.stringify({ watch: { id: 'w1', lat, lng, radiusKm: 10, createdAt: new Date().toISOString() } }), { status: 200 });
        }
        if (u.pathname === '/api/join/knock/status') {
            record(200);
            return new Response(JSON.stringify({ status: node.knockStatus }), { status: 200 });
        }
        if (u.pathname === '/api/node-admin/me') {
            record(200);
            return new Response(JSON.stringify({ role: node.role, communityName: 'Mullumbimby' }), { status: 200 });
        }
        if (u.pathname === '/api/members/preferences') {
            if (node.refuse) { record(node.refuse); return new Response('{"error":"Only a member of this community keeps a Home here."}', { status: node.refuse }); }
            const body = JSON.parse(req.body);
            if (node.keepsRow && node.answer.me && 'interests' in body.preferences) {
                node.answer = { ...node.answer, me: { ...node.answer.me, interests: body.preferences.interests } };
            }
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
const byLabel = (label: string) => document.querySelector(`[aria-label="${label.replace(/"/g, '\\"')}"]`) as HTMLElement | null;
const homeReads = () => node.requests.filter(r => new URL(r.url).pathname === '/api/home');
const marketOrder = () => Array.from(document.querySelectorAll('[data-testid^="home-market-p"]')).map(e => e.getAttribute('data-testid')!.replace('home-market-', ''));
// What the phone sent since a point, the cards a layout save named, the phone-only mark (index.tsx `phoneOver`), a Remove
// through a card's "…" menu, and whether Edit home says the cards aren't on the account yet (review of #1699, confirmation).
const trace = (from = 0) => node.requests.slice(from).map(r => `${r.method} ${new URL(r.url).pathname} ${r.status}`);
const sentIds = (r: { body: string }) => (JSON.parse(r.body).preferences['home.layout'].cards as { id: string }[]).map(c => c.id);
const markKey = () => homeLayoutPhoneOnlyStoreKey(who.identity.publicKey, NODE);
async function removeVia(id: string) {
    await act(async () => { (document.querySelector(`[data-testid="home-card-${id}-menu"]`) as HTMLElement).click(); });
    await act(async () => { (document.querySelector('[data-testid="home-menu-remove"]') as HTMLElement).click(); });
    await settle();
}
async function notOnAccountShown() {
    await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
    const shown = !!document.querySelector('[data-testid="edit-home-not-on-account"]');
    await act(async () => { (document.querySelector('[data-testid="edit-home-done"]') as HTMLElement).click(); });
    return shown;
}

describe('a new local member\'s first landing (§3.2 (b) day one)', () => {
    it('one request for the whole screen, and the cards in the design\'s order', async () => {
        await render();
        expect(node.requests.map(r => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /api/home']);
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
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
    it('Remove: the card goes at once, the instance leaves the list on the phone and the account, and it is said (CARD-FRAME §1.3)', async () => {
        await render();
        await act(async () => { byLabel('Card options for Coming up')!.click(); });
        expect(document.querySelector('[data-modal]')?.textContent).toContain('Remove');
        expect(document.querySelector('[data-modal]')?.textContent).not.toContain('Hide');
        expect(document.querySelector('[data-modal]')?.textContent).not.toContain('Settings');
        expect(byLabel('Move Coming up up')).not.toBeNull();
        expect(byLabel('Move Coming up down')).not.toBeNull();
        await act(async () => { byLabel('Remove Coming up from Home')!.click(); });
        await settle();
        expect(cards()).not.toContain('events');
        const phone = JSON.parse(mem.store.get(homeLayoutStoreKey(who.identity.publicKey, NODE))!);
        expect(phone.v).toBe(2);
        expect(phone.cards.map((c: { id: string }) => c.id)).not.toContain('events');
        const post = node.requests.find(r => r.method === 'POST')!;
        expect(JSON.parse(post.body).preferences['home.layout'].cards.map((c: { id: string }) => c.id)).not.toContain('events');
        expect(boundSignatureValid(post, who.identity.publicKey)).toBe(true);
        expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Coming up removed. Add a card brings it back.');
        // A remove reads nothing.
        expect(homeReads()).toHaveLength(1);
    });

    it('Move down: the card swaps with the one below it on screen', async () => {
        await render();
        await act(async () => { byLabel('Card options for Coming up')!.click(); });
        await act(async () => { byLabel('Move Coming up down')!.click(); });
        await settle();
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'market', 'events', 'joined', 'pulse', 'beans', 'community']);
    });

    it('the first movable card can\'t move up; the last can\'t move down past the community card', async () => {
        await render();
        await act(async () => { byLabel('Card options for First steps')!.click(); });
        expect(byLabel('Move First steps up')!.getAttribute('aria-disabled')).toBe('true');
        await act(async () => { byLabel('Cancel')!.click(); });
        await act(async () => { byLabel('Card options for Your Beans')!.click(); });
        expect(byLabel('Move Your Beans down')!.getAttribute('aria-disabled')).toBe('true');
    });

    it('Add a card: only this node\'s types, "On Home" for one already there; Add puts it first, says so, and reads Home only after the save is answered', async () => {
        await render();
        await act(async () => { byLabel('Card options for The Pulse')!.click(); });
        await act(async () => { byLabel('Remove The Pulse from Home')!.click(); });
        await settle();
        expect(cards()).not.toContain('pulse');
        await act(async () => { (document.querySelector('[data-testid="home-add-card"]') as HTMLElement).click(); });
        expect(document.querySelector('[data-testid="add-card-sheet"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="add-card-beans-on-home"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="add-card-find"]')).toBeNull();
        expect(byLabel('Your Beans is already on Home')).not.toBeNull();
        const before = node.requests.length;
        await act(async () => { byLabel('Add The Pulse to Home')!.click(); });
        await settle();
        expect(document.querySelector('[data-testid="add-card-sheet"]')).toBeNull();
        expect(cards()[0]).toBe('pulse');
        expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('The Pulse added to Home');
        const after = node.requests.slice(before).map(r => `${r.method} ${new URL(r.url).pathname}`);
        // The save first, and the read only once it is answered (§2.4), with the card in it. (This test node doesn't keep
        // layouts, so its next answer is older than the phone's and the phone sends its list again after: not counted.)
        expect(after.slice(0, 2)).toEqual(['POST /api/members/preferences', 'GET /api/home']);
        expect(JSON.parse(node.requests[before].body).preferences['home.layout'].cards[0]).toEqual({ id: 'pulse', type: 'pulse' });
        expect(homeReads().at(-1)!.url).toContain('pulse');
    });

    it('Edit home: ＋ Add a card first, ↑ ↓ … per card, no switches, and Reset gives the newcomer\'s list', async () => {
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(document.querySelector('[data-testid="edit-home-add"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="edit-home-pulse-switch"]')).toBeNull();
        expect(document.querySelector('[data-testid="edit-home-pulse-menu"]')).not.toBeNull();
        await act(async () => { (document.querySelector('[data-testid="edit-home-reset"]') as HTMLElement).click(); });
        await settle();
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'market', 'events', 'community']);
    });

    it('a saved search: Add opens its settings sheet, Add to Home puts it first with its words, and it says it fills in from the node', async () => {
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-add-card"]') as HTMLElement).click(); });
        await act(async () => { byLabel('Add A saved search to Home')!.click(); });
        await settle(2);
        expect(document.querySelector('[data-testid="card-settings-sheet"]')).not.toBeNull();
        const input = document.querySelector('[data-testid="card-settings-words"]') as HTMLElement;
        expect(input).not.toBeNull();
    });

    it('the settings sheet stands above the keyboard: lifted by its height and fitted above it, as Create a Group is (review of #1699, finding 3)', async () => {
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-add-card"]') as HTMLElement).click(); });
        await act(async () => { byLabel('Add A saved search to Home')!.click(); });
        await settle(2);
        const style = () => JSON.parse(document.querySelector('[data-testid="card-settings-sheet"]')!.getAttribute('data-style')!);
        expect(style()).toMatchObject({ marginBottom: 0, maxHeight: 569 * 0.9 });
        // The keyboard comes up (283 dp of 569, measured on the emulator at the floor) as the member types.
        keyboard.height = 283;
        keyboard.isVisible = true;
        const input = document.querySelector('[data-testid="card-settings-words"]') as HTMLInputElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'eggs');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        // Insets top 24 + 8: the sheet sits on the keyboard and fits between it and the status bar.
        expect(style()).toMatchObject({ marginBottom: 283, maxHeight: 569 - 283 - 32 });
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
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
    });

    it('returning to Home revalidates with the kept tag: a 304, no body, the same cards', async () => {
        await render();
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(homeReads().map(r => r.status)).toEqual([200, 304]);
        expect(homeReads()[1].headers['If-None-Match']).toMatch(/^W\/"home-/);
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
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

    it('a 404 from /api/home: an update message instead of unreachable, with Market and Talk links', async () => {
        node.status = 404;
        await render();
        expect(document.body.textContent).toContain("This community's server needs an update before Home works. Market and Talk still work.");
        expect(document.body.textContent).not.toContain("Couldn't reach your community");
        expect(document.querySelector('[data-testid="home-retry"]')).toBeNull();
        expect(byLabel('Open the Market')).not.toBeNull();
        expect(byLabel('Open Talk')).not.toBeNull();
        await act(async () => { byLabel('Open the Market')!.click(); });
        expect(nav.router.navigate).toHaveBeenCalledWith('/(tabs)/market');
        await act(async () => { byLabel('Open Talk')!.click(); });
        expect(nav.router.navigate).toHaveBeenCalledWith('/(tabs)/chats');
    });

    it('a kept answer and the node answers 404: the update message replaces it, not couldn\'t reach', async () => {
        await render();
        expect(cards()).toContain('market');
        node.status = 404;
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(document.body.textContent).toContain("This community's server needs an update before Home works. Market and Talk still work.");
        expect(document.querySelector('[data-testid="home-offline-note"]')).toBeNull();
        expect(cards()).toHaveLength(0);
        expect(byLabel('Open the Market')).not.toBeNull();
        expect(byLabel('Open Talk')).not.toBeNull();
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
        // The account's copy as a node before the frame answers it (version 1), and none on the phone.
        node.answer = { ...localMember(), cards: { ...localMember().cards, safety: { words: true, signInLinked: false } }, layout: { v: 1, order: [], hidden: [], dismissed: { safety: '2026-10-01T00:00:00.000Z' }, updatedAt: '2026-10-01T00:00:00.000Z' } as never };
        mem.store.delete(homeLayoutStoreKey(who.identity.publicKey, NODE));
        await render();
        expect(safety.props.homeWord).toEqual({ url: NODE, standing: { words: true, joinedAt: Date.parse(node.answer.me!.joinedAt!) } });
        expect(safety.props.accountDismissedAt).toBe('2026-10-01T00:00:00.000Z');
        // No copy of the member's list on this phone, and the account's names nothing: unknown, so the newcomer's list is
        // drawn and its one read is enough (review of #1699, finding 2: an empty version-1 list is not "every card").
        expect(node.requests.map(r => new URL(r.url).pathname)).toEqual(['/api/home']);
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'market', 'events', 'community']);
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
        layout: everyV1Card(now),
        cards: {
            needs: { items: needs },
            // Sent to both: a local community draws none (only the global node has the directory).
            find: findBody(),
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

/** Find your community's body as the global node sends it (routes/global-directory.ts landingCardFor): a community 12 km away. */
function findBody(over: Partial<NonNullable<HomeAnswer['cards']['find']>> = {}): NonNullable<HomeAnswer['cards']['find']> {
    return {
        point: 'request',
        communities: [{ key: 'byron', name: 'Byron Shire BeanPool', url: 'https://byron.example.org', lat: -28.6, lng: 153.6, radiusKm: 20, memberCount: 40, contactEmail: null, contactPhone: null, distanceKm: 12 }],
        communityCount: 38, nearbyPosts: { radiusKm: 25, count: 9, more: false }, watches: [], knock: null, directoryFetchedAt: iso(Date.now() - H),
        ...over,
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
            'home-tip-read-more → /guide/[slug] slug=posting',
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
            'home-tip-read-more → /guide/[slug] slug=posting',
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
    // Find your community (H4) right under Needs you, its three actions each opening a screen the global node shows (no
    // place known here, so "Tell me" opens Communities near you to ask for one); First steps' global words only while the
    // first post isn't made (case 2; no limits sent here); no money cards and no invite whatever the answer holds, no
    // Decisions and no vote in Needs you (Commons is hidden there): the Decide card is polls only, opening the Market's
    // Polls. Who joined is a count there, with nothing to open.
    global: {
        1: [
            'home-needs-message → /chat/[id] id=dm1',
            'home-needs-group → /chat/[id] id=g1&group=1',
            'home-find-near → /find-community',
            'home-find-start → /start-community',
            'home-find-watch → /find-community',
            'home-tip-read-more → /guide/[slug] slug=posting',
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
        2: [
            'home-needs-message → /(tabs)/chats view=messages&filter=unread',
            'home-needs-group → /(tabs)/chats view=groups',
            'home-find-near → /find-community',
            'home-find-start → /start-community',
            'home-find-watch → /find-community',
            'home-step-post → /map newPost=offer',
            'home-step-ask → /find-community',
            'home-tip-read-more → /guide/[slug] slug=posting',
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
const IN_PLACE = /^(home-card-[a-z]+-menu|home-edit|home-add-card|home-market-tune|home-notice-line|home-needs-admin|home-step-interests|home-interest-[a-z]+|home-tip-next|home-tips-dont-show)$/;

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
        // A guide page (the Tips card's Read more) is named by the bundled guide, not by its screen: it must be one of its pages.
        if (k === 'slug') {
            if (!getBundledGuide().guides.some(g => g.slug === v)) return `slug=${v}, which the bundled guide has no page for`;
            continue;
        }
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
        // Core's one rule (CARD-FRAME §1.2): no Decide card on the worldwide community, whatever its answer holds; its polls
        // are the Market's Polls pill.
        expect(byLabel('2 polls open. Opens the polls, in the Market.')).toBeNull();
        expect(document.querySelector('[data-testid="home-card-decide"]')).toBeNull();
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
        // A visitor's Home is the newcomer's (CARD-FRAME §3): New in the Market before Coming up.
        expect(cards()).toEqual(['market', 'events', 'community']);
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
        node.refuse = 403;
        const key = homeLayoutStoreKey(who.identity.publicKey, NODE);
        mem.store.set(key, JSON.stringify({ v: 2, cards: [{ id: 'beans', type: 'beans' }], dismissed: {}, updatedAt: new Date().toISOString() }));
        await render();
        expect(node.requests.filter(r => r.method === 'POST')).toHaveLength(1);
        for (let i = 0; i < 3; i++) {
            await act(async () => { nav.focus?.(); });
            await settle();
        }
        expect(node.requests.filter(r => r.method === 'POST')).toHaveLength(1);
        expect(cards()).toContain('pulse');
        expect(JSON.parse(mem.store.get(key)!).cards.map((c: { id: string }) => c.id)).toContain('pulse');
    });

    it('a node from before the frame refuses the new shape: the cards stay on the phone, Edit home says so, and each landing sends them again (CARD-FRAME §2.3)', async () => {
        node.answer = { ...localMember(), layout: { v: 1, order: ['beans'], hidden: ['pulse'], dismissed: {}, updatedAt: iso(Date.now() - 72 * H) } as never };
        node.refuse = 400;
        const key = homeLayoutStoreKey(who.identity.publicKey, NODE);
        const mine = { v: 2, cards: [{ id: 'search-k7mq', type: 'search', settings: { q: 'eggs', kind: 'any' } }, { id: 'beans', type: 'beans' }], dismissed: {}, updatedAt: new Date().toISOString() };
        mem.store.set(key, JSON.stringify(mine));
        await render();
        expect(cards().slice(0, 2)).toEqual(['search-k7mq', 'beans']);
        expect(JSON.parse(mem.store.get(key)!)).toEqual(mine);
        const posts = () => node.requests.filter(r => r.method === 'POST').length;
        expect(posts()).toBe(1);
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(document.querySelector('[data-testid="edit-home-not-on-account"]')?.textContent).toBe("Your community's server needs an update before your cards follow you to other devices.");
        await act(async () => { (document.querySelector('[data-testid="edit-home-done"]') as HTMLElement).click(); });
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(posts()).toBe(2);
        expect(cards().slice(0, 2)).toEqual(['search-k7mq', 'beans']);
    });

    // Review of #1699, finding 1: a POST at every read (each 2-minute poll, each doorbell) while Home was in front.
    it('the refused list goes again once per landing: never at a poll, a doorbell or an add\'s own read', async () => {
        const spy = vi.spyOn(globalThis, 'setInterval');
        try {
            node.answer = { ...localMember(), layout: { v: 1, order: ['beans'], hidden: ['pulse'], dismissed: {}, updatedAt: iso(Date.now() - 72 * H) } as never };
            node.refuse = 400;
            const key = homeLayoutStoreKey(who.identity.publicKey, NODE);
            mem.store.set(key, JSON.stringify({ v: 2, cards: [{ id: 'search-k7mq', type: 'search', settings: { q: 'eggs', kind: 'any' } }, { id: 'beans', type: 'beans' }], dismissed: {}, updatedAt: new Date().toISOString() }));
            const posts = () => node.requests.filter(r => r.method === 'POST' && new URL(r.url).pathname === '/api/members/preferences').length;
            await render();
            expect(posts()).toBe(1);
            const poll = spy.mock.calls.filter(c => c[1] === HOME_SAFETY_POLL_MS).at(-1)![0] as () => void;
            for (let i = 0; i < 3; i++) {
                await act(async () => { poll(); });
                await settle();
            }
            const ws = vi.mocked(DeviceEventEmitter.addListener).mock.calls.filter(c => c[0] === 'ws_activity').at(-1)![1] as (d: unknown) => void;
            await act(async () => { ws({ type: 'new_post' }); });
            await act(async () => { await new Promise(r => setTimeout(r, 3_300)); });
            await settle();
            expect(homeReads()).toHaveLength(5);
            expect(posts()).toBe(1);
            // An add: its own save, then its read, and that read sends nothing.
            const before = node.requests.length;
            await act(async () => { (document.querySelector('[data-testid="home-add-card"]') as HTMLElement).click(); });
            await act(async () => { byLabel('Add The Pulse to Home')!.click(); });
            await settle(20);
            expect(node.requests.slice(before).map(r => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['POST /api/members/preferences', 'GET /api/home']);
            expect(cards()[0]).toBe('pulse');
            // The next landing sends it once more.
            await act(async () => { nav.focus?.(); });
            await settle();
            expect(posts()).toBe(3);
        } finally { spy.mockRestore(); }
    });

    // Review of #1699 (confirmation), note 1: the line stayed until an edit or a restart.
    it('P6: the node is updated and another device saved a newer list: that list stands, nothing is sent, and Edit home no longer says the server needs an update', async () => {
        node.answer = { ...localMember(), layout: { v: 1, order: ['beans'], hidden: ['pulse'], dismissed: {}, updatedAt: iso(Date.now() - 72 * H) } as never };
        node.refuse = 400;
        mem.store.set(homeLayoutStoreKey(who.identity.publicKey, NODE), JSON.stringify({ v: 2, cards: [{ id: 'search-k7mq', type: 'search', settings: { q: 'eggs', kind: 'any' } }, { id: 'beans', type: 'beans' }], dismissed: {}, updatedAt: iso(Date.now() - H) }));
        await render();
        expect(await notOnAccountShown()).toBe(true);
        node.refuse = 0;
        node.answer = { ...localMember(), layout: { v: 2, cards: [{ id: 'pulse', type: 'pulse' }, { id: 'beans', type: 'beans' }], dismissed: {}, updatedAt: new Date().toISOString() } as never };
        const before = node.requests.length;
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(trace(before).filter(t => t.startsWith('POST'))).toEqual([]);
        expect(cards().slice(0, 2)).toEqual(['pulse', 'beans']);
        expect(await notOnAccountShown()).toBe(false);
    });

    it('a member who never edited adds a card on a node from before the frame: one save, then one read', async () => {
        node.answer = { ...localMember(), me: { ...localMember().me!, joinedAt: iso(Date.now() - 30 * 24 * H) }, layout: null };
        node.refuse = 400;
        mem.store.delete(homeLayoutStoreKey(who.identity.publicKey, NODE));
        await render();
        const before = node.requests.length;
        await act(async () => { (document.querySelector('[data-testid="home-add-card"]') as HTMLElement).click(); });
        await act(async () => { byLabel('Add The Pulse to Home')!.click(); });
        await settle(20);
        expect(node.requests.slice(before).map(r => `${r.method} ${r.status}`)).toEqual(['POST 400', 'GET 200']);
        expect(cards()[0]).toBe('pulse');
    });
});

// ── Edit home offers only what this node can show (PR #1483 review 4165384151) ─────────────────────────────────────────

const editRows = () => Array.from(document.querySelectorAll('[data-testid^="edit-home-"]'))
    .map(e => e.getAttribute('data-testid')!.replace('edit-home-', ''))
    .filter(id => !/-(up|down|menu)$/.test(id) && !['done', 'reset', 'add', 'not-on-account'].includes(id));
const pickerRows = () => Array.from(document.querySelectorAll('[data-testid^="add-card-"]'))
    .map(e => e.getAttribute('data-testid')!.replace('add-card-', ''))
    .filter(id => !/-(add|on-home|count|status)$/.test(id) && !/^(sheet|done|note|group-.*)$/.test(id));

describe('Edit home offers only the cards this node can show', () => {
    it('the global node: no Your deals, Your enterprise, Your Beans or Grow your community; First steps since H4; Find your community not while pinned', async () => {
        node.answer = everyCard('global', 1);
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        // Core's one rule (CARD-FRAME §1.2): no Decide on the worldwide community either.
        expect(editRows()).toEqual(['safety', 'steps', 'tips', 'interests', 'events', 'market', 'groups', 'joined', 'pulse', 'notices']);
        expect(document.body.textContent).not.toMatch(/Your deals|Your enterprise|Your Beans|Grow your community/);
        expect(document.querySelector('[data-modal]')?.textContent).toContain('Find your community stays near the top for your first 30 days.');
        // The picker lists the same: no money cards, no Decide, no invites, and no Find your community while it is pinned.
        await act(async () => { (document.querySelector('[data-testid="edit-home-add"]') as HTMLElement).click(); });
        await settle(2);
        const rows = pickerRows();
        expect(rows.length).toBeGreaterThan(5);
        for (const t of ['beans', 'deals', 'enterprise', 'decide', 'invite', 'find']) expect(rows, t).not.toContain(t);
        expect(document.body.textContent).toContain('Near you');
    });

    it('the global node after a member\'s first 30 days: Find your community is listed in its place, with its arrows and "…"', async () => {
        const a = everyCard('global', 1);
        node.answer = { ...a, me: { ...a.me!, joinedAt: iso(Date.now() - 31 * 24 * H) } };
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(editRows()).toEqual(['safety', 'find', 'steps', 'tips', 'interests', 'events', 'market', 'groups', 'joined', 'pulse', 'notices']);
        expect(document.querySelector('[data-testid="edit-home-find-menu"]')).not.toBeNull();
        expect(document.querySelector('[data-modal]')?.textContent).not.toContain('first 30 days');
    });

    it('a local community with Beans, escrow, enterprises and invites: every card but Find your community and "Your way back in" (no 12-words door)', async () => {
        node.answer = everyCard('local', 1);
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(editRows()).toEqual(['steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'beans', 'notices', 'invite']);
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

// ── The account leaving while Home's read is out (PR #1483 review 4166559191) ─────────────────────────────────────────

/** Everything Home keeps on the phone: every key under its prefix, and the stars. */
const homeKeys = () => [...mem.store.keys()].filter(k => k.startsWith('beanpool_home') || k === 'bp_fav_categories').sort();

describe('the account leaves the phone while Home\'s read is out: the screen writes nothing back for it', () => {
    /** A first landing whose read is held at the node: the answer would bring the account's stars and its first reveal. */
    async function landHeld(): Promise<() => void> {
        node.answer = { ...localMember(), me: { ...localMember().me!, interests: ['food'] } };
        let release!: () => void;
        node.homeGate = new Promise<void>(r => { release = r; });
        // A first landing: nothing of Home on the phone yet.
        mem.store.delete(homeLayoutStoreKey(who.identity.publicKey, NODE));
        await render();
        expect(homeKeys()).toEqual([]);
        return release;
    }

    it('Sign Out\'s wipe, then the read lands while the screen still holds the account: no answer, stars, owed save, reveal or hint come back', async () => {
        const release = await landHeld();
        // account-leaves-phone.ts: the key comes off the phone, then the one wipe (identity.ts wipeIdentity).
        announceAccountOnPhone(null);
        await act(async () => { await wipeIdentityScopedStorage(AsyncStorage as never); });
        release();
        await settle();
        expect(homeKeys()).toEqual([]);
        expect(node.requests.filter(r => r.method === 'POST')).toEqual([]);
    });

    it('Replace: the wipe, the restored account on the phone, then the replaced account\'s read lands: nothing of it is kept', async () => {
        const release = await landHeld();
        // restore-account.ts saveRestoredAccount: the wipe, then the restored key written (identity.ts importIdentity announces it).
        await act(async () => { await wipeIdentityScopedStorage(AsyncStorage as never); });
        announceAccountOnPhone((await draftIdentity()).publicKey);
        release();
        await settle();
        expect(homeKeys()).toEqual([]);
        expect(node.requests.filter(r => r.method === 'POST')).toEqual([]);
    });
});

// ── A landing that joins Home's read already out (PR #1483 review 4168250992) ─────────────────────────────────────────

describe('a landing that joins the read already out judges its answer by when that read was sent', () => {
    const phoneStars = () => JSON.parse(mem.store.get('bp_fav_categories') ?? '[]');
    const interestPosts = () => node.requests.filter(r => r.method === 'POST' && 'interests' in JSON.parse(r.body).preferences)
        .map(r => JSON.parse(r.body).preferences.interests);
    const tap = async (testId: string) => {
        await act(async () => { (document.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click(); });
        await settle();
    };

    /** Home is in front and a focus sends a read, held at the node: its answer says what the row held as it arrived. */
    async function focusWithReadHeld(): Promise<() => void> {
        let release!: () => void;
        node.homeGate = new Promise<void>(r => { release = r; });
        await act(async () => { nav.focus?.(); });
        await settle();
        return release;
    }

    it('the review\'s run: Food saved while the read is out, then a second landing joins it; Food stays, and the next star keeps it', async () => {
        node.keepsRow = true;
        mem.store.set(homeHintStoreKey(who.identity.publicKey), '1');
        await render();
        const release = await focusWithReadHeld();
        // The member taps Food; its save lands: the row, the phone and the flag all say ['food'].
        await tap('home-interest-food');
        expect(node.answer.me!.interests).toEqual(['food']);
        expect(phoneStars()).toEqual(['food']);
        // Home gets focus again while the read is still out (the app back to the front, back from the Market): it joins it.
        await act(async () => { nav.focus?.(); });
        await settle();
        release();
        await settle();
        expect(homeReads()).toHaveLength(2);
        // The read was sent before the save landed: neither landing takes its list over the phone's.
        expect(document.querySelector('[data-testid="home-interest-food"]')!.getAttribute('aria-selected')).toBe('true');
        expect(marketOrder()).toEqual(['p3', 'p1', 'p2']);
        expect(phoneStars()).toEqual(['food']);
        // The member stars Labour: the row keeps both (the review measured ["labour"]).
        await tap('home-interest-labour');
        expect(interestPosts()).toEqual([['food'], ['food', 'labour']]);
        expect(node.answer.me!.interests).toEqual(['food', 'labour']);
        // The next landing agrees with the row, and sends nothing.
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(homeReads()).toHaveLength(3);
        expect(phoneStars()).toEqual(['food', 'labour']);
        expect(interestPosts()).toHaveLength(2);
    });

    it('the control: the same run without the second landing keeps Food too', async () => {
        node.keepsRow = true;
        mem.store.set(homeHintStoreKey(who.identity.publicKey), '1');
        await render();
        const release = await focusWithReadHeld();
        await tap('home-interest-food');
        release();
        await settle();
        expect(homeReads()).toHaveLength(2);
        expect(document.querySelector('[data-testid="home-interest-food"]')!.getAttribute('aria-selected')).toBe('true');
        expect(phoneStars()).toEqual(['food']);
    });

    it('the control: a read sent with no save out, joined by a second landing, is the account\'s word (Food cleared in the web app)', async () => {
        node.keepsRow = true;
        node.answer = { ...localMember(), me: { ...localMember().me!, interests: ['food'] } };
        mem.store.set(homeHintStoreKey(who.identity.publicKey), '1');
        await render();
        expect(phoneStars()).toEqual(['food']);
        expect(marketOrder()).toEqual(['p3', 'p1', 'p2']);
        // The web app clears Food; then a focus sends a read, and a second landing joins it. No star is tapped.
        node.answer = { ...node.answer, me: { ...node.answer.me!, interests: [] } };
        const release = await focusWithReadHeld();
        await act(async () => { nav.focus?.(); });
        await settle();
        release();
        await settle();
        expect(homeReads()).toHaveLength(2);
        expect(phoneStars()).toEqual([]);
        expect(marketOrder()).toEqual(['p1', 'p2', 'p3']);
        expect(interestPosts()).toEqual([]);
    });
});

// ── Where only a community's admins invite (PR #1483 review 4166559683) ───────────────────────────────────────────────

describe('where only a community\'s admins invite, Home asks only them to', () => {
    /** A member a while in on a "Known" community (`door: 'admins'`): an Offer posted, a photo, a star; no invite made. */
    function knownCommunity(): HomeAnswer {
        const a = localMember();
        return {
            ...a,
            features: { ...a.features, door: 'admins' },
            me: { ...a.me!, interests: ['food'], firstOffer: true },
            cards: { ...a.cards, steps: { ...a.cards.steps!, firstOffer: true, firstPost: true, photo: true, interests: true, invited: false } },
        };
    }

    it('a plain member: no Grow your community, no invite step (First steps is done), nothing that opens Invites, none offered in Edit home', async () => {
        node.answer = knownCommunity();
        node.role = null;
        mem.store.set(homeHintStoreKey(who.identity.publicKey), '1');
        await render();
        expect(cards()).not.toContain('invite');
        expect(cards()).not.toContain('steps');
        const { links } = await pressEverything();
        expect(links.filter(l => l.href.pathname === '/(tabs)/people' && l.href.params?.view === 'invites').map(fmt)).toEqual([]);
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(editRows()).not.toContain('invite');
    });

    it('an admin there: Grow your community and the invite step, each opening Invites', async () => {
        node.answer = knownCommunity();
        node.role = 'admin';
        mem.store.set(homeHintStoreKey(who.identity.publicKey), '1');
        await render();
        expect(cards()).toEqual(expect.arrayContaining(['steps', 'invite']));
        const { links } = await pressEverything();
        expect(links.filter(l => l.href.params?.view === 'invites').map(fmt)).toEqual([
            'home-step-invite → /(tabs)/people view=invites',
            'home-invite → /(tabs)/people view=invites',
        ]);
    });
});

// ── The global node's Home (slice H4) ──────────────────────────────────────────────────────────────────────────────────

/** The phone's copy of the node's profile (utils/node-profile.ts, which the tab strip keeps): what Home goes by before an answer. */
function rememberProfile(profile: 'local' | 'global') {
    mem.store.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features: {}, checkedAt: new Date().toISOString() } }));
}

/** A new member of the global node by 12 words, `days` after joining: limits on, a community 12 km away, listings near. */
function globalMember(days = 3): HomeAnswer {
    const now = Date.now();
    const joinedAt = iso(now - days * 24 * H);
    return {
        generatedAt: iso(now), profile: 'global', features: GLOBAL_FEATURES,
        me: {
            joinedAt, isKeeper: false, interests: [], area: null, firstOffer: false, standing: 'member',
            probation: { onProbation: true, rules: 'words', limits: { posts: { limit: 2 }, photos: { limit: 4 }, new_dm_recipients: { limit: 3 } }, endsWhen: { hours: 168, keptPosts: 3 } },
        },
        layout: everyV1Card(now),
        cards: {
            find: findBody(),
            steps: { joinedAt, firstOffer: false, firstPost: false, photo: false, interests: false, invited: null, area: false, knocked: null },
            events: { items: [{ id: 'e1', title: 'Beach clean', startsAt: iso(now + 24 * H), endsAt: null, place: 'Brunswick', rsvp: null, distanceKm: 8 }], radiusKm: 50 },
            // Newest first as a node with no point would send them: the phone puts the nearest first.
            market: { items: [
                { id: 'p1', type: 'offer', title: 'Lemons to give away', category: 'food', photoUrl: null, distanceKm: 18 },
                { id: 'p2', type: 'need', title: 'Borrow a drill', category: 'tools', photoUrl: null, distanceKm: 3 },
                { id: 'p3', type: 'offer', title: 'Old bikes', category: 'goods', photoUrl: null, distanceKm: null },
                { id: 'p4', type: 'offer', title: 'Seedlings', category: 'garden', photoUrl: null, distanceKm: 0.5 },
            ], total14d: 4, more: false },
            // Names the global node never sends (§13 Q4): the phone draws none whatever an answer holds.
            joined: { count7d: 14, radiusKm: 50, names: [{ callsign: 'Ana', avatarUrl: null }, { callsign: 'Kofi', avatarUrl: null }] },
            community: { name: 'BeanPool', members: 2310, communities: 38 },
        },
    };
}

const homeCards = () => homeReads().map(r => new URL(r.url).searchParams.get('cards')!.split(','));

describe('the global node\'s Home (H4): Find your community on top, the global First steps, a count of who joined, Near you by distance', () => {
    it('one request; Find your community first, with no "…" for the first 30 days; the cards in the design\'s order', async () => {
        node.answer = globalMember(3);
        await render();
        expect(node.requests.map(r => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /api/home']);
        expect(cards()).toEqual(['find', 'steps', 'tips', 'interests', 'events', 'market', 'joined', 'community']);
        expect(byLabel('Card options for Find your community')).toBeNull();
        expect(byLabel('Card options for First steps')).not.toBeNull();
        const card = document.querySelector('[data-testid="home-card-find"]')!;
        expect(card.querySelector('[role="heading"]')?.textContent).toBe('Find your community');
        expect(card.textContent).toContain('Byron Shire BeanPool is 12 km away. Ask to join, and trade with your neighbours there.');
        expect(card.textContent).toContain('9 listings within 25 km of you');
        // Its three actions, each a 48dp Home button that reports where it rests to "+ ADD POST".
        expect(['home-find-near', 'home-find-start', 'home-find-watch'].map(t => document.querySelector(`[data-testid="${t}"]`)?.textContent))
            .toEqual(['Communities near you', 'Start a community', 'Tell me when one starts here']);
    });

    it('a layout that hides it or moves it down (another phone, the web app) is overruled while it is pinned: drawn first, asked for, nothing to hide it with', async () => {
        node.answer = { ...globalMember(3), layout: { v: 1, order: ['market', 'events', 'find'], hidden: ['find'], dismissed: {}, updatedAt: new Date().toISOString() } as never };
        await render();
        expect(cards()[0]).toBe('find');
        expect(cards().slice(0, 4)).toEqual(['find', 'market', 'events', 'steps']);
        expect(homeCards().at(-1)).toContain('find');
        // Nothing moves above it: the card under it can't move up.
        await act(async () => { byLabel('Card options for Near you')!.click(); });
        expect(byLabel('Move Near you up')!.getAttribute('aria-disabled')).toBe('true');
    });

    it('after 30 days: its "…" removes it, the layout is saved, and the next read no longer asks for it', async () => {
        node.answer = globalMember(31);
        mem.store.set(homeHintStoreKey(who.identity.publicKey), '1');
        await render();
        expect(cards()[0]).toBe('find');
        await act(async () => { byLabel('Card options for Find your community')!.click(); });
        await act(async () => { byLabel('Remove Find your community from Home')!.click(); });
        await settle();
        expect(cards()).not.toContain('find');
        const post = node.requests.find(r => r.method === 'POST')!;
        expect(JSON.parse(post.body).preferences['home.layout'].cards.map((c: { id: string }) => c.id)).not.toContain('find');
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(homeCards().at(-1)).not.toContain('find');
    });

    it('Who joined: a count by area, no names or faces, nothing to open', async () => {
        node.answer = globalMember(3);
        await render();
        const line = document.querySelector('[data-testid="home-joined-line"]')!;
        expect(line.getAttribute('aria-label')).toBe('14 people within 50 km joined this week.');
        expect(line.tagName).not.toBe('BUTTON');
        expect(document.querySelectorAll('[data-avatar]')).toHaveLength(0);
        expect(document.querySelector('[data-testid="home-card-joined"]')!.textContent).not.toMatch(/Ana|Kofi/);
    });

    it('"Near you": nearest first by distance; a star puts its category first, each part nearest first, in place', async () => {
        node.answer = globalMember(3);
        await render();
        expect(document.querySelector('[data-testid="home-card-market"] [role="heading"]')?.textContent).toBe('Near you');
        expect(marketOrder()).toEqual(['p4', 'p2', 'p1', 'p3']);
        expect(byLabel('Need: Borrow a drill. 3.0 km. Tools. Opens the listing.')).not.toBeNull();
        expect(byLabel('Offer: Seedlings. 500 m. Garden. Opens the listing.')).not.toBeNull();
        node.hang = true;
        await act(async () => { (document.querySelector('[data-testid="home-interest-food"]') as HTMLElement).click(); });
        await settle(3);
        expect(marketOrder()).toEqual(['p1', 'p4', 'p2', 'p3']);
    });

    it('First steps\' global words and the new-account limits; each line opens a screen the global node shows', async () => {
        node.answer = globalMember(3);
        mem.store.set(homeHintStoreKey(who.identity.publicKey), '1');
        await render();
        const steps = document.querySelector('[data-testid="home-card-steps"]')!;
        expect(Array.from(steps.querySelectorAll('[data-testid^="home-step-"]')).map(e => e.getAttribute('aria-label')))
            .toEqual(['Post something free or for swap, not done yet', 'Ask a community to let you in, not done yet']);
        expect(steps.querySelector('[data-testid="home-steps-limits"]')?.textContent).toBe('For your first 7 days: 2 posts and 3 new chats a day.');
        expect(steps.textContent).not.toMatch(/Post your first Offer|Add a photo|Invite someone|Set your area/);
        await act(async () => { (steps.querySelector('[data-testid="home-step-post"]') as HTMLElement).click(); });
        expect(nav.router.push).toHaveBeenCalledWith({ pathname: '/map', params: { newPost: 'offer' } });
        await act(async () => { (steps.querySelector('[data-testid="home-step-ask"]') as HTMLElement).click(); });
        expect(nav.router.push).toHaveBeenCalledWith('/find-community');
    });

    it('a knock this phone sent: the ask goes from First steps, and Find your community says the answer', async () => {
        node.answer = globalMember(3);
        await rememberKnock(who.identity.publicKey, { url: 'https://byron.example.org', name: 'Byron Shire BeanPool' });
        await render();
        expect(document.querySelector('[data-testid="home-step-ask"]')).toBeNull();
        expect(document.querySelector('[data-testid="home-step-post"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="home-card-find"]')!.textContent).toContain('Waiting for Byron Shire BeanPool: usually a few days.');
        // Only the community it asked, signed for there.
        const asks = node.requests.filter(r => new URL(r.url).pathname === '/api/join/knock/status');
        expect(asks.map(r => new URL(r.url).origin)).toEqual(['https://byron.example.org']);
    });

    it('the place: on the global node the phone\'s last known one (only where already allowed), to two decimals; never asked for', async () => {
        node.answer = globalMember(3);
        rememberProfile('global');
        loc.status = 'granted';
        loc.last = { coords: { latitude: -28.643_21, longitude: 153.612_34 } };
        await render();
        const q = new URL(homeReads()[0].url).searchParams;
        expect([q.get('lat'), q.get('lng')]).toEqual(['-28.64', '153.61']);
        expect(boundSignatureValid(homeReads()[0], who.identity.publicKey)).toBe(true);
        expect(loc.asked).toBe(0);
        // "Tell me when one starts here" keeps a watch there, on the community Home is read from.
        await act(async () => { (document.querySelector('[data-testid="home-find-watch"]') as HTMLElement).click(); });
        await settle();
        const watch = node.requests.find(r => new URL(r.url).pathname === '/api/global/watches')!;
        expect(new URL(watch.url).origin).toBe(NODE);
        expect(document.querySelector('[data-testid="home-find-watch-note"]')?.textContent).toBe("Done. You'll be told when a community starts near here.");
        expect(document.querySelector('[data-testid="home-find-watch"]')).toBeNull();
    });

    it('location not allowed: no place sent and none asked for; the first read with no profile known sends none, the next (the answer said global) does', async () => {
        node.answer = globalMember(3);
        await render();
        expect(new URL(homeReads()[0].url).searchParams.has('lat')).toBe(false);
        loc.status = 'granted';
        loc.last = { coords: { latitude: -28.643_21, longitude: 153.612_34 } };
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(new URL(homeReads()[1].url).searchParams.get('lat')).toBe('-28.64');
        expect(loc.asked).toBe(0);
    });
});

describe('a standby from before the frame and a phone with no copy (review of #1699, finding 2)', () => {
    const at = () => iso(Date.now() - 2 * H);
    const real = (when: string) => ({ v: 2, cards: [
        { id: 'pulse', type: 'pulse' }, { id: 'search-k2x7', type: 'search', settings: { q: 'eggs', kind: 'any' } }, { id: 'market', type: 'market' },
    ], dismissed: {}, updatedAt: when });
    const posts = () => node.requests.filter(r => r.method === 'POST' && new URL(r.url).pathname === '/api/members/preferences');
    const phoneIds = () => JSON.parse(mem.store.get(homeLayoutStoreKey(who.identity.publicKey, NODE)) ?? 'null')?.cards?.map((c: { id: string }) => c.id);

    async function onTheStandby(when: string) {
        // The standby answers the member's version-2 row as an empty version-1 list with the same date, and refuses a save.
        node.answer = { ...localMember(), layout: { v: 1, order: [], hidden: [], dismissed: {}, updatedAt: when } as never };
        node.refuse = 400;
        mem.store.delete(homeLayoutStoreKey(who.identity.publicKey, NODE));
        await render();
        // Not every version-1 card: the newcomer's list.
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'market', 'events', 'community']);
        await act(async () => { byLabel('Card options for Coming up')!.click(); });
        await act(async () => { byLabel('Remove Coming up from Home')!.click(); });
        await settle();
        expect(cards()).not.toContain('events');
        expect(posts().map(p => p.status)).toEqual([400]);
    }

    async function primaryBack(when: string) {
        node.refuse = 0;
        node.answer = { ...localMember(), layout: real(when) as never };
        const before = node.requests.length;
        await act(async () => { nav.focus?.(); });
        await settle();
        return before;
    }

    it('R5: the newcomer\'s list is drawn, an edit stays on the phone, and once the primary is back its list wins: nothing of the edit is sent', async () => {
        const when = at();
        await onTheStandby(when);
        const before = await primaryBack(when);
        expect(posts().filter(p => node.requests.indexOf(p) >= before)).toEqual([]);
        expect(cards()).toEqual(['pulse', 'search-k2x7', 'market', 'community']);
        expect(phoneIds()).toEqual(['pulse', 'search-k2x7', 'market']);
        // And it stays so: the next landing sends nothing either.
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(posts().filter(p => node.requests.indexOf(p) >= before)).toEqual([]);
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(document.querySelector('[data-testid="edit-home-not-on-account"]')).toBeNull();
    });

    it('the mark outlives the app: closed and opened again on the standby, then the primary back with a later list, the account\'s still wins', async () => {
        const when = at();
        await onTheStandby(when);
        act(() => root?.unmount());
        host?.remove();
        resetHomeStoreForTests();
        await render();
        expect(cards()).not.toContain('events');
        const before = await primaryBack(iso(Date.now() - H));
        expect(posts().filter(p => node.requests.indexOf(p) >= before)).toEqual([]);
        expect(cards()).toEqual(['pulse', 'search-k2x7', 'market', 'community']);
    });

    // Review of #1699 (confirmation), finding 1: an edit made while the phone's list is the phone's only sent it at once, so
    // the newcomer's placeholder list overwrote the member's real one when the primary was back before the phone read.
    function asOnTheStandby(when: string) {
        node.answer = { ...localMember(), layout: { v: 1, order: [], hidden: [], dismissed: {}, updatedAt: when } as never };
        node.refuse = 400;
        mem.store.delete(homeLayoutStoreKey(who.identity.publicKey, NODE));
    }

    it('P1b: the primary is back and the first edit comes before the phone reads: the read decides, the account\'s list wins, and the newcomer\'s list is never sent', async () => {
        const when = at();
        asOnTheStandby(when);
        await render();
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'market', 'events', 'community']);
        node.refuse = 0;
        node.answer = { ...localMember(), layout: real(when) as never };
        const before = node.requests.length;
        await removeVia('events');
        expect(posts().filter(p => node.requests.indexOf(p) >= before)).toEqual([]);
        // The edit's own read, then one more for the cards the account's list names that the edit's didn't.
        expect(trace(before)).toEqual(['GET /api/home 200', 'GET /api/home 200']);
        expect(new URL(homeReads().at(-1)!.url).searchParams.get('cards')!.split(',')).toEqual(expect.arrayContaining(['pulse', 'search-k2x7', 'market']));
        expect(cards()).toEqual(['pulse', 'search-k2x7', 'market', 'community']);
        expect(phoneIds()).toEqual(['pulse', 'search-k2x7', 'market']);
        expect(mem.store.has(markKey())).toBe(false);
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(posts().filter(p => node.requests.indexOf(p) >= before)).toEqual([]);
        expect(cards()).toEqual(['pulse', 'search-k2x7', 'market', 'community']);
    });

    it('P1: an edit on the standby, then the primary is back and the member edits again before the phone reads: the account\'s list still wins', async () => {
        const when = at();
        await onTheStandby(when);
        node.refuse = 0;
        node.answer = { ...localMember(), layout: real(when) as never };
        const before = node.requests.length;
        await removeVia('market');
        expect(posts().filter(p => node.requests.indexOf(p) >= before)).toEqual([]);
        expect(cards()).toEqual(['pulse', 'search-k2x7', 'market', 'community']);
        expect(phoneIds()).toEqual(['pulse', 'search-k2x7', 'market']);
        expect(mem.store.has(markKey())).toBe(false);
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(posts().filter(p => node.requests.indexOf(p) >= before)).toEqual([]);
    });

    it('on the standby an edit reads first, then goes once and is refused; a second edit sends nothing; the next landing sends it once more', async () => {
        const when = at();
        asOnTheStandby(when);
        await render();
        let before = node.requests.length;
        await removeVia('events');
        // Each read asks the edited list, so it carries no tag (another list): a 200.
        expect(trace(before)).toEqual(['GET /api/home 200', 'POST /api/members/preferences 400']);
        // The newcomer's list less Coming up (Your way back in and Notices are on it, drawn when they have something).
        expect(sentIds(posts().at(-1)!)).toEqual(['safety', 'steps', 'tips', 'interests', 'market', 'notices']);
        expect(mem.store.get(markKey())).toBe(when);
        before = node.requests.length;
        await removeVia('market');
        expect(trace(before)).toEqual(['GET /api/home 200']);
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'community']);
        before = node.requests.length;
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(trace(before)).toEqual(['GET /api/home 304', 'POST /api/members/preferences 400']);
        expect(sentIds(posts().at(-1)!)).toEqual(['safety', 'steps', 'tips', 'interests', 'notices']);
    });

    it('an updated node that holds a real empty version-1 list gets the edit right after the read, and the mark is gone', async () => {
        const when = at();
        asOnTheStandby(when);
        node.refuse = 0;
        await render();
        const before = node.requests.length;
        await removeVia('events');
        expect(trace(before)).toEqual(['GET /api/home 200', 'POST /api/members/preferences 200']);
        expect(sentIds(posts().at(-1)!)).toEqual(['safety', 'steps', 'tips', 'interests', 'market', 'notices']);
        expect(mem.store.has(markKey())).toBe(false);
        expect(phoneIds()).toEqual(['safety', 'steps', 'tips', 'interests', 'market', 'notices']);
    });
});

describe('a read that overtakes the first save\'s answer on an empty version-1 list: the newer edit stands and is sent (review of #1701 confirmation, finding 2)', () => {
    const posts = () => node.requests.filter(r => r.method === 'POST' && new URL(r.url).pathname === '/api/members/preferences');
    const ids = (l: unknown) => ((l as { cards?: { id: string }[] } | null)?.cards ?? []).map(c => c.id);
    const phoneIds = () => ids(JSON.parse(mem.store.get(homeLayoutStoreKey(who.identity.publicKey, NODE)) ?? 'null'));
    const sentKey = () => homeLayoutPhoneOnlySentStoreKey(who.identity.publicKey, NODE);
    const stampOf = (l: unknown) => ((l as { updatedAt?: string } | null)?.updatedAt ? Date.parse((l as { updatedAt: string }).updatedAt) : -Infinity);
    // The newcomer's list less Coming up, then less the Market too (Your way back in and Notices are on it).
    const LESS_EVENTS = ['safety', 'steps', 'tips', 'interests', 'market', 'notices'];
    const LESS_BOTH = ['safety', 'steps', 'tips', 'interests', 'notices'];

    function emptyV1(when: string) {
        node.answer = { ...localMember(), layout: { v: 1, order: [], hidden: [], dismissed: {}, updatedAt: when } as never };
        mem.store.delete(homeLayoutStoreKey(who.identity.publicKey, NODE));
    }

    /** The node keeps a layout save at once (the newer by date, as home-preferences.ts does); the first one's answer waits. */
    function slowFirstSave() {
        const real = globalThis.fetch;
        const log: string[] = [];
        let release = () => {};
        const gate = new Promise<void>(r => { release = r; });
        let held = false;
        globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
            const res = await real(input, init);
            if (new URL(String(input)).pathname !== '/api/members/preferences' || init.method !== 'POST' || res.status !== 200) return res;
            const l = JSON.parse(init.body).preferences['home.layout'];
            if (l && stampOf(l) >= stampOf(node.answer.layout)) node.answer = { ...node.answer, layout: l };
            log.push(`POST ${ids(l).join(',')}`);
            if (!held) {
                held = true;
                await gate;
                log.push('answered');
            }
            return res;
        }) as any;
        return { log, release: () => release() };
    }

    /**
     * As home-preferences.ts: the node keeps the newer by date, a date ahead of its clock held to its now (`behindMs`: its
     * clock is that far behind the phone's), and answers what it keeps; the first save's answer waits (`holdFirst`).
     */
    function slowClampedSave(behindMs: number, holdFirst = true) {
        const real = globalThis.fetch;
        const log: string[] = [];
        const kept: number[] = [];
        let release = () => {};
        const gate = new Promise<void>(r => { release = r; });
        let held = !holdFirst;
        globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
            const res = await real(input, init);
            if (new URL(String(input)).pathname !== '/api/members/preferences' || init.method !== 'POST' || res.status !== 200) return res;
            const sent = JSON.parse(init.body).preferences['home.layout'];
            const nodeNow = Date.now() - behindMs;
            const l = sent && stampOf(sent) > nodeNow ? { ...sent, updatedAt: new Date(nodeNow).toISOString() } : sent;
            if (l) kept.push(stampOf(l));
            if (l && stampOf(l) >= stampOf(node.answer.layout)) node.answer = { ...node.answer, layout: l };
            log.push(`POST ${ids(sent).join(',')}`);
            if (!held) {
                held = true;
                await gate;
                log.push('answered');
            }
            return new Response(JSON.stringify({ success: true, 'home.layout': node.answer.layout }), { status: 200 });
        }) as any;
        return { log, kept, release: () => release() };
    }

    for (const [behind, gap] of [[200, 0], [5_000, 0], [200, 400]]) {
        it(`NX1: X1 with the node's clock ${behind} ms behind the phone's${gap ? `, the second edit ${gap} ms after the first` : ''}, so the node dates the first save earlier than sent: both edits stand, on the account too (review of #1715, finding 1)`, async () => {
            emptyV1(iso(Date.now() - 2 * H));
            const save = slowClampedSave(behind);
            await render();
            let before = node.requests.length;
            await removeVia('events');
            expect(trace(before)).toEqual(['GET /api/home 200', 'POST /api/members/preferences 200']);
            // The second edit's read carries the first save back with the node's date, not the one the phone sent.
            if (gap) await act(async () => { await new Promise(r => setTimeout(r, gap)); });
            before = node.requests.length;
            await removeVia('market');
            expect(save.log).not.toContain('answered');
            // (The node's copy of the FIRST save; by now it may hold the second, dated later under a slow runner.)
            expect(save.kept[0]).toBeLessThan(Date.parse(JSON.parse(posts()[0].body).preferences['home.layout'].updatedAt));
            expect(trace(before)).toEqual(['GET /api/home 200', 'POST /api/members/preferences 200']);
            expect(sentIds(posts().at(-1)!)).toEqual(LESS_BOTH);
            save.release();
            await settle();
            expect(cards()).not.toContain('market');
            expect(cards()).not.toContain('events');
            expect(ids(node.answer.layout)).toEqual(LESS_BOTH);
            expect(phoneIds()).toEqual(LESS_BOTH);
            expect(mem.store.has(markKey())).toBe(false);
            expect(mem.store.has(sentKey())).toBe(false);
            // And it stays so at the next landing, which sends nothing: the phone's copy took the node's date from the save's
            // answer (review of #1715, note 1).
            before = node.requests.length;
            await act(async () => { nav.focus?.(); });
            await settle();
            expect(cards()).not.toContain('market');
            expect(ids(node.answer.layout)).toEqual(LESS_BOTH);
            expect(posts().filter(p => node.requests.indexOf(p) >= before)).toEqual([]);
        });
    }

    it('NS2: the member\'s own list, the node\'s clock 5 s behind the phone\'s: one Remove is sent once, and a return sends nothing (review of #1715, note 1)', async () => {
        node.answer = { ...localMember(), layout: { v: 2, cards: [{ id: 'events', type: 'events' }, { id: 'market', type: 'market' }, { id: 'pulse', type: 'pulse' }], dismissed: {}, updatedAt: iso(Date.now() - 2 * H) } as never };
        mem.store.set(homeLayoutStoreKey(who.identity.publicKey, NODE), JSON.stringify(node.answer.layout));
        slowClampedSave(5_000, false);
        await render();
        await removeVia('events');
        expect(posts()).toHaveLength(1);
        expect(ids(node.answer.layout)).toEqual(['market', 'pulse']);
        const before = node.requests.length;
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(trace(before)).toContain('GET /api/home 200');
        expect(posts()).toHaveLength(1);
        expect(cards()).not.toContain('events');
        expect(phoneIds()).toEqual(['market', 'pulse']);
        expect(JSON.parse(mem.store.get(homeLayoutStoreKey(who.identity.publicKey, NODE))!).updatedAt).toBe((node.answer.layout as { updatedAt: string }).updatedAt);
    });

    it('NX1, the edits kept with the mark: the node\'s clock 5 s behind, the app closed before the first save answers and the second edit\'s read failed; opened again, the node\'s copy of the first save is still the phone\'s own, so the newer edit wins and is sent', async () => {
        emptyV1(iso(Date.now() - 2 * H));
        slowClampedSave(5_000);
        await render();
        await removeVia('events');
        expect(posts()).toHaveLength(1);
        node.down = true;
        await removeVia('market');
        expect(cards()).not.toContain('market');
        act(() => root?.unmount());
        host?.remove();
        resetHomeStoreForTests();
        node.down = false;
        const before = node.requests.length;
        await render();
        expect(trace(before)).toEqual(['GET /api/home 200', 'POST /api/members/preferences 200']);
        expect(sentIds(posts().at(-1)!)).toEqual(LESS_BOTH);
        expect(cards()).not.toContain('market');
        expect(ids(node.answer.layout)).toEqual(LESS_BOTH);
        expect(mem.store.has(markKey())).toBe(false);
    });

    it('a date an older build kept with the mark (no print) still loads and still matches the phone\'s own save by its date', async () => {
        emptyV1(iso(Date.now() - 2 * H));
        slowFirstSave();
        await render();
        await removeVia('events');
        const first = JSON.parse(posts()[0].body).preferences['home.layout'].updatedAt;
        node.down = true;
        await removeVia('market');
        act(() => root?.unmount());
        host?.remove();
        resetHomeStoreForTests();
        // As the build before the print kept it: the dates alone.
        mem.store.set(sentKey(), JSON.stringify([first]));
        node.down = false;
        const before = node.requests.length;
        await render();
        expect(trace(before)).toEqual(['GET /api/home 200', 'POST /api/members/preferences 200']);
        expect(sentIds(posts().at(-1)!)).toEqual(LESS_BOTH);
        expect(ids(node.answer.layout)).toEqual(LESS_BOTH);
    });

    it('X1: Remove Coming up, then Remove the Market before the first save answers, and the second edit\'s read answers first: both stand, on the account too', async () => {
        emptyV1(iso(Date.now() - 2 * H));
        const save = slowFirstSave();
        await render();
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'market', 'events', 'community']);
        let before = node.requests.length;
        await removeVia('events');
        expect(trace(before)).toEqual(['GET /api/home 200', 'POST /api/members/preferences 200']);
        // The node has the first save; its answer is still out. The second edit's read answers before it.
        before = node.requests.length;
        await removeVia('market');
        expect(save.log).not.toContain('answered');
        expect(cards()).not.toContain('market');
        expect(cards()).not.toContain('events');
        expect(trace(before)).toEqual(['GET /api/home 200', 'POST /api/members/preferences 200']);
        expect(sentIds(posts().at(-1)!)).toEqual(LESS_BOTH);
        save.release();
        await settle();
        expect(save.log).toEqual([`POST ${LESS_EVENTS.join(',')}`, `POST ${LESS_BOTH.join(',')}`, 'answered']);
        expect(cards()).not.toContain('market');
        expect(ids(node.answer.layout)).toEqual(LESS_BOTH);
        expect(phoneIds()).toEqual(LESS_BOTH);
        expect(mem.store.has(markKey())).toBe(false);
        expect(mem.store.has(sentKey())).toBe(false);
        // And it stays so: the next landing sends nothing.
        before = node.requests.length;
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(posts().filter(p => node.requests.indexOf(p) >= before)).toEqual([]);
        expect(cards()).not.toContain('market');
    });

    it('X1, the dates kept with the mark: the app closed before the first save answers and the second edit\'s read failed; opened again, the account\'s list is the phone\'s own save, so the newer edit wins and is sent', async () => {
        emptyV1(iso(Date.now() - 2 * H));
        slowFirstSave();
        await render();
        await removeVia('events');
        expect(posts()).toHaveLength(1);
        expect(JSON.parse(mem.store.get(sentKey())!)).toEqual([{ at: JSON.parse(posts()[0].body).preferences['home.layout'].updatedAt, print: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
        node.down = true;
        await removeVia('market');
        expect(cards()).not.toContain('market');
        // The app is closed: the first save's answer reaches no screen.
        act(() => root?.unmount());
        host?.remove();
        resetHomeStoreForTests();
        node.down = false;
        const before = node.requests.length;
        await render();
        expect(trace(before)).toEqual(['GET /api/home 200', 'POST /api/members/preferences 200']);
        expect(sentIds(posts().at(-1)!)).toEqual(LESS_BOTH);
        expect(cards()).not.toContain('market');
        expect(cards()).not.toContain('events');
        expect(ids(node.answer.layout)).toEqual(LESS_BOTH);
        expect(mem.store.has(markKey())).toBe(false);
        expect(mem.store.has(sentKey())).toBe(false);
    });

    it('a standby\'s refusal keeps the mark and the date sent under it; the primary back with the member\'s real list still wins, nothing more is sent, and both go', async () => {
        const when = iso(Date.now() - 2 * H);
        emptyV1(when);
        node.refuse = 400;
        await render();
        await removeVia('events');
        expect(posts().map(p => p.status)).toEqual([400]);
        expect(mem.store.get(markKey())).toBe(when);
        expect(JSON.parse(mem.store.get(sentKey())!)).toEqual([{ at: JSON.parse(posts()[0].body).preferences['home.layout'].updatedAt, print: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
        await removeVia('market');
        expect(posts()).toHaveLength(1);
        node.refuse = 0;
        node.answer = { ...localMember(), layout: { v: 2, cards: [
            { id: 'pulse', type: 'pulse' }, { id: 'search-k2x7', type: 'search', settings: { q: 'eggs', kind: 'any' } }, { id: 'market', type: 'market' },
        ], dismissed: {}, updatedAt: when } as never };
        const before = node.requests.length;
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(posts().filter(p => node.requests.indexOf(p) >= before)).toEqual([]);
        expect(cards()).toEqual(['pulse', 'search-k2x7', 'market', 'community']);
        expect(mem.store.has(markKey())).toBe(false);
        expect(mem.store.has(sentKey())).toBe(false);
    });

    it('Sign Out takes the mark and the dates sent under it with the account', async () => {
        emptyV1(iso(Date.now() - 2 * H));
        node.refuse = 400;
        await render();
        await removeVia('events');
        expect(mem.store.has(markKey())).toBe(true);
        expect(mem.store.has(sentKey())).toBe(true);
        announceAccountOnPhone(null);
        await act(async () => { await wipeIdentityScopedStorage(AsyncStorage as never); });
        expect(mem.store.has(markKey())).toBe(false);
        expect(mem.store.has(sentKey())).toBe(false);
    });
});

describe('two saved searches: each is named by its words, never in its caption, and its line promises no rows (review of #1699, finding 4)', () => {
    it('their "…", the menu, Edit home and the removed line each say the words, bounded; the caption stays the type\'s', async () => {
        const long = 'second hand children\'s bicycles near the school';
        const mine = { v: 2, cards: [
            { id: 'search-k2x7', type: 'search', settings: { q: 'eggs', kind: 'any' } },
            { id: 'search-m4p9', type: 'search', settings: { q: long, kind: 'any' } },
            { id: 'pulse', type: 'pulse' },
        ], dismissed: {}, updatedAt: iso(Date.now() - 72 * H) };
        node.answer = { ...localMember(), layout: mine as never };
        mem.store.set(homeLayoutStoreKey(who.identity.publicKey, NODE), JSON.stringify(mine));
        await render();
        expect(cards().slice(0, 2)).toEqual(['search-k2x7', 'search-m4p9']);
        const bounded = '"second hand children\'s b…"';
        for (const id of ['search-k2x7', 'search-m4p9']) {
            const card = document.querySelector(`[data-testid="home-card-${id}"]`)!;
            // The caption is the type's name; the words are the body's (and the labels').
            expect(card.querySelector('[role="heading"]')!.textContent).toBe('A saved search');
            expect(card.querySelector('[role="heading"]')!.getAttribute('aria-label')).toBe('A saved search');
            expect(card.querySelector('[data-testid="home-search-waiting"]')!.textContent).toBe('Its listings show in a coming app update.');
            expect(card.textContent).not.toContain('Shows when your community answers');
        }
        expect(byLabel('Card options for "eggs"')).not.toBeNull();
        expect(byLabel(`Card options for ${bounded}`)).not.toBeNull();
        expect(byLabel('Card options for A saved search')).toBeNull();
        await act(async () => { byLabel('Card options for "eggs"')!.click(); });
        expect(byLabel('Move "eggs" down')).not.toBeNull();
        expect(byLabel('Settings for "eggs"')).not.toBeNull();
        // The menu's title is the card's name, drawn; only its labels carry the words.
        expect(document.querySelector('[role="heading"][aria-label=\'Card options for "eggs"\']')!.textContent).toBe('A saved search');
        await act(async () => { byLabel('Remove "eggs" from Home')!.click(); });
        await settle();
        expect(vi.mocked(AccessibilityInfo.announceForAccessibility)).toHaveBeenCalledWith('"eggs" removed. Add a card brings it back.');
        expect(cards()).not.toContain('search-k2x7');
        // Edit home: the row shows the type's name; its arrows and "…" say the words.
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        const row = document.querySelector('[data-testid="edit-home-search-m4p9"]')!;
        expect(row.textContent).toContain('A saved search');
        expect(row.textContent).not.toContain('bicycles');
        expect(byLabel(`Move ${bounded} down`)).not.toBeNull();
        expect(byLabel(`Card options for ${bounded}`)).not.toBeNull();
    });

    it('a new saved search is announced by its words', async () => {
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-add-card"]') as HTMLElement).click(); });
        await act(async () => { byLabel('Add A saved search to Home')!.click(); });
        await settle(2);
        const input = document.querySelector('[data-testid="card-settings-words"]') as HTMLInputElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'duck eggs');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { (document.querySelector('[data-testid="card-settings-done"]') as HTMLElement).click(); });
        await settle();
        expect(vi.mocked(AccessibilityInfo.announceForAccessibility)).toHaveBeenCalledWith('"duck eggs" added to Home');
    });
});

describe('the global node is never asked for a card it doesn\'t show (review of #1699, finding 5)', () => {
    it('a member for 60 days with a version-1 list: no read asks Beans, deals, enterprise or Decide', async () => {
        const base = globalMember(60);
        node.answer = { ...base, layout: { v: 1, order: ['pulse'], hidden: [], dismissed: {}, updatedAt: iso(Date.now() - 72 * H) } as never };
        mem.store.delete(homeLayoutStoreKey(who.identity.publicKey, NODE));
        await render();
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(homeReads().length).toBeGreaterThan(1);
        for (const asked of homeCards()) {
            for (const off of ['beans', 'deals', 'enterprise', 'decide']) expect(asked).not.toContain(off);
        }
        // The member's list is asked for what the node shows: The Pulse, Who joined.
        expect(homeCards().at(-1)).toEqual(expect.arrayContaining(['pulse', 'joined', 'groups']));
        expect(cards()).not.toContain('decide');
    });
});

describe('a local community\'s Home is H2\'s, whatever the answer or the phone holds (H4 changes nothing there)', () => {
    it('no Find your community, names and faces in Who joined, what\'s new first, no limits sentence, and no place sent', async () => {
        const a = localMember();
        node.answer = {
            ...a,
            me: { ...a.me!, probation: globalMember().me!.probation },
            cards: {
                ...a.cards,
                // What a local node never sends: the phone draws none of it.
                find: findBody(),
                market: { ...a.cards.market!, items: a.cards.market!.items.map((p, i) => ({ ...p, distanceKm: [9, 1, 4][i] })) },
            },
        };
        rememberProfile('local');
        loc.status = 'granted';
        loc.last = { coords: { latitude: -28.643_21, longitude: 153.612_34 } };
        await render();
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
        expect(document.querySelector('[data-testid="home-card-find"]')).toBeNull();
        expect(document.querySelector('[data-testid="home-joined-line"]')?.getAttribute('aria-label')).toBe('Ana, Kofi and 3 more joined this week. Opens People.');
        expect(Array.from(document.querySelectorAll('[data-avatar]')).map(e => e.getAttribute('data-avatar'))).toEqual(['Ana', 'Kofi']);
        expect(marketOrder()).toEqual(['p1', 'p2', 'p3']);
        expect(document.querySelector('[data-testid="home-steps-limits"]')).toBeNull();
        expect(byLabel('Post your first Offer, not done yet')).not.toBeNull();
        expect(new URL(homeReads()[0].url).searchParams.has('lat')).toBe(false);
        expect(node.requests.map(r => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /api/home']);
        // Edit home offers no Find your community, and says nothing of a pin.
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(editRows()).not.toContain('find');
        expect(document.querySelector('[data-modal]')?.textContent).not.toContain('first 30 days');
    });
});

// ── Tips (scratch/home/TIPS-DESIGN-fable.md §1, §6 item 3) ──────────────────────────────────────────────────────────

describe('the Tips card: one tip at a time, and it ends', () => {
    const tipText = () => document.querySelector('[data-testid="home-tip-text"]')?.textContent ?? null;
    const tipsRecord = () => JSON.parse(mem.store.get(homeTipsStoreKey(who.identity.publicKey)) ?? 'null');
    const text = (id: string) => HOME_TIPS.find(t => t.id === id)!.text;
    const LOCAL_IDS = ['what-this-is', 'offer', 'beans', 'price', 'words', 'map', 'messages', 'deal', 'credit', 'levels', 'invites', 'groups', 'votes', 'private', 'guide'];
    const again = async () => {
        act(() => root?.unmount());
        host?.remove();
        await render();
    };

    it('a new member lands on the first tip, 1 of 15; Next draws the next one in place, announces it, and keeps focus on the same button', async () => {
        await render();
        expect(cards().slice(0, 3)).toEqual(['steps', 'tips', 'interests']);
        expect(document.querySelector('[data-testid="home-card-tips"]')?.textContent).toContain('Tips · 1 of 15');
        expect(tipText()).toBe(text('what-this-is'));
        const next = document.querySelector('[data-testid="home-tip-next"]') as HTMLElement;
        expect(next.getAttribute('aria-label')).toBe('Next tip');
        const page = getBundledGuide().guides.find(g => g.slug === 'how-it-works')!.title;
        expect(document.querySelector('[data-testid="home-tip-read-more"]')?.getAttribute('aria-label')).toBe(`Read more in the guide: ${page}`);
        await act(async () => { next.click(); });
        await settle();
        expect(tipText()).toBe(text('offer'));
        expect(document.querySelector('[data-testid="home-card-tips"]')?.textContent).toContain('Tips · 2 of 15');
        expect(document.querySelector('[data-testid="home-tip-next"]')).toBe(next);
        expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(text('offer'));
        expect(tipsRecord()).toMatchObject({ seen: ['what-this-is'], current: 'offer', currentShownOn: localDay(), dismissedAt: null });
        // Never asked of the node: the address, and so its tag, is what it was.
        for (const r of homeReads()) expect(new URL(r.url).searchParams.get('cards') ?? '').not.toMatch(/\btips\b/);
    });

    it('Read more opens the tip\'s guide page', async () => {
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-tip-read-more"]') as HTMLElement).click(); });
        expect(nav.router.push).toHaveBeenCalledWith({ pathname: '/guide/[slug]', params: { slug: 'how-it-works' } });
    });

    it('a landing on a later day advances once; the same day does not', async () => {
        mem.store.set(homeTipsStoreKey(who.identity.publicKey), JSON.stringify({ v: 1, seen: [], current: 'what-this-is', currentShownOn: '2020-01-01', dismissedAt: null }));
        await render();
        expect(tipText()).toBe(text('offer'));
        expect(tipsRecord()).toMatchObject({ seen: ['what-this-is'], current: 'offer', currentShownOn: localDay() });
        await again();
        expect(tipText()).toBe(text('offer'));
        expect(tipsRecord().seen).toEqual(['what-this-is']);
    });

    it('Done on the last tip: the card goes, and Edit home says "All tips seen"; Remove and Add a card again starts over', async () => {
        mem.store.set(homeTipsStoreKey(who.identity.publicKey), JSON.stringify({ v: 1, seen: LOCAL_IDS.filter(id => id !== 'guide'), current: 'guide', currentShownOn: localDay(), dismissedAt: null }));
        await render();
        const done = document.querySelector('[data-testid="home-tip-next"]') as HTMLElement;
        expect(done.textContent).toBe('Done');
        expect(done.getAttribute('aria-label')).toBe('Done with tips. The card goes.');
        expect(document.querySelector('[data-testid="home-card-tips"]')?.textContent).toContain('Tips · 15 of 15');
        await act(async () => { done.click(); });
        await settle();
        expect(cards()).not.toContain('tips');
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        expect(document.querySelector('[data-testid="edit-home-tips"]')?.textContent).toContain('All tips seen');
        await act(async () => { (document.querySelector('[data-testid="edit-home-tips-menu"]') as HTMLElement).click(); });
        await act(async () => { byLabel('Remove Tips from Home')!.click(); });
        await settle();
        await act(async () => { (document.querySelector('[data-testid="edit-home-add"]') as HTMLElement).click(); });
        await settle(2);
        await act(async () => { byLabel('Add Tips to Home')!.click(); });
        await settle();
        expect(cards()).toContain('tips');
        expect(tipText()).toBe(text('what-this-is'));
    });

    it('Don\'t show tips again: the card goes, the record and the layout say so, the next landing has none; Add a card brings it back from tip 1', async () => {
        await render();
        const dont = document.querySelector('[data-testid="home-tips-dont-show"]') as HTMLElement;
        expect(dont.textContent).toBe("Don't show tips again");
        expect(dont.getAttribute('aria-label')).toBe("Don't show tips again. Edit home brings them back.");
        await act(async () => { dont.click(); });
        await settle();
        expect(cards()).not.toContain('tips');
        expect(tipsRecord().dismissedAt).toEqual(expect.any(String));
        const ids = (l: { cards: { id: string }[] }) => l.cards.map(c => c.id);
        expect(ids(JSON.parse(mem.store.get(homeLayoutStoreKey(who.identity.publicKey, NODE))!))).not.toContain('tips');
        const post = node.requests.find(r => r.method === 'POST')!;
        expect(ids(JSON.parse(post.body).preferences['home.layout'])).not.toContain('tips');
        expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Tips removed. Add a card brings it back.');
        await again();
        expect(cards()).not.toContain('tips');
        await act(async () => { (document.querySelector('[data-testid="home-add-card"]') as HTMLElement).click(); });
        await act(async () => { byLabel('Add Tips to Home')!.click(); });
        await settle();
        expect(cards()).toContain('tips');
        expect(tipText()).toBe(text('what-this-is'));
        expect(tipsRecord()).toMatchObject({ seen: [], dismissedAt: null });
    });

    // PR #1694 review finding 1: the day advance belongs to the return to Home, whatever the read brings, and nothing
    // moves while Home is in front.
    /** The phone's date moves on a day: the tip on the card was first shown "yesterday". */
    const yesterday = () => {
        const r = tipsRecord();
        mem.store.set(homeTipsStoreKey(who.identity.publicKey), JSON.stringify({ ...r, currentShownOn: '2020-01-01' }));
    };
    /** Something on the node changes while Home stays in front (a 200 with a new answer). */
    const nodeChanges = () => {
        node.answer = { ...node.answer, cards: { ...node.answer.cards, community: { name: 'Mullumbimby', members: 82, tradesThisMonth: 23 } } };
    };
    /** A doorbell that matters to Home, and the read it brings after the settle (3 s). */
    const bell = async () => {
        const ws = vi.mocked(DeviceEventEmitter.addListener).mock.calls.filter(c => c[0] === 'ws_activity').at(-1)![1] as (d: unknown) => void;
        await act(async () => { ws({ type: 'new_post' }); });
        await act(async () => { await new Promise(r => setTimeout(r, 3_300)); });
        await settle();
    };
    /** The two-minute safety read while Home is in front (the interval's own callback, not two minutes of waiting). */
    const polls = () => {
        const spy = vi.spyOn(globalThis, 'setInterval');
        return {
            run: async () => {
                const tick = spy.mock.calls.filter(c => c[1] === HOME_SAFETY_POLL_MS).at(-1)![0] as () => void;
                await act(async () => { tick(); });
                await settle();
            },
            restore: () => spy.mockRestore(),
        };
    };

    it('a return to Home on a later day that the node answers 304 advances the tip once; a doorbell and the poll after it leave it', async () => {
        const poll = polls();
        try {
            await render();
            expect(tipText()).toBe(text('what-this-is'));
            yesterday();
            await act(async () => { nav.focus?.(); });
            await settle();
            expect(homeReads().map(r => r.status)).toEqual([200, 304]);
            expect(tipText()).toBe(text('offer'));
            expect(tipsRecord()).toMatchObject({ seen: ['what-this-is'], current: 'offer', currentShownOn: localDay() });
            // Home stays in front: a doorbell brings a changed answer, then the poll. The tip stays where it is.
            yesterday();
            nodeChanges();
            await bell();
            expect(homeReads().map(r => r.status)).toEqual([200, 304, 200]);
            expect(tipText()).toBe(text('offer'));
            node.answer = { ...node.answer, cards: { ...node.answer.cards, community: { name: 'Mullumbimby', members: 83, tradesThisMonth: 23 } } };
            await poll.run();
            expect(homeReads().map(r => r.status)).toEqual([200, 304, 200, 200]);
            expect(tipText()).toBe(text('offer'));
            expect(tipsRecord().seen).toEqual(['what-this-is']);
        } finally { poll.restore(); }
    }, 20_000);

    it('the app coming back on a later day with the community out of reach advances the tip once; a doorbell and the poll once it answers leave it', async () => {
        const poll = polls();
        try {
            await render();
            yesterday();
            node.down = true;
            // The app comes back while Home is in front (AppState 'active'): a return to Home.
            const resume = vi.mocked(AppState.addEventListener).mock.calls.filter(c => c[0] === 'change').at(-1)![1] as (s: string) => void;
            await act(async () => { resume('active'); });
            await settle();
            expect(homeReads().map(r => r.status)).toEqual([200, 0]);
            expect(document.querySelector('[data-testid="home-offline-note"]')).not.toBeNull();
            expect(tipText()).toBe(text('offer'));
            // The community answers again while Home stays in front: nothing moves the tip.
            yesterday();
            node.down = false;
            nodeChanges();
            await bell();
            expect(homeReads().map(r => r.status)).toEqual([200, 0, 200]);
            expect(tipText()).toBe(text('offer'));
            node.answer = { ...node.answer, cards: { ...node.answer.cards, community: { name: 'Mullumbimby', members: 83, tradesThisMonth: 23 } } };
            await poll.run();
            expect(homeReads().map(r => r.status)).toEqual([200, 0, 200, 200]);
            expect(tipText()).toBe(text('offer'));
            expect(tipsRecord().seen).toEqual(['what-this-is']);
        } finally { poll.restore(); }
    }, 20_000);

    // Finding 6: the tip a restart draws is the record's, from that day, so it moves on the next day's landing.
    it('Tips added again records tip 1 as shown today, so the next day\'s landing moves on from it', async () => {
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-tips-dont-show"]') as HTMLElement).click(); });
        await settle();
        await act(async () => { (document.querySelector('[data-testid="home-add-card"]') as HTMLElement).click(); });
        await act(async () => { byLabel('Add Tips to Home')!.click(); });
        await settle();
        expect(tipText()).toBe(text('what-this-is'));
        expect(tipsRecord()).toMatchObject({ seen: [], current: 'what-this-is', currentShownOn: localDay(), dismissedAt: null });
        yesterday();
        await again();
        expect(tipText()).toBe(text('offer'));
    });

    // Finding 2: a node older than `tips` keeps the layout without it, so the switch-off must hold through the record.
    it('Remove on Tips from Edit home is "Don\'t show tips again": it holds on the next landing', async () => {
        await render();
        expect(cards()).toContain('tips');
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        await act(async () => { (document.querySelector('[data-testid="edit-home-tips-menu"]') as HTMLElement).click(); });
        await act(async () => { byLabel('Remove Tips from Home')!.click(); });
        await settle();
        expect(cards()).not.toContain('tips');
        expect(tipsRecord().dismissedAt).toEqual(expect.any(String));
        expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Tips removed. Add a card brings it back.');
        // The node keeps the list as sent.
        const sent = JSON.parse(node.requests.filter(r => r.method === 'POST').at(-1)!.body).preferences['home.layout'];
        expect(sent.cards.map((c: { id: string }) => c.id)).not.toContain('tips');
        node.answer = { ...node.answer, layout: sent };
        await again();
        expect(cards()).not.toContain('tips');
    });

    // Finding 3: Reset to defaults shows Tips again, so it starts the tips over (as switching it on does).
    it('Reset to defaults after "Don\'t show tips again" draws the card again, from tip 1', async () => {
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-tip-next"]') as HTMLElement).click(); });
        await act(async () => { (document.querySelector('[data-testid="home-tips-dont-show"]') as HTMLElement).click(); });
        await settle();
        expect(cards()).not.toContain('tips');
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        await act(async () => { (document.querySelector('[data-testid="edit-home-reset"]') as HTMLElement).click(); });
        await settle();
        expect(document.querySelector('[data-testid="edit-home-tips"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="edit-home-tips"]')?.textContent).not.toContain('Nothing to show now');
        expect(cards()).toContain('tips');
        expect(tipText()).toBe(text('what-this-is'));
        expect(tipsRecord()).toMatchObject({ seen: [], current: 'what-this-is', currentShownOn: localDay(), dismissedAt: null });
    });

    it('the record holds on a node that drops the unknown id: a dismissed record keeps the card away though the layout shows it', async () => {
        mem.store.set(homeTipsStoreKey(who.identity.publicKey), JSON.stringify({ v: 1, seen: [], current: null, currentShownOn: null, dismissedAt: '2026-10-08T00:00:00.000Z' }));
        await render();
        expect(cards()).not.toContain('tips');
    });

    it('a visitor on the global node gets no tips; a suspended member still does', async () => {
        node.answer = visitorAnswer();
        await render();
        expect(cards()).not.toContain('tips');
        node.answer = { ...localMember(), me: { ...localMember().me!, standing: 'suspended' } };
        await again();
        expect(cards()).toContain('tips');
    });
});

describe('the frame on screen: the fewer-cards line, the standby tie, a newer app\'s card, Settings… (CARD-FRAME §1.3, §2.6; review of #1697)', () => {
    const DAY = 24 * H;
    const phoneKey = () => homeLayoutStoreKey(who.identity.publicKey, NODE);
    const fewerLines = () => Array.from(document.querySelectorAll('[data-testid="home-fewer"]'));
    const posts = () => node.requests.filter(r => r.method === 'POST' && new URL(r.url).pathname === '/api/members/preferences');
    const sentList = (r: { body: string }) => JSON.parse(r.body).preferences['home.layout'].cards as { id: string; type: string; settings?: unknown }[];
    const again = async () => {
        act(() => root?.unmount());
        host?.remove();
        await render();
    };
    /** A member here a month, before the frame: the node keeps no list for them (they never edited). */
    const longStanding = (layout: unknown): HomeAnswer => ({ ...localMember(), me: { ...localMember().me!, joinedAt: iso(Date.now() - 30 * DAY) }, layout: layout as never });

    it('a member who never edited: "Home now starts with fewer cards" shows once, under the first card, and never on a later landing', async () => {
        node.answer = longStanding(null);
        mem.store.delete(phoneKey());
        await render();
        expect(fewerLines()).toHaveLength(1);
        expect(fewerLines()[0].textContent).toContain(FEWER_CARDS_LINE);
        // Drawn with the newcomer's list (§3), under the first card (where the one-time hint goes).
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'market', 'events', 'community']);
        const first = document.querySelector('[data-testid="home-card-steps"]')!;
        expect(first.compareDocumentPosition(fewerLines()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(document.querySelector('[data-testid="home-card-tips"]')!.compareDocumentPosition(fewerLines()[0]) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
        // Nothing is written for them: they still never edited.
        expect(mem.store.has(phoneKey())).toBe(false);
        expect(posts()).toHaveLength(0);
        await again();
        expect(fewerLines()).toHaveLength(0);
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(fewerLines()).toHaveLength(0);
    });

    // Review of #1699 (confirmation), finding 2: an empty version-1 list (a way-back dismissal on an older app, the web's
    // Reset) is unknown, so the newcomer's list is drawn; such a member never moved or hid a card, so the line is theirs.
    it('P2: a member whose account list is an empty version 1 (only a way-back dismissal) and who has no copy here sees the line once', async () => {
        node.answer = longStanding({ v: 1, order: [], hidden: [], dismissed: { safety: iso(Date.now() - 20 * DAY) }, updatedAt: iso(Date.now() - 20 * DAY) });
        mem.store.delete(phoneKey());
        await render();
        expect(cards()).toEqual(['steps', 'tips', 'interests', 'market', 'events', 'community']);
        expect(fewerLines()).toHaveLength(1);
        expect(fewerLines()[0].textContent).toContain(FEWER_CARDS_LINE);
        expect(posts()).toHaveLength(0);
        await again();
        expect(fewerLines()).toHaveLength(0);
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(fewerLines()).toHaveLength(0);
    });

    it('never for a member who edited: a version-1 list from an older app, a version-2 list, or an edit kept only on this phone', async () => {
        node.answer = longStanding({ v: 1, order: ['beans'], hidden: ['pulse'], dismissed: {}, updatedAt: iso(Date.now() - 72 * H) });
        mem.store.delete(phoneKey());
        await render();
        expect(cards()[0]).toBe('beans');
        expect(fewerLines()).toHaveLength(0);

        act(() => root?.unmount());
        host?.remove();
        mem.store.clear();
        resetHomeStoreForTests();
        mem.store.set('beanpool_anchor_url', NODE);
        node.answer = longStanding(everyV1Card(Date.now()));
        await render();
        expect(fewerLines()).toHaveLength(0);

        act(() => root?.unmount());
        host?.remove();
        mem.store.clear();
        resetHomeStoreForTests();
        mem.store.set('beanpool_anchor_url', NODE);
        node.answer = longStanding(null);
        mem.store.set(phoneKey(), JSON.stringify({ v: 2, cards: [{ id: 'pulse', type: 'pulse' }, { id: 'market', type: 'market' }], dismissed: {}, updatedAt: iso(Date.now() - H) }));
        await render();
        expect(cards()).toEqual(['pulse', 'market', 'community']);
        expect(fewerLines()).toHaveLength(0);
    });

    it('the standby tie (note b): an empty version-1 list from the account dated exactly like the phone\'s version-2 copy never replaces it, and nothing is sent', async () => {
        const at = iso(Date.now() - 2 * H);
        const mine = {
            v: 2,
            cards: [{ id: 'pulse', type: 'pulse' }, { id: 'search-k2x7', type: 'search', settings: { q: 'eggs', kind: 'any' } }, { id: 'market', type: 'market' }],
            dismissed: {},
            updatedAt: at,
        };
        mem.store.set(phoneKey(), JSON.stringify(mine));
        // What a standby from before the frame answers for that member's version-2 row: no order, nothing hidden, the same date.
        node.answer = { ...localMember(), layout: { v: 1, order: [], hidden: [], dismissed: {}, updatedAt: at } as never };
        await render();
        expect(cards()).toEqual(['pulse', 'search-k2x7', 'market', 'community']);
        expect(document.querySelector('[data-testid="home-search-words"]')?.textContent).toContain('eggs');
        expect(JSON.parse(mem.store.get(phoneKey())!)).toEqual(mine);
        expect(posts()).toHaveLength(0);
        // The next landing, the same answer read again, holds it too.
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(homeReads()).toHaveLength(2);
        expect(cards()).toEqual(['pulse', 'search-k2x7', 'market', 'community']);
        expect(JSON.parse(mem.store.get(phoneKey())!)).toEqual(mine);
        expect(posts()).toHaveLength(0);
    });

    it.each([
        ['an empty version-1 list dated after the phone\'s copy (another device\'s newer edit, as the standby answers it)', { order: [], hidden: [] }, H],
        ['a version-1 list that names cards, dated exactly like the phone\'s copy', { order: ['beans'], hidden: ['pulse'] }, 0],
    ])('the account\'s version-1 copy never wins over the phone\'s version 2 on these: %s', async (_what, v1, later) => {
        const at = Date.now() - 2 * H;
        const mine = { v: 2, cards: [{ id: 'pulse', type: 'pulse' }, { id: 'market', type: 'market' }], dismissed: {}, updatedAt: iso(at) };
        mem.store.set(phoneKey(), JSON.stringify(mine));
        node.answer = { ...localMember(), layout: { v: 1, ...v1, dismissed: {}, updatedAt: iso(at + later) } as never };
        await render();
        expect(cards()).toEqual(['pulse', 'market', 'community']);
        expect(JSON.parse(mem.store.get(phoneKey())!)).toEqual(mine);
        expect(posts()).toHaveLength(0);
    });

    it('a card of a type this app doesn\'t know (a newer app\'s) is not drawn, and every save made here sends it byte for byte, Reset included', async () => {
        const garden = { id: 'garden-k2x7', type: 'garden', settings: { plot: 7, crops: ['kale', 'Beans'], note: 'ñ “quoted” 🌱', nested: { a: [1, 2.5, null, true] } } };
        const theirs = { v: 2, cards: [{ id: 'events', type: 'events' }, garden, { id: 'market', type: 'market' }, { id: 'pulse', type: 'pulse' }], dismissed: {}, updatedAt: iso(Date.now() - 72 * H) };
        node.answer = { ...localMember(), layout: theirs as never };
        mem.store.set(phoneKey(), JSON.stringify(theirs));
        await render();
        expect(cards()).toEqual(['events', 'market', 'pulse', 'community']);
        const exact = JSON.stringify(garden);

        // Remove, from the card's "…".
        await act(async () => { byLabel('Card options for The Pulse')!.click(); });
        await act(async () => { byLabel('Remove The Pulse from Home')!.click(); });
        await settle();
        expect(posts()).toHaveLength(1);
        expect(posts()[0].body).toContain(exact);
        expect(sentList(posts()[0]).map(c => c.id)).toEqual(['events', 'garden-k2x7', 'market']);

        // Move down, from the card's "…": Coming up passes the Market on screen; the unseen card keeps its place.
        await act(async () => { byLabel('Card options for Coming up')!.click(); });
        await act(async () => { byLabel('Move Coming up down')!.click(); });
        await settle();
        const moved = posts().at(-1)!;
        expect(moved.body).toContain(exact);
        expect(sentList(moved).map(c => c.id)).toEqual(['market', 'garden-k2x7', 'events']);

        // Reset to defaults, from Edit home: the newcomer's list, and the unseen card kept at its end.
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        await act(async () => { (document.querySelector('[data-testid="edit-home-reset"]') as HTMLElement).click(); });
        await settle();
        const reset = posts().at(-1)!;
        expect(reset.body).toContain(exact);
        expect(sentList(reset).at(-1)).toEqual(garden);
        expect(cards()).not.toContain('garden-k2x7');
        // Every save sent it, and the phone's copy keeps it.
        for (const p of posts()) expect(p.body).toContain(exact);
        expect(mem.store.get(phoneKey())!).toContain(exact);
    });

    it('Settings… from a card\'s "…" opens its sheet with the words it has; Save changes them in place and says nothing is moved', async () => {
        const mine = {
            v: 2,
            cards: [{ id: 'events', type: 'events' }, { id: 'search-k2x7', type: 'search', settings: { q: 'eggs', kind: 'any' } }, { id: 'market', type: 'market' }],
            dismissed: {},
            updatedAt: iso(Date.now() - 72 * H),
        };
        node.answer = { ...localMember(), layout: mine as never };
        mem.store.set(phoneKey(), JSON.stringify(mine));
        await render();
        expect(cards()).toEqual(['events', 'search-k2x7', 'market', 'community']);
        // A type with no settings has no Settings…; the saved search's has.
        await act(async () => { byLabel('Card options for Coming up')!.click(); });
        expect(document.querySelector('[data-testid="home-menu-settings"]')).toBeNull();
        await act(async () => { byLabel('Cancel')!.click(); });
        // Named by its words (review of #1699, finding 4).
        await act(async () => { byLabel('Card options for "eggs"')!.click(); });
        expect(byLabel('Settings for "eggs"')).not.toBeNull();
        await act(async () => { byLabel('Settings for "eggs"')!.click(); });
        await settle(2);
        expect(document.querySelector('[data-testid="card-settings-sheet"]')).not.toBeNull();
        const input = document.querySelector('[data-testid="card-settings-words"]') as HTMLInputElement;
        expect(input.value).toBe('eggs');
        expect(byLabel('Save A saved search')).not.toBeNull();
        expect(byLabel('Add A saved search to Home')).toBeNull();
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'duck eggs');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const before = node.requests.length;
        await act(async () => { byLabel('Save A saved search')!.click(); });
        await settle();
        expect(document.querySelector('[data-testid="card-settings-sheet"]')).toBeNull();
        // In place: the same id, the same spot, the new words; on screen and on the account.
        expect(cards()).toEqual(['events', 'search-k2x7', 'market', 'community']);
        expect(document.querySelector('[data-testid="home-search-words"]')?.textContent).toContain('duck eggs');
        const save = node.requests.slice(before).find(r => r.method === 'POST')!;
        expect(sentList(save)).toEqual([
            { id: 'events', type: 'events' }, { id: 'search-k2x7', type: 'search', settings: { q: 'duck eggs', kind: 'any' } }, { id: 'market', type: 'market' },
        ]);
        expect(boundSignatureValid(save, who.identity.publicKey)).toBe(true);
    });
});
