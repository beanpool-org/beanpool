// @vitest-environment jsdom
/**
 * Home's Market card as picture tiles, slice S8 (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.1 item 5,
 * §4.4): components/home/MarketTiles.tsx drawn for real, through MarketBody as Home draws it. Two tiles a row (a lone last
 * one keeps half the width), each the listing's photo (its small copy) or its category's tile, OFFER or NEED on the photo,
 * the title cut to two lines and the price in the brand's ink; a tap anywhere on a tile opens the listing, and a tile is
 * one target. For 0, 1, 3 and 4 listings (the node sends four at most), with no photo, a long title and Beans off, in the
 * light and the dark colours. The phone at the floor (320dp, text at 1.3x) is react-native's mock here; the widths are
 * checked in home-layout-320.test.ts and on the emulator.
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
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, onLayout, value, onChangeText, disabled, numberOfLines, style } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 304, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        // What a tile is drawn in: its line limit, its words' colour and its ground (from the style, as the phone reads it).
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        const look = flat(typeof style === 'function' ? style({ pressed: false }) : style);
        if (look.color) attrs['data-color'] = look.color;
        if (look.backgroundColor) attrs['data-bg'] = look.backgroundColor;
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
const nav = vi.hoisted(() => {
    const pushed: unknown[] = [];
    return { pushed, router: { push: (to: unknown) => { pushed.push(to); }, navigate() {}, setParams() {} } };
});
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: nav.router,
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
    Image: ({ source, onError, onLoad }: { source?: { uri?: string }; onError?: () => void; onLoad?: () => void }) => createElement('img', { 'data-src': source?.uri, onError, onLoad }),
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
// Light or dark, as the test sets it: CategoryTile reads its tile colours from the theme.
const look = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const now = () => (look.dark ? { theme: 'dark', colors: darkColors } : { theme: 'light', colors: lightColors });
    return {
        useTheme: () => now(),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make(now()),
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
import { darkColors, lightColors, type AppColors } from '../../constants/colors';
import { contrastRatio } from '../readable-color';
import type { HomeMarketItem } from '../home-cards';

const NODE = 'https://riverside.example';

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    nav.pushed.length = 0;
    look.dark = false;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const EGGS: HomeMarketItem = { id: 'h-eggs', type: 'offer', title: 'Fresh eggs, a dozen', category: 'food', price_c: 1200, photoUrl: '/api/marketplace/posts/h-eggs/photos/0?v=1&k=Ab' };
const SEEDLINGS: HomeMarketItem = { id: 'h-seed', type: 'offer', title: 'Tomato seedlings', category: 'garden', price_c: 800, photoUrl: '/api/marketplace/posts/h-seed/photos/0?v=1&k=Cd' };
const LADDER: HomeMarketItem = { id: 'h-ladder', type: 'need', title: 'Borrow a long ladder', category: 'tools', price_c: 500, photoUrl: null, distanceKm: 2 };
const LESSONS: HomeMarketItem = { id: 'h-guitar', type: 'offer', title: 'Guitar lessons', category: 'arts', price_c: 4000, photoUrl: '/api/marketplace/posts/h-guitar/photos/0?v=1&k=Ef' };
const LONG: HomeMarketItem = {
    id: 'h-long', type: 'offer', category: 'goods', price_c: 2500, photoUrl: null,
    title: 'Hand-built cedar garden bench with a curved back, oiled twice, seats three comfortably, can deliver within town',
};
const FOUR = [EGGS, SEEDLINGS, LADDER, LESSONS];

async function show(items: HomeMarketItem[], { showsBeans = true, colors = lightColors as AppColors } = {}) {
    const body = createElement(MarketBody, { items, examples: false, nodeUrl: NODE, showsBeans, colors, onSeeAll: () => {} });
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, body) as any); });
    await settle();
}
const tile = (id: string) => host.querySelector(`[data-testid="home-market-${id}"]`) as HTMLElement;
const grid = () => host.querySelector('[data-testid="home-market-tiles"]') as HTMLElement | null;
/** Each row of the grid: the ids of its tiles, and '·' for the empty half beside a lone last one. */
const rows = () => Array.from(grid()?.children ?? []).map(r => Array.from(r.children).map(c => c.getAttribute('data-testid')?.replace('home-market-', '') ?? '·'));
const photoSlot = (id: string) => tile(id).querySelector('[data-testid="home-market-tile-photo"]') as HTMLElement;
/** A tile's lines of words under its photo: the title, then the price line where there is one. */
const lineOf = (id: string, nth: number) => Array.from(tile(id).querySelectorAll(':scope > span'))[nth] as HTMLElement | undefined;

describe("Home's Market card as picture tiles: how many", () => {
    it('no listings: no tiles, the four category tiles and See all, as before', async () => {
        await show([]);
        expect(grid()).toBeNull();
        expect(host.querySelector('[data-testid="home-market-empty-tiles"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="home-market-all"]')).not.toBeNull();
    });

    it('one listing: one tile at half the width, an empty half beside it', async () => {
        await show([EGGS]);
        expect(rows()).toEqual([['h-eggs', '·']]);
    });

    it('three listings: two a row, the last alone with an empty half', async () => {
        await show([EGGS, SEEDLINGS, LADDER]);
        expect(rows()).toEqual([['h-eggs', 'h-seed'], ['h-ladder', '·']]);
    });

    it('four (the most the node sends): two rows of two, in the order given', async () => {
        await show(FOUR);
        expect(rows()).toEqual([['h-eggs', 'h-seed'], ['h-ladder', 'h-guitar']]);
        expect(host.querySelectorAll('[data-testid="home-market-empty-tiles"]').length).toBe(0);
    });
});

describe('what a tile shows', () => {
    it("the listing's photo, its small copy (never a bigger one), with OFFER on its corner; the title and the price under it", async () => {
        await show(FOUR);
        const img = photoSlot('h-eggs').querySelector('img[data-src]');
        expect(img?.getAttribute('data-src')).toBe(`${NODE}${EGGS.photoUrl}&size=thumb2`);
        expect(photoSlot('h-eggs').textContent).toContain('OFFER');
        expect(lineOf('h-eggs', 0)?.textContent).toBe('Fresh eggs, a dozen');
        expect(lineOf('h-eggs', 1)?.textContent).toBe('12 Beans');
        // Beans, in words: never a symbol.
        expect(tile('h-eggs').textContent).not.toMatch(/Ʀ|🫘/);
        // A Need says so on its photo, with its price and how far.
        expect(photoSlot('h-ladder').textContent).toContain('NEED');
        expect(lineOf('h-ladder', 1)?.textContent).toBe('5 Beans · 2.0 km');
    });

    it('no photo: the category tile holds the slot, never a broken picture or an empty box', async () => {
        await show(FOUR);
        expect(photoSlot('h-ladder').querySelector('img')).toBeNull();
        expect(photoSlot('h-ladder').querySelector('[data-testid="category-tile"]')).not.toBeNull();
        expect(photoSlot('h-ladder').textContent).toContain('TOOLS');
    });

    it('a long title is cut to two lines on the tile and heard whole by a screen reader', async () => {
        await show([LONG]);
        expect(lineOf('h-long', 0)?.getAttribute('data-lines')).toBe('2');
        expect(tile('h-long').getAttribute('aria-label')).toBe(`Offer: ${LONG.title}. 25 Beans. Goods. Opens the listing.`);
        // The price stays on its own line under the title.
        expect(lineOf('h-long', 1)?.textContent).toBe('25 Beans');
    });

    it('Beans off: no price and no Beans anywhere on a tile; a distance still shows; the screen reader hears no price', async () => {
        await show(FOUR, { showsBeans: false });
        for (const p of FOUR) expect(tile(p.id).textContent, p.id).not.toMatch(/Beans|Free/);
        expect(lineOf('h-eggs', 1)).toBeUndefined();
        expect(lineOf('h-ladder', 1)?.textContent).toBe('2.0 km');
        expect(tile('h-eggs').getAttribute('aria-label')).toBe('Offer: Fresh eggs, a dozen. Food. Opens the listing.');
    });
});

describe('a tap anywhere on a tile opens the listing', () => {
    it('the photo, the title or the price: each opens that listing, and a tile is one target', async () => {
        await show(FOUR);
        for (const p of FOUR) {
            expect(tile(p.id).getAttribute('role')).toBe('button');
            // Nothing inside a tile is a target of its own.
            expect(tile(p.id).querySelectorAll('button, [role="button"], [role="link"]').length, p.id).toBe(0);
        }
        await act(async () => { photoSlot('h-seed').click(); });
        await act(async () => { lineOf('h-ladder', 0)!.click(); });
        await act(async () => { lineOf('h-guitar', 1)!.click(); });
        expect(nav.pushed).toEqual([
            { pathname: '/post/[id]', params: { id: 'h-seed' } },
            { pathname: '/post/[id]', params: { id: 'h-ladder' } },
            { pathname: '/post/[id]', params: { id: 'h-guitar' } },
        ]);
    });
});

describe('light and dark: every colour from the tokens, and each reads', () => {
    // The dark set is the same shape with its own values (the app hands either to a card as AppColors).
    it.each([['light', lightColors], ['dark', darkColors as unknown as AppColors]] as const)('%s', async (name, colors) => {
        look.dark = name === 'dark';
        await show(FOUR, { colors });
        const title = lineOf('h-eggs', 0)!;
        const price = lineOf('h-eggs', 1)!;
        expect(title.getAttribute('data-color')).toBe(colors.text.heading);
        expect(price.getAttribute('data-color')).toBe(colors.brand.primary);
        expect(photoSlot('h-eggs').getAttribute('data-bg')).toBe(colors.surface.subtle);
        // The chip on the photo: the Market's own OFFER and NEED pairs.
        const chip = (id: string) => photoSlot(id).querySelector(':scope > div[data-bg]:not([data-testid])') as HTMLElement;
        expect(chip('h-eggs').getAttribute('data-bg')).toBe(colors.market.offer.bg);
        expect(chip('h-ladder').getAttribute('data-bg')).toBe(colors.market.need.bg);
        expect(chip('h-ladder').querySelector('span')?.getAttribute('data-color')).toBe(colors.market.need.fg);
        // The placeholder is the category's tile colour in this set.
        expect(photoSlot('h-ladder').querySelector('[data-testid="category-tile"]')?.getAttribute('data-bg')).toBe(colors.tile.tools.tint);
        // Each pair reads at 4.5:1 or more on its ground: the words on the card, the chips' words on their tint.
        expect(contrastRatio(colors.text.heading, colors.surface.card)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors.brand.primary, colors.surface.card)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors.market.offer.fg, colors.market.offer.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors.market.need.fg, colors.market.need.bg)).toBeGreaterThanOrEqual(4.5);
    });
});
