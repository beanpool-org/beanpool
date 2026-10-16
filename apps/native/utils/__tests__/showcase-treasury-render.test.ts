// @vitest-environment jsdom
/**
 * treasury-detail.tsx in preview mode (Showcase):
 * On the worldwide/global node (enterprises off, showcase on), rendering an enterprise or project
 * displays the REAL treasury detail screen fed from sample community data (Example Valley Bakery
 * and Compost Bay).
 * Every control (Join as keeper, Pledge, Pause for season, Start wind-up, Post Offer/Need, To Commons)
 * is a marker action opening the LocalCommunitySheet.
 * Reads nothing of the member's own data and calls no node APIs.
 * Deep linking to a non-sample enterprise explains why ("Enterprises live in a local community.")
 * instead of "Couldn't load this group. Check your connection."
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SAMPLE_COMMUNITY } from '@beanpool/core';

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

vi.mock('expo-crypto', () => ({
    randomUUID: () => 'test-uuid',
    getRandomBytes: (n: number) => new Uint8Array(n),
}));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert() {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});

const searchParams = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {} },
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => searchParams.current,
        ErrorBoundary: () => null,
    };
});

vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: any) => createElement('div', null, children),
}));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: any) => createElement('div', null, children),
    KeyboardController: { dismiss() {} },
}));

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));

vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});

const me = vi.hoisted(() => ({ identity: { publicKey: 'a-real-member-key', callsign: 'RealMember' } as Record<string, string> | null }));
vi.mock('../identity', () => ({ loadIdentity: async () => me.identity }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
vi.mock('../../components/EnterpriseDecisions', () => ({
    EnterpriseDecisions: () => createElement('div', { 'data-testid': 'enterprise-decisions' }),
}));
vi.mock('../../components/ReportReasonBox', () => ({
    ReportReasonBox: () => createElement('div', { 'data-testid': 'report-reason-box' }),
}));
vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: ({ callsign }: any) => createElement('span', { 'data-avatar': callsign }),
}));

// The net spy.
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, name => net.answer?.(name)));
vi.mock('../node-post', () => ({
    signedGet: (_url: string, path: string) => { net.calls.push(`signedGet ${path}`); return new Promise(() => {}); },
    signedPost: (_url: string, path: string) => { net.calls.push(`signedPost ${path}`); return new Promise(() => {}); },
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));

import TreasuryDetailScreen from '../../app/treasury-detail';

const NODE = 'https://global.example';
function rememberProfile(profile: 'global' | 'local', features: Record<string, boolean>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}
const WORLDWIDE = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true };

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
const render = async (node: unknown) => { await act(async () => { root.render(node as any); }); await settle(); };
const text = () => host.textContent ?? '';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.answer = null;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    searchParams.current = {};
    me.identity = { publicKey: 'a-real-member-key', callsign: 'RealMember' };
    globalThis.fetch = vi.fn(async (url: unknown) => { net.calls.push(`fetch ${String(url)}`); return new Response('{}'); }) as typeof fetch;
});

afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('treasury-detail on global node (preview mode)', () => {
    it('renders real enterprise detail from sample without calling network', async () => {
        rememberProfile('global', WORLDWIDE);
        searchParams.current = { publicKey: 'sample-enterprise-valley-bakery' };

        await render(createElement(TreasuryDetailScreen));

        // Bakery name from sample
        expect(text()).toContain('Example Valley Bakery');

        // Did NOT call any real DB APIs
        expect(net.calls).not.toContain('db.getTreasuryDetail');
        expect(net.calls).not.toContain('db.getBalance');
        expect(net.calls).not.toContain('db.getEnterpriseLedger');
        expect(net.calls).not.toContain('db.getEnterpriseThread');

        // Shows Local Community strip and Example header
        expect(host.querySelector('[data-testid="local-community-strip"]')).not.toBeNull();
        expect(text()).toContain('Example Valley · an example member');

        // Keepers from sample
        expect(text()).toContain('a neighbour');

        // Live listings from sample
        expect(text()).toContain('Sourdough loaves, baked twice a week');

        // Balance from sample
        expect(text()).toContain('160');

        // EnterpriseDecisions is NOT drawn
        expect(host.querySelector('[data-testid="enterprise-decisions"]')).toBeNull();

        // Report Enterprise is NOT drawn
        expect(text()).not.toContain('Report Enterprise');
    });

    it('renders every control as a marker action opening the local community sheet', async () => {
        rememberProfile('global', WORLDWIDE);
        searchParams.current = { publicKey: 'sample-enterprise-valley-bakery' };

        await render(createElement(TreasuryDetailScreen));

        // Find all marker actions on screen
        const markerActions = host.querySelectorAll('[data-testid="local-community-action"]');
        const labels = Array.from(markerActions).map(el => el.textContent);

        // Verify the 6 enterprise controls are marker actions
        expect(labels.some(l => l?.includes('Join as keeper'))).toBe(true);
        expect(labels.some(l => l?.includes('Post Offer'))).toBe(true);
        expect(labels.some(l => l?.includes('Post Need'))).toBe(true);
        expect(labels.some(l => l?.includes('To Commons'))).toBe(true);
        expect(labels.some(l => l?.includes('Pause for season'))).toBe(true);
        expect(labels.some(l => l?.includes('Start wind-up'))).toBe(true);

        // Clicking a marker action opens the Local Community sheet
        const joinBtn = Array.from(markerActions).find(el => el.textContent?.includes('Join as keeper')) as HTMLElement;
        expect(joinBtn).toBeDefined();

        await act(async () => { joinBtn.click(); });
        await settle();

        expect(host.querySelector('[data-testid="local-community-sheet"]')).not.toBeNull();
        expect(text()).toContain('Why this lives in a local community');
    });

    it('renders sample crowdfund project with Pledge marker action', async () => {
        rememberProfile('global', WORLDWIDE);
        searchParams.current = { publicKey: 'sample-project-compost-bay' };

        await render(createElement(TreasuryDetailScreen));

        expect(text()).toContain('A compost bay by the community garden');

        // Did NOT call real APIs
        expect(net.calls).not.toContain('db.getTreasuryDetail');
        expect(net.calls).not.toContain('db.getEnterpriseLedger');

        // Pledge marker action exists
        const markerActions = host.querySelectorAll('[data-testid="local-community-action"]');
        const pledgeBtn = Array.from(markerActions).find(el => el.textContent?.includes('Pledge')) as HTMLElement;
        expect(pledgeBtn).toBeDefined();

        await act(async () => { pledgeBtn.click(); });
        await settle();

        expect(host.querySelector('[data-testid="local-community-sheet"]')).not.toBeNull();
    });

    it('displays feature check explanation on global deep link to non-sample enterprise', async () => {
        rememberProfile('global', WORLDWIDE);
        searchParams.current = { publicKey: 'real-enterprise-from-deep-link' };

        await render(createElement(TreasuryDetailScreen));

        // Explains why instead of "Couldn't load this group. Check your connection."
        expect(text()).toContain('Enterprises live in a local community.');
        expect(text()).not.toContain("Couldn't load this group. Check your connection.");

        // Calls NO real APIs
        expect(net.calls).not.toContain('db.getTreasuryDetail');
        expect(net.calls).not.toContain('db.getBalance');
    });
});

describe("the control: a local community's treasury detail", () => {
    it('calls real APIs when on a local community', async () => {
        rememberProfile('local', { beans: true, enterprises: true, decisions: true, showcase: false });
        searchParams.current = { publicKey: 'local-community-enterprise-1' };

        await render(createElement(TreasuryDetailScreen));

        expect(net.calls).toContain('db.getTreasuryDetail');
    });
});
