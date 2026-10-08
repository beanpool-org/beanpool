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
import { homeAnswerStoreKey, homeHintStoreKey, homeLayoutStoreKey, homeTipsStoreKey } from '../storage-keys';
import { HOME_TIPS, localDay } from '@beanpool/core';
import { AccessibilityInfo, AppState, DeviceEventEmitter } from 'react-native';
import { HOME_SAFETY_POLL_MS, decideOnNode, mergeNeeds, type HomeAnswer } from '../home-cards';
import { decisionsOn, hiddenTabsFor } from '../node-profile';
import { commonsSectionFor } from '../commons-sections';
import { marketFilterFromLink } from '../market-filters';
import { boundSignatureValid } from './server-signature-check';
import { paramsRead, resolves, tabOf } from './route-resolve';
import { getBundledGuide } from '../guide';

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
const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const homeReads = () => node.requests.filter(r => new URL(r.url).pathname === '/api/home');
const marketOrder = () => Array.from(document.querySelectorAll('[data-testid^="home-market-p"]')).map(e => e.getAttribute('data-testid')!.replace('home-market-', ''));


// ── CONFIRM #1694 fix round 1: what the fix could have broken ─────────────────────────────────────────────────────────
describe('Home tips: when a return to Home lands the tip (PR #1694 confirmation 1)', () => {
    const tipText = () => document.querySelector('[data-testid="home-tip-text"]')?.textContent ?? null;
    const tipsRecord = () => JSON.parse(mem.store.get(homeTipsStoreKey(who.identity.publicKey)) ?? 'null');
    const text = (id: string) => HOME_TIPS.find(t => t.id === id)!.text;
    const idOf = (t: string | null) => (t === null ? null : HOME_TIPS.find(x => x.text === t)?.id ?? '?');
    /** Every tip text the card shows, in order, as the DOM changes (consecutive repeats folded). */
    const watchTips = () => {
        const seen: (string | null)[] = [];
        const look = () => { const t = idOf(tipText()); if (seen.at(-1) !== t) seen.push(t); };
        const mo = new MutationObserver(look);
        mo.observe(document.body, { subtree: true, childList: true, characterData: true });
        return { seen, stop: () => { look(); mo.disconnect(); } };
    };
    const yesterday = () => {
        const r = tipsRecord();
        mem.store.set(homeTipsStoreKey(who.identity.publicKey), JSON.stringify({ ...r, currentShownOn: '2020-01-01' }));
    };

    it('A. first landing, no stored copy, no record: one GET, the tip drawn once (tip 1)', async () => {
        const w = watchTips();
        await render();
        w.stop();
        expect(node.requests.map(r => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /api/home']);
        expect(w.seen.filter(Boolean)).toEqual(['what-this-is']);
    });

    it('B. first landing, no stored copy, yesterday\'s record: the tip drawn once, already advanced (never tip 1 first)', async () => {
        mem.store.set(homeTipsStoreKey(who.identity.publicKey), JSON.stringify({ v: 1, seen: [], current: 'what-this-is', currentShownOn: '2020-01-01', dismissedAt: null }));
        const w = watchTips();
        await render();
        w.stop();
        expect(homeReads().length).toBe(1);
        expect(w.seen.filter(Boolean)).toEqual(['offer']);
    });

    it('C. first landing, no stored copy, an interests save owed (the phone has stars the account here lacks): the Tips card comes with the other cards, not after the save', async () => {
        // A member who starred interests (e.g. on the worldwide community) and lands on a community this phone has no copy of.
        mem.store.set('bp_fav_categories', JSON.stringify(['food']));
        const real = globalThis.fetch;
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        globalThis.fetch = (async (input: any, init: any) => {
            if (String(input).includes('/api/members/preferences')) await gate;
            return real(input, init);
        }) as any;
        await render();
        const before = cards();
        const tipBefore = tipText();
        release();
        await settle();
        expect(before).toContain('tips');
    });

    it('D. a notice opened on a later day (reason "again") leaves the tip; the next return moves it', async () => {
        node.answer = { ...node.answer, cards: { ...node.answer.cards, notices: { unseen: 1, first: { id: 'n1', title: 'Market day moved', line: 'Saturday, not Sunday.' } } } as any };
        await render();
        expect(tipText()).toBe(text('what-this-is'));
        yesterday();
        const readsBefore = homeReads().length;
        await act(async () => { (document.querySelector('[data-testid="home-notice-line"]') as HTMLElement).click(); });
        await settle();
        expect(homeReads().length).toBe(readsBefore + 1);
        expect(tipText()).toBe(text('what-this-is'));
        await act(async () => { nav.focus?.(); });
        await settle();
        expect(tipText()).toBe(text('offer'));
    });

    it('E. Reset to defaults while Tips is on, mid-way (tip 4): what happens to the progress', async () => {
        await render();
        for (let i = 0; i < 3; i++) {
            await act(async () => { (document.querySelector('[data-testid="home-tip-next"]') as HTMLElement).click(); });
            await settle();
        }
        const mid = idOf(tipText());
        const seenBefore = tipsRecord().seen;
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        await act(async () => { (document.querySelector('[data-testid="edit-home-reset"]') as HTMLElement).click(); });
        await settle();
        expect(idOf(tipText())).toBe(mid);
    });

    it('F. Edit home: Remove Tips, then ＋ Add a card brings it back from tip 1; the layout shows it', async () => {
        await render();
        await act(async () => { (document.querySelector('[data-testid="home-tip-next"]') as HTMLElement).click(); });
        await settle();
        const label = (l: string) => document.querySelector(`[aria-label="${l}"]`) as HTMLElement;
        await act(async () => { (document.querySelector('[data-testid="home-edit"]') as HTMLElement).click(); });
        await act(async () => { (document.querySelector('[data-testid="edit-home-tips-menu"]') as HTMLElement).click(); });
        await act(async () => { label('Remove Tips from Home').click(); });
        await settle();
        expect(tipsRecord().dismissedAt).toEqual(expect.any(String));
        expect(cards()).not.toContain('tips');
        await act(async () => { (document.querySelector('[data-testid="edit-home-add"]') as HTMLElement).click(); });
        await settle(2);
        await act(async () => { label('Add Tips to Home').click(); });
        await settle();
        expect(tipsRecord()).toMatchObject({ seen: [], current: 'what-this-is', currentShownOn: localDay(), dismissedAt: null });
        expect(cards()).toContain('tips');
        const ids = JSON.parse(mem.store.get(homeLayoutStoreKey(who.identity.publicKey, NODE))!).cards.map((c: { id: string }) => c.id);
        expect(ids).toContain('tips');
    });
});
