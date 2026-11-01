// @vitest-environment jsdom
/**
 * A decision on a message request, then the chat, rendered for real over the phone's own utils/db (PR #2540 review
 * 4395706539): components/MessageRequestsPane and app/chat/[id].tsx drawn as dm-requests-chat-render.test.ts draws them,
 * with utils/db itself on its real schema in an in-memory SQLite and real DM encryption between real keys
 * (dm-requests-sync-real.test.ts's harness), and the node a fetch stand-in that answers as routes/messaging.ts does. From
 * just before the member decides, the node's reads (its list and its pages of lines) are held, as on a slow node (5–10 s),
 * so the chat draws only what the phone's own row says.
 *
 * decideMessageRequest stored nothing: the chat opened after Accept on a Requests card drew "{name} wants to message you"
 * again, with no composer, and Accept or Cancel request inside the chat came back on the next reread of the row.
 *
 * Cancel request in the chat took its lines off the phone but left the decrypted copy of a photo among them, opened by the
 * chat, in the cache (review 4397153864).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// The shipped pictures' requires (utils/bundled-avatars.ts, through MemberAvatar and the picture sheet) load as a number.
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
});
import Module from 'node:module';
import { randomUUID } from 'node:crypto';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
/** The screen's DeviceEventEmitter listeners, as the stand-in below hands them over. */
const events = vi.hoisted(() => ({ on: {} as Record<string, Set<() => void>> }));
const h = vi.hoisted(() => ({
    store: new Map<string, string>(),
    me: { publicKey: '', privateKey: '' },
    /** The member signed in, one object for the whole test, as IdentityContext hands it over. */
    identity: { publicKey: '', privateKey: '', callsign: 'Bo' },
    /** The phone's files by path: one written is there until it is deleted. */
    files: new Map<string, string>(),
}));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', progressbar: 'progressbar' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
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
        Animated: { ScrollView: el('div'), View: el('div') },
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string) => { alerts.said.push(title); if (body) alerts.said.push(body); } },
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
vi.mock('expo-sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    (globalThis as any).__phoneSql = sql;
    const args = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    const adapter = {
        runAsync: vi.fn(async (q: string, p?: unknown) => {
            const r = sql.prepare(q).run(...args(p));
            return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
        }),
        execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
        getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...args(p))),
        getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...args(p)) ?? null),
        closeAsync: vi.fn(async () => {}),
        withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
    };
    return { openDatabaseAsync: vi.fn(async () => adapter) };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => h.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { h.store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) h.store.delete(k); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-image-picker', () => ({ requestCameraPermissionsAsync: async () => ({ granted: false }), launchCameraAsync: async () => ({ canceled: true }), launchImageLibraryAsync: async () => ({ canceled: true }) }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: async () => ({}), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///nowhere/', documentDirectory: 'file:///nowhere/doc/', EncodingType: { Base64: 'base64', UTF8: 'utf8' },
    getInfoAsync: vi.fn(async (path: string) => ({ exists: h.files.has(path) })), deleteAsync: vi.fn(async (path: string) => { h.files.delete(path); }), makeDirectoryAsync: vi.fn(async () => {}),
    writeAsStringAsync: vi.fn(async (path: string, data: string) => { h.files.set(path, data); }), readAsStringAsync: vi.fn(async () => ''), moveAsync: vi.fn(async () => {}),
}));
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
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: h.identity }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../identity', async (orig) => ({ ...(await orig<any>()), loadIdentity: vi.fn(async () => ({ ...h.me, callsign: 'Bo' })) }));
vi.mock('../nodes', async (orig) => ({ ...(await orig<any>()), getDatabaseFilenameForNode: vi.fn(() => 'beanpool_mullum.beanpool.org.db'), addSavedNode: vi.fn(async () => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));
vi.mock('../blocklist', () => ({ isUserBlocked: async () => false, getBlockedUsers: async () => [], blockUser: async () => {}, BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
// Which screen /chat/:id draws is utils/chat-route's call (tested there); here it is the DM the test opens.
vi.mock('../chat-route', () => ({ routeChat: async () => ({ view: 'dm', screenId: params.now.id }) }));
// The group's key code (group-chat-keys.ts) is off this path; the screen's keyring answers "never held".
vi.mock('../group-chat-keys', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), groupKeysLookUnopenable: () => false }));

import { setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { MessageRequestsPane } from '../../components/MessageRequestsPane';
import ChatRoute from '../../app/chat/[id]';
import { getDb, getMessageRequests, syncMessages, syncSingleConversation } from '../db';
import { encryptDmFormat2, sealDmLine } from '../e2e-crypto';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';

const sql = (globalThis as any).__phoneSql as import('node:sqlite').DatabaseSync;
const ANCHOR = 'https://mullum.beanpool.org';

interface Person { name: string; publicKey: string; privateKey: string }
function person(name: string): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { name, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

// ── The node ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Line { id: string; conversationId: string; authorPubkey: string; ciphertext: string; nonce: string; type: string; systemType: null; metadata: null; timestamp: string; editedAt: null }
interface Conv { id: string; participants: string[]; request: { state: string; from: string; at: string; nextLineIsRequest?: boolean } | null }
const node = {
    lines: [] as Line[],
    convs: [] as Conv[],
    /** A photo line's picture, locked, by the line's id: served while the line is. */
    photos: new Map<string, { data: string; nonce: string }>(),
    /** While true, a read the node has answered (the list, a page of lines) doesn't arrive until released: a slow node. */
    readsHeld: false,
    held: [] as Array<() => void>,
};
let clock = Date.parse('2026-10-20T00:00:00.000Z');
let serial = 0;

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}
const view = (c: Conv) => ({ id: c.id, type: 'dm', name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-10-20T00:00:00.000Z', request: c.request });
const waitingFor = (c: Conv, key: string) => !!c.request && c.request.from !== key && c.request.state === 'pending';

const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    if (init.method === 'POST' && u.pathname === '/api/messages/request') {
        // Accept, Ignore or Cancel request (routes/messaging.ts): the request as the member now reads it.
        const b = JSON.parse(init.body);
        const conv = node.convs.find((c) => c.id === b.conversationId);
        if (!conv?.request) return answer(404, { error: 'There is no message request for you in this chat.', code: 'request_not_found' });
        if (b.decision === 'cancel') {
            node.lines = node.lines.filter((l) => !(l.conversationId === conv.id && l.authorPubkey === conv.request!.from));
            conv.request = { ...conv.request, nextLineIsRequest: true };
        } else {
            conv.request = { ...conv.request, state: b.decision === 'accept' ? 'accepted' : 'ignored' };
        }
        return answer(200, { success: true, request: { ...conv.request } });
    }
    const attachment = u.pathname.match(/^\/api\/messages\/([^/]+)\/attachment$/);
    if (attachment) {
        const id = decodeURIComponent(attachment[1]);
        const photo = node.lines.some((l) => l.id === id) ? node.photos.get(id) : undefined;
        return photo ? answer(200, { ...photo, mime: 'image/jpeg' }) : answer(404, { error: 'Attachment not found' });
    }
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) {
        const mine = node.convs.filter((c) => c.participants.includes(list[1]));
        const asked = mine.filter((c) => waitingFor(c, list[1]) && node.lines.some((l) => l.conversationId === c.id));
        const body = {
            conversations: mine.filter((c) => !c.request || c.request.from === list[1] || c.request.state === 'accepted').map(view),
            totalUnread: 0,
            deletedAccounts: [],
            requests: { count: asked.length, conversations: asked.map(view) },
        };
        if (node.readsHeld) await new Promise<void>((release) => node.held.push(release));
        return answer(200, body);
    }
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page) {
        const conv = node.convs.find((c) => c.id === decodeURIComponent(page[1]));
        if (!conv) return answer(404, { error: 'Conversation not found' });
        const limit = Number(u.searchParams.get('limit') ?? 50);
        const body = { conversation: view(conv), messages: node.lines.filter((l) => l.conversationId === conv.id).slice(-limit).map((l) => ({ ...l })) };
        if (node.readsHeld) await new Promise<void>((release) => node.held.push(release));
        return answer(200, body);
    }
    if (u.pathname === '/api/members') return answer(200, []);
    return answer(404, { error: 'not here' });
});

/** A DM line on the node, locked between its author and the other person, as the apps write it. */
function write(conv: Conv, author: Person, text: string): Line {
    const peer = conv.participants.find((p) => p !== author.publicKey)!;
    const { ciphertext, nonce } = encryptDmFormat2(text, { myEdPrivHex: author.privateKey, peerEdPubHex: peer, conversationId: conv.id });
    clock += 1000;
    const line: Line = { id: `line-${++serial}`, conversationId: conv.id, authorPubkey: author.publicKey, ciphertext, nonce, type: 'text', systemType: null, metadata: null, timestamp: new Date(clock).toISOString(), editedAt: null };
    node.lines.push(line);
    return line;
}

/** A DM photo line on the node as sendImageMessage seals one (format 3, the author's first): its caption the words, its picture beside them. */
function writePhoto(conv: Conv, author: Person, caption: string, dataUri: string): Line {
    const peer = conv.participants.find((p) => p !== author.publicKey)!;
    const ctx = { myEdPrivHex: author.privateKey, peerEdPubHex: peer, conversationId: conv.id };
    const bind = { senderPubHex: author.publicKey, messageId: randomUUID() };
    const words = sealDmLine(caption, ctx, { ...bind, part: 'body', after: null });
    const picture = sealDmLine(dataUri, ctx, { ...bind, part: 'attachment' });
    clock += 1000;
    const line: Line = { id: bind.messageId, conversationId: conv.id, authorPubkey: author.publicKey, ciphertext: words.ciphertext, nonce: words.nonce, type: 'image', systemType: null, metadata: null, timestamp: new Date(clock).toISOString(), editedAt: null };
    node.lines.push(line);
    node.photos.set(line.id, { data: picture.ciphertext, nonce: picture.nonce });
    return line;
}

// ── The phone ───────────────────────────────────────────────────────────────────────────────────────────────────────

// utils/db reaches DeviceEventEmitter through require('react-native'), which vi.mock doesn't see: the same stand-in.
const realLoad = (Module as any)._load;
beforeAll(() => {
    (Module as any)._load = function (request: string, ...rest: any[]) {
        if (request === 'react-native') {
            return {
                DeviceEventEmitter: { emit: () => {}, addListener: (name: string, fn: () => void) => { (events.on[name] ??= new Set()).add(fn); return { remove() { events.on[name]?.delete(fn); } }; } },
                Platform: { OS: 'android' },
            };
        }
        return realLoad.call(this, request, ...rest);
    };
});
afterAll(() => { (Module as any)._load = realLoad; });

let bo: Person;
let rhea: Person;
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
    h.store.clear();
    h.store.set('beanpool_anchor_url', ANCHOR);
    h.store.set('beanpool_node_profiles', JSON.stringify({ [ANCHOR.toLowerCase()]: { profile: 'global', features: {}, checkedAt: new Date().toISOString() } }));
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    bo = person('Bo');
    rhea = person('Rhea');
    h.me = { publicKey: bo.publicKey, privateKey: bo.privateKey };
    h.identity = { ...h.me, callsign: 'Bo' };
    node.lines = [];
    node.convs = [];
    node.photos.clear();
    h.files.clear();
    node.readsHeld = false;
    node.held = [];
    alerts.said.length = 0;
    events.on = {};
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
    sql.prepare('INSERT OR REPLACE INTO members (public_key, callsign) VALUES (?, ?)').run(rhea.publicKey, 'Rhea');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => {
    act(() => root.unmount());
    host.remove();
    // The reads still held go now, so no answer of this test's lands in the next one.
    node.readsHeld = false;
    for (const release of node.held.splice(0)) release();
    await settle();
    setLanguage('en');
});

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const draw = async (screen: ReturnType<typeof createElement>) => {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, screen) as any); });
    await settle();
};
/** Opens /chat/:id, as router.push does. */
async function openChat(id: string): Promise<void> {
    act(() => root.unmount());
    root = createRoot(host);
    params.now = { id };
    await draw(createElement(ChatRoute));
}
/** The screen hears a sync (a poll, a delivery's end), as DeviceEventEmitter tells it on a phone: it rereads its row. */
async function syncLanded(): Promise<void> {
    await act(async () => { for (const fn of events.on.sync_data_updated ?? []) fn(); });
    await settle();
}
const button = (label: string) => Array.from(host.querySelectorAll<HTMLElement>('button[aria-label]')).find((b) => b.getAttribute('aria-label') === label) ?? null;
async function tap(label: string): Promise<void> {
    const b = button(label);
    expect(b, `a "${label}" button`).toBeTruthy();
    await act(async () => { b!.click(); });
    await settle();
}
const box = () => host.querySelector('input[placeholder="Message..."]');
const ACCEPT_CARD = 'Rhea wants to message you';

async function rheaAsks(id: string): Promise<Conv> {
    const req: Conv = { id, participants: [rhea.publicKey, bo.publicKey], request: { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() } };
    node.convs.push(req);
    write(req, rhea, 'first words from Rhea');
    await syncMessages(bo.publicKey);
    return req;
}

describe('a decision on a message request, then the chat, on the phone (review 4395706539)', () => {
    it('Accept on a Requests card: the chat opens with its composer, never the Accept card again', async () => {
        const req = await rheaAsks('dm-rhea-bo-card');
        const requests = await getMessageRequests(bo.publicKey);
        expect(requests?.conversations.map((c: any) => c.id)).toEqual([req.id]);
        const accepted: string[] = [];
        await draw(createElement(MessageRequestsPane, {
            entries: requests!.conversations, count: requests!.count, identity: { publicKey: bo.publicKey },
            onOpen: () => {}, onBack: () => {}, onAccepted: (entry: any) => accepted.push(entry.id), onChanged: () => {},
        }));
        // The card's preview read the node's page, and wrote the request waiting into the phone's row.
        expect(host.textContent).toContain('first words from Rhea');

        node.readsHeld = true;
        await tap('Accept');
        expect(accepted).toEqual([req.id]);
        await openChat(req.id);

        expect(host.textContent).toContain('first words from Rhea');
        expect(host.textContent).not.toContain(ACCEPT_CARD);
        expect(box()).not.toBeNull();
        expect(alerts.said).toEqual([]);
    });

    it('Accept in the chat: a reread of the row keeps the composer', async () => {
        const req = await rheaAsks('dm-rhea-bo-chat');
        await syncSingleConversation(req.id);
        node.readsHeld = true;
        await openChat(req.id);
        // Control: the row says the request waits, and the chat draws the Accept card.
        expect(host.textContent).toContain(ACCEPT_CARD);
        expect(box()).toBeNull();

        await tap('Accept');
        expect(host.textContent).not.toContain(ACCEPT_CARD);
        await syncLanded();

        expect(host.textContent).not.toContain(ACCEPT_CARD);
        expect(box()).not.toBeNull();
    });

    it('Cancel request in the chat: a reread of the row keeps the composer, with no "Sent as a request" over no line', async () => {
        const req: Conv = { id: 'dm-bo-rhea-cancel', participants: [bo.publicKey, rhea.publicKey], request: { state: 'pending', from: bo.publicKey, at: new Date(clock + 500).toISOString(), nextLineIsRequest: false } };
        node.convs.push(req);
        write(req, bo, 'his first words');
        await syncMessages(bo.publicKey);
        await syncSingleConversation(req.id);
        node.readsHeld = true;
        await openChat(req.id);
        // Control: his line waits for Rhea, and the chat says so.
        expect(host.textContent).toContain('his first words');
        expect(host.querySelector('[data-testid="request-waiting"]')).not.toBeNull();

        await tap('Cancel request');
        expect(host.querySelector('[data-testid="request-waiting"]')).toBeNull();
        await syncLanded();

        expect(host.textContent).not.toContain('his first words');
        expect(host.querySelector('[data-testid="request-waiting"]')).toBeNull();
        expect(box()).not.toBeNull();
    });
});

describe('Cancel request on the phone, and the photo the request opened with (review 4397153864)', () => {
    const PHOTO_B64 = Buffer.from('a decrypted jpeg').toString('base64');
    const cachedPhoto = (id: string) => `file:///nowhere/chat-images/${id}.jpg`;

    it('Cancel request in the chat takes the decrypted copy of his photo off the phone with its line', async () => {
        const req: Conv = { id: 'dm-bo-rhea-photo', participants: [bo.publicKey, rhea.publicKey], request: { state: 'pending', from: bo.publicKey, at: new Date(clock + 500).toISOString(), nextLineIsRequest: false } };
        node.convs.push(req);
        const photo = writePhoto(req, bo, 'his photo', `data:image/jpeg;base64,${PHOTO_B64}`);
        await syncMessages(bo.publicKey);
        await syncSingleConversation(req.id);
        node.readsHeld = true;
        await openChat(req.id);
        // Control: the chat drew his photo, opened on this phone, so its decrypted copy is in the cache.
        expect(host.querySelector('img[aria-label="Photo message"]')).not.toBeNull();
        expect(h.files.get(cachedPhoto(photo.id))).toBe(PHOTO_B64);

        await tap('Cancel request');
        await syncLanded();

        expect(host.textContent).not.toContain('his photo');
        expect(host.querySelector('img[aria-label="Photo message"]')).toBeNull();
        expect(h.files.has(cachedPhoto(photo.id))).toBe(false);
    });
});
