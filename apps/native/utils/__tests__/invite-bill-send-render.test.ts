// @vitest-environment jsdom
/**
 * A bill with an invite on the phone, the whole class at once (PR #3206 round 2; DESIGN-getting-paid-fable.md §4.5, slice B3):
 * app/(tabs)/people.tsx rendered for real (the mount of people-invites-no-vouch-render.test.ts) on a community that takes
 * bills, against a fake node that answers as the server does (engine/bills.ts checkInviteBill: the same id for the same bill on
 * an unused invite answers that invite; the same id for another bill is 409 `bill_id_reused`).
 *
 * Two rules, one table over (fold open / closed) x (bill: none / complete / half-typed) x (answer: ok / lost then retry the
 * same / lost then edit then retry / 409), saying what each tap sends, the id it uses and the words shown:
 *   1. An invite carries a bill only when the fold is open and the member can see the bill: closed, no bill goes and no bill
 *      refusal is shown for words they can't see.
 *   2. The bill's id belongs to one exact bill: the same bill again is the same id (so a retry after a lost answer gets back
 *      the invite already made), an edit is a new id, and a lost answer is never "Nothing was made".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as Array<[string, string | undefined]> }));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'radio') attrs.role = 'radio';
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
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
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'),
        TextInput: (p: Record<string, any>) => createElement('input', {
            'data-testid': p.testID, placeholder: p.placeholder, value: p.value ?? '', onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value),
        }),
        TouchableOpacity: el('button'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert: (title: string, text?: string) => { alerts.said.push([title, text]); } },
        Share: { share: async () => ({}) },
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
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'a-member-key', callsign: 'Robin', privateKey: 'aa' } }) }));

const tickets = vi.hoisted(() => ({ made: 0 }));
const never = () => new Promise<never>(() => {});
vi.mock('../db', () => ({
    getDb: () => new Promise<never>(() => {}), getFriendsLocal: async () => [], addFriendLocal: () => new Promise<never>(() => {}),
    removeFriendLocal: () => new Promise<never>(() => {}), createConversationApi: () => new Promise<never>(() => {}),
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../member-statements', () => ({ makeOfflineTicket: async () => { tickets.made++; return 'BP-TICKET'; } }));
vi.mock('../membership-probe', () => ({ fetchMembership: () => new Promise<never>(() => {}) }));
vi.mock('../node-admin', () => ({
    askNodeRole: () => new Promise<never>(() => {}), persistNodeRole: async () => {}, readPersistedNodeRole: async () => undefined, rememberNodeRole: async () => {},
}));
vi.mock('../knock-inbox', () => ({ fetchJoinRequests: () => new Promise<never>(() => {}) }));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: () => new Promise<never>(() => {}), joinedNudge: () => '', PROTECT_REDIRECT: '', HOME_REDIRECT: '' }));
vi.mock('../community-switch', () => ({ communitySwitched: () => () => {} }));
vi.mock('../global-join-existing', () => ({ isGlobalCommunity: () => false }));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'checking' }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise<never>(() => {}), signedPost: () => new Promise<never>(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../../components/WantsToJoin', () => ({ WantsToJoin: () => null }));
vi.mock('../../components/MyJoinRequests', () => ({ MyJoinRequests: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../people-visit', () => ({ usePeopleVisitEnds: () => 0 }));
import PeopleScreen from '../../app/(tabs)/people';
import { billLines, inviteBillLines, t } from '@beanpool/core';

const NODE = 'https://node.example';
const FEATURES = { beans: true, invites: true, showcase: false, bills: true };

/**
 * The fake node, as the server answers (engine/invites.ts generateInvite, engine/bills.ts checkInviteBill): each tap takes the
 * next answer. `lost` makes the invite and then the answer never arrives; `conflict` is the node saying the id is spent (409).
 */
type Answer = 'ok' | 'lost' | 'conflict';
const node = {
    bodies: [] as Array<Record<string, any>>,
    answers: [] as Answer[],
    made: 0,
    bills: new Map<string, { key: string; invite: Record<string, unknown> }>(),
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const spent = () => json({ error: billLines.idReused(), code: 'bill_id_reused' }, 409);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: FEATURES, checkedAt: new Date().toISOString() } }));
    tickets.made = 0;
    alerts.said.length = 0;
    node.bodies = [];
    node.answers = [];
    node.made = 0;
    node.bills.clear();
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/api/invite/generate')) {
            const body = JSON.parse(String(init?.body));
            node.bodies.push(body);
            const answer = node.answers.shift() ?? 'ok';
            if (answer === 'conflict' && body.bill) return spent();
            const make = () => ({
                code: `INV-TEST-000${++node.made}`, createdBy: body.publicKey, createdAt: new Date().toISOString(), usedBy: null, usedAt: null,
                intendedFor: body.intendedFor, ...(body.bill ? { bill: body.bill } : {}),
            });
            let invite: Record<string, unknown>;
            if (body.bill) {
                const key = `${body.bill.amount_c} ${body.bill.whatFor}`;
                const prior = node.bills.get(body.bill.id);
                if (prior && prior.key !== key) return spent();
                invite = prior ? prior.invite : make();
                if (!prior) node.bills.set(body.bill.id, { key, invite });
            } else {
                invite = make();
            }
            if (answer === 'lost') throw new TypeError('Network request failed');
            return json({ success: true, invite });
        }
        if (u.endsWith('/api/community/health')) return json({ ok: true });
        if (u.includes('/api/invite/mine/')) return json({ invites: [] });
        return never();
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const press = async (id: string) => { const el = q(id); expect(el, id).toBeTruthy(); await act(async () => { el!.click(); }); await settle(); };
const typeInto = async (input: HTMLInputElement | null, text: string, what: string) => {
    expect(input, what).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
};
const type = (id: string, text: string) => typeInto(q(id) as HTMLInputElement | null, text, id);
const open = async () => { await act(async () => { root.render(createElement(PeopleScreen) as any); }); await settle(); };
const generate = async () => {
    // Once an invite is made the form folds; a next one is a deliberate tap on "Make another invite".
    if (q('invite-make-another')) await press('invite-make-another');
    const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Generate'));
    expect(button, 'the Generate button').toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
};

type Fold = 'open' | 'closed';
type Bill = 'none' | 'complete' | 'half';
type Script = 'ok' | 'lost-then-same' | 'lost-then-edit' | 'conflict';
const SCRIPTS: Record<Script, Answer[]> = { ok: ['ok'], 'lost-then-same': ['lost', 'ok'], 'lost-then-edit': ['lost', 'ok'], conflict: ['conflict', 'ok'] };

/** What a row expects: each tap's bill id as a letter (null: no bill went), amounts, the alerts in order, tickets, the card. */
interface Expect { ids: Array<string | null>; amounts?: number[]; alerts: Array<[string, string]>; tickets: number; carries?: string }

const lost: [string, string] = [t('No answer'), inviteBillLines.answerLost()];
const half: [string, string] = [t('Could not add the bill'), billLines.badWhatFor()];
const NO_BILL: Record<Script, Expect> = {
    ok: { ids: [null], alerts: [], tickets: 0 },
    // No bill went: a dropped answer makes the offline ticket, as it always did, and never says a word about a bill.
    'lost-then-same': { ids: [null, null], alerts: [[t('Offline Mode'), t('You are currently offline. A temporary cryptographic offline invite ticket (valid for 30 days) will be generated instead.')]], tickets: 1 },
    'lost-then-edit': { ids: [null, null], alerts: [[t('Offline Mode'), t('You are currently offline. A temporary cryptographic offline invite ticket (valid for 30 days) will be generated instead.')]], tickets: 1 },
    conflict: { ids: [null, null], alerts: [], tickets: 0 },
};
const TABLE: Array<[Fold, Bill, Script, Expect]> = [];
for (const bill of ['none', 'complete', 'half'] as Bill[]) for (const script of Object.keys(SCRIPTS) as Script[]) TABLE.push(['closed', bill, script, NO_BILL[script]]);
for (const script of Object.keys(SCRIPTS) as Script[]) TABLE.push(['open', 'none', script, NO_BILL[script]]);
// Half-typed in an open fold: the fold's own refusal at every tap, and nothing goes.
TABLE.push(['open', 'half', 'ok', { ids: [], alerts: [half], tickets: 0 }]);
TABLE.push(['open', 'half', 'lost-then-same', { ids: [], alerts: [half, half], tickets: 0 }]);
TABLE.push(['open', 'half', 'lost-then-edit', { ids: [], alerts: [half, half], tickets: 0 }]);
TABLE.push(['open', 'half', 'conflict', { ids: [], alerts: [half, half], tickets: 0 }]);
// A whole bill in an open fold.
TABLE.push(['open', 'complete', 'ok', { ids: ['A'], amounts: [1200], alerts: [], tickets: 0, carries: 'bill 12 Beans' }]);
// The same bill again after a lost answer: the same id, and the node's answer is the invite it made the first time.
TABLE.push(['open', 'complete', 'lost-then-same', { ids: ['A', 'A'], amounts: [1200, 1200], alerts: [lost], tickets: 0, carries: 'bill 12 Beans' }]);
// Edited after a lost answer: a new bill, a new id, never 409.
TABLE.push(['open', 'complete', 'lost-then-edit', { ids: ['A', 'B'], amounts: [1200, 1500], alerts: [lost], tickets: 0, carries: 'bill 15 Beans' }]);
// The node says the id is spent: its words; the next tap goes with a new id and is not refused again.
TABLE.push(['open', 'complete', 'conflict', { ids: ['A', 'B'], amounts: [1200, 1200], alerts: [[t('Could not add the bill'), billLines.idReused()]], tickets: 0, carries: 'bill 12 Beans' }]);

describe('People › Invites: a bill goes only from an open fold, with an id that belongs to one exact bill (the whole table)', () => {
    it('the table covers every (fold, bill, answer) once', () => {
        expect(TABLE).toHaveLength(2 * 3 * 4);
        expect(new Set(TABLE.map(([f, b, s]) => `${f}/${b}/${s}`)).size).toBe(24);
    });

    it.each(TABLE)('fold %s, bill %s, answer %s', async (fold, bill, script, want) => {
        await open();
        if (fold === 'open' || bill !== 'none') {
            await press('invite-bill-toggle');
            if (bill === 'complete') { await type('invite-bill-what-for', 'Bread'); await type('invite-bill-beans', '12'); }
            if (bill === 'half') await type('invite-bill-beans', '5');
            // Closed again: the boxes still hold what was typed, out of sight.
            if (fold === 'closed') await press('invite-bill-toggle');
        }
        expect(!!q('invite-bill-what-for')).toBe(fold === 'open');
        node.answers = [...SCRIPTS[script]];
        await generate();
        if (SCRIPTS[script].length > 1) {
            if (script === 'lost-then-edit' && fold === 'open' && bill !== 'none') await type('invite-bill-beans', '15');
            await generate();
        }

        const letters = new Map<string, string>();
        const ids = node.bodies.map((b) => {
            if (!('bill' in b)) return null;
            if (!letters.has(b.bill.id)) letters.set(b.bill.id, String.fromCharCode(65 + letters.size));
            return letters.get(b.bill.id)!;
        });
        expect(ids, 'the bill id each tap sent').toEqual(want.ids);
        if (want.amounts) expect(node.bodies.map((b) => b.bill?.amount_c)).toEqual(want.amounts);
        expect(alerts.said, 'the words shown').toEqual(want.alerts);
        for (const [, words] of alerts.said) expect(words ?? '').not.toMatch(/Nothing was made/);
        expect(tickets.made, 'offline tickets').toBe(want.tickets);
        if (want.carries) expect(q('invite-made-carries')?.textContent).toBe(want.carries);
        if (want.ids.length > 0 && !want.ids.some((id) => id !== null)) expect(host.textContent).not.toContain('bill 12 Beans');
    });
});

describe('a retry of the same bill shows the invite the node already made, not what the panel holds now', () => {
    it('lost answer, the note changed, the same bill again: the card is the first invite, with its note', async () => {
        await open();
        const note = () => host.querySelector(`input[placeholder="${t("A note for you, kept on your community's server")}"]`) as HTMLInputElement | null;
        await typeInto(note(), 'Kim from the market', 'the note box');
        await press('invite-bill-toggle');
        await type('invite-bill-what-for', 'Bread');
        await type('invite-bill-beans', '12');
        node.answers = ['lost', 'ok'];
        await generate();
        await typeInto(note(), 'Someone else', 'the note box');
        await generate();
        expect(node.made).toBe(1);
        expect(node.bodies.map((b) => b.bill.id)).toEqual([node.bodies[0].bill.id, node.bodies[0].bill.id]);
        expect(q('invite-made-card')?.textContent).toContain('Kim from the market');
        expect(q('invite-made-card')?.textContent).not.toContain('Someone else');
    });
});
