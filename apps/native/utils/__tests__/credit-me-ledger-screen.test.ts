// @vitest-environment jsdom
/**
 * "What people who give credit see" on the phone's own Ledger, the whole screen rendered for real (scratch/fable-design/
 * DESIGN-credit-list-amend-fable.md §5.4; amendment 2 §0 item 20; slice C6; DESIGN-credit-list-fable.md test 22 and 15). A
 * fake node answers `GET /api/credit/me`; what the phone SENT is recorded and what it DREW comes from the answer alone, through
 * core's creditMeCard. Nothing here contacts a node.
 *
 * The harness is showcase-ledger-render's: the mode is decided as on a phone (the phone's copy of the node's profile through
 * useNodeProfile → useReaderFeatures → showcaseMode), and the net spy records every call into the node client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { creditMeCard, type CreditMeAnswer } from '@beanpool/core';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        attrs['data-style'] = JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter(s => s && typeof s === 'object')));
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
            ListHeaderComponent,
            data.length
                ? data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item, index })))
                : ListEmptyComponent),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), TouchableWithoutFeedback: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert() {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push() {}, navigate() {} },
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>(), writes: [] as string[] }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.writes.push(`${k}=${v}`); store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', EncodingType: { UTF8: 'utf8' }, writeAsStringAsync: async () => {} }));
vi.mock('expo-sharing', () => ({ shareAsync: async () => {} }));
vi.mock('../haptics', () => ({ hapticSuccess() {}, hapticWarning() {} }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: ({ callsign }: { callsign: string }) => createElement('span', { 'data-avatar': callsign }),
}));
vi.mock('../../components/TrustBadge', () => ({ TrustBadge: ({ level }: { level: string }) => createElement('span', { 'data-badge': level }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
// One identity object for the whole run, as the app's context keeps it: a new one each render would read again forever.
const me = vi.hoisted(() => ({ identity: { publicKey: 'ab'.repeat(32), callsign: 'Ana' } as Record<string, string> }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
const net = vi.hoisted(() => ({
    calls: [] as string[],
    /** The node's answer to the member's own balance (utils/db getBalance), whole hundredths. */
    balance: () => ({ balance_c: -42000, floor_c: -130000, usableFloor_c: -130000, liveOffers: 1, activated: true, frozen: false, tier: { name: 'Newcomer', emoji: '🌱' } }) as Record<string, unknown>,
    /** The node's answer to GET /api/credit/me: a status and a body, or 'offline' for a request that never got an answer. */
    credit: { status: 200 as number | 'offline', body: {} as unknown },
}));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name) => (name === 'getBalance' ? Promise.resolve(net.balance()) : undefined)));
vi.mock('../node-post', () => ({
    signedGet: async (_url: string, path: string) => {
        net.calls.push(`signedGet ${path}`);
        if (path === '/api/credit/me') {
            if (net.credit.status === 'offline') throw new Error('offline');
            return new Response(JSON.stringify(net.credit.body), { status: net.credit.status });
        }
        return new Promise<Response>(() => {});
    },
    signedPost: (_url: string, path: string) => { net.calls.push(`signedPost ${path}`); return new Promise(() => {}); },
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../../components/RepaymentCard', () => ({ RepaymentCard: () => null }));

import LedgerScreen from '../../app/(tabs)/ledger';

const NODE = 'https://mullum.example';
const rememberProfile = (profile: 'global' | 'local', features: Record<string, boolean>) =>
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
const WORLDWIDE = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true };

/** What the node's builder answers for a member: a voucher's answer about them (no parts, nobody who stands behind, no freeze). */
const ANSWER = (over: Partial<CreditMeAnswer> = {}): CreditMeAnswer & Record<string, unknown> => ({
    memberPubkey: me.identity.publicKey, callsign: 'Ana', own: false, owed_c: 42000, over_c: 0, paused: false,
    line_c: 130000, usable_c: 130000, liveOffers: 1, balance_c: -42000, canGive: true, status: 'active',
    risk: { level: 'medium', more: true, reasons: [{ code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 90000, line: 100000, pct: 50, gift: 90000, giftDays: 30 } }] },
    ...over,
});
const serve = (answer: CreditMeAnswer, status = 200) => { net.credit = { status, body: { told: 'x', me: answer } }; };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.credit = { status: 200, body: {} };
    store.map.clear();
    store.writes.length = 0;
    store.map.set('beanpool_anchor_url', NODE);
    globalThis.fetch = vi.fn(async (url: unknown) => { net.calls.push(`fetch ${String(url)}`); return new Response('{}'); }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = async () => {
    await act(async () => { root.render(createElement(LedgerScreen) as any); });
    for (let i = 0; i < 6; i++) await act(async () => {});
};
const text = () => host.textContent ?? '';
const card = () => host.querySelector('[data-testid="credit-seen-by-givers"]');
const asks = () => net.calls.filter((c) => c === 'signedGet /api/credit/me');

describe('a community that trades in Beans: the member\'s own Ledger', () => {
    beforeEach(() => rememberProfile('local', { beans: true, showcase: false }));

    it('asks the node once for what givers see, and draws core\'s card in its order (red when a line moves or a sentence is composed in the app)', async () => {
        serve(ANSWER());
        await render();
        expect(asks()).toHaveLength(1);
        const c = card();
        expect(c).not.toBeNull();
        const expected = creditMeCard(ANSWER());
        // Word for word, in this order: title, credit line, live Offers, balance, risk word, each reason, the told sentence.
        const lines = [expected.title, expected.credit, expected.liveOffers!, expected.balance, `${expected.shape} ${expected.word}`, ...expected.reasons, expected.told];
        const body = c!.textContent!;
        let at = -1;
        for (const line of lines) {
            const next = body.indexOf(line, at + 1);
            expect(next, `"${line}" is in the card, after the one before it`).toBeGreaterThan(at);
            at = next;
        }
        // The pieces a member reads, spelled out once so a change to core's words is seen here too.
        expect(body).toContain('What people who give credit see');
        expect(body).toContain('Balance −420 · using 420 of 1,300');
        expect(body).toContain('By their own trading they would owe 900 of 1,000: more than half. A gift of Beans paid 900 of it in the last 30 days.');
        expect(body).toContain('An owner or admin can say more.');
        expect(body).toContain('People who give credit here (the owners, admins and vouchers) can see your balance and your credit line, and each look is recorded.');
        expect(body).not.toContain('They owe');
    });

    it('is read once the member\'s own balance has been read, not before: one read at open, never one for the empty balance too (red when the card mounts on the empty balance)', async () => {
        serve(ANSWER());
        let land!: () => void;
        const held = new Promise<Record<string, unknown>>((resolve) => { land = () => resolve({ balance_c: -42000, floor_c: -130000, usableFloor_c: -130000, liveOffers: 1, activated: true, frozen: false, tier: { name: 'Newcomer', emoji: '🌱' } }); });
        const real = net.balance;
        net.balance = () => held as unknown as Record<string, unknown>;
        try {
            await render();
            expect(asks()).toHaveLength(0);
            expect(card()).toBeNull();
            await act(async () => { land(); });
            for (let i = 0; i < 6; i++) await act(async () => {});
            expect(asks()).toHaveLength(1);
            expect(card()).not.toBeNull();
        } finally { net.balance = real; }
    });

    it('is on the Levels tab, under the trust figures, and asks nothing else of the credit routes (red when it asks for the list, a card or the looks)', async () => {
        serve(ANSWER());
        await render();
        expect(text().indexOf('WHAT BUILDS YOUR TRUST')).toBeGreaterThan(-1);
        expect(text().indexOf('What people who give credit see')).toBeGreaterThan(text().indexOf('WHAT BUILDS YOUR TRUST'));
        const credit = net.calls.filter((c) => c.includes('/api/credit') || c.includes('/api/vouchers/ask'));
        expect(credit).toEqual(['signedGet /api/credit/me']);
    });

    it('reads the voucher\'s answer only: an answer that also carries parts, who stands behind and a freeze draws none of them (red when the card reads what a voucher is not told)', async () => {
        net.credit = { status: 200, body: { told: 'x', me: {
            ...ANSWER({ risk: { level: 'low', more: true, reasons: [{ code: 'new', level: 'not_known', mark: 'open', values: {} }] } }),
            parts: { known_c: 100000, room_c: 20000, earned_c: 10000, granted_c: 0, cap_c: 200000 },
            standsBehind: { confirmedBy: { memberPubkey: 'k', callsign: 'zedmin', at: '2026-11-01' }, vouchedBy: [{ memberPubkey: 'j', callsign: 'olivia', amount_c: 10000 }] },
            frozen: { credit: true, known: false },
        } } };
        await render();
        const body = card()!.textContent!;
        for (const leak of ['Made of', 'known floor', 'zedmin', 'olivia', 'Confirmed by', 'Vouched by', 'froze', 'frozen']) expect(body).not.toContain(leak);
        expect(body).toContain('Credit risk: low');
    });

    it.each([
        ['a node with Beans off (404)', 404, { error: 'Beans are off here.', code: 'beans_off' }],
        ['an unsigned request (401)', 401, { error: 'Sign this request with your member key.', code: 'unsigned' }],
        ['a refusal (403)', 403, { error: 'Not a member of this community.', code: 'not_a_member' }],
        ['a node that is down (500)', 500, { error: 'try again' }],
    ])('%s: nothing is drawn, and no error either (red when a refusal reaches the screen as a card or a message)', async (_name, status, body) => {
        net.credit = { status, body };
        await render();
        expect(asks()).toHaveLength(1);
        expect(card()).toBeNull();
        expect(text()).not.toContain('What people who give credit see');
        expect(text()).not.toContain('Credit risk');
        expect(text()).not.toContain(String((body as { error: string }).error));
    });

    it('no connection: nothing is drawn (red when an offline read throws into the screen)', async () => {
        net.credit = { status: 'offline', body: {} };
        await render();
        expect(card()).toBeNull();
        expect(text()).toContain('WHAT BUILDS YOUR TRUST');
    });

    it('keeps nothing: no phone storage write holds a figure, a word of the card or the answer (red when the answer is cached for offline)', async () => {
        serve(ANSWER({ balance_c: -43713 }));
        await render();
        expect(card()!.textContent).toContain('437.13');
        const written = store.writes.join('\n');
        for (const piece of ['43713', '437.13', 'Credit risk', 'credit line', 'over_half', '/api/credit/me']) expect(written).not.toContain(piece);
    });
});

describe('the worldwide community and any node whose Beans are not live for this reader', () => {
    it('in preview the Ledger asks the node nothing about credit and draws no card (red when the card is asked for outside a live Beans community)', async () => {
        rememberProfile('global', WORLDWIDE);
        serve(ANSWER());
        await render();
        expect(asks()).toHaveLength(0);
        expect(card()).toBeNull();
        expect(net.calls.filter((c) => c.includes('/api/credit'))).toEqual([]);
    });

    it('a node whose profile says Beans are off asks nothing either (red when only the node\'s 404 stands between the phone and the question)', async () => {
        rememberProfile('local', { beans: false, showcase: false });
        serve(ANSWER());
        await render();
        expect(asks()).toHaveLength(0);
        expect(card()).toBeNull();
    });
});

describe('what the card is made of (red when the phone grows its own copy of a sentence)', () => {
    /** A source file's code, without its comments (a comment may name what the code does not use). */
    const src = (f: string) => fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('the component draws core\'s creditMeCard and composes no reason, balance or credit sentence itself', () => {
        const s = src('components/CreditSeenByGivers.tsx');
        expect(s).toContain('creditMeCard');
        for (const own of ['riskReasonSentence', 'balanceSentence', 'creditLineSentence', 'position(']) expect(s, own).not.toContain(own);
        // English is core's: the component holds no sentence of its own.
        expect(/>\s*[A-Z][a-z]+ [a-z]+/.test(s.replace(/\{[^}]*\}/g, ''))).toBe(false);
    });

    it('the credit answer lives in the component\'s state only: no phone database, storage, file or cache is imported', () => {
        const s = src('components/CreditSeenByGivers.tsx') + src('utils/credit-view.ts');
        for (const store of ['AsyncStorage', 'expo-file-system', 'expo-sqlite', "from './db'", "from '../utils/db'", 'SecureStore', 'MMKV']) expect(s, store).not.toContain(store);
    });
});
