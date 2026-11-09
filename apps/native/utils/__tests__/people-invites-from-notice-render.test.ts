// @vitest-environment jsdom
/**
 * A notice that someone asked to join must never land on nothing (9 Nov: an owner of Byron tapped it and found Invites with no
 * list). The notice's routes carry `from=notice`; the whole of app/(tabs)/people.tsx, rendered for real (the mount of
 * people-invites-no-vouch-render.test.ts) on a local community, hands that to Wants to join, takes it off the route so it
 * doesn't outlive the visit, and drops it when the member picks another pill or leaves the tab. Wants to join itself is a
 * probe here; its own words are tested in wants-to-join-refusal.test.ts. Its fetch is a fake node: nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// `focusCleanups`: what each useFocusEffect on the screen returned (it has more than one); `blur()` runs them all.
const nav = vi.hoisted(() => ({
    params: {} as Record<string, string | undefined>, setParams: [] as Array<Record<string, unknown>>, wantsMounts: 0,
    focusCleanups: new Set<() => void>(), blur() { for (const off of [...this.focusCleanups]) off(); },
}));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityState, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(accessibilityState.selected);
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
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert() {} },
        Share: { share: async () => ({}) },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams(p: Record<string, unknown>) { nav.setParams.push(p); }, replace() {} },
        // The screen losing focus is `nav.blur()`: it runs the cleanup each focus effect returned.
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => {
            const off = cb();
            if (typeof off !== 'function') return undefined;
            nav.focusCleanups.add(off);
            return () => { nav.focusCleanups.delete(off); off(); };
        }, [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        // A fresh object on each read, as the router's: the params in force right now.
        useLocalSearchParams: () => ({ ...nav.params }),
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
// Wants to join is a probe: what People hands it is what is checked here. `nav.wantsMounts` counts its instances: a new
// instance is a fresh read, which every visit a notice begins must start from.
vi.mock('../../components/WantsToJoin', async () => {
    const { useEffect } = await import('react');
    return {
        WantsToJoin: (p: { fromNotice?: boolean }) => {
            useEffect(() => { nav.wantsMounts++; }, []);
            return createElement('span', { 'data-testid': 'wants-to-join-probe', 'data-from-notice': String(!!p.fromNotice) });
        },
    };
});
vi.mock('../../components/MyJoinRequests', () => ({ MyJoinRequests: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));

import PeopleScreen from '../../app/(tabs)/people';
import { t } from '@beanpool/core';

const NODE = 'https://node.example';
const LOCAL = { beans: true, invites: true, showcase: false };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: LOCAL, checkedAt: new Date().toISOString() } }));
    nav.params = { view: 'invites' };
    nav.setParams.length = 0;
    nav.wantsMounts = 0;
    nav.focusCleanups.clear();
    globalThis.fetch = vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.endsWith('/api/community/health')) return new Response(JSON.stringify({ ok: true }));
        if (u.includes('/api/invite/mine/')) return new Response(JSON.stringify({ invites: [] }));
        return never();
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const open = async () => { await act(async () => { root.render(createElement(PeopleScreen) as any); }); await settle(); };
/** The screen drawn again with the route as it now is: a notice tapped while the People tab is already open (it stays mounted). */
const tapNotice = async () => {
    nav.params = { view: 'invites', from: 'notice' };
    await open();
    nav.params = { view: 'invites' }; // People took the flag off the route
    await open();
};
/** What People told Wants to join about how Invites was reached; null while Wants to join is not on screen. */
const probe = () => host.querySelector('[data-testid="wants-to-join-probe"]')?.getAttribute('data-from-notice') ?? null;
const pill = (text: string) => {
    const found = Array.from(host.querySelectorAll('button')).find((x) => x.textContent === text);
    expect(found, `the "${text}" pill`).toBeTruthy();
    return found!;
};
const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };

describe('People → Invites opened by the notice "someone asked to join"', () => {
    it('from=notice reaches Wants to join, and is taken off the route so it does not outlive this visit', async () => {
        nav.params = { view: 'invites', from: 'notice' };
        await open();
        expect(probe()).toBe('true');
        expect(nav.setParams).toContainEqual({ from: undefined });
    });

    it('Invites opened any other way: Wants to join is not told a notice brought them', async () => {
        await open();
        expect(probe()).toBe('false');
        expect(nav.setParams).toEqual([]);
    });

    it('picking another pill ends it: back on Invites, it is no longer a notice\'s visit', async () => {
        nav.params = { view: 'invites', from: 'notice' };
        await open();
        expect(probe()).toBe('true');
        await press(pill(t('👫 Friends')));
        expect(probe()).toBeNull();
        await press(pill(t('🎟️ Invites')));
        expect(probe()).toBe('false');
    });

    it('leaving the tab ends it: coming back to Invites later is an ordinary visit', async () => {
        nav.params = { view: 'invites', from: 'notice' };
        await open();
        expect(probe()).toBe('true');
        await act(async () => { nav.blur(); });
        await settle();
        expect(probe()).toBe('false');
    });

    // People is a tab and stays mounted, so Wants to join stays mounted with it: it reads the list when it mounts and no
    // other time. A notice's visit has to start from a fresh read, or "nobody is waiting" is said over an old, empty list
    // while someone is waiting (the review of 9 Nov). A new instance is that fresh read, and drops what the last visit held
    // (an answer given there, the words after it).
    it('the notice is tapped while People is already on Invites: Wants to join starts over, with the notice on', async () => {
        await open();
        expect(nav.wantsMounts).toBe(1);
        expect(probe()).toBe('false');
        await tapNotice();
        expect(nav.wantsMounts).toBe(2);
        expect(probe()).toBe('true');
    });

    it('the notice is tapped again with the first visit still open: it starts over again, each tap', async () => {
        nav.params = { view: 'invites', from: 'notice' };
        await open();
        nav.params = { view: 'invites' };
        await open();
        expect(nav.wantsMounts).toBe(1);
        await tapNotice();
        expect(nav.wantsMounts).toBe(2);
        await tapNotice();
        expect(nav.wantsMounts).toBe(3);
        expect(probe()).toBe('true');
    });

    it('People opened by the notice itself (a cold start): one Wants to join, so one read, not two', async () => {
        nav.params = { view: 'invites', from: 'notice' };
        await open();
        expect(nav.wantsMounts).toBe(1);
        // The same render on the next frame, the route not yet cleared: still no second instance.
        await open();
        expect(nav.wantsMounts).toBe(1);
    });

    it('leaving the tab starts nothing over: only a notice does', async () => {
        nav.params = { view: 'invites', from: 'notice' };
        await open();
        await act(async () => { nav.blur(); });
        await settle();
        expect(nav.wantsMounts).toBe(1);
    });
});
