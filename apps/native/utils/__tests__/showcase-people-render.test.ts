// @vitest-environment jsdom
/**
 * People → Invites on the worldwide community, the whole screen rendered for real (scratch/global-node/
 * DESIGN-global-showcase-fable.md §1 row 8, §4): the node takes no invites and previews them, so the view says "Bring
 * someone here" with the marker's line, and asks nothing of the reader's own invite codes. The first-draw recipe of
 * showcase-ledger-render.test.ts: the mode is decided as on a phone (the phone's own copy of the node's profile, through
 * useNodeProfileState → useReaderFeatures, nothing mocked between); the codes are not asked for until it is known, and an
 * answer begun under another mode never draws over the preview.
 *
 * The net spy: fetch, XMLHttpRequest and WebSocket, and the node calls People makes through its helpers (the membership
 * probe, a node role, the join requests) are recorded. A local community's Invites, the same screen, is drawn first as the
 * control: its call for the member's codes is seen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LOCAL_COMMUNITY_LINES, inviteFolds } from '@beanpool/core';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
/** What the screen handed the share sheet or the clipboard: a preview hands neither anything. */
const sent = vi.hoisted(() => ({ shares: [] as unknown[], clips: [] as unknown[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (placeholder) attrs.placeholder = placeholder;
        // A field the member types in (People's invite box): what they type reaches the screen.
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
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
        Alert: { alert() {} },
        Share: { share: async (d: unknown) => { sent.shares.push(d); return {}; } },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {}, replace() {} },
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
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
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('react-native-qrcode-svg', () => ({ default: (props: any) => createElement('div', { 'data-testid': 'qr-code', 'data-qr-value': props?.value }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async (v: unknown) => { sent.clips.push(v); } }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    // The ask sheet's lift (components/InviteAsks.tsx, useModalKeyboardLift): no keyboard here.
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    // The voucher card's modal (people.tsx, slice V2) sits in one.
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
// People reads the vouchers block through utils/names-list.ts, which keeps the names key in the secure store: nothing here.
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const me = vi.hoisted(() => ({ identity: { publicKey: 'a-real-member-key', callsign: 'RealMember' } as Record<string, string> | null }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
// People's own node helpers: recorded, never answered (the screen waits, as on a phone with no answer yet).
const net = vi.hoisted(() => ({ calls: [] as string[] }));
const { never } = vi.hoisted(() => ({ never: (what: string) => { net.calls.push(what); return new Promise<never>(() => {}); } }));
vi.mock('../db', () => ({
    getDb: () => never('db.getDb'), getFriendsLocal: async () => [], addFriendLocal: () => never('db.addFriendLocal'),
    removeFriendLocal: () => never('db.removeFriendLocal'), createConversationApi: () => never('db.createConversationApi'),
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../member-statements', () => ({ makeOfflineTicket: () => never('makeOfflineTicket') }));
vi.mock('../membership-probe', () => ({ fetchMembership: () => never('fetchMembership') }));
vi.mock('../node-admin', () => ({
    askNodeRole: () => never('askNodeRole'), persistNodeRole: async () => {}, readPersistedNodeRole: async () => undefined, rememberNodeRole() {},
}));
vi.mock('../knock-inbox', () => ({ fetchJoinRequests: () => never('fetchJoinRequests') }));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: () => never('joinAnotherCommunity'), joinedNudge: () => '', PROTECT_REDIRECT: '/', HOME_REDIRECT: '/' }));
vi.mock('../community-switch', () => ({ communitySwitched: () => () => {} }));
vi.mock('../global-join-existing', () => ({
    isGlobalCommunity: (url: string | null | undefined) => !!url && url.trim().replace(/\/+$/, '').toLowerCase() === 'https://global.beanpool.org',
}));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'checking' }));
vi.mock('../node-post', () => ({
    signedGet: (_url: string, path: string) => never(`signedGet ${path}`),
    signedPost: (_url: string, path: string) => never(`signedPost ${path}`),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../../components/WantsToJoin', () => ({ WantsToJoin: () => null }));
vi.mock('../../components/MyJoinRequests', () => ({ MyJoinRequests: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));

import PeopleScreen from '../../app/(tabs)/people';

const NODE = 'https://global.example';
function rememberProfile(profile: 'global' | 'local', features: Record<string, boolean>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}
const WORLDWIDE = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true };
const INVITES = `${NODE}/api/invite/mine/a-real-member-key`;
/** A fetch that records every URL; the node's profile and the member's codes answer only when a test lets them. */
// Every screen hook that wants the profile asks for it (each its own copy), so every held ask of a URL is kept.
const answers = vi.hoisted(() => ({ held: new Map<string, Array<(r: Response) => void>>() }));
const land = (url: string, body: unknown) => { for (const r of answers.held.get(url) ?? []) r(new Response(JSON.stringify(body), { status: 200 })); };
function recordingFetch(holdProfile: boolean) {
    return vi.fn((url: unknown) => {
        const u = String(url);
        net.calls.push(`fetch ${u}`);
        if (u === INVITES || (holdProfile && u.endsWith('/api/community/info'))) return new Promise<Response>(resolve => answers.held.set(u, [...(answers.held.get(u) ?? []), resolve]));
        return new Promise<Response>(() => {});
    }) as typeof fetch;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    inviteFolds.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    sent.shares.length = 0;
    sent.clips.length = 0;
    answers.held.clear();
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    me.identity = { publicKey: 'a-real-member-key', callsign: 'RealMember' };
    globalThis.fetch = recordingFetch(false);
    (globalThis as any).XMLHttpRequest = class { open() { net.calls.push('xhr'); } send() { net.calls.push('xhr'); } setRequestHeader() {} };
    (globalThis as any).WebSocket = class { constructor() { net.calls.push('ws'); } };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
const render = async (node: unknown) => { await act(async () => { root.render(node as any); }); await settle(); };
const text = () => host.textContent ?? '';
const OWN_CODE = { code: 'OWN-CODE-7731', createdBy: 'a-real-member-key', createdAt: new Date().toISOString() };

const USED_CODE = { code: 'INV-ABCD-EFGH', createdBy: 'a-real-member-key', createdAt: new Date().toISOString(), usedBy: 'someone-else', usedAt: new Date().toISOString(), intendedFor: 'Kofi' };

describe("the control: a local community's Invites, the same screen", () => {
    it("asks its node for the member's own codes, so the spy sees this screen's call", async () => {
        rememberProfile('local', { invites: true, showcase: false });
        await render(createElement(PeopleScreen));
        expect(net.calls).toContain(`fetch ${INVITES}`);
        expect(text()).not.toContain(LOCAL_COMMUNITY_LINES.invites);
        expect(host.querySelector('[data-testid="local-community-strip"]')).toBeNull();
        expect(text()).not.toContain('Example Valley');
    });

    it("on a local community with pending and redeemed codes, does not show QR toggle, REDEEMED section, or tree", async () => {
        rememberProfile('local', { invites: true, showcase: false });
        await render(createElement(PeopleScreen));
        await act(async () => { land(INVITES, { invites: [OWN_CODE, USED_CODE] }); });
        await settle();
        // Pending and Joined are folded until opened, with their counts in the row.
        expect(text()).toContain('Pending (1)');
        expect(text()).toContain('Joined (1)');
        expect(text()).not.toContain('OWN-CODE-7731');
        await act(async () => { (host.querySelector('[data-testid="invites-pending-fold"]') as HTMLElement).click(); });
        await settle();
        const t = text();
        const buttons = Array.from(host.querySelectorAll('button')).map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
        expect(t).toContain('OWN-CODE-7731');
        expect(buttons.includes('Show QR code')).toBe(false);
        expect(buttons.some(b => b.includes('📱'))).toBe(false);
        expect(/REDEEMED/.test(t)).toBe(false);
        expect(/Community Tree/.test(t)).toBe(false);
    });
});

describe('Invites on the worldwide community, its profile on the phone', () => {
    it("says how a local community grows, and never asks for the member's own codes", async () => {
        rememberProfile('global', WORLDWIDE);
        await render(createElement(PeopleScreen));
        expect(text()).toContain('Bring someone here');
        expect(text()).toContain(LOCAL_COMMUNITY_LINES.invites);
        expect(net.calls).not.toContain(`fetch ${INVITES}`);
    });

    it("renders the real invite screen fed sample invites, used invites, and community tree", async () => {
        rememberProfile('global', WORLDWIDE);
        await render(createElement(PeopleScreen));

        // Strip and Example header
        expect(host.querySelector('[data-testid="local-community-strip"]')).not.toBeNull();
        expect(text()).toContain('Example Valley');
        expect(text()).toContain('An example invitation.');

        // Sample pending invite
        expect(text()).toContain('EXAMPLE-1234');
        expect(text()).toContain('For: a neighbour');

        // Sample redeemed invites
        expect(text()).toContain('EXAMPLE-5678');
        expect(text()).toContain('EXAMPLE-9012');

        // Tree
        expect(text()).toContain('Community Tree');
        expect(text()).toContain('an example member');
        expect(text()).toContain('a neighbour');

        // Every marker, the QR card's too once 📱 opens it, opens its own sheet; nothing is shared or copied.
        const markers = () => Array.from(host.querySelectorAll('[data-testid="local-community-action"]')) as HTMLElement[];
        const sheets = () => Array.from(host.querySelectorAll('[data-testid="local-community-sheet"]'));
        const pressEach = async (them: HTMLElement[]) => {
            for (const marker of them) {
                expect(sheets()).toHaveLength(0);
                await act(async () => { marker.click(); });
                await settle();
                expect(sheets()).toHaveLength(1);
                const close = host.querySelector('[data-modal] [aria-label="Close"]') as HTMLElement;
                await act(async () => { close.click(); });
                await settle();
                expect(sheets()).toHaveLength(0);
            }
        };
        const labels = (them: HTMLElement[]) => them.map((m) => m.getAttribute('aria-label'));
        const first = markers();
        expect(labels(first)).toEqual([expect.stringMatching(/^✨ Generate/), expect.stringMatching(/^Share, /)]);
        await pressEach(first);
        const qrToggle = host.querySelector('[aria-label="Show QR code"]') as HTMLElement;
        await act(async () => { qrToggle.click(); });
        await settle();
        const withQr = markers();
        expect(labels(withQr)).toEqual([expect.stringMatching(/^✨ Generate/), expect.stringMatching(/^📤 Share Invite, /), expect.stringMatching(/^Share, /)]);
        await pressEach([withQr[1]]);
        expect(sent.shares).toEqual([]);
        expect(sent.clips).toEqual([]);
    });

    it("draws a QR code that encodes only EXAMPLE-1234 when toggled, refusing any URL prefix", async () => {
        rememberProfile('global', WORLDWIDE);
        await render(createElement(PeopleScreen));

        // Find the QR toggle button (📱)
        const qrButtons = Array.from(host.querySelectorAll('button')).filter(
            (b) => b.getAttribute('aria-label') === 'Show QR code' || b.textContent?.includes('📱')
        );
        expect(qrButtons.length).toBeGreaterThan(0);

        // Click QR button
        await act(async () => { (qrButtons[0] as HTMLElement).click(); });
        await settle();

        // Check QR code rendered
        const qr = host.querySelector('[data-testid="qr-code"]');
        expect(qr).not.toBeNull();
        expect(qr?.getAttribute('data-qr-value')).toBe('EXAMPLE-1234');
        expect(qr?.getAttribute('data-qr-value')).not.toContain('http');
        expect(qr?.getAttribute('data-qr-value')).not.toContain('?invite=');
    });
});

describe("a phone that has never heard the worldwide community's profile", () => {
    it("starts as a local community; the member's own codes that land after the switch to preview never draw", async () => {
        globalThis.fetch = recordingFetch(true);
        await render(createElement(PeopleScreen));
        expect(net.calls).toEqual(expect.arrayContaining([`fetch ${INVITES}`, `fetch ${NODE}/api/community/info`]));
        await act(async () => { land(`${NODE}/api/community/info`, { profile: 'global', features: WORLDWIDE }); });
        await settle();
        expect(text()).toContain(LOCAL_COMMUNITY_LINES.invites);
        await act(async () => { land(INVITES, { invites: [OWN_CODE] }); });
        await settle();
        expect(text()).not.toContain('OWN-CODE-7731');
        expect(text()).toContain(LOCAL_COMMUNITY_LINES.invites);
    });
});

/**
 * The rule on People's Join Another Community (Marty, board card balance-rule-other-doors, 3 Nov 2026: "Yes, show the
 * sentence"): an invite typed for another community draws, above Join Community, the one sentence that community's join
 * screen and rules page say, where it confirms its members, read from it once the typing stops. Nothing to tick or tap.
 * Never for the member's own community, and nothing before a code is typed. Before this the form said nothing of the
 * rule: the "rule on" test fails there.
 */
describe("the joined community's rule on People's Join Another Community", () => {
    const OTHER = 'https://riverside.example';
    const RULE = { known: true, knownFloor: 100, debtLinePct: 30, quietDays: 21, debtLineFrom: null, quietDaysFrom: null };
    const SENTENCE = "The admins can see a confirmed member's balance if they owe more than 30% of their credit line, or are in debit and haven't made a sale for 21 days. Each look is logged.";
    const rules = { by: new Map<string, unknown>() };
    beforeEach(() => {
        rules.by.clear();
        rememberProfile('local', { invites: true, showcase: false });
        const others = recordingFetch(false);
        globalThis.fetch = vi.fn((url: unknown, init?: RequestInit) => {
            const u = String(url);
            if (u.endsWith('/api/community/known-rule')) {
                net.calls.push(`fetch ${u}`);
                const body = rules.by.get(u.replace('/api/community/known-rule', ''));
                return Promise.resolve(body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('{"error":"Not found"}', { status: 404 }));
            }
            return others(url as any, init);
        }) as typeof fetch;
    });
    const typeInvite = async (v: string) => {
        const box = host.querySelector('input[placeholder="Invite URL or token"]') as HTMLInputElement | null;
        expect(box, "People's invite box").not.toBeNull();
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        await act(async () => { setValue.call(box, v); box!.dispatchEvent(new Event('input', { bubbles: true })); });
        // The typing stops: the read waits 600 ms, as the join screen's does.
        await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
        await settle();
    };
    const ruleLine = () => host.querySelector('[data-testid="people-join-rule"]')?.textContent ?? null;
    const ruleReads = () => net.calls.filter((c) => c.endsWith('/api/community/known-rule'));

    it('nothing typed: no sentence, and nothing read for it', async () => {
        rules.by.set(NODE, RULE);
        await render(createElement(PeopleScreen));
        expect(host.querySelector('input[placeholder="Invite URL or token"]')).not.toBeNull();
        expect(ruleLine()).toBeNull();
        expect(ruleReads()).toEqual([]);
    });

    it("rule on: an invite link to another community draws that community's sentence, read from it", async () => {
        rules.by.set(OTHER, RULE);
        await render(createElement(PeopleScreen));
        await typeInvite(`${OTHER}/?invite=INV-ABCD-EFGH`);
        expect(ruleLine()).toBe(SENTENCE);
        expect(ruleReads()).toEqual([`fetch ${OTHER}/api/community/known-rule`]);
        expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    });

    it('rule off there: no sentence', async () => {
        rules.by.set(OTHER, { known: false });
        await render(createElement(PeopleScreen));
        await typeInvite(`${OTHER}/?invite=INV-ABCD-EFGH`);
        expect(ruleReads()).toEqual([`fetch ${OTHER}/api/community/known-rule`]);
        expect(ruleLine()).toBeNull();
    });

    it("a bare code joins nowhere new (the member's own community): no sentence, even where it has the rule", async () => {
        rules.by.set(NODE, RULE);
        await render(createElement(PeopleScreen));
        await typeInvite('INV-ABCD-EFGH');
        expect(ruleLine()).toBeNull();
        expect(ruleReads()).toEqual([]);
    });

    it('an invite naming an address that is not plain: no sentence, and the screen still draws', async () => {
        await render(createElement(PeopleScreen));
        await typeInvite('https://user@riverside.example/?invite=INV-ABCD-EFGH');
        expect(host.querySelector('input[placeholder="Invite URL or token"]')).not.toBeNull();
        expect(ruleLine()).toBeNull();
        expect(ruleReads()).toEqual([]);
    });
});
