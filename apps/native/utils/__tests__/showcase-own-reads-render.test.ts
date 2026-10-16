// @vitest-environment jsdom
/**
 * The reader's own data on the phone's other screens (global previews audit, "Across all five", P3; scratch/global-node/
 * DESIGN-global-showcase-fable.md §6 W3): the profile (the member's own trust card, or the vouch button on another's),
 * a listing (the Offer-first gate and the enterprises the member keeps) and the event composer's "Post as" (the
 * enterprises the member keeps) asked the node for the member's own balance on the worldwide community, where Beans
 * and enterprises are Example Valley's. Each screen rendered for real, with the net spy of showcase-market-render.test.ts
 * (every export of utils/db, fetch, XMLHttpRequest, WebSocket): in preview, never asked; on a local community, asked,
 * as before. The mode is decided as on a phone, from its own copy of the node's profile (utils/reads-own.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
        ErrorBoundary: () => null,
        Stack: { Screen: () => null },
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
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0, WHEN_UNLOCKED: 1, AFTER_FIRST_UNLOCK: 2 }));
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
vi.mock('../../components/NewPostTypeSheet', () => ({ NewPostTypeSheet: none }));
vi.mock('../../components/OwnerWordsPrompt', () => ({ OwnerWordsPrompt: none }));
vi.mock('../../components/ExampleListings', () => ({ ExampleListings: none }));
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
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));
vi.mock('@react-native-community/datetimepicker', () => ({ default: () => null }));
vi.mock('@react-native-picker/picker', () => ({ Picker: Object.assign(() => null, { Item: () => null }) }));
vi.mock('react-native-maps', () => ({ default: () => null, Marker: () => null, Circle: () => null, PROVIDER_GOOGLE: 'google', PROVIDER_DEFAULT: 'default' }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-image-manipulator', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('../haptics', () => ({ hapticTick: () => {}, hapticSuccess: () => {}, hapticWarning: () => {}, hapticLight: () => {} }));
vi.mock('../../components/EventDetail', () => ({ EventDetail: none }));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: none }));
vi.mock('../../components/AddressSearch', () => ({ AddressSearch: none }));
vi.mock('../../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: none }));
vi.mock('../../components/ChannelChips', () => ({ ChannelChips: none }));
vi.mock('../channels', () => ({ fetchPublicChannels: () => new Promise(() => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: async () => null, saveCanonicalProfile: async () => {} }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
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

import PublicProfileScreen from '../../app/public-profile';
import PostDetailScreen from '../../app/post/[id]';
import { NewEventModal } from '../../components/NewEventModal';

const NODE = 'https://global.example';
function rememberProfile(profile: 'global' | 'local', features: Record<string, boolean>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}
const WORLDWIDE = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true };
const LOCAL = { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false };
const ME = 'a-real-member-key';
const KOFI = 'k'.repeat(64);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.answer = null;
    params.now = {};
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    me.identity = { publicKey: ME, callsign: 'RealMember', privateKey: 'p' };
    globalThis.fetch = vi.fn(async (url: unknown) => { net.calls.push(`fetch ${String(url)}`); return new Response('{}'); }) as typeof fetch;
    (globalThis as any).XMLHttpRequest = class { open() { net.calls.push('xhr'); } send() { net.calls.push('xhr'); } setRequestHeader() {} };
    (globalThis as any).WebSocket = class { constructor() { net.calls.push('ws'); } };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => {}); };
const render = async (node: unknown) => { await act(async () => { root.render(node as any); }); await settle(); };
const balanceAsks = () => net.calls.filter(c => c === 'db.getBalance');

describe("the profile: the member's own balance", () => {
    for (const [whose, key] of [['their own', ME], ["another member's", KOFI]] as const) {
        it(`a local community, ${whose} profile: asked, as before`, async () => {
            rememberProfile('local', LOCAL);
            params.now = { publicKey: key };
            await render(createElement(PublicProfileScreen));
            expect(net.calls).toContain('db.getMemberProfile');
            expect(balanceAsks()).toHaveLength(1);
        });

        it(`the worldwide community (Beans in preview), ${whose} profile: never asked`, async () => {
            rememberProfile('global', WORLDWIDE);
            params.now = { publicKey: key };
            await render(createElement(PublicProfileScreen));
            expect(net.calls).toContain('db.getMemberProfile');
            expect(balanceAsks()).toEqual([]);
        });
    }
});

describe("a listing: the Offer-first gate and the enterprises the member keeps", () => {
    const POST = { id: 'p1', title: 'Help moving a sofa', type: 'need', status: 'active', author_pubkey: KOFI, credits: 0, photos: '[]', created_at: new Date().toISOString() };
    beforeEach(() => {
        params.now = { id: 'p1' };
        // The listing, and the phone's own database for its deal rows (none): the keeper check is reached.
        const database = { getFirstAsync: async () => null, getAllAsync: async () => [] };
        net.answer = (name) => (name === 'getPost' ? Promise.resolve(POST) : name === 'getDb' ? Promise.resolve(database) : undefined);
    });

    it('a local community: the balance is asked for the gate and for the keeper check, as before', async () => {
        rememberProfile('local', LOCAL);
        await render(createElement(PostDetailScreen));
        expect(net.calls).toContain('db.getPost');
        expect(balanceAsks()).toHaveLength(2);
    });

    it('the worldwide community (Beans and enterprises in preview): never asked', async () => {
        rememberProfile('global', WORLDWIDE);
        await render(createElement(PostDetailScreen));
        expect(net.calls).toContain('db.getPost');
        expect(balanceAsks()).toEqual([]);
    });
});

describe('the event composer: "Post as" an enterprise the member keeps', () => {
    const open = () => render(createElement(NewEventModal, { visible: true, onClose() {} }));

    it('a local community: the balance (keeperOf) and the treasuries are asked, as before', async () => {
        rememberProfile('local', LOCAL);
        await open();
        expect(net.calls).toContain('db.fetchGroups');
        expect(balanceAsks()).toHaveLength(1);
        expect(net.calls).toContain('db.getTreasuries');
    });

    it('the worldwide community (enterprises in preview): neither is asked', async () => {
        rememberProfile('global', WORLDWIDE);
        await open();
        expect(net.calls).toContain('db.fetchGroups');
        expect(balanceAsks()).toEqual([]);
        expect(net.calls).not.toContain('db.getTreasuries');
    });
});
