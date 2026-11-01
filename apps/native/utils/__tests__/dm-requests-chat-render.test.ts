// @vitest-environment jsdom
/**
 * A message request in app/chat/[id].tsx, rendered for real (the harness of conversation-words-render.test.ts: React
 * Native's host components as plain tags, utils/db as the net-spy stand-in, which records every call).
 *
 * PR #2540 review 4393642129: in `to-me` the phone fetched and showed the stranger's photo before Accept (ChatImage calls
 * getDecryptedAttachment on mount). Review 4393642152: the recipient had a live composer before the node's lines arrived
 * (a local read, or no row yet), and a line sent then accepts the request. Review 4393642166: the opener's screen read
 * "Sent as a request" before the node had taken the line. Review 4395541944: a refused Accept or Ignore said only "That did
 * not go through. Please try again.", even for a request its opener had cancelled, and kept the member on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The shipped pictures' requires (utils/bundled-avatars.ts, through MemberAvatar and the picture sheet) load as a number.
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
});
import Module from 'node:module';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
/** The composer's box and Send, and the screen's DeviceEventEmitter listeners, as the stand-ins below hand them over. */
const composer = vi.hoisted(() => ({ type: null as null | ((t: string) => void), send: null as null | (() => void) }));
const events = vi.hoisted(() => ({ on: {} as Record<string, Set<() => void>> }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', progressbar: 'progressbar' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, onLayout, value, onChangeText, disabled } = props;
        if (onChangeText && placeholder) composer.type = onChangeText;
        if (accessibilityLabel === 'Send message') composer.send = () => onPress?.();
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        const s = flat(props.style);
        if (s.flexWrap) attrs['data-wrap'] = s.flexWrap;
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
        ListHeaderComponent,
        (data ?? []).length
            ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
            : ListEmptyComponent,
        ListFooterComponent);
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList,
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string, buttons?: Array<{ text?: string }>) => { alerts.said.push(title); if (body) alerts.said.push(body); for (const b of buttons ?? []) if (b.text) alerts.said.push(b.text); } },
        Share: { share: async () => ({}) },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: {
            addListener: (name: string, fn: () => void) => { (events.on[name] ??= new Set()).add(fn); return { remove() { events.on[name]?.delete(fn); } }; },
            emit() {},
        },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useLocalSearchParams: () => params.now,
        Stack: { Screen: () => null },
        ErrorBoundary: () => null,
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
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-image-picker', () => ({ requestCameraPermissionsAsync: async () => ({ granted: false }), launchCameraAsync: async () => ({ canceled: true }), launchImageLibraryAsync: async () => ({ canceled: true }) }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: async () => ({}), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/', documentDirectory: '/tmp/doc/', getInfoAsync: async () => ({ exists: false }), deleteAsync: async () => {}, writeAsStringAsync: async () => {}, readAsStringAsync: async () => '', makeDirectoryAsync: async () => {} }));
vi.mock('expo-file-system', () => ({}));
vi.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, authenticateAsync: async () => ({ success: false }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
vi.mock('expo-linking', () => ({ createURL: (p: string) => `beanpool://${p}`, openURL: async () => {} }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: async () => ({}), maybeCompleteAuthSession: () => {} }));
vi.mock('expo-apple-authentication', () => ({}));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-notifications', () => ({}));
vi.mock('expo-device', () => ({}));
vi.mock('expo-location', () => ({ getForegroundPermissionsAsync: async () => ({ status: 'denied' }) }));
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...a: unknown[]) => void, ...a: unknown[]) => fn(...a) }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return {
        KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardController: { dismiss: async () => {}, setInputMode: () => {}, setDefaultMode: () => {} },
        AndroidSoftInputModes: {}, useKeyboardState: (pick?: (s: { isVisible: boolean; height: number }) => unknown) => (pick ? pick({ isVisible: false, height: 0 }) : { isVisible: false, height: 0 }),
        useKeyboardHandler: () => {},
    };
});
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});
const ME = { publicKey: 'me-key', privateKey: 'me-priv', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
const blocks = vi.hoisted(() => ({ made: [] as string[] }));
vi.mock('../blocklist', () => ({
    isUserBlocked: async () => false, getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated',
    blockUser: async (key: string) => { blocks.made.push(key); return true; },
}));
// Which screen /chat/:id draws is utils/chat-route's call (tested there); here the test names it.
const route = vi.hoisted(() => ({ now: { view: 'dm', screenId: 'dm1' } as { view: string; screenId: string } }));
vi.mock('../chat-route', () => ({ routeChat: async () => route.now }));
// The group's key code (group-chat-keys.ts) is off the words layer; the screen's keyring answers "never held".
vi.mock('../group-chat-keys', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), groupKeysLookUnopenable: () => false }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));


import { setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import ChatRoute from '../../app/chat/[id]';
import { router } from 'expo-router';

const NODE = 'https://mullum.example';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const KOFI_REQUEST = { state: 'pending', from: 'kofi-key', at: iso(now - 120_000) };

/** What the stand-in answers, by name; a name left out, or answered `undefined`, never settles (a node with no answer). */
type Answers = Record<string, unknown>;
function standIn(over: Answers): void {
    const answers: Answers = {
        getConversation: null, getMessages: [], getDealsBetween: [], getDmKeyChange: null, getKnownChatMute: null,
        markConversationRead: undefined,
        getDb: { getAllAsync: async () => [], getFirstAsync: async () => null, runAsync: async () => ({}) },
        ...over,
    };
    net.answer = (name, args) => {
        if (!(name in answers)) return undefined;
        const a = answers[name];
        if (typeof a === 'function') return (a as (...x: unknown[]) => Promise<unknown> | undefined)(...args);
        return a === undefined && name === 'syncSingleConversation' ? undefined : Promise.resolve(a);
    };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    alerts.said.length = 0;
    blocks.made.length = 0;
    composer.type = null;
    composer.send = null;
    events.on = {};
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'global', features: {}, checkedAt: new Date().toISOString() } }));
    route.now = { view: 'dm', screenId: 'dm1' };
    params.now = { id: 'dm1' };
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(): Promise<void> {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(ChatRoute)) as any); });
    await settle();
}
/** Types into the message box and presses Send, as a member would. */
async function typeAndSend(text: string): Promise<void> {
    if (composer.type) await act(async () => { composer.type!(text); });
    await settle(2);
    if (composer.send) await act(async () => { composer.send!(); });
    await settle();
}
/** The screen hears a sync (the delivery's end, a poll), as DeviceEventEmitter tells it on a phone. */
async function syncLanded(): Promise<void> {
    await act(async () => { for (const fn of events.on.sync_data_updated ?? []) fn(); });
    await settle();
}
const box = () => host.querySelector('input[placeholder="Message..."]');
const sent = () => net.calls.filter((c) => c === 'db.insertMessage').length;
const callsOf = (name: string) => net.calls.filter((c) => c === `db.${name}`).length;
// By the label's own value: jsdom's selectors miss a label holding an emoji ("React with 👍").
const button = (label: string) => Array.from(host.querySelectorAll<HTMLElement>('button[aria-label]')).find((b) => b.getAttribute('aria-label') === label) ?? null;
/** Taps a line's bubble (the unlabelled button holding its words), as a member would to see what it offers. */
async function tapLine(words: string): Promise<void> {
    const bubble = Array.from(host.querySelectorAll<HTMLElement>('button:not([aria-label])')).find((b) => b.textContent?.includes(words));
    expect(bubble, `a bubble reading "${words}"`).toBeTruthy();
    await act(async () => { bubble!.click(); });
    await settle(2);
}
async function tap(label: string): Promise<void> {
    const b = button(label);
    expect(b, `a "${label}" button`).toBeTruthy();
    await act(async () => { b!.click(); });
    await settle();
}

describe('a request waiting for this member, on the phone', () => {
    it('keeps a stranger\'s photo closed before Accept: nothing fetched, nothing drawn, the caption reads (review 4393642129)', async () => {
        standIn({
            getConversation: { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST },
            getMessages: [{ id: 'p1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'image', text: 'look at my ladder', rawTimestamp: iso(now - 60_000), timestamp: '' }],
            syncSingleConversation: true,
        });
        await open();

        expect(host.textContent).toContain('Kofi wants to message you');
        expect(net.calls).not.toContain('db.getDecryptedAttachment');
        expect(host.querySelector('img[aria-label="Photo message"]')).toBeNull();
        expect(host.querySelector('[data-testid="request-photo-closed"]')?.textContent).toContain('Photo: shown when you accept');
        expect(host.textContent).toContain('look at my ladder');
    });

    it('a request row and no lines here yet: the Accept card, no composer, until the node answers (review 4393642152, A)', async () => {
        standIn({
            getConversation: { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST },
            getMessages: [],
            syncSingleConversation: undefined,
        });
        await open();

        expect(host.textContent).toContain('Kofi wants to message you');
        expect(box()).toBeNull();
        await typeAndSend('hi there');
        expect(sent()).toBe(0);
    });

    it('no row yet (a push or a link): no send until the node answers (review 4393642152, B)', async () => {
        standIn({ getConversation: null, getMessages: [], syncSingleConversation: undefined });
        await open();

        expect(host.textContent).toContain('Loading the chat');
        await typeAndSend('hi there');
        expect(sent()).toBe(0);
    });

    // Review 4394827119: React and Reply on the stranger's line, with the Accept card on screen; the node took the reaction
    // and sent it to the opener, while the request still read waiting to them. The web offers neither while `inRequest`.
    it('offers no Reply or React on the stranger\'s line before Accept, so nothing reaches them; after Accept both are back', async () => {
        let conv = { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST as Record<string, unknown> };
        standIn({
            getConversation: () => Promise.resolve(conv),
            getMessages: [{ id: 'k1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: 'hello Ana', rawTimestamp: iso(now - 60_000), timestamp: '' }],
            syncSingleConversation: true,
            decideMessageRequest: () => { conv = { ...conv, request: { ...KOFI_REQUEST, state: 'accepted' } }; return Promise.resolve({ request: conv.request }); },
            toggleMessageReactionApi: {},
        });
        await open();
        expect(host.textContent).toContain('Kofi wants to message you');

        await tapLine('hello Ana');
        expect(button('React')).toBeNull();
        expect(button('Reply')).toBeNull();
        expect(host.querySelector('button[aria-label^="React with"]')).toBeNull();
        expect(callsOf('toggleMessageReactionApi')).toBe(0);

        await tap('Accept');
        expect(host.textContent).not.toContain('Kofi wants to message you');
        await tapLine('hello Ana');
        expect(button('Reply')).not.toBeNull();
        await tap('React');
        await tap('React with 👍');
        expect(callsOf('toggleMessageReactionApi')).toBe(1);
    });

    it('Accept, Decline, Report in place of the box, and a line has no Report of its own: the one on the bar blocks', async () => {
        standIn({
            getConversation: { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST },
            getMessages: [{ id: 'r1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: 'Buy my crypto', rawTimestamp: '2026-10-27T00:00:00.000Z', timestamp: '10:00' }],
            syncSingleConversation: true,
        });
        await open();
        for (const name of ['Accept', 'Decline', 'Report']) expect(Array.from(host.querySelectorAll('button')).some(b => b.textContent === name)).toBe(true);
        await tapLine('Buy my crypto');
        expect(Array.from(host.querySelectorAll('button')).some(b => b.textContent?.includes('Report message'))).toBe(false);
    });

    // The deciding review of #2705: with the tombstone left out, a bar that needs a line would be dead for good.
    it('a request whose line its sender deleted: the bar\'s Report blocks them, files no report, and says so', async () => {
        standIn({
            getConversation: { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST },
            getMessages: [{ id: 'r1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'removed', text: 'This message was deleted', metadata: { removed: true }, rawTimestamp: '2026-10-27T00:00:00.000Z', timestamp: '10:00' }],
            syncSingleConversation: true,
        });
        await open();
        await tap('Report');
        const reasonChip = Array.from(host.querySelectorAll<HTMLElement>('[data-modal] button')).find((b) => b.textContent === 'Spam or scam');
        await act(async () => { reasonChip!.click(); });
        await tap('Submit report');
        expect(callsOf('reportDmLine')).toBe(0);
        expect(blocks.made).toEqual(['kofi-key']);
        expect(alerts.said).toContain('That message was deleted, so no report went. They are blocked.');
    });

    it('a request with no line here and no word from the node: Report waits, for this phone can\'t yet tell deleted from not here yet', async () => {
        standIn({
            getConversation: { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST },
            getMessages: [],
            syncSingleConversation: false,
        });
        await open();
        await tap('Report');
        expect(host.querySelector('[data-modal]')).toBeNull();
        expect(blocks.made).toEqual([]);
    });

    describe('Accept or Ignore refused (review 4395541944)', () => {
        const refusal = (message: string, extra: Record<string, unknown>) => Object.assign(new Error(message), extra);
        const GONE = () => refusal('There is no message request for you in this chat.', { status: 404, code: 'request_not_found', nodeAnswered: true });
        async function kofiAsks(decide: () => Promise<unknown>): Promise<void> {
            standIn({
                getConversation: { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST },
                getMessages: [{ id: 'k1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: 'hello Ana', rawTimestamp: iso(now - 60_000), timestamp: '' }],
                syncSingleConversation: true,
                decideMessageRequest: decide,
            });
            await open();
            expect(host.textContent).toContain('Kofi wants to message you');
        }

        it('a request its opener cancelled: Accept goes back to Talk, as Ignore does, and says nothing', async () => {
            const navigate = vi.spyOn(router, 'navigate');
            await kofiAsks(() => Promise.reject(GONE()));
            await tap('Accept');
            expect(navigate).toHaveBeenCalledWith('/(tabs)/chats');
            expect(alerts.said).toEqual([]);
            navigate.mockRestore();
        });

        it('a request its opener cancelled: Ignore goes back to Talk too, and says nothing', async () => {
            const navigate = vi.spyOn(router, 'navigate');
            await kofiAsks(() => Promise.reject(GONE()));
            await tap('Decline');
            expect(navigate).toHaveBeenCalledWith('/(tabs)/chats');
            expect(alerts.said).toEqual([]);
            navigate.mockRestore();
        });

        it('the node refusing in its own words: those words, and the Accept card stays', async () => {
            const navigate = vi.spyOn(router, 'navigate');
            await kofiAsks(() => Promise.reject(refusal('This community is read-only for now.', { status: 503, code: 'standby', nodeAnswered: true })));
            await tap('Accept');
            expect(alerts.said).toEqual(['This community is read-only for now.']);
            expect(host.textContent).toContain('Kofi wants to message you');
            expect(navigate).not.toHaveBeenCalled();
            navigate.mockRestore();
        });

        it("a proxy's page (no JSON error), or no answer: the community out of reach, never the page's words", async () => {
            let answer: Error = refusal('Server returned 502', { status: 502, nodeAnswered: false });
            await kofiAsks(() => Promise.reject(answer));
            await tap('Accept');
            answer = new Error('Network request failed');
            await tap('Decline');
            expect(alerts.said).toEqual(['Connect to your community to accept or decline.', 'Connect to your community to accept or decline.']);
        });
    });

    it('after Cancel request, the person it was for cannot accept it, by Accept or by writing', async () => {
        // Marty, 28 Oct 2026 (PR #2540): the node's state is the authority. Kofi cancels while Ana has his request open: the
        // node's next answer has no line of his in it (the sync drops the withdrawn one) and still names his request, so the
        // chat stays a request for her, with no composer (a line of hers would accept it). Her Accept finds no request (404),
        // and the chat goes back to Talk.
        const navigate = vi.spyOn(router, 'navigate');
        let lines: unknown[] = [{ id: 'k1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: 'hello Ana', rawTimestamp: iso(now - 60_000), timestamp: '' }];
        standIn({
            getConversation: { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST },
            getMessages: () => Promise.resolve(lines),
            syncSingleConversation: true,
            decideMessageRequest: () => Promise.reject(Object.assign(new Error('There is no message request for you in this chat.'), { status: 404, code: 'request_not_found', nodeAnswered: true })),
            insertMessage: 'line-1',
        });
        await open();
        expect(host.textContent).toContain('hello Ana');

        lines = [];
        await syncLanded();
        expect(host.textContent).not.toContain('hello Ana');
        expect(host.textContent).toContain('Kofi wants to message you');
        expect(box()).toBeNull();
        await typeAndSend('hi Kofi');
        expect(sent()).toBe(0);

        await tap('Accept');
        expect(navigate).toHaveBeenCalledWith('/(tabs)/chats');
        expect(alerts.said).toEqual([]);
        expect(sent()).toBe(0);
        navigate.mockRestore();
    });

    it('control: once the node has answered an ordinary chat, the composer sends', async () => {
        standIn({ getConversation: { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: null }, getMessages: [], syncSingleConversation: true, insertMessage: 'line-1' });
        await open();

        expect(box()).not.toBeNull();
        await typeAndSend('hi there');
        expect(sent()).toBe(1);
    });
});

describe('an ordinary DM someone else opened, with no answer from the node (review 4394120110)', () => {
    const KOFIS = { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', createdBy: 'kofi-key', request: null };

    it("the node's list named it: the composer sends, offline too", async () => {
        standIn({ getConversation: { ...KOFIS, listed: 1 }, getMessages: [], syncSingleConversation: false, insertMessage: 'line-1' });
        await open();

        expect(host.textContent).not.toContain('Loading the chat');
        expect(box()).not.toBeNull();
        await typeAndSend('hi there');
        expect(sent()).toBe(1);
    });

    it('control: a row the list never named (a push, a link) still waits for the node', async () => {
        standIn({ getConversation: KOFIS, getMessages: [], syncSingleConversation: false, insertMessage: 'line-1' });
        await open();

        expect(host.textContent).toContain('Loading the chat');
        await typeAndSend('hi there');
        expect(sent()).toBe(0);
    });
});

describe("the opener's first line, on the phone", () => {
    const MINE = { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', createdBy: 'me-key', request: { state: 'pending', from: 'me-key', at: iso(now - 120_000), nextLineIsRequest: true } };
    const lineAs = (sendState?: string) => [{ id: 'line-1', senderId: 'me-key', authorPubkey: 'me-key', type: 'text', text: 'hello Kofi', outgoing: true, sendState, rawTimestamp: iso(now - 1_000), timestamp: '' }];

    it('reads "Sent as a request" only once the node has taken it; while it goes, nothing more is sent (review 4393642166)', async () => {
        let lines: unknown[] = [];
        standIn({ getConversation: MINE, getMessages: () => Promise.resolve(lines), syncSingleConversation: true, insertMessage: () => { lines = lineAs('sending'); return Promise.resolve('line-1'); } });
        await open();
        expect(host.textContent).toContain('Your first message goes to Kofi as a request.');

        await typeAndSend('hello Kofi');
        expect(sent()).toBe(1);
        expect(host.querySelector('[data-testid="request-waiting"]')).toBeNull();
        await typeAndSend('and another');
        expect(sent()).toBe(1);

        lines = lineAs(undefined);
        await syncLanded();
        expect(host.querySelector('[data-testid="request-waiting"]')).not.toBeNull();
    });

    // Review 4394827275: Edit was offered on the waiting request's line and drew the composer, but Send refused it (and the
    // box opened empty, its ref not yet mounted). The node and the web let the line edit; a new line still waits.
    describe('waiting for Kofi: my request\'s line still edits, and nothing new is sent', () => {
        const WAITING = { ...MINE, request: { ...MINE.request, nextLineIsRequest: false } };
        const mine = (text = 'hello Kofi') => [{ id: 'line-1', senderId: 'me-key', authorPubkey: 'me-key', type: 'text', text, outgoing: true, rawTimestamp: iso(now - 60_000), timestamp: '' }];
        let edits: unknown[][];
        beforeEach(() => {
            edits = [];
            standIn({
                getConversation: WAITING, getMessages: () => Promise.resolve(mine()), syncSingleConversation: true,
                editMessage: (...args: unknown[]) => { edits.push(args); return Promise.resolve(); },
                insertMessage: 'line-2',
            });
        });

        it('Edit opens the box holding the line\'s words, and Send edits it', async () => {
            await open();
            expect(host.querySelector('[data-testid="request-waiting"]')).not.toBeNull();
            expect(box()).toBeNull();

            await tapLine('hello Kofi');
            expect(button('React')).toBeNull();
            expect(button('Reply')).toBeNull();
            await tap('Edit message');
            expect(host.querySelector('[data-testid="request-waiting"]')).toBeNull();
            expect(box()).not.toBeNull();
            // Untouched, the box sends what it was filled with: the line's own words.
            await act(async () => { composer.send!(); });
            await settle();

            expect(edits).toEqual([['dm1', 'line-1', 'hello Kofi']]);
            expect(sent()).toBe(0);
            expect(host.querySelector('[data-testid="request-waiting"]')).not.toBeNull();
            expect(box()).toBeNull();
        });

        it('a changed line is sent as the edit, never as a new line', async () => {
            await open();
            await tapLine('hello Kofi');
            await tap('Edit message');
            await typeAndSend('hello Kofi, it is Ana');

            expect(edits).toEqual([['dm1', 'line-1', 'hello Kofi, it is Ana']]);
            expect(sent()).toBe(0);
        });
    });

    it('refused or never delivered: the composer stays, unsent, and the line says it did not go', async () => {
        let lines: unknown[] = [];
        standIn({ getConversation: MINE, getMessages: () => Promise.resolve(lines), syncSingleConversation: true, insertMessage: () => { lines = lineAs('sending'); return Promise.resolve('line-1'); } });
        await open();
        await typeAndSend('hello Kofi');

        lines = lineAs('failed');
        await syncLanded();
        expect(host.querySelector('[data-testid="request-waiting"]')).toBeNull();
        expect(box()).not.toBeNull();
        expect(host.textContent).toContain('Your first message goes to Kofi as a request.');
        expect(host.textContent).toContain('! not delivered');
    });
});

describe('a member who reached out while blocked, on the phone (Marty, 28 Oct 2026, PR #2540: "B: shows as accepted")', () => {
    it('a blocked member who reached out sees their request accepted when the blocker writes; nothing tells them they are blocked', async () => {
        // Kofi cancelled his request to Ana and blocked her; Ana wrote (her own request, kept for her alone, which she reads as
        // hers, waiting). Then Kofi writes: the node answers her as it answers a member nobody blocked (test-dm-request-cancel
        // step 11): her own request accepted, at the time she reached out, and his line an ordinary one. The screen shows that
        // and nothing else: his line, the composer back, and no word of waiting, a request or a block.
        const at = iso(now - 120_000);
        let request: Record<string, unknown> = { state: 'pending', from: 'me-key', at, nextLineIsRequest: false };
        const hers = { id: 'a1', senderId: 'me-key', authorPubkey: 'me-key', type: 'text', text: 'are you still there?', outgoing: true, rawTimestamp: iso(now - 110_000), timestamp: '' };
        let lines: unknown[] = [hers];
        standIn({
            getConversation: () => Promise.resolve({ name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', createdBy: 'kofi-key', request }),
            getMessages: () => Promise.resolve(lines),
            syncSingleConversation: true,
            insertMessage: 'line-2',
        });
        await open();
        expect(host.querySelector('[data-testid="request-waiting"]')).not.toBeNull();
        expect(box()).toBeNull();

        request = { state: 'accepted', from: 'me-key', at };
        lines = [hers, { id: 'k1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: 'sorry, yes', rawTimestamp: iso(now - 5_000), timestamp: '' }];
        await syncLanded();
        expect(host.textContent).toContain('sorry, yes');
        expect(host.querySelector('[data-testid="request-waiting"]')).toBeNull();
        expect(host.textContent).not.toContain('wants to message you');
        expect(host.textContent).not.toContain('as a request');
        expect(host.textContent).not.toMatch(/blocked|ignored/i);
        expect(box()).not.toBeNull();
        await typeAndSend('glad to hear it');
        expect(sent()).toBe(1);
    });
});
