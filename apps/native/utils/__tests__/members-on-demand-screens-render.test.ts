// @vitest-environment jsdom
/**
 * Never a dead end, screen by screen (DESIGN-global-members-by-area §2.4, #1792, slice M2): People → Community, New
 * message, the chats list, My Deals and the public profile rendered for real at the floor's window (320 × 569 dp, text at
 * 1.3×), in the real light and dark palettes, online and offline, on a community that says `membersOnDemand`.
 *
 * The phone's own utils/db runs on its real schema in an in-memory SQLite (as pillar-sync-members-on-demand.test.ts), so
 * the chats and deals rows come from the real queries with no card held; the node is a fetch stand-in that answers the
 * three small forms of `/api/members` (`keys=`, `q=`, `lat&lng&limit=`) and records every request; offline, every request
 * fails as a phone with no network does. React Native's host components are plain tags carrying their accessibility props
 * and flattened style (as showcase-render.test.ts), so what is checked is the tree, its words, the requests it makes, and
 * the text-fit arithmetic below — nothing here draws a frame (the emulator check is separate).
 *
 * Each screen: (a) a card held shows what it shows today; (b) no card and online, the name within one request by key;
 * (c) no card and offline, the key's first 8 characters (or the name the caller passed) and a profile that says "Connect
 * to see more", never a spinner that never ends; (d) never a `membersComplete` delete — no screen asks the node for the
 * whole directory and no card is removed. Every empty state is worded as §2.3 says, never "Loading" for a list that won't.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { act, createElement, Fragment, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };

const { FONT_SCALE, WINDOW } = vi.hoisted(() => ({ FONT_SCALE: 1.3, WINDOW: { width: 320, height: 569, scale: 1.5, fontScale: 1.3 } }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const flat = (style: unknown) => Object.assign({}, ...[style].flat(5).filter(s => s && typeof s === 'object'));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, disabled, value, onChangeText, allowFontScaling, adjustsFontSizeToFit } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = (e: Event) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (allowFontScaling === false) attrs['data-noscale'] = 'true';
        if (adjustsFontSizeToFit) attrs['data-fit'] = 'true';
        attrs['data-style'] = JSON.stringify(flat(props.style));
        if (tag === 'input') attrs.placeholder = props.placeholder;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    const asNode = (c: unknown): ReactNode => (typeof c === 'function' ? createElement(c as any) : (c as ReactNode));
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, style, contentContainerStyle }: Record<string, any>) =>
        createElement('div', { 'data-list': 'true', 'data-style': JSON.stringify(flat([style, contentContainerStyle])) },
            asNode(ListHeaderComponent),
            (data ?? []).length
                ? (data as unknown[]).map((item, index) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : String(index) }, renderItem({ item, index })))
                : asNode(ListEmptyComponent),
            asNode(ListFooterComponent));
    class Value { constructor(public v: number) {} setValue(v: number) { this.v = v; } interpolate() { return 0; } }
    const anim = () => ({ start: (cb?: () => void) => cb?.(), stop: () => {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), TouchableOpacity: el('button'), ScrollView: el('div'),
        TextInput: el('input'), Image: el('img'), Switch: el('button'), SafeAreaView: el('div'), KeyboardAvoidingView: el('div'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        RefreshControl: () => null,
        FlatList, SectionList: FlatList,
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        Animated: { View: el('div'), Text: el('span'), FlatList, Value, add: () => new Value(0), multiply: () => new Value(0), diffClamp: () => new Value(0), timing: anim, spring: anim, loop: anim, sequence: anim, parallel: anim, event: () => () => {}, createAnimatedComponent: (c: unknown) => c },
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: flat },
        Dimensions: { get: () => WINDOW, addEventListener: () => ({ remove() {} }) },
        useWindowDimensions: () => WINDOW,
        PixelRatio: { getFontScale: () => FONT_SCALE, get: () => 1.5 },
        AccessibilityInfo: { isReduceMotionEnabled: async () => true, isScreenReaderEnabled: async () => false, announceForAccessibility: () => {}, addEventListener: () => ({ remove() {} }) },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: () => {} },
        Keyboard: { dismiss: () => {}, addListener: () => ({ remove() {} }) },
        Alert: { alert: vi.fn() },
        Share: { share: vi.fn(async () => ({})) },
        Linking: { openURL: vi.fn(async () => {}) },
        I18nManager: { isRTL: false },
    };
});
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, pushed: [] as unknown[] }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => nav.pushed.push(to), navigate: (to: unknown) => nav.pushed.push(to), replace: (to: unknown) => nav.pushed.push(to), back: () => {}, setParams: () => {}, canGoBack: () => true },
    useLocalSearchParams: () => nav.params,
    useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true, setOptions: () => {} }),
    useFocusEffect: (cb: () => void | (() => void)) => { useEffect(() => cb() ?? undefined, [cb]); },
    ErrorBoundary: () => null,
    Link: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    KeyboardAwareScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => createElement('div', { 'data-qr': 'true' }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('expo-local-authentication', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 3, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => {}), deleteItemAsync: vi.fn(async () => {}) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/', getInfoAsync: vi.fn(async () => ({ exists: false })), makeDirectoryAsync: vi.fn(async () => {}), writeAsStringAsync: vi.fn(async () => {}),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-apple-authentication', () => ({}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), maybeCompleteAuthSession: () => {} }));
vi.mock('expo-linking', () => ({ createURL: (p: string) => `beanpool://${p}`, openURL: vi.fn() }));
vi.mock('expo-haptics', () => ({ impactAsync: vi.fn(async () => {}), notificationAsync: vi.fn(async () => {}), selectionAsync: vi.fn(async () => {}), ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));
vi.mock('expo-navigation-bar', () => ({ setBackgroundColorAsync: vi.fn(async () => {}), setButtonStyleAsync: vi.fn(async () => {}) }));

// The phone's database: the real utils/db on its real schema, in memory.
const sql = new DatabaseSync(':memory:');
const sqlParams = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
const adapter = {
    runAsync: async (q: string, p?: unknown) => { const r = sql.prepare(q).run(...sqlParams(p)); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
    execAsync: async (q: string) => { sql.exec(q); },
    getAllAsync: async (q: string, p?: unknown) => sql.prepare(q).all(...sqlParams(p)),
    getFirstAsync: async (q: string, p?: unknown) => sql.prepare(q).get(...sqlParams(p)) ?? null,
    closeAsync: async () => {},
    withTransactionAsync: async (cb: () => Promise<void>) => { await cb(); },
};
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...mem.store.keys()]),
        multiGet: vi.fn(async (ks: string[]) => ks.map(k => [k, mem.store.get(k) ?? null])),
        multiRemove: vi.fn(async (ks: string[]) => { ks.forEach(k => mem.store.delete(k)); }),
    },
}));
const OWN = 'e'.repeat(64);
vi.mock('../identity', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    loadIdentity: vi.fn(async () => ({ publicKey: 'e'.repeat(64), privateKey: 'aa', callsign: 'Me' })),
}));
vi.mock('../crypto', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    buildSignedHeaders: vi.fn(async () => ({ 'X-Public-Key': 'e'.repeat(64), 'X-Signature': 'sig', 'X-Timestamp': '1' })),
}));
vi.mock('../nodes', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
// One object, as the provider holds one: a fresh identity each render would re-run every screen's focus effect forever.
const who = vi.hoisted(() => ({ value: { identity: { publicKey: 'e'.repeat(64), callsign: 'Me' } } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who.value }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const colors = () => (theme.dark ? darkColors : lightColors);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors(), isDark: theme.dark }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
    };
});
// Which community the phone is on: one that says `membersOnDemand` (the worldwide one) unless a test says otherwise.
// The screens read it through useNodeProfile, the db's syncMessages from the phone's copy (getCachedNodeProfile): one answer.
const community = vi.hoisted(() => ({
    membersOnDemand: true,
    // On a real phone useNodeProfile starts null and answers a moment after the screen mounts; set, it answers this late.
    lateMs: 0,
    area: { lat: -28.55, lng: 153.5 } as null | { lat: number; lng: number },
    profile() {
        const on = this.membersOnDemand;
        return {
            profile: on ? 'global' : 'local', checkedAt: new Date().toISOString(),
            features: { beans: !on, escrow: !on, invites: !on, decisions: !on, exampleListings: false, ...(on ? { membersOnDemand: true } : {}) },
        };
    },
}));
vi.mock('../use-node-profile', async () => {
    const React = await import('react');
    const useNodeProfile = () => {
        const [late, setLate] = React.useState<ReturnType<typeof community.profile> | null>(null);
        React.useEffect(() => {
            if (!community.lateMs) return;
            const t = setTimeout(() => setLate(community.profile()), community.lateMs);
            return () => clearTimeout(t);
        }, []);
        return community.lateMs ? late : community.profile();
    };
    // The showcase's hooks (#1852, use-reader-features.ts) read the same answer, with `copyRead` once it has come.
    const useNodeProfileState = () => {
        const profile = useNodeProfile();
        return { profile, copyRead: profile !== null };
    };
    return { useNodeProfile, useNodeProfileState };
});
vi.mock('../node-profile', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getCachedNodeProfile: vi.fn(async () => community.profile()),
    fetchNodeProfile: vi.fn(async () => community.profile()),
}));
vi.mock('../nearby-area', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    readNearbyAreaCopy: vi.fn(async () => (community.area ? { area: community.area } : null)),
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ callsign }: { callsign: string }) => createElement('span', { 'data-avatar': callsign }) }));
vi.mock('../../components/PageTitle', () => ({ PageTitle: ({ title }: { title: string }) => createElement('h1', null, title), useTabRetapScrollTop: () => {} }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));
vi.mock('../../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../../components/WantsToJoin', () => ({ WantsToJoin: () => null }));
vi.mock('../../components/MyJoinRequests', () => ({ MyJoinRequests: () => null }));
vi.mock('../channels', () => ({ fetchPublicChannels: vi.fn(async () => []) }));

// The node: the three small forms of /api/members (M1), and nothing else this test needs. Every request is recorded.
const NODE_URL = 'https://global.example';
type NodeMember = { publicKey: string; callsign: string; joinedAt: string; avatarUrl: null; profileUpdatedAt: string; earnedCredit: number; nodeRole: null; elderVouchedBy: null; archetype: null; distanceKm?: number };
const nodeMember = (publicKey: string, callsign: string, distanceKm?: number): NodeMember => ({
    publicKey, callsign, joinedAt: '2026-03-01T00:00:00.000Z', avatarUrl: null, profileUpdatedAt: '2026-09-01T00:00:00.000Z', earnedCredit: 0, nodeRole: null, elderVouchedBy: null, archetype: null, ...(distanceKm !== undefined ? { distanceKm } : {}),
});
const RIVER = '1'.repeat(64);
const ROSA = '2'.repeat(64);
const KOFI = '3'.repeat(64);
const node = {
    online: true,
    members: [nodeMember(RIVER, 'Riverstone Bakehouse and Community Kitchen Collective', 1), nodeMember(ROSA, 'Rosa', 3), nodeMember(KOFI, 'Kofi', 12)],
    requests: [] as string[],
};
async function nodeFetch(input: unknown): Promise<Response> {
    const url = new URL(String(input));
    if (!node.online) throw new TypeError('Network request failed');
    node.requests.push(`${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/members') {
        const keys = url.searchParams.get('keys');
        const q = url.searchParams.get('q');
        if (keys) return json(keys.split(',').map(k => node.members.find(m => m.publicKey === k)).filter(Boolean));
        if (q) return json(node.members.filter(m => m.callsign.toLowerCase().startsWith(q.toLowerCase())).slice(0, 20));
        if (url.searchParams.get('lat') && url.searchParams.get('limit')) return json(node.members.slice(0, Number(url.searchParams.get('limit'))));
        return json({ error: 'the whole directory was asked for' }, 500);
    }
    return json({ error: 'not here' }, 404);
}

import { darkColors, lightColors, type AppColors } from '../../constants/colors';
import * as db from '../db';
import PeopleScreen from '../../app/(tabs)/people';
import NewMessageScreen from '../../app/new-message';
import ChatsScreen from '../../app/(tabs)/chats';
import PublicProfileScreen from '../../app/public-profile';
import { MyDealsSheet } from '../../components/MyDealsSheet';
import { InvitePeopleSheet } from '../../components/InvitePeopleSheet';

const realLoad = (Module as any)._load;
beforeAll(() => {
    (Module as any)._load = function (request: string, ...rest: any[]) {
        if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove() {} }) }, Platform: { OS: 'android' } };
        return realLoad.call(this, request, ...rest);
    };
});
afterAll(() => { (Module as any)._load = realLoad; });

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
    mem.store.clear();
    mem.store.set('beanpool_anchor_url', NODE_URL);
    node.online = true;
    node.requests.length = 0;
    nav.params = {};
    nav.pushed.length = 0;
    community.membersOnDemand = true;
    community.lateMs = 0;
    community.area = { lat: -28.55, lng: 153.5 };
    globalThis.fetch = vi.fn(nodeFetch) as typeof fetch;
    const database = await db.getDb();
    for (const t of ['members', 'conversations', 'conversation_participants', 'messages', 'marketplace_transactions', 'friends', 'ratings']) {
        await database.runAsync(`DELETE FROM ${t}`).catch(() => {});
    }
    await database.runAsync('INSERT INTO members (public_key, callsign, joined_at) VALUES (?, ?, ?)', [OWN, 'Me', '2026-01-01T00:00:00.000Z']);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const settle = async (ms = 0) => {
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, i === 0 ? ms : 0)); });
};
const render = async (node: unknown) => { await act(async () => { root.render(node as any); }); await settle(); };
const text = () => host.textContent ?? '';
const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const type = async (value: string) => {
    const input = host.querySelector('input')!;
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(450); // the 400 ms debounce the screens wait before asking
};
const styleOf = (el: Element) => JSON.parse(el.getAttribute('data-style') || '{}');
const membersRequests = () => node.requests.filter(r => r.startsWith('/api/members'));
const memberKeys = async () => (await (await db.getDb()).getAllAsync<{ public_key: string }>('SELECT public_key FROM members ORDER BY public_key')).map(r => r.public_key);

/**
 * Text that a fixed height would cut, estimated from the styles the screen gives it at 1.3× text: each Text is its lines
 * (numberOfLines, or the lines its words wrap to across the window) × its line height × the text scale; a column stacks
 * its children, a row takes the tallest; an element with a fixed `height` must hold what it holds. Returns the clipped
 * elements' text. An absolutely placed element floats over its parent and is held to its own height only.
 */
function clippedText(rootEl: Element): string[] {
    const clipped: string[] = [];
    const num = (v: unknown) => (typeof v === 'number' ? v : 0);
    const padV = (st: Record<string, unknown>) => num(st.paddingTop ?? st.paddingVertical ?? st.padding) + num(st.paddingBottom ?? st.paddingVertical ?? st.padding)
        + num(st.borderTopWidth ?? st.borderWidth) + num(st.borderBottomWidth ?? st.borderWidth);
    const marV = (st: Record<string, unknown>) => num(st.marginTop ?? st.marginVertical ?? st.margin) + num(st.marginBottom ?? st.marginVertical ?? st.margin);
    const textHeight = (el: Element, st: Record<string, any>): number => {
        const scale = el.getAttribute('data-noscale') ? 1 : FONT_SCALE;
        const size = (st.fontSize ?? 14) * scale;
        const line = st.lineHeight ? st.lineHeight * scale : size * 1.2;
        const fixedLines = Number(el.getAttribute('data-lines') || 0);
        const chars = (el.textContent ?? '').length;
        const wraps = Math.max(1, Math.ceil((chars * size * 0.55) / (WINDOW.width - 32)));
        return (fixedLines ? Math.min(fixedLines, wraps) : wraps) * line + padV(st);
    };
    const minHeight = (el: Element): number => {
        const st = styleOf(el);
        if (st.display === 'none') return 0;
        let content: number;
        if (el.tagName === 'SPAN' && el.textContent) {
            content = textHeight(el, st);
        } else {
            const kids = Array.from(el.children).filter(c => styleOf(c).position !== 'absolute');
            for (const c of Array.from(el.children)) if (styleOf(c).position === 'absolute') minHeight(c);
            const heights = kids.map(c => minHeight(c) + marV(styleOf(c)));
            const row = st.flexDirection === 'row' && st.flexWrap !== 'wrap';
            const gap = num(st.rowGap ?? st.gap) * Math.max(0, kids.length - 1);
            content = padV(st) + (row ? Math.max(0, ...heights) : heights.reduce((a, b) => a + b, 0) + gap);
        }
        if (typeof st.height === 'number') {
            if (content > st.height + 0.5 && el.textContent) clipped.push(`${(el.textContent ?? '').slice(0, 60)} (needs ${content.toFixed(1)}, has ${st.height})`);
            return st.height;
        }
        return Math.max(content, num(st.minHeight));
    };
    minHeight(rootEl);
    return clipped;
}

/**
 * Text placed over a row's text: inside a list's rows, an absolutely placed element carrying more than a badge's character
 * or two. (A screen's quick-return bar floats over the list on purpose, with the list padded beneath it: not a row's.)
 */
function textOverText(rootEl: Element): string[] {
    return Array.from(rootEl.querySelectorAll('[data-list] [data-style]'))
        .filter(e => styleOf(e).position === 'absolute' && (e.textContent ?? '').trim().length > 2)
        .map(e => (e.textContent ?? '').trim().slice(0, 60));
}

/** WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
        const n = hex.replace('#', '');
        const [r, g, bl] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}
/** The span holding exactly `words`, its colour against the nearest background behind it (the screen's when none). */
function contrastOf(words: string, colors: AppColors): number {
    const span = Array.from(host.querySelectorAll('span')).find(s => s.textContent === words);
    if (!span) throw new Error(`no text "${words}" on screen`);
    const fg = styleOf(span).color as string;
    let bg: string | undefined;
    for (let e: Element | null = span; e && !bg; e = e.parentElement) {
        const c = styleOf(e).backgroundColor;
        if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) bg = c;
    }
    return contrast(fg, bg ?? (colors.surface.app as string));
}

/** What every screen owes in every scheme and state: nothing cut, nothing over anything, no whole directory, no delete. */
async function fits(held: string[]) {
    expect(clippedText(host)).toEqual([]);
    expect(textOverText(host)).toEqual([]);
    expect(node.requests.filter(r => r === '/api/members' || r.startsWith('/api/members?updatedAfter') || r === '/api/community/members' || r.startsWith('/api/community/members?'))).toEqual([]);
    expect(await memberKeys()).toEqual(expect.arrayContaining(held));
    expect(host.querySelector('[data-spinner]')).toBeNull();
}

async function holdConversationWith(peer: string, id = `conv-${peer.slice(0, 4)}`) {
    const database = await db.getDb();
    await database.runAsync("INSERT INTO conversations (id, type, created_at) VALUES (?, 'dm', ?)", [id, '2026-10-01T00:00:00.000Z']);
    await database.runAsync('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [id, OWN]);
    await database.runAsync('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [id, peer]);
    return id;
}
async function holdCard(key: string, callsign: string) {
    await (await db.getDb()).runAsync('INSERT OR REPLACE INTO members (public_key, callsign, joined_at, card_fetched_at) VALUES (?, ?, ?, ?)', [key, callsign, '2026-03-01T00:00:00.000Z', new Date().toISOString()]);
}

for (const scheme of ['light', 'dark'] as const) {
    const colors: AppColors = scheme === 'dark' ? (darkColors as unknown as AppColors) : lightColors;
    describe(`members on demand, screen by screen, in ${scheme} at 320 × 569 and 1.3× text`, () => {
        beforeEach(() => { theme.dark = scheme === 'dark'; });

        describe('People → Community', () => {
            it('online with an area: the 50 nearest from one small read, each "about N km", and the line that says so', async () => {
                await render(createElement(PeopleScreen));
                await settle(450); // past the search's debounce: still the one read
                expect(membersRequests()).toEqual([`/api/members?lat=-28.55&lng=153.5&limit=50`]);
                expect(text()).toContain('Near you: the 50 closest members. Search a name to find anyone else.');
                expect(text()).toContain('Rosa');
                expect(text()).toContain('about 3 km');
                expect(text()).not.toMatch(/Loading community|members on this node/);
                expect(contrastOf('Near you: the 50 closest members. Search a name to find anyone else.', colors)).toBeGreaterThanOrEqual(4.5);
                expect(contrastOf(' · about 3 km', colors)).toBeGreaterThanOrEqual(4.5);
                await fits([OWN]);
                // An answer is shown, not kept: the cards held are still only the member's own.
                expect(await memberKeys()).toEqual([OWN]);
            });

            it('online, a search of 2 letters asks the node; one letter asks it nothing; a long name ellipsises on one line', async () => {
                await render(createElement(PeopleScreen));
                node.requests.length = 0;
                await type('R');
                expect(membersRequests()).toEqual([]);
                await type('Ri');
                expect(membersRequests()).toEqual(['/api/members?q=Ri&limit=20']);
                expect(text()).toContain('Members whose name starts with “Ri”.');
                const name = Array.from(host.querySelectorAll('span')).find(s => s.textContent?.startsWith('Riverstone'))!;
                expect(name.getAttribute('data-lines')).toBe('1');
                await type('Zz');
                expect(text()).toContain('No members match your search.');
                expect(contrastOf('No members match your search.', colors)).toBeGreaterThanOrEqual(4.5);
                await fits([OWN]);
            });

            it('online, one letter typed: the cards held and "Type at least 2 letters", never "Connect" to a phone that is online', async () => {
                await render(createElement(PeopleScreen));
                node.requests.length = 0;
                await type('Z');
                expect(membersRequests()).toEqual([]);
                expect(text()).toContain("People you've dealt with. Type at least 2 letters to search everyone.");
                expect(text()).toContain('No one you have dealt with matches. Type at least 2 letters to search everyone.');
                expect(text()).not.toContain('Connect to search everyone');
                expect(contrastOf('No one you have dealt with matches. Type at least 2 letters to search everyone.', colors)).toBeGreaterThanOrEqual(4.5);
                await fits([OWN]);
            });

            it('online with no area: the search alone and "Set your area", never "Loading"', async () => {
                community.area = null;
                await render(createElement(PeopleScreen));
                expect(membersRequests()).toEqual([]);
                expect(text()).toContain("Set your area to see who's near you. Search a name to find anyone.");
                expect(text()).toContain('Type at least 2 letters of a name.');
                expect(contrastOf('Type at least 2 letters of a name.', colors)).toBeGreaterThanOrEqual(4.5);
                expect(text()).not.toContain('Loading');
                await fits([OWN]);
            });

            it("offline: the cards held under \"People you've dealt with\", searched on the phone, never \"Loading\"", async () => {
                await holdCard(ROSA, 'Rosa');
                node.online = false;
                await render(createElement(PeopleScreen));
                expect(text()).toContain("People you've dealt with. Connect to search everyone.");
                expect(text()).toContain('Rosa');
                expect(text()).not.toContain('Riverstone');
                await type('Ko');
                expect(text()).toContain('No one you have dealt with matches. Connect to search everyone.');
                expect(contrastOf('No one you have dealt with matches. Connect to search everyone.', colors)).toBeGreaterThanOrEqual(4.5);
                expect(text()).not.toContain('Loading');
                expect(contrastOf("People you've dealt with. Connect to search everyone.", colors)).toBeGreaterThanOrEqual(4.5);
                await fits([OWN, ROSA]);
            });

            it('a local community (switch absent): the whole list from the copy as today, and nothing asked of /api/members', async () => {
                community.membersOnDemand = false;
                await holdCard(ROSA, 'Rosa');
                await render(createElement(PeopleScreen));
                expect(membersRequests()).toEqual([]);
                expect(text()).toContain('members on this node');
                expect(text()).toContain('Rosa');
                expect(text()).toContain('Newest');
            });
        });

        describe('New message', () => {
            it("recents and friends from the cards held, the heading and the empty line say what this list is", async () => {
                await render(createElement(NewMessageScreen));
                expect(text()).toContain("People you've dealt with");
                expect(text()).toContain('No one here yet');
                expect(text()).toContain('Type 2 letters of a name to find anyone in the community.');
                expect(text()).not.toMatch(/Sync with a node|Community Directory/);
                expect(contrastOf('Type 2 letters of a name to find anyone in the community.', colors)).toBeGreaterThanOrEqual(4.5);
                expect(membersRequests()).toEqual([]);
                await fits([OWN]);
            });

            it('online: a search asks the node, and a DM started from a result keeps that card, stamped', async () => {
                await render(createElement(NewMessageScreen));
                await type('Ro');
                expect(membersRequests()).toEqual(['/api/members?q=Ro&limit=20']);
                expect(text()).toContain('Rosa');
                // The DM itself is the node's to make: refused here, the card is kept all the same.
                const row = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Rosa'))!;
                await press(row);
                const kept = await (await db.getDb()).getFirstAsync<{ callsign: string; card_fetched_at: string | null }>('SELECT callsign, card_fetched_at FROM members WHERE public_key = ?', [ROSA]);
                expect(kept?.callsign).toBe('Rosa');
                expect(kept?.card_fetched_at).toBeTruthy();
                await fits([OWN, ROSA]);
            });

            it('offline: the held cards answer the search, and the empty line says to connect', async () => {
                await holdCard(KOFI, 'Kofi');
                node.online = false;
                await render(createElement(NewMessageScreen));
                expect(text()).toContain('Kofi');
                await type('Ro');
                expect(text()).toContain('No one you have dealt with matches');
                expect(text()).toContain('Connect to search everyone.');
                await type('Ko');
                expect(text()).toContain('Kofi');
                await fits([OWN, KOFI]);
            });
        });

        describe('Invite people to a group', () => {
            const sheet = () => createElement(InvitePeopleSheet, { isOpen: true, groupId: 'g1', groupName: 'Garden', existing: new Set<string>(), myPubkey: OWN, onClose: () => {}, onInvited: () => {} });

            it('online, no card held: the picker\'s words, never "Nobody else is in this community"; a search asks the node', async () => {
                await render(sheet());
                expect(text()).toContain('No one here yet');
                expect(text()).toContain('Type 2 letters of a name to find anyone in the community.');
                expect(text()).not.toContain('Nobody else is in this community yet.');
                expect(contrastOf('Type 2 letters of a name to find anyone in the community.', colors)).toBeGreaterThanOrEqual(4.5);
                node.requests.length = 0;
                await type('R');
                expect(membersRequests()).toEqual([]);
                expect(text()).toContain('Type at least 2 letters of a name to search everyone.');
                await type('Ro');
                expect(membersRequests()).toEqual(['/api/members?q=Ro&limit=20']);
                expect(text()).toContain('Rosa');
                await type('Zz');
                expect(text()).toContain('No members match your search');
                await fits([OWN]);
            });

            it('offline, a card held: the held card, and a search for anyone else says to connect', async () => {
                await holdCard(KOFI, 'Kofi');
                node.online = false;
                await render(sheet());
                expect(text()).toContain('Kofi');
                await type('Ro');
                expect(text()).toContain('No one you have dealt with matches');
                expect(text()).toContain('Connect to search everyone.');
                expect(text()).not.toContain('Nobody by that name.');
                await fits([OWN, KOFI]);
            });

            it('a local community (switch absent) keeps its words', async () => {
                community.membersOnDemand = false;
                await render(sheet());
                expect(text()).toContain('Nobody else is in this community yet.');
            });
        });

        describe('Chats', () => {
            it('(a) a card held: the name; (c) none held: the key\'s first 8 characters, never the conversation id', async () => {
                await holdCard(KOFI, 'Kofi');
                await holdConversationWith(KOFI, 'conv-kofi');
                await holdConversationWith(ROSA, 'conv-rosa');
                node.online = false;
                await render(createElement(ChatsScreen));
                expect(text()).toContain('Kofi');
                expect(text()).toContain(ROSA.slice(0, 8));
                expect(text()).not.toContain('conv-ros');
                await fits([OWN, KOFI]);
                // The tap opens the conversation, whose header opens the profile by key (below).
                await press(Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(ROSA.slice(0, 8)))!);
                expect(nav.pushed).toContainEqual('/chat/conv-rosa');
            });

            it('(b) none held and online: the name after one request by key', async () => {
                await holdConversationWith(ROSA, 'conv-rosa');
                const got = await (await import('../members-lookup')).fetchCardByKey(ROSA);
                expect(got).toBe('fetched');
                expect(membersRequests()).toEqual([`/api/members?keys=${ROSA}`]);
                await render(createElement(ChatsScreen));
                expect(text()).toContain('Rosa');
                await fits([OWN, ROSA]);
            });
        });

        describe('My Deals', () => {
            async function holdDeal(partner: string) {
                await (await db.getDb()).runAsync(
                    "INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at, post_title) VALUES ('tx-1', 'post-1', ?, ?, 12, 'completed', ?, ?, 'Sourdough loaf')",
                    [OWN, partner, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
            }

            it("(c) none held and offline: \"From\" and the key's first 8 characters, never a blank", async () => {
                await holdDeal(ROSA);
                node.online = false;
                await render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: OWN }, onClose: () => {}, initialTab: 'history' }));
                expect(text()).toContain('Sourdough loaf');
                expect(text()).toContain(`From ${ROSA.slice(0, 8)}`);
                await fits([OWN]);
            });

            it('(a) a card held, and (b) the card fetched by key in one request: the name', async () => {
                await holdDeal(KOFI);
                await holdCard(KOFI, 'Kofi');
                await render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: OWN }, onClose: () => {}, initialTab: 'history' }));
                expect(text()).toContain('From Kofi');
                await act(async () => root.render(null as any));
                await (await db.getDb()).runAsync("UPDATE marketplace_transactions SET seller_pubkey = ? WHERE id = 'tx-1'", [ROSA]);
                expect(await (await import('../members-lookup')).fetchCardByKey(ROSA)).toBe('fetched');
                expect(membersRequests()).toEqual([`/api/members?keys=${ROSA}`]);
                await render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: OWN }, onClose: () => {}, initialTab: 'history' }));
                expect(text()).toContain('From Rosa');
                await fits([OWN, KOFI, ROSA]);
            });
        });

        describe('Public profile', () => {
            it('(c) none held and offline: the name the caller passed, "Connect to see more", and no spinner left turning', async () => {
                node.online = false;
                nav.params = { publicKey: ROSA, callsign: 'Rosa' };
                await render(createElement(PublicProfileScreen));
                expect(text()).toContain('Rosa');
                expect(text()).toContain('Connect to see more');
                expect(contrastOf('Connect to see more', colors)).toBeGreaterThanOrEqual(4.5);
                await fits([OWN]);
            });

            it('(c) none held, offline, and no name passed: the key\'s first 8 characters', async () => {
                node.online = false;
                nav.params = { publicKey: ROSA };
                await render(createElement(PublicProfileScreen));
                expect(text()).toContain(ROSA.slice(0, 8));
                expect(text()).toContain('Connect to see more');
                await fits([OWN]);
            });

            it('(b) none held and online: one request by key, the name, the card kept stamped, no "Connect to see more"', async () => {
                nav.params = { publicKey: KOFI };
                await render(createElement(PublicProfileScreen));
                expect(membersRequests()).toEqual([`/api/members?keys=${KOFI}`]);
                expect(text()).toContain('Kofi');
                expect(text()).not.toContain('Connect to see more');
                await fits([OWN, KOFI]);
            });

            it('the node profile known a moment after the screen mounts: each read once, the stale card fetched once', async () => {
                community.lateMs = 30;
                await holdCard(ROSA, 'Rosa');
                await (await db.getDb()).runAsync('UPDATE members SET card_fetched_at = ? WHERE public_key = ?', ['2026-01-01T00:00:00.000Z', ROSA]);
                nav.params = { publicKey: ROSA, callsign: 'Rosa' };
                await render(createElement(PublicProfileScreen));
                await settle(100);
                const byPath: Record<string, number> = {};
                for (const r of node.requests) { const p = r.split('?')[0].replace(/[0-9a-f]{64}/, ':key'); byPath[p] = (byPath[p] ?? 0) + 1; }
                expect(membersRequests()).toEqual([`/api/members?keys=${ROSA}`]);
                expect(Object.keys(byPath).length).toBeGreaterThan(1);
                for (const [path, n] of Object.entries(byPath)) expect(n, path).toBe(1);
                expect(text()).toContain('Rosa');
            });

            it('(a) a card held and fresh: no request for it, the name it holds', async () => {
                await holdCard(ROSA, 'Rosa');
                nav.params = { publicKey: ROSA };
                await render(createElement(PublicProfileScreen));
                expect(membersRequests()).toEqual([]);
                expect(text()).toContain('Rosa');
                expect(text()).not.toContain('Connect to see more');
                await fits([OWN, ROSA]);
            });
        });
    });
}
