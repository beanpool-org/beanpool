// @vitest-environment jsdom
/**
 * Deals S4 (scratch/fable-design/DESIGN-deals-fable.md §3.3): the Market's cards on the phone, rendered for real at 320 dp ×
 * 1.3, light and dark. A listing the reader has a deal of their own on carries "🤝 IN TRUST" (held in trust) or "✋ ASKED"
 * (asked for), beside YOU and RECURRING in the list and on the photo's foot in the grid; a listing in someone else's deal
 * says nothing (a chip there would tell a stranger who traded), and nor does a finished one. Core's listingChips, as the
 * web's MarketplaceCard.
 *
 * The Market's harness is market-words-render.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The width every measured view reports (onLayout): the category panel's at 320 dp, 16 dp gutters, -8 dp margins. */
const PANEL_WIDTH = 304;
const alerts = vi.hoisted(() => ({ said: [] as string[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', summary: 'region' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, horizontal, onLayout, value, onChangeText, disabled } = props;
        // A view that measures itself hears the panel's width once, as on a phone.
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: PANEL_WIDTH, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        if (horizontal) attrs['data-horizontal'] = 'true';
        const s = flat(props.style);
        if (s.flexWrap) attrs['data-wrap'] = s.flexWrap;
        if (typeof s.width === 'number') attrs['data-width'] = String(s.width);
        if (typeof s.maxWidth === 'number') attrs['data-max-width'] = String(s.maxWidth);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
        ListHeaderComponent,
        (data ?? []).length
            ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
            : ListEmptyComponent,
        ListFooterComponent);
    class Value { constructor(public v = 0) {} setValue() {} setOffset() {} stopAnimation() {} interpolate() { return this; } addListener() { return ''; } removeListener() {} removeAllListeners() {} }
    const animation = () => ({ start(cb?: () => void) { cb?.(); }, stop() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList,
        Animated: {
            FlatList, View: el('div'), Value, event: () => () => {}, timing: animation, spring: animation, decay: animation,
            diffClamp: () => new Value(), add: () => new Value(), multiply: () => new Value(), subtract: () => new Value(), modulo: () => new Value(),
        },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string) => { alerts.said.push(title); if (body) alerts.said.push(body); } },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Easing: { out: (f: unknown) => f, cubic: () => 0, ease: () => 0, inOut: (f: unknown) => f },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {} },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => params.now,
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
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'denied', canAskAgain: false }), getLastKnownPositionAsync: async () => null,
    requestForegroundPermissionsAsync: async () => ({ status: 'denied' }), getCurrentPositionAsync: async () => null,
}));
vi.mock('react-native-maps', () => ({ default: () => null, Marker: () => null, Circle: () => null, PROVIDER_DEFAULT: 'default' }));
vi.mock('@react-native-community/slider', () => ({ default: () => createElement('input', { type: 'range' }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, authenticateAsync: async () => ({ success: false }) }));
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));
const look = vi.hoisted(() => ({ theme: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const colors = () => (look.theme === 'dark' ? darkColors : lightColors);
    return {
        useTheme: () => ({ theme: look.theme, colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: look.theme, colors: colors() }),
    };
});
const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
// A member's picture: drawn from what they chose, never words.
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
// The poll and event composers are their own screens (NewPollModal, NewEventModal), for a later sweep; closed here.
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: () => null }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../home-store', () => ({ readPhoneInterests: async () => interests.now, saveInterests: async () => {} }));
const interests = vi.hoisted(() => ({ now: [] as string[] }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import { setLanguage } from '@beanpool/core';
import { DrawnInLanguage, LanguageProvider } from '../../components/LanguageProvider';
import { LanguageRow } from '../../components/LanguagePicker';
import { FilterChipPanel } from '../../components/FilterChipPicker';
import { CATEGORY_FILTER_CHIPS } from '../map-filters';
import { TILE_LETTER_DP, TILE_PANEL_PADDING, longestWordLength } from '../filter-chips';
import MarketScreen from '../../app/(tabs)/market';

const NODE = 'https://mullum.example';
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();
const offer = (id: string, title: string, over: Record<string, unknown> = {}) => ({
    id, type: 'offer', status: 'active', title, description: 'Words', category: 'food', author_pubkey: 'kofi-key', author_callsign: 'Kofi',
    author_energy_cycled: 0, credits: 5, price_type: 'fixed', photos: '[]', repeatable: 1, created_at: iso(now - 60_000), ...over,
});
const POSTS = [offer('p-held', 'Duck eggs'), offer('p-asked', 'Long ladder', { lendable: 1, repeatable: 0 }), offer('p-other', 'Maths tutoring'), offer('p-done', 'Bike tune-up')];
const deal = (id: string, postId: string, status: string, over: Record<string, unknown> = {}) => ({
    id, postId, status, buyerPublicKey: ME.publicKey, sellerPublicKey: 'kofi-key', sellerCallsign: 'Kofi', credits: 5, createdAt: iso(now - 60_000), ...over,
});
const TRANSACTIONS = [
    deal('tx-1', 'p-held', 'pending'),
    deal('tx-2', 'p-asked', 'requested'),
    deal('tx-3', 'p-other', 'pending', { buyerPublicKey: 'mia-key', buyerCallsign: 'Mia' }),
    deal('tx-4', 'p-done', 'completed'),
];
function community(): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Record<string, unknown> = {
        getPosts: POSTS, getMarketplaceTransactions: TRANSACTIONS, getMyPosts: [], fetchMyEvents: [],
        getBalance: { isBlockedFromTrading: false }, fetchGroups: [], getMemberRatings: { average: 4, count: 2 },
        signedGet: { status: 200, ok: true, json: async () => ({ feed: [] }) },
    };
    return (name) => (name in answers ? Promise.resolve(answers[name]) : undefined);
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.answer = community();
    params.now = {};
    interests.now = [];
    alerts.said.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true, escrow: true, showcase: false }, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderMarket() {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(MarketScreen)) as any); });
    await settle();
}
/** Each chip, with the title of the card it sits on (the nearest ancestor that holds exactly one of the titles). */
function chips(): Array<[string | null, string]> {
    const titles = POSTS.map(p => p.title);
    return Array.from(host.querySelectorAll('[data-testid="card-deal-chip"]')).map((chip) => {
        let el: Element | null = chip;
        while (el && titles.filter(t => el!.textContent?.includes(t)).length !== 1) el = el.parentElement;
        return [chip.textContent, titles.find(t => el?.textContent?.includes(t)) ?? '?'] as [string | null, string];
    }).sort();
}
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(4); };

for (const theme of ['light', 'dark'] as const) {
    describe(`the Market's chip on a deal of your own, at 320 dp × 1.3 (${theme})`, () => {
        beforeEach(() => { look.theme = theme; });

        it('the list: 🤝 IN TRUST and ✋ ASKED on your own deals, nothing on a stranger\'s or a finished one', async () => {
            await renderMarket();
            expect(host.textContent).toContain('Maths tutoring');
            expect(chips()).toEqual([['✋ ASKED', 'Long ladder'], ['🤝 IN TRUST', 'Duck eggs']]);
        });

        it('the grid: the same chips on the photo\'s foot, in its badge row', async () => {
            await renderMarket();
            await click(host.querySelector('[aria-label="Grid view"]'));
            expect(host.querySelector('[data-testid="grid-badge-row"]')).not.toBeNull();
            expect(chips()).toEqual([['✋ ASKED', 'Long ladder'], ['🤝 IN TRUST', 'Duck eggs']]);
            for (const chip of Array.from(host.querySelectorAll('[data-testid="card-deal-chip"]'))) {
                expect(chip.closest('[data-testid="grid-badge-row"]')).not.toBeNull();
            }
        });
    });
}
