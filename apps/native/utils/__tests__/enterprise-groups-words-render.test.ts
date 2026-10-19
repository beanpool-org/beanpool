// @vitest-environment jsdom
/**
 * The enterprise page and groups in the member's language (words slice S3, sweep B7): app/treasury-detail.tsx (an
 * enterprise's or a project's page, with its Decisions block, report box, confirmations, pickers and alerts),
 * app/treasury-post.tsx (posting its Offer or Need, with the category picker), components/GroupDetailModal.tsx (a
 * group's info sheet, with its votes and the quiet-lead vote) and app/group-post.tsx, each rendered for real inside the
 * real LanguageProvider. React Native's host components are plain tags carrying their accessibility props,
 * placeholders and the few layout props the 320 dp checks read; the node is the net-spy stand-in for utils/db,
 * answering one small community.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label,
 * hint, placeholder or alert with letters outside a bracket bypassed t(). What members wrote is shown as written: the
 * enterprise's and the group's names, purpose and description, listing titles and memos, the discussion, a vote's
 * title and why, callsigns. The 320 dp × 1.3 checks model widths as talk-words-render.test.ts does (a generous 0.62 em
 * a letter).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Every alert's title, body and buttons, and the last alert's buttons (to press one). */
const alerts = vi.hoisted(() => ({ said: [] as string[], last: [] as Array<{ text?: string; onPress?: () => void }> }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio', alert: 'alert', tab: 'tab', checkbox: 'checkbox' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        const s = flat(props.style);
        if (s.flexWrap) attrs['data-wrap'] = s.flexWrap;
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        if (s.flexShrink !== undefined || s.flex !== undefined) attrs['data-gives'] = 'true';
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
                for (const b of buttons ?? []) if (b.text) alerts.said.push(b.text);
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
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true },
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
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
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
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});
// Digits only: a key's first characters, shown where a member has no name, carry no letters.
const ME = '1'.repeat(64);
const KOFI = '2'.repeat(64);
const MIA = '3'.repeat(64);
const ZOE = '4'.repeat(64);
const IVO = '5'.repeat(64);
const ENT = '9'.repeat(64);
const me = vi.hoisted(() => ({ identity: { publicKey: '1'.repeat(64), callsign: 'Ana' } as Record<string, string> }));
vi.mock('../identity', () => ({ loadIdentity: async () => me.identity }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
// A member's picture: drawn from what they chose, never words.
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../node-post', () => ({ signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}), anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import { pseudoLocalise, setLanguage, type ScopedDecisionCard, type ScopedDecisionList, type UiLang } from '@beanpool/core';
import { DrawnInLanguage, LanguageProvider } from '../../components/LanguageProvider';
import { LanguageRow } from '../../components/LanguagePicker';
import TreasuryDetailScreen from '../../app/treasury-detail';
import TreasuryPostScreen from '../../app/treasury-post';
import GroupPostScreen from '../../app/group-post';
import { GroupDetailModal } from '../../components/GroupDetailModal';

const NODE = 'https://mullum.example';
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

// ── The community: what its members wrote is kept here, so the checks can take it out ───────────────────────────
const BAKERY = 'Hill Bakery';
const PURPOSE = 'Bread for the whole valley, baked in the old hall oven';
const LISTINGS = [
    { id: 'p1', type: 'offer', title: 'Sourdough loaf', description: 'Baked on Saturdays', credits: 4, repeatable: 1 },
    { id: 'p2', type: 'need', title: 'Oven repair', description: 'The door hinge is loose', credits: 30, repeatable: 0 },
];
const THREAD = [
    { id: 'm1', type: 'text', ciphertext: b64('see you at the stall'), authorCallsign: 'Kofi', authorPubkey: KOFI, timestamp: iso(now - 2 * DAY) },
    { id: 'm2', type: 'removed', ciphertext: '', authorCallsign: 'Mia', authorPubkey: MIA, timestamp: iso(now - DAY) },
];
const ledgerEntry = (i: number) => ({
    id: `l${i}`, direction: i % 2 ? 'income' : 'spend', amount: 3 + i,
    counterpartyName: i % 3 === 0 ? undefined : 'Kofi', memo: i % 4 === 0 ? undefined : 'flour run',
    timestamp: iso(now - i * DAY), runningBalance: 100 - i,
});
const LEDGER = {
    enterprise: { publicKey: ENT }, period: { since: null, until: null },
    summary: { totalIncome: 60, totalSpend: 20, netChange: 38.5, startingBalance: 30, endingBalance: 68.5, transactionCount: 23 },
    entries: Array.from({ length: 23 }, (_, i) => ledgerEntry(i + 1)),
};
const decision = (over: Partial<ScopedDecisionCard> = {}): ScopedDecisionCard => ({
    id: 'd1', authorPubkey: KOFI, title: 'Pay Mia for the oven door', description: 'She fixed the hinge last week.',
    effect: 'pay_out', subject: MIA, params: { amount: 12.5 }, status: 'open',
    opensAt: iso(now - 3600_000), closesAt: iso(now + 4 * DAY),
    tally: { voted: 1, roll: 3, quorumRequired: 2, thresholdRequired: 0.6 }, myVote: null, canVote: true, ...over,
});
const DECISIONS: ScopedDecisionList = {
    decisions: [
        decision(),
        decision({ id: 'd2', title: 'Remove Zoe', description: 'Zoe moved away in spring.', effect: 'remove_keeper', subject: KOFI, status: 'executed', myVote: { support: 1, updatedAt: iso(now) }, tally: { voted: 3, roll: 3, quorumRequired: 2, thresholdRequired: 0.6, yes: 3, no: 0 } }),
        decision({ id: 'd3', title: 'New lead', description: 'Time for a change of hands.', effect: 'replace_lead', subject: KOFI, status: 'execution_blocked', executionReason: null, tally: { voted: 2, roll: 3, quorumRequired: 2, thresholdRequired: 0.6, yes: 2, no: 0 } }),
    ],
    canPropose: true, rollSize: 3,
};
/** The enterprise as its lead keeper reads it: requests, changes, bids, deals, a deficit, wage claims and a goal. */
function leadsView(over: Record<string, unknown> = {}) {
    return {
        publicKey: ENT, name: BAKERY, purpose: PURPOSE, lifecycle: 'ongoing', status: 'active', paused: false,
        balance: -12.5, creditLine: 100, liveOffers: 1, earnedSurplus: 7.25, workingCapitalCeiling: 400,
        goalAmount: 500, currentAmount: 120, deadlineAt: iso(now + 9 * DAY),
        isLeadOrSoleKeeperOrAdmin: true, availableToBack: 40,
        keepers: [
            { publicKey: ME, callsign: 'Ana', role: 'lead', grantedAt: iso(now - 300 * DAY) },
            { publicKey: KOFI, callsign: 'Kofi', role: 'keeper', backing: 20, grantedAt: iso(now - 200 * DAY) },
            { publicKey: MIA, callsign: 'Mia', role: 'keeper', suspended: true, grantedAt: iso(now - 100 * DAY) },
        ],
        keeperRequests: [
            { id: 'r1', callsign: 'Ivo', pledgedBacking: 15, canBackPledge: false },
            { id: 'r2', callsign: 'Zoe', pledgedBacking: 0, canBackPledge: true, pendingChange: { appliesAt: iso(now + 2 * DAY + 5 * 3600_000) } },
        ],
        keeperChanges: [
            { id: 'c1', kind: 'add', memberPubkey: ZOE, memberCallsign: 'Zoe', proposedBy: KOFI, proposedByCallsign: 'Kofi', pledgedBacking: 10, appliesAt: iso(now + 2 * DAY) },
            { id: 'c2', kind: 'remove', memberPubkey: MIA, memberCallsign: 'Mia', proposedBy: KOFI, proposedByCallsign: null, appliesAt: iso(now + 3 * 3600_000) },
        ],
        deferredClaims: [{ id: 'w1', status: 'pending', amount: 18 }],
        posts: LISTINGS,
        flow: [{ incoming: true, amount: 8, memo: 'loaf sale', timestamp: iso(now - DAY) }, { incoming: false, amount: 5, memo: '', timestamp: iso(now - 2 * DAY) }],
        pendingBids: [{ id: 'b1', post_title: 'Oven repair', peer_callsign: 'Ivo', credits: 30 }],
        activeDeals: [
            { id: 'd1', post_id: 'p1', post_title: 'Sourdough loaf', peer_callsign: 'Zoe', credits: 4, action_required: 'fulfill' },
            { id: 'd2', post_id: 'p2', post_title: 'Oven repair', peer_callsign: null, credits: 30, action_required: 'release', price_type: 'hourly', hours: 2 },
        ],
        ...over,
    };
}
const SUCCESSION_CANDIDATE = 'Zoe';

/** Everything members and the community wrote: shown as written, in every language. */
const OTHERS = [
    BAKERY, PURPOSE, ...LISTINGS.flatMap((l) => [l.title, l.description]), 'see you at the stall', 'flour run', 'loaf sale',
    'Ana', 'Kofi', 'Mia', 'Zoe', 'Ivo', SUCCESSION_CANDIDATE,
    ...DECISIONS.decisions.flatMap((d) => [d.title, d.description]),
    'Garden club', 'We grow food together on Tuesdays', NODE,
].filter((s): s is string => typeof s === 'string' && /\p{L}/u.test(s)).sort((a, b) => b.length - a.length);

type Answers = Record<string, unknown>;
function community(over: Answers = {}): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Answers = {
        getTreasuryDetail: leadsView(),
        getBalance: { balance: 10, keeperOf: [ENT] },
        getEnterpriseThread: { conversation: null, messages: THREAD, readOnly: false },
        getEnterpriseLedger: LEDGER,
        getEnterpriseDecisions: DECISIONS,
        ...over,
    };
    return (name) => {
        if (!(name in answers)) return undefined;
        const a = answers[name];
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    };
}
const LOCAL = { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false };
function rememberProfile(profile: 'local' | 'global', features: Record<string, unknown>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.answer = community();
    params.now = { publicKey: ENT, name: BAKERY };
    alerts.said.length = 0;
    alerts.last = [];
    me.identity = { publicKey: ME, callsign: 'Ana' };
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    rememberProfile('local', LOCAL);
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, screen: unknown = createElement(TreasuryDetailScreen)) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, screen as any) as any); });
    await settle();
}
async function again(lang: UiLang, screen?: unknown) {
    act(() => root.unmount());
    root = createRoot(host);
    alerts.said.length = 0;
    await renderIn(lang, screen);
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};
const xx = (s: string) => pseudoLocalise(s);
const byLabel = (label: string) => host.querySelector(`[aria-label="${label.replace(/"/g, '\\"')}"]`);
const buttonWith = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null;
const pressAlertButton = async (text: string) => {
    const b = alerts.last.find((x) => x.text === text);
    expect(b, `the alert's ${text}`).toBeTruthy();
    await act(async () => { b!.onPress?.(); });
    await settle(4);
};

/** Text with letters outside a pseudo-locale bracket, once what others wrote is taken out. */
function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
    // Innermost first: a translated sentence can hold another as a value ("[[Ƒööđ~], 3 ūñŕéāđ~~]").
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const o of OTHERS) rest = rest.split(o).join('');
    return /\p{L}/u.test(rest);
}
/** Every drawn text, label, hint, placeholder and alert that bypassed t(). */
function bypassing(): string[] {
    const out = new Set<string>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const whole = n.parentElement?.textContent ?? n.nodeValue;
        if (outsideBrackets(whole)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const [attr, kind] of [['aria-label', 'label'], ['data-hint', 'hint'], ['placeholder', 'placeholder']] as const) {
        for (const e of Array.from(host.querySelectorAll(`[${attr}]`))) {
            const v = e.getAttribute(attr);
            if (outsideBrackets(v)) out.add(`${kind}: ${JSON.stringify(v)}`);
        }
    }
    for (const said of alerts.said) if (outsideBrackets(said)) out.add(`alert: ${JSON.stringify(said)}`);
    return [...out];
}
/** How many drawn texts came through t() (bracketed), so a check on an empty screen can't pass by itself. */
const bracketed = () => Array.from(host.querySelectorAll('span')).filter((s) => /^\[.*\]$/su.test(s.textContent ?? '')).length;

describe('the enterprise page in the pseudo-locale: every word on it came through t() (words S3h)', () => {
    it('its lead keeper: the banner-free page, goal and pledge box, requests and changes, keepers, the balance in deficit, wage claims, Decisions, operator controls with bids and deals, the season controls, Income & Spend, listings, activity and the discussion', async () => {
        await renderIn('xx');
        expect(host.textContent).toContain(BAKERY);
        expect(host.textContent).toContain(PURPOSE);
        expect(host.textContent).toContain('see you at the stall');
        expect(host.textContent).toContain('Pay Mia for the oven door');
        // What the helpers write reads in the member's language too: a keeper change, the removed stand-in, the ledger.
        expect(host.textContent).toContain(xx('Adding {name} as a keeper, backing {n} beans').replace('{name}', 'Zoe').replace('{n}', '10'));
        expect(host.textContent).toContain(xx('removed by a keeper'));
        expect(host.textContent).toContain(xx('Show {shown} more ({n} older)').replace('{shown}', '3').replace('{n}', '3'));
        expect(host.textContent).toContain(xx('KEEPERS ({n})').replace('{n}', '3'));
        expect(bracketed()).toBeGreaterThan(60);
        expect(bypassing()).toEqual([]);
    });

    it('the season controls: each confirmation, the deficit that blocks a wind-up, and the alerts the page raises', async () => {
        await renderIn('xx');
        await click(byLabel(xx('Pause for Season')), 'Pause for Season');
        expect(host.textContent).toContain(xx('Confirm Pause for Season'));
        expect(bypassing(), 'pause').toEqual([]);
        await click(buttonWith(xx('Cancel')), 'Cancel');
        await click(byLabel(xx('Start Wind-Up')), 'Start Wind-Up');
        expect(host.textContent).toContain(xx('Start Enterprise Wind-Up'));
        expect(host.textContent).toContain(xx('Cannot wind up an enterprise in deficit ({amount} 🫘). Debt must be resolved or written off first.').replace('{amount}', '-12.5'));
        expect(bypassing(), 'wind-up').toEqual([]);

        await click(byLabel(xx('Step down as a keeper')), 'Step down');
        await click(byLabel(xx('Remove {name} as a keeper').replace('{name}', 'Kofi')), 'Remove Kofi');
        // The bid's Decline (a join request's Decline has its own spoken name and asks nothing first).
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === xx('Decline') && !b.getAttribute('aria-label')), 'Decline a bid');
        await click(byLabel(xx('Remove message from {name}').replace('{name}', 'Kofi')), 'Remove a message');
        // Four alerts, each a title, a body and two buttons.
        expect(alerts.said.length).toBe(16);
        expect(bypassing(), 'alerts').toEqual([]);
    });

    it('releasing an hourly deal opens the hours box; the report box', async () => {
        await renderIn('xx');
        await click(buttonWith(xx('Release Payment ({amount} 🫘)').replace('{amount}', '30')), 'Release Payment');
        expect(host.textContent).toContain(xx('Confirm Hours Worked'));
        expect(bypassing(), 'hours').toEqual([]);
        await click(buttonWith(xx('Cancel')), 'Cancel');
        await click(byLabel(xx('Report Enterprise')), 'Report Enterprise');
        expect(host.textContent).toContain(xx('WHY ARE YOU REPORTING IT?'));
        expect(host.textContent).toContain(xx('Child safety'));
        expect(bypassing(), 'report').toEqual([]);
    });

    it('the Decisions block\'s propose form', async () => {
        await renderIn('xx');
        await click(buttonWith(xx('Propose a vote')), 'Propose a vote');
        expect(host.querySelector('[data-testid="propose-scoped-sheet"]')).not.toBeNull();
        expect(host.textContent).toContain(xx('How many Beans?'));
        expect(bypassing()).toEqual([]);
    });

    it('a project, its keeper while its leader is quiet: the succession card with its vote, then proposing a candidate', async () => {
        const quiet = { isEligible: true, leadPubkey: KOFI, leadCallsign: 'Kofi', daysInactive: 34 };
        const proposal = { id: 's1', status: 'active', candidatePubkey: ZOE, candidateCallsign: SUCCESSION_CANDIDATE, votesCount: 1, noVotesCount: 0, requiredVotes: 2, totalEligible: 3, deadlineAt: iso(now + 13 * DAY), votes: [] };
        const project = (over: Record<string, unknown>) => leadsView({
            lifecycle: 'bounded', balance: 40, isLeadOrSoleKeeperOrAdmin: false, keeperRequests: [], keeperChanges: [],
            keepers: [
                { publicKey: KOFI, callsign: 'Kofi', role: 'lead' }, { publicKey: ME, callsign: 'Ana', role: 'keeper' }, { publicKey: ZOE, callsign: SUCCESSION_CANDIDATE, role: 'keeper' },
            ],
            leadInactivity: quiet, ...over,
        });
        net.answer = community({ getTreasuryDetail: project({ succession: { proposals: [proposal] } }) });
        await renderIn('xx');
        expect(host.textContent).toContain(xx('LEADER INACTIVE ({n} DAYS)').replace('{n}', '34'));
        expect(host.textContent).toContain(xx('Succession Proposal: Elect {name} as leader').replace('{name}', SUCCESSION_CANDIDATE));
        expect(byLabel(xx('Yes, make {name} leader').replace('{name}', SUCCESSION_CANDIDATE))).not.toBeNull();
        expect(bypassing(), 'the vote').toEqual([]);

        net.answer = community({ getTreasuryDetail: project({ succession: { proposals: [] } }) });
        await again('xx');
        await click(byLabel(xx('Propose Active Collaborator as Leader')), 'Propose Active Collaborator as Leader');
        expect(host.textContent).toContain(xx('Select an active collaborator to move the leader role to:'));
        expect(host.textContent).toContain(xx('{name} (yourself)').replace('{name}', 'Ana'));
        expect(bypassing(), 'the picker').toEqual([]);
    });

    it('a member who is not a keeper: the join card with its standing box; a request waiting, then approved', async () => {
        const member = { isLeadOrSoleKeeperOrAdmin: false, keeperRequests: [], keeperChanges: [], keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }], balance: 20 };
        net.answer = community({ getTreasuryDetail: leadsView(member), getBalance: { balance: 10, keeperOf: [] } });
        await renderIn('xx');
        expect(host.textContent).toContain(xx('🤝 ASK TO JOIN AS A KEEPER'));
        expect(host.textContent).toContain(xx('PLEDGE BEANS 🌱'));
        expect(bypassing(), 'join').toEqual([]);

        net.answer = community({ getTreasuryDetail: leadsView({ ...member, myPendingRequest: { pledgedBacking: 5 } }), getBalance: { balance: 10, keeperOf: [] } });
        await again('xx');
        expect(host.textContent).toContain(xx('⏳ KEEPER REQUEST PENDING'));
        expect(bypassing(), 'waiting').toEqual([]);

        net.answer = community({ getTreasuryDetail: leadsView({ ...member, myPendingRequest: { pledgedBacking: 5, pendingChange: { appliesAt: iso(now + DAY) } } }), getBalance: { balance: 10, keeperOf: [] } });
        await again('xx');
        expect(bypassing(), 'approved').toEqual([]);
    });

    it('the banners every member sees: paused (with its warning), winding up (grace over), completed (the discussion read-only)', async () => {
        net.answer = community({ getTreasuryDetail: leadsView({ paused: true, pausedAt: iso(now - 85 * DAY), pauseDaysRemaining: 5, pausedFloorSnapshot: 80 }) });
        await renderIn('xx');
        // The banner's label in capitals, the language's way (inCapitalsOf; the pseudo-locale takes English's rule).
        expect(host.textContent).toContain(xx('Paused for the season').toUpperCase());
        expect(host.textContent).toContain(xx('Pause credit floor snapshot expires in {n} days').replace('{n}', '5'));
        expect(bypassing(), 'paused').toEqual([]);

        net.answer = community({ getTreasuryDetail: leadsView({ status: 'winding_up', windUpInitiatedBy: KOFI, windUpGraceEndsAt: iso(now - 3600_000) }) });
        await again('xx');
        expect(host.textContent).toContain(xx('Winding Up').toUpperCase());
        expect(host.textContent).toContain(xx('The 7-day grace period has elapsed. Ready to be finalised.'));
        expect(bypassing(), 'winding up').toEqual([]);

        net.answer = community({ getTreasuryDetail: leadsView({ status: 'completed', balance: 0 }), getEnterpriseThread: { conversation: null, messages: [], readOnly: true } });
        await again('xx');
        expect(host.textContent).toContain(xx('Enterprise has wound up — discussion thread is read-only.'));
        expect(bypassing(), 'completed').toEqual([]);
    });

    it('a page the node could not answer, and an empty ledger, listings and activity', async () => {
        net.answer = community({ getTreasuryDetail: null });
        await renderIn('xx');
        expect(host.textContent).toContain(xx("Couldn't load this group. Check your connection."));
        expect(bypassing(), 'no page').toEqual([]);

        net.answer = community({ getTreasuryDetail: leadsView({ posts: [], flow: [], balance: 5 }), getEnterpriseThread: { conversation: null, messages: [], readOnly: false }, getEnterpriseLedger: { ...LEDGER, entries: [] } });
        await again('xx');
        expect(host.textContent).toContain(xx('No transactions recorded for this period.'));
        expect(host.textContent).toContain(xx('No live listings yet.'));
        expect(host.textContent).toContain(xx('No messages yet. Start the conversation!'));
        expect(bypassing(), 'empty').toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        await renderIn('en');
        expect(bracketed()).toBe(0);
        expect(host.textContent).toContain('PENDING KEEPER REQUESTS (2)');
        expect(host.textContent).toContain('Adding Zoe as a keeper, backing 10 beans');
        expect(host.textContent).toContain('⚠️ OPERATOR EATS LAST: This enterprise is currently in deficit (-12.5 🫘).');
        expect(host.textContent).toContain('Show 3 more (3 older)');
        expect(host.textContent).toContain('Bid by Ivo · 30 🫘');
        expect(host.textContent).toContain('Worker: Member · 30 🫘 in escrow');
        expect(host.textContent).toContain('120 🫘 raised');
        expect(host.textContent).toContain('Votes among this enterprise\'s keepers. More than half must vote.');
        expect(byLabel('Vote Yes on Pay Mia for the oven door')).not.toBeNull();
        expect(host.textContent).toContain('removed by a keeper');
    });
});

describe('posting an enterprise\'s Offer or Need in the pseudo-locale (words S3h)', () => {
    it('an Offer, the toast when a field is missing, and the category picker', async () => {
        params.now = { treasury: ENT, mode: 'offer', name: BAKERY };
        await renderIn('xx', createElement(TreasuryPostScreen));
        expect(host.textContent).toContain(xx('WHAT ARE YOU OFFERING?'));
        expect(host.textContent).toContain(xx("Posting on behalf of {name}. This lists in the Market like any offer; income from sales lands in the enterprise's balance.").replace('{name}', BAKERY));
        await click(buttonWith(xx('POST OFFER')), 'POST OFFER');
        expect(host.textContent).toContain(xx('⚠️ Add a title, category and price'));
        expect(bypassing(), 'offer').toEqual([]);
        await click(byLabel(xx('Choose a category')), 'Choose a category');
        expect(host.textContent).toContain(xx('Category'));
        expect(bypassing(), 'the picker').toEqual([]);
    });

    it('a Need, with no name: each sentence says "this enterprise" itself', async () => {
        params.now = { treasury: ENT, mode: 'need' };
        await renderIn('xx', createElement(TreasuryPostScreen));
        expect(host.textContent).toContain(xx("Posting on behalf of this enterprise. Members can bid to fulfil this tender; you approve a bid and release payment when it's done — funded by the enterprise's credit line."));
        expect(byLabel(xx('Price type: {type}. Tap to change.').replace('{type}', xx('fixed')))).not.toBeNull();
        expect(bypassing()).toEqual([]);
    });
});

// ── Groups ────────────────────────────────────────────────────────────────────────────────────────────────────
const GROUP = {
    id: 'g1', name: 'Garden club', slug: 'garden-club', description: 'We grow food together on Tuesdays', avatarUrl: null,
    category: 'working_group', createdBy: ME, joinPolicy: 'request_to_join', createdAt: iso(now - 90 * DAY), updatedAt: iso(now),
    memberCount: 4, viewerRole: 'convenor', viewerStatus: 'active', leadPubkey: ME, leadCallsign: 'Ana', closedAt: null,
};
const member = (pubkey: string, callsign: string, role: string, status = 'active') => ({ groupId: 'g1', memberPubkey: pubkey, callsign, role, status, joinedAt: iso(now - 60 * DAY), invitedBy: null });
const MEMBERS = [
    member(ME, 'Ana', 'convenor'), member(KOFI, 'Kofi', 'convenor'), member(MIA, 'Mia', 'member'), member(ZOE, 'Zoe', 'observer'),
    member(IVO, 'Ivo', 'member', 'pending_approval'),
];
const GROUP_DECISIONS: ScopedDecisionList = {
    decisions: [
        decision({ id: 'g-d1', scopeKind: 'group', effect: 'set_join_policy', subject: null, params: { policy: 'open' }, title: 'Open the club', description: 'More hands at the beds.' }),
        decision({ id: 'g-d2', scopeKind: 'group', effect: 'close_group', subject: null, params: null, status: 'unresolved', executionReason: 'Quorum not met (1/3)', title: 'Close it', description: 'The season is over now.', tally: { voted: 1, roll: 3, quorumRequired: 2, thresholdRequired: 0.6, yes: 1, no: 0 } }),
    ],
    canPropose: true, rollSize: 3, onRoll: true, closedAt: null, nameable: [ME, KOFI, MIA],
};
const OTHERS_GROUP = ['Open the club', 'More hands at the beds.', 'Close it', 'The season is over now.'];
OTHERS.push(...OTHERS_GROUP);
OTHERS.sort((a, b) => b.length - a.length);
const quietLead = (over: Record<string, unknown> = {}) => ({
    silence: { convenorPubkey: KOFI, convenorCallsign: 'Kofi', lastActiveAt: iso(now - 34 * DAY), daysInactive: 34, isSilent: true, isEligible: true, electorate: 'members', votersJoinedBy: iso(now - 34 * DAY) },
    proposals: [], canPropose: true, voters: [ME, MIA], ...over,
});
function groupNode(over: Answers = {}): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    return community({
        fetchGroupDetails: { group: GROUP, members: MEMBERS, rosterRefused: false },
        getGroupDecisions: GROUP_DECISIONS,
        fetchGroupSuccession: null,
        ...over,
    });
}
const sheet = (props: Record<string, unknown> = {}) => createElement(GroupDetailModal, {
    group: GROUP as any, isOpen: true, onClose() {}, myPubkey: ME, onPostToGroup() {}, keyChanged: new Set([MIA]), ...props,
});

describe('a group\'s info sheet in the pseudo-locale: every word on it came through t() (words S3h)', () => {
    it('its lead convenor: the pills, the lead line, Convenor Tools with a request, the roster with its badges and the key-changed mark, the votes, and every alert', async () => {
        net.answer = groupNode();
        await renderIn('xx', sheet());
        expect(host.textContent).toContain('Garden club');
        expect(host.textContent).toContain('We grow food together on Tuesdays');
        expect(host.textContent).toContain(xx('working group'));
        expect(host.textContent).toContain(xx('CONVENOR'));
        expect(host.textContent).toContain(xx('OBSERVER'));
        expect(host.textContent).toContain(xx('(key changed)'));
        expect(host.textContent).toContain(xx('Change who can join: {policy}').replace('{policy}', xx('anyone can join')));
        expect(bracketed()).toBeGreaterThan(25);
        expect(bypassing(), 'the sheet').toEqual([]);

        await click(byLabel(xx('Change join policy')), 'Change join policy');
        await pressAlertButton(xx('Open (immediate)'));
        await click(byLabel(xx('Hand over lead convenor')), 'Hand over');
        await click(byLabel(xx('Leave Group')), 'Leave Group');
        await click(byLabel(xx('Change role for {name}').replace('{name}', 'Mia')), 'Role');
        await click(byLabel(xx('Remove {name} from the group').replace('{name}', 'Zoe')), 'Remove Zoe');
        await click(byLabel(xx('Decline join request from {name}').replace('{name}', 'Ivo')), 'Decline Ivo');
        await click(byLabel(xx('Make {name} the lead convenor').replace('{name}', 'Kofi')), 'Make Kofi lead');
        expect(alerts.said.length).toBeGreaterThan(15);
        expect(bypassing(), 'the alerts').toEqual([]);

        await click(buttonWith(xx('Propose a vote')), 'Propose a vote');
        expect(host.querySelector('[data-testid="propose-group-sheet"]')).not.toBeNull();
        expect(bypassing(), 'the propose form').toEqual([]);
    });

    it('a member while the lead is quiet: the vote card with its buttons; then proposing; then the outcome alone', async () => {
        me.identity = { publicKey: MIA, callsign: 'Mia' };
        const asMember = { ...GROUP, viewerRole: 'member', leadPubkey: KOFI, leadCallsign: 'Kofi' };
        const proposal = { id: 'q1', groupId: 'g1', convenorPubkey: KOFI, convenorCallsign: 'Kofi', candidatePubkey: ME, candidateCallsign: 'Ana', proposerPubkey: ME, proposerCallsign: 'Ana', status: 'active', closedReason: null, createdAt: iso(now - DAY), deadlineAt: iso(now + 13 * DAY), executedAt: null, yesCount: 1, noCount: 0, electorateSize: 3, myVote: null, canVote: true };
        net.answer = groupNode({ fetchGroupDetails: { group: asMember, members: MEMBERS, rosterRefused: false }, fetchGroupSuccession: quietLead({ proposals: [proposal], canPropose: false }) });
        await renderIn('xx', sheet({ group: asMember, myPubkey: MIA }));
        expect(host.textContent).toContain(xx('Choosing a new lead convenor').toUpperCase());
        expect(host.textContent).toContain(xx("{name} hasn't been active for {n} days. The group can choose a new lead.").replace('{name}', 'Kofi').replace('{n}', '34'));
        await click(byLabel(xx('Vote yes to make {name} the lead convenor').replace('{name}', 'Ana')), 'Vote yes');
        expect(bypassing(), 'the vote').toEqual([]);

        net.answer = groupNode({ fetchGroupDetails: { group: asMember, members: MEMBERS, rosterRefused: false }, fetchGroupSuccession: quietLead() });
        await again('xx', sheet({ group: asMember, myPubkey: MIA }));
        expect(host.textContent).toContain(xx('Propose a new lead'));
        await click(byLabel(xx('Propose {name} as the lead convenor').replace('{name}', 'Mia')), 'Propose Mia');
        expect(bypassing(), 'proposing').toEqual([]);

        const passed = { ...proposal, status: 'passed', executedAt: iso(now - DAY) };
        net.answer = groupNode({ fetchGroupDetails: { group: asMember, members: MEMBERS, rosterRefused: false }, fetchGroupSuccession: quietLead({ silence: { ...quietLead().silence, isSilent: false, isEligible: false }, proposals: [passed], canPropose: false }) });
        await again('xx', sheet({ group: asMember, myPubkey: MIA }));
        expect(host.textContent).toContain(xx("{name} is now the group's lead convenor.").replace('{name}', 'Ana'));
        expect(bypassing(), 'the outcome').toEqual([]);
    });

    it('someone not in it: Join, Request to Join, waiting, invite only, a closed group, and a roster kept for members', async () => {
        me.identity = { publicKey: IVO, callsign: 'Ivo' };
        const outside = (over: Record<string, unknown>) => ({ ...GROUP, viewerRole: null, viewerStatus: null, ...over });
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ joinPolicy: 'open' }, 'Join Group'],
            [{ joinPolicy: 'request_to_join' }, 'Request to Join'],
            [{ viewerStatus: 'pending_approval' }, 'Request Pending Approval'],
            [{ joinPolicy: 'invite_only' }, 'Invite Only'],
            [{ closedAt: iso(now - DAY) }, "Closed by its members' vote"],
        ];
        for (const [over, words] of cases) {
            const group = outside(over);
            net.answer = groupNode({ fetchGroupDetails: { group, members: [], rosterRefused: true }, getGroupDecisions: null });
            await again('xx', sheet({ group, myPubkey: IVO }));
            const shown = host.textContent!.includes(xx(words)) || byLabel(xx(words)) !== null;
            expect(shown, words).toBe(true);
            expect(host.textContent).toContain(xx('Join the group to see who is here'));
            expect(bypassing(), words).toEqual([]);
        }
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        net.answer = groupNode();
        await renderIn('en', sheet());
        expect(bracketed()).toBe(0);
        expect(host.textContent).toContain('working group');
        expect(host.textContent).toContain('request to join');
        expect(host.textContent).toContain('Lead convenor: Ana (you). Only the lead can remove or demote a convenor, and nobody can remove the lead.');
        expect(host.textContent).toContain('Pending Requests (1)');
        // In capitals as it has always been shown (inCapitalsOf now, where a textTransform was).
        expect(host.textContent).toContain('ROSTER (4)');
        expect(host.textContent).toContain('Ana (You)');
        expect(host.textContent).toContain('(key changed)');
        expect(host.textContent).toContain('Not enough people voted');
    });
});

describe('posting to a group in the pseudo-locale (words S3h)', () => {
    it('with Beans: the banner, Offer / Need, the price unit, the toggles, and the missing-fields alert', async () => {
        params.now = { groupId: 'g1', groupName: 'Garden club' };
        await renderIn('xx', createElement(GroupPostScreen));
        expect(host.textContent).toContain(xx('Only {name} can see this').replace('{name}', 'Garden club'));
        expect(host.textContent).toContain(xx('PRICE (BEANS) *'));
        await click(buttonWith(xx('Post to {name}').replace('{name}', 'Garden club')), 'Post');
        expect(alerts.said).toContain(xx('Missing Fields'));
        expect(bypassing()).toEqual([]);
    });

    it('with Beans off: the note in the price\'s place', async () => {
        rememberProfile('global', { beans: false, escrow: false, enterprises: false, invites: false, showcase: false });
        params.now = { groupId: 'g1', groupName: 'Garden club' };
        await renderIn('xx', createElement(GroupPostScreen));
        expect(host.textContent).toContain(xx('No price here: say in the description what you would like in return, or that it is free.'));
        expect(bypassing()).toEqual([]);
    });
});

// ── 320 dp with text at 1.3×: longer languages never push words past an edge (checked with the pseudo-locale) ─────────
const FLOOR = 320;
const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);
const longestWord = (text: string) => text.split(/[\s\u200B]+/).reduce((a, b) => (widthOf(b, 1) > widthOf(a, 1) ? b : a), '');
const spanWith = (text: string) => Array.from(host.querySelectorAll('span')).find((s) => s.textContent === text) ?? null;

describe('the enterprise page and groups at 320 dp with 1.3× text, in the pseudo-locale', () => {
    it('the operator buttons: two lines at most, the longest word across its half, shrinking', async () => {
        await renderIn('xx');
        // 16 dp page gutters, the panel's 14 dp padding, a 10 dp gap; each half less its 16 dp icon and 6 dp gap.
        const half = (FLOOR - 32 - 28 - 10) / 2 - 22;
        for (const words of ['Post Offer', 'Post Need']) {
            const label = spanWith(xx(words))!;
            expect(label, words).not.toBeNull();
            expect(label.getAttribute('data-lines')).toBe('2');
            expect(label.getAttribute('data-shrinks')).toBe('true');
            const min = Number(label.getAttribute('data-min-scale'));
            expect(widthOf(longestWord(label.textContent!), 13 * SCALE) * min, words).toBeLessThanOrEqual(half);
        }
    });

    it('the request buttons, the period tabs and the P&L labels: one line each, shrinking to fit their share', async () => {
        await renderIn('xx');
        // The requests card's 16 dp padding and the row's 12 dp, an 8 dp gap; each button's 8 dp padding.
        const button = (FLOOR - 32 - 32 - 24 - 8) / 2 - 16;
        for (const words of ['Approve', 'Decline']) {
            const label = Array.from(host.querySelectorAll('span[data-shrinks]')).find((s) => s.textContent === xx(words))!;
            expect(label.getAttribute('data-lines')).toBe('1');
            expect(widthOf(label.textContent!, 13 * SCALE) * Number(label.getAttribute('data-min-scale')), words).toBeLessThanOrEqual(button);
        }
        // The strip's four tabs (All time is 1.6 of a share) inside the card's 14 dp padding and the strip's 3 dp; 2 dp each side.
        const unit = (FLOOR - 32 - 28 - 6) / 4.6;
        for (const [words, share] of [['All time', 1.6], ['30d', 1], ['90d', 1], ['1y', 1]] as const) {
            const label = spanWith(xx(words))!;
            expect(label.getAttribute('data-lines')).toBe('1');
            // maxFontSizeMultiplier 1.1 on the tabs.
            expect(widthOf(label.textContent!, 12 * 1.1) * Number(label.getAttribute('data-min-scale')), words).toBeLessThanOrEqual(unit * share - 4);
        }
        const box = (FLOOR - 32 - 28 - 8) / 2 - 20;
        for (const words of ['Came in', 'Went out']) {
            const label = spanWith(xx(words).toUpperCase())!;
            expect(label.getAttribute('data-lines')).toBe('1');
            expect(widthOf(label.textContent!, 10 * SCALE) * Number(label.getAttribute('data-min-scale')), words).toBeLessThanOrEqual(box);
        }
    });

    it('the bid row wraps its two buttons; the deal and cancel buttons\' words wrap inside them', async () => {
        await renderIn('xx');
        const approve = buttonWith(xx('Approve Bid ({amount} 🫘)').replace('{amount}', '30'))!;
        expect(approve.parentElement!.getAttribute('data-wrap')).toBe('wrap');
        for (const words of ['Fulfill Deal · Awaiting Customer Release', 'Cancel Initiative & Refund Escrow']) {
            const label = spanWith(xx(words));
            if (!label) continue; // the cancel button is a project's alone
            expect(label.getAttribute('data-gives'), words).toBe('true');
        }
    });

    it('the post forms: the header and Post shrink to one line; a group\'s Offer / Need fit their half', async () => {
        params.now = { treasury: ENT, mode: 'offer', name: BAKERY };
        await renderIn('xx', createElement(TreasuryPostScreen));
        // Between the 40 dp close button and its 40 dp spacer, inside 16 dp padding.
        const title = spanWith(xx('Post an Offer').toUpperCase())!;
        expect(title.getAttribute('data-lines')).toBe('1');
        expect(widthOf(title.textContent!, 16 * SCALE) * Number(title.getAttribute('data-min-scale'))).toBeLessThanOrEqual(FLOOR - 32 - 80);

        params.now = { groupId: 'g1', groupName: 'Garden club' };
        await again('xx', createElement(GroupPostScreen));
        const half = (FLOOR - 40 - 10) / 2;
        for (const words of ['🟢 Offer', '🟠 Need']) {
            const label = spanWith(xx(words))!;
            expect(label.getAttribute('data-lines')).toBe('1');
            expect(widthOf(label.textContent!, 14 * SCALE) * Number(label.getAttribute('data-min-scale')), words).toBeLessThanOrEqual(half);
        }
    });

    it('a group\'s pills wrap; its request buttons and Role shrink to one line', async () => {
        net.answer = groupNode();
        await renderIn('xx', sheet());
        const pill = spanWith(xx('working group'))!;
        expect(pill.parentElement!.parentElement!.getAttribute('data-wrap')).toBe('wrap');
        for (const words of ['Approve', 'Decline', 'Role']) {
            const label = Array.from(host.querySelectorAll('span[data-shrinks]')).find((s) => s.textContent === xx(words))!;
            expect(label, words).toBeTruthy();
            expect(label.getAttribute('data-lines')).toBe('1');
        }
    });
});

describe('the enterprise page follows a language picked in Settings', () => {
    const NATIVE_WORDS = path.resolve(__dirname, '../../words');
    const fr = JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, 'fr.json'), 'utf8')) as Record<string, string>;
    const MENU = { menuBtn: {}, menuIconWrap: {}, menuIcon: {}, menuText: {}, menuSub: {}, menuChevron: {} };

    it('a pick redraws it in the new language: the operator buttons, a keeper\'s chip and the back button\'s spoken name', async () => {
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(LanguageRow as any, { styles: MENU }), createElement(TreasuryDetailScreen))) as any);
        });
        await settle();
        expect(host.textContent).toContain('Post Offer');
        expect(byLabel('Go back')).not.toBeNull();
        await click(host.querySelector('[data-testid="settings-language"]'), 'Settings → Language');
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        await settle();
        const keeper = fr['Keeper\u0004enterprise role'];
        expect(fr['Post Offer']).toBeTruthy();
        expect(keeper).toBeTruthy();
        expect(host.textContent).toContain(fr['Post Offer']);
        expect(host.textContent).not.toContain('Post Offer');
        expect(spanWith(keeper)).not.toBeNull();
        expect(byLabel(fr['Go back'])).not.toBeNull();
        expect(byLabel('Go back')).toBeNull();
        // What members wrote stays as written.
        expect(host.textContent).toContain(BAKERY);
        expect(host.textContent).toContain(PURPOSE);
    });

    it('labels in capitals take the language\'s rule, not the phone\'s: a project\'s leader chip in Turkish reads LİDER', async () => {
        const tr = JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, 'tr.json'), 'utf8')) as Record<string, string>;
        expect(tr['Leader\u0004project role']).toBe('Lider');
        const project = leadsView({ lifecycle: 'bounded', balance: 40, keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }, { publicKey: ME, callsign: 'Ana', role: 'keeper' }] });
        net.answer = community({ getTreasuryDetail: project });
        await renderIn('tr');
        // Dotted capital İ, as Turkish writes it; a textTransform or toUpperCase() would have drawn "LIDER".
        expect(spanWith('LİDER')).not.toBeNull();
        expect(host.textContent).not.toContain('LIDER');
    });
});
