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
import * as fs from 'node:fs';
import * as path from 'node:path';
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
const blocks = vi.hoisted(() => ({ made: [] as string[], reports: [] as unknown[][] }));
vi.mock('../blocklist', () => ({
    isUserBlocked: async () => false, getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated',
    blockUser: async (key: string, ...report: unknown[]) => { blocks.made.push(key); blocks.reports.push(report); return true; },
}));
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


import { setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import ChatRoute from '../../app/chat/[id]';
import { router } from 'expo-router';
import { PUSH_RECEIVED_EVENT } from '../app-events';

const NODE = 'https://mullum.example';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const KOFI_REQUEST = { state: 'pending', from: 'kofi-key', at: iso(now - 120_000) };

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
    blocks.made.length = 0;
    blocks.reports.length = 0;
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
/** The phone keeps `url` as a community it is a member of, under the name it saved (Chat's held rows, a contact there). */
function holdsCommunity(url: string, name: string): void {
    store.map.set('beanpool_saved_nodes', JSON.stringify([{ url: NODE }, { url, name }]));
}
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
        // Copy (9 Nov) is the one thing a tap on the stranger's line now offers: it sends nothing to anyone.
        expect(button('Copy message')).not.toBeNull();

        await tap('Accept');
        expect(host.textContent).not.toContain('Kofi wants to message you');
        // The line's bar stayed open, so there is no second tap (it would close it): it now has Reply and React as well.
        expect(button('Reply')).not.toBeNull();
        await tap('React');
        await tap('React with 👍');
        expect(callsOf('toggleMessageReactionApi')).toBe(1);
    });

    // R1 (Marty, 1 Nov 2026): a request's link is a stranger's, and the last thing a spammer wants is for it to work.
    it('a link in a request reads as its words and opens nothing; once it is accepted it opens', async () => {
        const url = 'https://spam.example/win';
        const linkOf = () => Array.from(host.querySelectorAll<HTMLElement>('*')).find(e => e.textContent === url && e.children.length === 0) ?? null;
        let conv = { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST as Record<string, unknown> };
        standIn({
            getConversation: () => Promise.resolve(conv),
            getMessages: [{ id: 'k1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: `Free money at ${url}`, rawTimestamp: iso(now - 60_000), timestamp: '' }],
            syncSingleConversation: true,
            decideMessageRequest: () => { conv = { ...conv, request: { ...KOFI_REQUEST, state: 'accepted' } }; return Promise.resolve({ request: conv.request }); },
        });
        alerts.opened.length = 0;
        await open();
        expect(host.textContent).toContain(`Free money at ${url}`);
        expect(linkOf()).toBeNull();
        await tap('Accept');
        await act(async () => { linkOf()?.click(); });
        expect(alerts.opened).toEqual([url]);
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
    it('a request whose line its sender deleted: the bar\'s Report blocks them, reports the person in this account\'s name, and says so', async () => {
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
        expect(blocks.reports).toEqual([[ME.publicKey, 'Spam or scam']]);
        expect(alerts.said).toContain('That message was deleted, so your report of them goes without its words. They are blocked.');
    });

    // The deciding review of #2705: a lapsed request's line stays in the chat, and the opener's next line is a new request.
    describe('the bar\'s Report stops at the request\'s start', () => {
        const lapsed = { id: 'lapsed', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: 'From last time', rawTimestamp: iso(now - 40 * 86_400_000), timestamp: '' };
        const reportWith = async (lines: unknown[]) => {
            standIn({ getConversation: { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST }, getMessages: lines, syncSingleConversation: true, reportDmLine: { success: true } });
            await open();
            await tap('Report');
            const reasonChip = Array.from(host.querySelectorAll<HTMLElement>('[data-modal] button')).find((b) => b.textContent === 'Spam or scam');
            await act(async () => { reasonChip!.click(); });
            await tap('Submit report');
        };

        it('reports the line of this request', async () => {
            await reportWith([lapsed, { id: 'k1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: 'hello Ana', rawTimestamp: iso(now - 60_000), timestamp: '' }]);
            expect(callsOf('reportDmLine')).toBe(1);
            expect(blocks.made).toEqual(['kofi-key']);
            expect(blocks.reports).toEqual([[]]); // the line's report went: the block adds no second one
        });

        it('with that line deleted, never the lapsed one: it blocks, reports the person, and says so, as the web does', async () => {
            await reportWith([lapsed, { id: 'k1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'removed', text: 'This message was deleted', metadata: { removed: true }, rawTimestamp: iso(now - 60_000), timestamp: '' }]);
            expect(callsOf('reportDmLine')).toBe(0);
            expect(blocks.made).toEqual(['kofi-key']);
            expect(blocks.reports).toEqual([[ME.publicKey, 'Spam or scam']]);
            expect(alerts.said).toContain('That message was deleted, so your report of them goes without its words. They are blocked.');
        });
    });

    // #3309 review N4 C2: S3 lets a request in place be reported from its chat. Every part goes to the chat's own community by
    // name: without it the line would be looked for in the community in use's copy, and the person's report (with the
    // member's reason) would go to that community's moderators.
    it('in place (S3): Report on a request reports its line to the chat\'s own community and blocks them there, never the community in use', async () => {
        const RIVER = 'https://riverside.example';
        params.now = { id: 'dm1', community: RIVER, communityName: 'Riverside' };
        holdsCommunity(RIVER, 'Riverside');
        const reported: unknown[][] = [];
        standIn({
            getConversation: { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: KOFI_REQUEST },
            getMessages: [{ id: 'k1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: 'hello Ana', rawTimestamp: iso(now - 60_000), timestamp: '' }],
            syncSingleConversation: true,
            enterChatInPlace: () => undefined, leaveChatInPlace: () => undefined,
            reportDmLine: (...a: unknown[]) => { reported.push(a); return Promise.resolve({ success: true }); },
        });
        await open();
        await tap('Report');
        const reasonChip = Array.from(host.querySelectorAll<HTMLElement>('[data-modal] button')).find((b) => b.textContent === 'Spam or scam');
        await act(async () => { reasonChip!.click(); });
        await tap('Submit report');
        expect(reported).toEqual([['dm1', 'k1', 'hello Ana', 'Spam or scam', RIVER]]);
        expect(blocks.made).toEqual(['kofi-key']);
        // The line's report went, so the block adds no report of its own; it goes to that community, named.
        expect(blocks.reports).toEqual([[undefined, undefined, undefined, RIVER]]);
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
            // The node's words are the message, under a short title (Android cuts a title at two lines: alert-words-in-message.test.ts).
            expect(alerts.said).toEqual(['Message requests', 'This community is read-only for now.']);
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
            expect(alerts.said).toEqual(['Message requests', 'Connect to your community to accept or decline.', 'Message requests', 'Connect to your community to accept or decline.']);
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

            // The fourth: the chat's community, none named for the community in use (slice S2).
            expect(edits).toEqual([['dm1', 'line-1', 'hello Kofi', undefined]]);
            expect(sent()).toBe(0);
            expect(host.querySelector('[data-testid="request-waiting"]')).not.toBeNull();
            expect(box()).toBeNull();
        });

        it('a changed line is sent as the edit, never as a new line', async () => {
            await open();
            await tapLine('hello Kofi');
            await tap('Edit message');
            await typeAndSend('hello Kofi, it is Ana');

            expect(edits).toEqual([['dm1', 'line-1', 'hello Kofi, it is Ana', undefined]]);
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

    // R1 (engine/request-limits.ts): reports cleared this member's requests; the node's 403 `dm_requests_limited` ends as a
    // failed line whose tap says why. The phone words that sentence itself (core requests-cleared-words.ts), date kept.
    describe('reports cleared their requests: the failed line says so in the member\'s language', () => {
        const LIMITED = "People you wrote to reported your message requests, so they were cleared and you can't send new ones until 2026-11-08. You can still answer people who wrote to you, and post.";
        const failedWith = (error: string) => [{ ...lineAs('failed')[0], metadata: { __sendError: error } }];
        const WORDS_DIR = path.resolve(__dirname, '../../../../packages/beanpool-core/words');

        async function failedLine(): Promise<void> {
            standIn({ getConversation: MINE, getMessages: () => Promise.resolve(failedWith(LIMITED)), syncSingleConversation: true });
            await open();
        }

        it('English: the node\'s sentence, word for word, with the date', async () => {
            await failedLine();
            await tapLine('hello Kofi');
            expect(alerts.said).toContain(LIMITED);
        });

        it('Spanish: the same rule in Spanish, still a "no puedes" and still dated', async () => {
            await failedLine();
            setLanguage('es', [JSON.parse(fs.readFileSync(path.join(WORDS_DIR, 'es.json'), 'utf8'))]);
            await tapLine('hello Kofi');
            const said = alerts.said.find((s) => s.includes('2026-11-08'));
            expect(said).toBe('Personas a las que escribiste denunciaron tus solicitudes de mensaje, así que se borraron y no puedes enviar nuevas hasta el 2026-11-08. Todavía puedes responder a quienes te escribieron y publicar.');
            expect(alerts.said).not.toContain(LIMITED);
        });

        it('another failure\'s words are shown exactly as the node gave them', async () => {
            standIn({ getConversation: MINE, getMessages: () => Promise.resolve(failedWith('This community is read-only for now.')), syncSingleConversation: true });
            await open();
            setLanguage('es', [JSON.parse(fs.readFileSync(path.join(WORDS_DIR, 'es.json'), 'utf8'))]);
            await tapLine('hello Kofi');
            expect(alerts.said).toContain('This community is read-only for now.');
        });
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

// Old chat's photos (conversion code, log row OLDCHAT, remove after 12 Dec 2026): the chat screen asks for an old line's photo
// as old, so it opens as part of its words (db.ts getDecryptedAttachment's oldLine; tested on the frozen 1.2.36 photo in
// dm-line-binding.test.ts), and a new line's as new, as before.
describe('old chat on the phone\'s chat screen', () => {
    it('an old line\'s photo is asked for as old, a new line\'s as new', async () => {
        const asked: unknown[][] = [];
        standIn({
            getConversation: { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm' },
            getMessages: [
                { id: 'o1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'image', text: 'the old ladder', oldLine: true, rawTimestamp: '2026-11-05T09:00:00.000Z', timestamp: '' },
                { id: 'n1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'image', text: 'the new ladder', rawTimestamp: iso(now - 60_000), timestamp: '' },
            ],
            syncSingleConversation: true,
            getDecryptedAttachment: (...args: unknown[]) => { asked.push(args); return Promise.resolve(null); },
        });
        await open();
        expect(host.textContent).toContain('the old ladder');
        // The fourth: the chat's community, none named for the community in use (slice S2).
        expect(asked).toEqual(expect.arrayContaining([['dm1', 'o1', true, undefined], ['dm1', 'n1', false, undefined]]));
        expect(asked).toHaveLength(2);
        // Neither opened here (the stand-in answers null): each keeps the locked bubble.
        expect(host.textContent?.match(/Image unavailable/g)).toHaveLength(2);
    });
});

describe('a chat in place, left while its poll, a push or a read is on its way (slice S2, #3305 review)', () => {
    const RIVER = 'https://riverside.example';
    const KOFI_THERE = { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: null, listed: 1 };
    /** Calls held until the test answers them, as a node still answering does. */
    const heldCalls: Array<(v: unknown) => void> = [];
    const later = () => new Promise((resolve) => { heldCalls.push(resolve); });
    /** Each hold and let-go of the chat in place, by the community the screen named. */
    const placeLog: string[] = [];
    const callsSince = (n: number) => net.calls.slice(n).filter((c) => c !== 'db.getKnownChatMute');
    const leave = async () => { await act(async () => { root.unmount(); }); };

    async function openInPlace(over: Answers): Promise<void> {
        heldCalls.length = 0;
        placeLog.length = 0;
        params.now = { id: 'dm1', community: RIVER, communityName: 'Riverside' };
        holdsCommunity(RIVER, 'Riverside');
        standIn({
            getConversation: KOFI_THERE, getMessages: [], markConversationRead: true,
            enterChatInPlace: (c: unknown) => { placeLog.push(`enter ${String(c)}`); return undefined; },
            leaveChatInPlace: (c: unknown) => { placeLog.push(`leave ${String(c)}`); return undefined; },
            ...over,
        });
        await open();
        // Held before the first read, by the chat's own community, once: the peer's key read runs the focus effect again only
        // for an ordinary chat, so the copy is never let go and held again under its first poll (#3305 review).
        expect(net.calls.indexOf('db.enterChatInPlace')).toBeLessThan(net.calls.indexOf('db.getConversation'));
        expect(placeLog).toEqual([`enter ${RIVER}`]);
    }
    /** As many let-goes as holds: none left behind once the chat is left. */
    const balanced = () => placeLog.filter((x) => x.startsWith('enter')).length === placeLog.filter((x) => x.startsWith('leave')).length;

    it('opening, its first poll on its way as the peer\'s key is read: held once, never let go while it shows, and that poll\'s line shows', async () => {
        const LINE = { id: 'k1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: 'the newest line', rawTimestamp: iso(now), timestamp: '' };
        let polled = false;
        await openInPlace({ syncSingleConversation: later, getMessages: () => Promise.resolve(polled ? [LINE] : []) });
        // The peer's key is read (getConversation answered it) and the chat still holds its copy, from one hold.
        expect(host.textContent).toContain('Kofi');
        expect(callsOf('syncSingleConversation'), 'one first poll, not a second one deduped onto the first').toBe(1);
        expect(heldCalls).toHaveLength(1);
        const before = net.calls.length;
        polled = true;
        heldCalls[0](true);
        await settle();
        // The first poll's answer is followed up: the thread is read again and the line it brought shows, with no let-go.
        expect(callsSince(before)).toContain('db.getMessages');
        expect(host.textContent).toContain('the newest line');
        expect(placeLog).toEqual([`enter ${RIVER}`]);
        await leave();
        expect(placeLog).toEqual([`enter ${RIVER}`, `leave ${RIVER}`]);
        // Mutation: put loadDeals back in the focus effect's deps in place -> the key read lets go and holds again
        // (placeLog enter, leave, enter), a second poll is asked, and the first poll's answer runs nothing: no line shown.
    });

    it('control: an ordinary chat still runs its focus effect again once the peer\'s key is read (its first poll asked twice, as before)', async () => {
        standIn({ getConversation: KOFI_THERE, getMessages: [], markConversationRead: true, syncSingleConversation: true });
        await open();
        expect(host.textContent).toContain('Kofi');
        expect(callsOf('syncSingleConversation')).toBe(2);
        expect(callsOf('enterChatInPlace') + callsOf('leaveChatInPlace')).toBe(0);
    });

    it('the poll answers once the chat is left: nothing after it is read, marked or asked; the hold is let go once', async () => {
        await openInPlace({ syncSingleConversation: later });
        expect(heldCalls.length, 'a poll is on its way').toBeGreaterThan(0);
        const before = net.calls.length;
        await leave();
        for (const answer of heldCalls) answer(true);
        await settle();
        expect(callsSince(before)).toEqual(['db.leaveChatInPlace']);
        expect(placeLog.at(-1)).toBe(`leave ${RIVER}`);
        expect(balanced()).toBe(true);
        // Mutation: drop the `active` check in the poll's follow-up -> getConversation, getDmKeyChange, getDmKeyCodeInfo,
        // getMessages and markConversationRead are called after the leave (the review's late mark read to A).
    });

    it('a push\'s poll answers once the chat is left: the same, nothing after it', async () => {
        let holdNext = false;
        await openInPlace({ syncSingleConversation: () => (holdNext ? later() : Promise.resolve(true)) });
        await settle();
        holdNext = true;
        await act(async () => { for (const fn of events.on[PUSH_RECEIVED_EVENT] ?? []) fn(); });
        expect(heldCalls.length, 'the push\'s poll is on its way').toBe(1);
        const before = net.calls.length;
        await leave();
        heldCalls[0](true);
        await settle();
        expect(callsSince(before)).toEqual(['db.leaveChatInPlace']);
        expect(balanced()).toBe(true);
        // A push after the leave starts nothing: its listener went with the chat.
        expect(events.on[PUSH_RECEIVED_EVENT]?.size ?? 0).toBe(0);
    });

    it('a read mid-flight as the chat is left (its thread still on its way): not marked read, nothing shown, nothing asked', async () => {
        let holdReads = false;
        await openInPlace({ syncSingleConversation: () => Promise.resolve(true), getMessages: () => (holdReads ? later() : Promise.resolve([])) });
        await settle();
        holdReads = true;
        await act(async () => { for (const fn of events.on[PUSH_RECEIVED_EVENT] ?? []) fn(); });
        await settle();
        expect(heldCalls.length, 'the thread\'s read is on its way').toBeGreaterThan(0);
        const before = net.calls.length;
        await leave();
        for (const answer of heldCalls) answer([{ id: 'k1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: 'late', rawTimestamp: iso(now), timestamp: '' }]);
        await settle();
        expect(callsSince(before)).toEqual(['db.leaveChatInPlace']);
        // Mutation: drop the in-view check after the thread's read -> markConversationRead is called after the leave.
    });
});

describe('a chat in place opens nothing of the community in use: no listing, profile or deal of its (slice S2, #3305 review)', () => {
    const RIVER = 'https://riverside.example';
    const KOFI_THERE = { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: null, listed: 1 };
    /** A deal's notice, as the node posts it into the pair's own chat: it names the listing (metadata.postId). */
    const notice = (systemType: string, text: string) => ({
        id: `n-${systemType}`, type: 'system', senderId: 'SYSTEM', systemType, text, metadata: { postId: 'p-ladder' }, rawTimestamp: iso(now - 60_000), timestamp: '',
    });
    const FUNDED = notice('ESCROW_FUNDED', 'The Beans are held in trust.');
    const RELEASED = notice('ESCROW_RELEASED', 'The Beans were released.');
    const CANCELLED = notice('ESCROW_CANCELLED', 'The deal was cancelled.');
    /** A line sent from a listing (Message on a listing): its card names the listing. */
    const ABOUT_LINE = {
        id: 'a1', senderId: 'kofi-key', authorPubkey: 'kofi-key', type: 'text', text: 'is it still free?', rawTimestamp: iso(now - 30_000), timestamp: '',
        about: { postId: 'p-ladder', title: 'Borrow a long ladder', kind: 'offer' },
    };
    /** The chat's own listing, with a deal on it whose Beans are mine to release: the sticky header and the release bar. */
    const ON_A_LISTING = {
        ...KOFI_THERE, postId: 'p-ladder', postTitle: 'Borrow a long ladder', postStatus: 'pending', price_c: 500, price_type: 'fixed',
        pendingTxId: 'tx-held', pendingAmount_c: 500, txBuyerPubkey: ME.publicKey,
    };
    const HELD_DEAL = { txId: 'tx-held', postId: 'p-ladder', postTitle: 'Borrow a long ladder', status: 'pending', buyerPubkey: ME.publicKey, sellerPubkey: 'kofi-key', iAmBuyer: true, amount_c: 500 };
    /** A deal of theirs on my listing: the strip's card, which opens the listing at that deal. */
    const STRIP_DEAL = { txId: 'tx-eggs', postId: 'p-eggs', postTitle: 'Duck eggs', status: 'pending', buyerPubkey: 'kofi-key', sellerPubkey: ME.publicKey, iAmBuyer: false, amount_c: 300 };

    let went: Array<[string, unknown]>;
    beforeEach(() => {
        went = [];
        for (const how of ['push', 'replace', 'navigate'] as const) vi.spyOn(router, how).mockImplementation(((to: unknown) => { went.push([how, to]); }) as never);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    async function openChat(inPlace: boolean, over: Answers): Promise<void> {
        params.now = inPlace ? { id: 'dm1', community: RIVER, communityName: 'Riverside' } : { id: 'dm1' };
        if (inPlace) holdsCommunity(RIVER, 'Riverside');
        standIn({ getConversation: KOFI_THERE, getMessages: [], markConversationRead: true, syncSingleConversation: true, ...over });
        await open();
        expect(host.textContent).toContain('Kofi');
    }
    const buttonReading = (words: string) => (): HTMLElement | null =>
        Array.from(host.querySelectorAll<HTMLElement>('button')).find((b) => b.textContent?.trim() === words) ?? null;
    const buttonHolding = (words: string) => (): HTMLElement | null =>
        Array.from(host.querySelectorAll<HTMLElement>('button')).find((b) => b.textContent?.includes(words)) ?? null;
    const openMenu = async () => { await tap('More options'); };

    /**
     * Every tap target of the DM screen that opens a listing, a profile, a deal or a route of a community (the class closed
     * after #3305's deciding review of 465fb8f9). `goes`: where it leads in an ordinary chat, the community in use's (null:
     * no move; `asks`, what it reads of that community's copy). In place it is not there (`absent`), or there with a tap that
     * opens nothing (`inert`), or it goes where it does named by the chat's own community (`named`, `inPlaceGoes`).
     */
    interface Row {
        name: string; over: Answers; open?: () => Promise<void>; find: () => HTMLElement | null;
        goes: [string, unknown] | null; asks?: string; inPlace: 'absent' | 'inert' | 'named'; inPlaceGoes?: [string, unknown];
    }
    const ROWS: Row[] = [
        ...[FUNDED, RELEASED, CANCELLED].map((line): Row => ({
            name: `View Post on a deal's notice (${line.systemType})`, over: { getMessages: [line] }, find: buttonReading('View Post'),
            goes: ['push', '/post/p-ladder'], inPlace: 'absent',
        })),
        {
            name: "Rate your partner on a deal's notice (ESCROW_RELEASED)", over: { getMessages: [RELEASED] }, find: buttonReading('Rate your partner'),
            goes: null, asks: 'db.getDb', inPlace: 'absent',
        },
        {
            name: "a listing's card on a line", over: { getMessages: [ABOUT_LINE] }, find: () => host.querySelector<HTMLElement>('[data-testid="chat-about-card"]'),
            goes: ['push', '/post/p-ladder'], inPlace: 'inert',
        },
        {
            name: "the person's name at the top (their profile)", over: {}, find: buttonHolding('End-to-end encrypted'),
            goes: ['push', { pathname: '/public-profile', params: { publicKey: 'kofi-key', callsign: 'Kofi' } }], inPlace: 'inert',
        },
        {
            name: 'View profile in the menu', over: {}, open: openMenu, find: buttonReading('View profile'),
            goes: ['push', { pathname: '/public-profile', params: { publicKey: 'kofi-key', callsign: 'Kofi' } }], inPlace: 'absent',
        },
        {
            name: "the listing's header over the chat", over: { getConversation: ON_A_LISTING, getDealsBetween: [HELD_DEAL] },
            find: buttonHolding('Borrow a long ladder'), goes: ['push', '/post/p-ladder'], inPlace: 'absent',
        },
        {
            name: 'Release on the bar under it', over: { getConversation: ON_A_LISTING, getDealsBetween: [HELD_DEAL] },
            find: () => (host.textContent?.includes('Action needed: release the Beans')
                ? Array.from(host.querySelectorAll<HTMLElement>('button')).find((b) => b.textContent?.startsWith('Release')) ?? null
                : null),
            goes: null, inPlace: 'absent',
        },
        {
            name: "a deal's card on the strip", over: { getDealsBetween: [STRIP_DEAL] }, find: buttonHolding('Duck eggs'),
            goes: ['push', { pathname: '/post/[id]', params: { id: 'p-eggs', txId: 'tx-eggs' } }], inPlace: 'absent',
        },
        {
            name: 'Key code in the menu', over: {}, open: openMenu, find: buttonReading('Key code'),
            goes: ['push', { pathname: '/chat/key-code', params: { id: 'dm1' } }],
            inPlace: 'named', inPlaceGoes: ['push', { pathname: '/chat/key-code', params: { id: 'dm1', community: RIVER } }],
        },
    ];

    for (const row of ROWS) it(`${row.name}: in an ordinary chat it is offered, and leads to the community in use`, async () => {
        await openChat(false, row.over);
        await row.open?.();
        const target = row.find();
        expect(target, 'offered in an ordinary chat (so its in-place row is not vacuous)').not.toBeNull();
        const before = net.calls.length;
        await act(async () => { target!.click(); });
        await settle();
        if (row.goes) expect(went).toEqual([row.goes]);
        if (row.asks) expect(net.calls.slice(before)).toContain(row.asks);
    });

    for (const row of ROWS) it(`${row.name}: in place it opens nothing of the community in use`, async () => {
        await openChat(true, row.over);
        await row.open?.();
        const target = row.find();
        if (row.inPlace === 'absent') expect(target, 'not offered in place').toBeNull();
        else {
            expect(target, 'shown in place').not.toBeNull();
            await act(async () => { target!.click(); });
            await settle();
        }
        expect(went).toEqual(row.inPlace === 'named' ? [row.inPlaceGoes] : []);
        // Nothing of a deal or a listing is read in place, from the copy in use or any other.
        expect(net.calls.filter((c) => ['db.getDealsBetween', 'db.getDb', 'db.lookupAboutListing'].includes(c))).toEqual([]);
        // Mutation: drop `!at &&` from the notice's View Post -> its three rows find View Post in place.
    });

    /** Taps every button the screen shows: the menu's (opened again as each row closes it) and each line's actions included. */
    async function tapEverything(): Promise<string[]> {
        const tapped = new Set<string>();
        const keyOf = (b: HTMLElement) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '';
        const untapped = () => Array.from(host.querySelectorAll<HTMLElement>('button')).find((b) => !tapped.has(keyOf(b))) ?? null;
        for (let i = 0; i < 120; i++) {
            let next = untapped();
            if (!next) {
                // Each menu row closes the menu: open it again, and stop once it holds nothing new.
                await openMenu();
                next = untapped();
                if (!next) break;
            }
            tapped.add(keyOf(next));
            const b = next;
            await act(async () => { b.click(); });
            await settle(3);
        }
        return [...tapped];
    }
    const EVERYTHING: Answers = { getConversation: ON_A_LISTING, getDealsBetween: [HELD_DEAL, STRIP_DEAL], getMessages: [FUNDED, RELEASED, CANCELLED, ABOUT_LINE] };

    it('every button of a chat in place, with all of these there to show: the one move is Key code, named by its community', async () => {
        await openChat(true, EVERYTHING);
        const tapped = await tapEverything();
        expect(tapped).toEqual(expect.arrayContaining(['More options', 'Key code', 'Back']));
        expect(tapped.length).toBeGreaterThan(8);
        expect(went).toEqual([['push', { pathname: '/chat/key-code', params: { id: 'dm1', community: RIVER } }]]);
        expect(net.calls.filter((c) => ['db.getDealsBetween', 'db.getDb', 'db.lookupAboutListing', 'db.completeMarketplaceTransaction', 'db.cancelMarketplaceTransaction', 'db.reportDmLine'].includes(c))).toEqual([]);
        // Mutation: drop `!at &&` from the notice's View Post -> went holds ['push', '/post/p-ladder'].
    });

    it('control: the same taps in an ordinary chat open the listing, the person and the deal (so the sweep above would see them)', async () => {
        await openChat(false, EVERYTHING);
        await tapEverything();
        const to = went.map(([, where]) => (typeof where === 'string' ? where : (where as { pathname: string }).pathname));
        expect(to).toEqual(expect.arrayContaining(['/post/p-ladder', '/public-profile', '/post/[id]', '/chat/key-code']));
    });
});

describe('a chat named with another community: only a DM its copy holds opens in place, at its saved address and name (#3305 review F1, F2, F4)', () => {
    const RIVER = 'https://riverside.example';
    const KOFI_THERE = { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: null, listed: 1 };
    /** The calls of a chat drawn in place: none of them is made unless that community's copy holds the id as a DM. */
    const IN_PLACE_CALLS = ['enterChatInPlace', 'getConversation', 'getMessages', 'syncSingleConversation', 'markConversationRead', 'getDmKeyChange', 'getDmKeyCodeInfo'];
    let asked: unknown[][];
    let moves: unknown[][];
    beforeEach(() => {
        asked = [];
        moves = [];
        moveTo.run = (...args: unknown[]) => { moves.push(args); return Promise.resolve('switched'); };
    });
    async function openLink(link: Record<string, string>, over: Answers = {}): Promise<void> {
        params.now = link;
        standIn({
            getConversation: KOFI_THERE, getMessages: [], markConversationRead: true, syncSingleConversation: true,
            heldChatIsDm: (...args: unknown[]) => { asked.push(args); return Promise.resolve(true); },
            ...over,
        });
        await open();
    }
    const madeInPlace = () => IN_PLACE_CALLS.filter((n) => callsOf(n) > 0);
    /** A button by the words it shows (the move's button is named by its words, as Contacts' is). */
    const reading = (words: string) => Array.from(host.querySelectorAll<HTMLElement>('button')).find((b) => b.textContent?.trim() === words) ?? null;

    it('the reviewer\'s link: an enterprise\'s key named with a community the phone keeps opens nothing there in place; one tap moves there', async () => {
        holdsCommunity(RIVER, 'Riverside');
        await openLink({ id: 'enterprise-key-0123', community: RIVER, communityName: 'Riverside Official' }, {
            heldChatIsDm: (...args: unknown[]) => { asked.push(args); return Promise.resolve(false); },
        });
        // Asked of that community's copy, by the address the phone saved, for the id the link names.
        expect(asked).toEqual([[ME.publicKey, RIVER, 'enterprise-key-0123']]);
        expect(madeInPlace(), 'nothing held, read, polled or marked in place').toEqual([]);
        expect(host.querySelector('[data-testid="chat-not-in-place"]')).not.toBeNull();
        expect(host.textContent).toContain('Could not open this chat.');
        // The community's own saved name, never the link's.
        expect(host.textContent).not.toContain('Riverside Official');
        const go = reading('Open Riverside ›');
        expect(go, 'the move\'s button').not.toBeNull();
        await act(async () => { go!.click(); });
        // The move's modules load on the tap (a dynamic import): wait for it, bounded.
        for (let i = 0; i < 400 && moves.length === 0; i++) await settle(1);
        expect(moves.length).toBe(1);
        const [community, id, route] = moves[0] as [string, unknown, () => Promise<string>];
        expect([community, id, await route()]).toEqual([RIVER, null, '/chat/enterprise-key-0123']);
        expect(madeInPlace()).toEqual([]);
        // Mutation (the review's): ChatRoute draws the chat in place on `id && community` alone -> enterChatInPlace,
        // getConversation and the poll are made for the enterprise's key, and the header reads "Riverside Official".
    });

    it.each(['held', 'failed'] as const)('the move answered \'%s\' (a join or a switch under way, or a switch that failed): the screen says so, as Chat\'s held rows do; a move made says nothing', async (answered) => {
        holdsCommunity(RIVER, 'Riverside');
        const NOTE = 'Something went wrong. Try again in a moment.';
        const answers: string[] = [answered, 'switched'];
        moveTo.run = (...args: unknown[]) => { moves.push(args); return Promise.resolve(answers.shift()); };
        await openLink({ id: 'group-chat-1', community: RIVER, communityName: 'Riverside' }, {
            heldChatIsDm: (...args: unknown[]) => { asked.push(args); return Promise.resolve(false); },
        });
        expect(host.textContent).not.toContain(NOTE);
        const tap = async (n: number) => {
            await act(async () => { reading('Open Riverside ›')!.click(); });
            for (let i = 0; i < 400 && moves.length < n; i++) await settle(1);
            await settle(3);
            expect(moves.length).toBe(n);
        };
        await tap(1);
        expect(host.textContent, 'the tap moved nothing: it says so').toContain(NOTE);
        expect(madeInPlace()).toEqual([]);
        // Tapped again, and moved: the note goes.
        await tap(2);
        expect(host.textContent).not.toContain(NOTE);
        // Mutation (#3305 max review r2 N3, the head before this): moveThere ignores openNoticeIn's answer -> no note after
        // the first tap.
    });

    it('a direct chat that community\'s copy holds: in place, under the name the phone saved, whatever name the link carries', async () => {
        holdsCommunity(RIVER, 'Riverside');
        await openLink({ id: 'dm1', community: RIVER, communityName: 'Riverside Official' });
        expect(host.textContent).toContain('Kofi');
        expect(host.textContent).toContain('Riverside');
        expect(host.textContent).not.toContain('Riverside Official');
        expect(host.querySelector('[data-testid="chat-not-in-place"]')).toBeNull();
    });

    it('a link spelling the community otherwise (capitals, a path): in place at the address the phone saved, and only there', async () => {
        holdsCommunity(RIVER, 'Riverside');
        const at: unknown[] = [];
        await openLink({ id: 'dm1', community: 'HTTPS://Riverside.EXAMPLE/some/path', communityName: 'Riverside' }, {
            enterChatInPlace: (c: unknown) => { at.push(c); return undefined; },
            syncSingleConversation: (...args: unknown[]) => { at.push(args[1]); return Promise.resolve(true); },
        });
        expect(asked).toEqual([[ME.publicKey, RIVER, 'dm1']]);
        expect(at.length).toBeGreaterThan(1);
        expect(new Set(at)).toEqual(new Set([RIVER]));
    });

    it('a community the phone doesn\'t keep, or keeps only as a guest\'s look: nothing opens, nothing is asked, no way to move there', async () => {
        for (const guest of [false, true]) {
            net.calls.length = 0;
            asked = [];
            if (guest) {
                holdsCommunity(RIVER, 'Riverside');
                store.map.set('beanpool_guest_nodes', JSON.stringify(['https://RIVERSIDE.example/']));
            } else {
                store.map.delete('beanpool_saved_nodes');
                store.map.delete('beanpool_guest_nodes');
            }
            await openLink({ id: 'dm1', community: RIVER, communityName: 'Riverside' });
            expect(asked, guest ? 'a guest\'s look' : 'not kept').toEqual([]);
            expect(madeInPlace()).toEqual([]);
            expect(host.textContent).toContain('Could not open this chat.');
            expect(reading('Open Riverside ›')).toBeNull();
            expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent?.startsWith('Open '))).toBe(false);
            await act(async () => { root.unmount(); });
            root = createRoot(host);
        }
    });

    it('the community in use named: the chat\'s ordinary route, nothing held or asked in place', async () => {
        const named: unknown[] = [];
        await openLink({ id: 'dm1', community: `${NODE}/`, communityName: 'Somewhere' }, {
            getConversation: (...args: unknown[]) => { named.push(args[2]); return Promise.resolve(KOFI_THERE); },
        });
        expect(host.textContent).toContain('Kofi');
        expect(asked).toEqual([]);
        expect(callsOf('enterChatInPlace')).toBe(0);
        expect(named.length).toBeGreaterThan(0);
        expect(new Set(named)).toEqual(new Set([undefined]));
        expect(host.textContent).not.toContain('Somewhere');
    });

    it('F4: the first read refused in place (that community\'s copy can\'t be opened now): the chat says so, and its name never stays "Loading..."', async () => {
        holdsCommunity(RIVER, 'Riverside');
        const refused = () => Promise.reject(new Error('This phone has switched community since this chat was opened.'));
        await openLink({ id: 'dm1', community: RIVER, communityName: 'Riverside' }, { getConversation: refused, getMessages: refused });
        expect(host.textContent).not.toContain('Loading...');
        expect(host.textContent).toContain('This phone has switched community since this chat was opened.');
        // Only the conversation's read refused: its name is the chat's short id, never "Loading..." for good.
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        await openLink({ id: 'dm1', community: RIVER, communityName: 'Riverside' }, { getConversation: refused });
        expect(host.textContent).not.toContain('Loading...');
        // Mutation: no catch around getConversation in loadConversationData -> the name stays "Loading..." (an unhandled
        // rejection on a phone).
    });
});
