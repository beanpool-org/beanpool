// @vitest-environment jsdom
/**
 * "New since you last looked" on the phone, rendered for real (Market order S4, DESIGN-market-order-fable.md §2.9): the real
 * MarketScreen with the device modules stubbed, as market-order-render.test.ts does. One line in the section header's style
 * above the first post listed at or before this phone's stamp (the newest listed time on screen when the Market was last
 * left, under bp_market_seen_listed). None on the first visit, none under a search or a filter, none when nothing is newer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeviceEventEmitter } from 'react-native';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'unknown' }) }));
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
    const bus = new Map<string, Set<(...args: unknown[]) => void>>();
    const DeviceEventEmitter = {
        addListener: (name: string, cb: (...args: unknown[]) => void) => {
            if (!bus.has(name)) bus.set(name, new Set());
            bus.get(name)!.add(cb);
            return { remove() { bus.get(name)?.delete(cb); } };
        },
        emit: (name: string, ...args: unknown[]) => { for (const cb of [...(bus.get(name) ?? [])]) cb(...args); },
    };
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
        DeviceEventEmitter,
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
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {} }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'denied' }), getLastKnownPositionAsync: async () => null,
}));

vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => true, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});

const me = vi.hoisted(() => ({ identity: { publicKey: 'my-own-member-key', callsign: 'MyUser' } as Record<string, string> | null }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));

const { none } = vi.hoisted(() => ({ none: () => null }));
vi.mock('../../components/RadiusPickerModal', () => ({ RadiusPickerModal: none }));
vi.mock('../../components/TrustPickerSheet', () => ({ TrustPickerSheet: none, TRUST_FILTERS: [] }));
vi.mock('../../components/PostAuthorTrust', () => ({
    PostAuthorTrust: ({ callsign }: { callsign: string }) => createElement('span', { 'data-author': callsign }),
    isElder: () => false,
}));
vi.mock('../../components/ActivityWaterfall', () => ({ ActivityWaterfall: none }));
vi.mock('../../components/PollCard', () => ({ PollCard: ({ post }: { post: { id: string; title: string } }) => createElement('div', { 'data-poll': post.id }, post.title) }));
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: none }));
vi.mock('../../components/EventCard', () => ({
    EventCard: ({ post, myLocation }: { post: { id: string; title: string }; myLocation?: { lat: number } | null }) => createElement('div', { 'data-event': post.id, 'data-from': myLocation ? String(myLocation.lat) : '' }, post.title),
    EVENT_ACCENT: '#0F766E',
}));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: none }));
vi.mock('../../components/NewPostTypeSheet', () => ({ NewPostTypeSheet: none }));
vi.mock('../../components/OwnerWordsPrompt', () => ({ OwnerWordsPrompt: none }));
vi.mock('../../components/ExampleListings', () => ({ ExampleListings: none }));
vi.mock('../../components/MarketCircleLine', () => ({ MarketCircleLine: none, useFindCardRead: () => null }));
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
    signedGet: () => new Promise(() => {}),
    signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));

const net = vi.hoisted(() => ({ answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn([], (name, args) => net.answer?.(name, args)));

import MarketScreen from '../../app/(tabs)/market';
import { nearbyAreaKeyOf } from '../nearby-area';

const NODE = 'https://local.example';
const EMPTY: Record<string, unknown> = { getPosts: [], getBalance: { isBlockedFromTrading: false }, getMarketplaceTransactions: [], getNearbyKeptPostIds: new Set<string>(), getMyPosts: [], fetchGroups: [], fetchMyEvents: [] };
const listing = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, title, type: 'offer', status: 'active', category: 'services', author_pubkey: 'other-member-key', author_callsign: 'Other', author_energy_cycled: 0,
    credits: 0, photos: '[]', lat: -28.6, lng: 153.4, created_at: new Date().toISOString(), ...extra,
});

const holds = (posts: unknown[]) => { net.answer = (name) => (name === 'getPosts' ? Promise.resolve([...posts]) : name in EMPTY ? Promise.resolve(EMPTY[name]) : undefined); };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    params.now = {};
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true }, checkedAt: new Date().toISOString() } }));
    me.identity = { publicKey: 'my-own-member-key', callsign: 'MyUser' };
    holds([]);
    // The Market's fill reads the node; answer it here so no real request outlives the test (merge queue run 41642015479).
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => {}); };
const render = async () => { await act(async () => { root.render(createElement(MarketScreen) as any); }); await settle(); };


const HOUR = 60 * 60 * 1000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
const ahead = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };

const KEY = 'bp_market_seen_listed';
const LINE = 'NEW SINCE YOU LAST LOOKED';
/** Leave the Market (the screen goes out of view and the stamp is written), then come back to a fresh copy of it. */
const leaveAndReturn = async () => {
    act(() => root.unmount());
    root = createRoot(host);
    await render();
};

describe('the Market on the phone: New since you last looked', () => {
    const board = () => [
        listing('a1', 'Ana one', { author_pubkey: 'ana', created_at: ago(1) }),
        listing('b1', 'Bo bread', { author_pubkey: 'bo', created_at: ago(3) }),
        listing('y1', 'Yesterday goats', { author_pubkey: 'mo', created_at: ago(30) }),
        listing('old', 'Old ladder', { author_pubkey: 'jo', created_at: ago(24 * 12) }),
    ];
    const withFixedClock = async (run: () => Promise<void>) => {
        // The middle of a day, so Today and Yesterday do not shift under the test.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 10, 3, 17, 0, 0));
        try { await run(); } finally { vi.useRealTimers(); }
    };
    const at = (s: string) => (host.textContent ?? '').indexOf(s);

    it('is not shown on the first visit, and leaving stores the newest listed time that was on screen', async () => {
        await withFixedClock(async () => {
            holds(board());
            await render();
            expect(host.querySelector('[data-testid="new-since-line"]')).toBeNull();
            expect(store.map.get(KEY)).toBeUndefined();
            act(() => root.unmount());
            expect(store.map.get(KEY)).toBe(String(Date.parse(ago(1))));
        });
    });

    it('after leaving, a new post is above the line and what was already seen is below it', async () => {
        await withFixedClock(async () => {
            holds(board());
            await render();
            holds([listing('n1', 'Newcomer jam', { author_pubkey: 'nia', created_at: ago(0.5) }), ...board()]);
            await leaveAndReturn();
            const lines = host.querySelectorAll('[data-testid="new-since-line"]');
            expect(lines).toHaveLength(1);
            expect(lines[0].textContent).toBe(LINE);
            expect(at('Newcomer jam')).toBeGreaterThan(-1);
            expect(at('Newcomer jam')).toBeLessThan(at(LINE));
            expect(at(LINE)).toBeLessThan(at('Ana one'));
            expect(at('Ana one')).toBeLessThan(at('Bo bread'));
        });
    });

    it('is above the day heading when the first post already seen starts a day', async () => {
        await withFixedClock(async () => {
            holds([listing('y1', 'Yesterday goats', { author_pubkey: 'mo', created_at: ago(30) }), listing('old', 'Old ladder', { author_pubkey: 'jo', created_at: ago(24 * 12) })]);
            await render();
            holds([listing('n1', 'Newcomer jam', { author_pubkey: 'nia', created_at: ago(2) }), listing('y1', 'Yesterday goats', { author_pubkey: 'mo', created_at: ago(30) }), listing('old', 'Old ladder', { author_pubkey: 'jo', created_at: ago(24 * 12) })]);
            await leaveAndReturn();
            expect(at('Newcomer jam')).toBeLessThan(at(LINE));
            expect(at(LINE)).toBeLessThan(at('YESTERDAY'));
            expect(at('YESTERDAY')).toBeLessThan(at('Yesterday goats'));
        });
    });

    it('is not shown when nothing is newer than the stamp', async () => {
        await withFixedClock(async () => {
            holds(board());
            await render();
            await leaveAndReturn();
            expect(host.querySelector('[data-testid="new-since-line"]')).toBeNull();
        });
    });

    it('is not shown when every post on screen is newer than a stamp from long ago', async () => {
        await withFixedClock(async () => {
            store.map.set(KEY, String(Date.parse(ago(24 * 400))));
            holds(board());
            await render();
            expect(host.querySelector('[data-testid="new-since-line"]')).toBeNull();
        });
    });

    it('is not shown under a search, nor under a filter, whatever the stamp', async () => {
        await withFixedClock(async () => {
            store.map.set(KEY, String(Date.parse(ago(2))));
            holds([listing('n1', 'Newcomer ladder jam', { author_pubkey: 'nia', created_at: ago(0.5) }), ...board()]);
            // The stamp is real: with no search or filter the line shows.
            await render();
            expect(host.querySelectorAll('[data-testid="new-since-line"]')).toHaveLength(1);
            act(() => root.unmount());

            root = createRoot(host);
            params.now = { q: 'ladder' };
            await render();
            expect(host.textContent).toContain('Newcomer ladder jam');
            expect(host.querySelector('[data-testid="new-since-line"]')).toBeNull();
            act(() => root.unmount());

            root = createRoot(host);
            params.now = { filter: 'events' };
            await render();
            expect(host.querySelector('[data-testid="new-since-line"]')).toBeNull();
        });
    });

    it('a search or a filter does not move the stamp: only the whole Market can set it', async () => {
        await withFixedClock(async () => {
            store.map.set(KEY, String(Date.parse(ago(5))));
            holds(board());
            params.now = { q: 'ladder' };
            await render();
            act(() => root.unmount());
            expect(store.map.get(KEY)).toBe(String(Date.parse(ago(5))));
        });
    });

    it('is not drawn in the grid, which has no headings', async () => {
        await withFixedClock(async () => {
            store.map.set(KEY, String(Date.parse(ago(2))));
            holds([listing('n1', 'Newcomer jam', { author_pubkey: 'nia', created_at: ago(0.5) }), ...board()]);
            await render();
            expect(host.querySelectorAll('[data-testid="new-since-line"]')).toHaveLength(1);
            await click(host.querySelector('[aria-label="Grid view"]'));
            expect(host.querySelector('[data-testid="new-since-line"]')).toBeNull();
        });
    });

    it('reads a damaged stamp as none', async () => {
        await withFixedClock(async () => {
            store.map.set(KEY, 'not a number');
            holds(board());
            await render();
            expect(host.querySelector('[data-testid="new-since-line"]')).toBeNull();
        });
    });
});
