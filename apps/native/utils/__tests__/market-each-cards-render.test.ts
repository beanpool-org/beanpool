// @vitest-environment jsdom
/**
 * Per-item prices, slice P2 (scratch/fable-design/DESIGN-per-item-price-fable.md §2.1): the Market's three cards on the phone for an
 * Offer priced for each one, rendered for real at 320 dp x 1.3, light and dark. Rob's panels: 300 Beans each, 20 of them, or all 20
 * for 5,500. The list card has "300 [bean] each" at the row's end and "20 left · or all for 5,500" under the title; the grid has the
 * same price in its pill with "all 5,500" under it and "20 LEFT" in the last row's one chip; the compact row has the price with
 * "all 5,500" under it and "20 left" under the by-line. The price for all goes when one is taken singly; none left reads "All taken
 * for now". Where Beans are off there is no count, and every other listing is drawn as it was.
 *
 * The Market's harness is market-deal-chip-render.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
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
import { LanguageProvider } from '../../components/LanguageProvider';
import MarketScreen from '../../app/(tabs)/market';

const NODE = 'https://mullum.example';
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();
const base = (id: string, title: string, over: Record<string, unknown> = {}) => ({
    id, type: 'offer', status: 'active', title, description: 'Words', category: 'tools', author_pubkey: 'rob-key', author_callsign: 'Rob',
    author_energy_cycled: 0, price_c: 500, price_type: 'fixed', photos: '[]', repeatable: 0, created_at: iso(now - 60_000), ...over,
});
/** The phone's cached rows: the three per-item columns beside the price (utils/db.ts posts). */
const EACH = { price_type: 'each', price_c: 30000, units_left: 20, lot_units: 20, lot_price_c: 550000 };
const POSTS = [
    base('p-lot', 'Solar panels', EACH),
    base('p-nolot', 'Panels one gone', { ...EACH, units_left: 19 }),
    base('p-out', 'Panels all held', { ...EACH, units_left: 0 }),
    base('p-free', 'Free offcuts', { ...EACH, price_c: 0, lot_units: null, lot_price_c: null }),
    base('p-plain', 'Firewood', { price_c: 4000 }),
];
function community(): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Record<string, unknown> = {
        getPosts: POSTS, getMarketplaceTransactions: [], getMyPosts: [], fetchMyEvents: [],
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
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(4); };
/** The words in an element, each leaf text box on its own (boxes stack, so their text is not run together on screen). */
const words = (el: Element | null | undefined) => {
    if (!el) return '';
    // Every piece of text under the element, in order. A Text may hold words AND another Text (the price with the price for all on a
    // second line of it), so the edge of a span is a space, and the Beans picture (an img) is nothing.
    const out: string[] = [];
    const walk = (n: Node) => {
        if (n.nodeType === 3) { out.push(n.textContent ?? ''); return; }
        const span = n instanceof Element && n.tagName === 'SPAN';
        if (span) out.push(' ');
        n.childNodes.forEach(walk);
        if (span) out.push(' ');
    };
    el.childNodes.forEach(walk);
    return out.join('').replace(/\s+/g, ' ').trim();
};
/** The card (its open button) of this listing. */
const cardOf = (id: string) => host.querySelector(`[data-testid="market-card-${id}"]`) as HTMLElement;

for (const theme of ['light', 'dark'] as const) {
    describe(`the Market's cards for a listing priced for each one, at 320 dp x 1.3 (${theme})`, () => {
        beforeEach(() => { look.theme = theme; });

        it('the list card: "300 each" at the row\'s end, "20 left · or all for 5,500" under the title as two whole phrases', async () => {
            await renderMarket();
            const lot = cardOf('p-lot');
            expect(words(lot.querySelector('[data-testid="listing-price-each"]'))).toBe('300 each');
            const line = lot.querySelector('[data-testid="listing-each-line"]')!;
            expect(words(line)).toBe('20 left · or all for 5,500');
            // The phrases are their own boxes, so a narrow screen breaks between them and never inside one.
            expect(words(line.querySelector('[data-testid="listing-each-stock"]'))).toBe('20 left ·');
            expect(words(line.querySelector('[data-testid="listing-each-all"]'))).toBe('or all for 5,500');
            expect(line.getAttribute('data-wrap')).toBe('wrap');
            // Neither the price nor the line is clamped to a number of lines (no ellipsis).
            expect(lot.querySelector('[data-testid="listing-price-each"] [data-lines]')).toBeNull();
            expect(line.querySelector('[data-lines]')).toBeNull();
            // The picture is the Beans sign's place: no emoji reaches a phone with no glyph for it.
            expect(lot.textContent).not.toContain('🫘');
            expect(lot.querySelectorAll('[data-testid="listing-price-each"] img')).toHaveLength(1);
        });

        it('one taken singly: the price for all is gone; all held: words, not a count; a free one says Free and its count', async () => {
            await renderMarket();
            expect(words(cardOf('p-nolot').querySelector('[data-testid="listing-each-line"]'))).toBe('19 left');
            expect(words(cardOf('p-out').querySelector('[data-testid="listing-each-line"]'))).toBe('All taken for now');
            const free = cardOf('p-free');
            expect(words(free.querySelector('[data-testid="listing-price-free"]'))).toBe('Free');
            expect(words(free.querySelector('[data-testid="listing-each-line"]'))).toBe('20 left');
            expect(free.querySelector('img')).toBeNull();
        });

        it('any other listing is drawn as it was: its figure, no count line', async () => {
            await renderMarket();
            const plain = cardOf('p-plain');
            expect(plain.querySelector('[data-testid="listing-each-line"]')).toBeNull();
            expect(plain.querySelector('[data-testid="listing-price-each"]')).toBeNull();
            expect(plain.textContent).toContain('40');
        });

        it('the grid: the pill has "300 each" and "all 5,500" under it; the last row\'s one chip says 20 LEFT, the warning one ALL TAKEN FOR NOW', async () => {
            await renderMarket();
            await click(host.querySelector('[aria-label="Grid view"]'));
            const lot = cardOf('p-lot');
            expect(words(lot.querySelector('[data-testid="listing-price-each"]'))).toBe('300 each all 5,500');
            expect(words(lot.querySelector('[data-testid="listing-price-all"]'))).toBe('all 5,500');
            expect(words(lot.querySelector('[data-testid="card-stock-chip"]'))).toBe('20 LEFT');
            expect(lot.querySelector('[data-testid="card-stock-chip"]')!.closest('[data-testid="grid-last-row"]')).not.toBeNull();
            expect(words(cardOf('p-nolot').querySelector('[data-testid="listing-price-each"]'))).toBe('300 each');
            expect(words(cardOf('p-nolot').querySelector('[data-testid="card-stock-chip"]'))).toBe('19 LEFT');
            expect(words(cardOf('p-out').querySelector('[data-testid="card-stock-chip"]'))).toBe('ALL TAKEN FOR NOW');
            expect(cardOf('p-plain').querySelector('[data-testid="card-stock-chip"]')).toBeNull();
        });

        it('the compact row: the price with "all 5,500" under it, and "20 left" under the by-line', async () => {
            await renderMarket();
            // The toggle cycles list > grid > compact: the second press.
            await click(host.querySelector('[aria-label="Grid view"]'));
            await click(host.querySelector('[aria-label="Compact view"]'));
            const lot = cardOf('p-lot');
            expect(words(lot.querySelector('[data-testid="listing-price-each"]'))).toBe('300 each all 5,500');
            expect(words(lot.querySelector('[data-testid="card-stock"]'))).toBe('20 left');
            expect(words(cardOf('p-nolot').querySelector('[data-testid="card-stock"]'))).toBe('19 left');
            expect(cardOf('p-nolot').querySelector('[data-testid="listing-price-all"]')).toBeNull();
            expect(cardOf('p-plain').querySelector('[data-testid="card-stock"]')).toBeNull();
        });
    });
}

describe('where the community shows no Beans there is no count either', () => {
    it('Beans off: no price, no count, no price for all on any card', async () => {
        look.theme = 'light';
        store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'global', features: { beans: false, escrow: false, showcase: true }, checkedAt: new Date().toISOString() } }));
        await renderMarket();
        const lot = cardOf('p-lot');
        expect(lot).toBeTruthy();
        expect(lot.textContent).not.toMatch(/left|each|all for|5,500/i);
        expect(lot.querySelector('[data-testid="listing-each-line"]')).toBeNull();
    });
});
