// @vitest-environment jsdom
/**
 * Slice N2a (DESIGN-notify-and-backup-asks-fable-amend2.md §12.3) in app/chat/[id].tsx, rendered for real (the harness of
 * dm-requests-chat-render.test.ts: React Native's host components as plain tags, utils/db as the net-spy stand-in), with
 * the phone's notifications answered here and this phone's record in its storage.
 *
 * The named line: "Hear when Kofi answers." under my first message sent, "Hear when Kofi writes again." under their line
 * read here or a request accepted, "Hear when Kofi says yes." after a request on their listing (handed over by the listing,
 * it waits for a line to hang under). Tell me brings the phone's pop-up; allowed, the line says so; refused, it goes. Never
 * after the phone's no, never where notifications are allowed, never two soft asks in a day, and never the old pop-up.
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

const alerts = vi.hoisted(() => ({ said: [] as string[], opened: [] as string[] }));
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
        Linking: { openURL: async (url: string) => { alerts.opened.push(url); }, openSettings: async () => {} },
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
/** The phone's own answer to "may BeanPool notify?", and what its pop-up answers when Tell me brings it. */
const phone = vi.hoisted(() => ({ status: 'undetermined', canAskAgain: true, answer: 'granted', asked: 0 }));
vi.mock('expo-notifications', () => {
    const mod = {
        getPermissionsAsync: async () => ({ status: phone.status, canAskAgain: phone.canAskAgain }),
        requestPermissionsAsync: async () => { phone.asked += 1; phone.status = phone.answer; return { status: phone.answer }; },
    };
    return { default: mod, ...mod };
});
vi.mock('../../services/push-notifications', () => ({ registerForPushNotifications: async () => null }));
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
vi.mock('../blocklist', () => ({ isUserBlocked: async () => false, getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
// Which screen /chat/:id draws is utils/chat-route's call (tested there); here the test names it.
const route = vi.hoisted(() => ({ now: { view: 'dm', screenId: 'dm1' } as { view: string; screenId: string } }));
vi.mock('../chat-route', () => ({ routeChat: async () => route.now }));
// The move a chat that doesn't open in place offers (utils/push-notice-switch.ts openNoticeIn): recorded, nothing switches.
const moveTo = vi.hoisted(() => ({ run: null as null | ((...a: unknown[]) => Promise<unknown>) }));
vi.mock('../push-notice-switch', async (orig) => ({ ...(await orig<Record<string, unknown>>()), openNoticeIn: (...a: unknown[]) => moveTo.run?.(...a) ?? Promise.resolve('held') }));
// The group's key code (group-chat-keys.ts) is off the words layer; the screen's keyring answers "never held".
vi.mock('../group-chat-keys', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), groupKeysLookUnopenable: () => false }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));


import { localDay, setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import ChatRoute from '../../app/chat/[id]';
import { NOTIFICATION_PERMISSION_STORE_KEY } from '../storage-keys';
import { chatMoment, noteNotifyMoment } from '../../components/NotifyLine';

const NODE = 'https://mullum.example';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const KOFI_REQUEST = { state: 'pending', from: 'kofi-key', at: iso(now - 120_000) };
const KOFI_DM = { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', createdBy: ME.publicKey };

/** What the stand-in answers, by name; a name left out, or answered `undefined`, never settles (a node with no answer). */
type Answers = Record<string, unknown>;
function standIn(over: Answers): void {
    const answers: Answers = {
        getConversation: null, getMessages: [], getDealsBetween: [], getDmKeyChange: null, getDmKeyCodeInfo: null, getKnownChatMute: null,
        markConversationRead: undefined,
        getDb: { getAllAsync: async () => [], getFirstAsync: async () => null, runAsync: async () => ({}) },
        // The route's check before a chat opens in place (#3305 review F1): that community's copy holds it as a DM. A row
        // about another id says otherwise; the check's read-only handle then closes.
        heldChatIsDm: true, closeHeldCopies: undefined,
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
    composer.type = null;
    composer.send = null;
    events.on = {};
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'global', features: {}, checkedAt: new Date().toISOString() } }));
    route.now = { view: 'dm', screenId: 'dm1' };
    Object.assign(phone, { status: 'undetermined', canAskAgain: true, answer: 'granted', asked: 0 });
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
// By the label's own value: jsdom's selectors miss a label holding an emoji ("React with 👍").
const button = (label: string) => Array.from(host.querySelectorAll<HTMLElement>('button[aria-label]')).find((b) => b.getAttribute('aria-label') === label) ?? null;
async function tap(label: string): Promise<void> {
    const b = button(label);
    expect(b, `a "${label}" button`).toBeTruthy();
    await act(async () => { b!.click(); });
    await settle();
}

const line = (testId: string) => host.querySelector(`[data-testid="${testId}"]`);
/** The text of the bubble straight above an element: what the line hangs under. */
const above = (el: Element | null) => el?.parentElement?.previousElementSibling?.textContent ?? el?.previousElementSibling?.textContent ?? '';
const mine = (id: string, text: string, age: number) => ({ id, senderId: ME.publicKey, authorPubkey: ME.publicKey, text, type: 'text', outgoing: true, rawTimestamp: iso(now - age), timestamp: '' });
const theirs = (id: string, text: string, age: number) => ({ id, senderId: 'kofi-key', authorPubkey: 'kofi-key', text, type: 'text', rawTimestamp: iso(now - age), timestamp: '' });
/** A DM whose lines change as the member sends: insertMessage adds the line getMessages reads back. */
function dm(lines: unknown[], over: Answers = {}): void {
    const held = [...lines];
    standIn({
        getConversation: KOFI_DM,
        getMessages: () => Promise.resolve([...held]),
        insertMessage: (_id: unknown, author: unknown, text: unknown) => {
            held.push({ ...mine('m-new', String(text), 0), senderId: author, authorPubkey: author });
            return Promise.resolve('m-new');
        },
        syncSingleConversation: true,
        ...over,
    });
}
const record = () => JSON.parse(store.map.get(NOTIFICATION_PERMISSION_STORE_KEY) ?? 'null');
/** Nothing of the old pop-up, nor the phone's own, came by itself. */
function askedNothing(): void {
    expect(alerts.said).not.toContain('Turn on notifications?');
    expect(alerts.said).toEqual([]);
    expect(phone.asked).toBe(0);
}

describe('the named line in a chat (slice N2a)', () => {
    it('my first message sent: "Hear when Kofi answers." under it; Tell me brings the phone\'s pop-up, and allowed it says so', async () => {
        dm([mine('m1', 'Morning', 3_600_000)]);
        await open();
        expect(line('notify-line')).toBeNull();
        await typeAndSend('Is the ladder free?');
        const shown = line('notify-line');
        expect(shown?.textContent).toContain('Hear when Kofi answers.');
        expect(above(shown)).toContain('Is the ladder free?');
        askedNothing();
        expect(record()).toMatchObject({ lines: ['answer'], askKind: 'line' });

        await tap('Tell me');
        expect(phone.asked).toBe(1);
        expect(line('notify-line')).toBeNull();
        expect(line('notify-line-done')?.textContent).toContain("You'll hear when Kofi answers.");
        expect(alerts.said).toEqual([]);
    });

    it('Tell me, and the phone says no: the line goes without a word, and the phone\'s no is kept', async () => {
        phone.answer = 'denied';
        dm([mine('m1', 'Morning', 3_600_000)]);
        await open();
        await typeAndSend('Is the ladder free?');
        await tap('Tell me');
        expect(phone.asked).toBe(1);
        expect(line('notify-line')).toBeNull();
        expect(line('notify-line-done')).toBeNull();
        expect(alerts.said).toEqual([]);
        expect(record()).toMatchObject({ phoneNoAt: expect.any(Number) });
    });

    it('their line read here: "Hear when Kofi writes again." under it', async () => {
        dm([mine('m1', 'Morning', 7_200_000), theirs('k1', 'Yes, come by at five', 3_600_000)]);
        await open();
        const shown = line('notify-line');
        expect(shown?.textContent).toContain('Hear when Kofi writes again.');
        expect(above(shown)).toContain('Yes, come by at five');
        askedNothing();
    });

    it('a request accepted: "Hear when Kofi writes again." under their line, never before Accept', async () => {
        let conv: Record<string, unknown> = { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST };
        standIn({
            getConversation: () => Promise.resolve(conv),
            getMessages: [theirs('k1', 'hello Ana', 60_000)],
            syncSingleConversation: true,
            decideMessageRequest: () => { conv = { ...conv, request: { ...KOFI_REQUEST, state: 'accepted' } }; return Promise.resolve({ request: conv.request }); },
        });
        await open();
        expect(host.textContent).toContain('Kofi wants to message you');
        expect(line('notify-line')).toBeNull();
        await tap('Accept');
        const shown = line('notify-line');
        expect(shown?.textContent).toContain('Hear when Kofi writes again.');
        expect(above(shown)).toContain('hello Ana');
        askedNothing();
    });

    it('a request on their listing opened the chat: "Hear when Kofi says yes." under my first line there, not "answers"', async () => {
        noteNotifyMoment(chatMoment('dm1'), { kind: 'offer', name: 'Kofi' });
        dm([]);
        await open();
        expect(line('notify-line')).toBeNull();
        await typeAndSend('I can do Saturday');
        const shown = line('notify-line');
        expect(shown?.textContent).toContain('Hear when Kofi says yes.');
        expect(host.textContent).not.toContain('Hear when Kofi answers.');
        expect(above(shown)).toContain('I can do Saturday');
        expect(record()).toMatchObject({ lines: ['offer'] });
        askedNothing();
    });

    for (const [state, setUp] of [
        ["the phone said no (an iPhone's Don't Allow)", () => { phone.status = 'denied'; phone.canAskAgain = false; }],
        ["the phone said no (Android's first, recorded)", () => { phone.status = 'denied'; store.map.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify({ state: 'unanswered', updatedAt: 0, phoneNoAt: now - 86_400_000 })); }],
        ['allowed (Android 8 to 12, or turned on before)', () => { phone.status = 'granted'; }],
        ['another soft ask took today', () => { store.map.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify({ state: 'unanswered', updatedAt: 0, askDay: localDay(new Date(now)), askKind: 'once', onceAt: now - 60_000 })); }],
    ] as const) {
        it(`${state}: no line on their line read, none under my message sent, and nothing asked`, async () => {
            (setUp as () => void)();
            dm([theirs('k1', 'Yes, come by at five', 3_600_000)]);
            await open();
            expect(line('notify-line')).toBeNull();
            await typeAndSend('Great, see you');
            expect(line('notify-line')).toBeNull();
            askedNothing();
        });
    }
});
