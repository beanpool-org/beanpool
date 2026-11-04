// @vitest-environment jsdom
/**
 * A tap anywhere on a small card opens the ITEM, never the owner's profile (Marty, 4 Nov 2026: "in the listings and on the map
 * cards and pretty much any small card - if you click on the card in the wrong place you go to the owner of the listing's
 * profile ... from small cards you should be able to click anywhere on the card and have the card come up and then be able to
 * click on the profile pic from there").
 *
 * The real Market screen with its REAL author chip (components/PostAuthorTrust), in each of its three views. In the render
 * harness a press stops at the innermost button, as on a phone, so a chip that is a button swallows the card's press: a press
 * on the author's name must reach the card and send the app to the listing, and to no profile. One accessible element per
 * card: a button that reads out as the listing (its title and that it is a listing), not as its owner.
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
        AppState: { addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});

const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
/** Every place the app was sent to by `router.push`, in order. */
const go = vi.hoisted(() => ({ pushes: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push: (to: unknown) => { go.pushes.push(to); }, navigate() {}, setParams() {} },
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
vi.mock('../../components/ActivityWaterfall', () => ({ ActivityWaterfall: none }));
vi.mock('../../components/PollCard', () => ({ PollCard: ({ post }: { post: { id: string; title: string } }) => createElement('div', { 'data-poll': post.id }, post.title) }));
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
const EMPTY: Record<string, unknown> = { getPosts: [], getBalance: { isBlockedFromTrading: false }, getMarketplaceTransactions: [], getNearbyKeptPostIds: new Set<string>(), getMyPosts: [], fetchGroups: [], fetchMyEvents: [] };
const listing = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, title, type: 'offer', status: 'active', category: 'services', author_pubkey: 'damo-key', author_callsign: 'Damo', author_energy_cycled: 0,
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
    go.pushes.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true }, checkedAt: new Date().toISOString() } }));
    me.identity = { publicKey: 'my-own-member-key', callsign: 'MyUser' };
    holds([]);
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => {}); };
const render = async () => { await act(async () => { root.render(createElement(MarketScreen) as any); }); await settle(); };
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const toggleView = () => click(host.querySelector('[aria-label="Grid view"], [aria-label="Compact view"], [aria-label="List view"]'));

/** The card as a screen reader meets it: the one button named for the listing. */
const cardOf = (title: string) => host.querySelector(`[role="button"][aria-label="Open listing: ${title}"]`);

// An event is a small card too (style box P2, DESIGN-market-event-cards-fable.md §2.2): the real EventCard, one button that
// opens the event, read out as the event, with no Going / Interested button inside it to land on.
describe('the Market on the phone: an event card opens its event', () => {
    const DAY = 86_400_000;
    const event = {
        ...listing('ev-market', 'Byron Bay Farmers Market', { type: 'event', category: 'events' }),
        author_pubkey: 'host-key', event_start_at: new Date(Date.now() + DAY).toISOString(),
        event_end_at: new Date(Date.now() + DAY + 4 * 3_600_000).toISOString(), event_place_name: 'Butler Street Reserve',
        event_state: 'scheduled', goingCount: 3, interestedCount: 1, myRsvp: 'going',
    };
    beforeEach(() => holds([event, listing('pots', 'Pottery course')]));

    it('list view: one button for the event, named for it with the member\'s mark; a press on its place opens the event', async () => {
        await render();
        const buttons = Array.from(host.querySelectorAll('[role="button"]')).filter(b => b.textContent?.includes('Byron Bay Farmers Market'));
        expect(buttons).toHaveLength(1);
        const card = buttons[0];
        expect(card.getAttribute('aria-label')).toMatch(/^Event: Byron Bay Farmers Market, .+, Going ✓$/);
        expect(card.querySelectorAll('[role="button"], button')).toHaveLength(0);
        expect(card.textContent).not.toContain('Interested');
        const place = Array.from(card.querySelectorAll('span')).find(s => s.textContent?.includes('Butler Street Reserve'));
        await click(place!);
        expect(go.pushes).toEqual(['/post/ev-market']);
    });
});

describe('the Market on the phone: a small card opens its listing, not its owner', () => {
    beforeEach(() => holds([listing('pots', 'Pottery course')]));

    it.each([['list', 0], ['grid', 1], ['compact', 2]] as const)("%s view: a press on the owner's name opens the listing, and no profile", async (_view, toggles) => {
        await render();
        for (let i = 0; i < toggles; i++) await toggleView();
        const card = cardOf('Pottery course');
        expect(card).toBeTruthy();
        const owner = Array.from(card!.querySelectorAll('span')).find(s => s.textContent?.includes('Damo'));
        expect(owner).toBeTruthy();
        await click(owner!);
        expect(go.pushes).toEqual(['/post/pots']);
    });

    it.each([['list', 0], ['grid', 1]] as const)('%s view: the owner is shown, and nothing inside the card is a button that reaches a profile', async (_view, toggles) => {
        await render();
        for (let i = 0; i < toggles; i++) await toggleView();
        const card = cardOf('Pottery course')!;
        expect(card.textContent).toContain('Damo');
        expect(card.querySelector('[data-testid="author-chip"]')).toBeNull();
        expect(Array.from(card.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label')).filter(l => /profile/i.test(l ?? ''))).toEqual([]);
    });

    it('the card reads out as the listing: one button, named for its title', async () => {
        await render();
        const buttons = Array.from(host.querySelectorAll('[role="button"]')).filter(b => b.getAttribute('aria-label')?.includes('Pottery course'));
        expect(buttons).toHaveLength(1);
        expect(buttons[0].getAttribute('aria-label')).toBe('Open listing: Pottery course');
        expect(buttons[0].getAttribute('aria-label')).not.toContain('Damo');
    });
});
