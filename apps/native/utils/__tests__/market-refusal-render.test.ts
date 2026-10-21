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

/**
 * The sync engine as the Market sees it (services/pillar-sync.ts requestSync), on the faked clock. A request starts a
 * cycle after a 150 ms debounce. One made while a cycle holds the queue, as the Market's is when it hears that cycle's
 * PILLAR_SYNC_ENDED, queues one trailing cycle, which waits 2 s after that one ends and then its debounce.
 * isPillarSyncActive is true from a request until its cycle ends, through that cooldown too (the
 * pillar-sync-trailing-active.test.ts measure of the real engine). Each cycle takes the next of `queued` and ends after its
 * `ms` with pillar_sync_done when it landed, then PILLAR_SYNC_ENDED; with none queued it runs nothing, and nothing
 * reports back. `requests` counts the Market's requests, never the engine's own trailing one. `landed`: a cycle landed on
 * this copy before the Market mounted (syncLandedOnThisCopy).
 */
const sync = vi.hoisted(() => {
    const listeners = new Map<string, Set<(e?: unknown) => void>>();
    const emit = (name: string, e?: unknown) => { for (const l of [...(listeners.get(name) ?? [])]) l(e); };
    type Cycle = { success: boolean; ms: number };
    // A timer set in one test never acts in the next (reset).
    let run = 0;
    let holding = false;
    let again = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let cooldown: ReturnType<typeof setTimeout> | null = null;
    const later = (fn: () => void, ms: number) => { const mine = run; return setTimeout(() => { if (mine === run) fn(); }, ms); };
    const queue = () => {
        if (holding) { again = true; return; }
        if (debounce) clearTimeout(debounce);
        debounce = later(() => {
            debounce = null;
            const cycle = state.queued.shift();
            if (cycle) state.start(cycle);
        }, 150);
    };
    const state = {
        requests: 0,
        landed: false,
        queued: [] as Cycle[],
        listeners,
        emit,
        get active() { return holding || debounce !== null || cooldown !== null; },
        reset() {
            run++;
            holding = again = false;
            debounce = cooldown = null;
            state.requests = 0;
            state.landed = false;
            state.queued = [];
        },
        request() { state.requests++; queue(); },
        /** One cycle: running now, ending after `ms` as it says. */
        start(cycle: Cycle) {
            holding = true;
            later(() => {
                if (cycle.success) emit('pillar_sync_done');
                emit('pillar_sync_ended', { success: cycle.success });
                holding = false;
                if (!again) return;
                again = false;
                cooldown = later(() => { cooldown = null; queue(); }, 2_000);
            }, cycle.ms);
        },
    };
    return state;
});

// The members-only card's way to the global community (utils/use-global-guest-visit.ts), and any browser it opened.
const visits = vi.hoisted(() => ({ n: 0, browser: [] as string[] }));
vi.mock('../use-global-guest-visit', () => ({
    useGlobalGuestVisit: () => ({ visit: async () => { visits.n++; return { kind: 'guest' }; }, visiting: false }),
}));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress({ stopPropagation() {} });
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const emitter = {
        addListener: (name: string, l: (e?: unknown) => void) => {
            if (!sync.listeners.has(name)) sync.listeners.set(name, new Set());
            sync.listeners.get(name)!.add(l);
            return { remove() { sync.listeners.get(name)?.delete(l); } };
        },
        emit: sync.emit,
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
        Linking: { openURL: async (url: string) => { visits.browser.push(url); } },
        DeviceEventEmitter: emitter,
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
vi.mock('../../services/pillar-sync', () => ({
    requestSync: async () => { sync.request(); },
    isPillarSyncActive: () => sync.active,
    syncLandedOnThisCopy: async () => sync.landed,
    PILLAR_SYNC_ENDED: 'pillar_sync_ended',
}));
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
// The feed's foot: what the Market draws once a first sync has landed with nothing to list.
vi.mock('../../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => createElement('div', { 'data-testid': 'market-feed' }) }));
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
    sync.reset();
    sync.listeners.clear();
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
/** `ms` more on the faked clock, and whatever it set off settled. */
const pass = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); await settle(); };
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

    it('members only: Look around the global community opens it here, as a guest, never the browser (fails on origin/main: the browser)', async () => {
        visits.n = 0;
        visits.browser.length = 0;
        store.map.set(`beanpool_members_only_${NODE}`, '1');
        await render();
        const button = host.querySelector('[data-testid="members-only-look-around"]') as HTMLElement | null;
        expect(button?.textContent).toBe('🌍 Look around the global community');
        await act(async () => { button!.click(); });
        expect(visits.n).toBe(1);
        expect(visits.browser).toEqual([]);
    });
});

describe('no refusal noted', () => {
    // A sync that never reports back: the Market asks for one more at 12 s, and gives its verdict when that one's 12 s pass
    // with nothing running (before, the banner came at the first 12 s, with no second try).
    it('no answer at all: the loader, one sync more, then "Having trouble connecting" once that one gave up too', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await render();
        expect(text()).toContain('Loading the marketplace');
        expect(text()).not.toContain(TROUBLE);
        await waitOutFirstSync();
        expect(text()).toContain('Loading the marketplace');
        expect(text()).not.toContain(TROUBLE);
        await waitOutFirstSync();
        expect(text()).toContain(TROUBLE);
        expect(shown('members-only-listings') || shown('refused-private_preview') || shown('refused-account_closed')).toBe(false);
    });
});

// Android 1.2.66, 18 Oct: the Market showed "Having trouble connecting" on a live community, and Retry worked at once. A
// first sync that failed early (a read that went unsigned while the key was slow to read at a cold start, a cold radio)
// got no second try: the banner was the 12 s timer's verdict.
describe('a first sync that fails', () => {
    it('fails at 3 s: one sync more at once, no banner at 12 s while it runs; that one failing too shows the banner', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        sync.start({ success: false, ms: 3_000 });
        sync.queued = [{ success: false, ms: 12_000 }];
        await render();
        // The boot sync is running: the Market asks for none of its own.
        expect(sync.requests).toBe(0);
        await pass(3_000);
        expect(sync.requests).toBe(1);
        expect(text()).not.toContain(TROUBLE);
        await pass(9_001);
        expect(text()).toContain('Loading the marketplace');
        expect(text()).not.toContain(TROUBLE);
        // It ran after the engine's 2 s cooldown and its debounce, from 5.15 s.
        await pass(5_150);
        expect(text()).toContain(TROUBLE);
        expect(sync.requests).toBe(1);
    });

    it('fails at 3 s and the sync after it lands: the market, never the banner', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        sync.start({ success: false, ms: 3_000 });
        sync.queued = [{ success: true, ms: 2_000 }];
        await render();
        await pass(3_000);
        expect(shown('market-feed')).toBe(false);
        expect(text()).toContain('Loading the marketplace');
        await pass(4_150);
        expect(shown('market-feed')).toBe(true);
        await pass(30_000);
        expect(text()).not.toContain(TROUBLE);
        expect(sync.requests).toBe(1);
    });

    // No sync has landed on this copy yet (the boot sync failed before the Market listened, or never ran) and none runs.
    it('nothing landed on this copy and nothing runs as the Market mounts: it asks for one of its own, and one more once that fails', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        sync.queued = [{ success: false, ms: 20_000 }];
        await render();
        expect(sync.requests).toBe(1);
        // Running at 12 s: no verdict, and no second sync over it.
        await waitOutFirstSync();
        expect(sync.requests).toBe(1);
        expect(text()).not.toContain(TROUBLE);
        // It fails: one sync more, which lands.
        sync.queued = [{ success: true, ms: 1_000 }];
        await pass(8_150);
        expect(sync.requests).toBe(2);
        expect(text()).not.toContain(TROUBLE);
        await pass(3_150);
        expect(shown('market-feed')).toBe(true);
    });

    // The healthy start: the boot sync landed before the Market listened, its pillar_sync_done missed. The Market asked for a
    // whole sync more over the phone's data each time it mounted (review of PR #2127).
    it('the boot sync landed on this copy before the Market listened: the market, and no sync of its own', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        sync.landed = true;
        await render();
        expect(sync.requests).toBe(0);
        expect(shown('market-feed')).toBe(true);
        await pass(30_000);
        expect(sync.requests).toBe(0);
        expect(text()).not.toContain(TROUBLE);
    });

    it('Retry starts a new wait with its own second try', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await render();
        await waitOutFirstSync();
        await waitOutFirstSync();
        expect(text()).toContain(TROUBLE);
        const requestsBefore = sync.requests;
        sync.queued = [{ success: false, ms: 1_000 }, { success: true, ms: 1_000 }];
        const retry = Array.from(host.querySelectorAll('button')).find(b => (b.textContent ?? '').includes('Retry'));
        expect(retry).toBeTruthy();
        await act(async () => { retry!.click(); });
        await settle();
        expect(text()).not.toContain(TROUBLE);
        await pass(4_300);
        expect(sync.requests).toBe(requestsBefore + 2);
        expect(shown('market-feed')).toBe(true);
    });

    // The sync asked for as a cycle ends waits out the engine's 2 s cooldown before it runs: one that fails at 11 s has the
    // 12 s pass inside it, with no cycle running. Read as nothing running, it showed the banner over a retry still to come
    // (review of PR #2127).
    it('fails at 11 s: no banner at 12 s while the sync after it waits its turn; that one landing shows the market', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        sync.start({ success: false, ms: 11_000 });
        sync.queued = [{ success: true, ms: 3_000 }];
        await render();
        await pass(11_000);
        expect(sync.requests).toBe(1);
        await pass(1_001);
        expect(text()).toContain('Loading the marketplace');
        expect(text()).not.toContain(TROUBLE);
        await pass(4_150);
        expect(shown('market-feed')).toBe(true);
        expect(text()).not.toContain(TROUBLE);
        expect(sync.requests).toBe(1);
    });

    it('fails at 11 s and the sync after it fails too: the banner once that one has ended, not before', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        sync.start({ success: false, ms: 11_000 });
        sync.queued = [{ success: false, ms: 3_000 }];
        await render();
        await pass(11_000);
        await pass(1_001);
        expect(text()).not.toContain(TROUBLE);
        await pass(4_000);
        expect(text()).not.toContain(TROUBLE);
        await pass(150);
        expect(text()).toContain(TROUBLE);
        expect(sync.requests).toBe(1);
    });
});
