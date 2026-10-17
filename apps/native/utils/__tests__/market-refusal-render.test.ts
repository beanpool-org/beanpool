// @vitest-environment jsdom
/**
 * The Market with no listing to show, the whole screen rendered for real (app/(tabs)/market.tsx): a community that
 * refused this phone its listings is said as such, from the sync's note (utils/members-only-listings.ts), and "Having
 * trouble connecting" shows only once a first sync got no answer at all (scratch/global-node/
 * DESIGN-global-entry-fable.md §1.3, §C.3, §E, P3). The showcase-market-render.test.ts recipe: children that only draw
 * what they are given are stand-ins; the screen and its hooks are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress({ stopPropagation() {} });
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
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {} },
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => ({}),
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
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'a-stranger-key', callsign: 'Visitor' } }) }));
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
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: none }));
vi.mock('../../components/CurrencyDisplay', () => ({ CurrencyDisplay: none }));
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
// The local copy holds no listing: what the phone of a stranger, or of a closed account, holds of this community.
const net = vi.hoisted(() => ({ calls: [] as string[] }));
const EMPTY: Record<string, unknown> = { getPosts: [], getBalance: { isBlockedFromTrading: false }, getMarketplaceTransactions: [], getMyPosts: [], fetchGroups: [], fetchMyEvents: [] };
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name) => (name in EMPTY ? Promise.resolve(EMPTY[name]) : undefined)));

import MarketScreen from '../../app/(tabs)/market';

const NODE = 'https://global.example';
const PREVIEW = 'This community is in a private preview. Ask its owner for an invite.';
const TROUBLE = 'Having trouble connecting';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: {}, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = vi.fn(async () => new Response('{}')) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
const render = async () => { await act(async () => { root.render(createElement(MarketScreen) as any); }); await settle(); };
/** The 12 s the Market waits for a first sync before it gives a verdict (market.tsx armSyncWait). */
const waitOutFirstSync = async () => { await act(async () => { vi.advanceTimersByTime(12_001); }); await settle(); };
const text = () => host.textContent ?? '';
const shown = (id: string) => host.querySelector(`[data-testid="${id}"]`) !== null;

describe('the Market of a community that refused this phone its listings', () => {
    it("a private preview: the node's own sentence, before and after the first sync's wait, never \"trouble connecting\"", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        store.map.set(`beanpool_members_only_${NODE}`, JSON.stringify({ code: 'private_preview', sentence: 'Ask Ana, who runs it, for an invite.' }));
        await render();
        expect(shown('refused-private_preview')).toBe(true);
        expect(text()).toContain('Ask Ana, who runs it, for an invite.');
        await waitOutFirstSync();
        expect(text()).toContain('Ask Ana, who runs it, for an invite.');
        expect(text()).not.toContain(TROUBLE);
    });

    it("a private preview whose node sent no sentence: the server's own words", async () => {
        store.map.set(`beanpool_members_only_${NODE}`, JSON.stringify({ code: 'private_preview', sentence: null }));
        await render();
        expect(text()).toContain(PREVIEW);
    });

    it("a closed account: the closed sentence, with the community's name as the sheet shows it", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        store.map.set(`beanpool_members_only_${NODE}`, JSON.stringify({ code: 'account_closed' }));
        store.map.set('beanpool_saved_nodes', JSON.stringify([{ url: NODE, alias: 'Mullumbimby' }]));
        await render();
        await waitOutFirstSync();
        expect(shown('refused-account_closed')).toBe(true);
        expect(text()).toContain('Your account in Mullumbimby was closed');
        expect(text()).toContain('You deleted it, or the community removed it. Your other communities are not affected.');
        expect(text()).not.toContain(TROUBLE);
    });

    it('members only: its card, as before', async () => {
        store.map.set(`beanpool_members_only_${NODE}`, '1');
        await render();
        expect(shown('members-only-listings')).toBe(true);
        expect(shown('refused-private_preview') || shown('refused-account_closed')).toBe(false);
    });
});

describe('no refusal noted', () => {
    it('no answer at all: the loader, then "Having trouble connecting" once the first sync gave up', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await render();
        expect(text()).toContain('Loading the marketplace');
        expect(text()).not.toContain(TROUBLE);
        await waitOutFirstSync();
        expect(text()).toContain(TROUBLE);
        expect(shown('members-only-listings') || shown('refused-private_preview') || shown('refused-account_closed')).toBe(false);
    });
});
