// @vitest-environment jsdom
/**
 * Block stays available on the enterprise page, under a "…" menu at its foot (scratch/tools/
 * DESIGN-shops-round3-enterprise-shopfront-fable.md §0 row 11, §3, slice E1): a member may hide a shop they don't want
 * to see; it is not a red header button, as it was on the member Trust Profile an enterprise used to open. A keeper of
 * the enterprise has no Block on their own enterprise's page. Report stays where it was.
 *
 * app/treasury-detail.tsx rendered for real, in light and dark at the floor's window (320 × 569 dp, text at 1.3×), and in
 * the pseudo-locale (every word through t()); the node is the net-spy stand-in for utils/db answering one enterprise,
 * and utils/blocklist a spy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Every alert's title, body and buttons, and the last alert's buttons (to press one). */
const alerts = vi.hoisted(() => ({ said: [] as string[], last: [] as Array<{ text?: string; style?: string; onPress?: () => void }> }));

// The default banner (DefaultBanner) draws the bundled avatars, whose require(…jpg) vitest cannot load.
vi.mock('../bundled-avatars', () => ({ BUNDLED_AVATARS: [], resolveBundledAvatar: () => 1 }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', menu: 'menu', menuitem: 'menuitem' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, placeholder, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.expanded !== undefined) attrs['aria-expanded'] = String(accessibilityState.expanded);
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
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; style?: string; onPress?: () => void }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                for (const b of buttons ?? []) if (b.text) alerts.said.push(b.text);
                alerts.last = buttons ?? [];
            },
        },
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
const nav = vi.hoisted(() => ({ backs: 0 }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() { nav.backs++; }, setParams() {}, canGoBack: () => true },
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
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
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
const ENT = '7'.repeat(64);
const me = vi.hoisted(() => ({ identity: { publicKey: '1'.repeat(64), callsign: 'Ana' } as Record<string, string> }));
vi.mock('../identity', () => ({ loadIdentity: async () => me.identity }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../node-post', () => ({ signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}), anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));
const blocks = vi.hoisted(() => ({ calls: [] as unknown[][], blocked: false }));
vi.mock('../blocklist', () => ({
    blockUser: async (...args: unknown[]) => { blocks.calls.push(args); return true; },
    isUserBlocked: async () => blocks.blocked,
}));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { darkColors, lightColors } from '../../constants/colors';
import TreasuryDetailScreen from '../../app/treasury-detail';

const NODE = 'https://mullum.example';
const NAME = "Damo's Enterprise";
const iso = (ms: number) => new Date(ms).toISOString();
/** The enterprise as a member who is not one of its keepers reads it. */
function membersView(over: Record<string, unknown> = {}) {
    return {
        publicKey: ENT, name: NAME, purpose: 'We fix bikes, phones and kettles', lifecycle: 'ongoing', status: 'active', paused: false,
        balance: 12, creditLine: 50, liveOffers: 1, earnedSurplus: 0, workingCapitalCeiling: null,
        isLeadOrSoleKeeperOrAdmin: false, availableToBack: 0,
        keepers: [{ publicKey: DAMO, callsign: 'Damo', role: 'lead', grantedAt: iso(Date.now() - 30 * 86400_000) }],
        keeperRequests: [], keeperChanges: [], deferredClaims: [],
        posts: [], flow: [], pendingBids: [], activeDeals: [],
        ...over,
    };
}
function community(over: Record<string, unknown> = {}): (name: string) => Promise<unknown> | undefined {
    const answers: Record<string, unknown> = {
        getTreasuryDetail: membersView(),
        getBalance: { balance: 10, keeperOf: [] },
        getEnterpriseThread: { conversation: null, messages: [], readOnly: true },
        getEnterpriseLedger: null,
        getEnterpriseDecisions: null,
        ...over,
    };
    return (name) => (name in answers ? Promise.resolve(answers[name]) : undefined);
}
const LOCAL = { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.answer = community();
    params.now = { publicKey: ENT, name: NAME };
    alerts.said.length = 0;
    alerts.last = [];
    nav.backs = 0;
    blocks.calls.length = 0;
    blocks.blocked = false;
    theme.dark = false;
    me.identity = { publicKey: ME, callsign: 'Ana' };
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: LOCAL, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang = 'en') {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(TreasuryDetailScreen)) as any); });
    await settle();
}
const byLabel = (label: string) => host.querySelector(`[aria-label="${label.replace(/"/g, '\\"')}"]`);
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};
const pressAlertButton = async (text: string) => {
    const b = alerts.last.find((x) => x.text === text);
    expect(b, `the alert's ${text}`).toBeTruthy();
    await act(async () => { b!.onPress?.(); });
    await settle(4);
};
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');

for (const dark of [false, true]) {
    describe(`the enterprise page's "…" menu (${dark ? 'dark' : 'light'}, 320 dp × 1.3)`, () => {
        beforeEach(() => { theme.dark = dark; });

        it("a member: Block is under the \"…\" at the foot, never in the header; it asks first, then blocks the enterprise's key and goes back", async () => {
            const colors = dark ? darkColors : lightColors;
            await renderIn();
            expect(host.textContent).toContain(NAME);
            // Nothing of Block on the page until the menu is opened, and Report as it was.
            expect(host.textContent).not.toContain(`Block ${NAME}`);
            expect(byLabel('Report Enterprise')).toBeTruthy();
            const more = byLabel('More options');
            expect(more, 'the "…" button').toBeTruthy();
            expect(more?.querySelector('[data-icon="dots-horizontal"]')).toBeTruthy();
            expect(more?.getAttribute('aria-expanded')).toBe('false');
            // A 44 dp target, at the foot (after Report), not in the header.
            expect(styleOf(more).minWidth).toBeGreaterThanOrEqual(44);
            expect(styleOf(more).minHeight).toBeGreaterThanOrEqual(44);
            const all = Array.from(host.querySelectorAll('[aria-label]'));
            expect(all.indexOf(more!)).toBeGreaterThan(all.indexOf(byLabel('Report Enterprise')!));

            await click(more, 'More options');
            expect(more?.getAttribute('aria-expanded')).toBe('true');
            const block = byLabel(`Block ${NAME}`);
            expect(block, 'the menu\'s Block').toBeTruthy();
            expect(block?.textContent).toContain(`Block ${NAME}`);
            // Its words in the palette's danger colour, which the palette holds at 4.5:1 on a card, in light and in dark.
            expect(styleOf(block!.querySelector('span')).color).toBe(colors.feedback.danger.fg);
            expect(styleOf(block!.querySelector('span')).flexShrink).toBe(1);
            expect(styleOf(block).minHeight).toBeGreaterThanOrEqual(44);

            await click(block, 'Block');
            expect(alerts.said).toEqual([
                `Block ${NAME}?`,
                `This will instantly hide all posts, offers, and messages from ${NAME}, and notify moderation.`,
                'Cancel', 'Block',
            ]);
            expect(blocks.calls).toEqual([]);
            await pressAlertButton('Block');
            expect(blocks.calls).toHaveLength(1);
            expect(blocks.calls[0][0]).toBe(ENT);
            expect(blocks.calls[0][1]).toBe(ME);
            expect(alerts.said).toContain(`${NAME} has been blocked and removed from your feed.`);
            await pressAlertButton('OK');
            expect(nav.backs).toBe(1);
        });

        it('Cancel blocks nothing', async () => {
            await renderIn();
            await click(byLabel('More options'), 'More options');
            await click(byLabel(`Block ${NAME}`), 'Block');
            await pressAlertButton('Cancel');
            expect(blocks.calls).toEqual([]);
            expect(nav.backs).toBe(0);
        });

        it('a keeper of this enterprise: no "…" and no Block on its page; Report as it was', async () => {
            net.answer = community({ getBalance: { balance: 10, keeperOf: [ENT] } });
            await renderIn();
            expect(host.textContent).toContain(NAME);
            expect(byLabel('More options')).toBeNull();
            expect(host.textContent).not.toContain(`Block ${NAME}`);
            expect(byLabel('Report Enterprise')).toBeTruthy();
        });

        it("a project says it in its own words: Block the project's name", async () => {
            net.answer = community({ getTreasuryDetail: membersView({ name: 'Village Hall Roof', lifecycle: 'bounded', goalAmount: 500, currentAmount: 40 }) });
            params.now = { publicKey: ENT, name: 'Village Hall Roof' };
            await renderIn();
            expect(byLabel('Report Project')).toBeTruthy();
            await click(byLabel('More options'), 'More options');
            expect(byLabel('Block Village Hall Roof')).toBeTruthy();
        });

        it('an enterprise this member has blocked already: the menu says so and offers no second block', async () => {
            blocks.blocked = true;
            await renderIn();
            await click(byLabel('More options'), 'More options');
            expect(byLabel(`Block ${NAME}`)).toBeNull();
            expect(host.querySelector('[data-testid="enterprise-more-menu"]')?.textContent).toContain(`${NAME} is blocked`);
        });
    });
}

describe('the "…" menu in the pseudo-locale: every word through t()', () => {
    it('its button, its Block, the question and the answer', async () => {
        await renderIn('xx');
        const xx = (s: string, values: Record<string, string> = {}) => Object.entries(values).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), pseudoLocalise(s));
        await click(byLabel(xx('More options')), 'More options');
        await click(byLabel(xx('Block {name}', { name: NAME })), 'Block');
        expect(alerts.said).toEqual([
            xx('Block {name}?', { name: NAME }),
            xx('This will instantly hide all posts, offers, and messages from {name}, and notify moderation.', { name: NAME }),
            xx('Cancel'), xx('Block'),
        ]);
        await pressAlertButton(xx('Block'));
        expect(alerts.said).toContain(xx('{name} has been blocked and removed from your feed.', { name: NAME }));
    });
});
