// @vitest-environment jsdom
/**
 * Make invite on the phone, its two classes as invariants over whole tables (PR #3206 round 3; DESIGN-getting-paid-fable.md
 * §4.5, slice B3), as on the web (apps/pwa src/pages/InvitePage.refusals.test.tsx): app/(tabs)/people.tsx rendered for real
 * (the mount of invite-bill-send-render.test.ts) on a community that takes bills, against a fake node that answers as the
 * server does.
 *
 *   C. Every refusal POST /api/invite/generate can answer shows its OWN words, and the panel stays. "No invites here" only for
 *      the invites' own 404 `feature_off` (`feature: 'invites'`); a bill's (`feature: 'bills'`: bills switched off after the
 *      phone read the node's profile) is the bill's refusal, in its words. A refusal in the node's words makes no offline
 *      ticket, with a bill or without; only no answer, a 5xx or a page that isn't the node's falls back to one, never with a
 *      bill.
 *   D. An invite is in Pending once, by its code: a retry answered with an invite Pending already holds (from
 *      /api/invite/mine, re-read when the member comes back to Invites, or from an earlier answer) replaces that row.
 *
 * The refusals are the server's own, read from apps/server routes/community.ts POST /api/invite/generate, engine/invites.ts
 * generateInvite, engine/bills.ts checkInviteBill and assertUnderLimits, engine/writer-bounds.ts assertMayMakeInvite,
 * config/door.ts, config/node-role.ts, routes/profile-feature-gate.ts and gateway-rate-limit.ts. Nothing here contacts a node.
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
import { billLines, busyWords, inviteBillLines, inviteFolds, t } from '@beanpool/core';
import { unbreakable } from '../unbreakable';

const NODE = 'https://node.example';
const FEATURES = { beans: true, invites: true, showcase: false, bills: true };
const ME = 'a-member-key';

type Row = { code: string; createdBy: string; createdAt: string; usedBy: null; usedAt: null; intendedFor?: string; bill?: unknown; expiresAt?: string };
/** What the fake node answers one generate with. */
type Answer = { status: number; body: Record<string, unknown> | null } | { thrown: true } | { invite: Row };
const node = { answers: [] as Answer[], bodies: [] as Array<Record<string, any>>, mine: [] as Row[] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: FEATURES, checkedAt: new Date().toISOString() } }));
    inviteFolds.clear();
    tickets.made = 0;
    alerts.said.length = 0;
    node.answers = [];
    node.bodies = [];
    node.mine = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/api/invite/generate')) {
            node.bodies.push(JSON.parse(String(init?.body)));
            const a = node.answers.shift() ?? { thrown: true };
            if ('thrown' in a) throw new TypeError('Network request failed');
            if ('invite' in a) {
                // The node holds what it answers with: its next /api/invite/mine lists it (once).
                if (!node.mine.some((r) => r.code === a.invite.code)) node.mine.unshift(a.invite);
                return json({ success: true, invite: a.invite });
            }
            return a.body === null ? new Response('<html>A page in front of the node</html>', { status: a.status }) : json(a.body, a.status);
        }
        if (u.endsWith('/api/community/health')) return json({ ok: true });
        if (u.includes('/api/invite/mine/')) return json({ invites: node.mine.map((r) => ({ ...r })) });
        return never();
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const press = async (id: string) => { const el = q(id); expect(el, id).toBeTruthy(); await act(async () => { el!.click(); }); await settle(); };
const pressText = async (text: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
    expect(button, text).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
};
const type = async (id: string, text: string) => {
    const input = q(id) as HTMLInputElement | null;
    expect(input, id).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
};
const open = async () => { await act(async () => { root.render(createElement(PeopleScreen) as any); }); await settle(); };
const fillBill = async () => {
    if (!q('invite-bill-what-for')) await press('invite-bill-toggle');
    await type('invite-bill-what-for', 'Bread');
    await type('invite-bill-beans', '12');
};
const generateButton = () => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Generate')) ?? null;
const generate = async () => {
    if (q('invite-make-another')) await press('invite-make-another');
    const button = generateButton();
    expect(button, 'the Generate button').toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
};

// ── C: every refusal in its own words ───────────────────────────────────────────────────────────────────────────────────

/** How the panel must read one: the alert's title (by kind) and words, or no answer (`lost`). */
type Read = 'invites_off' | 'admins' | 'paused' | 'bill' | 'invite' | 'busy' | 'lost';
const REFUSALS: Array<[string, number, Record<string, unknown> | null, Read]> = [
    ['invites off', 404, { error: 'This community doesn’t use invites: anyone joins it with a sign-in. Share its link.', code: 'feature_off', feature: 'invites' }, 'invites_off'],
    ['bills off', 404, { error: 'Bills are switched off on this node.', code: 'feature_off', feature: 'bills' }, 'bill'],
    ['Beans off', 403, { error: 'Beans are switched off on this node.', code: 'profile_no_beans' }, 'invite'],
    ['bill id', 400, { error: billLines.badId(), code: 'bill_id' }, 'bill'],
    ['bill sender', 403, { error: billLines.notAMember(), code: 'bill_sender' }, 'bill'],
    ['bill amount', 400, { error: billLines.badAmount(), code: 'bill_amount' }, 'bill'],
    ['bill what for', 400, { error: billLines.badWhatFor(), code: 'bill_what_for' }, 'bill'],
    ['bill id reused', 409, { error: billLines.idReused(), code: 'bill_id_reused' }, 'bill'],
    ['bills on hold', 403, { error: billLines.onHold(), code: 'bills_on_hold' }, 'bill'],
    ['bills sent today', 429, { error: 'You have sent 20 bills today. You can send more from 16 Nov.', code: 'bills_sent_day', resetsAt: '2026-11-16T09:00:00.000Z' }, 'bill'],
    ['bills to new people today', 429, { error: 'You have sent bills to 3 new people today.', code: 'bills_new_people_day', resetsAt: '2026-11-16T09:00:00.000Z' }, 'bill'],
    ['bills out', 429, { error: 'You have 30 bills nobody has paid yet.', code: 'bills_out' }, 'bill'],
    ['muted', 403, { error: 'You are muted for an hour.', code: 'moderation_muted', mutedUntil: '2026-11-15T10:00:00.000Z' }, 'invite'],
    ['only admins invite', 403, { error: 'In this community only its admins invite people. Ask one.', code: 'admins_only' }, 'admins'],
    ['paused', 403, { error: 'Your account here is paused for now, so you can’t invite anyone.', code: 'paused' }, 'paused'],
    ['not a member', 403, { error: 'Only registered members can generate invites' }, 'invite'],
    ['not signed', 401, { error: 'A signed request is required' }, 'invite'],
    ['invites today', 429, { error: 'You can make 20 invites in any 24 hours. You can make more at 09:00.', code: 'invites_per_day', resetsAt: '2026-11-16T09:00:00.000Z' }, 'invite'],
    ['invites unused', 429, { error: 'You have 50 invites nobody has used yet, the most one member can hold.', code: 'invites_unused' }, 'invite'],
    ['a standby', 409, { error: 'This server is a standby copy of the community, not its main server.', code: 'standby' }, 'invite'],
    ['the gateway limit', 429, { error: 'Gateway rate limit exceeded. Please try again in 9s.' }, 'invite'],
    ['the day budget', 429, { error: 'You have made 1,000 changes today.', code: 'day_budget', resetsAt: '2026-11-16T09:00:00.000Z' }, 'invite'],
    ['a busy network (not JSON)', 429, null, 'busy'],
    ['a server fault', 500, { error: 'Something went wrong on the server.' }, 'lost'],
    ['a proxy page', 502, null, 'lost'],
];
const TABLE: Array<[string, boolean, number, Record<string, unknown> | null, Read]> = [];
for (const [name, status, body, read] of REFUSALS) for (const withBill of [true, false]) TABLE.push([name, withBill, status, body, read]);

const OFFLINE: [string, string] = [t('Offline Mode'), t('You are currently offline. A temporary cryptographic offline invite ticket (valid for 30 days) will be generated instead.')];
/** The one alert a row expects. A bill's own refusal is the bill's; with no bill, every refusal is "Invite not made". */
const alertFor = (read: Read, withBill: boolean, words: string | undefined): [string, string] => {
    if (read === 'invites_off') return [t('No invites here'), words!];
    if (read === 'admins') return [t('Only admins invite here'), words!];
    if (read === 'paused') return [t('No invites for now'), words!];
    if (read === 'lost') return withBill ? [t('No answer'), inviteBillLines.answerLost()] : OFFLINE;
    if (read === 'busy') return [t('Invite not made'), busyWords()];
    return [read === 'bill' && withBill ? t('Could not add the bill') : t('Invite not made'), words!];
};

describe('C: every refusal of Make invite shows its own words, and the panel stays (the whole table)', () => {
    it('the table holds every refusal with a bill and without, and both switches', () => {
        expect(TABLE).toHaveLength(REFUSALS.length * 2);
        expect(REFUSALS.filter(([, , b]) => b?.code === 'feature_off').map(([, , b]) => b?.feature)).toEqual(['invites', 'bills']);
    });

    it.each(TABLE)('%s, with a bill: %s', async (_name, withBill, status, body, read) => {
        await open();
        if (withBill) await fillBill();
        node.answers = [{ status, body }];
        await generate();
        expect(node.bodies, 'one generate').toHaveLength(1);
        expect('bill' in node.bodies[0]).toBe(withBill);
        expect(alerts.said, 'the one alert, in its own words').toEqual([alertFor(read, withBill, body?.error as string | undefined)]);
        // "No invites here" only for the invites' own switch.
        expect(alerts.said.some(([title]) => title === t('No invites here'))).toBe(read === 'invites_off');
        // An offline ticket only where nobody knows and no bill went: a refusal is never answered with one.
        const ticket = read === 'lost' && !withBill;
        expect(tickets.made, 'offline tickets').toBe(ticket ? 1 : 0);
        if (ticket) {
            expect(q('invite-made-card'), 'the ticket on its made card').toBeTruthy();
        } else {
            // The panel stays: the form is there, with the fold as it was.
            expect(generateButton(), 'the form stays').toBeTruthy();
            expect(!!q('invite-bill-what-for'), 'the fold stays as it was').toBe(withBill);
        }
    });
});

// ── D: an invite in Pending once, by its code ───────────────────────────────────────────────────────────────────────────

const row = (code: string, createdAt: string, extra: Partial<Row> = {}): Row => ({ code, createdBy: ME, createdAt, usedBy: null, usedAt: null, ...extra });
const OLD = row('INV-OLD1', new Date(Date.now() - 3 * 86_400_000).toISOString());
const X = row('INV-XXXX', new Date(Date.now() - 60_000).toISOString(), { bill: { id: 'b-1', whatFor: 'Bread', amount_c: 1200 } });
const NEW = row('INV-NEW2', new Date().toISOString(), { bill: { id: 'b-2', whatFor: 'Bread', amount_c: 1200 } });
const pendingCodes = async () => {
    const fold = q('invites-pending-fold');
    if (!fold) return [];
    if (!host.querySelector('[data-testid="invite-pending-row"]')) await press('invites-pending-fold');
    return Array.from(host.querySelectorAll('[data-testid="invite-pending-row"]')).map((r) => r.querySelector('[data-testid="invite-who"]')?.textContent);
};
const saved = () => (JSON.parse(store.map.get(`bp_offline_invites_${ME}`) ?? '[]') as Row[]).map((r) => r.code);

type ListCase = 'new invite' | 'same invite as listed' | 'same invite after a reload of mine';
/** Each row: what Pending lists before the answer, and after it. */
const LIST: Array<[ListCase, string[], string[]]> = [
    ['new invite', ['INV-OLD1'], ['INV-NEW2', 'INV-OLD1']],
    ['same invite as listed', ['INV-XXXX', 'INV-OLD1'], ['INV-XXXX', 'INV-OLD1']],
    // The finding: the answer was lost, the member left Invites and came back (mine re-read, the invite now listed after the
    // ones this phone had), then tapped the same bill again, as the alert said.
    ['same invite after a reload of mine', ['INV-OLD1', 'INV-XXXX'], ['INV-OLD1', 'INV-XXXX']],
];

describe('D: an invite is in Pending once, by its code (the whole table)', () => {
    it.each(LIST)('%s', async (which, before, after) => {
        node.mine = which === 'same invite as listed' ? [X, OLD] : [OLD];
        await open();
        await fillBill();
        if (which === 'same invite after a reload of mine') {
            node.answers = [{ thrown: true }];
            await generate();
            expect(alerts.said).toEqual([[t('No answer'), inviteBillLines.answerLost()]]);
            // The node made it; back to Invites, the phone reads it from the node.
            node.mine = [X, OLD];
            await pressText(unbreakable(t('👫 Friends')));
            await pressText(unbreakable(t('🎟️ Invites')));
        }
        expect(await pendingCodes(), 'Pending before').toEqual(before);
        // The node answers with the invite it made: a new one, or the one already listed.
        node.answers = [{ invite: which === 'new invite' ? NEW : X }];
        await generate();
        expect(q('invite-made-card'), 'the made card').toBeTruthy();
        expect(await pendingCodes(), 'Pending, in order').toEqual(after);
        expect(q('invites-pending-fold')?.textContent).toContain(`Pending (${after.length})`);
        // What the phone keeps for the next read holds it once too: a later read of mine keeps one row.
        expect(saved(), 'the list saved on the phone').toEqual(after);
        await pressText(unbreakable(t('👫 Friends')));
        await pressText(unbreakable(t('🎟️ Invites')));
        expect(await pendingCodes(), 'Pending after the next read of mine').toHaveLength(after.length);
    });
});
