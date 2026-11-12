// @vitest-environment jsdom
/**
 * A notice that someone asked to join must never say something false (review of 9 Nov, #3003). People is a tab and stays mounted,
 * and so did Wants to join with it: tapping the notice with Invites already the last view showed "Nobody is waiting to join
 * right now." over the list it had read earlier, while someone was waiting. The whole of app/(tabs)/people.tsx, rendered for
 * real, and the real Wants to join, against a fake node whose list changes between the two reads: nothing leaves the test.
 * (people-invites-from-notice-render.test.ts holds what People hands Wants to join; wants-to-join-refusal.test.ts its words.)
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
    params: {} as Record<string, string | undefined>, setParams: [] as Array<Record<string, unknown>>,
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
// The same object on every render, as the app's context gives it: a new one each time would make Wants to join read again
// on every render of People (its read depends on the identity), and hide the very thing tested here.
const me = vi.hoisted(() => ({ identity: { publicKey: 'a-member-key', callsign: 'Robin', privateKey: 'aa' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => me }));

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
// The node's list of people waiting to join: what a read returns now. A read is a read of the node as it is at that moment.
const node = vi.hoisted(() => ({ knocks: [] as Array<Record<string, unknown>> }));
vi.mock('../knock-inbox', () => ({
    KNOCK_UNREACHABLE_TEXT: 'unreachable',
    joinRequestAge: () => 0,
    fetchJoinRequests: async () => ({ ok: true, knocks: node.knocks.map((k) => ({ ...k })), total: node.knocks.length }),
    approveJoinRequest: async (_a: string, _i: unknown, id: string) => { node.knocks = node.knocks.filter((k) => k.id !== id); return { ok: true, status: 'approved' }; },
    declineJoinRequest: async (_a: string, _i: unknown, id: string) => { node.knocks = node.knocks.filter((k) => k.id !== id); return { ok: true, status: 'declined' }; },
}));
vi.mock('../vouchers', () => ({ askMyVouching: async () => null, rereadMyVouching: async () => {} }));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: () => new Promise<never>(() => {}), joinedNudge: () => '', PROTECT_REDIRECT: '', HOME_REDIRECT: '' }));
vi.mock('../community-switch', () => ({ communitySwitched: () => () => {} }));
vi.mock('../global-join-existing', () => ({ isGlobalCommunity: () => false }));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'checking' }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise<never>(() => {}), signedPost: () => new Promise<never>(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../../components/MyJoinRequests', () => ({ MyJoinRequests: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));

// People asks where the member is to end a Show credit visit (utils/people-visit.ts; its own test and people-show-credit-visit-render.test.ts): nothing here leaves the tab.
vi.mock('../people-visit', () => ({ usePeopleVisitEnds: () => 0 }));
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
    node.knocks = [];
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
const pill = (text: string) => {
    const found = Array.from(host.querySelectorAll('button')).find((x) => x.textContent === text);
    expect(found, `the "${text}" pill`).toBeTruthy();
    return found!;
};
const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };

const RIVER = { id: 'k1', pubkey: 'b'.repeat(64), callsign: 'River', message: 'I grow tomatoes by the river.', avatar: null, fromNode: null, createdAt: new Date().toISOString() };
const SKY = { id: 'k2', pubkey: 'c'.repeat(64), callsign: 'Sky', message: 'New in town, I fix bikes.', avatar: null, fromNode: null, createdAt: new Date().toISOString() };

const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null;
/** The notice is tapped: the route says `from=notice`, People takes it off the route (the next render has it gone). */
const tapNotice = async () => {
    nav.params = { view: 'invites', from: 'notice' };
    await open();
    nav.params = { view: 'invites' };
    await open();
};

describe('People → Invites, the notice tapped while People is already on Invites', () => {
    it('nobody was waiting when Invites opened; someone asks; the notice shows them, not "nobody is waiting"', async () => {
        await open();
        expect(byTestId('wants-to-join-nobody')).toBeNull();
        node.knocks = [RIVER];
        await tapNotice();
        expect(byTestId('wants-to-join-nobody')).toBeNull();
        expect(button('Invite River')).toBeTruthy();
        expect(host.textContent).toContain('River');
    });

    it('the notice is tapped with the first visit still open: each tap reads the node again', async () => {
        nav.params = { view: 'invites', from: 'notice' };
        await open();
        expect(byTestId('wants-to-join-nobody')?.textContent).toBe(t('Nobody is waiting to join right now.'));
        nav.params = { view: 'invites' };
        await open();
        node.knocks = [SKY];
        await tapNotice();
        expect(byTestId('wants-to-join-nobody')).toBeNull();
        expect(button('Invite Sky')).toBeTruthy();
    });

    it('the owner answered one earlier in the session; a co-owner answers the next; the notice is tapped: the lines, not a blank', async () => {
        node.knocks = [RIVER];
        await open();
        await press(button('Not now, River')!);
        // Answered by this owner: the section goes, and says nothing of "another owner".
        expect(byTestId('wants-to-join-nobody')).toBeNull();
        node.knocks = []; // Sky asked, and a co-owner has answered Sky before the owner taps the notice
        await tapNotice();
        expect(byTestId('wants-to-join-nobody')?.textContent).toBe(t('Nobody is waiting to join right now.'));
        expect(byTestId('wants-to-join-answered-already')?.textContent).toBe(t('Another owner or admin may have answered already.'));
    });

    it('opened by the notice itself, nobody waiting: the lines, from the one read the screen makes', async () => {
        nav.params = { view: 'invites', from: 'notice' };
        await open();
        expect(byTestId('wants-to-join-nobody')).toBeTruthy();
        expect(byTestId('wants-to-join-answered-already')).toBeTruthy();
    });
});
