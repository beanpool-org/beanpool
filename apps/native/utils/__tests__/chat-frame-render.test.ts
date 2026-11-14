// @vitest-environment jsdom
/**
 * The Chat tab's new top (slice T0; scratch/fable-design/DESIGN-forums-messaging-joint-fable.md §2.1, Marty's answers to
 * questions 1 and 3): app/(tabs)/chats.tsx rendered for real, on a phone 320 dp wide and 569 dp tall with text at 1.3x.
 *
 * - Where the community's forum is on (`features.forum`), the Chats · Forum switch takes the big "Chat" title's place, and
 *   under Chats nothing moves: Messages · Groups · People, the search row, the conversations.
 * - The Forum side is the forum's empty pane (slice F3 fills it): no chat list, no search, no Messages · Groups · People.
 * - Where the owners switched it off, or the server is from before the forum, there is no switch: the title "Chat", as before.
 * - **No height added** (the design's own claim, "T0's render test at 320 x 569 x 1.3 is the proof"): the switch's row is no
 *   taller than the title's row it replaces, read from the styles the screen really draws with.
 * - Both names fit their half of the row in every language, shrinking no further than the switch allows.
 *
 * React Native's host components are plain tags carrying their accessibility props and the few layout props the checks read
 * (copied from talk-words-render.test.ts, with the tab roles and each row's height parts added).
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
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', progressbar: 'progressbar', tab: 'tab', tablist: 'tablist' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, accessibilityState, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, maxFontSizeMultiplier, horizontal, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (disabled) attrs.disabled = true;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        if (maxFontSizeMultiplier !== undefined) attrs['data-max-scale'] = String(maxFontSizeMultiplier);
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(!!accessibilityState.selected);
        if (horizontal) attrs['data-horizontal'] = 'true';
        const s = flat(props.style);
        if (s.flexWrap) attrs['data-wrap'] = s.flexWrap;
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        // What Yoga lays a row out from: read by the sub-nav's 320 dp check.
        const layout: Record<string, unknown> = {};
        for (const k of ['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'padding', 'paddingHorizontal', 'marginHorizontal', 'borderWidth']) if (s[k] !== undefined) layout[k] = s[k];
        if (Object.keys(layout).length) attrs['data-layout'] = JSON.stringify(layout);
        // What a row's height is made of: read by the frame's no-added-height check.
        const box: Record<string, unknown> = {};
        for (const k of ['minHeight', 'height', 'marginTop', 'marginBottom', 'paddingTop', 'paddingBottom', 'paddingVertical', 'lineHeight', 'position']) if (s[k] !== undefined) box[k] = s[k];
        if (Object.keys(box).length) attrs['data-box'] = JSON.stringify(box);
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
/** The Chat route's params, as expo-router keeps them for a mounted tab: a push or setParams changes them in place, and every
 *  screen reading them (Talk, and People inside it) draws again. */
const params = vi.hoisted(() => ({ now: {} as Record<string, string>, heard: new Set<() => void>() }));
const setRouteParams = vi.hoisted(() => (next: Record<string, string>) => { params.now = next; for (const draw of [...params.heard]) draw(); });
/** Who listens for the tab bar's own tap (components/PageTitle useTabRetapScrollTop): the tap test fires it as the bar does. */
const tabPress = vi.hoisted(() => ({ heard: new Set<() => void>() }));
vi.mock('expo-router', async () => {
    const { useEffect: effect, useSyncExternalStore } = await import('react');
    const listen = (draw: () => void) => { params.heard.add(draw); return () => { params.heard.delete(draw); }; };
    return {
        router: {
            push() {}, navigate() {}, replace() {}, back() {}, canGoBack: () => true,
            setParams: (p: Record<string, string>) => setRouteParams({ ...params.now, ...p }),
        },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({
            addListener: (event: string, cb: () => void) => {
                if (event !== 'tabPress') return () => {};
                tabPress.heard.add(cb);
                return () => { tabPress.heard.delete(cb); };
            },
            isFocused: () => true,
        }),
        useLocalSearchParams: () => useSyncExternalStore(listen, () => params.now),
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
const openNoticeCalls = vi.hoisted(() => ({ calls: [] as Array<{ url: string; id: string | null; route: unknown }> }));
vi.mock('../push-notice-switch', async (importOriginal) => {
    const orig = await importOriginal<Record<string, unknown>>();
    return {
        ...orig,
        openNoticeIn: vi.fn(async (url: string, id: string | null, route: unknown) => {
            openNoticeCalls.calls.push({ url, id, route });
            return 'switched';
        }),
    };
});

import { CHAT_SIDES, PUSH_NOTICE_KINDS, pseudoLocalise, setLanguage, t, type PushNoticeKind, type UiLang } from '@beanpool/core';
import { followTap, noticeRoute, UNREAD_NOTICE_TYPE, type NoticeRoute } from '../push-notice-check';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LanguageProvider } from '../../components/LanguageProvider';
import { yourGroupsStore } from '../../components/useYourGroups';
// People asks where the member is to end a Show credit visit (utils/people-visit.ts; its own test and people-show-credit-visit-render.test.ts): nothing here leaves the tab.
vi.mock('../people-visit', () => ({ usePeopleVisitEnds: () => 0 }));
import ChatsScreen from '../../app/(tabs)/chats';

const NODE = 'https://riverside.example';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const CONVERSATIONS = [
    { id: 'c-kofi', type: 'dm', peer: 'Kofi', peerPubkey: 'kofi-key', lastMessage: 'see you at the hall', lastMessageFromApp: false, rawTimestamp: iso(now - 60_000), unread: 1 },
];

type Answers = Record<string, unknown>;
function community(over: Answers = {}): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Answers = {
        getConversations: CONVERSATIONS, getActionableDeals: [], syncMessages: undefined, getFriendsLocal: [],
        fetchYourGroups: { items: [], totalUnread: 0 }, fetchAddedYou: { addedYou: [], more: 0 }, getRecentChatMembers: [],
        getDb: { getAllAsync: async () => [], getFirstAsync: async () => null, runAsync: async () => ({}) },
        ...over,
    };
    return (name) => {
        if (!(name in answers)) return undefined;
        const a = answers[name];
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    };
}
function rememberProfile(features: Record<string, unknown>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features, checkedAt: new Date().toISOString() } }));
}
const LOCAL = { beans: true, escrow: true, invites: true, knocks: true, showcase: false };
/** A local community as a 1.4.x server says it: its forum on, members only (Marty's answer to question 3, 14 Nov 2026). */
const WITH_FORUM = { ...LOCAL, forum: true };

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
    yourGroupsStore.reset();
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(ChatsScreen)) as any); });
    await settle();
}
/** A new screen, as opening the tab again would draw it (the profile is read when the screen comes into focus). */
async function reopenIn(lang: UiLang) {
    act(() => root.unmount());
    root = createRoot(host);
    await renderIn(lang);
}
/** A way in from elsewhere pushing the Chat tab with these params while the tab stays mounted (a notice, Home's "All N
 *  groups", the needs-you rows). */
const pushChat = async (next: Record<string, string>) => {
    await act(async () => { setRouteParams({ ...next }); });
    await settle(4);
};
/** A notice's route pushed onto the mounted tab: its query becomes the tab's params, as expo-router's jump to a tab (JUMP_TO)
 *  replaces them, so a route with no query leaves the tab with none. */
const pushRoute = async (route: NoticeRoute) => {
    const [where, query = ''] = route.split('?');
    expect(where, route).toBe('/(tabs)/chats');
    await pushChat(Object.fromEntries(new URLSearchParams(query)));
};
/** The tab bar's own tap on the Chat tab while it shows: tabPress, then the same route with its params as they are (the bar's
 *  CommonActions.navigate(route)), so nothing in them changes. */
const tapTab = async () => {
    await act(async () => { for (const heard of [...tabPress.heard]) heard(); setRouteParams(params.now); });
    await settle(4);
};
const click = async (el: Element | null, what: string) => {
    expect(el, what).not.toBeNull();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};

const tablist = () => host.querySelector('[role="tablist"]');
const tabs = () => Array.from(host.querySelectorAll('[role="tab"]'));
const side = (name: string) => tabs().find((tb) => tb.getAttribute('aria-label') === name) ?? null;
const selected = (els: Element[]) => els.map((el) => el.getAttribute('aria-selected'));
const radios = () => Array.from(host.querySelectorAll('[role="radio"]'));
const radio = (name: string) => radios().find((r) => r.querySelector('span')?.textContent === name) ?? null;
/** The big title "Chat" (components/PageTitle), however many other headings a pane draws. */
const chatTitle = () => Array.from(host.querySelectorAll('[role="heading"]')).find((h) => h.textContent === 'Chat') ?? null;
const forumPane = () => host.querySelector('[data-testid="forum-pane"]');
const search = () => host.querySelector('input[placeholder="Search chats, posts, partners..."]');

describe('the Chat tab where the forum is on: Chats · Forum in the title\'s place', () => {
    it('opens on Chats: the switch, then Messages · Groups · People, the search row and the conversations, and no title', async () => {
        rememberProfile(WITH_FORUM);
        await renderIn('en');
        expect(tablist()?.getAttribute('aria-label')).toBe('Chat');
        expect(tabs().map((tb) => tb.textContent)).toEqual(['Chats', 'Forum']);
        expect(selected(tabs())).toEqual(['true', 'false']);
        expect(chatTitle()).toBeNull();
        // Under Chats nothing moves.
        expect(radios().map((r) => r.querySelector('span')?.textContent)).toEqual(['Messages', 'Groups', 'People']);
        expect(search()).not.toBeNull();
        expect(host.textContent).toContain('Kofi');
        expect(forumPane()).toBeNull();
        // Above Messages · Groups · People, where the title was; the smoke flow's selector stays on the tab's top.
        expect(tablist()!.compareDocumentPosition(radios()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(host.querySelector('[data-testid="page-title-talk"]')).toBe(tablist());
    });

    it('Forum: the forum\'s empty pane under the switch, with no chat list, search or Messages · Groups · People; Chats brings them back', async () => {
        rememberProfile(WITH_FORUM);
        await renderIn('en');
        await click(side('Forum'), 'Forum');
        expect(selected(tabs())).toEqual(['false', 'true']);
        expect(forumPane()).not.toBeNull();
        // Empty: slice F3 fills it.
        expect(forumPane()!.childNodes.length).toBe(0);
        expect(radios()).toEqual([]);
        expect(search()).toBeNull();
        expect(host.textContent).not.toContain('Kofi');
        expect(chatTitle()).toBeNull();
        await click(side('Chats'), 'Chats');
        expect(selected(tabs())).toEqual(['true', 'false']);
        expect(radios().length).toBe(3);
        expect(search()).not.toBeNull();
        expect(host.textContent).toContain('Kofi');
        expect(forumPane()).toBeNull();
    });

    it('Groups and People keep the switch on top, in the title\'s place', async () => {
        rememberProfile(WITH_FORUM);
        await renderIn('en');
        for (const name of ['Groups', 'People']) {
            await click(radio(name), name);
            expect(radio(name)?.getAttribute('aria-selected'), name).toBe('true');
            expect(tabs().map((tb) => tb.textContent), name).toEqual(['Chats', 'Forum']);
            expect(selected(tabs()), name).toEqual(['true', 'false']);
            expect(chatTitle(), name).toBeNull();
            expect(tablist()!.compareDocumentPosition(radios()[0]) & Node.DOCUMENT_POSITION_FOLLOWING, name).toBeTruthy();
        }
    });

    it('a way into Chat that names a pane (a notice, the header\'s icons) lands on Chats from the Forum side', async () => {
        rememberProfile(WITH_FORUM);
        await renderIn('en');
        await click(side('Forum'), 'Forum');
        params.now = { view: 'groups' };
        await renderIn('en');
        expect(selected(tabs())).toEqual(['true', 'false']);
        expect(forumPane()).toBeNull();
        expect(radio('Groups')?.getAttribute('aria-selected')).toBe('true');

        await click(side('Forum'), 'Forum');
        params.now = { filter: 'unread' };
        await renderIn('en');
        expect(selected(tabs())).toEqual(['true', 'false']);
        expect(forumPane()).toBeNull();
    });

    it('the same pane pushed again after a Forum tap lands on Chats again: the view is taken once read (Home\'s "All N groups" twice)', async () => {
        rememberProfile(WITH_FORUM);
        await renderIn('en');
        const names: Record<string, string> = { groups: 'Groups', people: 'People', messages: 'Messages' };
        const left: string[] = [];
        // Each pushed twice, a Forum tap before each push: the second push carries exactly what the first did.
        for (const [i, view] of ['groups', 'groups', 'people', 'people', 'messages', 'messages'].entries()) {
            await click(side('Forum'), 'Forum');
            expect(forumPane(), `${view} #${i}: on the Forum before the push`).not.toBeNull();
            await pushChat({ view });
            expect(selected(tabs()), `${view} #${i}`).toEqual(['true', 'false']);
            expect(forumPane(), `${view} #${i}`).toBeNull();
            expect(radio(names[view])?.getAttribute('aria-selected'), `${view} #${i}`).toBe('true');
            left.push(params.now.view);
        }
        // Taken each time: the next push of the same view is a change again.
        expect(left).toEqual(['', '', '', '', '', '']);
    });

    it('the phone\'s own "messages waiting" notice, tapped after a Forum tap, lands on Chats, on Messages, each time (review of #3146)', async () => {
        rememberProfile(WITH_FORUM);
        await renderIn('en');
        await click(radio('Groups'), 'Groups');
        const went: NoticeRoute[] = [];
        for (const i of [1, 2]) {
            await click(side('Forum'), 'Forum');
            expect(forumPane(), `tap ${i}: on the Forum before it`).not.toBeNull();
            // The notice the app posts itself when messages wait at a community it keeps (utils/other-communities-unread.ts),
            // here the one in use, so no switch: followTap hands its route to the router, as services/push-notifications.ts does.
            await followTap({ identifier: `n${i}`, remote: false, title: 'BeanPool', body: 'x', data: { type: UNREAD_NOTICE_TYPE, url: NODE } }, {
                storage: AsyncStorage, account: ME,
                openIn: async () => { throw new Error('the community in use needs no switch'); },
            }, (route) => { went.push(route); });
            expect(went, `tap ${i}`).toHaveLength(i);
            await pushRoute(went[i - 1]);
            expect(selected(tabs()), `tap ${i}`).toEqual(['true', 'false']);
            expect(forumPane(), `tap ${i}`).toBeNull();
            expect(radio('Messages')?.getAttribute('aria-selected'), `tap ${i}`).toBe('true');
            expect(host.textContent, `tap ${i}`).toContain('Kofi');
        }
    });

    it('a chat notice whose details never came (every kind for the Chat tab), tapped or opened from the bell after a Forum tap, lands on Chats (review of #3146)', async () => {
        rememberProfile(WITH_FORUM);
        await renderIn('en');
        const chatKinds = (Object.keys(PUSH_NOTICE_KINDS) as PushNoticeKind[]).filter((k) => PUSH_NOTICE_KINDS[k].tab === 'chats');
        expect(chatKinds.sort()).toEqual(['chat.group', 'chat.mention', 'chat.message', 'group.lead']);
        for (const kind of chatKinds) {
            await click(side('Forum'), 'Forum');
            expect(forumPane(), `${kind}: on the Forum before it`).not.toBeNull();
            // What followTap lands on when the community's answer timed out, and the bell's Open (components/NeedsYouIcons.tsx).
            await pushRoute(noticeRoute(kind, null));
            expect(selected(tabs()), kind).toEqual(['true', 'false']);
            expect(forumPane(), kind).toBeNull();
            expect(host.textContent, kind).toContain('Kofi');
        }
    });

    it('the tab\'s own tap keeps the side the member chose: Forum stays Forum, before and after a way in took the view', async () => {
        rememberProfile(WITH_FORUM);
        await renderIn('en');
        await click(side('Forum'), 'Forum');
        await tapTab();
        expect(tabPress.heard.size, 'the screen listens for the tab bar\'s tap').toBeGreaterThan(0);
        expect(selected(tabs())).toEqual(['false', 'true']);
        expect(forumPane()).not.toBeNull();
        // A way in that named Messages, then the member's own Forum tap, then the tab's tap again: still Forum.
        await pushChat({ view: 'messages' });
        expect(selected(tabs())).toEqual(['true', 'false']);
        await click(side('Forum'), 'Forum');
        await tapTab();
        expect(selected(tabs())).toEqual(['false', 'true']);
        expect(forumPane()).not.toBeNull();
    });

    it('People\'s own views in the param (friends, community, invites) are left for People to read', async () => {
        rememberProfile(WITH_FORUM);
        await renderIn('en');
        await click(radio('People'), 'People');
        await pushChat({ view: 'invites' });
        expect(params.now.view).toBe('invites');
        expect(radio('People')?.getAttribute('aria-selected')).toBe('true');
    });

    it('in the pseudo-locale: the two names and the switch\'s spoken name came through t()', async () => {
        rememberProfile(WITH_FORUM);
        await renderIn('xx');
        const names = CHAT_SIDES.map((s) => t(s.label));
        expect(names).toEqual([pseudoLocalise('Chats'), pseudoLocalise('Forum')]);
        expect(tabs().map((tb) => tb.textContent)).toEqual(names);
        expect(tabs().map((tb) => tb.getAttribute('aria-label'))).toEqual(names);
        expect(tablist()?.getAttribute('aria-label')).toBe(pseudoLocalise('Chat'));
    });
});

describe('the Chat tab where the forum is off: the title "Chat", as before', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
        ['switched off by its owners', { ...LOCAL, forum: false }],
        ['a server from before the forum, which says nothing', LOCAL],
    ];
    for (const [what, features] of cases) {
        it(what, async () => {
            rememberProfile(features);
            await renderIn('en');
            expect(tablist()).toBeNull();
            expect(tabs()).toEqual([]);
            const title = host.querySelector('[data-testid="page-title-talk"]');
            expect(title?.getAttribute('role')).toBe('heading');
            expect(title?.textContent).toBe('Chat');
            expect(radios().length).toBe(3);
            expect(search()).not.toBeNull();
            expect(host.textContent).toContain('Kofi');
            expect(forumPane()).toBeNull();
        });
    }
});

// ── 320 dp × 569 dp with text at 1.3×, as the design asks (§2.1: "T0's render test at 320 × 569 × 1.3 is the proof") ──────
const FLOOR = 320;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);
const boxOf = (el: Element): Record<string, number | string> => JSON.parse(el.getAttribute('data-box') ?? '{}');
const layoutOf = (el: Element): Record<string, number | string> => JSON.parse(el.getAttribute('data-layout') ?? '{}');
const num = (v: number | string | undefined) => Number(v ?? 0);
/** A text's line at this text size: its line height scales with the text, up to its own cap (React Native's rule). */
const lineOf = (text: Element, scale: number) => num(boxOf(text).lineHeight) * Math.min(scale, Number(text.getAttribute('data-max-scale') ?? Infinity));

/** The big title's row: its padding above and below and its one line. */
function titleRow(scale: number): number {
    const title = host.querySelector('[data-testid="page-title-talk"]')!;
    const row = boxOf(title.parentElement!);
    return num(row.paddingTop) + lineOf(title, scale) + num(row.paddingBottom);
}
/** The switch's row: its margins and its tallest tab (a tab is its touch row, or its words and padding when taller). */
function switchRow(scale: number): number {
    const bar = tablist()!;
    const tallest = Math.max(...tabs().map((tab) => {
        const label = tab.querySelector('span[data-shrinks]')!;
        const b = boxOf(tab);
        // The underline is drawn inside the touch row, so it adds nothing.
        for (const child of Array.from(tab.children)) if (child !== label) expect(boxOf(child).position).toBe('absolute');
        return Math.max(num(b.minHeight), 2 * num(b.paddingVertical) + lineOf(label, scale));
    }));
    return num(boxOf(bar).marginTop) + tallest + num(boxOf(bar).marginBottom);
}

describe('the Chat tab at 320 dp × 569 dp with text at 1.3×', () => {
    it('no height added: the switch\'s row is no taller than the title\'s row it replaces (at 1.3× text, and at 1×)', async () => {
        rememberProfile(LOCAL);
        await renderIn('en');
        const title = { big: titleRow(1.3), plain: titleRow(1) };
        // 4 dp + its 36 dp line + 8 dp; the line grows with the text, to its 1.3× cap.
        expect(title.plain).toBe(48);
        expect(title.big).toBeCloseTo(58.8, 5);
        const under = { radios: radios().length, search: !!search() };

        rememberProfile(WITH_FORUM);
        await reopenIn('en');
        const sw = { big: switchRow(1.3), plain: switchRow(1) };
        expect(sw.big).toBeLessThanOrEqual(title.big);
        expect(sw.plain).toBeLessThanOrEqual(title.plain);
        expect(sw).toEqual({ big: 48, plain: 48 });
        // And the rows under it are the rows that were under the title: nothing added between the top and the list.
        expect({ radios: radios().length, search: !!search() }).toEqual(under);
    });

    it('both names fit their half of the row in every language, shrinking no further than the switch allows', async () => {
        rememberProfile(WITH_FORUM);
        await renderIn('en');
        const bar = tablist()!;
        const tab = tabs()[0];
        const label = tab.querySelector('span[data-shrinks]')!;
        expect(label.getAttribute('data-lines')).toBe('1');
        const minScale = Number(label.getAttribute('data-min-scale'));
        const px = Number(label.getAttribute('data-font')) * Math.min(1.3, Number(label.getAttribute('data-max-scale') ?? Infinity));
        // Half of the row inside the page's gutters, less the tab's own padding each side.
        const half = (FLOOR - 2 * num(layoutOf(bar).marginHorizontal)) / 2 - 2 * num(layoutOf(tab).paddingHorizontal);
        expect(half).toBe(128);
        const catalogs = path.resolve(__dirname, '../../../../packages/beanpool-core/words');
        const languages = fs.readdirSync(catalogs).filter((f) => /^[a-z]{2,3}(-[A-Za-z]+)?\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')).sort();
        expect(languages.length).toBe(24);
        const sources = ['Chats', 'Forum'];
        const worst: Array<[string, string, number]> = [];
        for (const lang of ['en', ...languages]) {
            const catalog: Record<string, unknown> = lang === 'en' ? {} : JSON.parse(fs.readFileSync(path.join(catalogs, `${lang}.json`), 'utf8'));
            for (const source of sources) {
                const text = lang === 'en' ? source : catalog[`${source}\u0004chat tab side`];
                expect(typeof text === 'string' && text.length > 0, `${lang}: ${source} has a translation`).toBe(true);
                const scale = Math.min(1, half / widthOf(text as string, px));
                worst.push([lang, text as string, scale]);
                expect(scale, `${lang}: "${text}" at 1.3× shrinks to ${scale.toFixed(2)}`).toBeGreaterThanOrEqual(minScale);
            }
        }
        // English draws whole, at full size.
        expect(worst.filter(([lang]) => lang === 'en').map(([, , s]) => s)).toEqual([1, 1]);
    });
});
