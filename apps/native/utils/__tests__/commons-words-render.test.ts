// @vitest-environment jsdom
/**
 * The Commons tab and its Decisions in the member's language (words slice S3, sweep B6): app/(tabs)/projects.tsx rendered
 * for real inside the real LanguageProvider, with what only it opens drawn for real too: the Commons info sheet, a
 * project's and an enterprise's card, the Commons preview, Decide (open and History, in preview too), the
 * propose-a-Decision form; and the two forms of their own, app/propose-project.tsx and the new-poll form. React
 * Native's host components are plain tags carrying their accessibility props, placeholders and the few layout props the
 * 320 dp checks read; the node answers a small community.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint,
 * placeholder or alert with letters outside a bracket bypassed t(). What members, the community and the node wrote is
 * shown as written: a group's, a project's or an enterprise's name, purpose and description, a Decision's title and
 * text, a member's name, the node's reasons, Example Valley's sample, a Decision's system reference.
 *
 * Components the Commons shares with other screens are drawn as stand-ins (their sweeps are the screens they share):
 * Talk's Your groups rows and the create-a-group flow (S3c), the group detail sheet (groups), MemberAvatar, InfoModal's
 * frame (its stand-in draws the title, tab names and every tab the Commons sheet hands it), and the local-community
 * marker (its stand-in draws the label an action hands it, and the header's words).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, forwardRef, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', switch: 'switch', checkbox: 'checkbox', tab: 'tab', tablist: 'tablist', radiogroup: 'radiogroup', progressbar: 'progressbar' };
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
        if (s.flexShrink !== undefined) attrs['data-shrink'] = String(s.flexShrink);
        if (s.flex !== undefined) attrs['data-flex'] = String(s.flex);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        if (s.textTransform) attrs['data-transform'] = s.textTransform;
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const FlatList = forwardRef(function FlatList(props: Record<string, any>, _ref) {
        const { data = [], renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent } = props;
        return createElement('div', null,
            ListHeaderComponent ?? null,
            data.length
                ? data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
                : (ListEmptyComponent ?? null));
    });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), TouchableWithoutFeedback: el('div'), SafeAreaView: el('div'), KeyboardAvoidingView: el('div'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        FlatList, RefreshControl: () => null,
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                for (const b of buttons ?? []) { if (b.text) alerts.said.push(b.text); alerts.buttons.push(b); }
            },
        },
        Share: { share: async () => ({}) },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, Presets: {}, create: () => ({}) },
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
        useLocalSearchParams: () => params.now,
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        ErrorBoundary: () => null,
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.map.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => store.map.delete(k)); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }) }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: async () => ({}), SaveFormat: { JPEG: 'jpeg' } }));
const picked = vi.hoisted(() => ({ date: null as Date | null }));
vi.mock('@react-native-community/datetimepicker', () => ({
    // Picks the day the case set, as soon as it opens.
    default: function Picker({ onChange }: { onChange: (e: { type: string }, d?: Date) => void }) {
        useEffect(() => { if (picked.date) onChange({ type: 'set' }, picked.date); }, []);
        return null;
    },
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
});
vi.mock('expo-crypto', () => ({ randomUUID: () => 'a-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors, themePreference: 'light', setThemePreference() {}, patternEnabled: false, setPatternEnabled() {} }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});
const KEY = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity, setIdentity() {} }) }));
vi.mock('../identity', () => ({ loadIdentity: async () => who.identity }));
vi.mock('../nodes', () => ({ getSavedNodes: async () => [] }));

// What the node says, as the cases set it.
const LOCAL = { beans: true, escrow: true, enterprises: true, decisions: true };
const GLOBAL = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true };
const node = vi.hoisted(() => ({
    features: null as Record<string, unknown> | null,
    canPropose: true as boolean | null,
    decisions: [] as any[],
    groups: [] as any[],
    treasuries: [] as any[],
    voice: { voiceCredits: 16, hasCompletedTrade: true } as { voiceCredits: number; hasCompletedTrade: boolean } | null,
    vote: { success: true } as Record<string, unknown>,
    area: null as null | { lat: number; lng: number },
}));
vi.mock('../use-reader-features', () => ({
    useReaderFeatures: () => ({ node: node.features, reader: null, effective: node.features, known: true }),
}));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', features: { ...(node.features ?? {}), nearbyListings: { radiusKm: 10, max: 500 } } }) }));
vi.mock('../member-area', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useMyArea: () => node.area,
}));
vi.mock('../db', () => ({
    getBalance: async () => ({ earnedCredit: 0, commons: 1234.5, canOperate: true }),
    getTreasuries: async () => node.treasuries,
    getDecisions: async () => ({ decisions: node.decisions, myPoolVoting: node.voice, canPropose: node.canPropose }),
    getAllCommunityMembers: async () => [{ publicKey: 'd'.repeat(64), callsign: 'Dave' }],
    fetchGroups: async () => node.groups,
    fetchYourGroups: async () => [],
    castDecisionVote: async () => node.vote,
    createDecision: async () => ({ success: true }),
    createPost: async () => ({}),
    createEnterpriseApi: async () => ({}),
}));

// Shared with other screens: drawn as stand-ins (see the note above).
vi.mock('../../components/YourGroupsPane', () => ({
    YourGroupsRows: () => createElement('span', { 'data-later-sweep': 'YourGroupsRows' }),
    YourGroupsLoading: () => null,
    YourGroupsError: ({ message }: { message: string }) => createElement('span', { 'data-stand-in': 'YourGroupsError' }, message),
    useCreateGroupFlow: () => ({ open() {}, modal: null }),
}));
const yours = vi.hoisted(() => ({ items: [] as unknown[] | null, error: null as string | null }));
vi.mock('../../components/useYourGroups', () => ({
    useYourGroups: () => ({ items: yours.items, error: yours.error, refresh() {} }),
    yourGroupsStore: { refresh() {} },
}));
vi.mock('../../components/GroupDetailModal', () => ({ GroupDetailModal: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/InfoModal', () => ({
    InfoModal: ({ isOpen, title, tabs }: { isOpen: boolean; title: string; tabs: Array<{ id: string; label: string; content: unknown }> }) => (isOpen
        ? createElement('div', { 'data-modal': 'true', 'data-stand-in': 'InfoModal' },
            createElement('span', { role: 'heading' }, title),
            ...tabs.map((tab) => createElement('div', { key: tab.id }, createElement('button', null, tab.label), tab.content as any)))
        : null),
}));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({
    LocalCommunityMark: (p: { variant: string; label?: string }) => (p.variant === 'action'
        ? createElement('button', { 'data-testid': 'local-community-action' }, p.label)
        : createElement('span', { 'data-later-sweep': `LocalCommunityMark:${p.variant}` })),
    ExampleHeader: ({ text }: { text?: string }) => createElement('span', { 'data-stand-in': 'ExampleHeader' }, text ?? null),
    LocalCommunitySheet: () => null,
}));

import { SAMPLE_COMMUNITY, inCapitalsOf, pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider, DrawnInLanguage } from '../../components/LanguageProvider';
import { LanguageRow } from '../../components/LanguagePicker';
import ProjectsScreen from '../../app/(tabs)/projects';
import ProposeProjectScreen from '../../app/propose-project';
import { NewPollModal } from '../../components/NewPollModal';
import { sampleDecisions, sampleEnterprises } from '../../components/showcase/sample-screens';

const NODE = 'https://mullum.example';
const DAY = 24 * 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const GROUPS = [
    { id: 'g1', name: 'Garden Crew', description: 'We grow food on the corner lot', category: 'working_group', joinPolicy: 'request_to_join', memberCount: 4 },
    { id: 'g2', name: 'Knitters', description: '', category: 'social', joinPolicy: 'invite_only', memberCount: 1, viewerStatus: 'invited' },
    { id: 'g3', name: 'Night Owls', description: 'Late chats', category: 'general', joinPolicy: 'open', memberCount: 9, viewerRole: 'observer' },
    { id: 'g4', name: 'Drummers', description: 'Rhythm', category: 'drum_circle', joinPolicy: 'by_vote', memberCount: 3 },
];
const TREASURIES = [
    { publicKey: 'p'.repeat(64), name: 'New hall roof', purpose: 'A dry roof for the hall', balance: 40, liveOffers: 0, goalAmount: 300, currentAmount: 40, lifecycle: 'bounded', status: 'active', paused: false, keepers: [{ memberPubkey: 'x' }], deadlineAt: iso(Date.now() + 10 * DAY) },
    { publicKey: 'e'.repeat(64), name: 'Egg flock', purpose: '', balance: -12.5, liveOffers: 3, goalAmount: null, currentAmount: null, lifecycle: 'ongoing', status: 'active', paused: true, keepers: [{ memberPubkey: 'x' }, { memberPubkey: 'y' }], deadlineAt: null },
    { publicKey: 'w'.repeat(64), name: 'Old mill', purpose: 'Flour', balance: 0, liveOffers: 1, goalAmount: 50, currentAmount: 10, lifecycle: 'bounded', status: 'active', paused: false, keepers: [], deadlineAt: iso(Date.now() - 2 * DAY) },
];
const tally = (over: Record<string, unknown> = {}) => ({
    totalVoters: 4, quorumRequired: 6, quorumMet: false, supportRatio: 0.75, thresholdRequired: 0.5, yesWeight: 3, noWeight: 1, passed: false,
    electorate: 4, quorumRatio: 0.3, ...over,
});
const decision = (id: string, over: Record<string, unknown>) => ({
    id, authorPubkey: 'o'.repeat(64), title: `Title ${id}`, description: `Why ${id}`, touches: 'member', effect: 'suspend_member', subject: 'd'.repeat(64),
    params: {}, status: 'open', franchise: '1m1v', opensAt: iso(Date.now() - DAY), closesAt: iso(Date.now() + 3 * DAY), tally: tally(), myVote: null, ...over,
});
const OPEN = [
    // The member's own: one open Decision each, so a second is refused.
    decision('11111111', { authorPubkey: KEY, effect: 'remove_member', params: { memberName: 'Dave', debt: -20, commonsPool: 500 } }),
    // A member's proposal carrying a pause vote's mark is no pause's vote (removal by vote S2): it gets no pause box.
    decision('22222222', { effect: 'remove_member', params: { memberName: 'Mia', rule: 2 }, closesAt: iso(Date.now() + 30 * 60_000) }),
    decision('33333333', { effect: 'remove_member', params: { memberName: 'Kofi', balance: 15 }, closesAt: iso(Date.now() + 5 * 3600_000) }),
    decision('44444444', { touches: 'pool', effect: 'grant_enterprise', franchise: 'quadratic_trade', myVote: { support: false, voteCount: 3, creditsUsed: 9, updatedAt: iso(Date.now()) }, tally: tally({ quorumMet: true, quorumRequired: 3, electorate: 2 }) }),
    decision('55555555', { effect: 'keep_suspension', params: { memberName: 'Ana', suspendedAt: iso(new Date(2026, 9, 3, 12).getTime()) }, myVote: { support: true, voteCount: 1, creditsUsed: 1, updatedAt: iso(Date.now()) } }),
    decision('66666666', { effect: 'reach_the_moon', touches: 'sky', closesAt: iso(Date.now() - 1000) }),
    // A pause's own vote (removal by vote S2), and one on an admin, whom no vote removes.
    decision('18181818', { authorPubkey: 'SYSTEM', effect: 'remove_member', params: { memberName: 'Ola', rule: 2, pausedAt: iso(new Date(2026, 9, 22, 12).getTime()), reason: 'Threats at the market' } }),
    decision('19191919', { authorPubkey: 'SYSTEM', effect: 'remove_member', params: { memberName: 'Abe', rule: 2, serverRole: 'admin', pausedAt: iso(new Date(2026, 9, 22, 12).getTime()) } }),
];
const PAST = [
    decision('77777777', { status: 'executed', effect: 'freeze_credit', executionReason: 'Credit floor set to 0', tally: tally({ quorumMet: true, passed: true }) }),
    decision('88888888', { status: 'executed', effect: 'grant_voucher' }),
    decision('99999999', { status: 'failed', effect: 'unfreeze_credit', tally: tally({ quorumMet: true }) }),
    decision('10101010', { status: 'failed', effect: 'revoke_voucher' }),
    decision('12121212', { status: 'admin_halted', effect: 'grant_hardship', adminHaltReason: 'Duplicate of last week' }),
    decision('13131313', { status: 'execution_pending_grace', effect: 'remove_member', gracePeriodEndsAt: iso(new Date(2026, 9, 25, 12).getTime()) }),
    decision('14141414', { status: 'execution_void', effect: 'write_off_deficit' }),
    decision('15151515', { status: 'unresolved', effect: 'forgive_debt' }),
    decision('16161616', { status: 'passed_queued_for_funds', effect: 'remove_lead_keeper' }),
    decision('17171717', { status: 'paused_by_storm', effect: 'unsuspend_member' }),
];

/** Everything members, the community, the node and the sample wrote: shown as written. */
const OTHERS = [
    ...GROUPS.flatMap((g) => [g.name, g.description]), 'drum circle', 'by vote', 'DRUM_CIRCLE',
    ...TREASURIES.flatMap((e) => [e.name, e.purpose]),
    ...[...OPEN, ...PAST].flatMap((d) => [d.title, d.description]),
    'Dave', 'Mia', 'Kofi', 'Ana', 'Ola', 'Abe', 'Credit floor set to 0', 'Duplicate of last week', 'Reach The Moon', 'sky', 'PAUSED BY STORM', 'system:decision:',
    'Example Valley', ...SAMPLE_COMMUNITY.decisions.flatMap((d) => [d.question, (d as { body?: string }).body ?? '']),
    ...sampleDecisions().flatMap((d) => [d.title, d.description]), ...sampleEnterprises().flatMap((e) => [e.name ?? '', e.purpose ?? '']),
].filter(Boolean).sort((a, b) => b.length - a.length);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    params.now = {};
    alerts.said.length = 0;
    alerts.buttons.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    who.identity = { publicKey: KEY, privateKey: 'me-priv', callsign: 'Me' };
    node.features = LOCAL;
    node.canPropose = true;
    node.decisions = [...OPEN, ...PAST];
    node.groups = GROUPS;
    node.treasuries = TREASURIES;
    node.voice = { voiceCredits: 16, hasCompletedTrade: true };
    node.vote = { success: true };
    node.area = null;
    yours.items = [];
    yours.error = null;
    picked.date = null;
});
afterEach(() => { vi.useRealTimers(); act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, screen: ReturnType<typeof createElement> = createElement(ProjectsScreen)) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, screen) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const type = async (el: Element | null | undefined, text: string) => {
    expect(el).toBeTruthy();
    const input = el as HTMLInputElement;
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};
const shown = (english: string, lang: UiLang = 'xx') => (lang === 'xx' ? pseudoLocalise(english) : english);
/** The button whose own words hold `english` as drawn now. */
const button = (english: string, lang: UiLang = 'xx') => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(shown(english, lang))) ?? null;
const byLabel = (label: string) => host.querySelector(`[aria-label="${label.replace(/"/g, '\\"')}"]`);
const byPlaceholder = (english: string) => host.querySelector(`input[placeholder="${shown(english).replace(/"/g, '\\"')}"]`);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A sentence drawn now with some number for {n} (a count that moves with the clock). */
const withSomeCount = (english: string) => new RegExp(pseudoLocalise(english).split('{n}').map(escape).join('\\d+'));
/** Commons opens on Decide (its first section): Groups is a tap away. */
const toGroups = (lang: UiLang = 'xx') => click(byLabel(shown('Groups Section', lang)), 'Groups');

/** Text with letters outside a pseudo-locale bracket, once what others wrote is taken out. */
function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
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
const bracketed = () => Array.from(host.querySelectorAll('span')).filter((s) => /^\[.*\]$/su.test(s.textContent ?? '')).length;

describe('the Commons in the pseudo-locale: every word on it came through t() (words S3g)', () => {
    it('Groups: the heading, the pool and voice credits, the switch, Your groups, the chips, a group\'s card, the enterprises\' cards', async () => {
        await renderIn('xx');
        expect(host.textContent).toContain(pseudoLocalise('Community decisions, the Commons, and your groups: projects, enterprises and more. Propose binding actions and vote on what matters.'));
        expect(host.textContent).toContain(inCapitalsOf(pseudoLocalise('Voice credits')));
        await toGroups();
        expect(host.textContent).toContain(inCapitalsOf(pseudoLocalise('Groups you could join')));
        expect(host.textContent).toContain(pseudoLocalise("You're not in any groups yet. Join one below, or start one with +."));
        // A group's card: its kind and join policy in the member's language, an unknown one as the node wrote it.
        expect(host.textContent).toContain(pseudoLocalise('🏷️ {category} · {n} members · {policy}').replace('{category}', pseudoLocalise('working group')).replace('{n}', '4').replace('{policy}', pseudoLocalise('request to join')));
        expect(host.textContent).toContain(pseudoLocalise('🏷️ {category} · {n} member · {policy}').replace('{category}', pseudoLocalise('social')).replace('{n}', '1').replace('{policy}', pseudoLocalise('invite only')));
        expect(host.textContent).toContain('drum circle');
        expect(host.textContent).toContain(pseudoLocalise('INVITED'));
        expect(host.textContent).toContain(pseudoLocalise('OBSERVER'));
        expect(host.textContent).toContain(pseudoLocalise('No description provided.'));
        // A project's and an enterprise's cards: the state line, the money, the deadline.
        expect(host.textContent).toContain(pseudoLocalise('{n} keeper').replace('{n}', '1'));
        expect(host.textContent).toContain(pseudoLocalise('Paused for season'));
        expect(host.textContent).toContain(pseudoLocalise('{n} days left').replace('{n}', '10'));
        expect(host.textContent).toContain(pseudoLocalise('Expired'));
        expect(host.textContent).toContain(pseudoLocalise('Goal: {amount} 🫘').replace('{amount}', '300'));
        expect(bracketed()).toBeGreaterThan(30);
        expect(bypassing()).toEqual([]);
        await click(button('🌱 Projects'), 'Projects chip');
        await click(button('🏛️ Enterprises'), 'Enterprises chip');
        await click(button('👥 Chat groups'), 'Chat groups chip');
        expect(bypassing(), 'chips').toEqual([]);
    });

    it('the empty lists, and the + with no community connected', async () => {
        node.groups = [];
        node.treasuries = [];
        await renderIn('xx');
        await toGroups();
        expect(host.textContent).toContain(pseudoLocalise('No other groups yet'));
        await click(button('🌱 Projects'), 'Projects chip');
        expect(host.textContent).toContain(pseudoLocalise('No projects to back yet'));
        expect(host.textContent).toContain(pseudoLocalise('+ Start a project'));
        await click(button('🏛️ Enterprises'), 'Enterprises chip');
        expect(host.textContent).toContain(pseudoLocalise('+ Start an enterprise'));
        store.map.delete('beanpool_anchor_url');
        await click(byLabel(pseudoLocalise('Start a project or an enterprise')), 'the +');
        expect(alerts.said).toContain(pseudoLocalise('Connect to a community first.'));
        await click(button('👥 Chat groups'), 'Chat groups chip');
        expect(host.textContent).toContain(pseudoLocalise('No other groups to join'));
        expect(host.textContent).toContain(pseudoLocalise('+ Create a Group'));
        expect(bypassing()).toEqual([]);
    });

    it('the Commons info sheet: every tab, the worked example and the process', async () => {
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('About the Commons Pool')), 'About the Commons Pool');
        expect(host.textContent).toContain(pseudoLocalise('Community Commons'));
        expect(host.textContent).toContain(pseudoLocalise('progressive monthly contribution'));
        expect(host.textContent).toContain(pseudoLocalise('{n} credits').replace('{n}', '25'));
        expect(host.textContent).toContain('200 × 0% = 0.0 + 300 × 1.0% = 3.0 + 100 × 1.5% = 1.5');
        expect(host.textContent).toContain(pseudoLocalise('5. At close, passed Decisions execute automatically — the node transfers approved funds to the enterprise account.'));
        expect(bypassing()).toEqual([]);
    });

    it('Decide: every kind of card, its tally and turnout, the vote and its answers, the stepper; the propose questions', async () => {
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Decide Section')), 'Decide');
        expect(host.textContent).toContain(inCapitalsOf(pseudoLocalise('Touches: {what}').replace('{what}', pseudoLocalise('member'))));
        expect(host.textContent).toContain(pseudoLocalise('Remove Member'));
        expect(host.textContent).toContain('Reach The Moon');
        expect(host.textContent).toContain(pseudoLocalise('Closing now'));
        expect(host.textContent).toMatch(withSomeCount('{n}m left'));
        expect(host.textContent).toMatch(withSomeCount('{n}h left'));
        expect(host.textContent).toContain(pseudoLocalise('Vote YES'));
        expect(host.textContent).toContain(pseudoLocalise('You voted No ({n} votes)').replace('{n}', '3'));
        expect(host.textContent).toContain(pseudoLocalise('You have {credits}: up to {votes} on this Decision.').replace('{credits}', pseudoLocalise('{n} voice credits').replace('{n}', '16')).replace('{votes}', pseudoLocalise('{n} votes').replace('{n}', '4')));
        expect(host.textContent).toContain(pseudoLocalise('An admin suspended {name} on {date}. Keep the suspension?').replace('{name}', 'Ana').split('{date}')[0]);
        expect(host.textContent).toContain(pseudoLocalise('An admin paused {name} on {date}.').replace('{name}', 'Ola').split('{date}')[0]);
        expect(host.textContent).toContain(pseudoLocalise('Yes removes {name} after 7 days. No brings {name} back as soon as the vote closes.').split('{name}').join('Ola'));
        expect(host.textContent).toContain(pseudoLocalise("{name} holds a role that runs this community's server, and no community vote removes an owner or admin: whatever this vote decides, {name} is back when it closes.").split('{name}').join('Abe'));
        expect(bypassing(), 'open').toEqual([]);
        await click(byLabel(pseudoLocalise('Increase votes')), 'Increase votes');
        await click(button('Vote YES'), 'Vote YES');
        expect(alerts.said).toContain(pseudoLocalise('Vote Recorded'));
        // The node's no-trade answer in the member's language; any other refusal as the node wrote it.
        node.vote = { success: false, error: 'Voting on community money opens after your first completed trade.' };
        await click(button('Vote YES'), 'Vote YES again');
        expect(alerts.said).toContain(pseudoLocalise('Voting on community money opens after your first completed trade.'));
        expect(bypassing(), 'votes').toEqual([]);
        await click(button('+ Propose a Decision'), 'Propose');
        expect(alerts.said).toContain(pseudoLocalise('You already have an open decision (limit 1 open decision per author).'));
        expect(bypassing(), 'propose').toEqual([]);
    });

    it('Decide: a member with no trade yet is told before voting on money, and asked to trade before proposing', async () => {
        node.canPropose = false;
        node.voice = { voiceCredits: 0, hasCompletedTrade: false };
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Decide Section')), 'Decide');
        expect(host.querySelector('[data-testid="pool-vote-blocker"]')?.textContent).toBe(pseudoLocalise('Voting on community money opens after your first completed trade.'));
        expect(host.textContent).toContain(pseudoLocalise('For money votes · opens after your first completed trade'));
        await click(byLabel(pseudoLocalise('Propose a decision')), 'the +');
        expect(alerts.said).toContain(pseudoLocalise('Complete a Trade First'));
        expect(bypassing()).toEqual([]);
    });

    it('Decide\'s History: every filter, status, tally and provenance line', async () => {
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Decide Section')), 'Decide');
        await click(byLabel(pseudoLocalise('Decisions History')), 'History');
        expect(host.textContent).toContain(pseudoLocalise('EXECUTION PENDING GRACE'));
        expect(host.textContent).toContain('PAUSED BY STORM');
        expect(host.textContent).toContain(pseudoLocalise('Not executed: Threshold not met'));
        expect(host.textContent).toContain(pseudoLocalise('Not executed: Quorum not reached'));
        expect(host.textContent).toContain(pseudoLocalise('Expired unresolved: Quorum not reached'));
        expect(host.textContent).toContain(pseudoLocalise('Executed successfully'));
        expect(bypassing(), 'all').toEqual([]);
        for (const f of ['Executed', 'Failed', 'Void']) await click(button(f), f);
        node.decisions = OPEN;
        await click(button('All'), 'All');
        expect(bypassing(), 'filters').toEqual([]);
    });

    it('the propose-a-Decision form: touches, effects, the lead to remove, the debt disclosure, its questions', async () => {
        node.decisions = [];
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Decide Section')), 'Decide');
        await click(button('+ Propose a Decision'), 'Propose');
        expect(host.textContent).toContain(pseudoLocalise('Propose a Community Decision'));
        expect(host.textContent).toContain(inCapitalsOf(pseudoLocalise('Mandatory Debt Disclosure (§3.8)')));
        expect(bypassing(), 'form').toEqual([]);
        await click(byLabel(pseudoLocalise('Submit Community Decision')), 'Submit');
        expect(alerts.said).toContain(pseudoLocalise('Missing Title'));
        await click(button('Remove a lead keeper or project leader'), 'Remove a lead');
        expect(host.textContent).toContain(inCapitalsOf(pseudoLocalise('The lead keeper or leader to remove: callsign or public key')));
        expect(byPlaceholder("Enter the lead keeper or leader's callsign or pubkey...")).not.toBeNull();
        await type(byPlaceholder('e.g. Grant 200 beans to the Tool Library'), 'Replace the lead');
        await type(byPlaceholder('Explain why this decision is needed, what will be done, and who is responsible.'), 'They left');
        // The Egg flock's key: the form knows it for an enterprise (the screen hands it the node's list, #2200), so it
        // asks for its lead keeper.
        await type(byPlaceholder('Or enter its public key...'), 'e'.repeat(64));
        expect(byPlaceholder("Enter the lead keeper's callsign or pubkey...")).not.toBeNull();
        // No lead named: the form asks for the member first (its lead alert follows only a named one, never reached).
        await click(byLabel(pseudoLocalise('Submit Community Decision')), 'Submit');
        expect(alerts.said).toContain(pseudoLocalise('Please enter or select a valid member callsign or 64-character public key.'));
        await click(button('Commons Pool'), 'Commons Pool');
        await click(button('Give Beans to a project or enterprise'), 'Give Beans');
        await click(byLabel(pseudoLocalise('Submit Community Decision')), 'Submit');
        expect(alerts.said).toContain(pseudoLocalise('Invalid Amount'));
        await click(button('Hardship Grant'), 'Hardship');
        OTHERS.push('Replace the lead', 'They left', 'e'.repeat(64));
        expect(bypassing(), 'answers').toEqual([]);
        OTHERS.splice(OTHERS.length - 3, 3);
    });

    it('in preview (the worldwide community): the Commons preview and Decide fed Example Valley', async () => {
        node.features = GLOBAL;
        await renderIn('xx');
        expect(host.querySelector('[data-testid="commons-preview"]')).not.toBeNull();
        expect(host.textContent).toContain(pseudoLocalise('Commons pool'));
        expect(host.textContent).toContain(pseudoLocalise('Pledge'));
        expect(bypassing(), 'Groups').toEqual([]);
        await click(byLabel(pseudoLocalise('Decide Section')), 'Decide');
        expect(host.querySelector('[data-testid="decide-preview"]')).not.toBeNull();
        expect(host.textContent).toContain(pseudoLocalise('Example Valley · an example member'));
        expect(host.textContent).toContain(pseudoLocalise('👍 Vote YES'));
        expect(host.textContent).toContain(pseudoLocalise('Secret ballot: members see the totals, never who voted how.'));
        expect(bypassing(), 'Decide').toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        await renderIn('en');
        expect(bracketed()).toBe(0);
        await toGroups('en');
        for (const english of ['Commons', 'Community decisions, the Commons, and your groups: projects, enterprises and more. Propose binding actions and vote on what matters.',
            'COMMONS POOL', 'VOICE CREDITS', 'For money votes · from completed trades · N votes cost N×N', 'Decide', 'Groups', 'YOUR GROUPS', 'GROUPS YOU COULD JOIN',
            '🏷️ working group · 4 members · request to join', 'Join policy: request to join', 'View Details →', 'INVITED', 'OBSERVER', '1 keeper',
            'Paused for season · 2 keepers', '10 days left', 'Expired', 'Goal: 300 🫘', 'No description provided.']) {
            expect(host.textContent, english).toContain(english);
        }
        await click(byLabel('Decide Section'), 'Decide');
        for (const english of ['TOUCHES: MEMBER', 'Remove Member', "Dave's balance is −20 beans. Removing them charges that 20 to the Commons pool, which currently holds 500.",
            "Balances are private: only the members who can vote in this see Mia's balance and any debt. The Commons pool holds 1235 beans.",
            'Kofi has no debt. Removing them charges nothing to the Commons pool, which currently holds 1235.', 'Turnout: 4 of 6 votes needed', 'Pending', 'Turnout: 4 of 3 votes needed', 'Met ✅',
            '30% of 4 members active in the last 30 days (at least 3)', 'Tally: Yes 3 (75%) · No 1', 'Needs 50%', 'Votes: 3 (Cost: 9 credits)',
            'You have 16 voice credits: up to 4 votes on this Decision.', 'You voted No (3 votes)', 'Change to Yes', 'Voted No', 'You voted Yes',
            'An admin suspended Ana on 3 Oct 2026. Keep the suspension?', '🔒 Secret ballot: members see the totals, never who voted how.', '3 days left', 'Closing now',
            'Reach The Moon', 'TOUCHES: SKY', 'Keep Suspension?', 'Grant Enterprise', 'Quadratic', '1m1v', 'Vote YES', 'Vote NO',
            'An admin paused Ola on 22 Oct 2026.', 'Yes removes Ola after 7 days. No brings Ola back as soon as the vote closes.',
            "Abe holds a role that runs this community's server, and no community vote removes an owner or admin: whatever this vote decides, Abe is back when it closes."]) {
            expect(host.textContent, english).toContain(english);
        }
        expect(host.textContent).not.toContain('An admin paused Mia');
        expect(host.textContent).toMatch(/\d+m left/);
        expect(host.textContent).toMatch(/\d+h left/);
        await click(byLabel('Decisions History'), 'History');
        for (const english of ['EXECUTION PENDING GRACE', 'In 7-day Grace Period: Scheduled for removal on 25 Oct 2026', 'Turnout: 4 of 6 votes needed (Unmet)',
            'Yes: 3 (75%) · No: 1', 'Halted by an admin — Reason: Duplicate of last week', 'Provenance: system:decision:77777777 · Credit floor set to 0',
            'Authorised by: Community Vote (system:decision:77777777)', 'Void: Subject does not exist or was pruned', 'AUTHORISATION & PROVENANCE']) {
            expect(host.textContent, english).toContain(english);
        }
    });
});

describe('the start-a-project form and the new-poll form in the pseudo-locale', () => {
    it('Start an Enterprise / Project: every field, the missing-fields line, a deadline picked, the answer', async () => {
        await renderIn('xx', createElement(ProposeProjectScreen));
        expect(host.textContent).toContain(inCapitalsOf(pseudoLocalise('Start an Enterprise / Project')));
        expect(host.textContent).toContain(pseudoLocalise('FUNDING GOAL ({currency}) *').split('{currency}')[0]);
        expect(bypassing(), 'form').toEqual([]);
        // The missing-fields line hides itself 3 s later on a bare timer in propose-project.tsx, run here on a fake clock so it
        // never outlives the test: left running, it can fire after the file's jsdom is gone ("window is not defined").
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const start = byLabel(pseudoLocalise('Start initiative'));
        expect(start, 'Start').toBeTruthy();
        await act(async () => { (start as HTMLElement).click(); });
        expect(host.textContent).toContain(pseudoLocalise('⚠️ Please complete all required fields'));
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        vi.useRealTimers();
        expect(host.textContent).not.toContain(pseudoLocalise('⚠️ Please complete all required fields'));
        picked.date = new Date(2026, 10, 30, 12);
        await click(byLabel(pseudoLocalise('Select funding deadline date')), 'the deadline');
        expect(host.textContent).toContain(pseudoLocalise('30 Nov 2026'));
        expect(host.textContent).toContain(pseudoLocalise('Clear deadline'));
        await type(byPlaceholder('e.g. Community Tool Shed'), 'Tool shed');
        await type(host.querySelector('input[aria-label="' + pseudoLocalise('Purpose statement') + '"]'), 'Lend tools');
        await type(host.querySelector('input[placeholder="0"]'), '120');
        await click(byLabel(pseudoLocalise('Start initiative')), 'Start');
        expect(alerts.said).toContain(pseudoLocalise('Initiative Started 🌱'));
        await click(button('🏛️ Enterprise'), 'Enterprise');
        OTHERS.push('Tool shed', 'Lend tools');
        expect(bypassing(), 'answers').toEqual([]);
        OTHERS.splice(OTHERS.length - 2, 2);
    });

    it('in English, the deadline reads as a day ("30 Nov 2026"), not its UTC date', async () => {
        picked.date = new Date(2026, 10, 30, 0, 30);
        await renderIn('en', createElement(ProposeProjectScreen));
        await click(byLabel('Select funding deadline date'), 'the deadline');
        expect(host.textContent).toContain('30 Nov 2026');
        expect(byLabel('Funding deadline: 30 Nov 2026')).not.toBeNull();
        expect(host.textContent).toContain('START AN ENTERPRISE / PROJECT');
    });

    it('New Community Poll: the fields, options, durations, open vote, the placeless note, its questions', async () => {
        node.area = null;
        await renderIn('xx', createElement(NewPollModal, { visible: true, onClose() {} }));
        expect(host.textContent).toContain(pseudoLocalise('New Community Poll'));
        expect(host.querySelector('[data-testid="poll-placeless-note"]')?.textContent).toContain(pseudoLocalise("You haven't set your area, so members nearby won't see this poll in their list; they can still find it by searching. Set it in Settings → Your area to show it near you."));
        expect(byPlaceholder('Option {n}'.replace('{n}', '1'))).toBeNull();
        expect(host.querySelector(`input[placeholder="${pseudoLocalise('Option {n}').replace('{n}', '2')}"]`)).not.toBeNull();
        expect(bypassing(), 'form').toEqual([]);
        await click(byLabel(pseudoLocalise('Add another poll option')), 'Add Option');
        await click(byLabel(pseudoLocalise('Remove Option {n}').replace('{n}', '3')), 'Remove Option 3');
        await click(byLabel(pseudoLocalise('{n} Days duration').replace('{n}', '14')), '14 days');
        await click(byLabel(pseudoLocalise('Open vote: members see who chose what')), 'Open vote');
        expect(host.textContent).toContain(pseudoLocalise("Members will see who chose what. You can't change this once someone has voted."));
        await click(byLabel(pseudoLocalise('Create poll')), 'Create');
        expect(alerts.said).toContain(pseudoLocalise('Please enter a poll question.'));
        expect(bypassing(), 'answers').toEqual([]);
    });
});

// ── 320 dp with text at 1.3×: longer languages never push words past an edge (checked with the pseudo-locale) ─────────
const FLOOR = 320;
const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);
/** The longest word, without the pseudo-locale's brackets: they mark a sentence; its ~35 % pad models a longer language. */
const longestWord = (text: string) => text.split(/[\s\u200B]+/).map((w) => w.replace(/^\[+|\]+$/g, '')).reduce((a, b) => (widthOf(b, 1) > widthOf(a, 1) ? b : a), '');
const minScale = (span: Element) => Number(span.getAttribute('data-min-scale') ?? 1);

describe('the Commons at 320 dp with 1.3× text, in the pseudo-locale', () => {
    it('the Decide / Groups switch and the two stat cards: words shrink to fit their half', async () => {
        await renderIn('xx');
        // 16 dp list sides, an 8 / 10 dp gap, then each pill's 4 dp and each card's 12 dp padding.
        const pillHalf = (FLOOR - 32 - 8) / 2 - 8;
        for (const label of ['Decide Section', 'Groups Section']) {
            const span = byLabel(pseudoLocalise(label))!.querySelector('span[data-shrinks]')!;
            expect(span.getAttribute('data-lines'), label).toBe('1');
            expect(widthOf(span.textContent!, 13 * SCALE) * minScale(span), span.textContent!).toBeLessThanOrEqual(pillHalf);
        }
        const cardHalf = (FLOOR - 32 - 10) / 2 - 24;
        const labels = Array.from(host.querySelectorAll('span[data-font="11"][data-lines="2"]'));
        expect(labels.length).toBe(2);
        for (const span of labels) {
            expect(span.getAttribute('data-shrinks'), span.textContent!).toBe('true');
            expect(widthOf(longestWord(span.textContent!), 11 * SCALE) * minScale(span), span.textContent!).toBeLessThanOrEqual(cardHalf);
        }
    });

    it('a group card\'s join policy and View Details wrap; a project\'s "raised" and "Goal" wrap', async () => {
        await renderIn('xx');
        await toGroups();
        const details = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === pseudoLocalise('View Details →'))!;
        expect(details.parentElement!.getAttribute('data-wrap')).toBe('wrap');
        const policy = details.parentElement!.firstElementChild!;
        expect(policy.getAttribute('data-shrink')).toBe('1');
        expect(policy.getAttribute('data-lines')).toBe('2');
        const goal = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === pseudoLocalise('Goal: {amount} 🫘').replace('{amount}', '300'))!;
        expect(goal.parentElement!.getAttribute('data-wrap')).toBe('wrap');
    });

    it('Decide: Open Decisions / History shrink onto two lines in their half; History\'s filters wrap; the stepper\'s words give way', async () => {
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Decide Section')), 'Decide');
        // 16 dp sides, a 10 dp gap; each tab's 12 dp padding (the icon is above the words, the count in the corner).
        const half = (FLOOR - 32 - 10) / 2 - 24;
        for (const label of ['Open Decisions', 'Decisions History']) {
            const span = byLabel(pseudoLocalise(label))!.querySelector('span[data-shrinks]')!;
            expect(span.getAttribute('data-lines'), label).toBe('2');
            expect(span.getAttribute('data-shrink'), label).toBe('1');
            expect(widthOf(longestWord(span.textContent!), 13 * SCALE) * minScale(span), span.textContent!).toBeLessThanOrEqual(half);
        }
        const stepper = Array.from(host.querySelectorAll('span')).find((s) => (s.textContent ?? '').startsWith(pseudoLocalise('Votes: {count} (Cost: {n} credits)').slice(0, 5)))!;
        expect(stepper.getAttribute('data-shrink')).toBe('1');
        await click(byLabel(pseudoLocalise('Decisions History')), 'History');
        expect(button('Executed')!.parentElement!.getAttribute('data-wrap')).toBe('wrap');
    });

    it('the poll form: Cancel and Create shrink to one line, the title to two, and all three fit across; the options row wraps', async () => {
        await renderIn('xx', createElement(NewPollModal, { visible: true, onClose() {} }));
        const cancel = byLabel(pseudoLocalise('Cancel'))!.querySelector('span')!;
        const create = byLabel(pseudoLocalise('Create poll'))!.querySelector('span')!;
        const title = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === pseudoLocalise('New Community Poll'))!;
        for (const s of [cancel, create]) {
            expect(s.getAttribute('data-shrinks')).toBe('true');
            expect(s.getAttribute('data-lines')).toBe('1');
        }
        expect(title.getAttribute('data-lines')).toBe('2');
        // 16 dp sides and two 8 dp gaps; Cancel's 10 dp padding and Create's 16 dp, each side.
        const used = widthOf(longestWord(cancel.textContent!), 15 * SCALE) * minScale(cancel) + 20 + widthOf(longestWord(create.textContent!), 14 * SCALE) * minScale(create) + 32;
        expect(widthOf(longestWord(title.textContent!), 16 * SCALE) * minScale(title)).toBeLessThanOrEqual(FLOOR - 32 - 16 - used);
        expect(byLabel(pseudoLocalise('Add another poll option'))!.parentElement!.getAttribute('data-wrap')).toBe('wrap');
    });

    it('the form headers give way: the propose form\'s title and its two touches, the start-a-project header', async () => {
        node.decisions = [];
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Decide Section')), 'Decide');
        await click(button('+ Propose a Decision'), 'Propose');
        const title = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === pseudoLocalise('Propose a Community Decision'))!;
        expect(title.getAttribute('data-shrink')).toBe('1');
        for (const touch of ['Member', 'Commons Pool']) {
            const span = Array.from(button(touch)!.querySelectorAll('span')).find((s) => s.textContent === pseudoLocalise(touch))!;
            expect(span.getAttribute('data-shrink'), touch).toBe('1');
        }
        act(() => root.unmount());
        root = createRoot(host);
        await renderIn('xx', createElement(ProposeProjectScreen));
        const header = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === inCapitalsOf(pseudoLocalise('Start an Enterprise / Project')))!;
        expect(header.getAttribute('data-shrink')).toBe('1');
    });

    it('labels in capitals carry them in their words: none is upper-cased by the phone', async () => {
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('About the Commons Pool')), 'info');
        await click(byLabel(pseudoLocalise('Decide Section')), 'Decide');
        await click(button('+ Propose a Decision'), 'Propose');
        const transformed = Array.from(host.querySelectorAll('[data-transform]')).map((e) => e.textContent);
        expect(transformed).toEqual([]);
    });
});

describe('the Commons follows a language picked on the phone', () => {
    const NATIVE_WORDS = path.resolve(__dirname, '../../words');
    const fr = JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, 'fr.json'), 'utf8')) as Record<string, unknown>;
    const MENU = { menuBtn: {}, menuIconWrap: {}, menuIcon: {}, menuText: {}, menuSub: {}, menuChevron: {} };

    it('a pick redraws it in the new language, with nothing by hand; members\' words stay as written', async () => {
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(LanguageRow as any, { styles: MENU }), createElement(ProjectsScreen))) as any);
        });
        await settle();
        await toGroups('en');
        expect(host.textContent).toContain('No description provided.');
        await click(host.querySelector('[data-testid="settings-language"]'), 'Settings → Language');
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        await settle();
        // The whole app is drawn again in the new language, so the tab opens on its first section again.
        await click(byLabel(typeof fr['Groups Section'] === 'string' ? fr['Groups Section'] as string : 'Groups Section'), 'Groups');
        expect(typeof fr['No description provided.']).toBe('string');
        expect(host.textContent).toContain(fr['No description provided.'] as string);
        expect(host.textContent).not.toContain('No description provided.');
        expect(host.textContent).toContain('Garden Crew');
        expect(host.textContent).toContain('We grow food on the corner lot');
    });
});
