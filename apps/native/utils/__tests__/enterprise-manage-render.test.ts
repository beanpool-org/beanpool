// @vitest-environment jsdom
/**
 * The keepers' Manage console (slice S7 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3, §6; Marty's
 * answers of 23 Oct 2026): every keeper action the enterprise page had moves to its console, and the public page keeps no
 * operator control. Manage sits in the page's header for its keepers (and a node admin, whose keeper requests they are);
 * the console holds the requests and changes, succession, the operator controls with bids and deals, the sweep, the
 * keepers' votes, removing a keeper and stepping down, the discussion's removals, the season and the wind-up, cancelling
 * an initiative; and its face (any keeper: About, logo, kind, how we deal; the lead: name and purpose, the others told
 * why), with one Save, and Featured (up to six of its live Offers in its shop).
 *
 * app/treasury-detail.tsx and app/treasury-manage.tsx rendered for real, in light and dark at the floor's window (320 ×
 * 569 dp, text at 1.3×); the node is the net-spy stand-in for utils/db.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], last: [] as Array<{ text?: string; onPress?: () => void }> }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio', checkbox: 'checkbox', alert: 'alert', tab: 'tab' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, placeholder, onLayout, value, onChangeText, disabled, numberOfLines, editable } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (editable === false) attrs.readOnly = true;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (numberOfLines !== undefined) attrs['data-lines'] = String(numberOfLines);
        if (placeholder) attrs.placeholder = placeholder;
        attrs['data-style'] = JSON.stringify(flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style));
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => void }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                alerts.last = buttons ?? [];
            },
        },
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
const nav = vi.hoisted(() => ({ pushes: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push(to: unknown) { nav.pushes.push(to); }, navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true },
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
vi.mock('expo-image', () => ({ Image: ({ source }: { source?: { uri?: string } }) => createElement('img', { src: source?.uri }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'a-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return {
        KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardStickyView: pass,
        KeyboardController: { dismiss: async () => {} },
        useKeyboardState: (pick?: (s: { height: number; isVisible: boolean }) => unknown) => (pick ? pick({ height: 0, isVisible: false }) : { height: 0, isVisible: false }),
    };
});
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const colors = () => (theme.dark ? darkColors : lightColors);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors(), patternEnabled: false }),
    };
});
// Digits only: a key's first characters, shown where a member has no name, carry no letters.
const ME = '1'.repeat(64);
const KOFI = '2'.repeat(64);
const MIA = '3'.repeat(64);
const ZOE = '4'.repeat(64);
const ENT = '9'.repeat(64);
const me = vi.hoisted(() => ({ identity: { publicKey: '1'.repeat(64), callsign: 'Ana' } as Record<string, string> }));
vi.mock('../identity', () => ({ loadIdentity: async () => me.identity }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ size, avatarUrl }: { size?: number; avatarUrl?: string | null }) => createElement('span', { 'data-avatar': String(size ?? ''), 'data-src': avatarUrl ?? '' }) }));
// The logo's picker: a picture the keeper chose, already the phone's small copy.
const PICKED = 'data:image/jpeg;base64,/9j/AAAA';
vi.mock('../../components/AvatarPickerSheet', () => ({
    AvatarPickerSheet: ({ visible, onSelectImage, onClose }: { visible: boolean; onSelectImage: (uri: string) => void; onClose: () => void }) => (visible
        ? createElement('button', { 'data-testid': 'picker-pick', onClick: () => { onSelectImage(PICKED); onClose(); } }, 'pick')
        : null),
}));
vi.mock('../node-post', () => ({ signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}), anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null, getCachedAnchorUrl: () => store.map.get('beanpool_anchor_url') ?? null }));
const net = vi.hoisted(() => ({ calls: [] as string[], args: [] as Array<[string, unknown[]]>, answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => { net.args.push([name, args]); return net.answer?.(name, args); }));
vi.mock('../blocklist', () => ({ blockUser: async () => true, isUserBlocked: async () => false }));

import { setLanguage, type ScopedDecisionList } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { darkColors, lightColors } from '../../constants/colors';
import TreasuryDetailScreen from '../../app/treasury-detail';
import TreasuryManageScreen from '../../app/treasury-manage';

const NODE = 'https://mullum.example';
const NAME = 'Hill Bakery';
const PURPOSE = 'Bread for the whole valley';
const ABOUT = 'We bake on Saturdays in the old hall.';
const HOW = 'Pick up at the hall on Saturday mornings.';
const SHOP_ID = 'shop-1';
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const DECISIONS: ScopedDecisionList = {
    decisions: [{
        id: 'd1', authorPubkey: KOFI, title: 'Pay Mia for the oven door', description: 'She fixed the hinge.', effect: 'pay_out', subject: MIA,
        params: { amount: 12.5 }, status: 'open', opensAt: iso(now - 3600_000), closesAt: iso(now + 4 * DAY),
        tally: { voted: 1, roll: 3, quorumRequired: 2, thresholdRequired: 0.6 }, myVote: null, canVote: true,
    }],
    canPropose: true, rollSize: 3,
};
const SHOP = { id: SHOP_ID, kind: 'baking', counts: { things: 2 }, name: NAME, ownerPublicKey: ENT, ownerName: NAME, enterprise: true, blurb: null, howToDeal: HOW, paused: false, backOn: null, openedAt: iso(now - 30 * DAY) };
/** The enterprise as its lead keeper reads it: a request and a change waiting, a bid, two deals, a message to remove. */
function leadsView(over: Record<string, unknown> = {}) {
    return {
        publicKey: ENT, name: NAME, purpose: PURPOSE, about: ABOUT, since: iso(now - 60 * DAY), offerCategories: ['baking'],
        lifecycle: 'ongoing', status: 'active', paused: false,
        balance: 40, creditLine: 100, liveOffers: 2, earnedSurplus: 7, workingCapitalCeiling: 400,
        isLeadOrSoleKeeperOrAdmin: true, availableToBack: 40, shop: SHOP,
        keepers: [
            { publicKey: ME, callsign: 'Ana', role: 'lead', grantedAt: iso(now - 300 * DAY) },
            { publicKey: KOFI, callsign: 'Kofi', role: 'keeper', backing: 20, grantedAt: iso(now - 200 * DAY) },
            { publicKey: MIA, callsign: 'Mia', role: 'keeper', grantedAt: iso(now - 100 * DAY) },
        ],
        keeperRequests: [{ id: 'r1', callsign: 'Ivo', pledgedBacking: 15, canBackPledge: true }],
        keeperChanges: [{ id: 'c1', kind: 'add', memberPubkey: ZOE, memberCallsign: 'Zoe', proposedBy: KOFI, proposedByCallsign: 'Kofi', pledgedBacking: 10, appliesAt: iso(now + 2 * DAY) }],
        deferredClaims: [],
        posts: [{ id: 'p1', type: 'offer', category: 'baking', title: 'Sourdough loaf', credits: 4, price_type: 'fixed', status: 'active' }],
        flow: [],
        pendingBids: [{ id: 'b1', post_title: 'Oven repair', peer_callsign: 'Ivo', credits: 30 }],
        activeDeals: [
            { id: 'x1', post_id: 'p1', post_title: 'Sourdough loaf', peer_callsign: 'Zoe', credits: 4, action_required: 'fulfill' },
            { id: 'x2', post_id: 'p2', post_title: 'Oven repair', peer_callsign: 'Mia', credits: 30, action_required: 'pay', price_type: 'fixed' },
        ],
        ...over,
    };
}
/** A project whose leader has gone quiet, as one of its other collaborators reads it. */
function quietProject(over: Record<string, unknown> = {}) {
    return leadsView({
        lifecycle: 'bounded', status: 'active', isLeadOrSoleKeeperOrAdmin: false, keeperRequests: [], keeperChanges: [], goalAmount: 500, currentAmount: 120,
        keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }, { publicKey: ME, callsign: 'Ana', role: 'keeper' }, { publicKey: ZOE, callsign: 'Zoe', role: 'keeper' }],
        leadInactivity: { isEligible: true, leadPubkey: KOFI, leadCallsign: 'Kofi', daysInactive: 34 },
        succession: { proposals: [] },
        ...over,
    });
}
const THREAD = [{ id: 'm1', type: 'text', ciphertext: b64('see you at the stall'), authorCallsign: 'Kofi', authorPubkey: KOFI, timestamp: iso(now - DAY) }];
/** What `author=` answers for its keepers: three of its Offers in its shop (one featured), one not in it yet, one Need. */
const OFFERS = [
    { id: 'p1', type: 'offer', category: 'baking', title: 'Sourdough loaf', credits: 4, priceType: 'fixed', status: 'active', audienceScope: 'public', featuredAt: iso(now - DAY), shopId: SHOP_ID },
    { id: 'p3', type: 'offer', category: 'baking', title: 'Rye loaf', credits: 5, priceType: 'fixed', status: 'active', audienceScope: 'public', featuredAt: null, shopId: SHOP_ID },
    { id: 'p4', type: 'offer', category: 'baking', title: 'Seed bread', credits: 6, priceType: 'fixed', status: 'pending', audienceScope: 'public', featuredAt: null, shopId: SHOP_ID },
    { id: 'p5', type: 'offer', category: 'baking', title: 'Fruit buns', credits: 3, priceType: 'fixed', status: 'active', audienceScope: 'public', featuredAt: null, shopId: null },
    { id: 'n1', type: 'need', category: 'tools', title: 'A new oven door', credits: 30, priceType: 'fixed', status: 'active', audienceScope: 'public', shopId: null },
];
type Writer = (method: string, path: string, body: unknown) => Promise<unknown>;
function community(over: Record<string, unknown> = {}, opts: { offers?: unknown; write?: Writer } = {}): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Record<string, unknown> = {
        getTreasuryDetail: leadsView(),
        getBalance: { balance: 10, keeperOf: [ENT] },
        getEnterpriseThread: { conversation: null, messages: THREAD, readOnly: false },
        getEnterpriseLedger: null,
        getEnterpriseDecisions: DECISIONS,
        ...over,
    };
    const offers = opts.offers ?? OFFERS;
    return (name, args) => {
        if (name === 'signedGet') {
            const path = String(args[0]);
            if (path.startsWith(`/api/marketplace/posts?author=${ENT}`)) {
                if (offers === 'down') return Promise.reject(new TypeError('Network request failed'));
                return Promise.resolve({ ok: true, status: 200, json: async () => offers });
            }
            return undefined;
        }
        if (name === 'signedRequestWithMethod') {
            const [method, path, body] = args as [string, string, unknown];
            return (opts.write ?? okWrites)(method, path, body);
        }
        return name in answers ? Promise.resolve(answers[name]) : undefined;
    };
}
/** The node takes every change and answers it as its routes do. */
const okWrites: Writer = async (method, path, body) => {
    if (path === `/api/treasury/${ENT}/profile`) return { success: true, publicKey: ENT, name: NAME, purpose: PURPOSE, about: ABOUT, ...(body as object) };
    if (path === `/api/treasury/${ENT}/shop`) return { success: true, shop: { ...SHOP, ...(body as object) }, paused: [], resumed: [] };
    if (path === `/api/treasury/${ENT}/shop/offers`) return { success: true, added: (body as { postIds: string[] }).postIds };
    if (/^\/api\/marketplace\/posts\/[^/]+\/feature$/.test(path)) return { success: true, postId: path.split('/')[4], featuredAt: (body as { featured: boolean }).featured ? iso(now) : null };
    throw Object.assign(new Error(`unexpected ${method} ${path}`), { status: 500 });
};
const writes = () => net.args.filter(([n]) => n === 'signedRequestWithMethod').map(([, a]) => ({ method: a[0], path: a[1], body: a[2] }));
const LOCAL = { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.args.length = 0;
    net.answer = community();
    params.now = { publicKey: ENT, name: NAME };
    nav.pushes.length = 0;
    alerts.said.length = 0;
    alerts.last = [];
    theme.dark = false;
    me.identity = { publicKey: ME, callsign: 'Ana' };
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: LOCAL, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render(screen: 'page' | 'console') {
    act(() => root.unmount());
    root = createRoot(host);
    const el = createElement(screen === 'page' ? TreasuryDetailScreen : TreasuryManageScreen);
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, el) as any); });
    await settle();
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const byLabel = (label: string) => host.querySelector(`[aria-label="${label.replace(/"/g, '\\"')}"]`);
const buttonWith = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text) ?? null;
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const type = async (el: Element | null | undefined, text: string, what: string) => {
    expect(el, what).toBeTruthy();
    const input = el as HTMLInputElement;
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');

/**
 * Every keeper action the enterprise page had before the console (app/treasury-detail.tsx at f6104d01), each with the
 * view of the enterprise it shows for and how a member finds it: its spoken name, or its words on a button.
 */
type View = 'lead' | 'paused' | 'windingUp' | 'quietProject' | 'quietProjectVote';
const ACTIONS: Array<{ what: string; view: View; label?: string; button?: string; testID?: string }> = [
    { what: "approve a member's request to keep it", view: 'lead', label: 'Approve keeper request' },
    { what: "decline a member's request to keep it", view: 'lead', label: 'Decline keeper request' },
    { what: 'object to a keeper change', view: 'lead', label: 'Object: Adding Zoe as a keeper, backing 10 beans' },
    { what: 'remove a keeper', view: 'lead', label: 'Remove Kofi as a keeper' },
    { what: 'step down', view: 'lead', label: 'Step down as a keeper' },
    { what: 'post its Offer', view: 'lead', button: 'Post Offer' },
    { what: 'post its Need', view: 'lead', button: 'Post Need' },
    { what: 'sweep its surplus to the Commons', view: 'lead', label: 'Sweep to the Commons' },
    { what: 'say how much to sweep', view: 'lead', label: 'Amount to sweep to the Commons' },
    { what: 'approve a bid on its Need', view: 'lead', button: 'Approve Bid (30 🫘)' },
    { what: 'decline a bid on its Need', view: 'lead', button: 'Decline' },
    { what: 'open a deal it is fulfilling', view: 'lead', button: 'Fulfill Deal · Awaiting Customer Release' },
    { what: 'release the payment of a deal', view: 'lead', button: 'Release Payment (30 🫘)' },
    { what: 'propose a vote among the keepers', view: 'lead', button: 'Propose a vote' },
    { what: 'remove a message from its discussion', view: 'lead', label: 'Remove message from Kofi' },
    { what: 'pause for the season', view: 'lead', label: 'Pause for Season' },
    { what: 'start the wind-up', view: 'lead', label: 'Start Wind-Up' },
    { what: 'resume after a pause', view: 'paused', label: 'Resume Enterprise' },
    { what: 'stop the wind-up', view: 'windingUp', label: 'Stop Wind-Up' },
    { what: 'finalise the wind-up', view: 'windingUp', label: 'Finalise Wind-Up' },
    { what: 'propose a new leader while the leader is quiet', view: 'quietProject', label: 'Propose Active Collaborator as Leader' },
    { what: 'cancel an initiative and refund its backers', view: 'quietProject', label: 'Cancel initiative and refund escrow' },
    { what: 'vote yes on a new leader', view: 'quietProjectVote', label: 'Yes, make Zoe leader' },
    { what: 'vote no on a new leader', view: 'quietProjectVote', label: 'No, do not make Zoe leader' },
];
const PROPOSAL = { id: 's1', status: 'active', candidatePubkey: ZOE, candidateCallsign: 'Zoe', votesCount: 1, noVotesCount: 0, requiredVotes: 2, totalEligible: 3, deadlineAt: iso(now + 13 * DAY), votes: [] };
const VIEWS: Record<View, () => Record<string, unknown>> = {
    lead: () => leadsView(),
    paused: () => leadsView({ paused: true, pausedAt: iso(now - 5 * DAY) }),
    windingUp: () => leadsView({ status: 'winding_up', windUpInitiatedBy: KOFI, windUpGraceEndsAt: iso(now - 3600_000) }),
    quietProject: () => quietProject(),
    quietProjectVote: () => quietProject({ succession: { proposals: [PROPOSAL] } }),
};
const found = (a: (typeof ACTIONS)[number]) => (a.label ? byLabel(a.label) : buttonWith(a.button!));

for (const dark of [false, true]) {
    describe(`the keepers' console (${dark ? 'dark' : 'light'}, 320 dp × 1.3)`, () => {
        beforeEach(() => { theme.dark = dark; });
        const colors = () => (dark ? darkColors : lightColors);

        it('a keeper reads Manage in the page\'s header, in the central tokens; it opens the console for this enterprise', async () => {
            await render('page');
            const manage = byId('enterprise-manage');
            expect(manage?.textContent).toBe('Manage');
            expect(styleOf(manage).minHeight).toBeGreaterThanOrEqual(44);
            expect(styleOf(manage).borderColor).toBe(colors().brand.primary);
            expect(manage?.querySelector('span')?.getAttribute('data-style')).toContain(colors().brand.primary);
            await click(manage, 'Manage');
            expect(nav.pushes).toContainEqual({ pathname: '/treasury-manage', params: { publicKey: ENT, name: NAME } });
        });

        it('a member who keeps none of it reads no Manage; a node admin who keeps none of it does, for the requests are theirs', async () => {
            net.answer = community({ getTreasuryDetail: leadsView({ isLeadOrSoleKeeperOrAdmin: false, keeperRequests: [], keeperChanges: [], keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }] }), getBalance: { balance: 10, keeperOf: [] } });
            await render('page');
            expect(byId('shopfront-name')?.textContent).toBe(NAME);
            expect(byId('enterprise-manage')).toBeNull();
            expect(host.textContent).not.toContain('Manage');

            net.answer = community({ getTreasuryDetail: leadsView({ keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }] }), getBalance: { balance: 10, keeperOf: [] } });
            await render('page');
            expect(byId('enterprise-manage')).not.toBeNull();
        });

        it('the public page keeps no operator control, in every state a keeper had one', async () => {
            for (const view of Object.keys(VIEWS) as View[]) {
                net.answer = community({ getTreasuryDetail: VIEWS[view]() });
                await render('page');
                expect(byId('shopfront-name')?.textContent, view).toBe(NAME);
                for (const a of ACTIONS.filter((x) => x.view === view)) expect(found(a), `${a.what}, on the public page (${view})`).toBeNull();
                for (const words of ['OPERATOR CONTROLS', 'SEASON & LIFECYCLE CONTROLS', 'PENDING KEEPER REQUESTS', 'KEEPER CHANGES WAITING', 'PENDING BIDS ON NEEDS', 'ACTIVE DEALS', 'INACTIVE (']) {
                    expect(host.textContent, `${words} (${view})`).not.toContain(words);
                }
                expect(host.querySelector('[data-icon="trash-can-outline"]'), `a message's remove (${view})`).toBeNull();
            }
            // What every member does stays: the thread, Report, the money.
            expect(host.textContent).toContain('Discussion');
            expect(byLabel('Report Project')).not.toBeNull();
            expect(byId('shopfront-money-line')).not.toBeNull();
        });

        it('every keeper action of today is in the console, in the state it had it', async () => {
            for (const view of Object.keys(VIEWS) as View[]) {
                net.answer = community({ getTreasuryDetail: VIEWS[view]() });
                await render('console');
                expect(byId('manage-screen'), view).not.toBeNull();
                for (const a of ACTIONS.filter((x) => x.view === view)) expect(found(a), `${a.what}, in the console (${view})`).not.toBeNull();
            }
        });

        it('a release by the hour asks the hours; a candidate is picked from the keepers', async () => {
            net.answer = community({ getTreasuryDetail: leadsView({ activeDeals: [{ id: 'x2', post_id: 'p2', post_title: 'Oven repair', peer_callsign: 'Mia', credits: 30, action_required: 'pay', price_type: 'hourly', hours: 2 }] }) });
            await render('console');
            await click(buttonWith('Release Payment (30 🫘)'), 'Release Payment');
            expect(host.textContent).toContain('Confirm Hours Worked');

            net.answer = community({ getTreasuryDetail: quietProject() });
            await render('console');
            await click(byLabel('Propose Active Collaborator as Leader'), 'Propose');
            expect(host.textContent).toContain('Select an active collaborator to move the leader role to:');
            expect(byLabel('Propose Zoe as leader')).not.toBeNull();
        });

        it('someone who keeps none of it opening the console reads why, and nothing is offered or written', async () => {
            net.answer = community({ getTreasuryDetail: leadsView({ isLeadOrSoleKeeperOrAdmin: false, keeperRequests: [], keeperChanges: [], keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }] }), getBalance: { balance: 10, keeperOf: [] } });
            await render('console');
            expect(byId('manage-not-keeper')?.textContent).toBe('Only its keepers manage this enterprise.');
            for (const a of ACTIONS.filter((x) => x.view === 'lead')) expect(found(a), a.what).toBeNull();
            expect(byId('manage-face')).toBeNull();
            expect(writes()).toEqual([]);
        });

        // Its shop's routes and the feature route take its keepers only; its profile route takes a node admin too (PR #2405
        // review 4355986004).
        it('a node admin who keeps none of it gets the face its profile route takes: no kind, no how we deal, no Featured', async () => {
            net.answer = community({ getTreasuryDetail: leadsView({ shop: null, keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }] }), getBalance: { balance: 10, keeperOf: [] } });
            await render('console');
            expect(byId('manage-screen')).not.toBeNull();
            expect(byLabel('Approve keeper request')).not.toBeNull();
            expect(byId('manage-face')).not.toBeNull();
            expect((byId('manage-face-name') as HTMLInputElement).value).toBe(NAME);
            expect(byId('manage-face-purpose')).not.toBeNull();
            expect(byId('manage-face-about')).not.toBeNull();
            expect(byId('manage-face-logo')).not.toBeNull();
            expect(byId('manage-face-kind')).toBeNull();
            expect(byId('manage-face-how')).toBeNull();
            expect(byId('manage-featured')).toBeNull();
            expect(byId('manage-shop-open')).toBeNull();
            expect(host.textContent).not.toContain('OPERATOR CONTROLS');
            await type(byId('manage-face-about'), 'We bake on Saturdays and Wednesdays.', 'About');
            await click(byId('manage-face-save'), 'Save');
            expect(writes()).toEqual([{ method: 'PUT', path: `/api/treasury/${ENT}/profile`, body: { about: 'We bake on Saturdays and Wednesdays.' } }]);
            expect(byId('manage-face-saved')?.textContent).toBe('Saved.');
        });

        it('the console unreachable says so in a sentence, with Try again', async () => {
            net.answer = community({ getTreasuryDetail: null });
            await render('console');
            expect(byId('manage-offline')?.textContent).toContain("Couldn't load this group. Check your connection.");
            expect(byId('manage-retry')).not.toBeNull();
        });

        describe('its face, with one Save', () => {
            it('the lead changes its name and kind: one Save sends each field that changed, to its own route, and says it is saved', async () => {
                await render('console');
                const face = byId('manage-face');
                expect(face).not.toBeNull();
                expect(styleOf(face).backgroundColor).toBe(colors().surface.card);
                expect((byId('manage-face-name') as HTMLInputElement).value).toBe(NAME);
                expect((byId('manage-face-purpose') as HTMLInputElement).value).toBe(PURPOSE);
                expect((byId('manage-face-about') as HTMLInputElement).value).toBe(ABOUT);
                expect((byId('manage-face-how') as HTMLInputElement).value).toBe(HOW);
                expect(byId('manage-face-lead-only')).toBeNull();
                expect(byId('manage-face-save')?.getAttribute('aria-disabled')).toBe('true');

                await type(byId('manage-face-name'), 'Hill Bakery and Mill', 'name');
                expect(byId('manage-face-kind')?.textContent).toContain('🍞 Cooked food and baking');
                await click(byId('manage-face-kind'), 'Kind');
                await click(byId('shop-kind-pick-food'), 'the kind');
                expect(byId('shop-kind-sheet')).toBeNull();
                expect(byId('manage-face-kind')?.textContent).toContain('🥕 Food from the garden or farm');
                await click(byId('manage-face-save'), 'Save');
                expect(writes()).toEqual([
                    { method: 'PUT', path: `/api/treasury/${ENT}/profile`, body: { name: 'Hill Bakery and Mill' } },
                    { method: 'PUT', path: `/api/treasury/${ENT}/shop`, body: { kind: 'food' } },
                ]);
                expect(byId('manage-face-saved')?.textContent).toBe('Saved.');
            });

            it('a new logo goes as the picture the keeper chose, with nothing else', async () => {
                await render('console');
                await click(byId('manage-face-logo'), 'Change the logo');
                await click(byId('picker-pick'), 'a picture');
                expect(byId('manage-face-logo-image')?.querySelector('[data-avatar="56"]')?.getAttribute('data-src')).toBe(PICKED);
                await click(byId('manage-face-save'), 'Save');
                expect(writes()).toEqual([{ method: 'PUT', path: `/api/treasury/${ENT}/profile`, body: { avatar: PICKED } }]);
            });

            it('a keeper who does not lead reads its name and purpose, and why they are the lead\'s; their About goes alone', async () => {
                net.answer = community({ getTreasuryDetail: leadsView({ isLeadOrSoleKeeperOrAdmin: false, keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }, { publicKey: ME, callsign: 'Ana', role: 'keeper' }] }) });
                await render('console');
                expect(byId('manage-face-name')).toBeNull();
                expect(byId('manage-face-purpose')).toBeNull();
                expect(byId('manage-face-name-shown')?.textContent).toContain(NAME);
                expect(byId('manage-face-purpose-shown')?.textContent).toContain(PURPOSE);
                expect(byId('manage-face-lead-only')?.textContent).toBe("Only the lead keeper can change the enterprise's name or what it is for.");
                await type(byId('manage-face-about'), 'We bake on Saturdays and Wednesdays.', 'About');
                await click(byId('manage-face-save'), 'Save');
                expect(writes()).toEqual([{ method: 'PUT', path: `/api/treasury/${ENT}/profile`, body: { about: 'We bake on Saturdays and Wednesdays.' } }]);
            });

            it('a refusal is the node\'s own sentence; nothing after it is sent', async () => {
                net.answer = community({}, {
                    write: async (method, path, body) => {
                        if (path.endsWith('/profile')) throw Object.assign(new Error('That name is already taken here. Pick another.'), { status: 409, code: 'name_taken' });
                        return okWrites(method, path, body);
                    },
                });
                await render('console');
                await type(byId('manage-face-name'), 'Kofi', 'name');
                await type(byId('manage-face-how'), 'Saturdays only.', 'how we deal');
                await click(byId('manage-face-save'), 'Save');
                expect(byId('manage-face-error')?.textContent).toBe('That name is already taken here. Pick another.');
                expect(writes().map((w) => w.path)).toEqual([`/api/treasury/${ENT}/profile`]);
                expect(byId('manage-face-saved')).toBeNull();
            });

            it('the enterprise read again (Put them in its shop) keeps what the keeper typed and picked; a field they left is the node\'s', async () => {
                // Each read a new copy, as the node's JSON is; since the first, another keeper changed what it is for.
                let reads = 0;
                const base = community();
                net.answer = (name, args) => {
                    if (name !== 'getTreasuryDetail') return base(name, args);
                    reads++;
                    return Promise.resolve(leadsView(reads > 1 ? { purpose: 'Bread and flour for the valley' } : {}));
                };
                await render('console');
                await type(byId('manage-face-about'), 'We bake on Saturdays and Wednesdays.', 'About');
                await type(byId('manage-face-how'), 'Saturdays only.', 'how we deal');
                await click(byId('manage-face-kind'), 'Kind');
                await click(byId('shop-kind-pick-food'), 'the kind');
                await click(byId('manage-face-logo'), 'Change the logo');
                await click(byId('picker-pick'), 'a picture');
                await click(byId('manage-shop-add'), 'Put them in its shop');
                expect(reads, 'the console read the enterprise again').toBeGreaterThan(1);
                expect((byId('manage-face-about') as HTMLInputElement).value).toBe('We bake on Saturdays and Wednesdays.');
                expect((byId('manage-face-how') as HTMLInputElement).value).toBe('Saturdays only.');
                expect(byId('manage-face-kind')?.textContent).toContain('🥕 Food from the garden or farm');
                expect(byId('manage-face-logo-image')?.querySelector('[data-avatar="56"]')?.getAttribute('data-src')).toBe(PICKED);
                expect((byId('manage-face-purpose') as HTMLInputElement).value).toBe('Bread and flour for the valley');
                await click(byId('manage-face-save'), 'Save');
                expect(writes().filter((w) => w.path !== `/api/treasury/${ENT}/shop/offers`)).toEqual([
                    { method: 'PUT', path: `/api/treasury/${ENT}/profile`, body: { about: 'We bake on Saturdays and Wednesdays.', avatar: PICKED } },
                    { method: 'PUT', path: `/api/treasury/${ENT}/shop`, body: { kind: 'food', howToDeal: 'Saturdays only.' } },
                ]);
            });

            it('its face saved and its shop\'s part refused: the new logo shows until it is read again, and only the refused part is sent again', async () => {
                const OLD = `${NODE}/api/members/${ENT}/avatar?v=old`;
                const NEW = `${NODE}/api/members/${ENT}/avatar?v=new`;
                let shopOpen = false;
                let faceWent = false;
                let land: ((d: unknown) => void) | null = null;
                const base = community({}, {
                    write: async (method, path, body) => {
                        if (path === `/api/treasury/${ENT}/shop` && !shopOpen) throw Object.assign(new Error('Its shop is closed for now.'), { status: 409, code: 'shop_paused' });
                        if (path === `/api/treasury/${ENT}/profile`) faceWent = true;
                        return okWrites(method, path, body);
                    },
                });
                // The read after the save is held, to land when the test says.
                net.answer = (name, args) => {
                    if (name !== 'getTreasuryDetail') return base(name, args);
                    if (!faceWent) return Promise.resolve(leadsView({ avatar: OLD }));
                    return new Promise((r) => { land = r; });
                };
                await render('console');
                await click(byId('manage-face-logo'), 'Change the logo');
                await click(byId('picker-pick'), 'a picture');
                await click(byId('manage-face-kind'), 'Kind');
                await click(byId('shop-kind-pick-food'), 'the kind');
                await click(byId('manage-face-save'), 'Save');
                expect(byId('manage-face-error')?.textContent).toBe('Its shop is closed for now.');
                expect(byId('manage-face-partly')?.textContent).toBe('Its other changes were saved.');
                const logo = () => byId('manage-face-logo-image')?.querySelector('[data-avatar="56"]')?.getAttribute('data-src');
                expect(logo(), 'the logo on the node now, not its old one').toBe(PICKED);
                expect(land, 'the enterprise is read again').not.toBeNull();
                await act(async () => { land!(leadsView({ avatar: NEW })); });
                await settle();
                expect(logo()).toBe(NEW);
                expect(byId('manage-face-kind')?.textContent).toContain('🥕 Food from the garden or farm');
                shopOpen = true;
                await click(byId('manage-face-save'), 'Save again');
                expect(writes()).toEqual([
                    { method: 'PUT', path: `/api/treasury/${ENT}/profile`, body: { avatar: PICKED } },
                    { method: 'PUT', path: `/api/treasury/${ENT}/shop`, body: { kind: 'food' } },
                    { method: 'PUT', path: `/api/treasury/${ENT}/shop`, body: { kind: 'food' } },
                ]);
            });

            it('no answer from the community says so, and keeps what was typed', async () => {
                net.answer = community({}, { write: async () => { throw new TypeError('Network request failed'); } });
                await render('console');
                await type(byId('manage-face-about'), 'New words.', 'About');
                await click(byId('manage-face-save'), 'Save');
                expect(byId('manage-face-error')?.textContent).toBe("Your community couldn't be reached. Try again.");
                expect((byId('manage-face-about') as HTMLInputElement).value).toBe('New words.');
            });
        });

        describe('Featured', () => {
            it('its live Offers in its shop, each on or off the shelf; a tap puts one on, through the feature route', async () => {
                await render('console');
                const shelf = byId('manage-featured');
                expect(shelf?.textContent).toContain('1 of 6 on the shelf');
                expect(byId('manage-feature-p1')?.getAttribute('aria-checked')).toBe('true');
                expect(byId('manage-feature-p3')?.getAttribute('aria-checked')).toBe('false');
                expect(byId('manage-feature-p4')).not.toBeNull();
                expect(byId('manage-feature-p5')).toBeNull();
                expect(byId('manage-feature-n1')).toBeNull();
                await click(byId('manage-feature-p3'), 'Rye loaf');
                expect(writes()).toEqual([{ method: 'PUT', path: '/api/marketplace/posts/p3/feature', body: { featured: true } }]);
                expect(byId('manage-feature-p3')?.getAttribute('aria-checked')).toBe('true');
                expect(byId('manage-featured')?.textContent).toContain('2 of 6 on the shelf');
            });

            it('six on the shelf: the rest wait, said once; one comes off with a tap', async () => {
                const six = Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, type: 'offer', title: `Loaf ${i}`, credits: 4, priceType: 'fixed', status: 'active', audienceScope: 'public', featuredAt: i < 6 ? iso(now - i * 1000) : null, shopId: SHOP_ID }));
                net.answer = community({}, { offers: six });
                await render('console');
                expect(byId('manage-featured-full')?.textContent).toBe('Six is the shelf; un-feature one first.');
                expect(byId('manage-feature-q6')?.getAttribute('aria-disabled')).toBe('true');
                await click(byId('manage-feature-q0'), 'Loaf 0');
                expect(writes()).toEqual([{ method: 'PUT', path: '/api/marketplace/posts/q0/feature', body: { featured: false } }]);
                expect(byId('manage-featured-full')).toBeNull();
            });

            it('its live Offers not in its shop yet go in with one tap, so they can be featured', async () => {
                await render('console');
                expect(byId('manage-shop-outside')?.textContent).toBe("1 of its live Offers isn't in its shop yet, so it can't be featured.");
                await click(byId('manage-shop-add'), 'Put them in its shop');
                expect(writes()).toEqual([{ method: 'POST', path: `/api/treasury/${ENT}/shop/offers`, body: { postIds: ['p5'] } }]);
            });

            it("a refusal is the node's own sentence; Offers that couldn't be read say so", async () => {
                net.answer = community({}, {
                    write: async () => { throw Object.assign(new Error("This Offer has ended, so it can't be featured."), { status: 400, code: 'feature_ended' }); },
                });
                await render('console');
                await click(byId('manage-feature-p3'), 'Rye loaf');
                expect(byId('manage-featured-error')?.textContent).toBe("This Offer has ended, so it can't be featured.");
                expect(byId('manage-feature-p3')?.getAttribute('aria-checked')).toBe('false');

                net.answer = community({}, { offers: 'down' });
                await render('console');
                expect(byId('manage-featured-unread')?.textContent).toBe("Its Offers couldn't be read just now.");
            });

            it('no shop yet: one tap opens it', async () => {
                net.answer = community({ getTreasuryDetail: leadsView({ shop: null }) });
                await render('console');
                expect(byId('manage-shop-none')?.textContent).toContain('It has no shop yet.');
                await click(byId('manage-shop-open'), 'Open its shop');
                expect(writes()).toEqual([{ method: 'PUT', path: `/api/treasury/${ENT}/shop`, body: {} }]);
            });
        });
    });
}
