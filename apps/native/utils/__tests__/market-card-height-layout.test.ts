// @vitest-environment jsdom
/**
 * A Market card is its own height, never the screen's (tester Damo, 29 Oct, Android 1.2.83): the only listing on the
 * Market, a photoless Offer, drew its category tile down the whole screen, its words at the top and the card empty
 * below. The tile (components/CategoryTile.tsx) and the list row's picture slot read `height: '100%'`, and Yoga resolves
 * a percentage height against the room the ancestors offer, not the box that is laid out around it: in a list row whose
 * slot takes its height from the text beside it, that room is the whole list (the header, the card, the examples under
 * it), so the card grew to it.
 *
 * market-banner-fallback-render.test.ts draws this screen in jsdom, which has no layout, so a card that fills the screen
 * looks the same there as one that does not. Here the mocks keep each host's style and yoga-dom-layout.ts lays the
 * rendered Market out with Yoga in a short and a tall viewport: the card must come out the same height in both, and be
 * the height of its slot (80 dp at least) or of the text beside it, whichever is taller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { layOut } from './yoga-dom-layout';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', summary: 'region' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, onLayout, value, onChangeText, disabled, style, numberOfLines } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 304, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        // What yoga-dom-layout.ts lays out: the host's style as it was given, and a Text's line limit.
        attrs['data-style'] = JSON.stringify(flat(typeof style === 'function' ? style({ pressed: false }) : style));
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    // A vertical ScrollView around a content container, the cells (a row of `numColumns` for the grid) in it, as the
    // phone's FlatList builds them.
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent, contentContainerStyle, numColumns = 1, columnWrapperStyle }: Record<string, any>) => {
        const items: any[] = data ?? [];
        const rows: any[][] = [];
        for (let i = 0; i < items.length; i += numColumns) rows.push(items.slice(i, i + numColumns));
        const cell = (children: unknown, key: string, style?: unknown) => createElement('div', { key, 'data-style': JSON.stringify(flat(style)) }, children as any);
        return createElement('div', { 'data-testid': 'market-list', 'data-style': JSON.stringify({ flexGrow: 1, flexShrink: 1, overflow: 'scroll' }) },
            createElement('div', { 'data-style': JSON.stringify(flat(contentContainerStyle)) },
                ListHeaderComponent,
                items.length
                    ? rows.map((row, r) => cell(
                        numColumns > 1
                            ? cell(row.map((item, c) => createElement('div', { key: keyExtractor(item, r * numColumns + c), 'data-style': '{"flex":1}' }, renderItem({ item, index: r * numColumns + c }))), 'row', columnWrapperStyle)
                            : renderItem({ item: row[0], index: r }),
                        keyExtractor(row[0], r)))
                    : ListEmptyComponent,
                ListFooterComponent));
    };
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
// The picture as a phone draws it: its URL, its style, and what it does when the picture will not load.
vi.mock('expo-image', () => ({
    Image: ({ source, onError, style }: { source?: { uri?: string }; onError?: () => void; style?: unknown }) => createElement('img', {
        'data-src': source?.uri, 'data-style': JSON.stringify(Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'))), onError,
    }),
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
// The first sync has landed on this copy, so the Market has loaded and may draw its examples.
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => true, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));
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
vi.mock('../photo-refresh', () => ({ refreshListingAfterPhotoError: () => true }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import { setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import MarketScreen from '../../app/(tabs)/market';

const NODE = 'https://mullum.example';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const BANNER = `${NODE}/api/shops/shop-1/photo?v=ref1&k=Yqpu8qmgAGQ`;
const PHOTO = (id: string) => `${NODE}/api/marketplace/posts/${id}/photos/0?v=1791608803169&k=AbCdEf`;

/** Damo's listing: a recurring Offer from an enterprise, in Tech, with no photo and no banner. */
const LONE = {
    id: 'p-network', type: 'offer', status: 'active', title: 'Fundamentals of Network Security', description: 'A course', category: 'tech',
    author_pubkey: 'damo-key', author_callsign: "Damo's Enterprise", author_energy_cycled: 0, credits: 45, price_type: 'fixed', repeatable: 1,
    photos: [], created_at: iso(now - 60_000),
};
/** The same listing from an enterprise that has a shop banner: its card draws the banner. */
const WITH_BANNER = { ...LONE, id: 'p-banner', title: 'Sourdough from the bakery', category: 'food', authorBannerUrl: BANNER };
/** Ten listings of the three kinds. */
const TEN = Array.from({ length: 10 }, (_, i) => ({
    ...LONE, id: `p-${i}`, title: `Listing number ${i} with a title long enough to need a second line`, category: ['tech', 'food', 'tools', 'garden', 'services'][i % 5],
    repeatable: i % 2, credits: i + 1, created_at: iso(now - (i + 1) * 60_000),
    ...(i % 3 === 1 ? { photos: [PHOTO(`p-${i}`)] } : {}),
    ...(i % 3 === 2 ? { authorBannerUrl: BANNER } : {}),
}));

function community(posts: unknown[]): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Record<string, unknown> = {
        getPosts: posts, getMarketplaceTransactions: [], getMyPosts: [], fetchMyEvents: [],
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
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    // The node asks for its example listings, which sit under the real ones while there are few of them: the list a
    // newcomer's first listing is in, and what Damo's phone was drawing.
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true, escrow: true, showcase: false, exampleListings: true }, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function show(posts: unknown[], view: 'list' | 'grid' | 'compact' = 'list') {
    net.answer = community(posts);
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(MarketScreen) as any) as any); });
    await settle();
    // The Market opens in list view; its view button goes list → grid → compact.
    for (let i = 0; i < (view === 'list' ? 0 : view === 'grid' ? 1 : 2); i++) {
        const toggle = host.querySelector(`[aria-label="${i === 0 ? 'Grid view' : 'Compact view'}"]`);
        expect(toggle).not.toBeNull();
        await act(async () => { (toggle as HTMLElement).click(); });
        await settle(2);
    }
}
const list = () => host.querySelector('[data-testid="market-list"]') as HTMLElement;
/** A listing's card: its outermost button. */
function cardOf(title: string): HTMLElement {
    const card = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(title) && !b.parentElement?.closest('button'));
    expect(card, `a card for "${title}"`).toBeTruthy();
    return card as HTMLElement;
}

// 320 dp wide at 1.3x text, in the phone's own height and in two much taller ones (a tablet, a foldable): a card that is
// its own height comes out the same in all of them.
const WIDTH = 320;
const HEIGHTS = [569, 1200, 2400];
const lay = (height: number) => layOut(list(), { width: WIDTH, height }, { fontScale: 1.3 });
const heightsAcross = (el: Element) => HEIGHTS.map((h) => lay(h).height(el));
/**
 * What a list row's text column needs, from where its children sit: the column is stretched to the card, so its own height
 * says nothing about the card. The 12 dp of padding above and below.
 */
const PADDING = 24;
function textNeeds(l: ReturnType<typeof lay>, text: Element): number {
    const first = text.firstElementChild!;
    const last = text.lastElementChild!;
    return l.box(last).top + l.height(last) - l.box(first).top + PADDING;
}

describe("a list-view card is its own height, never the screen's", () => {
    it("Damo's only listing, a photoless Offer with the examples under it: the card is its slot or its text, whichever is taller", async () => {
        await show([LONE]);
        // The examples are in the list, as on his phone: the room that used to be the card's.
        expect(host.querySelector('[data-testid="example-listings"]')).not.toBeNull();
        const card = cardOf(LONE.title);
        const row = card.firstElementChild as HTMLElement;   // the card itself: picture slot, then the text column
        const tile = row.querySelector('[data-testid="category-tile"]') as HTMLElement;
        expect(tile).not.toBeNull();
        const slot = tile.parentElement as HTMLElement;
        const text = row.lastElementChild as HTMLElement;

        for (const height of HEIGHTS) {
            const l = lay(height);
            // The card (a 1 dp border all round) is as tall as its slot, 80 dp at least, or the text beside it.
            expect(l.height(row), `card at ${height} dp`).toBeCloseTo(Math.max(80, textNeeds(l, text)) + 2, 1);
            // The tile fills its slot and no more.
            expect(l.height(tile), `tile at ${height} dp`).toBeCloseTo(l.height(slot), 1);
            expect(l.height(slot), `slot at ${height} dp`).toBeCloseTo(l.height(row) - 2, 1);
            expect(l.width(slot)).toBe(80);
        }
        // And well short of the screen, on a phone and on a tall one.
        expect(Math.max(...heightsAcross(row))).toBeLessThan(250);
        expect(new Set(heightsAcross(row)).size).toBe(1);
    });

    it("an enterprise's listing with its banner is its own height; its banner failing to load gives the tile, still its own height", async () => {
        await show([WITH_BANNER]);
        const row = () => cardOf(WITH_BANNER.title).firstElementChild as HTMLElement;
        const picture = () => row().querySelector('img[data-src]') as HTMLImageElement | null;
        expect(picture()?.getAttribute('data-src')).toBe(BANNER);
        expect(row().querySelector('[data-testid="category-tile"]')).toBeNull();
        const bannerHeights = heightsAcross(row());
        expect(new Set(bannerHeights).size).toBe(1);
        expect(bannerHeights[0]).toBeLessThan(250);
        // The slot is the picture itself, and fills the card's height.
        for (const height of HEIGHTS) expect(lay(height).height(picture()!)).toBeCloseTo(lay(height).height(row()) - 2, 1);

        // The banner will not load (a weak connection, or a URL from before the enterprise changed it): the tile.
        await act(async () => { picture()!.dispatchEvent(new Event('error')); });
        await settle(2);
        const tile = row().querySelector('[data-testid="category-tile"]') as HTMLElement;
        expect(tile).not.toBeNull();
        const tileHeights = heightsAcross(row());
        expect(new Set(tileHeights).size).toBe(1);
        expect(tileHeights[0]).toBeLessThan(250);
        for (const height of HEIGHTS) expect(lay(height).height(tile)).toBeCloseTo(lay(height).height(row()) - 2, 1);
    });

    it('ten listings, with and without a photo or a banner: every card is its own height, the same in a short and a tall viewport', async () => {
        await show(TEN);
        const rows = TEN.map((p) => cardOf(p.title).firstElementChild as HTMLElement);
        expect(rows).toHaveLength(10);
        for (const height of HEIGHTS) {
            const l = lay(height);
            rows.forEach((row, i) => {
                const text = row.lastElementChild as HTMLElement;
                expect(l.height(row), `card ${i} at ${height} dp`).toBeCloseTo(Math.max(80, textNeeds(l, text)) + 2, 1);
                expect(l.height(row), `card ${i} at ${height} dp`).toBeLessThan(250);
            });
        }
        // The cards stack: nothing is as tall as the list, which is what the ten of them together come to.
        const l = lay(569);
        const total = rows.reduce((sum, row) => sum + l.height(row), 0);
        expect(total).toBeGreaterThan(rows.length * 80);
        expect(total).toBeLessThan(rows.length * 250);
    });
});

describe('the grid and compact views keep their cards their own height too', () => {
    it.each([['grid', 1], ['grid', 10], ['compact', 1], ['compact', 10]] as const)('%s view with %i listing(s)', async (view, count) => {
        const posts = count === 1 ? [LONE] : TEN;
        await show(posts, view);
        for (const p of posts) {
            const card = cardOf(p.title);
            const heights = heightsAcross(card);
            expect(new Set(heights).size, `${p.title}: ${heights.join(', ')}`).toBe(1);
            expect(heights[0], p.title).toBeLessThan(view === 'grid' ? 400 : 120);
        }
    });
});

// The Market's fill (market-fill.ts): on a community that reads by area, a short nearby list is followed, in the list's
// footer, by the newest from elsewhere. Those cards sit in views of their own (a plain one in the list view, a row of two
// in the grid), so each view is laid out with Yoga here too.
describe('the fill beneath a short nearby list: its cards are their own height, in every view', () => {
    const FAR = Array.from({ length: 4 }, (_, i) => ({
        id: `far-${i}`, type: 'offer', status: 'active', title: `Far listing ${i} with a title long enough to need a second line`, description: 'From elsewhere',
        category: ['tech', 'food', 'tools', 'garden'][i], authorPublicKey: 'far-key', authorCallsign: 'Bo', credits: i + 1, priceType: 'fixed',
        photos: i % 2 ? [PHOTO(`far-${i}`)] : [], ...(i === 2 ? { authorBannerUrl: BANNER } : {}), lat: 48.8, lng: 2.3, createdAt: iso(now - (i + 1) * 3_600_000),
    }));
    beforeEach(() => {
        store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'global', features: { beans: false, nearbyListings: { radiusKm: 250, max: 500 } }, checkedAt: new Date().toISOString() } }));
        globalThis.fetch = vi.fn(async (url: unknown) => (String(url).includes('/api/marketplace/posts') ? new Response(JSON.stringify(FAR)) : new Response('{}', { status: 404 }))) as typeof fetch;
    });

    it.each(['list', 'grid', 'compact'] as const)('%s view: one listing near, four from elsewhere beneath it', async (view) => {
        await show([LONE], view);
        expect(host.querySelector('[data-testid="market-fill"]')).not.toBeNull();
        const cap = view === 'grid' ? 400 : view === 'list' ? 250 : 120;
        for (const p of [LONE, ...FAR]) {
            const heights = heightsAcross(cardOf(p.title));
            expect(new Set(heights).size, `${p.title}: ${heights.join(', ')}`).toBe(1);
            expect(heights[0], p.title).toBeLessThan(cap);
        }
    });

    it('nothing near: the fill alone, with its short line above, every card its own height', async () => {
        await show([], 'list');
        expect(host.querySelector('[data-testid="market-near-empty"]')).not.toBeNull();
        for (const p of FAR) {
            const heights = heightsAcross(cardOf(p.title));
            expect(new Set(heights).size, `${p.title}: ${heights.join(', ')}`).toBe(1);
            expect(heights[0], p.title).toBeLessThan(250);
        }
    });
});

describe('the layout check sees the fault it is here for', () => {
    // The row as it was drawn before: a `height: '100%'` slot and a tile of the same, in the same list with the examples
    // under it. Built by hand, not rendered, so the check shows itself to find the fault, whatever the screen draws now.
    const div = (style: Record<string, unknown>, ...children: Element[]) => {
        const e = document.createElement('div');
        e.setAttribute('data-style', JSON.stringify(style));
        children.forEach((c) => e.appendChild(c));
        return e;
    };
    function oldRow() {
        const text = div({ flex: 1, padding: 12, justifyContent: 'center' }, div({ width: 150, height: 90 }));
        const tile = div({ width: '100%', height: '100%', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, div({ width: 28, height: 28 }));
        const slot = div({ width: 80, height: '100%', minHeight: 80, overflow: 'hidden' }, tile);
        const row = div({ flexDirection: 'row', padding: 0, borderWidth: 1, marginBottom: 8, overflow: 'hidden' }, slot, text);
        const content = div({ paddingHorizontal: 16, paddingBottom: 100 }, div({ height: 90 }), div({}, div({}, row)), div({ height: 380 }));
        const scroll = div({ flexGrow: 1, flexShrink: 1, overflow: 'scroll' }, content);
        return { scroll, row, slot, tile };
    }

    it('a percentage-height slot makes a lone card far taller than its own 116 dp', () => {
        // 90 dp of text, 24 of padding and a 1 dp border all round; the list around it adds 90 above and 380 below.
        const { scroll, row, slot, tile } = oldRow();
        for (const height of [569, 1200]) {
            const l = layOut(scroll, { width: WIDTH, height });
            expect(l.height(row)).toBeGreaterThan(300);
            expect(l.height(tile)).toBeGreaterThan(300);
            expect(l.height(slot)).toBeGreaterThan(300);
        }
    });
});
