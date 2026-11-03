// @vitest-environment jsdom
/**
 * Render test for the Market fresh-listings banner (feat/fresh-banner):
 * The banner renders when fresh listings exist today, dismissing it hides it
 * and persists the day and count to AsyncStorage via @beanpool/core's freshBanner helper.
 * Own listings are excluded from the fresh count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: any) => children, KeyboardAvoidingView: ({ children }: any) => children, KeyboardStickyView: ({ children }: any) => children })); // the real one needs the keyboard library's native side
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeviceEventEmitter } from 'react-native';
import { freshBannerDay, parseFreshBannerDismissal } from '@beanpool/core';

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
vi.mock('../../components/PollCard', () => ({ PollCard: none }));
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: none }));
vi.mock('../../components/EventCard', () => ({ EventCard: none, EVENT_ACCENT: '#0F766E' }));
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

describe('MarketScreen fresh banner dismissal', () => {
    it('dismissing the fresh banner hides it and writes local day and count to AsyncStorage', async () => {
        holds([
            listing('post-1', 'Bicycle repair', { author_pubkey: 'neighbour-1' }),
            listing('post-2', 'Sourdough loaf', { author_pubkey: 'neighbour-2' }),
        ]);

        await render();

        // The banner renders with count 2 and dismissal prompt
        expect(host.textContent).toContain('2 fresh listings posted today!');
        expect(host.textContent).toContain('Tap to dismiss • Scroll down to explore');

        // Find the fresh banner button (it has aria-label matching the banner title)
        const bannerBtn = Array.from(host.querySelectorAll('button')).find(
            b => b.textContent?.includes('Tap to dismiss • Scroll down to explore')
        );
        expect(bannerBtn).toBeTruthy();

        // Click / tap the banner to dismiss
        await act(async () => {
            bannerBtn!.click();
        });
        await settle();

        // Banner is now hidden
        expect(host.textContent).not.toContain('Tap to dismiss • Scroll down to explore');
        expect(host.textContent).not.toContain('fresh listings posted today!');

        // AsyncStorage was updated with today's day and count 2
        const stored = store.map.get('bp_dismissed_fresh_count');
        expect(stored).toBeTruthy();
        const parsed = parseFreshBannerDismissal(stored);
        expect(parsed).toEqual({ day: freshBannerDay(), count: 2 });
    });

    it('leaves own posts out of the fresh count', async () => {
        // Only own posts posted today: fresh count should be 0, so no banner shows
        holds([
            listing('own-1', 'My organic lemons', { author_pubkey: 'my-own-member-key' }),
        ]);

        await render();

        expect(host.textContent).not.toContain('Tap to dismiss • Scroll down to explore');
        expect(host.textContent).not.toContain('fresh listing posted today');
    });

    it('more listings posted today bring the banner back', async () => {
        // Pre-set stored dismissal for 1 listing today
        const dismissal = JSON.stringify({ day: freshBannerDay(), count: 1 });
        store.map.set('bp_dismissed_fresh_count', dismissal);

        // Feed has 2 listings today from other members
        holds([
            listing('post-1', 'Bicycle repair', { author_pubkey: 'neighbour-1' }),
            listing('post-2', 'Sourdough loaf', { author_pubkey: 'neighbour-2' }),
        ]);

        await render();

        // Count (2) > dismissed (1), so banner reappears
        expect(host.textContent).toContain('2 fresh listings posted today!');
        expect(host.textContent).toContain('Tap to dismiss • Scroll down to explore');
    });
});
