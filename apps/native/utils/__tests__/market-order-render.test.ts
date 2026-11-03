// @vitest-environment jsdom
/**
 * The Market's order on the phone, rendered for real (Market order S1, DESIGN-market-order-fable.md): the real MarketScreen
 * with the device modules stubbed, as market-fresh-banner-render.test.ts does. Newest listed first under Today / Yesterday /
 * This Week / Older Listings; an event comes back under Today the day before it starts; a named author's third post of a day
 * goes after the others'; the Pinned block stays on top; the headings Upcoming events, Polls and Nearest first are gone; the
 * grid is the same order with no headings; on the worldwide community one line and each card's distance, inside the circle.
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
const EMPTY: Record<string, unknown> = { getPosts: [], getBalance: { isBlockedFromTrading: false }, getMarketplaceTransactions: [], getMyPosts: [], fetchGroups: [], fetchMyEvents: [] };
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

describe('the Market on the phone: one order', () => {
    const localPosts = () => [
        listing('pin', 'Pinned bike pump', { pinned_until: ahead(48), pinned_at: ago(1), created_at: ago(300), author_pubkey: 'a-0' }),
        listing('a1', 'Ana one', { author_pubkey: 'ana', created_at: ago(1) }),
        listing('a2', 'Ana two', { author_pubkey: 'ana', created_at: ago(2) }),
        listing('a3', 'Ana three', { author_pubkey: 'ana', created_at: ago(3) }),
        listing('lee', 'Lee scoby', { author_pubkey: 'lee', created_at: ago(4) }),
        listing('ev', 'Repair Café', { type: 'event', author_pubkey: 'civic', created_at: ago(24 * 35), event_start_at: ahead(10), event_end_at: ahead(12), event_state: 'scheduled' }),
        listing('far-ev', 'Garden day', { type: 'event', author_pubkey: 'civic', created_at: ago(24 * 20), event_start_at: ahead(24 * 5), event_end_at: ahead(24 * 5 + 2), event_state: 'scheduled' }),
        listing('y1', 'Yesterday goats', { author_pubkey: 'mo', created_at: ago(30) }),
        listing('old', 'Old ladder', { author_pubkey: 'jo', created_at: ago(24 * 12) }),
    ];

    it("local list: Pinned on top, Today in listed order (an event that came back among it, Ana's third last), then Yesterday", async () => {
        // Run early in the local day this would shift across midnight, so pin the clock to the middle of a day.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 10, 3, 17, 0, 0));
        try {
            holds(localPosts());
            await render();
            const text = host.textContent ?? '';
            for (const gone of ['UPCOMING EVENTS', 'NEAREST FIRST']) expect(text).not.toContain(gone);
            const at = (s: string) => text.indexOf(s);
            // Pinned block first, then the day headings.
            expect(at('Pinned bike pump')).toBeGreaterThan(-1);
            expect(at('Pinned bike pump')).toBeLessThan(at('TODAY'));
            // Today, newest listed first: Ana 1 h, Ana 2 h, Lee 4 h, the event 14 h (it starts in 10 h, less 24); Ana's third (3 h) after everyone else's.
            const today = ['Ana one', 'Ana two', 'Lee scoby', 'Repair Café', 'Ana three'];
            const pos = today.map(at);
            expect(pos.every(p => p > at('TODAY'))).toBe(true);
            expect([...pos].sort((a, b) => a - b)).toEqual(pos);
            expect(at('Ana three')).toBeLessThan(at('YESTERDAY'));
            expect(at('YESTERDAY')).toBeLessThan(at('Yesterday goats'));
            // An event five days off has not come back: it is in the day it was posted, 20 days back.
            expect(at('Garden day')).toBeGreaterThan(at('OLDER LISTINGS'));
            expect(at('Old ladder')).toBeGreaterThan(at('OLDER LISTINGS'));
            // The pinned post is in the block once, not again in the stream.
            expect(text.split('Pinned bike pump').length - 1).toBe(1);
            // A local community has no "Newest within" line and no distances.
            expect(host.querySelector('[data-testid="market-newest-within"]')).toBeNull();
            expect(host.querySelector('[data-testid="card-distance"]')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('the grid is the same order with no headings', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 10, 3, 17, 0, 0));
        try {
            holds(localPosts());
            await render();
            await click(host.querySelector('[aria-label="Grid view"]'));
            const text = host.textContent ?? '';
            for (const heading of ['TODAY', 'YESTERDAY', 'THIS WEEK', 'OLDER LISTINGS']) expect(text).not.toContain(heading);
            const order = ['Ana one', 'Ana two', 'Lee scoby', 'Repair Café', 'Ana three', 'Yesterday goats'].map(s => text.indexOf(s));
            expect(order.every(p => p > -1)).toBe(true);
            expect([...order].sort((a, b) => a - b)).toEqual(order);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a poll is among the days, and no Polls heading is drawn', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 10, 3, 17, 0, 0));
        try {
            holds([...localPosts(), listing('poll', 'Where is the picnic', { type: 'poll', status: 'active', poll_closes_at: ahead(6), created_at: ago(24 * 6), poll_options: '[]' })]);
            await render();
            const text = host.textContent ?? '';
            expect(text).toContain('Where is the picnic');
            expect(text).not.toContain('POLLS');
            // Closing in 6 h, it is listed 18 h ago: yesterday, in the middle of the afternoon's day before.
            expect(text.indexOf('Where is the picnic')).toBeGreaterThan(text.indexOf('YESTERDAY'));
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the Market on the worldwide community: the same order inside a circle', () => {
    const AREA = { lat: -28.65, lng: 153.55 }; // Byron Bay
    const GLOBAL_NODE = 'https://global.example';
    beforeEach(() => {
        store.map.set('beanpool_anchor_url', GLOBAL_NODE);
        store.map.set('beanpool_node_profiles', JSON.stringify({ [GLOBAL_NODE]: { profile: 'global', features: { beans: false, distanceSearch: true, nearbyListings: { radiusKm: 250, max: 500 } }, checkedAt: new Date().toISOString() } }));
        store.map.set(nearbyAreaKeyOf(GLOBAL_NODE), JSON.stringify({ key: 'my-own-member-key', area: AREA, checkedAt: Date.now(), whole: false }));
    });

    const posts = () => [
        listing('near', 'Surplus pumpkins', { created_at: ago(2), lat: -28.6, lng: 153.5, author_pubkey: 'p1' }),
        listing('mid', 'Sourdough starter', { created_at: ago(3), lat: -27.47, lng: 153.03, author_pubkey: 'p2' }),
        listing('far', 'Melbourne bike', { created_at: ago(1), lat: -37.81, lng: 144.96, author_pubkey: 'p3' }),
    ];

    it('says the line once, drops what is beyond 250 km, orders the rest newest first and gives each card its distance', async () => {
        holds(posts());
        await render();
        const line = host.querySelector('[data-testid="market-newest-within"]');
        expect(line?.textContent).toBe('Newest within 250 km of your area.');
        expect(host.querySelectorAll('[data-testid="market-newest-within"]')).toHaveLength(1);
        const text = host.textContent ?? '';
        expect(text).not.toContain('Melbourne bike');
        expect(text.indexOf('Surplus pumpkins')).toBeLessThan(text.indexOf('Sourdough starter'));
        const distances = Array.from(host.querySelectorAll('[data-testid="card-distance"]')).map(d => d.textContent);
        expect(distances).toHaveLength(2);
        expect(distances[0]).toMatch(/^📍 \d+(\.\d)? km$/);
        for (const gone of ['NEAREST FIRST', 'UPCOMING EVENTS']) expect(text).not.toContain(gone);
    });

    it('a pinned listing is above the line and has its distance too', async () => {
        holds([listing('pin', 'Pinned seed swap', { pinned_until: ahead(48), pinned_at: ago(1), created_at: ago(200), lat: -28.6, lng: 153.5 }), ...posts()]);
        await render();
        const text = host.textContent ?? '';
        expect(text.indexOf('Pinned seed swap')).toBeLessThan(text.indexOf('Newest within 250 km of your area.'));
        expect(host.querySelectorAll('[data-testid="card-distance"]')).toHaveLength(3);
    });

    it('with no area set there is no line and no cut', async () => {
        store.map.set(nearbyAreaKeyOf(GLOBAL_NODE), JSON.stringify({ key: 'my-own-member-key', area: null, checkedAt: Date.now(), whole: false }));
        holds(posts());
        await render();
        expect(host.querySelector('[data-testid="market-newest-within"]')).toBeNull();
        expect(host.textContent).toContain('Melbourne bike');
    });

    it('an event shows its distance from the area, not from a GPS fix', async () => {
        holds([...posts(), listing('gev', 'Garden day', { type: 'event', created_at: ago(5), lat: -28.6, lng: 153.5, event_start_at: ahead(100), event_end_at: ahead(102), event_state: 'scheduled' })]);
        await render();
        expect(host.querySelector('[data-event="gev"]')?.getAttribute('data-from')).toBe(String(AREA.lat));
    });
});
