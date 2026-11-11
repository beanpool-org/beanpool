// @vitest-environment jsdom
/**
 * People → Invites with the Vouchers block (Marty's §11, DESIGN-invites-and-names-list-amend2-fable.md): the whole screen
 * (app/(tabs)/people.tsx) rendered for real, with the recipe of showcase-people-render.test.ts, for five members of one
 * local community. Nothing between the screen and the node is stubbed but the network: a small fake node answers
 * GET /api/names/vouchers as engine/vouchers.ts and routes/names-list.ts do (owners and credit-committee admins get the
 * block; a plain admin gets 403 committee_only; anyone who isn't an owner or admin gets 403 admins_only), keyed by who signed
 * the request. The phone never decides who sees the block; these tests prove it shows exactly what the node answered.
 *
 * Which check fails if the screen's gate goes: people.tsx renders <VouchersBlock> only under `vouchersData &&`, set only
 * from an ok answer. Rendering it without that (e.g. `vouchers={vouchersData?.vouchers ?? []}` under `true &&`) fails
 * "a plain admin, a voucher and a member: no block" for all three roles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, value, onChangeText, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (placeholder) attrs.placeholder = placeholder;
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (disabled) attrs.disabled = true;
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
        Share: { share: async () => ({}) },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ pushed: [] as string[] }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push(to: string) { nav.pushed.push(to); }, navigate() {}, setParams() {}, replace() {} },
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
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => createElement('div', { 'data-testid': 'qr-code' }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
}));
// The safe area: the edges a SafeAreaView keeps clear are written on it, so a test can see the card's modal keeps the top.
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
    SafeAreaView: ({ children, edges, testID }: { children?: unknown; edges?: string[]; testID?: string }) =>
        createElement('div', { 'data-safe-area': (edges ?? ['top', 'right', 'bottom', 'left']).join(','), 'data-testid': testID }, children as any),
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const me = vi.hoisted(() => ({ identity: null as Record<string, string> | null }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
// Who signed: the fake node reads it from this header, as the real one reads the signature's key.
vi.mock('../crypto', () => ({ buildSignedHeaders: async (_m: string, _u: string, _b: string, _priv: string, pub: string) => ({ 'X-Signer': pub }) }));
const net = vi.hoisted(() => ({ calls: [] as string[] }));
const { never } = vi.hoisted(() => ({ never: (what: string) => { net.calls.push(what); return new Promise<never>(() => {}); } }));
vi.mock('../db', () => ({
    getDb: () => never('db.getDb'), getFriendsLocal: async () => [], addFriendLocal: () => never('db.addFriendLocal'),
    removeFriendLocal: () => never('db.removeFriendLocal'), createConversationApi: () => never('db.createConversationApi'),
}));
vi.mock('../member-statements', () => ({ makeOfflineTicket: () => never('makeOfflineTicket') }));
vi.mock('../membership-probe', () => ({ fetchMembership: () => never('fetchMembership') }));
vi.mock('../node-admin', () => ({
    askNodeRole: () => never('askNodeRole'), persistNodeRole: async () => {}, readPersistedNodeRole: async () => undefined, rememberNodeRole() {},
}));
vi.mock('../knock-inbox', () => ({ fetchJoinRequests: () => never('fetchJoinRequests') }));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: () => never('joinAnotherCommunity'), joinedNudge: () => '', PROTECT_REDIRECT: '/', HOME_REDIRECT: '/' }));
vi.mock('../community-switch', () => ({ communitySwitched: () => () => {} }));
vi.mock('../global-join-existing', () => ({ isGlobalCommunity: () => false }));
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
import { voucherRowText } from '../../components/VouchersBlock';

const NODE = 'https://mullum.example';
const key = (c: string) => c.repeat(64);
/** One local community's people: who each is to the node. */
const PEOPLE = {
    owner: { publicKey: key('a'), callsign: 'Sally', role: 'owner', committee: true },
    committeeAdmin: { publicKey: key('b'), callsign: 'Wren', role: 'admin', committee: true },
    plainAdmin: { publicKey: key('c'), callsign: 'Ash', role: 'admin', committee: false },
    voucher: { publicKey: key('d'), callsign: 'jane', role: 'member', committee: false },
    member: { publicKey: key('e'), callsign: 'Bea', role: 'member', committee: false },
} as const;
type Who = keyof typeof PEOPLE;

/** A voucher's row as the node sends it: every figure whole hundredths of a Bean (left 55000 is 550 Beans). */
const row = (pk: string, callsign: string, over: Record<string, unknown> = {}) => ({
    memberPubkey: pk, callsign, source: 'entry', entryId: '9'.repeat(32), madeBy: key('a'), madeByCallsign: 'Sally', madeAt: '2026-11-05T10:00:00Z',
    stoppedAt: null, stopReason: null, left: 55000, held: 10000, heldInvites: 1, vouched: 35000, peopleVouched: 4, level: 65000, belowZero: 1, writtenOff: 0,
    passedOn: { amount_c: 0, people: 0, belowZero: 0 }, invitesWithVouch: 5, trading: { withOthers: 2, insideOnly: 1 }, ...over,
});
/** The node's block, in the node's order (vouchersBlock() orders by callsign; here Wren before Jane's row to prove the phone keeps it). */
const OWNER_ROW = row(key('a'), 'Sally', { source: 'role', noLimit: true, left: 0, held: 0, level: 0, vouched: 20000, peopleVouched: 2, belowZero: 0, vouchedLast30Days: 20000 });
const WAITING = { entryId: '7'.repeat(32), level: 100000, vouchAmount: 2500, madeBy: key('a'), madeByCallsign: 'Sally', madeAt: '2026-11-09T10:00:00Z', expiresAt: '2026-12-09T10:00:00Z' };
const BLOCK = {
    vouchers: [OWNER_ROW, row(key('b'), 'Wren', { source: 'role', left: 150000, held: 0, level: 150000, vouched: 0, peopleVouched: 0, belowZero: 0 }), row(key('d'), 'jane')],
    waiting: [WAITING],
    // Whom "+ Make someone a voucher" offers (invites-vouching I5): an admin with no budget, and a name confirmed on the list.
    candidates: { admins: [{ memberPubkey: key('9'), callsign: 'Kit' }], confirmed: [{ memberPubkey: key('8'), callsign: 'liz', entryId: '6'.repeat(32) }], adminsOffered: true },
    settings: { voucherBudget: 100000, memberGift: 10000, presets: [2500, 5000, 7500, 10000], vouchMax: 10000, vouchesPerPerson: 3, budgetMax: 200000 },
};
const COMMITTEE_ONLY = 'Only an owner or an admin on the credit committee makes vouchers and sets their budgets.';
const ADMINS_ONLY = 'Only the community’s owners and admins can open the names list.';

/** The fake node: the vouchers routes as the server answers them, by who signed; the member's own invites, none. */
function fakeNode() {
    return vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
        const u = String(url);
        net.calls.push(`fetch ${u}`);
        const signer = init?.headers?.['X-Signer'];
        const who = Object.values(PEOPLE).find((p) => p.publicKey === signer);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
        if (u.startsWith(`${NODE}/api/invite/mine/`)) return json(200, { invites: [] });
        if (u === `${NODE}/api/names/vouchers` || u.startsWith(`${NODE}/api/names/vouchers/`)) {
            if (!who || (who.role !== 'owner' && who.role !== 'admin')) return json(403, { code: 'admins_only', error: ADMINS_ONLY });
            if (u === `${NODE}/api/names/vouchers`) {
                return who.committee ? json(200, BLOCK) : json(403, { code: 'committee_only', error: COMMITTEE_ONLY });
            }
            const pk = decodeURIComponent(u.slice(`${NODE}/api/names/vouchers/`.length));
            const v = BLOCK.vouchers.find((r) => r.memberPubkey === pk);
            return v ? json(200, { ...v, history: [], people: [], canChange: who.committee }) : json(404, { code: 'not_voucher', error: 'Not a voucher.' });
        }
        return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    nav.pushed.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    // A local community that takes invites from members (its profile on the phone, as People reads it).
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { invites: true, showcase: false }, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = fakeNode();
    (globalThis as any).XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} };
    (globalThis as any).WebSocket = class {};
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderAs(who: Who) {
    const p = PEOPLE[who];
    me.identity = { publicKey: p.publicKey, privateKey: key('f'), callsign: p.callsign };
    await act(async () => { root.render(createElement(PeopleScreen) as any); });
    await settle();
}
const block = () => host.querySelector('[data-testid="vouchers-block"]');
const askedForBlock = () => net.calls.includes(`fetch ${NODE}/api/names/vouchers`);
const inviteHeading = () => Array.from(host.querySelectorAll('span')).find((s) => (s.textContent ?? '').includes('Invite Someone')) ?? null;

describe('People → Invites: the Vouchers block, exactly as the node answers (§11)', () => {
    for (const who of ['owner', 'committeeAdmin'] as const) {
        it(`${who}: the block, above Invite someone, one row per voucher in the node's order, and + Make someone a voucher`, async () => {
            await renderAs(who);
            expect(askedForBlock()).toBe(true);
            const b = block();
            expect(b).not.toBeNull();
            const rows = Array.from(b!.querySelectorAll('[data-testid="voucher-row"]')).map((r) => r.textContent);
            expect(rows).toEqual([voucherRowText(BLOCK.vouchers[1]), voucherRowText(BLOCK.vouchers[2])]);
            expect(rows).toEqual(['@Wren · 1,500 left ›', '@jane · 550 left ›']);
            expect(b!.textContent).toContain('+ Make someone a voucher');
            // Above the invite form (§11: "at the TOP of that screen, above Invite someone").
            const heading = inviteHeading();
            expect(heading).not.toBeNull();
            expect(b!.compareDocumentPosition(heading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            // The last row opens the sheet of whom the node offers (I5; it opened the names list before Marty's 10 Nov rule),
            // in a full-screen modal kept inside the safe area, with the community's default budget to start from.
            const make = Array.from(b!.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === '+ Make someone a voucher');
            await act(async () => { (make as HTMLElement).click(); });
            await settle();
            expect(nav.pushed).toEqual([]);
            const safe = host.querySelector('[data-modal] [data-testid="make-voucher-modal"]');
            expect(safe, 'the sheet sits in a SafeAreaView').not.toBeNull();
            expect(safe!.getAttribute('data-safe-area')!.split(',')).toEqual(expect.arrayContaining(['top', 'bottom']));
            expect(Array.from(safe!.querySelectorAll('[data-testid="make-voucher-admin-row"]')).map((r) => r.textContent)).toEqual(['@Kit']);
            expect(Array.from(safe!.querySelectorAll('[data-testid="make-voucher-confirmed-row"]')).map((r) => r.textContent)).toEqual(['@liz']);
            await act(async () => { (safe!.querySelector('[data-testid="make-voucher-admin-row"]') as HTMLElement).click(); });
            expect(safe!.querySelector('[data-testid="make-voucher-budget"]')?.textContent).toContain('Budget: 1,000 Beans');
        });
    }

    for (const who of ['plainAdmin', 'voucher', 'member'] as const) {
        it(`a plain admin, a voucher and a member: no block (${who}: the node refused it)`, async () => {
            await renderAs(who);
            expect(askedForBlock()).toBe(true);
            // The screen itself rendered: its invite form is there, the block is not.
            expect(inviteHeading()).not.toBeNull();
            expect(block()).toBeNull();
            expect(host.textContent).not.toContain('+ Make someone a voucher');
            expect(host.textContent).not.toContain('550 of 650 left');
        });
    }

    it('a row opens that voucher’s card in a full-screen modal kept inside the safe area (top edge included)', async () => {
        await renderAs('owner');
        const jane = Array.from(host.querySelectorAll('[data-testid="voucher-row"]')).find((r) => (r.textContent ?? '').startsWith('@jane'));
        expect(jane).toBeTruthy();
        await act(async () => { (jane as HTMLElement).click(); });
        await settle();
        const modal = host.querySelector('[data-modal]');
        expect(modal).not.toBeNull();
        const safe = modal!.querySelector('[data-testid="voucher-card-modal"]');
        expect(safe, 'the card sits in a SafeAreaView').not.toBeNull();
        expect(safe!.getAttribute('data-safe-area')!.split(',')).toEqual(expect.arrayContaining(['top', 'bottom']));
        // The card, from the node's card answer: Set budget to starts at a level the node takes (700, not 650).
        expect(safe!.textContent).toContain('Their budget');
        expect(safe!.textContent).toContain('Set budget to: 700');
        expect(net.calls).toContain(`fetch ${NODE}/api/names/vouchers/${key('d')}`);
    });
});

describe('People → Invites: the Vouchers block reshaped (invites-vouching I4)', () => {
    const texts = (sel: string) => Array.from(host.querySelectorAll(sel)).map((r) => r.textContent);

    it('owners are pinned first under one line "Owners · no limit", each row "@Sally · 2 vouched ›" with no budget words', async () => {
        await renderAs('owner');
        const b = block()!;
        expect(b).not.toBeNull();
        expect(texts('[data-testid="vouchers-owners-line"]')).toEqual(['Owners · no limit']);
        expect(texts('[data-testid="voucher-owner-row"]')).toEqual(['@Sally · 2 vouched ›']);
        expect(texts('[data-testid="voucher-owner-row"]')[0]).not.toMatch(/left|budget|of \d|below zero|limit/i);
        // Pinned: the owners' line and row come before every other voucher's row.
        const ownerRow = b.querySelector('[data-testid="voucher-owner-row"]')!;
        const firstOther = b.querySelector('[data-testid="voucher-row"]')!;
        expect(ownerRow.compareDocumentPosition(firstOther) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The other rows say who and what is left, and nothing else.
        expect(texts('[data-testid="voucher-row"]')).toEqual(['@Wren · 1,500 left ›', '@jane · 550 left ›']);
    });

    it('Waiting to join lists the promised budget from the node’s `waiting`, below the vouchers, the name on the phone until the list is open', async () => {
        await renderAs('owner');
        const b = block()!;
        expect(texts('[data-testid="vouchers-waiting-heading"]')).toEqual(['Waiting to join']);
        expect(texts('[data-testid="voucher-waiting-row"]')).toEqual(['Name on the phone · waiting to join · budget 1,000 ›']);
        const lastVoucher = Array.from(b.querySelectorAll('[data-testid="voucher-row"]')).pop()!;
        const waiting = b.querySelector('[data-testid="voucher-waiting-row"]')!;
        expect(lastVoucher.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // Nothing in the block is a balance, a code or a bare entry id.
        expect(b.textContent).not.toMatch(/balance/i);
        expect(b.textContent).not.toContain('7'.repeat(32));
        // A waiting row opens the names list, where the entry's own line is.
        await act(async () => { (waiting as HTMLElement).click(); });
        expect(nav.pushed).toEqual(['/names-list']);
    });

    it('without a waiting invite, there is no Waiting to join section', async () => {
        const noWaiting = { ...BLOCK, waiting: [] };
        const node = fakeNode();
        globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
            if (String(url) === `${NODE}/api/names/vouchers`) return new Response(JSON.stringify(noWaiting), { status: 200 });
            return (node as any)(url, init);
        }) as unknown as typeof fetch;
        await renderAs('owner');
        expect(block()).not.toBeNull();
        expect(host.querySelector('[data-testid="vouchers-waiting-heading"]')).toBeNull();
        expect(host.querySelector('[data-testid="voucher-waiting-row"]')).toBeNull();
    });

    it('a node from before I4 (no `waiting`, no owner flag) still draws: every voucher a "left" row, nothing waiting', async () => {
        const old = { vouchers: BLOCK.vouchers.slice(1).map(({ ...r }) => r), settings: BLOCK.settings };
        const node = fakeNode();
        globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
            if (String(url) === `${NODE}/api/names/vouchers`) return new Response(JSON.stringify(old), { status: 200 });
            return (node as any)(url, init);
        }) as unknown as typeof fetch;
        await renderAs('owner');
        expect(texts('[data-testid="voucher-row"]')).toEqual(['@Wren · 1,500 left ›', '@jane · 550 left ›']);
        expect(host.querySelector('[data-testid="vouchers-owners-line"]')).toBeNull();
        expect(host.querySelector('[data-testid="vouchers-waiting-heading"]')).toBeNull();
    });
});
