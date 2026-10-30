// @vitest-environment jsdom
/**
 * A conversation in the member's language (words slice S3, sweep B2, step 2): app/chat/[id].tsx rendered for real inside
 * the real LanguageProvider, as a direct message (the listing it is about, its deals, the release bar, a trade's lines,
 * a line that didn't open, a reply, a failed send, the photo and delete questions, the ⋮ sheet and its mute choices), as a
 * group's chat (the invite prompt of a new group, a convenor's removal, the ⋮ sheet, the search) and as an event's chat.
 * The shared pieces are drawn for real: the bubbles and their actions, the banners, the composer, the owner header.
 * React Native's host components are plain tags carrying their accessibility props and placeholders; the node is the
 * net-spy stand-in for utils/db.
 *
 * In the pseudo-locale any text, screen-reader label, placeholder or alert (title, body and buttons) with letters
 * outside a bracket bypassed t(). What members wrote is shown as written, and so are the node's own sentences (a group's
 * system lines, an event's notice: slice S4).
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

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', progressbar: 'progressbar' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, onLayout, value, onChangeText, disabled } = props;
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
        DeviceEventEmitter: { addListener: listener, emit() {} },
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
vi.mock('../blocklist', () => ({ isUserBlocked: async () => false, getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
// Which screen /chat/:id draws is utils/chat-route's call (tested there); here the test names it.
const route = vi.hoisted(() => ({ now: { view: 'dm', screenId: 'dm1' } as { view: string; screenId: string } }));
vi.mock('../chat-route', () => ({ routeChat: async () => route.now }));
// The group's key code (group-chat-keys.ts) is off the words layer; the screen's keyring answers "never held".
vi.mock('../group-chat-keys', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), groupKeysLookUnopenable: () => false }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { LockedHistoryRow, LockedHistorySheet, SealedNoticeLine } from '../../components/LockedHistory';
import { LOCKED_OWN_LINE_TEXT, lockedHistoryRowText } from '../group-history-unlock';
import { GROUP_LINE_UNVERIFIED_DETAILS, GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT, earlierKeyDetails } from '../group-line-display';
import { DM_LINE_NOT_VERIFIED_TEXT } from '@beanpool/core';
import ChatRoute from '../../app/chat/[id]';

const NODE = 'https://mullum.example';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

/** A DM about a listing: the other person's line, mine read and failed, an edit, a delete, a trade's lines, a line that didn't open. */
const DM_MESSAGES = [
    { id: 'm1', senderId: 'kofi-key', text: 'Is the ladder still free?', type: 'text', rawTimestamp: iso(now - 3_600_000), timestamp: '' },
    { id: 'm2', senderId: ME.publicKey, text: 'Yes, come by at five', type: 'text', outgoing: true, readByPeer: true, edited: true, rawTimestamp: iso(now - 3_500_000), timestamp: '' },
    { id: 'm3', senderId: 'SYSTEM', text: '5 Beans held in trust.', type: 'system', systemType: 'ESCROW_FUNDED', metadata: { postId: 'p-ladder' }, rawTimestamp: iso(now - 3_400_000), timestamp: '' },
    { id: 'm4', senderId: 'SYSTEM', text: 'Payment of 5 Beans released to you.', type: 'system', systemType: 'ESCROW_RELEASED', metadata: { postId: 'p-old' }, rawTimestamp: iso(now - 3_300_000), timestamp: '' },
    { id: 'm5', senderId: 'kofi-key', text: DM_LINE_NOT_VERIFIED_TEXT, type: 'text', unattributed: true, rawTimestamp: iso(now - 3_200_000), timestamp: '' },
    { id: 'm6', senderId: 'kofi-key', text: 'See you then', type: 'text', integrityNote: 'Shown out of the order it was written in.', metadata: { replyToId: 'm2', reactions: [{ emoji: '👍', author: ME.publicKey }] }, rawTimestamp: iso(now - 3_100_000), timestamp: '' },
    { id: 'm7', senderId: 'kofi-key', text: 'This message was deleted', type: 'removed', metadata: { removed: true }, rawTimestamp: iso(now - 3_000_000), timestamp: '' },
    { id: 'm8', senderId: ME.publicKey, text: 'running late', type: 'text', outgoing: true, sendState: 'failed', rawTimestamp: iso(now - 60_000), timestamp: '' },
];
const DM_CONVERSATION = {
    name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', postId: 'p-ladder', postTitle: 'Borrow a long ladder', postStatus: 'pending',
    credits: 5, price_type: 'hourly', pendingTxId: 'tx-held', pendingAmount: 5, txBuyerPubkey: ME.publicKey,
};
const DM_DEALS = [
    { txId: 'tx-held', postId: 'p-ladder', postTitle: 'Borrow a long ladder', status: 'pending', iAmBuyer: true, credits: 5 },
    { txId: 'tx-eggs', postId: 'p-eggs', postTitle: 'Duck eggs', status: 'pending', iAmBuyer: false, credits: 3 },
    { txId: 'tx-done', postId: 'p-old', postTitle: null, status: 'completed', iRated: false, credits: 8 },
];
/** A new group of the member's: only them in it, a node system line, a convenor's removal. */
const GROUP_CHAT = {
    group: { id: 'g1', name: 'Garden club', category: 'social' }, isConvenor: true, canPost: true, mute: null,
    messages: [
        { id: 's1', authorPubkey: 'SYSTEM', type: 'system', ciphertext: 'Garden club was created', timestamp: iso(now - 7_200_000) },
    ],
};
const GROUP_DETAILS = { group: { id: 'g1', name: 'Garden club', category: 'social', joinPolicy: 'open', memberCount: 1 }, members: [{ memberPubkey: ME.publicKey, callsign: 'Ana', status: 'active', role: 'convenor' }] };
const EVENT_CHAT = {
    title: 'Repair café', canPost: true, isHost: true, privateNote: 'Bring a mug', notice: "Visible to the host, everyone going, and this node's operator.",
    messages: [{ id: 'e1', authorPubkey: 'mia-key', authorCallsign: 'Mia', type: 'text', ciphertext: Buffer.from('I can fix lamps').toString('base64'), nonce: 'plaintext-v1', timestamp: iso(now - 600_000) }],
};

/** Everything members and the node wrote: shown as written, in every language. */
const OTHERS = [
    'Kofi', 'Ana', 'Mia', 'Borrow a long ladder', 'Duck eggs', 'Is the ladder still free?', 'Yes, come by at five', 'See you then', 'running late',
    'Garden club', 'Garden club was created', 'Repair café', 'Bring a mug', 'I can fix lamps', EVENT_CHAT.notice,
].sort((a, b) => b.length - a.length);

type Answers = Record<string, unknown>;
function node(over: Answers = {}): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Answers = {
        getConversation: DM_CONVERSATION, getMessages: DM_MESSAGES, getDealsBetween: DM_DEALS, getDmKeyChange: null, getKnownChatMute: null,
        syncMessages: undefined, syncSingleConversation: undefined, markConversationRead: undefined,
        getDb: { getAllAsync: async () => [], getFirstAsync: async () => null, runAsync: async () => ({}) },
        getGroupChat: GROUP_CHAT, fetchGroupDetails: GROUP_DETAILS, markThreadReadOnNode: undefined,
        groupScreenKeyringFor: { seenLocked: async () => false, sync: async () => null, noteShownRoster: () => {}, serveMissing: async () => {} },
        noteLockedHistoryRow: undefined, getEventChat: EVENT_CHAT, fetchYourGroups: { items: [], totalUnread: 0 },
        getInvitablePeople: [{ publicKey: 'kofi-key', callsign: 'Kofi', avatarUrl: null }, { publicKey: 'mia-key', callsign: 'Mia', avatarUrl: null }],
        ...over,
    };
    return (name) => (name in answers ? Promise.resolve(answers[name]) : undefined);
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.answer = node();
    alerts.said.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true, escrow: true }, checkedAt: new Date().toISOString() } }));
    route.now = { view: 'dm', screenId: 'dm1' };
    params.now = { id: 'dm1' };
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, screen: unknown = createElement(ChatRoute)) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, screen as any) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el ?? null, what).not.toBeNull();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`);
const bubbleWith = (text: string) => Array.from(host.querySelectorAll('button')).reverse().find((b) => b.textContent?.includes(text)) ?? null;

function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const o of OTHERS) rest = rest.split(o).join('');
    return /\p{L}/u.test(rest);
}
function bypassing(): string[] {
    const out = new Set<string>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const whole = n.parentElement?.textContent ?? n.nodeValue;
        if (outsideBrackets(whole)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const [attr, kind] of [['aria-label', 'label'], ['placeholder', 'placeholder']] as const) {
        for (const e of Array.from(host.querySelectorAll(`[${attr}]`))) {
            const v = e.getAttribute(attr);
            if (outsideBrackets(v)) out.add(`${kind}: ${JSON.stringify(v)}`);
        }
    }
    for (const said of alerts.said) if (outsideBrackets(said)) out.add(`alert: ${JSON.stringify(said)}`);
    return [...out];
}
const bracketed = () => Array.from(host.querySelectorAll('span')).filter((s) => /^\[.*\]$/su.test(s.textContent ?? '')).length;

describe('a direct message in the pseudo-locale: every word came through t() (words S3c)', () => {
    it('the header, the listing and its status, the deals strip, the release bar, every kind of line, the composer', async () => {
        await renderIn('xx');
        expect(host.textContent).toContain('Is the ladder still free?');
        expect(host.textContent).toContain('Borrow a long ladder');
        // The lower layers' English reads in the member's language: a trade's line, a line that didn't open, its mark.
        expect(host.textContent).toContain(pseudoLocalise('{n} Beans held in trust.').replace('{n}', '5'));
        expect(host.textContent).toContain(pseudoLocalise("🔒 This message couldn't be verified, so it isn't shown."));
        expect(host.textContent).toContain(pseudoLocalise('Shown out of the order it was written in.'));
        expect(host.textContent).toContain(pseudoLocalise('! not delivered'));
        expect(host.textContent).toContain(pseudoLocalise('This message was deleted'));
        expect(bracketed()).toBeGreaterThan(20);
        expect(bypassing()).toEqual([]);
    });

    it('a bubble\'s actions, a reply, the delete, failed-send, photo and release questions', async () => {
        await renderIn('xx');
        await click(bubbleWith('Yes, come by at five'), 'my message');
        expect(byLabel(pseudoLocalise('Delete message'))).not.toBeNull();
        expect(bypassing(), 'the actions').toEqual([]);
        await click(byLabel(pseudoLocalise('Reply')), 'Reply');
        expect(host.textContent).toContain(pseudoLocalise('Replying to {name}').replace('{name}', pseudoLocalise('You')));
        expect(bypassing(), 'the reply banner').toEqual([]);
        await click(bubbleWith('Yes, come by at five'), 'my message, again');
        await click(byLabel(pseudoLocalise('Delete message')), 'Delete message');
        await click(bubbleWith('running late'), 'the failed send');
        await click(byLabel(pseudoLocalise('Attach image')), 'Attach image');
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(pseudoLocalise('Release {amount}').slice(0, 6))) ?? null, 'Release');
        expect(alerts.said).toContain(pseudoLocalise('Delete for everyone?'));
        expect(alerts.said).toContain(pseudoLocalise('Message not delivered'));
        expect(alerts.said).toContain(pseudoLocalise('Send Photo'));
        expect(alerts.said).toContain(pseudoLocalise('Release {n} Beans to the provider? This action cannot be undone.').replace('{n}', '5'));
        expect(bypassing(), 'the questions').toEqual([]);
    });

    it('the ⋮ sheet and its mute choices', async () => {
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('More options')), 'More options');
        expect(host.textContent).toContain(pseudoLocalise('View profile'));
        expect(bypassing(), 'the sheet').toEqual([]);
        await click(Array.from(host.querySelectorAll('[data-modal] button')).find((b) => b.textContent === pseudoLocalise('Mute notifications')) ?? null, 'Mute notifications');
        expect(host.textContent).toContain(pseudoLocalise('For a week'));
        expect(bypassing(), 'the mute choices').toEqual([]);
    });

    it('in English the words are as they were', async () => {
        await renderIn('en');
        expect(bracketed()).toBe(0);
        expect(host.textContent).toContain('5 Beans held in trust.');
        expect(host.textContent).toContain('⚠️ Action Required: Release Credits');
        expect(host.textContent).toContain('⏳ Awaiting release');
        expect(host.textContent).toContain('🔒 End-to-end encrypted');
        expect(host.textContent).toContain('PENDING');
        expect(host.textContent).toContain('5 Beans / hr');
        expect(host.textContent).toContain('! not delivered');
        expect(byLabel('Release credits for Borrow a long ladder')).toBeNull(); // in the release bar, not the strip
        expect(byLabel('Leave a review for deal')).not.toBeNull();
        // Read by value: the selector engine trips on an emoji inside an attribute selector.
        expect(Array.from(host.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label'))).toContain('1 reaction: 👍');
    });

    it('a held deal\'s card says "held in trust", never "in escrow" (held-in-trust words)', async () => {
        await renderIn('en');
        expect(host.textContent).toMatch(/5.*· held in trust/);
        expect(host.textContent).toMatch(/3.*· held in trust/);
        expect(host.textContent).toContain('· completed');
        expect(host.textContent).not.toMatch(/escrow/i);
    });
});

describe('the admin page\'s message in a direct message, in the pseudo-locale (#2179 review)', () => {
    it('its words as written, even word for word a sentence BeanPool writes; the note under it in the member\'s language', async () => {
        const note = "From your community's admins. Not a private message: the community's server can read it.";
        const admins = { id: 'mA', senderId: 'kofi-key', text: 'Keep them locked', type: 'text', unattributed: true, quoteFrom: 'admins', integrityNote: note, rawTimestamp: iso(now - 30_000), timestamp: '' };
        net.answer = node({ getMessages: [...DM_MESSAGES, admins] });
        await renderIn('xx');
        const line = Array.from(host.querySelectorAll('[data-testid="dm-line-unattributed"]')).find((l) => l.textContent?.includes(pseudoLocalise(note)));
        expect(line, 'the admins\' line').toBeTruthy();
        expect(line!.textContent).toContain('Keep them locked');
        expect(line!.textContent).not.toContain(pseudoLocalise('Keep them locked'));
        // A line that didn't open is still BeanPool's stand-in, in the member's language.
        expect(host.textContent).toContain(pseudoLocalise(DM_LINE_NOT_VERIFIED_TEXT));
    });
});

describe('a group\'s chat and an event\'s chat in the pseudo-locale', () => {
    it('a new group: the owner header, the invite prompt, the node\'s system line as it sent it, the composer and its notice', async () => {
        route.now = { view: 'group', screenId: 'g1' };
        params.now = { id: 'g1', group: '1', created: '1' };
        await renderIn('xx');
        expect(host.textContent).toContain('Garden club was created');
        expect(host.textContent).toContain(pseudoLocalise('Who do you want to invite?'));
        expect(byLabel(pseudoLocalise('{name}, group. Opens the group page.').replace('{name}', 'Garden club'))).not.toBeNull();
        expect(host.textContent).toContain(pseudoLocalise("This community's node is older and can read this group's chat. It will be locked once the node is updated."));
        expect(bypassing(), 'the chat').toEqual([]);
        await click(byLabel(pseudoLocalise('Chat menu')), 'Chat menu');
        expect(host.textContent).toContain(pseudoLocalise('Confirm new phone'));
        expect(bypassing(), 'the menu').toEqual([]);
        await click(Array.from(host.querySelectorAll('[data-modal] button')).find((b) => b.textContent === pseudoLocalise('Search this chat')) ?? null, 'Search this chat');
        expect(host.querySelector(`input[placeholder="${pseudoLocalise('Search this chat')}"]`)).not.toBeNull();
        expect(bypassing(), 'the search').toEqual([]);
    });

    it('a new group\'s next step: Invite people, its list and its button with a count', async () => {
        route.now = { view: 'group', screenId: 'g1' };
        params.now = { id: 'g1', group: '1', created: '1' };
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Invite people')), 'Invite people');
        expect(host.textContent).toContain(pseudoLocalise('to {name}').replace('{name}', 'Garden club'));
        expect(byLabel(pseudoLocalise('Pick people to invite'))).not.toBeNull();
        expect(bypassing(), 'the sheet').toEqual([]);
        await click(byLabel('Kofi'), 'Kofi');
        expect(byLabel(pseudoLocalise('Invite {n} person').replace('{n}', '1'))).not.toBeNull();
        expect(bypassing(), 'one picked').toEqual([]);
    });

    it('an event\'s chat: the note for people going, the host\'s remove, the composer', async () => {
        route.now = { view: 'event', screenId: 'ev1' };
        params.now = { id: 'ev1', event: '1' };
        await renderIn('xx');
        expect(host.textContent).toContain('I can fix lamps');
        expect(host.textContent).toContain(pseudoLocalise('📌 NOTE FOR PEOPLE WHO ARE GOING'));
        expect(bypassing(), 'the chat').toEqual([]);
        await click(bubbleWith('I can fix lamps'), 'Mia\'s message');
        await click(byLabel(pseudoLocalise('Remove this message')), 'Remove');
        expect(alerts.said).toContain(pseudoLocalise('Remove this message?'));
        expect(bypassing(), 'the question').toEqual([]);
    });

    it('a locked chat\'s pieces: a line that names nobody, the row from before a phone change, and its sheet', async () => {
        await renderIn('xx', createElement('div', null,
            createElement(SealedNoticeLine, { name: GROUP_LINE_UNVERIFIED_NAME, text: GROUP_LINE_UNVERIFIED_TEXT, details: GROUP_LINE_UNVERIFIED_DETAILS }),
            createElement(SealedNoticeLine, { name: 'Ana', text: LOCKED_OWN_LINE_TEXT, details: earlierKeyDetails('Ana', iso(now - 30 * 86_400_000)) }),
            createElement(LockedHistoryRow, { text: lockedHistoryRowText(3), onPress: () => {} }),
            createElement(LockedHistorySheet, { open: true, bottomInset: 0, onClose: () => {}, onWords: () => {}, onAsk: () => {} })));
        expect(host.textContent).toContain(pseudoLocalise('🔒 {n} messages from before you changed phones. Unlock →').replace('{n}', '3'));
        expect(host.textContent).toContain(pseudoLocalise('Keep them locked'));
        expect(bypassing()).toEqual([]);
    });
});

// ── 320 dp with text at 1.3×: longer languages never cut or push words past an edge (checked with the pseudo-locale) ──
const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);
const longestWord = (text: string) => text.split(/[\s\u200B]+/).reduce((a, b) => (widthOf(b, 1) > widthOf(a, 1) ? b : a), '');

describe('a conversation at 320 dp with 1.3× text, in the pseudo-locale', () => {
    it('the ⋮ sheet\'s rows take two lines rather than cutting a label, and no word is wider than the row', async () => {
        route.now = { view: 'group', screenId: 'g1' };
        params.now = { id: 'g1', group: '1' };
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Chat menu')), 'Chat menu');
        const labels = Array.from(host.querySelectorAll('[data-modal] button > span'));
        expect(labels.length).toBeGreaterThanOrEqual(4);
        // 20 dp sides, the 22 dp icon and a 14 dp gap.
        const row = 320 - 40 - 22 - 14;
        for (const label of labels) {
            expect(label.getAttribute('data-lines'), label.textContent!).toBe('2');
            expect(widthOf(longestWord(label.textContent!), 16 * SCALE), label.textContent!).toBeLessThanOrEqual(row);
        }
    });

    it('a deal\'s buttons in the strip: one line each that shrinks, in a row that wraps', async () => {
        await renderIn('xx');
        const review = byLabel(pseudoLocalise('Leave a review for deal'))!;
        expect(review).not.toBeNull();
        const label = review.querySelector('span[data-shrinks]')!;
        expect(label.getAttribute('data-lines')).toBe('1');
        expect(review.parentElement!.getAttribute('data-wrap')).toBe('wrap');
        // The card is 200 dp with 10 dp padding; the button pads 12 dp a side.
        expect(widthOf(label.textContent!, 13 * SCALE) * Number(label.getAttribute('data-min-scale'))).toBeLessThanOrEqual(200 - 20 - 24);
    });
});

describe('message request on the phone (phone-web-parity)', () => {
    it('in mine-waiting: shows waiting line, no live composer, and Cancel request calls decideMessageRequest', async () => {
        const reqConv = {
            ...DM_CONVERSATION,
            request: { state: 'pending', from: ME.publicKey, at: iso(now - 60_000) },
        };
        const reqMessages = [
            { id: 'm1', senderId: ME.publicKey, authorPubkey: ME.publicKey, text: 'Hi Kofi', type: 'text', rawTimestamp: iso(now - 60_000), timestamp: '' },
        ];
        net.answer = node({
            getConversation: reqConv,
            getMessages: reqMessages,
            decideMessageRequest: { success: true },
        });
        await renderIn('en');
        expect(host.querySelector('[data-testid="request-waiting"]')).not.toBeNull();
        expect(host.textContent).toContain('Sent as a request. Kofi will see it under Requests. You can write more once they accept.');
        expect(host.querySelector('input[placeholder="Message..."]')).toBeNull();

        const cancelBtn = host.querySelector('[data-testid="request-cancel"]');
        expect(cancelBtn).not.toBeNull();
        expect(cancelBtn!.textContent).toContain('Cancel request');
        await click(cancelBtn, 'Cancel request');
        expect(net.calls.some((c) => c.startsWith('db.decideMessageRequest'))).toBe(true);
    });

    it('failed message bubble shows server words in alert', async () => {
        const SERVER_ERROR = 'Your first message is waiting for Kofi. You can write more once they accept it.';
        const failedMsg = {
            id: 'm-fail',
            senderId: ME.publicKey,
            text: 'second message',
            type: 'text',
            outgoing: true,
            sendState: 'failed',
            metadata: { __sendError: SERVER_ERROR },
            rawTimestamp: iso(now - 10_000),
            timestamp: '',
        };
        net.answer = node({ getMessages: [failedMsg] });
        await renderIn('en');
        await click(bubbleWith('second message'), 'the failed send');
        expect(alerts.said).toContain('Message not delivered');
        expect(alerts.said).toContain(SERVER_ERROR);
    });
});

// ── Deals S7: a request on the member's own listing is a card in the chat, as on the web (#2607 deciding pass) ──────────
describe("a request waiting for the member's answer in the chat's deal strip", () => {
    /** Kofi asks to help with a Need: on a Need the one who asks is the seller; the Need's author is the buyer and answers. */
    const request = (over: Record<string, unknown> = {}) => ({
        txId: 'tx-ask', postId: 'p-fence', postTitle: 'Paint the fence', status: 'requested', credits: 12, iRated: false,
        buyerPubkey: ME.publicKey, sellerPubkey: 'kofi-key', iAmBuyer: true,
        postAuthorPublicKey: ME.publicKey, postType: 'need', postRepeatable: 0, postLendable: 0, ...over,
    });
    const only = (...deals: unknown[]) => {
        net.answer = node({ getDealsBetween: deals, getConversation: { ...DM_CONVERSATION, postId: null, postTitle: null, pendingTxId: null, pendingAmount: null, txBuyerPubkey: null } });
    };
    const labels = () => Array.from(host.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label') ?? '');

    it('the author of the Need sees "Waiting on you: answer", nothing held, and no buttons of its own', async () => {
        only(request());
        await renderIn('en');
        expect(host.textContent).toContain('Paint the fence');
        expect(host.textContent).toContain('Waiting on you: answer');
        expect(host.textContent).not.toContain('held in trust');
        expect(byLabel('Cancel deal')).toBeNull();
        expect(labels().filter((l) => /^(Release|Leave a review)/.test(l))).toEqual([]);
    });

    it("the same card in the member's language", async () => {
        only(request());
        await renderIn('xx');
        expect(host.textContent).toContain(pseudoLocalise('Waiting on you: answer'));
    });

    it("the lender of a thing sees the borrower's request, which an Offer's author answers", async () => {
        only(request({ postType: 'offer', postLendable: 1, buyerPubkey: 'kofi-key', sellerPubkey: ME.publicKey, iAmBuyer: false, postAuthorPublicKey: ME.publicKey }));
        await renderIn('en');
        expect(host.textContent).toContain('Waiting on you: answer');
    });

    it('the one who asked sees no card for their own request, nor a declined one, nor a third person\'s listing', async () => {
        // I am the helper (seller) on Kofi's Need: waiting on him.
        only(request({ buyerPubkey: 'kofi-key', sellerPubkey: ME.publicKey, iAmBuyer: false, postAuthorPublicKey: 'kofi-key' }));
        await renderIn('en');
        expect(host.textContent).not.toContain('Paint the fence');
        expect(host.textContent).not.toContain('Waiting on you: answer');
        act(() => root.unmount());
        root = createRoot(host);
        only(request({ status: 'rejected' }));
        await renderIn('en');
        expect(host.textContent).not.toContain('Waiting on you: answer');
        act(() => root.unmount());
        root = createRoot(host);
        // Kofi asked on someone else's Need: not mine to answer.
        only(request({ postAuthorPublicKey: 'zoe-key' }));
        await renderIn('en');
        expect(host.textContent).not.toContain('Waiting on you: answer');
    });
});
