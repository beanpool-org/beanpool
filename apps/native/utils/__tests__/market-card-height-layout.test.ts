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
                            // RN's own row for numColumns > 1 is `flexDirection: 'row'`, with the columnWrapperStyle on top of it.
                            ? cell(row.map((item, c) => createElement('div', { key: keyExtractor(item, r * numColumns + c), 'data-style': '{"flex":1}' }, renderItem({ item, index: r * numColumns + c }))), 'row', [{ flexDirection: 'row' }, columnWrapperStyle])
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
    Image: ({ source, onError, onLoad, style }: { source?: { uri?: string }; onError?: () => void; onLoad?: () => void; style?: unknown }) => createElement('img', {
        'data-src': source?.uri, 'data-style': JSON.stringify(Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'))), onError, onLoad,
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
/** An element's left edge and top in the list's own coordinates: Yoga gives each box in its parent's, so add them up. */
function at(l: ReturnType<typeof lay>, el: Element) {
    let left = 0, top = 0;
    for (let e: Element | null = el; e && e !== list(); e = e.parentElement) { const b = l.box(e); left += b.left; top += b.top; }
    return { left, top };
}
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
        // card-photo-blank: until the banner has drawn, the tile holds the slot, at the card's own height.
        const loadingTile = row().querySelector('[data-testid="category-tile"]') as HTMLElement;
        expect(loadingTile).not.toBeNull();
        const loadingHeights = heightsAcross(row());
        expect(new Set(loadingHeights).size).toBe(1);
        expect(loadingHeights[0]).toBeLessThan(250);
        for (const height of HEIGHTS) expect(lay(height).height(loadingTile)).toBeCloseTo(lay(height).height(row()) - 2, 1);
        await act(async () => { picture()!.dispatchEvent(new Event('load')); });
        await settle(2);
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

// The style box, slice P2 (DESIGN-market-event-cards-fable.md §3 P2): an event is the Offer's list card. Laid out with Yoga at
// 320 dp and 1.3x text: its picture is the card's own slot (80 wide, flush inside the 1 dp border, the card's full height), the
// card is the Offer card's width at the same left edge, its own height (Marty, 4 Nov: "the big card doesnt need to conform to
// the same size"), and no taller than 210 dp with Byron's longest title, pinned, a place and the member's mark.
describe('an event in the list is the Offer card, and its own height', () => {
    const DAY = 86_400_000;
    const BYRON: any = {
        id: 'ev-twilight', type: 'event', status: 'active', title: 'Byron Bay Twilight Market - Every Saturday', category: 'events',
        author_pubkey: 'byron-key', author_callsign: 'Byron Markets', created_at: iso(now - 2 * 60_000),
        event_start_at: iso(now + 2 * DAY), event_end_at: iso(now + 2 * DAY + 5 * 3_600_000), event_state: 'scheduled',
        event_place_name: 'Railway Park, Jonson Street, Byron Bay', lat: -28.643, lng: 153.612,
        pinnedAt: iso(now - 60_000), pinnedUntil: iso(now + 3 * DAY), myRsvp: 'going', goingCount: 4, interestedCount: 2, photos: [],
    };
    const OFFER = { ...LONE, id: 'p-offer', title: 'Vehicle Storage', created_at: iso(now - 60_000) };
    /** The event's card: the Pressable is the card itself (an Offer's is the Pressable's child). */
    const eventCard = () => host.querySelector('[data-testid="event-card-ev-twilight"]') as HTMLElement;

    it("the picture is the slot: 80 wide, flush inside the border, the card's full height; the card the Offer's width at the same left edge", async () => {
        await show([BYRON, OFFER]);
        const card = eventCard();
        expect(card).not.toBeNull();
        const slot = card.firstElementChild as HTMLElement;
        const text = card.lastElementChild as HTMLElement;
        expect(slot.querySelector('[data-testid="category-tile"]')).not.toBeNull();
        const offer = cardOf(OFFER.title).firstElementChild as HTMLElement;
        for (const height of HEIGHTS) {
            const l = lay(height);
            expect(l.box(slot), `slot at ${height} dp`).toMatchObject({ left: 1, top: 1, width: 80 });
            expect(l.height(slot), `slot at ${height} dp`).toBeCloseTo(l.height(card) - 2, 1);
            // The card is its lines' height: the text column's, or the slot's 80, whichever is taller.
            expect(l.height(card), `card at ${height} dp`).toBeCloseTo(Math.max(80, textNeeds(l, text)) + 2, 1);
            expect(l.width(card)).toBe(l.width(offer));
            expect(at(l, card).left).toBe(at(l, offer).left);
        }
        expect(new Set(heightsAcross(card)).size).toBe(1);
        const l = lay(569);
        console.log(`event card ${l.height(card)} dp, Offer card ${l.height(offer)} dp at 320 x 1.3`);
        expect(l.height(card)).toBeLessThanOrEqual(210);
        // No more than two of its loud lines (20 dp at 1x) taller than the Offer card beside it.
        expect(l.height(card) - l.height(offer)).toBeLessThanOrEqual(2 * 20 * 1.3);
    });

    it('nothing on the card is wider than the card, and no button but the card itself', async () => {
        await show([BYRON, OFFER]);
        const card = eventCard();
        const l = lay(569);
        const cardRight = at(l, card).left + l.width(card);
        for (const el of Array.from(card.querySelectorAll('*'))) {
            expect(at(l, el).left + l.width(el), el.textContent ?? el.tagName).toBeLessThanOrEqual(cardRight + 0.5);
        }
        expect(card.querySelectorAll('button')).toHaveLength(0);
        expect(card.textContent).toContain('Going ✓');
        expect(card.textContent).not.toContain('Interested');
    });
});

// Byron's phone, 4 Nov (Android): "the pinned one is smaller. and it looks bad". The Pinned block added a 16 dp margin of
// its own inside a list that already pads 16 dp, so a pinned card sat 32 dp in from each edge and every other card 16 dp.
// Laid out with Yoga at 320 dp and 1.3x text: a pinned card and a card under TODAY are the same width at the same left
// edge, in every view, and the gap between pinned cards is the gap between the others.
describe('a pinned card is the same width as every other card', () => {
    const DAY = 86_400_000;
    const pinned = (id: string, title: string, ageMs: number) => ({ ...LONE, id, title, created_at: iso(now - ageMs), pinnedAt: iso(now - ageMs), pinnedUntil: iso(now + 3 * DAY) });
    const plain = (id: string, title: string, ageMs: number) => ({ ...LONE, id, title, created_at: iso(now - ageMs) });
    const PIN_A = pinned('pin-a', 'Pinned sourdough loaves', 3 * 60_000);
    const PIN_B = pinned('pin-b', 'Pinned garden spades', 4 * 60_000);
    const STREAM_A = plain('str-a', 'Stream bicycle repairs', 1 * 60_000);
    const STREAM_B = plain('str-b', 'Stream guitar lessons', 2 * 60_000);

    /** A listing's card box: in the list and compact views the card is the pressable's child; in the grid it is the pressable. */
    let view: 'list' | 'grid' | 'compact' = 'list';
    const row = (title: string) => (view === 'grid' ? cardOf(title) : cardOf(title).firstElementChild) as HTMLElement;
    beforeEach(() => { view = 'list'; });

    it('list view: one pinned Offer and one Offer in the stream below it are the same width at the same left edge', async () => {
        await show([PIN_A, STREAM_A]);
        expect(host.querySelector('[data-testid="market-pinned-block"]')).not.toBeNull();
        const l = lay(569);
        const [pin, stream] = [row(PIN_A.title), row(STREAM_A.title)];
        // The stream card is the list's width less its 16 dp of padding a side: the measure is sound.
        expect(l.width(stream)).toBe(WIDTH - 32);
        expect(at(l, stream).left).toBe(16);
        // And the pinned card is that card's twin, not 16 dp narrower a side.
        expect(l.width(pin)).toBe(l.width(stream));
        expect(at(l, pin).left).toBe(at(l, stream).left);
    });

    it('list view: the gap between two pinned cards is the gap between two other cards', async () => {
        await show([PIN_A, PIN_B, STREAM_A, STREAM_B]);
        const l = lay(569);
        const gap = (upper: HTMLElement, lower: HTMLElement) => at(l, lower).top - (at(l, upper).top + l.height(upper));
        const [pinGap, streamGap] = [gap(row(PIN_A.title), row(PIN_B.title)), gap(row(STREAM_A.title), row(STREAM_B.title))];
        expect(streamGap).toBe(8);
        expect(pinGap).toBe(streamGap);
    });

    it.each(['grid', 'compact'] as const)('%s view: pinned cards are the width and left edge of the others', async (which) => {
        view = which;
        await show([PIN_A, PIN_B, STREAM_A, STREAM_B], which);
        const l = lay(569);
        // Left edges and widths, pinned against the stream's: the first of each pair in the grid, every card in compact.
        const [pin, stream] = [row(PIN_A.title), row(STREAM_A.title)];
        expect(at(l, stream).left).toBe(16);
        expect(at(l, pin).left).toBe(at(l, stream).left);
        expect(l.width(pin)).toBe(l.width(stream));
        if (which === 'grid') {
            // The second card of the pair keeps its place too, and the pair's gap is the stream pair's.
            expect(at(l, row(PIN_B.title)).left).toBe(at(l, row(STREAM_B.title)).left);
            expect(l.width(row(PIN_B.title))).toBe(l.width(row(STREAM_B.title)));
        }
        if (which === 'compact') {
            const gap = (upper: HTMLElement, lower: HTMLElement) => at(l, lower).top - (at(l, upper).top + l.height(upper));
            expect(gap(row(PIN_A.title), row(PIN_B.title))).toBe(gap(row(STREAM_A.title), row(STREAM_B.title)));
        }
    });

    it('grid view: the gap between two rows of pinned cards is the gap between two rows of the others', async () => {
        view = 'grid';
        const PIN_C = pinned('pin-c', 'Pinned honey jars', 5 * 60_000);
        const STREAM_C = plain('str-c', 'Stream hedge trimming', 6 * 60_000);
        const STREAM_D = plain('str-d', 'Stream piano tuning', 7 * 60_000);
        await show([PIN_A, PIN_B, PIN_C, STREAM_A, STREAM_B, STREAM_C, STREAM_D], 'grid');
        const l = lay(569);
        const gap = (upper: HTMLElement, lower: HTMLElement) => at(l, lower).top - (at(l, upper).top + l.height(upper));
        const [pinRows, streamRows] = [gap(row(PIN_A.title), row(PIN_C.title)), gap(row(STREAM_A.title), row(STREAM_C.title))];
        // To a thousandth of a dp: since PG2 a tile's text block is 133.2 dp at 1.3x, which float32 Yoga (no pixel rounding
        // here, setPointScaleFactor(0)) carries as 16.000015 between rows. A phone rounds to its pixels.
        expect(streamRows).toBeCloseTo(16, 3);
        expect(pinRows).toBeCloseTo(streamRows, 3);
    });
});

// Marty, 4 Nov ("go with the fable recs", DESIGN-market-grid-sizes-fable.md §0.4 pick 1, §2.1, slice PG1): a Pinned heading over
// one pin and a half-empty row is a lie, and a pair with a spacer wasted a cell. In the grid there is no Pinned block: the pins
// are the grid's first cells, newest pin first, each with its 📌 PINNED pill on the photo, and the stream carries on in the same
// row. List and compact keep the heading and the block. A pin is never drawn twice. Laid out with Yoga at 320 dp, 1.3x text.
describe('the grid has no Pinned block: its pins are the first cells, and the stream carries on in the same row', () => {
    const DAY = 86_400_000;
    const pinned = (id: string, title: string, pinnedAgoMs: number) => ({ ...LONE, id, title, created_at: iso(now - 9 * 60_000), pinnedAt: iso(now - pinnedAgoMs), pinnedUntil: iso(now + 3 * DAY) });
    const plain = (id: string, title: string, ageMs: number) => ({ ...LONE, id, title, created_at: iso(now - ageMs) });
    // Pinned out of order on purpose: the newest pin is the one pinned a minute ago.
    const OLDEST_PIN = pinned('pin-old', 'Pinned oldest sourdough', 30 * 60_000);
    const NEWEST_PIN = pinned('pin-new', 'Pinned newest spades', 1 * 60_000);
    const MIDDLE_PIN = pinned('pin-mid', 'Pinned middle honey', 10 * 60_000);
    const S1 = plain('s1', 'Stream bicycle repairs', 1 * 60_000);
    const S2 = plain('s2', 'Stream guitar lessons', 2 * 60_000);
    const S3 = plain('s3', 'Stream hedge trimming', 3 * 60_000);

    /** How many outermost cards carry this title: a post drawn twice is two. */
    const drawn = (title: string) => Array.from(host.querySelectorAll('button')).filter(b => b.textContent?.includes(title) && !b.parentElement?.closest('button')).length;
    /** The rows as a member sees them: the titles grouped by the card's top, each row left to right. */
    function rowsOf(l: ReturnType<typeof lay>, titles: string[]): string[][] {
        const placed = titles.map(title => ({ title, ...at(l, cardOf(title)) })).sort((a, b) => a.top - b.top || a.left - b.left);
        const rows: { top: number; titles: string[] }[] = [];
        for (const p of placed) {
            const row = rows.find(r => Math.abs(r.top - p.top) < 1);
            if (row) row.titles.push(p.title); else rows.push({ top: p.top, titles: [p.title] });
        }
        return rows.map(r => r.titles);
    }
    const pill = (title: string) => cardOf(title).querySelector('[data-testid="pinned-chip"]');

    it('one pin: no heading, no block; the pin is the first cell and the first stream card is beside it in the same row', async () => {
        await show([S1, NEWEST_PIN, S2, S3], 'grid');
        expect(host.querySelector('[data-testid="pinned-section-header"]')).toBeNull();
        expect(host.querySelector('[data-testid="market-pinned-block"]')).toBeNull();
        const l = lay(569);
        expect(rowsOf(l, [NEWEST_PIN.title, S1.title, S2.title, S3.title])).toEqual([[NEWEST_PIN.title, S1.title], [S2.title, S3.title]]);
        // The pin is the first cell of the first row, at the list's left edge, as wide as the card beside it.
        expect(at(l, cardOf(NEWEST_PIN.title))).toEqual({ left: 16, top: at(l, cardOf(S1.title)).top });
        expect(l.width(cardOf(NEWEST_PIN.title))).toBe(l.width(cardOf(S1.title)));
        for (const p of [NEWEST_PIN, S1, S2, S3]) expect(drawn(p.title), p.title).toBe(1);
    });

    it('three pins, newest pin first, then the stream: [pin, pin], [pin, stream], [stream, stream]; no empty cell, none drawn twice', async () => {
        await show([S1, OLDEST_PIN, S2, NEWEST_PIN, S3, MIDDLE_PIN], 'grid');
        expect(host.querySelector('[data-testid="pinned-section-header"]')).toBeNull();
        expect(host.querySelector('[data-testid="market-pinned-block"]')).toBeNull();
        const all = [NEWEST_PIN, MIDDLE_PIN, OLDEST_PIN, S1, S2, S3].map(p => p.title);
        expect(rowsOf(lay(569), all)).toEqual([
            [NEWEST_PIN.title, MIDDLE_PIN.title],
            [OLDEST_PIN.title, S1.title],
            [S2.title, S3.title],
        ]);
        for (const title of all) expect(drawn(title), title).toBe(1);
    });

    it('a fourth live pin is not one of the three: it is drawn once, in the stream, not above it', async () => {
        const FOURTH = pinned('pin-4th', 'Pinned fourth lamps', 50 * 60_000);
        await show([S1, FOURTH, NEWEST_PIN, MIDDLE_PIN, OLDEST_PIN], 'grid');
        expect(host.querySelector('[data-testid="market-pinned-block"]')).toBeNull();
        const all =[NEWEST_PIN, MIDDLE_PIN, OLDEST_PIN, FOURTH, S1].map(p => p.title);
        for (const title of all) expect(drawn(title), title).toBe(1);
        const rows = rowsOf(lay(569), all);
        expect(rows[0]).toEqual([NEWEST_PIN.title, MIDDLE_PIN.title]);
        expect(rows[1][0]).toBe(OLDEST_PIN.title);
    });

    it('the 📌 PINNED pill is on the pinned cells\' photos, and only on those', async () => {
        await show([S1, NEWEST_PIN, S2], 'grid');
        expect(pill(NEWEST_PIN.title)?.textContent).toContain('PINNED');
        expect(pill(S1.title)).toBeNull();
        expect(pill(S2.title)).toBeNull();
    });

    it.each(['list', 'compact'] as const)('%s view: the Pinned heading and block are as before, above the stream, each card once', async (view) => {
        await show([S1, NEWEST_PIN, S2], view);
        const block = host.querySelector('[data-testid="market-pinned-block"]');
        expect(block).not.toBeNull();
        expect(host.querySelector('[data-testid="pinned-section-header"]')?.textContent).toContain('PINNED');
        expect(block!.contains(cardOf(NEWEST_PIN.title))).toBe(true);
        expect(block!.contains(cardOf(S1.title))).toBe(false);
        const l = lay(569);
        expect(at(l, cardOf(NEWEST_PIN.title)).top).toBeLessThan(at(l, cardOf(S1.title)).top);
        for (const p of [NEWEST_PIN, S1, S2]) expect(drawn(p.title), p.title).toBe(1);
    });

    it('no pins: the grid is the stream alone, two to a row, with no heading', async () => {
        await show([S1, S2, S3], 'grid');
        expect(host.querySelector('[data-testid="pinned-section-header"]')).toBeNull();
        expect(rowsOf(lay(569), [S1.title, S2.title, S3.title])).toEqual([[S1.title, S2.title], [S3.title]]);
    });
});

// Slice PG2 (DESIGN-market-grid-sizes-fable.md §2.2, §2.5; Marty, 4 Nov 2026: "the other smaller tiles yes - the same seems
// best"): the grid is rows on a lattice. Its FlatList draws rows, not posts: a pair of tiles in one row shares one height, each
// tile's text block is four rows whatever it holds (24 + (4 x 18 + 3 x 4) x fontScale), and a poll is a row of its own, the
// list's width, never a half cell. Laid out with Yoga at 320 dp and 1.3x text.
describe('the grid is rows on a lattice: a pair is one height, the text block four rows, a poll the whole width', () => {
    const DAY = 86_400_000;
    const plain = (id: string, title: string, ageMs: number, extra: Record<string, unknown> = {}) => ({ ...LONE, id, title, repeatable: 0, created_at: iso(now - ageMs), ...extra });
    // One tile with the least a tile can hold, one with the most: a one-line title and nothing else, against a two-line title,
    // a photo, RECURRING and a group's lock (the lock is the one chip row 4 keeps).
    const SHORT = plain('g-short', 'Eggs', 1 * 60_000);
    const FULL = plain('g-full', 'Listing with a title long enough to need a second line and more', 2 * 60_000, {
        repeatable: 1, photos: [PHOTO('g-full')], audience_scope: 'group', target_group_name: 'Byron Bay Permaculture Growers',
    });
    const C = plain('g-c', 'Hedge trimming', 3 * 60_000);
    const D = plain('g-d', 'Piano tuning', 4 * 60_000);
    const POLL = {
        id: 'g-poll', type: 'poll', status: 'active', title: 'Where should the new tool shed go?', description: 'The working bee is on the 12th',
        author_pubkey: 'dee-key', author_callsign: 'Dee', created_at: iso(now - 90_000), poll_closes_at: iso(now + 2 * DAY), pollOpenVote: true,
        pollOptions: [{ id: 'o1', text: 'North of the hall', votes: 3 }, { id: 'o2', text: 'Behind the south barn', votes: 1 }, { id: 'o3', text: 'Beside the packing shed', votes: 0 }],
        pollVotes: [],
    };
    const SCALE = 1.3;
    const BLOCK = 24 + (4 * 18 + 3 * 4) * SCALE;
    const blockOf = (card: Element) => card.querySelector('[data-testid="grid-text-block"]') as HTMLElement;
    const pollCard = () => host.querySelector('[data-testid="poll-card"]') as HTMLElement;
    /** The grid's poll: its summary tile (PollGridTile, Marty 5 Nov 2026), laid over a tile's invisible box. */
    const gridPoll = () => host.querySelector('[data-testid="market-poll-tile-g-poll"]') as HTMLElement;

    it('a pair at 320 x 1.3: two tiles 136 wide and one height, the least a tile holds beside the most', async () => {
        await show([SHORT, FULL, C, D], 'grid');
        const [short, full] = [cardOf(SHORT.title), cardOf(FULL.title)];
        const l = lay(569);
        // One row, left to right.
        expect(at(l, short).top).toBe(at(l, full).top);
        expect(at(l, short).left).toBe(16);
        expect(at(l, full).left).toBe(16 + 136 + 16);
        expect(l.width(short)).toBe(136);
        expect(l.width(full)).toBe(136);
        expect(l.height(short)).toBe(l.height(full));
        // Each block is the four rows, the same number, whatever the tile holds.
        for (const card of [short, full]) expect(l.height(blockOf(card))).toBeCloseTo(BLOCK, 3);
        // The tile is its picture and its block (inside a 1 dp border), and nothing else: a lattice by construction, not only
        // by the row's stretch. The picture is 4:3 at the card's inner width.
        for (const card of [short, full]) {
            const picture = blockOf(card).previousElementSibling as HTMLElement;
            expect(l.height(picture)).toBeCloseTo((136 - 2) * 3 / 4, 3);
            expect(l.height(card)).toBeCloseTo(2 + (136 - 2) * 3 / 4 + BLOCK, 3);
        }
        console.log(`grid tile ${l.height(short).toFixed(1)} dp at 320 x 1.3, text block ${l.height(blockOf(short)).toFixed(1)} dp`);
    });

    it('the rows line up across the pair, and nothing in a block runs out of it', async () => {
        await show([SHORT, FULL], 'grid');
        const l = lay(569);
        const rowsOf = (card: Element) => Array.from(blockOf(card).children).map(r => at(l, r).top - at(l, card).top);
        expect(rowsOf(cardOf(SHORT.title))).toEqual(rowsOf(cardOf(FULL.title)));
        for (const card of [cardOf(SHORT.title), cardOf(FULL.title)]) {
            const block = blockOf(card);
            const bottom = at(l, block).top + l.height(block) - 12;   // inside its 12 dp of padding
            for (const r of Array.from(block.children)) expect(at(l, r).top + l.height(r), r.textContent ?? '').toBeLessThanOrEqual(bottom + 0.01);
            // The title takes two rows at most.
            const title = block.firstElementChild!.firstElementChild!;
            expect(title.getAttribute('data-lines')).toBe('2');
        }
    });

    it('row 4 is one line: the group\'s lock before RECURRING, one chip at most, cut at the tile\'s edge', async () => {
        const REPEATS = plain('g-rep', 'Weekly veg box', 5 * 60_000, { repeatable: 1 });
        await show([SHORT, FULL, REPEATS], 'grid');
        const full = cardOf(FULL.title);
        const last = full.querySelector('[data-testid="grid-last-row"]') as HTMLElement;
        expect(last.textContent).toContain('Byron Bay Permaculture Growers');
        expect(last.textContent).not.toContain('RECURRING');
        expect(full.querySelectorAll('[data-testid="card-group-chip"]')).toHaveLength(1);
        // Nothing in the tile ends past its right edge, the long lock chip least of all (it is cut inside row 4).
        const l = lay(569);
        const right = at(l, full).left + l.width(full);
        for (const el of Array.from(full.querySelectorAll('*'))) expect(at(l, el).left + l.width(el), el.textContent ?? el.tagName).toBeLessThanOrEqual(right + 0.5);
        const chip = full.querySelector('[data-testid="card-group-chip"]')!;
        expect(at(l, chip).left + l.width(chip)).toBeLessThanOrEqual(at(l, last).left + l.width(last) + 0.5);
        // Without the lock, RECURRING; with neither (and no distance off the worldwide community), a blank last row.
        expect(cardOf(REPEATS.title).querySelector('[data-testid="grid-last-row"]')!.textContent).toBe('↻ RECURRING');
        expect(cardOf(SHORT.title).querySelector('[data-testid="grid-last-row"]')!.textContent).toBe('');
    });

    it('a poll is a row of its own at the list\'s width, 288 dp, never a half cell; the tiles pack round it', async () => {
        await show([SHORT, POLL, FULL, C], 'grid');
        const l = lay(569);
        const poll = gridPoll();
        expect(poll).not.toBeNull();
        expect(pollCard()).toBeNull();
        expect(l.width(poll)).toBe(WIDTH - 32);
        expect(at(l, poll).left).toBe(16);
        // The tile that waited for its partner keeps it: SHORT and FULL share the first row, the poll is under it, C after.
        expect(at(l, cardOf(SHORT.title)).top).toBe(at(l, cardOf(FULL.title)).top);
        expect(at(l, poll).top).toBeGreaterThan(at(l, cardOf(SHORT.title)).top + l.height(cardOf(SHORT.title)));
        expect(at(l, cardOf(C.title)).top).toBeGreaterThan(at(l, poll).top + l.height(poll));
        // C is the last, odd tile: it keeps its half of the row.
        expect(l.width(cardOf(C.title))).toBe(136);
        expect(at(l, cardOf(C.title)).left).toBe(16);
    });

    // Marty, 5 Nov 2026: "yes two wide it is but make sure it filled correctly. we dont want 2 wide with heaps of space". The
    // poll's row is a tile row tall, never its own height, whatever it holds: a tile's box drawn invisible in its first cell.
    it('a poll\'s row is exactly a tile row tall at 320 x 1.3, the short poll and the long one alike', async () => {
        const SIX = { ...POLL, id: 'g-poll', pollOptions: Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, text: `Answer number ${i + 1} with words enough to fill a line`, votes: i })) };
        for (const poll of [POLL, SIX, { ...POLL, pollOptions: POLL.pollOptions.slice(0, 2) }]) {
            await show([SHORT, FULL, poll, C, D], 'grid');
            const l = lay(569);
            const tile = cardOf(SHORT.title);
            expect(l.height(gridPoll())).toBeCloseTo(l.height(tile), 3);
            expect(l.height(gridPoll())).toBeCloseTo(2 + (136 - 2) * 3 / 4 + BLOCK, 3);
            // Its header at its top and its footer at its foot, inside its 12 of padding; the answers between them.
            const head = gridPoll().querySelector('[data-testid="poll-grid-head"]')!;
            const foot = gridPoll().querySelector('[data-testid="poll-grid-foot"]')!;
            expect(at(l, head).top - at(l, gridPoll()).top).toBeCloseTo(12 + 1, 3);
            expect(at(l, gridPoll()).top + l.height(gridPoll()) - (at(l, foot).top + l.height(foot))).toBeCloseTo(12 + 1, 3);
            act(() => root.unmount());
            root = createRoot(host);
        }
    });

    it('the poll in the grid is the width of the poll in the list', async () => {
        await show([SHORT, POLL], 'list');
        const listWidth = lay(569).width(pollCard());
        act(() => root.unmount());
        root = createRoot(host);
        await show([SHORT, POLL], 'grid');
        expect(lay(569).width(gridPoll())).toBe(listWidth);
    });

    it('under a poll in the grid is the gutter, 16, as under a row of tiles (the poll card on the box, slice C1)', async () => {
        await show([SHORT, FULL, POLL, C, D], 'grid');
        const l = lay(569);
        const poll = gridPoll();
        const nextRow = cardOf(C.title);
        expect(at(l, nextRow).top - (at(l, poll).top + l.height(poll))).toBeCloseTo(16, 3);
        const firstRow = cardOf(SHORT.title);
        expect(at(l, poll).top - (at(l, firstRow).top + l.height(firstRow))).toBeCloseTo(16, 3);
    });
});

// Slice P3' (DESIGN-market-grid-sizes-fable.md §2.2, §3 P3'; DESIGN-card-style-box-fable.md §2): an event and the Daily Pulse
// in the grid are tiles like the listing beside them, from the same box: the 4:3 photo, the type chip at its top-left, the foot
// row of pills, then the listing tiles' own four-row text block (an event's date, time, title and place; the Pulse's title, its
// pill and one line of its news). So a pair is one height by construction and an event's text block is a listing's, row for
// row. Laid out with Yoga at 320 dp and 1.3x text.
describe("an event and the Daily Pulse in the grid are tiles: the listing's shell and its text block, row for row", () => {
    const DAY = 86_400_000;
    const SCALE = 1.3;
    const BLOCK = 24 + (4 * 18 + 3 * 4) * SCALE;
    const ROW = 18 * SCALE;
    const GAP = 4 * SCALE;
    const LISTING = { ...LONE, id: 'l-eggs', title: 'Eggs', repeatable: 0, created_at: iso(now - 60_000) };
    /** Byron's longest title, pinned, a place, a photo and the member's own answer; counts above zero. */
    const BYRON: any = {
        id: 'ev-twilight', type: 'event', status: 'active', title: 'Byron Bay Twilight Market - Every Saturday', category: 'events',
        author_pubkey: 'byron-key', author_callsign: 'Byron Markets', created_at: iso(now - 2 * 60_000),
        event_start_at: iso(now + 2 * DAY), event_end_at: iso(now + 2 * DAY + 5 * 3_600_000), event_state: 'scheduled',
        event_place_name: 'Railway Park, Jonson Street, Byron Bay', lat: -28.643, lng: 153.612,
        pinnedAt: iso(now - 60_000), pinnedUntil: iso(now + 3 * DAY), myRsvp: 'going', goingCount: 12, interestedCount: 5,
        photos: [PHOTO('ev-twilight')],
    };
    /** The least an event holds: no place, no photo, nobody's answer. */
    const REPAIR: any = {
        id: 'ev-repair', type: 'event', status: 'active', title: 'Repair Café', category: 'events', author_pubkey: 'hall-key',
        author_callsign: 'Civic Hall', created_at: iso(now - 3 * 60_000), event_start_at: iso(now + DAY), event_end_at: iso(now + DAY + 2 * 3_600_000),
        event_state: 'scheduled', photos: [],
    };
    const PULSE = {
        ...LONE, id: 'pulse-1', title: 'Byron Shire: water limits end on Monday after the weekend rain', author_callsign: 'Daily Pulse',
        author_pubkey: 'pulse-key', repeatable: 0, credits: 0, created_at: iso(now - 90_000),
        description: 'Council says the dam is at 92% after the weekend rain, and the level-2 limits end on Monday.',
    };
    const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    const blockOf = (card: Element) => card.querySelector('[data-testid="grid-text-block"]') as HTMLElement;
    /** Each row of a block, as its top inside the tile and its height. */
    const rowsOf = (l: ReturnType<typeof lay>, card: Element) => Array.from(blockOf(card).children).map(r => ({ top: at(l, r).top - at(l, card).top, height: l.height(r) }));

    it('an event beside a listing at 320 x 1.3: one row, 136 wide each, one height; the same picture and the same text block', async () => {
        await show([BYRON, LISTING], 'grid');
        const ev = byId('event-card-ev-twilight');
        const li = byId('market-card-l-eggs');
        expect(ev).not.toBeNull();
        expect(li).not.toBeNull();
        const l = lay(569);
        expect(at(l, ev).top).toBe(at(l, li).top);
        expect([l.width(ev), l.width(li)]).toEqual([136, 136]);
        expect(l.height(ev)).toBe(l.height(li));
        for (const card of [ev, li]) {
            expect(l.height(blockOf(card))).toBeCloseTo(BLOCK, 3);
            const picture = blockOf(card).previousElementSibling as HTMLElement;
            expect(l.height(picture)).toBeCloseTo((136 - 2) * 3 / 4, 3);
            // The tile is its picture and its block inside the 1 dp border, and nothing else: the lattice by construction.
            expect(l.height(card)).toBeCloseTo(2 + (136 - 2) * 3 / 4 + BLOCK, 3);
        }
        // Row for row: the event's date and time sit in the listing's title box, its title on the author's row, its place on
        // the listing's last row; each one row tall, 4 dp (scaled) apart.
        const e = rowsOf(l, ev);
        const s = rowsOf(l, li);
        expect(e).toHaveLength(4);
        expect(s).toHaveLength(3);
        for (const r of e) expect(r.height).toBeCloseTo(ROW, 3);
        expect(e[0].top).toBeCloseTo(s[0].top, 3);
        expect(e[1].top).toBeCloseTo(e[0].top + ROW + GAP, 3);
        expect(e[1].top + ROW).toBeCloseTo(s[0].top + s[0].height, 3);
        expect(e[2].top).toBeCloseTo(s[1].top, 3);
        expect(e[3].top).toBeCloseTo(s[2].top, 3);
        console.log(`event tile ${l.height(ev).toFixed(1)} dp, listing tile ${l.height(li).toFixed(1)} dp at 320 x 1.3`);
    });

    it("the event tile's four rows are one line each and stay in its block; nothing runs past its edge; no button inside it", async () => {
        await show([BYRON, LISTING], 'grid');
        const ev = byId('event-card-ev-twilight');
        const block = blockOf(ev);
        const l = lay(569);
        const bottom = at(l, block).top + l.height(block) - 12;   // inside its 12 dp of padding
        for (const r of Array.from(block.children)) expect(at(l, r).top + l.height(r), r.textContent ?? '').toBeLessThanOrEqual(bottom + 0.01);
        // One line each: the date, the time's pieces (the start, and the end with its dash on a same-day span), the title, the
        // place. Whether the span is one day depends on the hour the test runs at (now + 2 days + 5 hours), so count its pieces.
        const pieces = block.querySelector('[data-testid="event-time-row"]')!.children.length;
        expect([1, 2]).toContain(pieces);
        const lines = Array.from(block.querySelectorAll('span[data-lines]'));
        expect(lines.map(x => x.getAttribute('data-lines'))).toEqual(Array(3 + pieces).fill('1'));
        const right = at(l, ev).left + l.width(ev);
        for (const el of Array.from(ev.querySelectorAll('*'))) expect(at(l, el).left + l.width(el), el.textContent ?? el.tagName).toBeLessThanOrEqual(right + 0.5);
        expect(ev.querySelectorAll('button')).toHaveLength(0);
        // On the photo: EVENT, 📌 PINNED and the member's mark; the counts are the page's in the grid.
        const picture = block.previousElementSibling as HTMLElement;
        expect(picture.querySelector('[data-testid="event-type-chip"]')?.textContent).toBe('EVENT');
        expect(picture.querySelector('[data-testid="grid-badge-row"]')?.textContent).toBe('📌 PINNED' + 'Going ✓');
        expect(ev.textContent).not.toContain('going ·');
    });

    it('two events in a row: two tiles 136 wide and one height, the most an event holds beside the least', async () => {
        await show([BYRON, REPAIR], 'grid');
        const [a, b] = [byId('event-card-ev-twilight'), byId('event-card-ev-repair')];
        const l = lay(569);
        expect(at(l, a).top).toBe(at(l, b).top);
        expect([l.width(a), l.width(b)]).toEqual([136, 136]);
        expect(l.height(a)).toBe(l.height(b));
        for (const card of [a, b]) expect(l.height(blockOf(card))).toBeCloseTo(BLOCK, 3);
        expect(rowsOf(l, a)).toEqual(rowsOf(l, b));
    });

    it('the Daily Pulse beside a listing: one height, the same block; its pill in row 3, one line of its news in row 4, and no second pill on the photo', async () => {
        await show([PULSE, LISTING], 'grid');
        const pulse = byId('market-card-pulse-1');
        const li = byId('market-card-l-eggs');
        expect(pulse).not.toBeNull();
        const l = lay(569);
        expect(at(l, pulse).top).toBe(at(l, li).top);
        expect(l.width(pulse)).toBe(136);
        expect(l.height(pulse)).toBe(l.height(li));
        expect(l.height(blockOf(pulse))).toBeCloseTo(BLOCK, 3);
        const rows = Array.from(blockOf(pulse).children);
        expect(rows).toHaveLength(3);
        expect(rows[1].querySelector('[data-testid="pulse-chip"]')?.textContent).toBe('🗞️ PULSE');
        const news = rows[2].querySelector('[data-testid="pulse-line"]')!;
        expect(news.textContent).toBe(PULSE.description);
        expect(news.getAttribute('data-lines')).toBe('1');
        expect(byId('grid-badge-row') && pulse.querySelector('[data-testid="grid-badge-row"]')!.textContent).toBe('');
        const bottom = at(l, blockOf(pulse)).top + l.height(blockOf(pulse)) - 12;
        for (const r of rows) expect(at(l, r).top + l.height(r), r.textContent ?? '').toBeLessThanOrEqual(bottom + 0.01);
        const right = at(l, pulse).left + l.width(pulse);
        for (const el of Array.from(pulse.querySelectorAll('*'))) expect(at(l, el).left + l.width(el), el.textContent ?? el.tagName).toBeLessThanOrEqual(right + 0.5);
    });
});

// The Market's fill (market-fill.ts): on a community that reads by area, a short nearby list is followed, in the list's
// footer, by the newest from elsewhere. Those cards sit in views of their own (a plain one in the list view, a row of two
// in the grid), so each view is laid out with Yoga here too.
// Slice C1 (DESIGN-card-style-box-fable.md §0 item 2, §2 rows "Compact row, event / Poll"; Marty, 4 Nov: "and list view in phone -
// the events dont change"): in the compact view an event and a poll are compact rows like a listing's, from the same box. Each is
// ONE row, no taller than a listing's row and one line more (a line of the row's 11 dp words at 1.3x text), with the 32 dp
// picture and the chip at the end; the poll's answers are on its page, not on the row. Laid out with Yoga at 320 dp and 1.3x text.
describe('the compact view: an event and a poll are compact rows, one row no taller than a listing\'s and one line', () => {
    const DAY = 86_400_000;
    const SCALE = 1.3;
    /** One line of the row's words (11 dp) as the layout model draws a line: a font size and a quarter, times the scale. */
    const ONE_LINE = 11 * 1.25 * SCALE;
    const LISTING = { ...LONE, id: 'c-eggs', title: 'Eggs from the back paddock', repeatable: 0, created_at: iso(now - 60_000) };
    /** Byron's longest title, pinned, a place, the member's own answer: the most an event's row holds. */
    const BYRON: any = {
        id: 'ev-twilight', type: 'event', status: 'active', title: 'Byron Bay Twilight Market - Every Saturday', category: 'events',
        author_pubkey: 'byron-key', author_callsign: 'Byron Markets', created_at: iso(now - 2 * 60_000),
        event_start_at: iso(now + 2 * DAY), event_end_at: iso(now + 2 * DAY + 5 * 3_600_000), event_state: 'scheduled',
        event_place_name: 'Railway Park, Jonson Street, Byron Bay', lat: -28.643, lng: 153.612,
        pinnedAt: iso(now - 60_000), pinnedUntil: iso(now + 3 * DAY), myRsvp: 'going', goingCount: 12, interestedCount: 5, photos: [],
    };
    /** A poll the member has answered, with a long question and a long answer. */
    const POLL = {
        id: 'c-poll', type: 'poll', status: 'active', title: 'What would make trading on BeanPool easier for you this summer?',
        description: 'Tell us', author_pubkey: 'dee-key', author_callsign: 'Dee', created_at: iso(now - 90_000),
        poll_closes_at: iso(now + 11 * DAY), pollOpenVote: true, userVotedOptionId: 'o1', pollVotes: [],
        pollOptions: [{ id: 'o1', text: 'Better matches between offers and needs', votes: 3 }, { id: 'o2', text: 'More events', votes: 1 }],
    };
    const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    /** A listing's row: the compact row is the listing pressable's one child (an event's and a poll's row is the pressable). */
    const listingRow = () => cardOf(LISTING.title).firstElementChild as HTMLElement;

    it('at 320 x 1.3: the event row and the poll row are each one row, at most a listing row and one line tall, the same width', async () => {
        await show([LISTING, BYRON, POLL], 'compact');
        const l = lay(569);
        const listing = listingRow();
        const event = byId('event-card-ev-twilight');
        const poll = byId('poll-row-c-poll');
        expect(event, 'the event is a compact row').not.toBeNull();
        expect(poll, 'the poll is a compact row').not.toBeNull();
        expect(host.querySelector('[data-testid="poll-card"]'), 'no poll card in the compact view').toBeNull();
        const listingHeight = l.height(listing);
        for (const [name, row] of [['event', event], ['poll', poll]] as const) {
            // One row: the picture, the words and the chip side by side, as the listing's.
            expect(JSON.parse(row.getAttribute('data-style')!).flexDirection, name).toBe('row');
            expect(l.height(row), `${name} ${l.height(row)} against the listing's ${listingHeight}`).toBeLessThanOrEqual(listingHeight + ONE_LINE);
            expect(l.width(row), name).toBe(l.width(listing));
            expect(at(l, row).left, name).toBe(at(l, listing).left);
            // The 32 dp picture.
            const picture = row.querySelector('[data-testid="compact-picture"]')!;
            expect([l.width(picture), l.height(picture)], name).toEqual([32, 32]);
            // Nothing inside it reaches past its right edge (a Text inside a Text is words of its parent, not a box).
            const right = at(l, row).left + l.width(row);
            for (const el of Array.from(row.querySelectorAll('*')).filter(e => !e.parentElement?.closest('span'))) expect(at(l, el).left + l.width(el), `${name}: ${el.textContent}`).toBeLessThanOrEqual(right + 0.5);
        }
    });

    it('the pinned block too: a pinned event and a pinned poll are rows of the same width as the stream\'s', async () => {
        const POLL_PINNED = { ...POLL, id: 'c-poll-pin', pinnedAt: iso(now - 60_000), pinnedUntil: iso(now + 3 * DAY) };
        await show([LISTING, BYRON, POLL_PINNED], 'compact');
        const block = host.querySelector('[data-testid="market-pinned-block"]') as HTMLElement;
        expect(block).not.toBeNull();
        const l = lay(569);
        for (const id of ['event-card-ev-twilight', 'poll-row-c-poll-pin']) {
            const row = block.querySelector(`[data-testid="${id}"]`) as HTMLElement;
            expect(row, id).not.toBeNull();
            expect(l.width(row), id).toBe(l.width(listingRow()));
            expect(l.height(row), id).toBeLessThanOrEqual(l.height(listingRow()) + ONE_LINE);
        }
    });
});

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

    // PG2: a grid tile's row 4 holds the distance and one chip side by side, in the box's styles (gridTextBlock). Built by hand
    // at a tile's inner width (136 - 2 - 24 = 110 dp), 1.3x text: each piece gives way, so the long lock chip ends inside the
    // row; laid out rigid (flexShrink 0, the fault) it runs past it. The screen test cannot reach this pair: a distance needs the
    // worldwide community's circle.
    it("row 4's distance and lock chip end inside the tile; laid out rigid, the chip runs past it", async () => {
        const { gridTextBlock } = await import('../../components/market-card-shell');
        const b = gridTextBlock(1.3);
        const span = (style: Record<string, unknown>, text: string) => {
            const e = document.createElement('span');
            e.setAttribute('data-style', JSON.stringify(style));
            e.setAttribute('data-lines', '1');
            e.textContent = text;
            return e;
        };
        const rowWith = (piece: Record<string, unknown>) => {
            const chip = div({ flexShrink: 0, maxWidth: '100%', paddingHorizontal: 6, paddingVertical: 2 }, span({ fontSize: 10 }, '🔒 Only Byron Bay Permaculture Growers can see this'));
            const row = div(b.lastRow as Record<string, unknown>, span({ fontSize: 14, lineHeight: 18, ...piece }, '📍 141 km'), div(piece, chip));
            const scroll = div({ flexGrow: 1, flexShrink: 1, overflow: 'scroll' }, div({ width: 110 }, row));
            const l = layOut(scroll, { width: WIDTH, height: 569 }, { fontScale: 1.3 });
            // The chip's right edge in the row's coordinates: its wrapper's left plus its own.
            return { right: l.box(chip.parentElement!).left + l.box(chip).left + l.width(chip), width: l.width(row) };
        };
        const kept = rowWith(b.lastRowPiece as Record<string, unknown>);
        expect(kept.width).toBe(110);
        expect(kept.right).toBeLessThanOrEqual(kept.width + 0.5);
        const rigid = rowWith({ flexShrink: 0 });
        expect(rigid.right).toBeGreaterThan(rigid.width + 10);
    });

    // DESIGN-grid-event-rows-fable.md call 4: an event tile's row 2 is core's two whole pieces ("10:26", "–14:26") in
    // gridBlock.timeRow, a row one line high that wraps and clips. Built by hand at a tile's inner width at 320 x 1.3 (110 dp)
    // with pieces wider than it together (the measure's 0.56 em a character: 112 dp): the end piece is laid out whole on the
    // line under the row's clip, and the row shows the start alone. At 200 dp they share the line. Laid out without the wrap
    // (the fault), the end piece runs past the row's edge, where it would be cut.
    it("an event tile's time row: pieces wider than the row put the end piece whole under its clip; at 200 dp one line", async () => {
        const { gridTextBlock } = await import('../../components/market-card-shell');
        const b = gridTextBlock(1.3);
        const span = (text: string) => {
            const e = document.createElement('span');
            e.setAttribute('data-style', JSON.stringify({ fontSize: 14, fontWeight: '800', lineHeight: 18, ...b.timePiece }));
            e.setAttribute('data-lines', '1');
            e.textContent = text;
            return e;
        };
        const laid = (width: number, rowStyle: Record<string, unknown> = b.timeRow as Record<string, unknown>) => {
            const start = span('10:26');
            const end = span('–14:26');
            const row = div(rowStyle, start, end);
            const scroll = div({ flexGrow: 1, flexShrink: 1, overflow: 'scroll' }, div({ width }, row));
            const l = layOut(scroll, { width: WIDTH, height: 569 }, { fontScale: 1.3 });
            return { row: l.box(row), start: l.box(start), end: l.box(end) };
        };
        const ROW = 18 * 1.3;
        const whole = (text: string) => text.length * 14 * 1.3 * 0.56;
        const narrow = laid(110);
        expect(narrow.row.width).toBe(110);
        expect(narrow.row.height).toBeCloseTo(ROW, 3);
        expect(narrow.start.width + narrow.end.width).toBeGreaterThan(110);
        // The start on the row, whole; the end whole too, on the next line, at or below the row's bottom: clipped away.
        expect(narrow.start).toMatchObject({ left: 0, top: 0 });
        expect(narrow.start.width).toBeCloseTo(whole('10:26'), 3);
        expect(narrow.end.left).toBe(0);
        expect(narrow.end.top).toBeGreaterThanOrEqual(narrow.row.height - 0.01);
        expect(narrow.end.width).toBeCloseTo(whole('–14:26'), 3);
        // Room for both: one line, the end straight after the start.
        const wide = laid(200);
        expect(wide.row.height).toBeCloseTo(ROW, 3);
        expect(wide.start.top).toBe(0);
        expect(wide.end.top).toBe(0);
        expect(wide.end.left).toBeCloseTo(wide.start.width, 3);
        expect(wide.end.left + wide.end.width).toBeLessThanOrEqual(200);
        // The fault the wrap is there for: one line that never wraps puts the end past the row's edge, to be cut there.
        const rigid = laid(110, { ...(b.timeRow as Record<string, unknown>), flexWrap: 'nowrap' });
        expect(rigid.end.top).toBe(0);
        expect(rigid.end.left + rigid.end.width).toBeGreaterThan(110);
    });

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
