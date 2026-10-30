// @vitest-environment jsdom
/**
 * The Market of a community that syncs listings by area, when little is near the member (Damo via Marty, 30 Oct:
 * "Nearby, then fill"), the whole screen rendered for real (app/(tabs)/market.tsx): with fewer than FILL_BELOW listings
 * shown from the phone's nearby set, the newest from elsewhere come beneath them, read from the node as the Market's
 * search reads it (no words, no point), without a tap and without repeating one. From 8, nothing changes. The
 * showcase-market-render.test.ts recipe: children that only draw what they are given are stand-ins; the screen, its
 * hooks and its cards are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// use-global-guest-visit reads useNodeStatus().recheck (only during a visit, which these screens never start); the real
// context pulls expo-crypto in at import.
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
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));
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
// The author chip draws what it is given: its props are recorded, so a card's tier and founding key can be checked.
vi.mock('../../components/PostAuthorTrust', () => ({
    PostAuthorTrust: ({ callsign, showTier = true, isFounding = false }: { callsign: string; showTier?: boolean; isFounding?: boolean }) =>
        createElement('span', { 'data-author': callsign, 'data-show-tier': String(showTier), 'data-founding': String(!!isFounding) }),
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
vi.mock('../../components/NoAreaLine', () => ({ NoAreaLine: none }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: none }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/CurrencyDisplay', () => ({ CurrencyDisplay: ({ amount }: { amount: string | number }) => createElement('span', null, `${amount} Beans`) }));
// The type pills' row records its handler, so a test can pick a pill as a tap does.
const pick = vi.hoisted(() => ({ select: null as null | ((id: string) => void) }));
vi.mock('../../components/FilterChipRow', () => ({
    FilterChipRow: ({ chips, onSelect }: { chips: Array<{ id: string }>; onSelect: (id: string) => void }) => { if (chips.some(c => c.id === 'offers')) pick.select = onSelect; return null; },
    FilterChipBar: none,
}));
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
const BY_AREA = { beans: false, nearbyListings: { radiusKm: 250, max: 500 } };
function rememberProfile(profile: 'global' | 'local', features: Record<string, unknown>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}
const EMPTY: Record<string, unknown> = { getPosts: [], getBalance: { isBlockedFromTrading: false }, getMarketplaceTransactions: [], getMyPosts: [], fetchGroups: [], fetchMyEvents: [] };
const listing = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, title, type: 'offer', status: 'active', category: 'services', author_pubkey: 'ada-key', author_callsign: 'Ada', author_energy_cycled: 0,
    credits: 0, photos: '[]', lat: -28.6, lng: 153.4, created_at: new Date().toISOString(), ...extra,
});
/** What the phone holds: the nearby set. */
const nearOf = (n: number) => Array.from({ length: n }, (_, i) => listing(`near-${i}`, `Near ${i}`));
/** What the node answers the elsewhere read: camelCase rows, newest first. */
const farOf = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `far-${i}`, title: `Far ${i}`, type: 'offer', status: 'active', category: 'services', authorPublicKey: 'bo-key', authorCallsign: 'Bo',
    credits: 0, photos: [], lat: 48.8, lng: 2.3, createdAt: new Date().toISOString(),
}));
/** The node's answer to the elsewhere read, and the urls it was asked. */
const node = vi.hoisted(() => ({ rows: [] as unknown[], asked: [] as string[], fail: false }));
const holds = (near: unknown[]) => { net.answer = (name) => (name === 'getPosts' ? Promise.resolve(near) : name in EMPTY ? Promise.resolve(EMPTY[name]) : undefined); };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    node.rows = [];
    node.asked.length = 0;
    node.fail = false;
    params.now = {};
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    me.identity = { publicKey: 'a-real-member-key', callsign: 'RealMember' };
    rememberProfile('global', BY_AREA);
    holds([]);
    globalThis.fetch = vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes('/api/marketplace/posts')) {
            node.asked.push(u);
            if (node.fail) return new Response('nope', { status: 500 });
            return new Response(JSON.stringify(node.rows));
        }
        return new Response('{}');
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => {}); };
const render = async () => { await act(async () => { root.render(createElement(MarketScreen) as any); }); await settle(); };
const text = () => host.textContent ?? '';
const fill = () => host.querySelector('[data-testid="market-fill"]');
const count = (title: string) => (text().match(new RegExp(`${title}(?!\\d)`, 'g')) ?? []).length;

describe('a short nearby list is filled with the newest from elsewhere', () => {
    it('nothing near: the newest from elsewhere fill in at once, with the short line above and no tap', async () => {
        node.rows = farOf(3);
        await render();
        expect(fill()).not.toBeNull();
        const section = fill()!.textContent ?? '';
        expect(section).toContain('NEWEST FROM ELSEWHERE');
        for (const title of ['Far 0', 'Far 1', 'Far 2']) expect(section).toContain(title);
        expect(host.querySelector('[data-testid="market-near-empty"]')?.textContent).toBe('Nothing within 250 km yet.');
        // The dead end and its link are gone.
        expect(host.querySelector('[data-testid="market-see-elsewhere"]')).toBeNull();
        expect(host.querySelector('[data-testid="market-empty-tiles"]')).toBeNull();
        // The same route as the search, with no words and no point: the newest page, narrowed by nothing.
        expect(node.asked).toEqual([`${NODE}/api/marketplace/posts?types=offer,need,poll,event&limit=50`]);
    });

    it('3 near: those 3 first, then elsewhere without a listing twice', async () => {
        const near = nearOf(3);
        holds(near);
        // The newest from everywhere holds two of the near ones too.
        node.rows = [{ ...farOf(1)[0], id: 'near-1', title: 'Near 1' }, ...farOf(2), { ...farOf(1)[0], id: 'near-0', title: 'Near 0' }];
        await render();
        expect(fill()).not.toBeNull();
        for (const title of ['Near 0', 'Near 1', 'Near 2']) expect(count(title)).toBe(1);
        expect(fill()!.textContent).toContain('Far 0');
        expect(fill()!.textContent).toContain('Far 1');
        expect(fill()!.textContent).not.toContain('Near');
        // Nearest first is kept: the near ones come before the section.
        expect(text().indexOf('Near 2')).toBeLessThan(text().indexOf('NEWEST FROM ELSEWHERE'));
        expect(host.querySelector('[data-testid="market-near-empty"]')).toBeNull();
    });

    it('8 near: nothing changes, no section and no read of elsewhere', async () => {
        holds(nearOf(8));
        node.rows = farOf(4);
        await render();
        expect(text()).toContain('Near 7');
        expect(fill()).toBeNull();
        expect(text()).not.toContain('Far 0');
        expect(node.asked).toEqual([]);
    });

    it('never takes the list past a page', async () => {
        holds(nearOf(3));
        node.rows = farOf(120);
        await render();
        expect((fill()!.textContent ?? '').match(/Far \d+/g)).toHaveLength(47);
    });

    it('the type and category the member picked narrow the read of elsewhere too', async () => {
        node.rows = farOf(2);
        await render();
        await act(async () => { pick.select!('offers'); });
        await settle();
        expect(node.asked.at(-1)).toBe(`${NODE}/api/marketplace/posts?type=offer&limit=50`);
    });

    it('rows that fail the feed filters are not in the fill (a need under Offers, a blocked author)', async () => {
        node.rows = [...farOf(1), { ...farOf(1)[0], id: 'far-need', title: 'Far need', type: 'need' }];
        await render();
        await act(async () => { pick.select!('offers'); });
        await settle();
        expect(fill()!.textContent).toContain('Far 0');
        expect(fill()!.textContent).not.toContain('Far need');
    });

    it('if elsewhere cannot be read, an empty area ends in the old empty state and its link', async () => {
        node.fail = true;
        await render();
        expect(fill()).toBeNull();
        expect(host.querySelector('[data-testid="market-see-elsewhere"]')).not.toBeNull();
        expect(text()).toContain('Nothing within 250 km yet.');
    });

    it('not for a member with no area (they already have the newest worldwide), a local community, or a signed-out phone', async () => {
        node.rows = farOf(2);
        // No area: the node's word, noted by the sync (utils/nearby-area.ts).
        const dbName = (await import('../nodes')).getDatabaseFilenameForNode(NODE);
        store.map.set(`pillar_sync_${dbName}_nearby_area`, JSON.stringify({ key: 'a-real-member-key', area: null, checkedAt: Date.now(), whole: false }));
        await render();
        expect(fill()).toBeNull();
        expect(node.asked).toEqual([]);
        act(() => root.unmount());
        root = createRoot(host);

        store.map.delete(`pillar_sync_${dbName}_nearby_area`);
        rememberProfile('local', { beans: true });
        await render();
        expect(fill()).toBeNull();
        expect(node.asked).toEqual([]);
    });

    it('not under Events, a group, or while a search is typed', async () => {
        node.rows = farOf(2);
        params.now = { filter: 'events' };
        await render();
        expect(fill()).toBeNull();
        expect(node.asked).toEqual([]);
    });
});
