// @vitest-environment jsdom
/**
 * Talk in the member's language (words slice S3, sweep B2): app/(tabs)/chats.tsx rendered for real inside the real
 * LanguageProvider, with what only Talk draws or opens drawn for real too: the conversation list and its trade rows,
 * the sort and filter drawer, the Groups pane (its rows, its empty and error states, the Create a Group form), the
 * People pane (friends and who added you, the community list, invites, a guest's registration), and the New message
 * picker. React Native's host components are plain tags carrying their accessibility props, placeholders and the few
 * layout props the 320 dp checks read; the node is the net-spy stand-in for utils/db, answering a small community.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint,
 * placeholder or alert with letters outside a bracket bypassed t(). What members wrote is shown as written: names,
 * listing titles, group names, messages. The 320 dp × 1.3 checks model widths as tab-bar-words-render.test.ts does (a
 * generous 0.62 em a letter).
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

const alerts = vi.hoisted(() => ({ said: [] as string[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', progressbar: 'progressbar' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, horizontal, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        if (horizontal) attrs['data-horizontal'] = 'true';
        const s = flat(props.style);
        if (s.flexWrap) attrs['data-wrap'] = s.flexWrap;
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        // What Yoga lays a row out from: read by the sub-nav's 320 dp check.
        const layout: Record<string, unknown> = {};
        for (const k of ['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'padding', 'paddingHorizontal', 'marginHorizontal', 'borderWidth']) if (s[k] !== undefined) layout[k] = s[k];
        if (Object.keys(layout).length) attrs['data-layout'] = JSON.stringify(layout);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
        ListHeaderComponent,
        (data ?? []).length
            ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
            : ListEmptyComponent,
        ListFooterComponent);
    class Value { constructor(public v = 0) {} setValue() {} setOffset() {} stopAnimation() {} interpolate() { return this; } addListener() { return ''; } removeListener() {} removeAllListeners() {} }
    const animation = () => ({ start(cb?: () => void) { cb?.(); }, stop() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList,
        Animated: {
            FlatList, View: el('div'), ScrollView: el('div'), Value, event: () => () => {}, timing: animation, spring: animation, decay: animation,
            loop: () => ({ start() {}, stop() {} }), sequence: () => ({ start() {}, stop() {} }),
            diffClamp: () => new Value(), add: () => new Value(), multiply: () => new Value(), subtract: () => new Value(), modulo: () => new Value(),
        },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string, buttons?: Array<{ text?: string }>) => { alerts.said.push(title); if (body) alerts.said.push(body); for (const b of buttons ?? []) if (b.text) alerts.said.push(b.text); } },
        Share: { share: async () => ({}) },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Easing: { out: (f: unknown) => f, cubic: () => 0, ease: () => 0, inOut: (f: unknown) => f },
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
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => params.now,
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
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
// Group info's picture sheet (components/AvatarPickerSheet) opens the system picker only when asked.
vi.mock('expo-image-picker', () => ({ requestCameraPermissionsAsync: vi.fn(), launchCameraAsync: vi.fn(), launchImageLibraryAsync: vi.fn() }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => createElement('div', { 'data-qr': 'true' }) }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
});
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, authenticateAsync: async () => ({ success: false }) }));
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
// A member's picture: drawn from what they chose, never words.
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
/** What a community this phone asked to join answers its signed status read with (utils/knock.ts); by its origin. */
const knockReads = vi.hoisted(() => ({ answers: new Map<string, () => Promise<Response>>() }));
vi.mock('../node-post', () => ({
    signedGet: (origin: string) => knockReads.answers.get(origin)?.() ?? new Promise(() => {}), signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../member-statements', () => ({ makeOfflineTicket: () => new Promise(() => {}) }));
const membership = vi.hoisted(() => ({ isMember: true }));
vi.mock('../membership-probe', () => ({ fetchMembership: async () => ({ ok: true, json: async () => ({ isMember: membership.isMember }) }) }));
vi.mock('../node-admin', () => ({
    askNodeRole: async () => null, persistNodeRole: async () => {}, readPersistedNodeRole: async () => undefined, rememberNodeRole: () => {},
}));
const knocks = vi.hoisted(() => ({ list: [] as any[], unreachable: false }));
vi.mock('../knock-inbox', async (importOriginal) => {
    const real = await importOriginal<Record<string, any>>();
    return {
        ...real,
        fetchJoinRequests: async () => (knocks.unreachable
            ? { ok: false, kind: 'error', message: real.KNOCK_UNREACHABLE_TEXT }
            : { ok: true, knocks: knocks.list, total: knocks.list.length }),
    };
});
const globalDoor = vi.hoisted(() => ({ entry: 'checking' as string, here: false }));
vi.mock('../global-join-existing', () => ({ isGlobalCommunity: () => globalDoor.here }));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => globalDoor.entry }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { DrawnInLanguage, LanguageProvider } from '../../components/LanguageProvider';
import { LanguageRow } from '../../components/LanguagePicker';
import { yourGroupsStore } from '../../components/useYourGroups';
import { joinRequestMeta, wantsToJoinTitle, WANTS_TO_JOIN_HELP } from '../knock-inbox';
import { KNOCK_MESSAGES } from '../knock';
import { MyJoinRequests } from '../../components/MyJoinRequests';
import ChatsScreen from '../../app/(tabs)/chats';
import NewMessageScreen from '../../app/new-message';

const NODE = 'https://mullum.example';
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The conversation list as utils/db getConversations gives it: the English its lower layers write is in it, marked
 * `lastMessageFromApp`; a member's words are not, even word for word a sentence BeanPool writes (Una's).
 */
/** A member's DM that is word for word one of the sentences chat-line-words.ts translates. */
const MEMBER_WRITES_A_TABLE_SENTENCE = 'Keep them locked';
const CONVERSATIONS = [
    { id: 'c-kofi', type: 'dm', peer: 'Kofi', peerPubkey: 'kofi-key', keyChanged: true, lastMessage: 'Started conversation', lastMessageFromApp: true, rawTimestamp: iso(now - 60_000), unread: 2 },
    { id: 'c-mia', type: 'dm', peer: 'Mia', peerPubkey: 'mia-key', postId: 'p-ladder', postTitle: 'Borrow a long ladder', postStatus: 'pending', lastMessage: 'see you at the hall', lastMessageFromApp: false, rawTimestamp: iso(now - 3 * DAY), unread: 0 },
    { id: 'c-zoe', type: 'dm', peer: 'Zoe', peerPubkey: 'zoe-key', postId: 'p-maths', postTitle: 'Maths tutoring', postStatus: 'completed', lastMessage: 'thanks!', lastMessageFromApp: false, rawTimestamp: iso(now - 20 * DAY), unread: 0 },
    { id: 'c-ivo', type: 'dm', peer: 'Ivo', peerPubkey: 'ivo-key', postId: 'p-eggs', postTitle: 'Duck eggs', postStatus: 'active', lastMessage: '5 Beans held in trust.', lastMessageFromApp: true, rawTimestamp: iso(now - 2 * DAY), unread: 0 },
    { id: 'c-ola', type: 'dm', peer: 'Ola', peerPubkey: 'ola-key', lastMessage: 'Notice: 🔒 Encrypted message', lastMessageFromApp: true, rawTimestamp: null, unread: 0 },
    { id: 'c-una', type: 'dm', peer: 'Una', peerPubkey: 'una-key', lastMessage: MEMBER_WRITES_A_TABLE_SENTENCE, lastMessageFromApp: false, rawTimestamp: iso(now - 4 * DAY), unread: 0 },
];
/** Two deals waiting on the member: a release in Mia's chat and a review in Zoe's. */
const DEALS = [
    { txId: 'tx-1', conversationId: 'c-mia', action: 'release', postTitle: 'Borrow a long ladder', peerPubkey: 'mia-key', peerCallsign: 'Mia', credits: 5 },
    { txId: 'tx-2', conversationId: 'c-zoe', action: 'review', postTitle: null, peerPubkey: 'zoe-key', peerCallsign: 'Zoe', credits: 0 },
];
const mute = { conversationId: 'g-bakery', mutedUntil: null, always: true };
/** "Your groups": a new group of the member's, an enterprise they lead (muted, unread), a project they help, an event. */
const YOUR_GROUPS = [
    { kind: 'group', id: 'g1', conversationId: 'g1', name: 'Garden club', role: 'convenor', category: 'social', readOnly: false, lastMessage: null, unreadCount: 0, mute: null, lastActivityAt: iso(now), badge: null, avatarUrl: null },
    { kind: 'enterprise', id: 'g-bakery', conversationId: 'g-bakery', name: 'Bakery', role: 'lead', lifecycle: 'ongoing', readOnly: false, unreadCount: 3, mute, lastActivityAt: iso(now), badge: null, avatarUrl: null,
        lastMessage: { id: 'm1', authorPubkey: 'kofi-key', authorCallsign: 'Kofi', type: 'text', systemType: null, text: 'bread at six', timestamp: iso(now - 2 * DAY) } },
    { kind: 'enterprise', id: 'g-roof', conversationId: 'g-roof', name: 'Hall roof', role: 'keeper', lifecycle: 'bounded', readOnly: false, unreadCount: 1, mute: null, lastActivityAt: iso(now), badge: null, avatarUrl: null,
        lastMessage: { id: 'm2', authorPubkey: ME.publicKey, authorCallsign: 'Ana', type: 'text', systemType: null, text: 'tiles ordered', timestamp: iso(now - 30 * DAY) } },
    { kind: 'event', id: 'e1', conversationId: 'e1', name: 'Repair café', role: 'going', readOnly: false, unreadCount: 0, mute: null, lastActivityAt: iso(now), badge: null, avatarUrl: null, lastMessage: null },
];
const FRIENDS = [
    { publicKey: 'kofi-key', callsign: 'Kofi', addedAt: iso(now - 10 * DAY) },
    { publicKey: 'mia-key', callsign: 'Mia', addedAt: null },
];
const MEMBERS = [
    { public_key: 'kofi-key', callsign: 'Kofi', joined_at: iso(now - 3 * 60 * 60_000) },
    { public_key: 'mia-key', callsign: 'Mia', joined_at: iso(now - 3 * DAY) },
    { public_key: 'zoe-key', callsign: 'Zoe', joined_at: iso(now - 15 * DAY) },
    { public_key: 'ola-key', callsign: 'Ola', joined_at: iso(now - 200 * DAY) },
];
const ADDED_YOU = [{ publicKey: 'rosa-key', callsign: 'Rosa', avatarUrl: null }];
const INVITES = [{ code: 'ab12-cd34', createdBy: ME.publicKey, createdAt: iso(now - DAY), intendedFor: 'Rosa' }];
const KNOCKS = [{ id: 'k1', pubkey: 'ivo-key', callsign: 'Ivo', message: 'I grow tomatoes', avatar: null, fromNode: 'castlemaine.example', createdAt: iso(now - 2 * DAY) }];
/** The communities this phone asked to join (utils/knock.ts's memory), each answering its own way. */
const ASKED: Array<{ url: string; name: string; answer: 'unreachable' | { status: number; body: Record<string, unknown> } }> = [
    { url: 'https://hills.example', name: 'Hills Commons', answer: { status: 200, body: { status: 'pending' } } },
    { url: 'https://river.example', name: 'River Town', answer: { status: 200, body: { status: 'approved', invite: 'RIVR2345' } } },
    { url: 'https://coast.example', name: 'Coast Swap', answer: { status: 200, body: { status: 'none' } } },
    { url: 'https://far.example', name: 'Far Valley', answer: 'unreachable' },
    { url: 'https://odd.example', name: 'Odd Grove', answer: { status: 200, body: { nonsense: true } } },
    { url: 'https://shut.example', name: 'Shut Gate', answer: { status: 404, body: { error: 'We take no requests here' } } },
];
const CLOSED_WORDS = 'We take no requests here';
/** The node's answer to a new conversation from a member whose account is paused (403 `paused`, removal by vote S1). */
const PAUSED_OPEN_WORDS = 'Your account here is paused for now, so you can’t start a new conversation. You can still answer the ones you’re in.';

/** Everything members and the community wrote: shown as written, in every language. */
const OTHERS = [
    ...CONVERSATIONS.flatMap((c: any) => [c.peer, c.postTitle]), 'see you at the hall', 'thanks!', MEMBER_WRITES_A_TABLE_SENTENCE,
    ...DEALS.flatMap((d: any) => [d.postTitle, d.peerCallsign]),
    ...YOUR_GROUPS.flatMap((g: any) => [g.name, g.lastMessage?.text, g.lastMessage?.authorCallsign]),
    ...FRIENDS.map((f) => f.callsign), ...MEMBERS.map((m) => m.callsign), ...ADDED_YOU.map((a) => a.callsign),
    ...INVITES.flatMap((i) => [i.code, i.intendedFor]), ...KNOCKS.flatMap((k) => [k.callsign, k.message, k.fromNode]),
    ...ASKED.map((a) => a.name), CLOSED_WORDS, PAUSED_OPEN_WORDS,
    NODE, ME.callsign,
].filter((s): s is string => typeof s === 'string' && /\p{L}/u.test(s)).sort((a, b) => b.length - a.length);

type Answers = Record<string, unknown>;
function community(over: Answers = {}): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Answers = {
        getConversations: CONVERSATIONS, getActionableDeals: DEALS, syncMessages: undefined, getFriendsLocal: FRIENDS,
        fetchYourGroups: { items: YOUR_GROUPS, totalUnread: 4 }, fetchAddedYou: { addedYou: ADDED_YOU, more: 2 },
        getRecentChatMembers: [{ publicKey: 'kofi-key', callsign: 'Kofi', avatar_url: null }],
        getDb: { getAllAsync: async (sql: string) => (/FROM members/.test(sql) ? MEMBERS : []), getFirstAsync: async () => null, runAsync: async () => ({}) },
        ...over,
    };
    return (name) => {
        if (!(name in answers)) return undefined;
        const a = answers[name];
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    };
}
function rememberProfile(profile: 'local' | 'global', features: Record<string, unknown>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}
const LOCAL = { beans: true, escrow: true, invites: true, knocks: true, showcase: false };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.answer = community();
    params.now = {};
    alerts.said.length = 0;
    knocks.list = [];
    knocks.unreachable = false;
    membership.isMember = true;
    globalDoor.entry = 'checking';
    globalDoor.here = false;
    store.map.clear();
    knockReads.answers.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set(`bp_offline_invites_${ME.publicKey}`, JSON.stringify(INVITES));
    rememberProfile('local', LOCAL);
    yourGroupsStore.reset();
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, screen: unknown = createElement(ChatsScreen)) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, screen as any) as any); });
    await settle();
}
const click = async (el: Element | null, what: string) => {
    expect(el, what).not.toBeNull();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`);
const buttonWithText = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text) ?? null;
/** One of Talk's three panes, by the name on its switch (its spoken name also carries an unread count). */
const pane = (label: string) => click(Array.from(host.querySelectorAll('[role="radio"]')).find((b) => b.querySelector('span')?.textContent === pseudoLocalise(label) || b.querySelector('span')?.textContent === label) ?? null, label);

/** Text with letters outside a pseudo-locale bracket, once what others wrote is taken out. */
function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
    // Innermost first: a translated sentence can hold another as a value ("[[Ƒööđ~], 3 ūñŕéāđ~~]").
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const o of OTHERS) rest = rest.split(o).join('');
    return /\p{L}/u.test(rest);
}
/** Every drawn text, label, hint, placeholder and alert that bypassed t(). */
function bypassing(): string[] {
    const out = new Set<string>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const whole = n.parentElement?.textContent ?? n.nodeValue;
        if (outsideBrackets(whole)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const [attr, kind] of [['aria-label', 'label'], ['data-hint', 'hint'], ['placeholder', 'placeholder']] as const) {
        for (const e of Array.from(host.querySelectorAll(`[${attr}]`))) {
            const v = e.getAttribute(attr);
            if (outsideBrackets(v)) out.add(`${kind}: ${JSON.stringify(v)}`);
        }
    }
    for (const said of alerts.said) if (outsideBrackets(said)) out.add(`alert: ${JSON.stringify(said)}`);
    return [...out];
}
/** How many drawn texts came through t() (bracketed), so a check on an empty screen can't pass by itself. */
const bracketed = () => Array.from(host.querySelectorAll('span')).filter((s) => /^\[.*\]$/su.test(s.textContent ?? '')).length;

describe('Talk in the pseudo-locale: every word on it came through t() (words S3c)', () => {
    it('Messages: the switch, the search row, the trade rows waiting on the member, each conversation\'s pill, preview and time', async () => {
        await renderIn('xx');
        expect(host.textContent).toContain('Borrow a long ladder');
        expect(host.textContent).toContain('Duck eggs');
        expect(host.querySelector('[data-testid="page-title-talk"]')).not.toBeNull();
        // The lower layers' English (db.ts previews, a trade's line) reads in the member's language too.
        expect(host.textContent).toContain(pseudoLocalise('Started conversation'));
        expect(host.textContent).toContain(pseudoLocalise('{n} Beans held in trust.').replace('{n}', '5'));
        expect(host.textContent).toContain(pseudoLocalise('Notice: {text}').replace('{text}', pseudoLocalise('🔒 Encrypted message')));
        // A member's words are shown as they wrote them, even word for word a sentence BeanPool writes (#2179 review).
        expect(host.textContent).toContain(MEMBER_WRITES_A_TABLE_SENTENCE);
        expect(host.textContent).not.toContain(pseudoLocalise(MEMBER_WRITES_A_TABLE_SENTENCE));
        expect(bracketed()).toBeGreaterThan(15);
        expect(bypassing()).toEqual([]);
    });

    it('the sort and filter drawer, with Beans on', async () => {
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Filter and sort')), 'Filter and sort');
        expect(host.textContent).toContain(pseudoLocalise('Credits: High'));
        expect(host.textContent).toContain(pseudoLocalise('👫 Friends Only'));
        expect(bypassing()).toEqual([]);
    });

    it('no conversations yet', async () => {
        net.answer = community({ getConversations: [], getActionableDeals: [] });
        await renderIn('xx');
        expect(host.textContent).toContain(pseudoLocalise('No conversations yet.'));
        expect(bypassing()).toEqual([]);
    });

    it('Groups: every row\'s kind, the member\'s part, unread and muted in its spoken name; the buttons; the Create a Group form', async () => {
        await renderIn('xx');
        await pane('Groups');
        expect(host.textContent).toContain('Garden club');
        expect(host.textContent).toContain(pseudoLocalise('New group · invite people to get started'));
        const bakery = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Bakery'))!;
        expect(bakery.getAttribute('aria-label')).toBe(pseudoLocalise('{head}, {n} unread, muted. {preview}')
            .replace('{head}', pseudoLocalise('{name}, enterprise, lead keeper').replace('{name}', 'Bakery'))
            .replace('{n}', '3')
            .replace('{preview}', pseudoLocalise('{name}: {text}').replace('{name}', 'Kofi').replace('{text}', 'bread at six')));
        expect(bypassing(), 'rows').toEqual([]);
        await click(byLabel(pseudoLocalise('New group')), 'New group');
        expect(host.textContent).toContain(pseudoLocalise('Create a Group'));
        expect(host.textContent).toContain(pseudoLocalise('Social Circle'));
        expect(host.textContent).toContain(pseudoLocalise('Request to Join'));
        expect(bypassing(), 'the form').toEqual([]);
    });

    it('Groups with none yet, and Groups the node could not answer', async () => {
        net.answer = community({ fetchYourGroups: { items: [], totalUnread: 0 } });
        await renderIn('xx');
        await pane('Groups');
        expect(host.textContent).toContain(pseudoLocalise('No groups yet'));
        expect(bypassing(), 'empty').toEqual([]);

        act(() => root.unmount());
        root = createRoot(host);
        yourGroupsStore.reset();
        net.answer = community({ fetchYourGroups: new Error('') });
        await renderIn('xx');
        await pane('Groups');
        expect(host.textContent).toContain(pseudoLocalise('Could not load your groups.'));
        expect(host.textContent).toContain(pseudoLocalise('Try again'));
        expect(bypassing(), 'error').toEqual([]);
    });

    it('People: friends and who added you, the community list with its sorts, invites with a request to join', async () => {
        knocks.list = KNOCKS;
        await renderIn('xx');
        await pane('People');
        await click(buttonWithText(pseudoLocalise('👫 Friends')), 'Friends');
        expect(host.textContent).toContain('Rosa');
        expect(host.textContent).toContain(pseudoLocalise('Added recently'));
        expect(bypassing(), 'friends').toEqual([]);
        await click(buttonWithText(pseudoLocalise('🏘️ Community')), 'Community');
        expect(host.textContent).toContain('Zoe');
        expect(host.textContent).toContain(pseudoLocalise('Joined today'));
        expect(bypassing(), 'community').toEqual([]);
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith(pseudoLocalise('🎟️ Invites ({n})').slice(0, 6))) ?? null, 'Invites');
        expect(host.textContent).toContain('I grow tomatoes');
        expect(host.textContent).toContain(pseudoLocalise('📤 Invite Someone'));
        expect(bypassing(), 'invites').toEqual([]);
    });

    it('People\'s requests to join: in English exactly as knock-inbox writes them (it stays off the words layer); a community out of reach, in the member\'s language', async () => {
        knocks.list = KNOCKS;
        await renderIn('en');
        await pane('People');
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith('🎟️ Invites')) ?? null, 'Invites');
        expect(host.textContent).toContain(`🚪 ${wantsToJoinTitle(1)}`);
        expect(host.textContent).toContain(WANTS_TO_JOIN_HELP);
        expect(host.textContent).toContain(joinRequestMeta(KNOCKS[0]));

        act(() => root.unmount());
        root = createRoot(host);
        knocks.unreachable = true;
        await renderIn('xx');
        await pane('People');
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith(pseudoLocalise('🎟️ Invites').slice(0, 6))) ?? null, 'Invites');
        expect(host.textContent).toContain(pseudoLocalise("Couldn't reach your community. Check your connection and try again."));
        expect(bypassing()).toEqual([]);
    });

    it('the worldwide community\'s People, the communities this phone asked to join: the phone\'s notes in the member\'s language in every state; a community\'s own refusal as it sent it', async () => {
        store.map.set('beanpool_knocks', JSON.stringify({ pubkey: ME.publicKey, knocks: ASKED.map((a, i) => ({ url: a.url, name: a.name, key: null, sentAt: iso(now - i * DAY) })) }));
        for (const a of ASKED) {
            knockReads.answers.set(a.url, async () => {
                if (a.answer === 'unreachable') throw new Error('offline');
                return new Response(JSON.stringify(a.answer.body), { status: a.answer.status });
            });
        }
        const notes = [KNOCK_MESSAGES.waiting, KNOCK_MESSAGES.invited, KNOCK_MESSAGES.none, KNOCK_MESSAGES.unreachable, KNOCK_MESSAGES.unreadable];

        await renderIn('en', createElement(MyJoinRequests, { identity: ME as any }));
        for (const a of ASKED) expect(host.textContent).toContain(a.name);
        for (const note of notes) expect(host.textContent, note).toContain(note);
        expect(host.textContent).toContain(CLOSED_WORDS);

        act(() => root.unmount());
        root = createRoot(host);
        await renderIn('xx', createElement(MyJoinRequests, { identity: ME as any }));
        for (const note of notes) {
            expect(host.textContent, note).toContain(pseudoLocalise(note));
            expect(host.textContent, note).not.toContain(note);
        }
        expect(host.textContent).toContain(CLOSED_WORDS);
        expect(bypassing()).toEqual([]);
    });

    it('People as a guest: registration and the troubleshooting card; at the global community, its door', async () => {
        membership.isMember = false;
        await renderIn('xx');
        await pane('People');
        await click(buttonWithText(pseudoLocalise('🎟️ Register')), 'Register');
        expect(host.textContent).toContain(pseudoLocalise('⚠️ Guest Connection Mode'));
        expect(host.textContent).toContain(pseudoLocalise('🛠️ Connection Troubleshooting'));
        expect(bypassing(), 'a guest').toEqual([]);

        act(() => root.unmount());
        root = createRoot(host);
        rememberProfile('global', { invites: false, wordsDoor: true, knocks: false, membersOnDemand: true });
        globalDoor.here = true;
        globalDoor.entry = 'join';
        await renderIn('xx');
        await pane('People');
        await click(buttonWithText(pseudoLocalise('🎟️ Register')), 'Register');
        expect(host.textContent).toContain(pseudoLocalise('🌍 Join with 12 words or a sign-in'));
        expect(bypassing(), 'the global door').toEqual([]);
    });

    it('the New message picker', async () => {
        await renderIn('xx', createElement(NewMessageScreen));
        expect(host.textContent).toContain('Kofi');
        expect(host.textContent).toContain(pseudoLocalise('💬 Recently Chatted'));
        expect(bypassing()).toEqual([]);
    });

    it("the New message picker, a conversation the node won't open (a paused account): its words, never nothing", async () => {
        net.answer = community({ createConversationApi: new Error(PAUSED_OPEN_WORDS) });
        await renderIn('xx', createElement(NewMessageScreen));
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Zoe')) ?? null, "Zoe's row");
        expect(net.calls).toContain('db.createConversationApi');
        expect(alerts.said).toEqual([pseudoLocalise('Error'), PAUSED_OPEN_WORDS]);
        expect(bypassing()).toEqual([]);
    });

    it('the New message picker, offline: the phone says to connect, in the member\'s language', async () => {
        net.answer = community({ createConversationApi: new Error('You are off-grid. Please connect to a node first.') });
        await renderIn('xx', createElement(NewMessageScreen));
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Zoe')) ?? null, "Zoe's row");
        expect(alerts.said).toEqual([pseudoLocalise('Error'), pseudoLocalise('Connect to your community to start a chat.')]);
        expect(bypassing()).toEqual([]);
    });

    it("the New message picker, a refusal without the node's words: the phone's own sentence, in the member's language", async () => {
        net.answer = community({ createConversationApi: new Error('Failed to create conversation thread.') });
        await renderIn('xx', createElement(NewMessageScreen));
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Zoe')) ?? null, "Zoe's row");
        expect(net.calls).toContain('db.createConversationApi');
        expect(alerts.said).toEqual([pseudoLocalise('Error'), pseudoLocalise('Failed to create conversation thread.')]);
        expect(bypassing()).toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        await renderIn('en');
        expect(bracketed()).toBe(0);
        expect(host.textContent).toContain('Action Required');
        expect(host.textContent).toContain('Release Credits (1)');
        expect(host.textContent).toContain('HELD IN TRUST');
        expect(host.textContent).toContain('5 Beans held in trust.');
        expect(host.textContent).toContain('Started conversation');
        expect(byLabel('Search chats, posts, partners')).not.toBeNull();
        await pane('Groups');
        // A muted chat adds nothing to the switch's total (WhatsApp's rule): Hall roof's one.
        expect(byLabel('Groups, 1 unread')).not.toBeNull();
        expect(byLabel('Bakery, enterprise, lead keeper, 3 unread, muted. Kofi: bread at six')).not.toBeNull();
        expect(byLabel('Hall roof, project, collaborator, 1 unread. You: tiles ordered')).not.toBeNull();
        expect(byLabel('Garden club, group, convenor. New group · invite people to get started')).not.toBeNull();
    });
});

// ── 320 dp with text at 1.3×: longer languages never push words past an edge (checked with the pseudo-locale) ─────────
const FLOOR = 320;
const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);

const layoutOf = (el: Element): Record<string, number | string> => JSON.parse(el.getAttribute('data-layout') ?? '{}');
/**
 * How far each pill's text must shrink (1 = drawn full size) to stay on one line, with the row laid out as Yoga does it:
 * a pill's size before sharing is its flex-basis (its text when it has none) plus padding and border; free space goes by
 * flex-grow, a shortfall comes off by flex-shrink × that size. `labelDp` is each label's one-line width at full size.
 */
function scalesInRow(row: Element, pills: Element[], labelDp: number[]): number[] {
    const inner = FLOOR - 2 * Number(layoutOf(row).padding ?? 0);
    const items = pills.map((pill, i) => {
        const l = layoutOf(pill);
        // React Native: flex: n is flexGrow n, flexShrink 1 and flexBasis 0; a pill with none of them neither grows nor shrinks.
        const frame = 2 * Number(l.paddingHorizontal ?? 0) + 2 * Number(l.borderWidth ?? 0);
        const content = l.flexBasis !== undefined ? Number(l.flexBasis) : l.flex ? 0 : labelDp[i];
        return { grow: Number(l.flexGrow ?? l.flex ?? 0), shrink: Number(l.flexShrink ?? (l.flex ? 1 : 0)), frame, base: content + frame, margin: 2 * Number(l.marginHorizontal ?? 0) };
    });
    const free = inner - items.reduce((n, it) => n + it.base + it.margin, 0);
    const growth = items.reduce((n, it) => n + it.grow, 0);
    const weight = items.reduce((n, it) => n + it.shrink * it.base, 0);
    return items.map((it, i) => {
        const share = free >= 0 ? (growth ? (free * it.grow) / growth : 0) : weight ? (free * it.shrink * it.base) / weight : 0;
        return Math.min(1, Math.max(0, it.base + share - it.frame) / labelDp[i]);
    });
}

describe('Talk at 320 dp with 1.3× text, in the pseudo-locale', () => {
    it('the Messages / Groups / People switch: each name one line in its third, shrinking to fit', async () => {
        await renderIn('xx');
        const tabs = Array.from(host.querySelectorAll('[role="radio"]'));
        expect(tabs.length).toBe(3);
        // 16 dp gutters, 3 dp padding and gaps, 4 dp padding in each tab.
        const third = (FLOOR - 32 - 6 - 6) / 3 - 8;
        for (const tab of tabs) {
            const label = tab.querySelector('span[data-shrinks]')!;
            expect(label.getAttribute('data-lines')).toBe('1');
            const min = Number(label.getAttribute('data-min-scale'));
            expect(widthOf(label.textContent!, 13 * SCALE) * min, label.textContent!).toBeLessThanOrEqual(third);
        }
    });

    it('People\'s sub-nav names stay on one line and shrink together to fit the row; its sorts wrap rather than run past the edge', async () => {
        rememberProfile('local', { ...LOCAL, membersOnDemand: false });
        await renderIn('xx');
        await pane('People');
        const row = buttonWithText(pseudoLocalise('🏘️ Community'))!.parentElement!;
        const pills = Array.from(row.children);
        expect(pills.length).toBe(3);
        const labels = pills.map((p) => p.querySelector(':scope > span[data-shrinks]')!);
        // One line, and the whole name inside its pill. On one line a word cannot break, so the longest-word check below only
        // fails when the name is cut by more than its own length; the real rule is that the pill leaves the name at least its
        // smallest shrink (`scales[i] \u2265 min-scale`), or RN ellipsizes it. The pseudo-locale is a stress case, 35% longer than
        // any real language, and misses that floor by a hair (0.5947 against 0.6 for the Community name, 0.5976 for the others);
        // the real languages are held to the floor exactly in the next describe. So allow PSEUDO_SLACK: a change that cuts more
        // than a hair of a name fails here.
        const PSEUDO_SLACK = 0.01;
        const dp = labels.map((l) => widthOf(l.textContent!, 11 * SCALE));
        const scales = scalesInRow(row, pills, dp);
        labels.forEach((label, i) => {
            expect(label.getAttribute('data-lines')).toBe('1');
            const longest = label.textContent!.split(/[\s\u200B]+/).reduce((a, b) => (widthOf(b, 1) > widthOf(a, 1) ? b : a), '');
            expect(widthOf(longest, 11 * SCALE) * Number(label.getAttribute('data-min-scale')), longest).toBeLessThanOrEqual(scales[i] * dp[i]);
            expect(scales[i], `name ${i + 1}`).toBeGreaterThanOrEqual(Number(label.getAttribute('data-min-scale')) - PSEUDO_SLACK);
        });
        await click(buttonWithText(pseudoLocalise('🏘️ Community')), 'Community');
        const sorts = buttonWithText(pseudoLocalise('Newest'))?.parentElement ?? Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(pseudoLocalise('Newest')))!.parentElement!;
        expect(sorts.getAttribute('data-wrap')).toBe('wrap');
    });

    it('the drawer\'s chips wrap; the Groups pane\'s two buttons wrap and their words shrink', async () => {
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Filter and sort')), 'Filter and sort');
        const chip = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === pseudoLocalise('Credits: High'))!;
        expect(chip.parentElement!.getAttribute('data-wrap')).toBe('wrap');
        await pane('Groups');
        const newGroup = byLabel(pseudoLocalise('New group'))!;
        expect(newGroup.querySelector('span[data-shrinks]')!.getAttribute('data-lines')).toBe('1');
    });
});

/**
 * People's three sub-tabs at 320 dp with text at 1.3×, in all 25 languages (Marty, 28 Oct, Android 1.2.83: the middle tab read
 * as a lone 🏘️, its word gone). Widths are each label measured as Android draws it (people-pill-widths.json, from
 * scripts/words/measure-people-pills.mjs); the row is the real screen's styles, laid out as Yoga does. English's
 * "🏘️ Community" is 6.69 em: ~96 dp, more than the ~94 dp an equal third of the row gave it, so it wrapped.
 */
describe('People\'s sub-nav at 320 dp with 1.3× text, in every language', () => {
    const FONT = 11 * SCALE;
    // The smallest a label may be drawn: 0.8 of its 11 sp, as the tab strip allows (8.8 dp, still readable).
    const READABLE = (0.8 * 11) / FONT;
    const measured: { widths: Record<string, Record<string, number>> } = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'people-pill-widths.json'), 'utf8'));
    const NATIVE_WORDS = path.resolve(__dirname, '../../words');
    const COUNT = '🎟️ Invites ({n})';

    /**
     * The row as drawn with each of its three tabs selected in turn: the sub-nav, its tabs, and the layout each carries.
     * React keeps the three tabs mounted, so each click rewrites the same nodes: the row is copied at the moment of the click,
     * or all three entries would carry the layout of the last selection (review 4408169606).
     */
    async function drawnRows() {
        rememberProfile('local', { ...LOCAL, membersOnDemand: false });
        await renderIn('en');
        await pane('People');
        const rows: Array<{ row: Element; pills: Element[]; texts: string[]; lines: string[]; minScale: number[] }> = [];
        for (const name of ['👫 Friends', '🏘️ Community', '🎟️ Invites']) {
            await click(buttonWithText(name), name);
            const live = buttonWithText(name)!.parentElement!;
            const labels = Array.from(live.children).map((p) => p.querySelector(':scope > span[data-shrinks]')!);
            const row = live.cloneNode(true) as Element;
            const pills = Array.from(row.children);
            rows.push({
                row, pills,
                texts: labels.map((l) => l.textContent!),
                lines: labels.map((l) => l.getAttribute('data-lines')!),
                minScale: labels.map((l) => Number(l.getAttribute('data-min-scale'))),
            });
        }
        // The selected tab carries the 1 dp border (+ 2 dp of frame). Read after the last click, each copy must still show its own.
        rows.forEach(({ pills }, selected) => {
            expect(pills.map((p) => layoutOf(p).borderWidth !== undefined), `bordered tab with tab ${selected + 1} selected`).toEqual([0, 1, 2].map((i) => i === selected));
        });
        return rows;
    }
    const emOf =(lang: string, label: string) => {
        const em = measured.widths[lang]?.[label];
        if (em === undefined) throw new Error(`${lang}: no measured width for "${label}"; run scripts/words/measure-people-pills.mjs`);
        return em;
    };

    it('English: all three names whole, on one line, at full size, whichever tab is selected', async () => {
        for (const { row, pills, texts, lines } of await drawnRows()) {
            expect(texts).toEqual(['👫 Friends', '🏘️ Community', '🎟️ Invites']);
            // The third tab also reads "🎟️ Invites ({n})" with requests waiting, and "🎟️ Register" for a guest: the widest of them.
            const invites = Math.max(...['🎟️ Invites', COUNT, '🎟️ Register'].map((l) => emOf('en', l)));
            const dp = [emOf('en', '👫 Friends'), emOf('en', '🏘️ Community'), invites].map((em) => em * FONT);
            // Each name has the width it needs, so none wraps (the emoji alone on a line) or shrinks.
            expect(scalesInRow(row, pills, dp)).toEqual([1, 1, 1]);
            expect(lines).toEqual(['1', '1', '1']);
        }
    });

    it('every language: each name on one line, shrunk no further than it stays readable, whichever tab is selected', async () => {
        const rows = await drawnRows();
        const languages = ['en', ...fs.readdirSync(NATIVE_WORDS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()];
        expect(languages.length).toBe(25);
        expect(Object.keys(measured.widths).sort()).toEqual([...languages].sort());
        for (const lang of languages) {
            const catalog: Record<string, string | Record<string, string>> = lang === 'en' ? {} : JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, `${lang}.json`), 'utf8'));
            const word = (english: string) => (lang === 'en' ? english : (catalog[english] as string));
            const counts: string[] = lang === 'en' ? [COUNT] : Array.from(new Set(Object.values(catalog[`${COUNT}|${COUNT}`] as Record<string, string>)));
            const em = [
                emOf(lang, word('👫 Friends')),
                emOf(lang, word('🏘️ Community')),
                Math.max(...[word('🎟️ Invites'), word('🎟️ Register'), ...counts].map((l) => emOf(lang, l))),
            ];
            for (const { row, pills, minScale } of rows) {
                const scales = scalesInRow(row, pills, em.map((e) => e * FONT));
                scales.forEach((scale, i) => {
                    expect(scale, `${lang}, name ${i + 1}`).toBeGreaterThanOrEqual(Math.max(minScale[i], READABLE));
                });
            }
        }
    });
});

describe('Talk follows a language picked in Settings', () => {
    const NATIVE_WORDS = path.resolve(__dirname, '../../words');
    const fr = JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, 'fr.json'), 'utf8')) as Record<string, string>;
    const MENU = { menuBtn: {}, menuIconWrap: {}, menuIcon: {}, menuText: {}, menuSub: {}, menuChevron: {} };

    it('a pick redraws it in the new language: a changed key\'s tag and its spoken words, with nothing by hand', async () => {
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(LanguageRow as any, { styles: MENU }), createElement(ChatsScreen))) as any);
        });
        await settle();
        expect(host.textContent).toContain('key changed');
        expect(byLabel('The key behind this chat changed')).not.toBeNull();
        await click(host.querySelector('[data-testid="settings-language"]'), 'Settings → Language');
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        expect(fr['key changed']).toBeTruthy();
        expect(fr['The key behind this chat changed']).toBeTruthy();
        expect(host.textContent).toContain(fr['key changed']);
        expect(byLabel(fr['The key behind this chat changed'])).not.toBeNull();
        expect(byLabel('The key behind this chat changed')).toBeNull();
        expect(host.textContent).toContain('Kofi');
    });
});

// PR #2540 review 4395541801: the push tap ("Someone new wants to message you") opens Requests without looking, and Talk drew
// the Requests pane whenever that filter was on, while its All and Requests pills draw only with a list kept for this
// community. With none (a community not synced yet, after Sign Out or Replace, or requests off on the node), the member
// had the empty Requests card, no pills and no chats, until a sync kept a list. The web guards this (MessagesPage.tsx).
describe('Talk opened on Requests (review 4395541801)', () => {
    const NO_REQUESTS = "No requests. A first message from someone you haven't added or talked to arrives here.";
    const ROSA_ASKS = { count: 1, conversations: [{ id: 'req-rosa', peerCallsign: 'Rosa', participants: [ME.publicKey, 'rosa-key'], request: { state: 'pending', from: 'rosa-key', at: iso(now - 60_000) } }] };

    it('no list kept for this community: the chats are drawn, not an empty Requests with no way back', async () => {
        params.now = { filter: 'requests' };
        net.answer = community({ getMessageRequests: null });
        await renderIn('en');

        expect(host.textContent).not.toContain(NO_REQUESTS);
        expect(host.textContent).toContain(MEMBER_WRITES_A_TABLE_SENTENCE);
    });

    it('while the kept list is still being read, the chats are drawn', async () => {
        params.now = { filter: 'requests' };
        await renderIn('en');

        expect(net.calls).toContain('db.getMessageRequests');
        expect(host.textContent).not.toContain(NO_REQUESTS);
        expect(host.textContent).toContain(MEMBER_WRITES_A_TABLE_SENTENCE);
    });

    it('control: with a list kept, the tap opens Requests on its card, with the pills to go back to All', async () => {
        params.now = { filter: 'requests' };
        net.answer = community({ getMessageRequests: ROSA_ASKS });
        await renderIn('en');

        expect(host.textContent).toContain('1 person wants to message you');
        expect(host.textContent).not.toContain(MEMBER_WRITES_A_TABLE_SENTENCE);
        await click(buttonWithText('All'), 'the All pill');
        expect(host.textContent).toContain(MEMBER_WRITES_A_TABLE_SENTENCE);
    });
});
