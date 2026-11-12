// @vitest-environment jsdom
/**
 * Show credit is OFF at every visit (DESIGN-credit-list-fable.md §2; the deciding review of #3096, finding 1): the whole of
 * app/(tabs)/people.tsx rendered for real (the mount of people-invites-no-vouch-render.test.ts), on a local community with
 * Beans, for someone the node says gives credit. The People tab stays mounted, so the switch must go off by itself when the
 * member leaves it for another tab or the app goes to the background, taking the list (and the balances it holds in memory)
 * with it, and the next switch-on must ask the node again. A profile or the names list pushed ON TOP of People is not a
 * leave: the list is still there when the member comes back (the Confirm re-read needs it). A door's or the bell's start
 * (a chip, a voucher) is spent when the switch goes off, however it goes off: a later plain switch-on opens on All.
 *
 * The credit list itself is a stub that records when it is mounted and unmounted (its own reads are credit-render.test.ts):
 * a new mount is a new read of the node, an unmount is the pages in memory dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment, useEffect, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Where the member is (the router's pathname), the route's params, the app's state, and what the credit list stub did. */
const route = vi.hoisted(() => ({
    path: '/people',
    params: { view: 'community' } as Record<string, string | undefined>,
    listeners: new Set<() => void>(),
    appState: new Set<(s: string) => void>(),
    log: [] as string[],
    refuse: null as null | (() => void),
}));
const go = (path: string) => { route.path = path; route.listeners.forEach((l) => l()); };

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'radio') attrs.role = 'radio';
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
            ListHeaderComponent,
            (data ?? []).length
                ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
                : ListEmptyComponent,
            ListFooterComponent),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Switch: ({ value, onValueChange, testID, accessibilityLabel }: Record<string, any>) => createElement('button', {
            role: 'switch', 'aria-checked': String(!!value), 'aria-label': accessibilityLabel, 'data-testid': testID, onClick: () => onValueChange?.(!value),
        }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert() {} },
        Share: { share: async () => ({}) },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: {
            currentState: 'active',
            addEventListener: (_: string, cb: (s: string) => void) => { route.appState.add(cb); return { remove() { route.appState.delete(cb); } }; },
        },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const { useEffect: useEffectInMock } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {}, replace() {} },
        useFocusEffect: (cb: () => void | (() => void)) => useEffectInMock(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => route.params,
        usePathname: () => useSyncExternalStore((l) => { route.listeners.add(l); return () => { route.listeners.delete(l); }; }, () => route.path),
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
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'a-member-key', callsign: 'Robin', privateKey: 'aa' } }) }));

const never = () => new Promise<never>(() => {});
vi.mock('../db', () => ({
    getDb: () => new Promise<never>(() => {}), getFriendsLocal: async () => [], addFriendLocal: () => new Promise<never>(() => {}),
    removeFriendLocal: () => new Promise<never>(() => {}), createConversationApi: () => new Promise<never>(() => {}),
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../member-statements', () => ({ makeOfflineTicket: async () => 'BP-TICKET' }));
vi.mock('../membership-probe', () => ({ fetchMembership: () => new Promise<never>(() => {}) }));
vi.mock('../node-admin', () => ({
    askNodeRole: () => new Promise<never>(() => {}), persistNodeRole: async () => {}, readPersistedNodeRole: async () => undefined, rememberNodeRole: async () => {},
}));
vi.mock('../knock-inbox', () => ({ fetchJoinRequests: () => new Promise<never>(() => {}) }));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: () => new Promise<never>(() => {}), joinedNudge: () => '', PROTECT_REDIRECT: '', HOME_REDIRECT: '' }));
vi.mock('../community-switch', () => ({ communitySwitched: () => () => {} }));
vi.mock('../global-join-existing', () => ({ isGlobalCommunity: () => false }));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'checking' }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise<never>(() => {}), signedPost: () => new Promise<never>(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../../components/WantsToJoin', () => ({ WantsToJoin: () => null }));
vi.mock('../../components/MyJoinRequests', () => ({ MyJoinRequests: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
// The node says this member gives credit (its fresh answer; use-credit-giver.test and credit-render.test cover the asking).
vi.mock('../use-credit-giver', () => ({ useCreditGiver: () => 'giver' }));
// The credit list: what it was opened on, when it came and went, and a way for the node to refuse it.
vi.mock('../../components/CreditList', () => ({
    CreditList: (p: { initialFilter?: string; focusVoucher?: string; onRefused: () => void }) => {
        useEffect(() => {
            route.log.push(`mount ${p.initialFilter ?? 'all'}${p.focusVoucher ? ` ${p.focusVoucher}` : ''}`);
            route.refuse = p.onRefused;
            return () => { route.log.push('unmount'); };
        }, []);
        return createElement('div', { 'data-testid': 'credit-list', 'data-filter': p.initialFilter ?? 'all', 'data-voucher': p.focusVoucher ?? '' }, 'credit list');
    },
}));

import PeopleScreen from '../../app/(tabs)/people';

const NODE = 'https://node.example';
const VOUCHER = 'b'.repeat(64);
const rememberProfile = () =>
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true, invites: true, showcase: false }, checkedAt: new Date().toISOString() } }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    rememberProfile();
    route.path = '/people';
    route.params = { view: 'community' };
    route.log.length = 0;
    route.refuse = null;
    globalThis.fetch = vi.fn(async () => never()) as unknown as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const show = async () => { await act(async () => { root.render(createElement(PeopleScreen) as any); }); await settle(); };
const switchEl = () => host.querySelector('[data-testid="credit-switch"]') as HTMLElement | null;
const isOn = () => switchEl()?.getAttribute('aria-checked') === 'true';
const flip = async () => { await act(async () => { switchEl()!.click(); }); await settle(); };
const list = () => host.querySelector('[data-testid="credit-list"]') as HTMLElement | null;
const navigate = async (path: string) => { await act(async () => { go(path); }); await settle(); };
const background = async () => { await act(async () => { route.appState.forEach((cb) => cb('background')); }); await settle(); };

describe('Show credit is off at every visit', () => {
    it('starts off, and the switch turns it on and off by hand', async () => {
        await show();
        expect(switchEl()).not.toBeNull();
        expect(isOn()).toBe(false);
        expect(list()).toBeNull();
        await flip();
        expect(isOn()).toBe(true);
        expect(list()).not.toBeNull();
        await flip();
        expect(isOn()).toBe(false);
        expect(list()).toBeNull();
    });

    it('leaving People for another tab turns it off and drops the list; coming back is off, and the next switch-on asks the node again', async () => {
        await show();
        await flip();
        expect(route.log).toEqual(['mount all']);
        await navigate('/market');
        expect(list()).toBeNull();
        await navigate('/people');
        expect(isOn()).toBe(false);
        expect(list()).toBeNull();
        expect(route.log).toEqual(['mount all', 'unmount']);
        await flip();
        expect(list()).not.toBeNull();
        expect(route.log).toEqual(['mount all', 'unmount', 'mount all']);
    });

    it('a profile or the names list pushed on top is not a leave: the switch and the list are as they were when it comes back', async () => {
        await show();
        await flip();
        await navigate('/public-profile');
        await navigate('/names-list');
        await navigate('/people');
        expect(isOn()).toBe(true);
        expect(list()).not.toBeNull();
        expect(route.log).toEqual(['mount all']);
    });

    it('a pushed screen, then another tab (a link out of the profile), is a leave', async () => {
        await show();
        await flip();
        await navigate('/public-profile');
        await navigate('/chats');
        await navigate('/people');
        expect(isOn()).toBe(false);
        expect(list()).toBeNull();
    });

    it('the app going to the background turns it off', async () => {
        await show();
        await flip();
        await background();
        expect(isOn()).toBe(false);
        expect(list()).toBeNull();
        expect(route.log).toEqual(['mount all', 'unmount']);
    });

    it('People inside Talk (the Chat tab) is left when another tab opens, and People as its own route is left for Chat', async () => {
        route.path = '/chats';
        await show();
        await flip();
        await navigate('/ledger');
        await navigate('/chats');
        expect(isOn()).toBe(false);
        expect(list()).toBeNull();
        await flip();
        await navigate('/people');
        expect(isOn()).toBe(false);
    });
});

describe('a door\'s or the bell\'s start is spent when the switch goes off, however it goes off', () => {
    const bell = () => { route.params = { view: 'community', credit: 'vouchers', voucher: VOUCHER }; };

    it('the bell opens the Vouchers chip on the voucher; after a leave a plain switch-on opens on All', async () => {
        bell();
        await show();
        expect(isOn()).toBe(true);
        expect(list()!.getAttribute('data-filter')).toBe('vouchers');
        expect(list()!.getAttribute('data-voucher')).toBe(VOUCHER);
        await navigate('/market');
        await navigate('/people');
        expect(isOn()).toBe(false);
        await flip();
        expect(list()!.getAttribute('data-filter')).toBe('all');
        expect(list()!.getAttribute('data-voucher')).toBe('');
    });

    it('the same after the app went to the background', async () => {
        bell();
        await show();
        await background();
        await flip();
        expect(list()!.getAttribute('data-filter')).toBe('all');
        expect(list()!.getAttribute('data-voucher')).toBe('');
    });

    it('the same after the node refused the list (403 not_a_giver)', async () => {
        bell();
        await show();
        await act(async () => { route.refuse!(); });
        await settle();
        expect(isOn()).toBe(false);
        await flip();
        expect(list()!.getAttribute('data-filter')).toBe('all');
        expect(list()!.getAttribute('data-voucher')).toBe('');
    });

    it('the same after the member turned it off by hand', async () => {
        bell();
        await show();
        await flip();
        expect(isOn()).toBe(false);
        await flip();
        expect(list()!.getAttribute('data-filter')).toBe('all');
    });

    it('the same after the member left the Community list for Invites', async () => {
        bell();
        await show();
        const pill = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Invites'));
        expect(pill, 'the Invites pill').toBeTruthy();
        await act(async () => { pill!.click(); });
        await settle();
        expect(switchEl()).toBeNull();
        const community = Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Community'));
        expect(community, 'the Community pill').toBeTruthy();
        await act(async () => { community!.click(); });
        await settle();
        expect(isOn()).toBe(false);
        await flip();
        expect(list()!.getAttribute('data-filter')).toBe('all');
    });
});
