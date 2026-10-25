// @vitest-environment jsdom
/**
 * The enterprise page is the shopfront (slice S5 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3,
 * §6; Marty's answers of 23 Oct 2026): shopfront first, money last. A member reads, in order: the banner and the logo,
 * the name, its kind and since when; who keeps it, each with their badges (recognition, which gates nothing, said once);
 * About; Featured; what its keepers do together; its sections; How we deal; Message the lead keeper (a DM to them, named);
 * then the money as one line, the figures, pledges and ledger behind "Money and backing". A project keeps its goal card
 * above About. A visitor's page ends after How we deal. An older node's page reads as before.
 *
 * app/treasury-detail.tsx rendered for real, in light and dark at the floor's window (320 × 569 dp, text at 1.3×), and in
 * the pseudo-locale (every word through t()); the node is the net-spy stand-in for utils/db.
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
// Digits only: a key's first characters, shown where a member has no name, carry no letters.
const ME = '1'.repeat(64);
const DAMO = '2'.repeat(64);
const RACHEL = '3'.repeat(64);
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
import TreasuryDetailScreen from '../../app/treasury-detail';

const NODE = 'https://mullum.example';
const NAME = "Damo's Enterprise";
const SHOP_ID = 'shop-1';
const ABOUT = 'We fix bikes, phones and kettles on Saturdays at the hall.';
const HOW = 'Bring it by on a Saturday; pay in Beans when it works.';
const iso = (ms: number) => new Date(ms).toISOString();
const keepers = [
    { publicKey: RACHEL, callsign: 'Rachel', role: 'admin', avatarUrl: null, tier: 'Newcomer', rating: { average: 0, count: 0 }, trades: 2, offerCategories: ['food'] },
    { publicKey: DAMO, callsign: 'Damo', role: 'lead', avatarUrl: '/api/avatar/2222', tier: 'Resident', rating: { average: 4.8, count: 9 }, trades: 14, offerCategories: ['repairs'] },
];
/** The enterprise as a member who is not one of its keepers reads it from a node with the shopfront (E2 + S5). */
function membersView(over: Record<string, unknown> = {}) {
    return {
        publicKey: ENT, name: NAME, purpose: 'Fixing things so they last.', lifecycle: 'ongoing', status: 'active', paused: false,
        balance: 12, creditLine: 50, liveOffers: 3, earnedSurplus: 4, workingCapitalCeiling: null,
        isLeadOrSoleKeeperOrAdmin: false, availableToBack: 0,
        about: ABOUT, since: '2026-09-03T10:00:00.000Z', offerCategories: ['food', 'repairs'],
        shop: { id: SHOP_ID, category: 'tech', counts: { things: 3 }, name: NAME, ownerPublicKey: ENT, ownerName: NAME, enterprise: true, blurb: null, howToDeal: HOW, paused: false, backOn: null, openedAt: iso(Date.now()) },
        keepers,
        keeperRequests: [], keeperChanges: [], deferredClaims: [],
        posts: [{ id: 'old-1', type: 'offer', category: 'repairs', title: 'Text-only listing', credits: 5, price_type: 'fixed', status: 'active' }],
        flow: [], pendingBids: [], activeDeals: [],
        ...over,
    };
}
/** What `author=` answers: its Offers with photos and stamps, and one Need. */
const LISTINGS = [
    { id: 'p1', type: 'offer', category: 'repairs', title: 'Puncture fixed', credits: 5, priceType: 'fixed', status: 'active', featuredAt: '2026-10-21T00:00:00.000Z', shopId: SHOP_ID, photos: ['/api/marketplace/posts/p1/photos/0'] },
    { id: 'p2', type: 'offer', category: 'electronics', title: 'Phone screen', credits: 30, priceType: 'fixed', status: 'active', featuredAt: '2026-10-22T00:00:00.000Z', shopId: SHOP_ID },
    { id: 'p3', type: 'offer', category: 'repairs', title: 'Bike service', credits: 3, priceType: 'hourly', status: 'active', shopId: SHOP_ID },
    { id: 'n1', type: 'need', category: 'tools', title: 'A workbench', credits: 0, priceType: 'fixed', status: 'active' },
];
function community(over: Record<string, unknown> = {}, listings: unknown = LISTINGS): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Record<string, unknown> = {
        getTreasuryDetail: membersView(),
        getBalance: { balance: 10, keeperOf: [] },
        getEnterpriseThread: { conversation: null, messages: [], readOnly: false },
        getEnterpriseLedger: null,
        getEnterpriseDecisions: null,
        createConversationApi: { id: 'dm-1' },
        ...over,
    };
    return (name, args) => {
        if (name === 'signedGet') {
            const path = String(args[0]);
            if (path.startsWith(`/api/marketplace/posts?author=${ENT}`)) {
                if (listings === 'down') return Promise.reject(new TypeError('Network request failed'));
                return Promise.resolve({ ok: true, status: 200, json: async () => listings });
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
    net.answer = community();
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
async function renderIn(lang: UiLang = 'en') {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(TreasuryDetailScreen)) as any); });
    await settle();
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
/** Where a text first shows in the page's words, to hold the order. */
const at = (text: string) => {
    const i = host.textContent!.indexOf(text);
    expect(i, `"${text}" on the page`).toBeGreaterThanOrEqual(0);
    return i;
};

for (const dark of [false, true]) {
    describe(`the enterprise page is the shopfront (${dark ? 'dark' : 'light'}, 320 dp × 1.3)`, () => {
        beforeEach(() => { theme.dark = dark; });
        const colors = () => (dark ? darkColors : lightColors);

        it('a member reads the shopfront first and the money last, in the order of round 3 §3', async () => {
            await renderIn();
            // The banner, a quiet block in its kind's emoji (no shop photo yet), the logo over its foot, then the name.
            const banner = byId('shopfront-banner');
            expect(banner?.textContent).toBe('💻');
            expect(styleOf(banner).backgroundColor).toBe(colors().brand.tint);
            expect(styleOf(banner).height).toBe(128);
            expect(byId('shopfront-logo')?.querySelector('[data-avatar="64"]')).toBeTruthy();
            expect(byId('shopfront-name')?.textContent).toBe(NAME);
            expect(host.textContent).toContain('💻 Tech · since Sep 2026');
            // Who keeps it: the lead first, each with their badges, and once that the badges gate nothing.
            const keepersBlock = byId('shopfront-keepers');
            expect(keepersBlock?.textContent).toContain('Kept by');
            expect(byId(`shopfront-keeper-${DAMO}`)?.textContent).toContain('Damo · Lead keeper');
            expect(byId(`shopfront-badges-${DAMO}`)?.textContent).toBe('🏠 Resident · ★★★★★ · 14 trades');
            expect(byId(`shopfront-badges-${RACHEL}`)?.textContent).toBe('🌱 Newcomer · 2 trades');
            expect(keepersBlock!.textContent!.indexOf('Damo')).toBeLessThan(keepersBlock!.textContent!.indexOf('Rachel'));
            expect(byId('shopfront-badges-note')?.textContent).toBe('Badges show what each person has done here. They gate nothing.');
            // About, Featured (the latest featured first), what they do together, the sections, How we deal, Message.
            expect(byId('shopfront-about')?.textContent).toContain(ABOUT);
            const tiles = Array.from(byId('shopfront-featured')!.querySelectorAll('[data-testid^="shopfront-featured-"]')).map((e) => e.getAttribute('data-testid'));
            expect(tiles).toEqual(['shopfront-featured-p2', 'shopfront-featured-p1']);
            expect(byId('shopfront-featured-p1')?.querySelector('img')?.getAttribute('src')).toBe(`${NODE}/api/marketplace/posts/p1/photos/0?size=thumb`);
            expect(styleOf(byId('shopfront-featured-p1')).width).toBe(136);
            expect(byId('shopfront-together')?.textContent).toContain('What we do together');
            expect(byId('shopfront-section-toBuy')?.textContent).toContain('To buy (2)');
            expect(byId('shopfront-section-byTime')?.textContent).toContain('3 🫘 an hour');
            expect(byId('shopfront-section-lookingFor')?.textContent).toContain('A workbench');
            expect(byId('shopfront-how')?.textContent).toContain(HOW);
            expect(byId('shopfront-message')?.textContent).toBe('Message Damo (lead keeper)');
            // The money in one line; its figures behind the expand.
            expect(byId('shopfront-money-line')?.textContent).toBe('12 🫘 · credit line 50 🫘');
            expect(host.textContent).not.toContain('Earned surplus'.toUpperCase());
            expect(host.textContent).not.toContain('Text-only listing');
            const order = [NAME, 'Kept by', ABOUT, 'Featured', 'What we do together', 'To buy (2)', HOW, 'Message Damo (lead keeper)', '12 🫘 · credit line 50 🫘', 'Discussion'].map(at);
            expect([...order].sort((a, b) => a - b)).toEqual(order);
        });

        it('what its keepers do together: each category once, an older id and today\'s as one', async () => {
            net.answer = community({ getTreasuryDetail: membersView({ offerCategories: ['food', 'tools', 'tools_hardware'] }) });
            await renderIn();
            const chips = Array.from(byId('shopfront-together')!.querySelectorAll('span')).map((e) => e.textContent).filter((x) => x && x !== 'What we do together');
            expect(chips).toEqual(['🥕 Food', '🛠️ Tools']);
        });

        it('"Money and backing" opens the figures, the pledges and the ledger, and closes them', async () => {
            await renderIn();
            const toggle = byId('shopfront-money-toggle');
            expect(toggle?.getAttribute('aria-expanded')).toBe('false');
            await click(toggle, 'Money and backing');
            expect(toggle?.getAttribute('aria-expanded')).toBe('true');
            const open = byId('shopfront-money-open');
            expect(open?.textContent).toContain('CREDIT LINE');
            expect(open?.textContent).toContain('EARNED SURPLUS');
            expect(open?.textContent).toContain('INCOME & SPEND');
            await click(toggle, 'Hide money and backing');
            expect(byId('shopfront-money-open')).toBeNull();
        });

        it('Message opens the DM with the lead keeper', async () => {
            await renderIn();
            await click(byId('shopfront-message'), 'Message');
            const call = net.args.find(([name]) => name === 'createConversationApi');
            expect(call?.[1]).toEqual(['dm', [ME, DAMO], ME]);
            expect(nav.pushes).toContainEqual('/chat/dm-1');
            expect(styleOf(byId('shopfront-message')).backgroundColor).toBe(colors().brand.fill);
            expect(styleOf(byId('shopfront-message')!.querySelector('span')).color).toBe(colors().text.onBrand);
        });

        it('the lead keeper reading their own page: no Message to themselves', async () => {
            me.identity = { publicKey: DAMO, callsign: 'Damo' };
            await renderIn();
            expect(byId('shopfront-keepers')).toBeTruthy();
            expect(byId('shopfront-message')).toBeNull();
        });

        it("a visitor's cut-off: names and roles, About and How we deal, then a sentence; nothing past it", async () => {
            const visitorKeepers = keepers.map(({ publicKey, callsign, role }) => ({ publicKey, callsign, role }));
            net.answer = community({
                getTreasuryDetail: membersView({ offerCategories: undefined, keepers: visitorKeepers, posts: [], shop: { id: SHOP_ID, category: 'tech', counts: { things: 3 } } }),
            }, []);
            await renderIn();
            expect(byId(`shopfront-keeper-${DAMO}`)?.textContent).toContain('Damo · Lead keeper');
            expect(byId(`shopfront-badges-${DAMO}`)).toBeNull();
            expect(byId('shopfront-badges-note')).toBeNull();
            expect(byId('shopfront-about')?.textContent).toContain(ABOUT);
            expect(byId('shopfront-visitor')?.textContent).toBe("Members of this community see what it offers, its keepers' badges and its accounts.");
            for (const gone of ['shopfront-featured', 'shopfront-together', 'shopfront-sections', 'shopfront-message', 'shopfront-money']) expect(byId(gone), gone).toBeNull();
            expect(host.textContent).not.toContain('Discussion');
            expect(net.calls).not.toContain('db.signedGet');
        });

        it("a project keeps its goal card above About, says who runs it, and Message names its leader", async () => {
            net.answer = community({ getTreasuryDetail: membersView({ name: 'Village Hall Roof', lifecycle: 'bounded', goalAmount: 500, currentAmount: 40 }) });
            params.now = { publicKey: ENT, name: 'Village Hall Roof' };
            await renderIn();
            expect(byId('shopfront-keepers')?.textContent).toContain('Run by');
            expect(byId(`shopfront-keeper-${DAMO}`)?.textContent).toContain('Damo · Leader');
            expect(at('Goal: 500 🫘')).toBeLessThan(at(ABOUT));
            expect(at('Run by')).toBeLessThan(at('Goal: 500 🫘'));
            expect(byId('shopfront-message')?.textContent).toBe('Message Damo (leader)');
        });

        it("the listings couldn't be read: the node's own text listings, in their sections", async () => {
            net.answer = community({}, 'down');
            await renderIn();
            expect(byId('shopfront-section-toBuy')?.textContent).toContain('Text-only listing');
            expect(byId('shopfront-featured')).toBeNull();
        });

        it("the banner is its shop's photo, from its community, filling the block; with none, the quiet block", async () => {
            const PHOTO = `/api/shops/${SHOP_ID}/photo?v=ab12cd34&k=${'K'.repeat(22)}`;
            const view = membersView();
            net.answer = community({ getTreasuryDetail: { ...view, shop: { ...(view.shop as Record<string, unknown>), photoUrl: PHOTO } } });
            await renderIn();
            const banner = byId('shopfront-banner');
            expect(banner?.querySelector('img')?.getAttribute('src')).toBe(`${NODE}${PHOTO}`);
            expect(banner?.textContent).toBe('');
            expect(styleOf(banner).height).toBe(128);
            expect(byId('shopfront-logo')?.querySelector('[data-avatar="64"]')).toBeTruthy();
        });

        it('an older node (no About, no since): the page reads as before, its listings in sections, no cut-off', async () => {
            const { about: _a, since: _s, offerCategories: _o, shop: _shop, ...older } = membersView();
            net.answer = community({ getTreasuryDetail: { ...older, keepers: keepers.map(({ publicKey, callsign, role }) => ({ publicKey, callsign, role })) } }, 'down');
            await renderIn();
            expect(byId('shopfront-banner')?.textContent).toBe('🏛️');
            expect(byId('shopfront-visitor')).toBeNull();
            expect(byId('shopfront-section-toBuy')?.textContent).toContain('Text-only listing');
            expect(byId('shopfront-money-line')?.textContent).toBe('12 🫘 · credit line 50 🫘');
        });
    });
}

describe('the shopfront in the pseudo-locale: every word through t()', () => {
    it('its headings, badges, sections, Message and money', async () => {
        await renderIn('xx');
        const xx = (s: string, values: Record<string, string> = {}) => Object.entries(values).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), pseudoLocalise(s));
        expect(byId('shopfront-keepers')?.textContent).toContain(xx('Kept by'));
        expect(byId('shopfront-badges-note')?.textContent).toBe(xx('Badges show what each person has done here. They gate nothing.'));
        expect(byId('shopfront-featured')?.textContent).toContain(xx('Featured'));
        expect(byId('shopfront-together')?.textContent).toContain(xx('What we do together'));
        expect(byId('shopfront-section-toBuy')?.textContent).toContain(xx('To buy ({n})', { n: '2' }));
        expect(byId('shopfront-how')?.textContent).toContain(xx('How we deal'));
        expect(byId('shopfront-message')?.textContent).toBe(xx('Message {name} (lead keeper)', { name: 'Damo' }));
        expect(byId('shopfront-money-line')?.textContent).toBe(xx('{balance} 🫘 · credit line {credit} 🫘', { balance: '12', credit: '50' }));
        expect(byId('shopfront-money-toggle')?.textContent).toBe(xx('Money and backing ›'));
    });
});
