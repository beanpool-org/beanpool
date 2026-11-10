// @vitest-environment jsdom
/**
 * People → Invites: Share sends the invite as TEXT ONLY (Marty, 10 Nov: a shared QR picture lost the link, the code and the
 * community's address, and "most people dont know how to scan their own QR code"). The whole of app/(tabs)/people.tsx is
 * rendered for real (the mount of people-invites-no-vouch-render.test.ts) on a local community; every phone module is a
 * stand-in that records what it was given. Share must hand the share sheet one `message` and nothing else: no `url`, no file,
 * no clipboard write, no toast, on either phone. The QR stays on the screen for someone standing beside you.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const phone = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'android',
    // Everything the share dialog was handed, whole, so a stray `url` or `title` shows up in the comparison.
    shares: [] as Array<Record<string, unknown>>,
    toasts: [] as string[],
    copied: [] as string[],
    sharedFiles: [] as Array<{ uri: string; options: unknown }>,
}));

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
        Platform: { get OS() { return phone.os; }, select: (o: Record<string, unknown>) => o[phone.os] ?? o.default },
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
        Alert: { alert: () => {} },
        Share: { share: async (content: Record<string, unknown>) => { phone.shares.push(content); return {}; } },
        ToastAndroid: { LONG: 1, show: (text: string) => { phone.toasts.push(text); } },
        DeviceEventEmitter: { addListener: listener, emit() {} },
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
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('react-native-qrcode-svg', () => ({ default: ({ value }: { value: string }) => createElement('span', { 'data-testid': 'qr', 'data-value': value }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async (text: string) => { phone.copied.push(text); } }));
vi.mock('expo-sharing', () => ({
    isAvailableAsync: async () => true,
    shareAsync: async (uri: string, options: unknown) => { phone.sharedFiles.push({ uri, options }); },
}));
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
// The community's card answers at once, so Share does not wait the two seconds it would for a node that is slow.
vi.mock('../peek', async (importOriginal) => ({ ...(await importOriginal<typeof import('../peek')>()), fetchPeekCommunityName: async () => 'Mullum' }));
vi.mock('../../components/WantsToJoin', () => ({ WantsToJoin: () => null }));
vi.mock('../../components/MyJoinRequests', () => ({ MyJoinRequests: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));

import PeopleScreen from '../../app/(tabs)/people';
import { inviteFolds, t } from '@beanpool/core';

const NODE = 'https://node.example';
const LOCAL = { beans: true, invites: true, showcase: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    inviteFolds.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: LOCAL, checkedAt: new Date().toISOString() } }));
    phone.os = 'ios';
    phone.shares.length = 0;
    phone.toasts.length = 0;
    phone.copied.length = 0;
    phone.sharedFiles.length = 0;
    let made = 0;
    globalThis.fetch = vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.endsWith('/api/invite/generate')) return json({ success: true, invite: { code: `INV-TEST-000${++made}` } });
        if (u.endsWith('/api/community/health')) return json({ ok: true });
        if (u.includes('/api/invite/mine/')) return json({ invites: [] });
        return never();
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const open = async () => { await act(async () => { root.render(createElement(PeopleScreen) as any); }); await settle(); };
const buttonWith = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text);
const tap = async (text: string) => {
    const button = buttonWith(text);
    expect(button, `the "${text}" button`).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
};
/** An invite made on the node: its QR card, with Share. */
const generate = async () => {
    await open();
    await act(async () => { Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Generate'))!.click(); });
    await settle();
};
const generateAndShare = async () => {
    await generate();
    await tap(t('📤 Share Invite'));
};

const LINK = `${NODE}/?invite=INV-TEST-0001`;
/** The message the web's Share sends: the link, the code to paste if the link does not open, and the community's address. */
const MESSAGE = (code: string) => [
    'Join my BeanPool community, Mullum:',
    `${NODE}/?invite=${code}`,
    '',
    "If the link doesn't open, install BeanPool from beanpool.org and paste this code:",
    code,
    '',
    'Community address: node.example',
].join('\n');

/** Nothing but the words went to the share sheet, and nothing else was put on the clipboard, shown as a toast or shared as a file. */
const sentTheTextOnly = (code: string) => {
    expect(phone.shares).toEqual([{ message: MESSAGE(code) }]);
    expect(Object.keys(phone.shares[0])).toEqual(['message']);
    expect(phone.sharedFiles).toEqual([]);
    expect(phone.copied).toEqual([]);
    expect(phone.toasts).toEqual([]);
};

describe('People → Invites: Share sends the whole message as text, never a picture', () => {
    it('the invite just made (📤 Share Invite) shares the link, the code and the address on iOS', async () => {
        await generateAndShare();
        expect(phone.shares[0].message).toContain(LINK);
        sentTheTextOnly('INV-TEST-0001');
    });

    it('and the same on Android: no picture dialog, no clipboard note', async () => {
        phone.os = 'android';
        await generateAndShare();
        sentTheTextOnly('INV-TEST-0001');
    });

    it('an invite in the pending list (open the row, then Share) sends its own message', async () => {
        store.map.set('bp_offline_invites_a-member-key', JSON.stringify([{ code: 'INV-ROW-0001', createdAt: new Date().toISOString(), intendedFor: 'Sam' }]));
        await open();
        // Pending is folded until opened; the whole row opens the invite, and Share is on it.
        for (const id of ['invites-pending-fold', 'invite-pending-row']) {
            const el = host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
            expect(el, id).toBeTruthy();
            await act(async () => { el!.click(); });
            await settle();
        }
        await tap(t('📤 Share Invite'));
        sentTheTextOnly('INV-ROW-0001');
    });

    it('still shows the invite\'s QR on the screen, for someone beside you to scan', async () => {
        await generate();
        const qr = host.querySelector('[data-testid="qr"]');
        expect(qr).toBeTruthy();
        expect(qr!.getAttribute('data-value')).toBe(LINK);
    });
});
