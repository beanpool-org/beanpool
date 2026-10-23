// @vitest-environment jsdom
/**
 * A tap on an enterprise opens the enterprise page, never a member's Trust Profile (scratch/tools/
 * DESIGN-shops-round3-enterprise-shopfront-fable.md §0 rows 1–2, §1.1, slice E1).
 *
 * Every door on the phone that opens someone by key pushes `/public-profile` with `publicKey`: a post's author card and
 * its deal peer and requester (post/[id].tsx), the deal chat's peer (chat/[id].tsx), the map's listing preview
 * ((tabs)/map.tsx, protected: read here, never changed), PostAuthorTrust, PulseFeedCard, AddedYouLines and the People
 * lists. None of them knows what the key is, so the profile screen is where an enterprise is told apart: the node's
 * trust profile for the key says `isTreasury` (server slice E0), and the screen replaces itself with `/treasury-detail`.
 * Until the node has said, a key this phone holds no member card for (the member directory never carries an
 * enterprise) draws no Trust Profile at all; a member whose card is held is drawn at once, as before. The node's own
 * BeanPool account, the author of every curated Pulse card, is a treasury row but no enterprise: its trust profile says
 * no `isTreasury`, and the Pulse door opens its profile with its channel chips.
 *
 * The phone's own utils/db runs on its real schema in an in-memory SQLite; the node is a fetch stand-in that answers
 * the trust profile per key (held until the test lets it through, where a case needs the moment before the answer).
 * React Native's host components are plain tags carrying their accessibility props and flattened style (as
 * members-on-demand-screens-render.test.ts), at the floor's window (320 × 569 dp, text at 1.3×), light and dark.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
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
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = (e: Event) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        attrs['data-style'] = JSON.stringify(flat(props.style));
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    const asNode = (c: unknown): ReactNode => (typeof c === 'function' ? createElement(c as any) : (c as ReactNode));
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }: Record<string, any>) =>
        createElement('div', { 'data-list': 'true' },
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
        Animated: { View: el('div'), Text: el('span'), FlatList, Value, timing: anim, spring: anim, loop: anim, sequence: anim, parallel: anim, event: () => () => {}, createAnimatedComponent: (c: unknown) => c },
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
/** Where the screens went: a push (a door), and a replace (the profile screen handing over to the enterprise page). */
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, pushed: [] as unknown[], replaced: [] as unknown[] }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => nav.pushed.push(to), navigate: (to: unknown) => nav.pushed.push(to), replace: (to: unknown) => nav.replaced.push(to), back: () => {}, setParams: () => {}, canGoBack: () => true },
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
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
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
// A local community, Beans and enterprises on (where enterprises exist at all), unless a case says otherwise.
const community = vi.hoisted(() => ({
    features: { beans: true, escrow: true, invites: true, decisions: true, enterprises: true, exampleListings: false } as Record<string, boolean>,
    profile() { return { profile: 'local', checkedAt: new Date().toISOString(), features: this.features }; },
}));
vi.mock('../use-node-profile', () => ({
    useNodeProfile: () => community.profile(),
    useNodeProfileState: () => ({ profile: community.profile(), copyRead: true }),
}));
vi.mock('../node-profile', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getCachedNodeProfile: vi.fn(async () => community.profile()),
    fetchNodeProfile: vi.fn(async () => community.profile()),
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ callsign }: { callsign: string }) => createElement('span', { 'data-avatar': callsign }) }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));
// The real chips, from the channels the node lists per key (none, unless a case sets some).
const channels = vi.hoisted(() => ({ byKey: new Map<string, unknown[]>() }));
vi.mock('../channels', () => ({ fetchPublicChannels: vi.fn(async (publicKey: string) => channels.byKey.get(publicKey) ?? []) }));
// The Pulse card's player is a WebView: nothing a door's test reads.
vi.mock('../../components/PulseYouTubePlayer', () => ({ PulseYouTubePlayer: () => null }));

// The node: the trust profile per key (an enterprise's says isTreasury, server slice E0), and who added this member.
const NODE_URL = 'https://mullum.example';
const ENTERPRISE = '7'.repeat(64);
const ENTERPRISE_NAME = "Damo's Enterprise";
const KOFI = '3'.repeat(64);
const memberTrust = (publicKey: string, callsign: string) => ({
    publicKey, callsign,
    tier: { name: 'Newcomer', emoji: '🌱' }, earnedCredit: 0, stats: { tradeCount: 0, uniquePartners: 0 }, completionRate: null,
    risk: { band: 'red', headline: 'New & unvouched — take normal precautions', reasons: ['New member with no completed trades yet.'], tips: ['Meet somewhere public the first time.'] },
    vouchedInBy: { kind: 'admin', publicKey: null, callsign: null, avatarUrl: null, tier: null },
    mutualCount: 0, mutualConnections: [], joinedAt: '2026-09-01T00:00:00.000Z', lastActiveAt: null, elderVouch: null,
});
/** What the node answers for an enterprise's key since slice E0: the same shape, saying what the key is. */
const ENTERPRISE_TRUST = { ...memberTrust(ENTERPRISE, ENTERPRISE_NAME), isTreasury: true, elderVouch: { publicKey: OWN, callsign: 'Damo', avatarUrl: null } };
const node = {
    online: true,
    requests: [] as string[],
    trust: new Map<string, Record<string, unknown>>(),
    /** While set, every trust profile waits for it: the moment before the node has said what the key is. */
    trustGate: null as Promise<void> | null,
    /** The same, for one key only: its answer comes late while another key's comes at once. */
    trustGates: new Map<string, Promise<void>>(),
    addedYou: [] as Array<{ publicKey: string; callsign: string; avatarUrl: null; addedAt: string }>,
};
function holdTrust(): () => void {
    let open!: () => void;
    node.trustGate = new Promise<void>(r => { open = r; });
    return open;
}
function holdTrustFor(publicKey: string): () => void {
    let open!: () => void;
    node.trustGates.set(publicKey, new Promise<void>(r => { open = r; }));
    return open;
}
async function nodeFetch(input: unknown, init?: { body?: unknown }): Promise<Response> {
    const url = new URL(String(input));
    if (!node.online) throw new TypeError('Network request failed');
    node.requests.push(`${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/trust/profile') {
        const { targetPubkey } = JSON.parse(String(init?.body ?? '{}'));
        if (node.trustGate) await node.trustGate;
        const gate = node.trustGates.get(targetPubkey);
        if (gate) await gate;
        const answer = node.trust.get(targetPubkey);
        return answer ? json(answer) : json({ error: 'Member not found' }, 404);
    }
    if (url.pathname === '/api/friends/added-you') return json({ addedYou: node.addedYou, more: 0 });
    return json({ error: 'not here' }, 404);
}

import { darkColors, lightColors } from '../../constants/colors';
import * as db from '../db';
import PublicProfileScreen from '../../app/public-profile';
import { PostAuthorTrust } from '../../components/PostAuthorTrust';
import { AddedYouLines } from '../../components/AddedYouLines';
import { PulseFeedCard } from '../../components/PulseFeedCard';

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
    node.trust = new Map<string, Record<string, unknown>>([[ENTERPRISE, ENTERPRISE_TRUST], [KOFI, memberTrust(KOFI, 'Kofi')]]);
    node.trustGate = null;
    node.trustGates = new Map<string, Promise<void>>();
    node.addedYou = [];
    channels.byKey = new Map<string, unknown[]>();
    community.features = { beans: true, escrow: true, invites: true, decisions: true, enterprises: true, exampleListings: false };
    nav.params = {};
    nav.pushed.length = 0;
    nav.replaced.length = 0;
    theme.dark = false;
    globalThis.fetch = vi.fn(nodeFetch) as typeof fetch;
    const database = await db.getDb();
    for (const t of ['members', 'posts', 'ratings', 'friends']) await database.runAsync(`DELETE FROM ${t}`).catch(() => {});
    await database.runAsync('INSERT INTO members (public_key, callsign, joined_at) VALUES (?, ?, ?)', [OWN, 'Me', '2026-01-01T00:00:00.000Z']);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (ms = 0) => {
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, i === 0 ? ms : 0)); });
};
const render = async (el: unknown) => { await act(async () => { root.render(el as any); }); await settle(); };
const text = () => host.textContent ?? '';
const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const holdCard = async (publicKey: string, callsign: string) => {
    await (await db.getDb()).runAsync('INSERT INTO members (public_key, callsign, joined_at) VALUES (?, ?, ?)', [publicKey, callsign, '2026-03-01T00:00:00.000Z']);
};

/** Words only the member Trust Profile draws: none of them may show for an enterprise's key, at any moment. */
const TRUST_PROFILE_WORDS = ['Trust Profile', 'Reciprocity Health', 'Vouched by', 'Vouch for', 'Trust Points', 'Collaboration Chemistry', 'Joined', 'Block'];
const expectNoTrustProfile = (when: string) => {
    for (const w of TRUST_PROFILE_WORDS) expect(text(), `${w} (${when})`).not.toContain(w);
    expect(host.querySelector('[data-testid="trust-track-record"]'), when).toBeNull();
};
const toEnterprisePage = { pathname: '/treasury-detail', params: { publicKey: ENTERPRISE, name: ENTERPRISE_NAME } };
/** A curated Pulse card, as GET /api/pulse/feed hands it out: its author is the key that owns its channel. */
const pulseCard = (ownerPubkey: string, callsign: string) => ({
    id: `pi_${ownerPubkey.slice(0, 6)}`, ownerPubkey, callsign, avatarUrl: null, platform: 'youtube', category: 'learn',
    url: 'https://www.youtube.com/watch?v=tgsN2LiUVa0', title: 'The BeanPool Economy', thumbnailUrl: null,
    publishedAt: '2026-08-04T00:00:00Z', source: 'official', isVerified: false,
});

for (const dark of [false, true]) {
    describe(`An enterprise's key on the profile screen (${dark ? 'dark' : 'light'}, 320 dp × 1.3)`, () => {
        beforeEach(() => { theme.dark = dark; });

        it('no card held: no Trust Profile is drawn before the node answers, then the screen replaces itself with the enterprise page', async () => {
            const open = holdTrust();
            nav.params = { publicKey: ENTERPRISE, callsign: ENTERPRISE_NAME };
            await render(createElement(PublicProfileScreen));
            // The node has not said yet: the screen waits, with Back, and draws nothing of a member's profile.
            expectNoTrustProfile('before the node answers');
            expect(host.querySelector('[data-spinner]')).not.toBeNull();
            expect(host.querySelector('[role="button"]')?.textContent).toContain('Back');
            expect(nav.replaced).toEqual([]);
            await act(async () => { open(); });
            await settle(20);
            expect(nav.replaced).toEqual([toEnterprisePage]);
            expect(nav.pushed).toEqual([]);
            expectNoTrustProfile('after the node answered');
            // The waiting state draws in the palette's own colours: its Back is the body text colour, as the profile's own Back.
            const colors = dark ? darkColors : lightColors;
            const back = host.querySelector('[data-testid="profile-kind-pending-back"]')!;
            expect(JSON.parse(back.querySelector('span')?.getAttribute('data-style') ?? '{}').color).toBe(colors.text.body);
        });

        it('a card held for the key (an older directory): drawn at once, then handed to the enterprise page when the node says what it is', async () => {
            await holdCard(ENTERPRISE, ENTERPRISE_NAME);
            nav.params = { publicKey: ENTERPRISE, callsign: ENTERPRISE_NAME };
            await render(createElement(PublicProfileScreen));
            await settle(20);
            expect(nav.replaced).toEqual([toEnterprisePage]);
        });

        it('a member with a card held: the Trust Profile at once, never replaced', async () => {
            const open = holdTrust();
            await holdCard(KOFI, 'Kofi');
            nav.params = { publicKey: KOFI, callsign: 'Kofi' };
            await render(createElement(PublicProfileScreen));
            expect(text()).toContain('Trust Profile');
            expect(text()).toContain('Kofi');
            await act(async () => { open(); });
            await settle(20);
            expect(nav.replaced).toEqual([]);
            expect(text()).toContain('Trust Profile');
            expect(text()).toContain('Newcomer');
        });

        it('a member with no card held: the Trust Profile once the node has answered, never replaced', async () => {
            nav.params = { publicKey: KOFI, callsign: 'Kofi' };
            await render(createElement(PublicProfileScreen));
            await settle(20);
            expect(nav.replaced).toEqual([]);
            expect(text()).toContain('Trust Profile');
            expect(text()).toContain('Kofi');
        });

        it('offline with no card: the profile as before (the name passed), never a spinner left turning', async () => {
            node.online = false;
            nav.params = { publicKey: KOFI, callsign: 'Kofi' };
            await render(createElement(PublicProfileScreen));
            await settle(20);
            expect(nav.replaced).toEqual([]);
            expect(text()).toContain('Kofi');
            expect(host.querySelector('[data-spinner]')).toBeNull();
        });

        it('a community with enterprises switched off: no wait for a key with no card, and never replaced', async () => {
            community.features = { ...community.features, enterprises: false };
            const open = holdTrust();
            nav.params = { publicKey: KOFI, callsign: 'Kofi' };
            await render(createElement(PublicProfileScreen));
            // Drawn at once (the trust panel's own spinner turns while its read is out, as before).
            expect(text()).toContain('Kofi');
            expect(text()).toContain('Trust Profile');
            await act(async () => { open(); });
            await settle(20);
            expect(nav.replaced).toEqual([]);
        });

        // The screen can be handed a new key in place (a voucher or mutual link on a profile opens another): what it holds
        // for the last key never stands for the new one (review of #2367).
        it("a key changed in place from a member's held card to an enterprise's: the member's card is not drawn for it while the node is asked", async () => {
            await holdCard(KOFI, 'Kofi');
            nav.params = { publicKey: KOFI, callsign: 'Kofi' };
            await render(createElement(PublicProfileScreen));
            await settle(20);
            expect(text()).toContain('Trust Profile');
            expect(text()).toContain('Kofi');
            const open = holdTrust();
            nav.params = { publicKey: ENTERPRISE, callsign: ENTERPRISE_NAME };
            await render(createElement(PublicProfileScreen));
            expectNoTrustProfile('the new key, before the node answers');
            expect(text()).not.toContain('Kofi');
            expect(host.querySelector('[data-testid="profile-kind-pending-back"]')).not.toBeNull();
            await act(async () => { open(); });
            await settle(20);
            expect(nav.replaced).toEqual([toEnterprisePage]);
        });

        it("a key changed in place while the last key's trust profile is out: its late answer never lands on the new key", async () => {
            const openEnterprise = holdTrustFor(ENTERPRISE);
            nav.params = { publicKey: ENTERPRISE, callsign: ENTERPRISE_NAME };
            await render(createElement(PublicProfileScreen));
            nav.params = { publicKey: KOFI, callsign: 'Kofi' };
            await render(createElement(PublicProfileScreen));
            await settle(20);
            expect(text()).toContain('Trust Profile');
            expect(text()).toContain('Newcomer');
            await act(async () => { openEnterprise(); });
            await settle(20);
            expect(nav.replaced).toEqual([]);
            expect(host.querySelector('[data-testid="profile-kind-pending-back"]')).toBeNull();
            expect(text()).toContain('Trust Profile');
            expect(text()).toContain('Kofi');
            expect(text()).toContain('Newcomer');
        });

        it("the member's own profile: never waits on the node, never replaced", async () => {
            const open = holdTrust();
            nav.params = { publicKey: OWN };
            await render(createElement(PublicProfileScreen));
            expect(text()).toContain('My Profile');
            await act(async () => { open(); });
            await settle(20);
            expect(nav.replaced).toEqual([]);
        });
    });
}

// The node's own BeanPool account owns the curated learn channel and every channel an admin adds: a treasury row, but no
// enterprise, so the node's trust profile for it carries no isTreasury (server, review of #2367). Every curated Pulse
// card is BeanPool's, so its author door is the first one a new member taps.
const BEANPOOL = 'b'.repeat(64);
const BEANPOOL_LEARN = {
    id: 'chan_beanpool_learn', platform: 'youtube', url: 'https://www.youtube.com/channel/UC-b27mPemXxYje4VkKF7hgw', handle: '@BeanPool',
    category: 'learn', isPrimaryVideo: true, supportsAutolist: true, isVerified: false,
};
for (const dark of [false, true]) {
    describe(`The Pulse card's author door, for the node's own BeanPool account (${dark ? 'dark' : 'light'}, 320 dp × 1.3)`, () => {
        beforeEach(() => {
            theme.dark = dark;
            node.trust.set(BEANPOOL, memberTrust(BEANPOOL, 'BeanPool'));
            channels.byKey.set(BEANPOOL, [BEANPOOL_LEARN]);
        });

        it("opens BeanPool's profile with its learn channel, never the enterprise page", async () => {
            await render(createElement(PulseFeedCard, { item: pulseCard(BEANPOOL, 'BeanPool'), currentPubkey: OWN }));
            await press(host.querySelector('[aria-label="View BeanPool\'s public profile"]')!);
            expect(nav.pushed).toEqual([{ pathname: '/public-profile', params: { publicKey: BEANPOOL } }]);
            await act(async () => root.render(null as any));
            nav.params = (nav.pushed[0] as { params: Record<string, string> }).params;
            await render(createElement(PublicProfileScreen));
            await settle(20);
            expect(nav.replaced).toEqual([]);
            expect(host.querySelector('[data-testid="profile-kind-pending-back"]')).toBeNull();
            expect(text()).toContain('BeanPool');
            const chips = host.querySelector('[aria-label="External channels"]');
            expect(chips, "BeanPool's channel chips").not.toBeNull();
            expect(chips!.querySelector('[aria-label="YouTube @BeanPool"]'), 'its learn channel').not.toBeNull();
            expect(chips!.textContent).toContain('YouTube · @BeanPool');
            expect(node.requests).toContain('/api/trust/profile');
        });
    });
}

describe('Every door lands on the enterprise page', () => {
    /** Follows a door's push to the profile screen, as the router would, and reads where the screen sent the member. */
    async function follow(push: unknown): Promise<unknown[]> {
        const to = push as { pathname: string; params: Record<string, string> };
        expect(to.pathname).toBe('/public-profile');
        expect(to.params.publicKey).toBe(ENTERPRISE);
        await act(async () => root.render(null as any));
        nav.params = to.params;
        await render(createElement(PublicProfileScreen));
        await settle(20);
        expectNoTrustProfile('after a door');
        return nav.replaced;
    }

    it("a post's author (PostAuthorTrust, the Market's cards and the post screen)", async () => {
        await render(createElement(PostAuthorTrust, { pubkey: ENTERPRISE, callsign: ENTERPRISE_NAME, mode: 'full' }));
        await press(host.querySelector(`[aria-label="View ${ENTERPRISE_NAME}'s profile"]`)!);
        expect(nav.pushed).toHaveLength(1);
        expect(await follow(nav.pushed[0])).toEqual([{ pathname: '/treasury-detail', params: { publicKey: ENTERPRISE, name: ENTERPRISE_NAME } }]);
    });

    it('People → Friends: "added you" (AddedYouLines)', async () => {
        node.addedYou = [{ publicKey: ENTERPRISE, callsign: ENTERPRISE_NAME, avatarUrl: null, addedAt: '2026-10-20T00:00:00.000Z' }];
        await render(createElement(AddedYouLines, { myKey: OWN, onAddedBack: () => {} }));
        await press(host.querySelector(`[aria-label="${ENTERPRISE_NAME} added you. Open their profile"]`)!);
        expect(nav.pushed).toHaveLength(1);
        expect(await follow(nav.pushed[0])).toEqual([{ pathname: '/treasury-detail', params: { publicKey: ENTERPRISE, name: ENTERPRISE_NAME } }]);
    });

    it("a door that passes no name (PulseFeedCard's author): the enterprise page, named as the node names it", async () => {
        expect(await follow({ pathname: '/public-profile', params: { publicKey: ENTERPRISE } })).toEqual([{ pathname: '/treasury-detail', params: { publicKey: ENTERPRISE, name: ENTERPRISE_NAME } }]);
    });

    it("PulseFeedCard's author button → the profile screen → the enterprise page, for an enterprise's card", async () => {
        await render(createElement(PulseFeedCard, { item: pulseCard(ENTERPRISE, ENTERPRISE_NAME), currentPubkey: OWN }));
        await press(host.querySelector(`[aria-label="View ${ENTERPRISE_NAME}'s public profile"]`)!);
        expect(nav.pushed).toEqual([{ pathname: '/public-profile', params: { publicKey: ENTERPRISE } }]);
        expect(await follow(nav.pushed[0])).toEqual([{ pathname: '/treasury-detail', params: { publicKey: ENTERPRISE, name: ENTERPRISE_NAME } }]);
    });

    // The doors inside whole screens (post/[id], chat/[id], People, the protected map) are read from their source: each
    // opens someone by key only through this one screen, so the redirect above is theirs too. A door that opened the
    // Trust Profile any other way, or a new door, fails here until it is looked at.
    it('every door in the app opens someone by key through /public-profile with their publicKey, and nothing else draws a Trust Profile', () => {
        const appRoot = path.resolve(__dirname, '../..');
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of fs.readdirSync(dir)) {
                const p = path.join(dir, name);
                if (name === 'node_modules' || name === '__tests__') continue;
                if (fs.statSync(p).isDirectory()) walk(p);
                else if (/\.(tsx?|jsx?)$/.test(name)) files.push(p);
            }
        };
        for (const d of ['app', 'components', 'utils', 'tools']) if (fs.existsSync(path.join(appRoot, d))) walk(path.join(appRoot, d));
        const doors: Record<string, number> = {};
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            const rel = path.relative(appRoot, f);
            const pushes = [...src.matchAll(/pathname:\s*'\/public-profile'/g)].length;
            if (pushes) doors[rel] = pushes;
            // A push's params, in its next lines: always the key, by the name the screen reads.
            for (const m of src.matchAll(/pathname:\s*'\/public-profile'[\s\S]{0,200}?params:\s*\{([^}]*)\}/g)) {
                expect(m[1], `${rel}: a door to the profile screen passes publicKey`).toMatch(/\bpublicKey\s*:/);
            }
            // Nothing but the profile screen draws "Trust Profile".
            if (rel !== path.join('app', 'public-profile.tsx')) expect(src, rel).not.toMatch(/t\('Trust Profile'\)/);
        }
        // §1.1's doors, and the member's own profile (the Ledger tab, the header, a voucher or mutual link on a profile).
        expect(doors).toEqual({
            [path.join('app', 'post', '[id].tsx')]: 3,
            [path.join('app', 'chat', '[id].tsx')]: 2,
            [path.join('app', '(tabs)', 'map.tsx')]: 1,
            [path.join('app', '(tabs)', 'people.tsx')]: 2,
            [path.join('app', '(tabs)', 'ledger.tsx')]: 1,
            [path.join('app', 'public-profile.tsx')]: 2,
            [path.join('components', 'PostAuthorTrust.tsx')]: 1,
            [path.join('components', 'PulseFeedCard.tsx')]: 1,
            [path.join('components', 'AddedYouLines.tsx')]: 1,
            [path.join('components', 'GlobalHeader.tsx')]: 1,
            // The shopfront's keeper rows and a shop's owner line (S5): a member, opened by their key.
            [path.join('components', 'shopfront', 'Shopfront.tsx')]: 1,
            [path.join('app', 'shop', '[id].tsx')]: 1,
        });
    });
});
