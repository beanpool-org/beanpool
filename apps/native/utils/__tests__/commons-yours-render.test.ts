// @vitest-environment jsdom
/**
 * Commons S3 (DESIGN-commons-ux-fable.md §3.1, §5 S3):
 * The phone's Groups section shows YOURS first:
 * - Kept enterprises and projects first (lead first), then groups you are in.
 * - Kept enterprise row: role word ('Lead keeper'), 'Balance 40 🫘 · 3 live offers', Manage pill pushing /treasury-manage, row pushing /treasury-detail.
 * - Group row: role word ('Convenor'), tap pushes its chat.
 * - Events you are going to are NOT in Yours (and not drawn on Commons).
 * - The explainer card is deleted.
 * - Yours empty line: two variants based on community shape.
 * - 320 dp × 1.3 layout measurement: name wraps to two lines, Manage pill keeps 44 dp.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, forwardRef, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
}));

vi.mock('expo-haptics', () => ({
    selectionAsync: vi.fn(async () => {}),
    notificationAsync: vi.fn(async () => {}),
    impactAsync: vi.fn(async () => {}),
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

const nav = vi.hoisted(() => ({ pushes: [] as any[] }));
const alerts = vi.hoisted(() => ({ said: [] as string[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', radiogroup: 'radiogroup' };
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, value, onChangeText, disabled, numberOfLines, style } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines !== undefined) attrs['data-lines'] = numberOfLines;
        if (style) {
            const flat = Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
            attrs['data-style'] = JSON.stringify(flat);
        }
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const FlatList = forwardRef(function FlatList(props: Record<string, any>, _ref) {
        const { data = [], renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent } = props;
        return createElement('div', null,
            ListHeaderComponent ?? null,
            data.length
                ? data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
                : (ListEmptyComponent ?? null));
    });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), TouchableWithoutFeedback: el('div'), SafeAreaView: el('div'), KeyboardAvoidingView: el('div'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        FlatList, RefreshControl: () => null,
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert: (title: string, body?: string) => { alerts.said.push(title); if (body) alerts.said.push(body); } },
        Share: { share: async () => ({}) },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, Presets: {}, create: () => ({}) },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});

vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: {
            push: (target: any) => { nav.pushes.push(target); },
            navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true,
        },
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        useLocalSearchParams: () => ({}),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        ErrorBoundary: () => null,
    };
});

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.map.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => store.map.delete(k)); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }) }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: async () => ({}), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
});
vi.mock('expo-crypto', () => ({ randomUUID: () => 'a-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors, themePreference: 'light', setThemePreference() {}, patternEnabled: false, setPatternEnabled() {} }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});

const KEY = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity, setIdentity() {} }) }));
vi.mock('../identity', () => ({ loadIdentity: async () => who.identity }));
vi.mock('../nodes', () => ({ getSavedNodes: async () => [] }));

const activeFeatures = vi.hoisted(() => ({ current: { beans: true, escrow: true, enterprises: true, decisions: true } as any }));
vi.mock('../use-reader-features', () => ({
    useReaderFeatures: () => ({ node: activeFeatures.current, reader: null, effective: activeFeatures.current, known: true }),
}));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', features: activeFeatures.current }) }));

const node = vi.hoisted(() => ({
    treasuries: [] as any[],
    groups: [] as any[],
    getTreasuries: null as any,
}));
vi.mock('../db', () => ({
    getBalance: async () => ({ earnedCredit: 5, commons: 800 }),
    getTreasuries: (...args: unknown[]) => node.getTreasuries(...args),
    getDecisions: async () => ({ decisions: [], myPoolVoting: { voiceCredits: 4, hasCompletedTrade: true }, canPropose: true }),
    getAllCommunityMembers: async () => [{ publicKey: 'd'.repeat(64), callsign: 'Dave' }],
    fetchGroups: async () => node.groups,
    fetchYourGroups: async () => [],
    castDecisionVote: async () => ({ success: true }),
    createDecision: async () => ({ success: true }),
}));

const yourGroupsState = vi.hoisted(() => ({ items: [] as any[], error: null as string | null }));
vi.mock('../../components/useYourGroups', () => ({
    useYourGroups: () => ({ items: yourGroupsState.items, error: yourGroupsState.error, refresh() {} }),
    yourGroupsStore: { refresh() {}, markRead() {} },
}));
vi.mock('../../components/GroupDetailModal', () => ({ GroupDetailModal: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({
    LocalCommunityMark: () => null,
    ExampleHeader: () => null,
    LocalCommunitySheet: () => null,
}));

import { setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import ProjectsScreen from '../../app/(tabs)/projects';

const NODE = 'https://mullum.example';
const EGGS_KEY = 'e'.repeat(64);
const EGGS_SUMMARY = {
    publicKey: EGGS_KEY,
    name: 'Community Eggs',
    callsign: 'Community Eggs',
    purpose: 'Fresh eggs for Mullum',
    balance: 40,
    creditLine: 0,
    liveOffers: 3,
    goalAmount: null,
    currentAmount: null,
    lifecycle: 'ongoing',
    status: 'active',
    paused: false,
    keepers: [],
    deadlineAt: null,
};

const EGGS_CHAT = {
    id: EGGS_KEY,
    conversationId: EGGS_KEY,
    kind: 'enterprise' as const,
    lifecycle: 'ongoing' as const,
    name: 'Community Eggs',
    role: 'lead',
    badge: null,
    avatarUrl: null,
    readOnly: false,
    lastMessage: null,
    unreadCount: 0,
    mute: null,
};

const GARDEN_CHAT = {
    id: 'garden-crew',
    conversationId: 'garden-crew',
    kind: 'group' as const,
    name: 'Garden Crew',
    role: 'convenor',
    category: 'social',
    badge: null,
    avatarUrl: null,
    readOnly: false,
    lastMessage: {
        id: 'msg-1',
        authorPubkey: 'other-pk',
        authorCallsign: 'Alice',
        type: 'text',
        systemType: null,
        text: 'see you there',
        timestamp: new Date().toISOString(),
    },
    unreadCount: 0,
    mute: null,
};

const EVENT_CHAT = {
    id: 'event-dinner',
    conversationId: 'event-dinner',
    kind: 'event' as const,
    name: 'Community Dinner',
    role: 'going',
    badge: null,
    avatarUrl: null,
    readOnly: false,
    lastMessage: null,
    unreadCount: 0,
    mute: null,
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    nav.pushes.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    who.identity = { publicKey: KEY, privateKey: 'me-priv', callsign: 'Me' };
    activeFeatures.current = { beans: true, escrow: true, enterprises: true, decisions: true };
    node.treasuries = [EGGS_SUMMARY];
    node.groups = [];
    node.getTreasuries = vi.fn(async () => node.treasuries);
    yourGroupsState.items = [EGGS_CHAT, GARDEN_CHAT, EVENT_CHAT];
    yourGroupsState.error = null;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderScreen() {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(ProjectsScreen)) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`);

describe('Commons S3 — Yours first, Find named, explainer gone (phone)', () => {
    it('shows kept enterprises/projects lead first with role word, balance line, Manage pill, and group row pushing chat; drops events; explainer gone', async () => {
        await renderScreen();
        // Go to Groups section
        await click(byLabel('Groups Section'), 'Groups');

        // Heading is YOURS
        expect(host.textContent).toContain('YOURS');

        // Kept enterprise: "Community Eggs" is present
        expect(host.textContent).toContain('Community Eggs');
        expect(host.textContent).toContain('Lead keeper');
        expect(host.textContent).toContain('Balance 40 🫘 · 3 live offers');

        // Manage pill pushing /treasury-manage
        const manageBtn = Array.from(host.querySelectorAll('button')).find(b => (b.textContent ?? '').includes('Manage'));
        expect(manageBtn).toBeTruthy();
        await click(manageBtn, 'Manage pill');
        expect(nav.pushes).toContainEqual(expect.objectContaining({
            pathname: '/treasury-manage',
            params: expect.objectContaining({ publicKey: EGGS_KEY }),
        }));

        // Row tap pushes /treasury-detail
        const enterpriseRow = Array.from(host.querySelectorAll('button')).find(b => (b.textContent ?? '').includes('Community Eggs') && (b.textContent ?? '').includes('Lead keeper'));
        expect(enterpriseRow).toBeTruthy();
        await click(enterpriseRow, 'Enterprise row');
        expect(nav.pushes).toContainEqual(expect.objectContaining({
            pathname: '/treasury-detail',
            params: expect.objectContaining({ publicKey: EGGS_KEY }),
        }));

        // Group row "Garden Crew" is present with "Convenor" role word
        expect(host.textContent).toContain('Garden Crew');
        expect(host.textContent).toContain('Convenor');
        const groupRow = Array.from(host.querySelectorAll('button')).find(b => (b.textContent ?? '').includes('Garden Crew') && !(b.textContent ?? '').includes('Manage'));
        expect(groupRow).toBeTruthy();
        await click(groupRow, 'Group row');
        expect(nav.pushes).toContainEqual(expect.objectContaining({
            pathname: expect.stringMatching(/chat/),
        }));

        // Events the member is going to are NOT in Yours (and not drawn on Commons)
        expect(host.textContent).not.toContain('Community Dinner');

        // The explainer card is gone
        expect(host.textContent).not.toContain('A group is a place for some people rather than everyone');
    });

    it('the empty line variants: nothing of yours when Beans + enterprises on, no groups of yours when off', async () => {
        yourGroupsState.items = [];
        await renderScreen();
        await click(byLabel('Groups Section'), 'Groups');

        // Beans and enterprises on:
        expect(host.textContent).toContain('Nothing of yours yet. Start something with +, or find one below.');
        expect(host.textContent).not.toContain('No groups of yours yet');

        // Beans off (or enterprises off):
        activeFeatures.current = { beans: false, escrow: false, enterprises: false, decisions: true };
        await renderScreen();
        expect(host.textContent).toContain('No groups of yours yet. Start one with +, or join one below.');
    });

    it('320 dp × 1.3 measurement: line 2 and name not truncated, Manage pill below line 2 and ≥ 44 dp, spoken label contains status and line 2', async () => {
        node.treasuries = [{
            ...EGGS_SUMMARY,
            status: 'paused',
            paused: true,
        }];
        await renderScreen();
        await click(byLabel('Groups Section'), 'Groups');

        // The enterprise name element allows 2 lines wrapping (data-lines="2")
        const nameEl = Array.from(host.querySelectorAll('span')).find(el => (el.textContent ?? '').trim() === 'Community Eggs');
        expect(nameEl).toBeTruthy();
        expect(nameEl?.getAttribute('data-lines')).toBe('2');

        // Line 2 is not clamped to 1 line (no numberOfLines={1} clamp that cuts it off)
        const line2El = Array.from(host.querySelectorAll('span')).find(el => (el.textContent ?? '').includes('Balance 40 🫘 · 3 live offers'));
        expect(line2El).toBeTruthy();
        expect(line2El?.getAttribute('data-lines')).not.toBe('1');

        // The Manage pill keeps at least 44 dp touch target and is positioned below line 2
        const manageBtn = Array.from(host.querySelectorAll('button')).find(b => (b.textContent ?? '').includes('Manage'));
        expect(manageBtn).toBeTruthy();
        const manageStyle = JSON.parse(manageBtn!.getAttribute('data-style') || '{}');
        expect(manageStyle.minHeight).toBeGreaterThanOrEqual(44);
        expect(manageStyle.minWidth).toBeGreaterThanOrEqual(44);
        expect(manageStyle.alignSelf).toBe('flex-end');
        expect(line2El!.compareDocumentPosition(manageBtn!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        // The enterprise row's accessibilityLabel contains the name, role, status and line 2
        const enterpriseRow = Array.from(host.querySelectorAll('button')).find(b => (b.textContent ?? '').includes('Community Eggs') && !(b.textContent ?? '').includes('Manage'));
        expect(enterpriseRow).toBeTruthy();
        const a11y = enterpriseRow?.getAttribute('aria-label') ?? '';
        expect(a11y).toContain('Community Eggs');
        expect(a11y).toContain('lead keeper');
        expect(a11y).toContain('paused');
        expect(a11y).toContain('Balance 40 🫘 · 3 live offers');

        // Group row spoken name contains "convenor" for a convenor
        const groupRow = Array.from(host.querySelectorAll('button')).find(b => (b.textContent ?? '').includes('Garden Crew'));
        expect(groupRow).toBeTruthy();
        expect(groupRow?.getAttribute('aria-label')).toContain('convenor');
    });

    it('omits balance line until treasury summary is loaded', async () => {
        node.treasuries = [];
        await renderScreen();
        await click(byLabel('Groups Section'), 'Groups');

        expect(host.textContent).toContain('Community Eggs');
        expect(host.textContent).not.toContain('Balance 0 🫘');
    });
});
