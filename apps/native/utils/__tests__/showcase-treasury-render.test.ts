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

const nav = vi.hoisted(() => ({ pushes: [] as string[] }));
const searchParams = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push(x: unknown) { nav.pushes.push(JSON.stringify(x)); }, navigate(x: unknown) { nav.pushes.push(`nav ${JSON.stringify(x)}`); }, setParams() {}, back() { nav.pushes.push('back'); } },
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
    nav.pushes.length = 0;
    me.identity = { publicKey: 'a-real-member-key', callsign: 'RealMember' };
    globalThis.fetch = vi.fn(async (url: unknown) => { net.calls.push(`fetch ${String(url)}`); return new Response('{}'); }) as typeof fetch;
});

afterEach(() => { act(() => root.unmount()); host.remove(); });

const BAKERY = SAMPLE_COMMUNITY.enterprises[0];
const PROJECT = SAMPLE_COMMUNITY.projects[0];
const markers = () => Array.from(host.querySelectorAll('[data-testid="local-community-action"]')) as HTMLElement[];
const label = (el: Element) => (el.textContent ?? '').replace(/🏘️.*$/u, '').trim();
const press = async (el: HTMLElement) => { await act(async () => { el.click(); }); await settle(); };

describe('treasury-detail on global node (preview mode)', () => {
    it("Example Valley's enterprise: the real page fed the sample, marked, and not one call", async () => {
        rememberProfile('global', WORLDWIDE);
        searchParams.current = { publicKey: BAKERY.id, name: BAKERY.name };
        await render(createElement(TreasuryDetailScreen));

        expect(text()).toContain(BAKERY.name);
        expect(host.querySelector('[data-testid="local-community-strip"]')).not.toBeNull();
        expect(text()).toContain('Example Valley · an example member');
        expect(text()).toContain('a neighbour');
        expect(text()).toContain(BAKERY.listings[0].title);
        expect(text()).toContain(String(BAKERY.balance));
        expect(host.querySelector('[data-testid="enterprise-decisions"]')).toBeNull();
        expect(text()).not.toContain('Report Enterprise');
        expect(host.querySelector('input')).toBeNull();
        expect(net.calls).toEqual([]);
        expect(nav.pushes).toEqual([]);
    });

    it('every control is a marker that opens the sheet; none calls the node or leaves the page', async () => {
        rememberProfile('global', WORLDWIDE);
        searchParams.current = { publicKey: BAKERY.id };
        await render(createElement(TreasuryDetailScreen));

        expect(markers().map(label)).toEqual(['Join as keeper', 'Post Offer', 'Post Need', 'To Commons', 'Pause for season', 'Start wind-up']);
        for (const i of markers().keys()) {
            await press(markers()[i]);
            expect(host.querySelector('[data-testid="local-community-sheet"]')).not.toBeNull();
            expect(text()).toContain('Why this lives in a local community');
            await press(host.querySelector('[data-modal] [aria-label="Close"]') as HTMLElement);
            expect(host.querySelector('[data-testid="local-community-sheet"]')).toBeNull();
        }
        // A listing tap goes nowhere.
        const listing = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(BAKERY.listings[0].title)) as HTMLElement;
        await press(listing);
        expect(net.calls).toEqual([]);
        expect(nav.pushes).toEqual([]);
    });

    it('a keeper chip is not a button: no profile, no call (review of #2063, B3)', async () => {
        rememberProfile('global', WORLDWIDE);
        searchParams.current = { publicKey: BAKERY.id };
        await render(createElement(TreasuryDetailScreen));
        const buttons = Array.from(host.querySelectorAll('button, [role="button"]'));
        expect(buttons.filter(b => b.textContent?.includes('a neighbour') && !b.textContent?.includes(BAKERY.listings[0].title))).toEqual([]);
        expect(net.calls).toEqual([]);
    });

    it("Example Valley's project: the Pledge is the marker, never the box", async () => {
        rememberProfile('global', WORLDWIDE);
        searchParams.current = { publicKey: PROJECT.id };
        await render(createElement(TreasuryDetailScreen));

        expect(text()).toContain(PROJECT.title);
        expect(host.querySelector('[data-testid="pledge-preview"]')).not.toBeNull();
        expect(host.querySelector('[aria-label="Pledge amount"]')).toBeNull();
        expect(text()).not.toContain('PLEDGE BEANS');
        // The join card says the project's word (review N4).
        expect(markers().map(label)).toContain('Join as collaborator');
        expect(markers().map(label)).not.toContain('Join as keeper');
        const pledge = markers().find(m => label(m) === 'Pledge')!;
        await press(pledge);
        expect(host.querySelector('[data-testid="local-community-sheet"]')).not.toBeNull();
        expect(net.calls).toEqual([]);
        expect(nav.pushes).toEqual([]);
    });

    it('a deep link to a real enterprise says why (a line that opens the sheet) and calls nothing', async () => {
        rememberProfile('global', WORLDWIDE);
        searchParams.current = { publicKey: 'b'.repeat(64) };
        await render(createElement(TreasuryDetailScreen));

        const line = host.querySelector('[data-testid="enterprise-elsewhere"]')!;
        expect(line.textContent).toContain('Enterprises live in a local community');
        expect(text()).not.toContain("Couldn't load this group. Check your connection.");
        expect(text()).not.toContain(BAKERY.name);
        await press(line.querySelector('button') as HTMLElement);
        expect(host.querySelector('[data-testid="local-community-sheet"]')).not.toBeNull();
        expect(net.calls).toEqual([]);
    });
});

describe("the control: a local community's treasury detail reads as before", () => {
    const LOCAL = { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false };
    const DETAIL = {
        publicKey: 'local-ent-1', name: 'Garden Bakery', purpose: 'Bread from the garden oven', balance: 50, creditLine: 100, liveOffers: 1,
        lifecycle: 'ongoing', status: 'active', paused: false, keepers: [{ publicKey: 'a-real-member-key', callsign: 'RealMember', role: 'lead' }], posts: [],
    };
    const answers: Record<string, unknown> = {
        getTreasuryDetail: DETAIL,
        getBalance: { balance: 10, keeperOf: ['local-ent-1'] },
        getEnterpriseLedger: { enterprise: { publicKey: 'local-ent-1' }, period: { since: null, until: null }, summary: { totalIncome: 30, totalSpend: 10, netChange: 20, startingBalance: 30, endingBalance: 50, transactionCount: 2 }, entries: [] },
        getEnterpriseThread: { conversation: null, messages: [], readOnly: false },
    };
    // What the screen asked before the preview came (measured at 25e3390a, review of #2063).
    const BASE_KEEPER = ['db.getTreasuryDetail', 'db.getEnterpriseThread', 'db.getEnterpriseLedger', 'db.getBalance'];
    const BASE_UNANSWERED = ['db.getTreasuryDetail', 'db.getEnterpriseThread', 'db.getEnterpriseLedger'];

    it('a keeper on their own enterprise: the same calls, the keeper controls, no strip and no marker', async () => {
        rememberProfile('local', LOCAL);
        net.answer = (name) => (name in answers ? Promise.resolve(answers[name]) : undefined);
        searchParams.current = { publicKey: 'local-ent-1', name: 'Garden Bakery' };
        await render(createElement(TreasuryDetailScreen));
        expect([...net.calls].sort()).toEqual([...BASE_KEEPER].sort());
        expect(text()).toContain('OPERATOR CONTROLS');
        expect(host.querySelector('[data-testid="local-community-strip"]')).toBeNull();
        expect(markers()).toEqual([]);
    });

    it('a link with ?preview=true is a real link: read as before (N6)', async () => {
        rememberProfile('local', LOCAL);
        net.answer = (name) => (name in answers ? Promise.resolve(answers[name]) : undefined);
        searchParams.current = { publicKey: 'local-ent-1', preview: 'true' };
        await render(createElement(TreasuryDetailScreen));
        expect([...net.calls].sort()).toEqual([...BASE_KEEPER].sort());
        expect(text()).toContain('Garden Bakery');
        expect(text()).not.toContain(BAKERY.name);
    });

    it('enterprises switched off by the operator, a stale link: base\'s calls and base\'s words (B5)', async () => {
        rememberProfile('local', { ...LOCAL, enterprises: false, showcase: false });
        net.answer = (name) => (name === 'getTreasuryDetail' || name === 'getEnterpriseLedger' || name === 'getEnterpriseThread' ? Promise.reject(new Error('feature_off')) : undefined);
        searchParams.current = { publicKey: 'local-ent-1' };
        await render(createElement(TreasuryDetailScreen));
        expect([...net.calls].sort()).toEqual([...BASE_UNANSWERED].sort());
        expect(text()).toContain("Couldn't load this group. Check your connection.");
        expect(text()).not.toContain('Enterprises live in a local community');
        expect(host.querySelector('[data-testid="enterprise-elsewhere"]')).toBeNull();
    });

    it('a reader who may only read enterprises (node on, reader off): read as before', async () => {
        rememberProfile('local', LOCAL);
        // Not asked here: the reader's own set is only asked where it can matter; the node's set alone says live.
        net.answer = (name) => (name in answers ? Promise.resolve(answers[name]) : undefined);
        searchParams.current = { publicKey: 'local-ent-1' };
        await render(createElement(TreasuryDetailScreen));
        expect(net.calls).toContain('db.getTreasuryDetail');
        expect(net.calls).toContain('db.getEnterpriseLedger');
    });

    it('the node answers nothing (offline): the same calls, still waiting', async () => {
        rememberProfile('local', LOCAL);
        searchParams.current = { publicKey: 'local-ent-1' };
        await render(createElement(TreasuryDetailScreen));
        expect([...net.calls].sort()).toEqual([...BASE_UNANSWERED].sort());
        expect(text()).not.toContain('Enterprises live in a local community');
    });
});
