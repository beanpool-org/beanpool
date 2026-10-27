// @vitest-environment jsdom
/**
 * A shop's page (slice S5 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3 "The member's shop page",
 * on DESIGN-shops-and-tools-fable.md §8): the enterprise page's shopfront minus keepers and money. A member reads, in
 * order: the banner and the owner's picture as its logo, its name, its kind and since when, the owner's trust line, About,
 * Featured, its sections, How I deal, and Message (a DM to the owner). Its owner reads it as members do, with the way to
 * change it instead of Message. An enterprise's shop is its page; a visitor's view, none and no answer are each said.
 *
 * app/shop/[id].tsx rendered for real, in light and dark at the floor's window (320 × 569 dp, text at 1.3×), and in the
 * pseudo-locale; the node is the net-spy stand-in for utils/db.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
    Loader._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
});
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
const nav = vi.hoisted(() => ({ pushes: [] as unknown[], replaces: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push(to: unknown) { nav.pushes.push(to); }, navigate() {}, replace(to: unknown) { nav.replaces.push(to); }, back() {}, setParams() {}, canGoBack: () => true },
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
vi.mock('expo-image', () => ({ Image: ({ source, testID, ...rest }: { source?: { uri?: string }; testID?: string }) => createElement('img', { src: source?.uri, 'data-testid': testID, ...rest }) }));
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
const DAVE = '4'.repeat(64);
const ENT = '7'.repeat(64);
const me = vi.hoisted(() => ({ identity: { publicKey: '1'.repeat(64), callsign: 'Ana' } as Record<string, string> }));
vi.mock('../identity', () => ({ loadIdentity: async () => me.identity }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ size }: { size?: number }) => createElement('span', { 'data-avatar': String(size ?? '') }) }));
vi.mock('../node-post', () => ({ signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}), anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null }));
const net = vi.hoisted(() => ({ calls: [] as string[], args: [] as Array<[string, unknown[]]>, answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => { net.args.push([name, args]); return net.answer?.(name, args); }));
vi.mock('../blocklist', () => ({ blockUser: async () => true, isUserBlocked: async () => false }));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { darkColors, lightColors } from '../../constants/colors';
import ShopPageScreen from '../../app/shop/[id]';

const NODE = 'https://mullum.example';
const SHOP = 'shop-dave';
const BLURB = 'Tools to lend on our street: ladders, drills, a trailer.';
const HOW = 'Knock first. Back by Sunday, please.';
function memberShop(over: Record<string, unknown> = {}) {
    return {
        id: SHOP, category: 'tools', counts: { things: 3, available: 3, toBorrow: 2, toBuy: 1, out: 0, newThisWeek: 1 },
        name: "Dave's Tool Shed", ownerPublicKey: DAVE, ownerName: 'Dave', enterprise: false, blurb: BLURB, howToDeal: HOW,
        paused: false, backOn: null, openedAt: '2026-08-14T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z', ...over,
    };
}
const LISTINGS = [
    { id: 'l1', type: 'offer', category: 'tools', title: 'Ladder, 3 m', credits: 2, priceType: 'daily', status: 'active', lendable: true, featuredAt: '2026-10-20T00:00:00.000Z', shopId: SHOP, photos: ['/api/marketplace/posts/l1/photos/0'], authorEnergyCycled: 200 },
    { id: 'l2', type: 'offer', category: 'tools', title: 'Cordless drill', credits: 1, priceType: 'daily', status: 'pending', lendable: true, shopId: SHOP, authorEnergyCycled: 200 },
    { id: 'l3', type: 'offer', category: 'tools', title: 'Box of screws', credits: 3, priceType: 'fixed', status: 'active', shopId: SHOP, authorEnergyCycled: 200 },
];
type Answer = { status: number; json?: unknown } | 'down';
function node(shop: Answer = { status: 200, json: memberShop() }, listings: Answer = { status: 200, json: LISTINGS }) {
    return (name: string, args: unknown[]): Promise<unknown> | undefined => {
        if (name === 'signedGet') {
            const path = String(args[0]);
            const a = path === `/api/shops/${SHOP}` ? shop : path.startsWith(`/api/marketplace/posts?shop=${SHOP}`) ? listings : null;
            if (!a) return undefined;
            if (a === 'down') return Promise.reject(new TypeError('Network request failed'));
            return Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json ?? null });
        }
        if (name === 'getMemberProfile') return Promise.resolve({ public_key: DAVE, avatar_url: '/api/avatar/dave' });
        if (name === 'getMemberRatings') return Promise.resolve({ average: 5, count: 2 });
        if (name === 'createConversationApi') return Promise.resolve({ id: 'dm-dave' });
        return undefined;
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
    net.answer = node();
    params.now = { id: SHOP };
    nav.pushes.length = 0;
    nav.replaces.length = 0;
    theme.dark = false;
    me.identity = { publicKey: ME, callsign: 'Ana' };
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: LOCAL, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang = 'en') {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(ShopPageScreen)) as any); });
    await settle();
}
/** A fresh mount, for a case that reads the screen again from the start. */
async function remount(lang: UiLang = 'en') {
    act(() => root.unmount());
    root = createRoot(host);
    await renderIn(lang);
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
const at = (text: string) => {
    const i = host.textContent!.indexOf(text);
    expect(i, `"${text}" on the page`).toBeGreaterThanOrEqual(0);
    return i;
};

for (const dark of [false, true]) {
    describe(`a member's shop page (${dark ? 'dark' : 'light'}, 320 dp × 1.3)`, () => {
        beforeEach(() => { theme.dark = dark; });
        const colors = () => (dark ? darkColors : lightColors);

        it("its banner is the photo its owner chose, from its community; the same layout as an enterprise's", async () => {
            const PHOTO = `/api/shops/${SHOP}/photo?v=ab12cd34&k=${'K'.repeat(22)}`;
            net.answer = node({ status: 200, json: memberShop({ photoUrl: PHOTO }) });
            await renderIn();
            const banner = byId('shopfront-banner');
            expect(banner?.querySelector('img')?.getAttribute('src')).toBe(`${NODE}${PHOTO}`);
            expect(banner?.textContent).toBe('');
            expect(byId('shopfront-name')?.textContent).toBe("Dave's Tool Shed");
        });

        it('a member reads its shopfront in order, and Message writes to its owner', async () => {
            await renderIn();
            // No banner photo: the default banner from its logo (S3), echo with 1 round copy on category's tint (photo avatar).
            const defaultBanner = byId('shopfront-banner')?.querySelector('[data-testid="default-banner"]');
            expect(defaultBanner).not.toBeNull();
            expect(styleOf(defaultBanner!).backgroundColor).toBe(colors().tile.tools.tint);
            expect(defaultBanner?.querySelectorAll('[data-testid="default-banner-echo-copy"]').length).toBe(1);
            expect(styleOf(byId('shopfront-banner')).backgroundColor).toBe(colors().brand.tint);
            expect(byId('shopfront-logo')?.querySelector('[data-avatar="64"]')).toBeTruthy();
            expect(byId('shopfront-name')?.textContent).toBe("Dave's Tool Shed");
            expect(host.textContent).toContain('🛠️ Tools · since Aug 2026');
            expect(byId('shop-page-owner')?.textContent).toContain('Dave');
            expect(byId('shopfront-about')?.textContent).toContain(BLURB);
            expect(Array.from(byId('shopfront-featured')!.querySelectorAll('[data-testid^="shopfront-featured-"]')).map((e) => e.getAttribute('data-testid'))).toEqual(['shopfront-featured-l1']);
            expect(byId('shopfront-section-toBorrow')?.textContent).toContain('To borrow (2)');
            expect(byId('shopfront-row-l2')?.textContent).toContain('1 🫘 a day · Out on loan');
            expect(byId('shopfront-section-toBuy')?.textContent).toContain('Box of screws');
            expect(byId('shopfront-how')?.textContent).toContain(HOW);
            expect(byId('shopfront-message')?.textContent).toBe('Message Dave');
            const order = ["Dave's Tool Shed", 'since Aug 2026', BLURB, 'Featured', 'To buy (1)', 'To borrow (2)', HOW, 'Message Dave'].map(at);
            expect([...order].sort((a, b) => a - b)).toEqual(order);
            // One read for the shop, one for its Offers as this reader may see them.
            expect(net.args.filter(([n]) => n === 'signedGet').map(([, a]) => a[0])).toEqual([`/api/shops/${SHOP}`, `/api/marketplace/posts?shop=${SHOP}&type=offer&limit=200`]);
            expect(styleOf(byId('shopfront-message')).backgroundColor).toBe(colors().brand.fill);

            await click(byId('shopfront-message'), 'Message Dave');
            expect(net.args.find(([n]) => n === 'createConversationApi')?.[1]).toEqual(['dm', [ME, DAVE], ME]);
            expect(nav.pushes).toContainEqual('/chat/dm-dave');
        });

        it("the owner's line is a 48 dp target to their profile", async () => {
            await renderIn();
            const owner = byId('shop-page-owner');
            expect(styleOf(owner).minHeight).toBeGreaterThanOrEqual(48);
            expect(owner?.getAttribute('aria-label')).toBe("View Dave's profile");
            await click(owner, 'the owner line');
            expect(nav.pushes).toEqual([{ pathname: '/public-profile', params: { publicKey: DAVE, callsign: 'Dave' } }]);
        });

        it('a tile and a row open their listing', async () => {
            await renderIn();
            await click(byId('shopfront-featured-l1'), 'the ladder tile');
            await click(byId('shopfront-row-l3'), 'the screws row');
            expect(nav.pushes).toEqual([{ pathname: '/post/[id]', params: { id: 'l1' } }, { pathname: '/post/[id]', params: { id: 'l3' } }]);
        });

        it('its owner reads it as members do, with the way to change it instead of Message', async () => {
            me.identity = { publicKey: DAVE, callsign: 'Dave' };
            await renderIn();
            expect(byId('shopfront-message')).toBeNull();
            expect(byId('shop-page-mine')?.textContent).toContain('This is your shop as members here see it.');
            await click(byId('shop-page-change'), 'Change your shop');
            expect(nav.pushes).toEqual(['/shop/mine']);
        });

        it('unnamed, closed for now: "Dave\'s shop", the day it is back, and what waits', async () => {
            net.answer = node({ status: 200, json: memberShop({ name: null, paused: true, backOn: '2026-11-02' }) }, { status: 200, json: [] });
            await renderIn();
            expect(byId('shopfront-name')?.textContent).toBe("Dave's shop");
            expect(host.textContent).toContain('Closed for now · back');
            expect(byId('shopfront-sections-empty')?.textContent).toBe('This shop is closed for now. Its Offers wait until it reopens.');
        });

        it("an enterprise's shop is its page: this screen replaces itself", async () => {
            net.answer = node({ status: 200, json: memberShop({ enterprise: true, ownerPublicKey: ENT, ownerName: 'Lou Repairs', name: 'Lou Repairs' }) });
            await renderIn();
            expect(nav.replaces).toEqual([{ pathname: '/treasury-detail', params: { publicKey: ENT, name: 'Lou Repairs' } }]);
        });

        it("a visitor's view, a shop that is gone, and no answer: each said", async () => {
            net.answer = node({ status: 200, json: { id: SHOP, category: 'tools', counts: { things: 3 } } });
            await renderIn();
            expect(byId('shopfront-visitor')?.textContent).toBe("Members of this community see a shop's name, its owner and what it offers.");
            expect(byId('shopfront-message')).toBeNull();

            net.answer = node({ status: 404, json: { code: 'shop_not_found' } });
            await remount();
            expect(byId('shop-page-none')?.textContent).toContain('This shop is not here any more.');

            net.answer = node('down');
            await remount();
            expect(byId('shop-page-offline')?.textContent).toContain("This shop couldn't be read just now. Try again.");
            net.answer = node();
            await click(byId('shop-page-retry'), 'Try again');
            expect(byId('shopfront-name')?.textContent).toBe("Dave's Tool Shed");
        });

        it("its listings couldn't be read: the shop says so, never an empty shop", async () => {
            net.answer = node(undefined, 'down');
            await renderIn();
            expect(byId('shop-page-listings-unread')?.textContent).toBe("What is in this shop couldn't be read just now.");
            expect(byId('shopfront-sections')).toBeNull();
        });
    });
}

describe('the shop page in the pseudo-locale: every word through t()', () => {
    it('its sections, About, How I deal and Message', async () => {
        await renderIn('xx');
        const xx = (s: string, values: Record<string, string> = {}) => Object.entries(values).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), pseudoLocalise(s));
        expect(byId('shopfront-section-toBorrow')?.textContent).toContain(xx('To borrow ({n})', { n: '2' }));
        expect(byId('shopfront-how')?.textContent).toContain(xx('How I deal'));
        expect(byId('shopfront-about')?.textContent).toContain(xx('About'));
        expect(byId('shopfront-message')?.textContent).toBe(xx('Message {name}', { name: 'Dave' }));
    });
});
