// @vitest-environment jsdom
/**
 * People → Invites vouch presets (slice V3, §4):
 * - Presets: None · 25 · 50 · 75 · 100 shown only when member is a voucher
 * - "From your budget: 550 of 1,000 left"
 * - An invite's body carries `vouchAmount` and nothing else
 * - A refused vouch shows the node's sentence and makes NO ticket
 * - An offline ticket never carries a vouch
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as Array<[string, string | undefined]> }));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'radio') attrs.role = 'radio';
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (disabled || accessibilityState?.disabled) attrs.disabled = true;
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
        Alert: { alert: (title: string, text?: string) => { alerts.said.push([title, text]); } },
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
        router: { push() {}, navigate() {}, setParams() {}, replace() {} },
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => ({ view: 'invites' }),
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
// V2 (#2914): People's Vouchers block reads the names-list key, which imports expo-secure-store (a native module).
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
    SafeAreaView: ({ children, edges, testID }: { children?: unknown; edges?: string[]; testID?: string }) =>
        createElement('div', { 'data-safe-area': (edges ?? ['top', 'right', 'bottom', 'left']).join(','), 'data-testid': testID }, children as any),
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const IDENTITY = { publicKey: 'a-member-key', callsign: 'Robin', privateKey: 'aa' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: IDENTITY }) }));

const tickets = vi.hoisted(() => ({ made: 0 }));
const never = () => new Promise<never>(() => {});
vi.mock('../db', () => ({
    getDb: () => new Promise<never>(() => {}), getFriendsLocal: async () => [], addFriendLocal: () => new Promise<never>(() => {}),
    removeFriendLocal: () => new Promise<never>(() => {}), createConversationApi: () => new Promise<never>(() => {}),
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../member-statements', () => ({ makeOfflineTicket: async () => { tickets.made++; return 'BP-TICKET'; } }));
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
    signedGet: vi.fn(async (_anchor: string, path: string) => {
        if (path === '/api/vouchers/me') {
            return {
                ok: true,
                json: async () => ({
                    voucher: node.voucher,
                    budget: { left: node.budgetLeft, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: node.budgetLevel },
                    presets: [25, 50, 75, 100],
                    vouchMax: 100,
                    budgetMax: 2000,
                    vouchedBy: [],
                }),
            };
        }
        return { ok: false, json: async () => null };
    }),
    signedPost: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../../components/WantsToJoin', () => ({ WantsToJoin: () => null }));
vi.mock('../../components/MyJoinRequests', () => ({ MyJoinRequests: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));

import PeopleScreen from '../../app/(tabs)/people';
import { t } from '@beanpool/core';

const NODE = 'https://node.example';
const LOCAL = { beans: true, invites: true, showcase: false };
const rememberProfile = (features: Record<string, boolean>) =>
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features, checkedAt: new Date().toISOString() } }));

const node = {
    made: [] as Array<Record<string, unknown>>,
    down: false,
    voucher: true,
    budgetLeft: 550,
    budgetLevel: 1000,
    generateRefusal: null as string | null,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    rememberProfile(LOCAL);
    tickets.made = 0;
    alerts.said.length = 0;
    node.made = [];
    node.down = false;
    node.voucher = true;
    node.budgetLeft = 550;
    node.budgetLevel = 1000;
    node.generateRefusal = null;

    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/api/vouchers/me')) {
            return json({
                voucher: node.voucher,
                budget: { left: node.budgetLeft, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: node.budgetLevel },
                presets: [25, 50, 75, 100],
                vouchMax: 100,
                budgetMax: 2000,
                vouchedBy: [],
            });
        }
        if (u.endsWith('/api/invite/generate')) {
            if (node.down) throw new TypeError('Network request failed');
            if (node.generateRefusal) {
                return json({ error: node.generateRefusal }, 409);
            }
            node.made.push(JSON.parse(String(init?.body)));
            return json({ success: true, invite: { code: `INV-TEST-000${node.made.length}` } });
        }
        if (u.endsWith('/api/community/health')) return json({ ok: true });
        if (u.includes('/api/invite/mine/')) return json({ invites: [] });
        return never();
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const open = async () => { await act(async () => { root.render(createElement(PeopleScreen) as any); }); await settle(); };
const generate = async () => {
    const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Generate'));
    expect(button, 'the Generate button').toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
};

describe('People → Invites with vouch presets (slice V3, §4)', () => {
    it('renders presets and budget balance when node says member is a voucher', async () => {
        await open();
        expect(host.querySelector('[data-testid="invite-vouch"]')).toBeTruthy();
        expect(host.textContent).toMatch(/From your budget: 550 of 1,?000 left/);
        expect(host.querySelector('[data-testid="invite-vouch-none"]')).toBeTruthy();
        expect(host.querySelector('[data-testid="invite-vouch-25"]')).toBeTruthy();
        expect(host.querySelector('[data-testid="invite-vouch-50"]')).toBeTruthy();
        expect(host.querySelector('[data-testid="invite-vouch-75"]')).toBeTruthy();
        expect(host.querySelector('[data-testid="invite-vouch-100"]')).toBeTruthy();
    });

    it('greys out preset above budget left', async () => {
        node.budgetLeft = 30;
        await open();
        const b25 = host.querySelector('[data-testid="invite-vouch-25"]');
        const b50 = host.querySelector('[data-testid="invite-vouch-50"]');
        expect(b25?.hasAttribute('disabled')).toBe(false);
        expect(b50?.hasAttribute('disabled')).toBe(true);
    });

    it('selected preset is included in generate request body', async () => {
        await open();
        const b50 = host.querySelector('[data-testid="invite-vouch-50"]') as HTMLButtonElement;
        expect(b50).toBeTruthy();
        await act(async () => { b50.click(); });
        await settle();
        await generate();

        expect(node.made).toHaveLength(1);
        expect(node.made[0]).toEqual({
            publicKey: 'a-member-key',
            vouchAmount: 50,
        });
        expect(tickets.made).toBe(0);
    });

    it('refused vouch shows the server sentence and makes NO offline ticket', async () => {
        node.generateRefusal = 'You have only 20 left in your vouching budget.';
        await open();
        const b50 = host.querySelector('[data-testid="invite-vouch-50"]') as HTMLButtonElement;
        await act(async () => { b50.click(); });
        await settle();
        await generate();

        expect(tickets.made).toBe(0);
        expect(alerts.said).toContainEqual([t('Could not vouch'), 'You have only 20 left in your vouching budget.']);
    });

    it('dropped connection when vouching shows offline notice and makes NO ticket', async () => {
        await open();
        const b50 = host.querySelector('[data-testid="invite-vouch-50"]') as HTMLButtonElement;
        await act(async () => { b50.click(); });
        await settle();
        node.down = true;
        await generate();

        expect(tickets.made).toBe(0);
        expect(alerts.said[0][0]).toBe(t('Offline'));
    });
});
