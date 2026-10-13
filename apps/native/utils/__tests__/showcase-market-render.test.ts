// @vitest-environment jsdom
/**
 * The Market tab on the worldwide community, the whole screen rendered for real (scratch/global-node/
 * DESIGN-global-showcase-fable.md §1 rows 2 and 5, §4): listings are real, and Beans and deals are Example Valley's
 * preview, so the screen reads the feed and nothing of the reader's own balance (getBalance also asks the node) or
 * deals, and My Deals opens on Example Valley's. The first-draw recipe of showcase-ledger-render.test.ts: the mode is
 * decided as on a phone (the phone's own copy of the node's profile, through useNodeProfile → useReaderFeatures, nothing
 * mocked between); nothing of a previewed feature is asked until it is known, and an answer begun under another mode
 * never draws over the preview.
 *
 * The net spy: fetch, XMLHttpRequest, WebSocket and every export of utils/db (net-spy-db.ts). A local community's
 * Market, the same screen, is drawn first as the control: its calls are seen. Children that only draw what they are
 * given (the composer, pickers, cards) are stand-ins; the screen, its hooks and My Deals are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SAMPLE_COMMUNITY } from '@beanpool/core';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
        ListHeaderComponent,
        (data ?? []).length
            ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
            : ListEmptyComponent,
        ListFooterComponent);
    class Value { constructor(public v = 0) {} setValue() {} interpolate() { return this; } addListener() { return ''; } removeListener() {} }
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList,
        Animated: { FlatList, View: el('div'), Value, event: () => () => {}, timing: () => ({ start() {} }), diffClamp: () => new Value() },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert() {} },
        Linking: { openURL: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {} },
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
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
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {} }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'denied' }), getLastKnownPositionAsync: async () => null,
}));
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const me = vi.hoisted(() => ({ identity: { publicKey: 'a-real-member-key', callsign: 'RealMember' } as Record<string, string> | null }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
// Stand-ins for what only draws what it is given.
const { none } = vi.hoisted(() => ({ none: () => null }));
vi.mock('../../components/RadiusPickerModal', () => ({ RadiusPickerModal: none }));
vi.mock('../../components/TrustPickerSheet', () => ({ TrustPickerSheet: none, TRUST_FILTERS: [] }));
vi.mock('../../components/PostAuthorTrust', () => ({ PostAuthorTrust: none, isElder: () => false }));
vi.mock('../../components/ActivityWaterfall', () => ({ ActivityWaterfall: none }));
vi.mock('../../components/PollCard', () => ({ PollCard: none }));
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: none }));
vi.mock('../../components/EventCard', () => ({ EventCard: none, EVENT_ACCENT: '#0F766E' }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: none }));
vi.mock('../../components/NewPostTypeSheet', () => ({ NewPostTypeSheet: none }));
vi.mock('../../components/OwnerWordsPrompt', () => ({ OwnerWordsPrompt: none }));
vi.mock('../../components/ExampleListings', () => ({ ExampleListings: none }));
vi.mock('../../components/NoAreaLine', () => ({ NoAreaLine: none }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: none }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/CurrencyDisplay', () => ({ CurrencyDisplay: ({ amount }: { amount: string | number }) => createElement('span', null, `${amount} Beans`) }));
vi.mock('../../components/FilterChipRow', () => ({ FilterChipRow: none, FilterChipBar: none }));
vi.mock('../../components/FilterChipPicker', () => ({ FilterChipButton: none, FilterChipPanel: none }));
vi.mock('../../components/QuickReturn', () => ({
    useQuickReturn: () => ({ show() {}, hidden: false, titleHeight: 0, listInset: 0, listProps: {} }),
    QuickReturnBlock: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    ActiveFilterChip: none,
}));
vi.mock('../home-store', () => ({ readPhoneInterests: async () => [], saveInterests: async () => {} }));
vi.mock('../node-post', () => ({
    signedGet: (_url: string, path: string) => { net.calls.push(`signedGet ${path}`); return new Promise(() => {}); },
    signedPost: (_url: string, path: string) => { net.calls.push(`signedPost ${path}`); return new Promise(() => {}); },
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
// The net spy.
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import MarketScreen from '../../app/(tabs)/market';

const NODE = 'https://global.example';
function rememberProfile(profile: 'global' | 'local', features: Record<string, boolean>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}
const WORLDWIDE = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true };
/** The reader's own Beans and deals: a preview of them asks none of it. */
const PREVIEWED = ['db.getBalance', 'db.getMarketplaceTransactions', 'db.getMyPosts'];
const EMPTY: Record<string, unknown> = { getPosts: [], getBalance: { isBlockedFromTrading: false }, getMarketplaceTransactions: [], getMyPosts: [], fetchGroups: [], fetchMyEvents: [] };
const emptyAnswer = (name: string) => (name in EMPTY ? Promise.resolve(EMPTY[name]) : undefined);
/** The member's own deal: one listing, waiting on them. */
const OWN_POST = { id: 'own-post', title: 'Own deal: fix the gate', type: 'need', status: 'pending', author_pubkey: 'a-real-member-key', credits: 12, photos: '[]', created_at: new Date().toISOString() };
const OWN_TX = { id: 'own-tx', postId: 'own-post', postTitle: 'Own deal: fix the gate', status: 'pending', buyerPublicKey: 'a-real-member-key', sellerPublicKey: 'n', sellerCallsign: 'OwnNeighbour', credits: 12, createdAt: new Date().toISOString() };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.answer = emptyAnswer;
    params.now = {};
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    me.identity = { publicKey: 'a-real-member-key', callsign: 'RealMember' };
    globalThis.fetch = vi.fn(async (url: unknown) => { net.calls.push(`fetch ${String(url)}`); return new Response('{}'); }) as typeof fetch;
    (globalThis as any).XMLHttpRequest = class { open() { net.calls.push('xhr'); } send() { net.calls.push('xhr'); } setRequestHeader() {} };
    (globalThis as any).WebSocket = class { constructor() { net.calls.push('ws'); } };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
const render = async (node: unknown) => { await act(async () => { root.render(node as any); }); await settle(); };
const text = () => host.textContent ?? '';
const dealsPill = () => host.querySelector('[aria-label^="My Deals"]');

describe("the control: a local community's Market, the same screen", () => {
    it("reads the member's own balance and deals, so the spy sees this screen's calls", async () => {
        rememberProfile('local', { beans: true, escrow: true, showcase: false });
        await render(createElement(MarketScreen));
        expect(net.calls).toEqual(expect.arrayContaining(['db.getPosts', 'db.getBalance', 'db.getMarketplaceTransactions']));
        expect(dealsPill()).not.toBeNull();
    });
});

describe('the Market on the worldwide community, its profile on the phone', () => {
    it("reads the listings, never the reader's own Beans or deals, before or after the mode is known", async () => {
        rememberProfile('global', WORLDWIDE);
        await render(createElement(MarketScreen));
        expect(net.calls).toContain('db.getPosts');
        for (const call of PREVIEWED) expect(net.calls, call).not.toContain(call);
        expect(dealsPill()?.getAttribute('aria-label')).toBe('My Deals');
    });

    it("a link that opens My Deals at once opens Example Valley's deals, and asks nothing for the member's own", async () => {
        rememberProfile('global', WORLDWIDE);
        params.now = { tab: 'deals' };
        await render(createElement(MarketScreen));
        expect(host.querySelector('[data-testid="deals-preview-head"]')).not.toBeNull();
        expect(text()).toContain(SAMPLE_COMMUNITY.deals.find(d => d.status === 'waiting-on-you')!.what);
        for (const call of PREVIEWED) expect(net.calls, call).not.toContain(call);
    });
});

describe("a phone that has never heard the worldwide community's profile", () => {
    let profileLands: () => void;
    const held: Array<() => void> = [];
    beforeEach(() => {
        held.length = 0;
        // The member's own deal, from the phone's copy: held, to land after the switch to preview.
        net.answer = (name, args) => {
            const own = name === 'getMarketplaceTransactions' ? [OWN_TX]
                : name === 'getMyPosts' ? [OWN_POST]
                    : name === 'getPosts' && (args[0] as { allScopes?: boolean } | undefined)?.allScopes ? [OWN_POST]
                        : undefined;
            return own ? new Promise(resolve => held.push(() => resolve(own))) : emptyAnswer(name);
        };
        globalThis.fetch = vi.fn((url: unknown) => {
            net.calls.push(`fetch ${String(url)}`);
            return new Promise<Response>(resolve => {
                profileLands = () => resolve(new Response(JSON.stringify({ profile: 'global', features: WORLDWIDE }), { status: 200 }));
            });
        }) as typeof fetch;
    });
    const landAll = async () => { for (let i = 0; i < 8 && held.length; i++) { await act(async () => { held.shift()!(); }); await settle(); } };

    it("starts as a local community; the member's own deals that land after the switch never count on the My Deals pill", async () => {
        await render(createElement(MarketScreen));
        expect(net.calls).toEqual(expect.arrayContaining(['db.getMarketplaceTransactions', `fetch ${NODE}/api/community/info`]));
        profileLands();
        await settle();
        await landAll();
        expect(dealsPill()?.getAttribute('aria-label')).toBe('My Deals');
    });

    it("My Deals opened by a link before the switch: the member's own deals landing after it never draw over Example Valley's", async () => {
        params.now = { tab: 'deals' };
        await render(createElement(MarketScreen));
        profileLands();
        await settle();
        expect(host.querySelector('[data-testid="deals-preview-head"]')).not.toBeNull();
        await landAll();
        expect(text()).not.toContain('Own deal: fix the gate');
        expect(text()).toContain(SAMPLE_COMMUNITY.deals.find(d => d.status === 'waiting-on-you')!.what);
    });
});
