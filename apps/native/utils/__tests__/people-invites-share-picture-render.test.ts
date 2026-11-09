// @vitest-environment jsdom
/**
 * People → Invites: Share sends the QR picture with the invite message (Damo, 9 Nov). The whole of app/(tabs)/people.tsx is
 * rendered for real (the mount of people-invites-no-vouch-render.test.ts) on a local community; the off-screen card that is
 * captured and every phone module are stand-ins that record what they were given. What each share dialog shows is looked at
 * on the emulator (the PR); the logic under it is invite-picture-share.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const phone = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'android',
    shares: [] as Array<{ message: string; url?: string }>,
    toasts: [] as string[],
    copied: [] as string[],
    sharedFiles: [] as Array<{ uri: string; options: unknown }>,
    moves: [] as Array<{ from: string; to: string }>,
    shots: [] as Array<{ code: string; value: string }>,
    // What the off-screen card hands back: a file address, null (it could not be made), or held until the test lets it go.
    capture: { mode: 'file' as 'file' | 'null' | 'held', release: null as null | ((uri: string | null) => void) },
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
        Share: { share: async (content: { message: string; url?: string }) => { phone.shares.push(content); return {}; } },
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
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async (text: string) => { phone.copied.push(text); } }));
vi.mock('expo-sharing', () => ({
    isAvailableAsync: async () => true,
    shareAsync: async (uri: string, options: unknown) => { phone.sharedFiles.push({ uri, options }); },
}));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///cache/',
    deleteAsync: async () => {},
    moveAsync: async (o: { from: string; to: string }) => { phone.moves.push(o); },
}));
// The off-screen card: it is drawn and captured on a phone (components/InvitePictureShot.tsx); here it answers as set.
vi.mock('../../components/InvitePictureShot', () => ({
    InvitePictureShot: ({ code, value, onCaptured }: { code: string; value: string; onCaptured: (uri: string | null) => void }) => {
        useEffect(() => {
            phone.shots.push({ code, value });
            if (phone.capture.mode === 'held') { phone.capture.release = onCaptured; return; }
            onCaptured(phone.capture.mode === 'null' ? null : `file:///tmp/capture-${code}.png`);
        }, []);
        return createElement('span', { 'data-testid': 'picture-shot' });
    },
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
import { t } from '@beanpool/core';

const NODE = 'https://node.example';
const LOCAL = { beans: true, invites: true, showcase: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
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
    phone.moves.length = 0;
    phone.shots.length = 0;
    phone.capture.mode = 'file';
    phone.capture.release = null;
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
const NAMED = 'file:///cache/beanpool-invite-INV-TEST-0001.png';

describe('People → Invites: Share sends the QR picture with the message', () => {
    it('on iOS: one share sheet with the message and the picture, named for the code', async () => {
        await generateAndShare();

        expect(phone.shots).toEqual([{ code: 'INV-TEST-0001', value: LINK }]);
        expect(phone.moves).toEqual([{ from: 'file:///tmp/capture-INV-TEST-0001.png', to: NAMED }]);
        expect(phone.shares).toHaveLength(1);
        expect(phone.shares[0].url).toBe(NAMED);
        expect(phone.shares[0].message).toContain('Mullum');
        expect(phone.shares[0].message).toContain(LINK);
        expect(phone.shares[0].message).toContain('INV-TEST-0001');
        expect(phone.sharedFiles).toEqual([]);
        expect(phone.copied).toEqual([]);
    });

    it('on Android: the picture in the dialog, the message on the clipboard and said so, and no message-only share', async () => {
        phone.os = 'android';
        await generateAndShare();

        expect(phone.sharedFiles).toEqual([{ uri: NAMED, options: { mimeType: 'image/png', dialogTitle: 'Join me on BeanPool' } }]);
        expect(phone.copied).toHaveLength(1);
        expect(phone.copied[0]).toContain(LINK);
        expect(phone.toasts).toEqual(['Invite message copied. Paste it with the picture.']);
        expect(phone.shares).toEqual([]);
    });

    it('shares the message alone, as before, where the picture could not be made', async () => {
        phone.capture.mode = 'null';
        await generateAndShare();

        expect(phone.shares).toHaveLength(1);
        expect(phone.shares[0].url).toBeUndefined();
        expect(phone.shares[0].message).toContain(LINK);
        expect(phone.moves).toEqual([]);
    });

    it('shares the message alone when the picture is never made, after waiting a few seconds, not for ever', async () => {
        phone.capture.mode = 'held';
        await generate();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            await act(async () => { buttonWith(t('📤 Share Invite'))!.click(); });
            expect(phone.shares).toEqual([]);
            await act(async () => { await vi.advanceTimersByTimeAsync(3900); });
            expect(phone.shares).toEqual([]);
            await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        } finally {
            vi.useRealTimers();
        }
        await settle();
        expect(phone.shares).toHaveLength(1);
        expect(phone.shares[0].url).toBeUndefined();
        expect(phone.shares[0].message).toContain(LINK);
    });

    it('a second tap while the first is still making its picture starts nothing', async () => {
        phone.capture.mode = 'held';
        await generateAndShare();
        await tap(t('📤 Share Invite'));
        expect(phone.shots).toHaveLength(1);

        await act(async () => { phone.capture.release!('file:///tmp/held.png'); });
        await settle();
        expect(phone.shares).toHaveLength(1);
        expect(phone.shares[0].url).toBe(NAMED);
    });

    it('takes the picture away once the share is on its way', async () => {
        await generateAndShare();
        expect(host.querySelector('[data-testid="picture-shot"]')).toBeNull();
    });
});
