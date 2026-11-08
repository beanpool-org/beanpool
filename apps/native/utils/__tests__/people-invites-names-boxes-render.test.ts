// @vitest-environment jsdom
/**
 * People → Invites for owners and admins (DESIGN-invites-and-names-list-amend3-fable.md §1–§2, slice A2; Marty, 8 Nov: Q1 allow
 * both, Q2 phone first): the two boxes are absent for a member; the voucher box is greyed for an admin off the credit committee,
 * without a connection, or until the names box is ticked; the presets stay with the names box ticked; the bound invite's body
 * carries a level only with an entry and a vouch only when picked; a ticket never carries a level; the duplicate warning; the
 * entry written but the invite refused; and the entry's id, kept only for the same person tried again unchanged (#2974 round 2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as Array<[string, string | undefined, string[]]> }));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'radio' || accessibilityRole === 'checkbox') attrs.role = accessibilityRole;
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (disabled || accessibilityState?.disabled) attrs.disabled = true;
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
        Alert: { alert: (title: string, text?: string, buttons?: Array<{ text: string }>) => { alerts.said.push([title, text, (buttons ?? []).map((b) => b.text)]); } },
        Share: { share: async () => ({}) },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
// Focus as the navigator gives it: `nav.blur()` leaves the tab (each focus effect's clean-up runs), `nav.focus()` comes back.
const nav = vi.hoisted(() => {
    const listeners = new Set<(on: boolean) => void>();
    const say = (on: boolean) => { nav.on = on; for (const l of listeners) l(on); };
    const nav = { on: true, listeners, blur: () => say(false), focus: () => say(true) };
    return nav;
});
const pushed = vi.hoisted(() => [] as string[]);
vi.mock('expo-router', async () => {
    const { useEffect, useState } = await import('react');
    return {
        router: { push: (to: string) => { pushed.push(to); }, navigate() {}, setParams() {}, replace() {} },
        useFocusEffect: (cb: () => void | (() => void)) => {
            const [on, setOn] = useState(nav.on);
            useEffect(() => { nav.listeners.add(setOn); return () => { nav.listeners.delete(setOn); }; }, []);
            useEffect(() => (on ? cb() : undefined), [cb, on]);
        },
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
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
}));
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
const IDENTITY = { publicKey: 'a-member-key', callsign: 'Robin', privateKey: 'aa' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: IDENTITY }) }));

const tickets = vi.hoisted(() => ({ made: 0, args: [] as unknown[][] }));
const never = () => new Promise<never>(() => {});
vi.mock('../db', () => ({
    getDb: () => new Promise<never>(() => {}), getFriendsLocal: async () => [], addFriendLocal: () => new Promise<never>(() => {}),
    removeFriendLocal: () => new Promise<never>(() => {}), createConversationApi: () => new Promise<never>(() => {}),
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../member-statements', () => ({ makeOfflineTicket: async (...args: unknown[]) => { tickets.made++; tickets.args.push(args); return 'BP-TICKET'; } }));
vi.mock('../membership-probe', () => ({ fetchMembership: () => new Promise<never>(() => {}) }));
const node = vi.hoisted(() => ({
    role: null as 'owner' | 'admin' | 'moderator' | null,
    committee: false,
    voucher: true,
    budgetLeft: 550,
    budgetLevel: 1000,
    voucherBudget: 1000,
    online: true,
    inviteDown: false,
    inviteRefusal: null as string | null,
    vouchersDown: false,
    generated: [] as Array<Record<string, unknown>>,
    bound: [] as Array<{ entryId: string; body: Record<string, unknown> }>,
}));
// The member's role, as the node answers GET /api/node-admin/me.
vi.mock('../node-admin', () => ({
    askNodeRole: async () => ({ role: node.role, communityName: null }), persistNodeRole: async () => {}, readPersistedNodeRole: async () => undefined, rememberNodeRole: () => {},
}));
// The names list's own flows: the open (and its entries, as this phone opens them) and the sealed add are faked here; the
// bound invite is core's real inviteForNamesEntry, so the body it sends is the one on the wire. The fake add answers as the
// node does (engine/names-list.ts): an add whose id is on the list already is `entry_exists`, judged by the id alone, the
// entry keeps the text it was first written with, and core counts that as landed (names-list-flows.ts). An open is a
// snapshot of the list as it stood then.
const list = vi.hoisted(() => ({
    saved: [] as Array<{ name: string; note: string; addId?: string }>,
    onNode: [] as Array<{ id: string; name: string }>,
    opens: 0,
    refuse: null as string | null,
    refuseStatus: 0,
    /** What each open says, in turn (core's `notices`, said once); an open past the end says nothing. */
    said: [] as string[][],
    /** A plan that isn't ready (the open answered, the list not read): `list: null`, as core gives it. */
    plan: null as Record<string, unknown> | null,
}));
vi.mock('../names-list', async (importOriginal) => {
    const real = await importOriginal<typeof import('../names-list')>();
    const row = (id: string, by: string) => ({ id, ciphertext: 'x', keyId: 'k1', createdBy: by, createdAt: '', updatedBy: by, updatedAt: '' });
    const names = (): Record<string, string> => ({ 'entry-jane': 'Jane Albury', ...Object.fromEntries(list.onNode.map((e) => [e.id, e.name])) });
    return {
        ...real,
        openNamesList: async () => {
            list.opens++;
            if (list.refuse) return { ok: false, status: list.refuseStatus, code: null, message: list.refuse };
            const notices = list.said.shift() ?? [];
            const state = { admins: [{ pubkey: 'damo-key', callsign: 'damo' }], callsigns: {} };
            if (list.plan) return { ok: true, value: { state, plan: list.plan, pin: {}, ring: {}, generations: new Map(), list: null, notices, made: null, sentTo: [] } };
            return {
                ok: true,
                value: {
                    state, plan: { kind: 'ready' }, pin: {}, ring: {}, generations: new Map(),
                    list: { entries: [row('entry-jane', 'damo-key'), ...list.onNode.map((e) => row(e.id, 'a-member-key'))], confirmations: [] },
                    notices, made: null, sentTo: [],
                },
            };
        },
        openEntries: (l: { entries: Array<{ id: string }> }) => l.entries.map((e) => ({
            id: e.id, keyId: 'k1', createdAt: '', updatedAt: '', text: { name: names()[e.id], note: '' }, locked: null, key: null,
            holders: [], notTrusting: [], checkedHere: [], confirmation: null, voucher: null,
        })),
        saveNamesEntry: async (_a: string, _i: unknown, _s: unknown, _o: unknown, text: { name: string; note: string }, _entryId?: string, addId?: string) => {
            list.saved.push({ ...text, addId });
            const id = addId ?? `no-id-${list.saved.length}`;
            if (!list.onNode.some((e) => e.id === id)) list.onNode.push({ id, name: text.name });
            return { ok: true, value: { id, keyId: 'k1', ciphertext: 'sealed', opened: null } };
        },
    };
});
vi.mock('../knock-inbox', () => ({ fetchJoinRequests: () => new Promise<never>(() => {}) }));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: () => new Promise<never>(() => {}), joinedNudge: () => '', PROTECT_REDIRECT: '', HOME_REDIRECT: '' }));
vi.mock('../community-switch', () => ({ communitySwitched: () => () => {} }));
vi.mock('../global-join-existing', () => ({ isGlobalCommunity: () => false }));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'checking' }));
vi.mock('../node-post', () => ({
    // GET /api/vouchers/me: the inviter is a voucher with budget left, so the presets show (as people-invites-vouch.test.ts).
    signedGet: vi.fn(async (_anchor: string, path: string) => (path === '/api/vouchers/me'
        ? {
            ok: true,
            json: async () => ({
                voucher: node.voucher,
                budget: { left: node.budgetLeft, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: node.budgetLevel },
                presets: [25, 50, 75, 100], vouchMax: 100, budgetMax: 2000, vouchedBy: [],
            }),
        }
        : { ok: false, json: async () => null })),
    signedPost: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../../components/WantsToJoin', () => ({ WantsToJoin: () => null }));
vi.mock('../../components/MyJoinRequests', () => ({ MyJoinRequests: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));

import PeopleScreen from '../../app/(tabs)/people';
import { t } from '@beanpool/core';
import { NAMES_COPY } from '../names-list';
import { keyLineWords } from '../../components/key-lines';

const NODE = 'https://node.example';
const LOCAL = { beans: true, invites: true, showcase: false };
const COMMITTEE_ONLY = 'Only an owner or an admin on the credit committee makes vouchers and sets their budgets.';
const rememberProfile = (features: Record<string, boolean>) =>
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features, checkedAt: new Date().toISOString() } }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    rememberProfile(LOCAL);
    tickets.made = 0;
    tickets.args.length = 0;
    alerts.said.length = 0;
    list.saved.length = 0;
    list.onNode.length = 0;
    list.opens = 0;
    list.refuse = null;
    list.refuseStatus = 0;
    list.said = [];
    list.plan = null;
    pushed.length = 0;
    nav.on = true;
    Object.assign(node, {
        role: null, committee: false, voucher: true, budgetLeft: 550, budgetLevel: 1000, voucherBudget: 1000, online: true, inviteDown: false, inviteRefusal: null,
        vouchersDown: false, generated: [], bound: [],
    });

    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/api/vouchers/me')) {
            return json({
                voucher: node.voucher,
                budget: { left: node.budgetLeft, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: node.budgetLevel },
                presets: [25, 50, 75, 100], vouchMax: 100, budgetMax: 2000, vouchedBy: [],
            });
        }
        // GET /api/names/vouchers answers owners and committee admins only (routes/names-list.ts).
        if (u === `${NODE}/api/names/vouchers`) {
            if (!node.online) throw new TypeError('Network request failed');
            if (node.vouchersDown) return json({ error: 'Something went wrong.' }, 500);
            return node.committee
                ? json({ vouchers: [], settings: { voucherBudget: node.voucherBudget, voucherMaxVouch: 100 } })
                : json({ code: 'committee_only', error: COMMITTEE_ONLY }, 403);
        }
        const bind = u.match(/\/api\/names\/entries\/([^/]+)\/invite$/);
        if (bind) {
            if (node.inviteDown) throw new TypeError('Network request failed');
            if (node.inviteRefusal) return json({ code: 'not_enough', error: node.inviteRefusal }, 409);
            node.bound.push({ entryId: decodeURIComponent(bind[1]), body: JSON.parse(String(init?.body)) });
            return json({ success: true, invite: { code: `INV-NAMES-000${node.bound.length}` } }, 201);
        }
        if (u.endsWith('/api/invite/generate')) {
            node.generated.push(JSON.parse(String(init?.body)));
            return json({ success: true, invite: { code: `INV-TEST-000${node.generated.length}` } });
        }
        if (u.endsWith('/api/community/health')) {
            if (!node.online) throw new TypeError('Network request failed');
            return json({ ok: true });
        }
        if (u.includes('/api/invite/mine/')) return json({ invites: [] });
        return never();
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const open = async () => { await act(async () => { root.render(createElement(PeopleScreen) as any); }); await settle(); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const press = async (id: string) => { const el = q(id); expect(el, id).toBeTruthy(); await act(async () => { el!.click(); }); await settle(); };
const type = async (id: string, text: string) => {
    const input = q(id) as HTMLInputElement;
    expect(input, id).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
};
const generate = async () => {
    const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Generate'));
    expect(button, 'the Generate button').toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
};
const forInput = () => host.querySelector(`input[placeholder="${t('Who is this invite for? (For your records)')}"]`);

describe('People → Invites: the owners’ and admins’ names-list boxes (amend3 §1, slice A2)', () => {
    it('a member sees today’s form only: no boxes', async () => {
        node.role = null;
        await open();
        expect(q('invite-vouch'), 'the presets, as today').toBeTruthy();
        expect(forInput(), 'the "for" line, as today').toBeTruthy();
        expect(q('invite-names')).toBeNull();
        expect(q('invite-names-box')).toBeNull();
        expect(q('invite-voucher-box')).toBeNull();
    });

    it('a moderator sees no boxes either', async () => {
        node.role = 'moderator';
        await open();
        expect(q('invite-names')).toBeNull();
    });

    it('an admin not on the credit committee: the names box, and the voucher box greyed with the committee sentence', async () => {
        node.role = 'admin';
        node.committee = false;
        await open();
        expect(q('invite-names-box')?.getAttribute('aria-checked')).toBe('false');
        expect(q('invite-voucher-box')?.hasAttribute('disabled')).toBe(true);
        expect(q('invite-voucher-why')?.textContent).toBe(t(COMMITTEE_ONLY));
        await press('invite-names-box');
        expect(q('invite-voucher-box')?.hasAttribute('disabled'), 'still greyed with the names box ticked').toBe(true);
        expect(q('invite-voucher-why')?.textContent).toBe(t(COMMITTEE_ONLY));
        await press('invite-voucher-box');
        expect(q('invite-voucher-level'), 'a greyed box opens no stepper').toBeNull();
    });

    it('the committee: the voucher box waits for the names box; the presets stay with it ticked (Q1); the body carries both', async () => {
        node.role = 'owner';
        node.committee = true;
        await open();
        expect(q('invite-voucher-box')?.hasAttribute('disabled'), 'greyed until the names box is ticked').toBe(true);
        expect(q('invite-voucher-why')?.textContent).toMatch(/names list/);
        await press('invite-names-box');
        expect(list.opens, 'the list opened on this phone').toBe(1);
        expect(q('invite-vouch'), 'Q1: the presets stay visible with the names box ticked').toBeTruthy();
        expect(q('invite-vouch-50')).toBeTruthy();
        expect(forInput(), 'the plain "for" line goes: the real name is sealed instead').toBeNull();
        expect(q('invite-voucher-box')?.hasAttribute('disabled')).toBe(false);
        await press('invite-voucher-box');
        expect(q('invite-voucher-amount')?.textContent, 'prefilled with the community default').toMatch(/1,?000/);
        await press('invite-voucher-up');
        expect(q('invite-voucher-amount')?.textContent).toMatch(/1,?100/);
        await type('invite-names-name', 'Rowan Penhallow');
        await press('invite-vouch-50');
        await generate();

        expect(list.saved).toHaveLength(1);
        expect(list.saved[0].name).toBe('Rowan Penhallow');
        expect(list.saved[0].addId, 'the entry’s id, chosen on this phone').toMatch(/\S/);
        expect(node.bound).toEqual([{ entryId: list.saved[0].addId, body: { vouchAmount: 50, voucherLevel: 1100 } }]);
        expect(node.generated, 'no plain invite, and the name never went to the node').toEqual([]);
        expect(tickets.made).toBe(0);
        expect(alerts.said).toEqual([]);
        expect(JSON.stringify([...store.map.values()]), 'nor into the phone’s plain storage').not.toContain('Rowan');
        // Made: the boxes start again.
        expect(q('invite-names-box')?.getAttribute('aria-checked')).toBe('false');
    });

    it('the names box alone: the level is not sent, nor a vouch nobody picked', async () => {
        node.role = 'admin';
        node.committee = true;
        await open();
        await press('invite-names-box');
        await type('invite-names-name', 'Ida Quiller');
        await generate();
        expect(node.bound).toEqual([{ entryId: list.saved[0].addId, body: {} }]);
    });

    it('a plain invite (names box not ticked) never carries a level', async () => {
        node.role = 'owner';
        node.committee = true;
        await open();
        await press('invite-vouch-25');
        await generate();
        expect(node.generated).toEqual([{ publicKey: 'a-member-key', vouchAmount: 25 }]);
        expect(node.bound).toEqual([]);
    });

    it('no connection: the voucher box greyed, "Needs a connection…", never the committee sentence', async () => {
        node.role = 'owner';
        node.committee = true;
        node.online = false;
        await open();
        await press('invite-names-box');
        expect(q('invite-voucher-box')?.hasAttribute('disabled')).toBe(true);
        expect(q('invite-voucher-why')?.textContent).toBe(t('Needs a connection. You can make them a voucher from the list once they’ve joined.'));
    });

    it('the committee’s answer not heard (the read failed): greyed, and no sentence that would be untrue', async () => {
        node.role = 'owner';
        node.committee = true;
        node.vouchersDown = true;
        await open();
        await press('invite-names-box');
        expect(q('invite-voucher-box')?.hasAttribute('disabled')).toBe(true);
        expect(q('invite-voucher-why')).toBeNull();
        expect(host.textContent).not.toContain(t(COMMITTEE_ONLY));
    });

    it('the connection drops at the invite with a level chosen: no ticket (a ticket never carries a level); the entry stands', async () => {
        node.role = 'owner';
        node.committee = true;
        await open();
        await press('invite-names-box');
        await press('invite-voucher-box');
        await type('invite-names-name', 'Bryony Keast');
        node.inviteDown = true;
        await generate();
        expect(tickets.made).toBe(0);
        expect(list.saved).toHaveLength(1);
        expect(alerts.said[0][0]).toBe(t('Invite not made'));
    });

    it('the connection drops at the invite with nothing chosen: a ticket bound to the entry, carrying no level', async () => {
        node.role = 'owner';
        node.committee = true;
        await open();
        await press('invite-names-box');
        await type('invite-names-name', 'Bryony Keast');
        node.inviteDown = true;
        await generate();
        expect(tickets.made).toBe(1);
        expect(tickets.args[0]).toEqual([NODE, 'a-member-key', 'aa', { namesEntryId: list.saved[0].addId }]);
        expect(JSON.stringify(tickets.args[0])).not.toMatch(/level|vouch/i);
    });

    it('typing a name already on the list warns, and "Invite that entry" binds that entry, adding nothing', async () => {
        node.role = 'admin';
        node.committee = false;
        await open();
        await press('invite-names-box');
        await type('invite-names-name', 'jane  albury');
        expect(q('invite-names-same')?.textContent).toContain(t('{name} is on the list already (added by {by}, not joined yet). Invite that entry instead?', { name: 'Jane Albury', by: '@damo' }));
        await press('invite-names-same-invite');
        expect(list.saved).toEqual([]);
        expect(node.bound).toEqual([{ entryId: 'entry-jane', body: {} }]);
    });

    it('a different name gives no warning', async () => {
        node.role = 'admin';
        await open();
        await press('invite-names-box');
        await type('invite-names-name', 'Jane Alberry');
        expect(q('invite-names-same')).toBeNull();
    });

    it('the entry written but the invite refused: says so, points to the list, and the entry stands', async () => {
        node.role = 'owner';
        node.committee = true;
        node.inviteRefusal = 'You have only 20 left in your vouching budget.';
        await open();
        await press('invite-names-box');
        await type('invite-names-name', 'Tegan Rule');
        await press('invite-vouch-50');
        await generate();
        expect(list.saved).toHaveLength(1);
        expect(tickets.made).toBe(0);
        const [title, text, buttons] = alerts.said[0];
        expect(title).toBe(t('Invite not made'));
        expect(text).toBe(t('The name is on the names list, but the invite wasn’t made: {why} Their entry stays: open the names list and use Invite this person on it.', { why: 'You have only 20 left in your vouching budget.' }));
        expect(buttons).toContain(t('Open the names list'));
    });

    it('a list this phone can’t open says why, and Generate adds nothing', async () => {
        node.role = 'admin';
        list.refuse = 'This phone can’t write to the list right now. Open it again.';
        await open();
        await press('invite-names-box');
        expect(q('invite-names-refused')).toBeTruthy();
        await type('invite-names-name', 'Ned Varcoe');
        await generate();
        expect(list.saved).toEqual([]);
        expect(node.bound).toEqual([]);
        expect(alerts.said[0][0]).toBe(t('Not added to the names list'));
    });

    // #2974 round 2 (deciding review, InviteNamesBoxes.tsx:152): the node checks an add by its id alone, so the id kept after a
    // refused invite must never carry another person's name.
    describe('the entry’s id: kept only for the same person tried again unchanged', () => {
        const REFUSED = 'You have only 20 left in your vouching budget.';
        const tegansEntryRefused = async () => {
            node.role = 'owner';
            node.committee = true;
            node.inviteRefusal = REFUSED;
            await open();
            await press('invite-names-box');
            await type('invite-names-name', 'Tegan Rule');
            await press('invite-vouch-50');
            await generate();
            expect(alerts.said[0]?.[0]).toBe(t('Invite not made'));
            expect(list.onNode).toEqual([{ id: list.saved[0].addId, name: 'Tegan Rule' }]);
            expect(node.bound).toEqual([]);
            alerts.said.length = 0;
            node.inviteRefusal = null;
            return list.saved[0].addId!;
        };

        it('the review’s steps: Tegan’s invite refused, Bob typed, Generate: Bob gets a new entry with his own name; Tegan’s is untouched and not bound', async () => {
            const tegans = await tegansEntryRefused();
            await type('invite-names-name', '');
            await type('invite-names-name', 'Bob Smith');
            await generate();
            expect(list.saved.map((e) => e.name)).toEqual(['Tegan Rule', 'Bob Smith']);
            const bobs = list.saved[1].addId;
            expect(bobs, 'Bob’s entry is a new id, never Tegan’s').not.toBe(tegans);
            expect(list.onNode, 'both names stored, each under its own id').toEqual([{ id: tegans, name: 'Tegan Rule' }, { id: bobs, name: 'Bob Smith' }]);
            expect(node.bound.map((b) => b.entryId), 'Bob’s invite is bound to Bob’s entry, Tegan’s to nothing').toEqual([bobs]);
            expect(alerts.said).toEqual([]);
        });

        it('the same person tried again, unchanged: the same id, so the node’s entry_exists binds Tegan’s one entry, no second one', async () => {
            const tegans = await tegansEntryRefused();
            await generate();
            expect(list.saved.map((e) => e.addId)).toEqual([tegans, tegans]);
            expect(list.onNode).toEqual([{ id: tegans, name: 'Tegan Rule' }]);
            expect(node.bound).toEqual([{ entryId: tegans, body: { vouchAmount: 50 } }]);
            expect(alerts.said).toEqual([]);
        });

        it('the name changed and changed back is still a change: a new id', async () => {
            const tegans = await tegansEntryRefused();
            await type('invite-names-name', 'Tegan Rules');
            await type('invite-names-name', 'Tegan Rule');
            await generate();
            expect(list.saved[1].addId).not.toBe(tegans);
        });

        it('after the entry is added the list is opened again, so the warning sees it when the name is changed and changed back', async () => {
            const tegans = await tegansEntryRefused();
            expect(list.opens, 'opened at the tick, and again once Tegan’s entry was added').toBe(2);
            await type('invite-names-name', 'Bob Smith');
            expect(q('invite-names-same')).toBeNull();
            await type('invite-names-name', 'tegan  rule');
            expect(q('invite-names-same')?.textContent).toContain(t('{name} is on the list already (added by {by}, not joined yet). Invite that entry instead?', { name: 'Tegan Rule', by: t('an admin') }));
            await press('invite-names-same-invite');
            expect(list.saved, 'Invite that entry adds nothing').toHaveLength(1);
            expect(node.bound.map((b) => b.entryId)).toEqual([tegans]);
        });

        it('the box unticked and ticked again: a new id, even for the same name', async () => {
            const tegans = await tegansEntryRefused();
            await press('invite-names-box');
            await press('invite-names-box');
            expect(q('invite-names-name')).toBeTruthy();
            await type('invite-names-name', 'Tegan Rule');
            await generate();
            expect(list.saved).toHaveLength(2);
            expect(list.saved[1].addId).not.toBe(tegans);
            expect(node.bound.map((b) => b.entryId)).toEqual([list.saved[1].addId]);
        });

        it('a plain invite in between, then the box ticked again: a new id', async () => {
            const tegans = await tegansEntryRefused();
            await press('invite-names-box');
            await generate();
            expect(node.generated, 'the plain invite').toHaveLength(1);
            await press('invite-names-box');
            await type('invite-names-name', 'Bob Smith');
            await generate();
            expect(list.saved[1]).toMatchObject({ name: 'Bob Smith' });
            expect(list.saved[1].addId).not.toBe(tegans);
            expect(list.onNode.find((e) => e.id === tegans)?.name, 'Tegan’s entry keeps her name').toBe('Tegan Rule');
        });

        it('leaving the screen and coming back: a new id', async () => {
            const tegans = await tegansEntryRefused();
            await act(async () => { nav.blur(); });
            await settle();
            await act(async () => { nav.focus(); });
            await settle();
            expect(q('invite-names-name')).toBeTruthy();
            await generate();
            expect(list.saved).toHaveLength(2);
            expect(list.saved[1].addId).not.toBe(tegans);
        });

        it('another of People’s views and back to Invites: a new id', async () => {
            const tegans = await tegansEntryRefused();
            const pill = (words: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === words) as HTMLElement;
            await act(async () => { pill(t('👫 Friends')).click(); });
            await settle();
            await act(async () => { pill(t('🎟️ Invites')).click(); });
            await settle();
            expect(q('invite-names-name')).toBeTruthy();
            await generate();
            expect(list.saved).toHaveLength(2);
            expect(list.saved[1].addId).not.toBe(tegans);
        });
    });

    // #2974 round 3 (deciding review, InviteNamesBoxes.tsx:149): the list says its warnings once, on the open that read them
    // (core forgets them and rewrites `seen`), so the box's open says them on Invites, never drops them.
    describe('what the box’s open says: shown on Invites, once, until dismissed or the list is opened', () => {
        const say = (text: string) => text.split('\n\n').map(keyLineWords).join('\n\n');
        const shown = () => Array.from(host.querySelectorAll('[data-testid="invite-names-notice"]')).map((n) => n.textContent ?? '');
        const DROPPED_ME = NAMES_COPY.droppedMe('damo');
        const LOST = NAMES_COPY.lostEntries(2);

        it('a sync’s warning (another admin’s key dropped this phone): shown in the amber box with "Open the names list", which opens the list and ends it', async () => {
            node.role = 'admin';
            list.said = [[DROPPED_ME]];
            await open();
            expect(q('invite-names-notices'), 'nothing said before the tick').toBeNull();
            await press('invite-names-box');
            expect(shown()).toEqual([say(DROPPED_ME)]);
            expect(q('invite-names-open-list')?.textContent).toBe(t('Open the names list'));
            expect(q('invite-names-notices-dismiss')?.textContent).toBe(t('Dismiss'));
            // The tick's own work goes on: the name field, no refusal.
            expect(q('invite-names-name')).toBeTruthy();
            expect(q('invite-names-refused')).toBeNull();
            // Unticked, it stays: nothing else will say it.
            await press('invite-names-box');
            expect(shown()).toEqual([say(DROPPED_ME)]);
            await press('invite-names-open-list');
            expect(pushed).toEqual(['/names-list']);
            expect(q('invite-names-notices')).toBeNull();
        });

        it('Dismiss ends it, and a later open with nothing to say brings nothing back', async () => {
            node.role = 'owner';
            list.said = [[LOST]];
            await open();
            await press('invite-names-box');
            expect(shown()).toEqual([say(LOST)]);
            await press('invite-names-notices-dismiss');
            expect(q('invite-names-notices')).toBeNull();
            expect(pushed).toEqual([]);
            // An invite made, then the box ticked for the next person: the list opens afresh and has nothing new to say.
            await type('invite-names-name', 'Tegan Rule');
            await generate();
            expect(node.bound).toHaveLength(1);
            await press('invite-names-box');
            expect(list.opens).toBe(2);
            expect(q('invite-names-notices')).toBeNull();
        });

        it('the open again after an entry is added: what it says joins what the tick said, each once, nothing dropped', async () => {
            node.role = 'owner';
            node.committee = true;
            node.inviteRefusal = 'You have only 20 left in your vouching budget.';
            list.said = [[LOST], [LOST, DROPPED_ME]];
            await open();
            await press('invite-names-box');
            expect(shown()).toEqual([say(LOST)]);
            await type('invite-names-name', 'Tegan Rule');
            await press('invite-vouch-50');
            await generate();
            expect(alerts.said[0]?.[0]).toBe(t('Invite not made'));
            expect(list.opens, 'the tick, and the open after the entry was added').toBe(2);
            expect(shown()).toEqual([say(LOST), say(DROPPED_ME)]);
        });

        it('a plan that isn’t ready: the refusal in its own words (the put-back card), not "can’t write right now", and what the open said with it', async () => {
            node.role = 'admin';
            list.plan = { kind: 'refused', reason: 'rolled_back', offered: { n: 2 }, newest: { n: 5 } };
            list.said = [[NAMES_COPY.lostSinceCopy(3)]];
            await open();
            await press('invite-names-box');
            expect(q('invite-names-refused')?.textContent).toBe(say(NAMES_COPY.refusedRolledBack(2, 5)));
            expect(q('invite-names-refused')?.textContent).not.toBe(say(NAMES_COPY.notReady));
            expect(shown()).toEqual([say(NAMES_COPY.lostSinceCopy(3))]);
            // Generate adds nothing, and says the same refusal.
            await type('invite-names-name', 'Ned Varcoe');
            await generate();
            expect(list.saved).toEqual([]);
            expect(alerts.said[0]).toEqual([t('Not added to the names list'), say(NAMES_COPY.refusedRolledBack(2, 5)), []]);
        });

        it('a server that keeps no names list (404): says so, as the list’s screen does', async () => {
            node.role = 'admin';
            list.refuse = 'Not found';
            list.refuseStatus = 404;
            await open();
            await press('invite-names-box');
            expect(q('invite-names-refused')?.textContent).toBe(t('This community keeps no names list.'));
        });
    });
});
