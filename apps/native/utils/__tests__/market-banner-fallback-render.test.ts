// @vitest-environment jsdom
/**
 * An enterprise's shop banner that will not load gives way to the CategoryTile, never an empty box (Pictures S6, review
 * of #2565, finding 8): app/(tabs)/market.tsx rendered for real in each of its three views, and Home's Market row
 * (components/home/HomeCardBodies.tsx MarketBody). A banner fails when the connection is weak, or when the phone holds a
 * URL from before the enterprise replaced or took it down (its key is bound to the photo as it is now). A listing's own
 * photo that fails is healed as before: its listing is read again (utils/photo-refresh.ts), and the tile does not take
 * its place. React Native's host components are plain tags; expo-image's Image is an <img> that carries its URL and its
 * onError, so the test makes it fail as a phone does. The node is the net-spy stand-in for utils/db (market-words-render).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', summary: 'region' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 304, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
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
        Alert: { alert: () => {} },
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
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {} },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => ({}),
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
// The picture as a phone draws it: its URL, and what it does when the picture will not load.
vi.mock('expo-image', () => ({
    Image: ({ source, onError }: { source?: { uri?: string }; onError?: () => void }) => createElement('img', { 'data-src': source?.uri, onError }),
}));
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
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: () => null }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../home-store', () => ({ readPhoneInterests: async () => [], saveInterests: async () => {} }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
const healed = vi.hoisted(() => ({ calls: [] as Array<[string | null | undefined, string | null | undefined]> }));
vi.mock('../photo-refresh', () => ({
    refreshListingAfterPhotoError: (postId: string | null | undefined, url: string | null | undefined) => { healed.calls.push([postId, url]); return true; },
}));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import { setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { MarketBody } from '../../components/home/HomeCardBodies';
import { lightColors } from '../../constants/colors';
import type { HomeMarketItem } from '../home-cards';
import MarketScreen from '../../app/(tabs)/market';

const NODE = 'https://mullum.example';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
// As the phone's copy hands them out (utils/db.ts getPosts): on the node's address.
const BANNER = `${NODE}/api/shops/shop-1/photo?v=ref1&k=Yqpu8qmgAGQ`;
const JAM_PHOTO = `${NODE}/api/marketplace/posts/p-jam/photos/0?v=1791608803169&k=AbCdEf`;

/** An enterprise's photoless listing (its banner), a member's listing with its own photo, and one with neither. */
const POSTS = [
    {
        id: 'p-bread', type: 'offer', status: 'active', title: 'Sourdough from the bakery', description: 'Daily', category: 'food',
        author_pubkey: 'bakery-key', author_callsign: 'Valley Bakery', author_energy_cycled: 0, credits: 5, price_type: 'fixed',
        photos: [], authorBannerUrl: BANNER, created_at: iso(now - 60_000),
    },
    {
        id: 'p-jam', type: 'offer', status: 'active', title: 'Plum jam jars', description: 'Homemade', category: 'food',
        author_pubkey: 'kofi-key', author_callsign: 'Kofi', author_energy_cycled: 0, credits: 3, price_type: 'fixed',
        photos: [JAM_PHOTO], created_at: iso(now - 120_000),
    },
    {
        id: 'p-ladder', type: 'need', status: 'active', title: 'Borrow a long ladder', description: 'Gutters', category: 'tools',
        author_pubkey: 'mia-key', author_callsign: 'Mia', author_energy_cycled: 0, credits: 2, price_type: 'fixed',
        photos: [], created_at: iso(now - 180_000),
    },
];

function community(): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Record<string, unknown> = {
        getPosts: POSTS, getMarketplaceTransactions: [], getMyPosts: [], fetchMyEvents: [],
        getBalance: { isBlockedFromTrading: true }, fetchGroups: [], getMemberRatings: { average: 0, count: 0 },
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
    healed.calls.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true, escrow: true, showcase: false, exampleListings: false }, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function show(screen: unknown) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, screen as any) as any); });
    await settle();
}
/** The card (its outermost button) that shows `title`. */
function cardOf(title: string): HTMLElement {
    const card = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(title) && !b.parentElement?.closest('button'));
    expect(card, `a card for "${title}"`).toBeTruthy();
    return card as HTMLElement;
}
const pictureOf = (card: HTMLElement) => card.querySelector<HTMLImageElement>('img[data-src]');
const tileOf = (card: HTMLElement) => card.querySelector('[data-testid="category-tile"]');
async function failToLoad(img: HTMLImageElement | null) {
    expect(img).not.toBeNull();
    await act(async () => { img!.dispatchEvent(new Event('error')); });
    await settle(2);
}

describe("the Market's cards: a banner that will not load gives way to the tile", () => {
    // The Market opens in list view; its view button goes list → grid → compact.
    it.each([['list', 0], ['grid', 1], ['compact', 2]] as const)('the %s view', async (_view, presses) => {
        await show(createElement(MarketScreen));
        for (let i = 0; i < presses; i++) {
            const toggle = host.querySelector(`[aria-label="${i === 0 ? 'Grid view' : 'Compact view'}"]`);
            expect(toggle).not.toBeNull();
            await act(async () => { (toggle as HTMLElement).click(); });
            await settle(2);
        }

        // The enterprise's listing draws its banner, not the tile.
        const bread = pictureOf(cardOf('Sourdough from the bakery'));
        expect(bread?.getAttribute('data-src')).toBe(BANNER);
        expect(tileOf(cardOf('Sourdough from the bakery'))).toBeNull();
        // It will not load: the tile takes its place, and nothing is read again (a banner is no listing photo).
        await failToLoad(bread);
        expect(pictureOf(cardOf('Sourdough from the bakery'))).toBeNull();
        expect(tileOf(cardOf('Sourdough from the bakery'))).not.toBeNull();
        expect(healed.calls).toEqual([]);

        // A listing's own photo that will not load is healed by its own URL, and stays a picture, as before.
        const jam = pictureOf(cardOf('Plum jam jars'));
        expect(jam?.getAttribute('data-src')).toBe(`${JAM_PHOTO}&size=thumb`);
        await failToLoad(jam);
        expect(healed.calls).toEqual([['p-jam', JAM_PHOTO]]);
        expect(pictureOf(cardOf('Plum jam jars'))).not.toBeNull();
        expect(tileOf(cardOf('Plum jam jars'))).toBeNull();

        // And a listing with neither draws its tile.
        expect(pictureOf(cardOf('Borrow a long ladder'))).toBeNull();
        expect(tileOf(cardOf('Borrow a long ladder'))).not.toBeNull();
    });
});

describe("Home's Market row: a banner that will not load gives way to the tile", () => {
    const items: HomeMarketItem[] = [
        { id: 'h-bread', type: 'offer', title: 'Sourdough from the bakery', category: 'food', credits: 5, photoUrl: null, bannerUrl: '/api/shops/shop-1/photo?v=ref1&k=Yq' },
        { id: 'h-tools', type: 'need', title: 'Borrow a long ladder', category: 'tools', credits: 2, photoUrl: null },
    ];
    const body = (list = items) => createElement(MarketBody, { items: list, examples: false, nodeUrl: NODE, showsBeans: true, colors: lightColors, onSeeAll: () => {} });
    const row = (id: string) => host.querySelector(`[data-testid="home-market-${id}"]`) as HTMLElement;

    it('draws the banner on the node, then the tile once it fails; a new banner is tried again', async () => {
        await show(body());
        const img = row('h-bread').querySelector<HTMLImageElement>('img[data-src]');
        expect(img?.getAttribute('data-src')).toBe(`${NODE}/api/shops/shop-1/photo?v=ref1&k=Yq`);
        expect(row('h-bread').querySelector('[data-testid="category-tile"]')).toBeNull();
        await failToLoad(img);
        expect(row('h-bread').querySelector('img[data-src]')).toBeNull();
        expect(row('h-bread').querySelector('[data-testid="category-tile"]')).not.toBeNull();

        // The enterprise put a new banner up: the next answer's URL is drawn.
        await show(body([{ ...items[0], bannerUrl: '/api/shops/shop-1/photo?v=ref2&k=Zz' }, items[1]]));
        expect(row('h-bread').querySelector('img[data-src]')?.getAttribute('data-src')).toBe(`${NODE}/api/shops/shop-1/photo?v=ref2&k=Zz`);
        expect(row('h-tools').querySelector('[data-testid="category-tile"]')).not.toBeNull();
    });
});
