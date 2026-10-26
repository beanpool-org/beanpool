// @vitest-environment jsdom
/**
 * A keeper finding the enterprise's paused Offers and Needs on the phone:
 * app/treasury-detail.tsx rendered for real.
 *
 * Verifies:
 *  - A keeper of the enterprise sees the "Paused" section listing paused Offers and Needs.
 *  - Tapping one opens the listing (/post/[id]).
 *  - A non-keeper member sees NO Paused section and NO paused listings.
 *  - A visitor sees NO Paused section.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', menu: 'menu', menuitem: 'menuitem' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, placeholder, onLayout, value, onChangeText, disabled, numberOfLines } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.expanded !== undefined) attrs['aria-expanded'] = String(accessibilityState.expanded);
        if (numberOfLines !== undefined) attrs['data-lines'] = String(numberOfLines);
        if (placeholder) attrs.placeholder = placeholder;
        attrs['data-style'] = JSON.stringify(flat(props.style));
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: () => {} },
        Share: { share: async () => ({}) },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
const nav = vi.hoisted(() => ({ pushes: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push(to: unknown) { nav.pushes.push(to); }, navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => params.now,
        ErrorBoundary: () => null,
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-image', () => ({ Image: ({ source }: { source?: { uri?: string } }) => createElement('img', { src: source?.uri }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'a-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return {
        KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardStickyView: pass,
        KeyboardController: { dismiss: async () => {} },
        useKeyboardState: (pick?: (s: { height: number; isVisible: boolean }) => unknown) => (pick ? pick({ height: 0, isVisible: false }) : { height: 0, isVisible: false }),
    };
});
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const colors = () => (theme.dark ? darkColors : lightColors);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors(), patternEnabled: false }),
    };
});

const ME = '1'.repeat(64);
const DAMO = '2'.repeat(64);
const ENT = '7'.repeat(64);
const me = vi.hoisted(() => ({ identity: { publicKey: '1'.repeat(64), callsign: 'Ana' } as Record<string, string> | null }));
vi.mock('../identity', () => ({ loadIdentity: async () => me.identity }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ size }: { size?: number }) => createElement('span', { 'data-avatar': String(size ?? '') }) }));
vi.mock('../node-post', () => ({ signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}), anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null }));
const net = vi.hoisted(() => ({ calls: [] as string[], args: [] as Array<[string, unknown[]]>, answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => { net.args.push([name, args]); return net.answer?.(name, args); }));
vi.mock('../blocklist', () => ({ blockUser: async () => true, isUserBlocked: async () => false }));

import { setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import TreasuryDetailScreen from '../../app/treasury-detail';

const NODE = 'https://mullum.example';
const NAME = "Mullum Eggs";
const SHOP_ID = 'shop-1';

const keepers = [
    { publicKey: ME, callsign: 'Ana', role: 'keeper', avatarUrl: null, tier: 'Resident', rating: { average: 5.0, count: 4 }, trades: 10, offerCategories: ['food'] },
    { publicKey: DAMO, callsign: 'Damo', role: 'lead', avatarUrl: null, tier: 'Resident', rating: { average: 4.8, count: 9 }, trades: 14, offerCategories: ['food'] },
];

function enterpriseDetail(over: Record<string, unknown> = {}) {
    return {
        publicKey: ENT, name: NAME, purpose: 'Pasture eggs for all.', lifecycle: 'ongoing', status: 'active', paused: false,
        balance: 12, creditLine: 50, liveOffers: 1, earnedSurplus: 4, workingCapitalCeiling: null,
        isLeadOrSoleKeeperOrAdmin: true, availableToBack: 0,
        about: 'Fresh pasture eggs daily.', since: '2026-09-03T10:00:00.000Z', offerCategories: ['food'],
        shop: { id: SHOP_ID, category: 'food', counts: { things: 2 }, name: NAME, ownerPublicKey: ENT, ownerName: NAME, enterprise: true, blurb: null, howToDeal: 'Farm gate pickup', paused: false, backOn: null, openedAt: new Date().toISOString() },
        keepers,
        keeperRequests: [], keeperChanges: [], deferredClaims: [],
        posts: [{ id: 'p1', type: 'offer', category: 'food', title: 'Dozen farm eggs', credits: 6, price_type: 'fixed', status: 'active' }],
        flow: [], pendingBids: [], activeDeals: [],
        ...over,
    };
}

const LISTINGS = [
    { id: 'p1', type: 'offer', category: 'food', title: 'Dozen farm eggs', credits: 6, priceType: 'fixed', status: 'active', shopId: SHOP_ID },
    { id: 'p-paused', type: 'offer', category: 'food', title: 'Special duck eggs', credits: 8, priceType: 'fixed', status: 'paused', shopId: SHOP_ID },
];

function community(keeperOf: string[], listings: unknown = LISTINGS, detailOver: Record<string, unknown> = {}): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const detail = enterpriseDetail(detailOver);
    const answers: Record<string, unknown> = {
        getTreasuryDetail: detail,
        getBalance: { balance: 10, keeperOf },
        getEnterpriseThread: { conversation: null, messages: [], readOnly: false },
        getEnterpriseLedger: null,
        getEnterpriseDecisions: null,
    };
    return (name, args) => {
        if (name === 'signedGet') {
            const path = String(args[0]);
            if (path.startsWith(`/api/marketplace/posts?author=${ENT}`)) {
                const isKeeper = path.includes('keeper=1');
                const allListings = Array.isArray(listings) ? listings : [];
                if (isKeeper) {
                    return Promise.resolve({ ok: true, status: 200, json: async () => allListings });
                }
                if (detail.paused || detail.status === 'winding_up' || detail.status === 'completed') {
                    return Promise.resolve({ ok: true, status: 200, json: async () => [] });
                }
                return Promise.resolve({ ok: true, status: 200, json: async () => allListings.filter((l: any) => l.status === 'active') });
            }
            return undefined;
        }
        return name in answers ? Promise.resolve(answers[name]) : undefined;
    };
}

const LOCAL = { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.args.length = 0;
    params.now = { publicKey: ENT, name: NAME };
    nav.pushes.length = 0;
    theme.dark = false;
    me.identity = { publicKey: ME, callsign: 'Ana' };
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: LOCAL, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderScreen() {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(TreasuryDetailScreen)) as any); });
    await settle();
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};

describe('treasury-detail paused section on phone', () => {
    it('shows the Paused section to a keeper with the paused Offer, and tapping opens it', async () => {
        net.answer = community([ENT], LISTINGS);
        await renderScreen();

        expect(host.textContent).toContain('Mullum Eggs');
        expect(host.textContent).toContain('Dozen farm eggs');
        expect(byId('shopfront-paused')).toBeTruthy();
        expect(host.textContent).toContain('Special duck eggs');

        // Tapping opens the listing via router.push({ pathname: '/post/[id]', params: { id } })
        const row = byId('shopfront-row-p-paused');
        await click(row, 'paused row');
        expect(nav.pushes).toContainEqual({ pathname: '/post/[id]', params: { id: 'p-paused' } });
    });

    it('with enterprise season-paused, keeper sections show no live listing and Paused section shows only the paused row', async () => {
        net.answer = community([ENT], LISTINGS, { paused: true });
        await renderScreen();

        expect(host.textContent).toContain('Mullum Eggs');
        // Sections must show empty message: no live listings
        expect(host.textContent).toContain('No live listings yet.');
        expect(host.textContent).not.toContain('Dozen farm eggs');

        // Paused section must be visible and contain the paused listing
        expect(byId('shopfront-paused')).toBeTruthy();
        expect(host.textContent).toContain('Special duck eggs');
    });

    it('a non-keeper member sees NO Paused section and never triggers the keeper read', async () => {
        const notKeeper = enterpriseDetail({ keepers: [{ publicKey: DAMO, callsign: 'Damo', role: 'lead' }] });
        net.answer = (name, _args) => {
            if (name === 'getTreasuryDetail') return Promise.resolve(notKeeper);
            if (name === 'getBalance') return Promise.resolve({ balance: 10, keeperOf: [] });
            if (name === 'signedGet') {
                return Promise.resolve({ ok: true, status: 200, json: async () => [LISTINGS[0]] });
            }
            return undefined;
        };
        await renderScreen();

        expect(host.textContent).toContain('Mullum Eggs');
        expect(host.textContent).toContain('Dozen farm eggs');
        expect(byId('shopfront-paused')).toBeNull();
        expect(host.textContent).not.toContain('Special duck eggs');

        // Must never trigger keeper read
        expect(net.args.some(([name, args]) => name === 'signedGet' && String(args[0]).includes('keeper=1'))).toBe(false);
    });

    it('a visitor sees NO Paused section and never triggers the keeper read', async () => {
        me.identity = null;
        net.answer = community([]);
        await renderScreen();

        expect(host.textContent).toContain('Mullum Eggs');
        expect(byId('shopfront-paused')).toBeNull();
        expect(host.textContent).not.toContain('Special duck eggs');

        // Must never trigger keeper read
        expect(net.args.some(([name, args]) => name === 'signedGet' && String(args[0]).includes('keeper=1'))).toBe(false);
    });
});
