// @vitest-environment jsdom
/**
 * ★ For You's "Your events" follows the member's answer (the deciding review of #2874, market.tsx): the event's page is the
 * only place to answer since the card lost its buttons (style box P2), and that page is a sheet over the Market, so the
 * Market stays mounted under it. When the member comes back from it, "Your events" is read again: an answer changed there
 * is the row's new mark, a cleared one takes the row away, a new Going brings one in. Before this, the rows kept the mark
 * they were first read with until the member changed pill, and the same event could read two ways on one screen.
 *
 * The real MarketScreen and the real EventCard (its mark), with the device modules stubbed as cards-open-item-render.test.ts
 * does. Focus is the navigator's: a "come back" runs every focus effect's clean-up and then the effect again, as a sheet
 * closing over the tabs does on a phone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MyEvent } from '../event-extras';

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
        AppState: { addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});

/** The navigator's focus: `comeBack()` is the sheet over the tabs closing, which blurs and re-focuses the Market. */
const focus = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock('expo-router', async () => {
    const { useEffect, useState } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {} },
        // As the real hook: the effect runs on focus and again when its callback changes while focused; its clean-up runs
        // on blur. A come-back is a blur and a focus, so each effect cleans up and runs again.
        useFocusEffect: (cb: () => void | (() => void)) => {
            const [visit, setVisit] = useState(0);
            useEffect(() => {
                const again = () => setVisit(v => v + 1);
                focus.listeners.add(again);
                return () => { focus.listeners.delete(again); };
            }, []);
            useEffect(() => cb(), [cb, visit]);
        },
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

vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'my-own-member-key', callsign: 'MyUser' } }) }));

const { none } = vi.hoisted(() => ({ none: () => null }));
vi.mock('../../components/RadiusPickerModal', () => ({ RadiusPickerModal: none }));
vi.mock('../../components/TrustPickerSheet', () => ({ TrustPickerSheet: none, TRUST_FILTERS: [] }));
vi.mock('../../components/ActivityWaterfall', () => ({ ActivityWaterfall: none }));
vi.mock('../../components/PollCard', () => ({ PollCard: none }));
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: none }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: none }));
vi.mock('../../components/NewPostTypeSheet', () => ({ NewPostTypeSheet: none }));
vi.mock('../../components/OwnerWordsPrompt', () => ({ OwnerWordsPrompt: none }));
vi.mock('../../components/ExampleListings', () => ({ ExampleListings: none }));
vi.mock('../../components/MarketCircleLine', () => ({ MarketCircleLine: none, useFindCardRead: () => null }));
vi.mock('../../components/NoAreaLine', () => ({ NoAreaLine: none }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: none }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/CurrencyDisplay', () => ({ CurrencyDisplay: ({ amount }: { amount: string | number }) => createElement('span', null, `${amount} Beans`) }));
// The type row as buttons, one per pill, so the test can choose ★ For You as a member does.
vi.mock('../../components/FilterChipRow', () => ({
    FilterChipRow: ({ chips, onSelect }: { chips: ReadonlyArray<{ id: string }>; onSelect: (id: string) => void }) => createElement('div', null,
        chips.map(c => createElement('button', { key: c.id, 'data-chip': c.id, onClick: () => onSelect(c.id) }, c.id))),
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
    signedGet: () => new Promise(() => {}),
    signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));

/** The node: what `/api/events/mine` answers now, and every db call the screen made. */
const node = vi.hoisted(() => ({ mine: [] as MyEvent[], calls: [] as string[] }));
const EMPTY: Record<string, unknown> = { getPosts: [], getBalance: { isBlockedFromTrading: false }, getMarketplaceTransactions: [], getNearbyKeptPostIds: new Set<string>(), getMyPosts: [], fetchGroups: [] };
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(node.calls, (name) => (
    name === 'fetchMyEvents' ? Promise.resolve(node.mine.map(r => ({ ...r })))
        : name in EMPTY ? Promise.resolve(EMPTY[name]) : undefined)));

import MarketScreen from '../../app/(tabs)/market';

const NODE = 'https://local.example';
const DAY = 86_400_000;
const repairCafe = (rsvp: MyEvent['rsvp']): MyEvent => ({
    postId: 'ev-repair', title: 'Repair café', startAt: new Date(Date.now() + DAY).toISOString(),
    endAt: new Date(Date.now() + DAY + 3 * 3_600_000).toISOString(), placeName: 'Mullum hall', rsvp, photo: null, reminderOffsets: null,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    node.mine = [];
    node.calls.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true }, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => {}); };
const render = async () => { await act(async () => { root.render(createElement(MarketScreen) as any); }); await settle(); };
const choose = async (pill: string) => {
    const chip = host.querySelector(`[data-chip="${pill}"]`);
    expect(chip, `the ${pill} pill`).toBeTruthy();
    await act(async () => { (chip as HTMLElement).click(); });
    await settle();
};
/** The member closes the event's page: the Market, under it all along, is focused again. */
const comeBack = async () => { await act(async () => { for (const again of [...focus.listeners]) again(); }); await settle(); };
const reads = () => node.calls.filter(c => c === 'db.fetchMyEvents').length;
const markOf = (postId: string) => host.querySelector(`[data-testid="event-card-${postId}"] [data-testid="event-mark"]`)?.textContent ?? null;
const yourEventsShown = () => (host.textContent ?? '').includes('YOUR EVENTS');

describe('★ For You: "Your events" follows the answer given on the event\'s page', () => {
    it('an answer changed on the page is the row\'s mark when the member comes back', async () => {
        node.mine = [repairCafe('going')];
        await render();
        await choose('for-you');
        expect(yourEventsShown()).toBe(true);
        expect(markOf('ev-repair')).toBe('Going ✓');

        // On the event's page: Going → Interested. The node now answers the new place.
        node.mine = [repairCafe('interested')];
        await comeBack();
        expect(markOf('ev-repair')).toBe('Interested ✓');
        // One card for the event, one mark: never the old one beside the new.
        expect(host.querySelectorAll('[data-testid="event-card-ev-repair"]')).toHaveLength(1);
    });

    it('an answer cleared on the page takes the row away; a new Going brings one in', async () => {
        node.mine = [repairCafe('going')];
        await render();
        await choose('for-you');
        expect(markOf('ev-repair')).toBe('Going ✓');

        node.mine = [];
        await comeBack();
        expect(host.querySelector('[data-testid="event-card-ev-repair"]')).toBeNull();
        expect(yourEventsShown()).toBe(false);

        node.mine = [repairCafe('going')];
        await comeBack();
        expect(yourEventsShown()).toBe(true);
        expect(markOf('ev-repair')).toBe('Going ✓');
    });

    it('is read once per visit, and only while ★ For You is chosen', async () => {
        node.mine = [repairCafe('going')];
        await render();
        // Opening on All: no read of the member's events.
        expect(reads()).toBe(0);
        await choose('for-you');
        expect(reads()).toBe(1);
        await comeBack();
        expect(reads()).toBe(2);
        // On another pill the rows are not drawn, so a come-back reads nothing for them.
        await choose('offers');
        await comeBack();
        expect(reads()).toBe(2);
    });
});
