// @vitest-environment jsdom
/**
 * The Ledger tab and its info sheets in the member's language (words slice S3, sweep B8): app/(tabs)/ledger.tsx rendered
 * for real inside the real LanguageProvider, with what only the Ledger draws drawn for real too: the frozen card's and
 * the bar's lines (utils/credit-line-card.ts), the rows' holds and dates, Example Valley's rows in preview, and every
 * sheet it opens (Trust & Reputation, Credit Slider Info, Available Balance, System Circulation) with their frame
 * (components/InfoModal.tsx). The sheets nothing on the Ledger opens (Pricing & Fees, My Deals & Trust Hold, Invites &
 * Vouching) are rendered on their own. React Native's host components are plain tags carrying their accessibility props,
 * placeholders and the layout props the 320 dp checks read; the node client answers a member's ledger.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label,
 * placeholder or alert with letters outside a bracket bypassed t(). What members and the node wrote is shown as written:
 * names, a pledge's project, a listing's title, a memo, a node's refusal, keys; and Example Valley's own words in
 * preview (core's SAMPLE_COMMUNITY, the showcase's sweep).
 *
 * Components the Ledger shares with other screens, or whose words live elsewhere, are drawn as stand-ins (their sweeps
 * are the screens they share): CreditBar, RepaymentCard (REPAYMENT_COPY, shared with Pay the Commons), CommonsInfoModal,
 * the showcase's LocalCommunityMark / ExampleHeader / LocalCommunitySheet (the marker's stand-in draws the label the
 * Ledger hands it, so that label is checked), MemberAvatar, TrustBadge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, Fragment, useEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(6).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        const s = flat(props.style);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        attrs['data-style'] = JSON.stringify(s);
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
        TouchableOpacity: el('button'), TouchableWithoutFeedback: el('button'), SafeAreaView: el('div'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                for (const b of buttons ?? []) { if (b.text) alerts.said.push(b.text); alerts.buttons.push(b); }
            },
        },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {} },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => ({}),
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
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', EncodingType: { UTF8: 'utf8' }, writeAsStringAsync: async () => {} }));
vi.mock('expo-sharing', () => ({ shareAsync: async () => {} }));
vi.mock('../haptics', () => ({ hapticSuccess() {}, hapticWarning() {} }));
const blocked = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => blocked.keys, BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
// One identity object for the whole run, as the app's context keeps it: a new one each render would reload the tab forever.
const me = vi.hoisted(() => ({ identity: { publicKey: 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12', callsign: 'Ana' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => me }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}),
    signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));

// Shared with other screens, or with words that live elsewhere: drawn as stand-ins (see the note above).
vi.mock('../../components/CreditBar', () => ({ CreditBar: () => createElement('span', { 'data-later-sweep': 'CreditBar' }) }));
vi.mock('../../components/RepaymentCard', () => ({ RepaymentCard: () => createElement('span', { 'data-later-sweep': 'RepaymentCard' }) }));
vi.mock('../../components/CommonsInfoModal', () => ({ CommonsInfoModal: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({
    LocalCommunityMark: ({ label }: { label?: string }) => createElement('button', { 'data-later-sweep': 'LocalCommunityMark' }, label ?? null),
    LocalCommunitySheet: () => null,
    ExampleHeader: () => null,
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/TrustBadge', () => ({ TrustBadge: ({ level }: { level: string }) => createElement('span', { 'data-badge': level }) }));

import { BLOCKED_BEANS_NOTE, CIRCULATION_FREE_BEANS, PROTOCOL_CONSTANTS, SAMPLE_COMMUNITY, TIER_LEVELS, formatNumber, pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { DrawnInLanguage, LanguageProvider } from '../../components/LanguageProvider';
import { LanguageRow } from '../../components/LanguagePicker';
import { PricingInfoModal } from '../../components/info-content/PricingInfoModal';
import { DealsInfoModal } from '../../components/info-content/DealsInfoModal';
import { InviteInfoModal } from '../../components/info-content/InviteInfoModal';
import { KNOWN_FROZEN, frozenDebitLine } from '../credit-line-card';
import LedgerScreen from '../../app/(tabs)/ledger';

const NODE = 'https://mullum.example';
const OFFER_ID = '123e4567-e89b-12d3-a456-426614174000';
const DAY = Date.UTC(2026, 9, 3, 12);

/** A Resident with 1200 Beans: spending paused below what one live offer unlocks, the known part of the line frozen. */
const RESIDENT = {
    balance: 1200, floor: -200, usableFloor: -150, liveOffers: 1, activated: true, frozen: true, creditFrozen: false, knownFrozen: true, knownGrant: 50,
    tier: { name: 'Resident', emoji: '🏠' }, tierCredit: 200, earnedCredit: 150, qualifiedValue: 300, avgRating: 4.5, reviewCount: 3, commons: 12.5,
    trustStats: { uniquePartners: 4 },
};
/** The rows getTransactions answers: holds (to, from, no title), a project, Beans from someone blocked, an offer link. */
const ROWS = [
    { id: 't1', type: 'debit', amount: 30, peer: 'Held in Trust: Fix the gate (to Mia)', held: { title: 'Fix the gate', counterparty: 'Mia', toCounterparty: true }, projectWallet: false, peerPubkey: 'escrow_1', memo: 'Fresh eggs', timestamp: '03/10/2026', at: DAY },
    { id: 't2', type: 'credit', amount: 12, peer: 'Held in Trust: Bike repair (from Mia)', held: { title: 'Bike repair', counterparty: 'Mia', toCounterparty: false }, projectWallet: false, peerPubkey: 'escrow_2', memo: '', timestamp: '03/10/2026', at: DAY },
    { id: 't3', type: 'debit', amount: 5, peer: 'Held in Trust', held: { title: null, counterparty: null, toCounterparty: false }, projectWallet: false, peerPubkey: 'escrow_3', memo: '', timestamp: '03/10/2026', at: DAY },
    { id: 't4', type: 'debit', amount: 25, peer: 'Project Wallet', held: null, projectWallet: true, peerPubkey: 'project_9', memo: 'Community garden', timestamp: '03/10/2026', at: DAY },
    { id: 't5', type: 'credit', amount: 7, peer: 'Rex', held: null, projectWallet: false, peerPubkey: 'rex-key', memo: 'a note Ana never sees', timestamp: '03/10/2026', at: DAY },
    { id: 't6', type: 'credit', amount: 40, peer: 'Mia', held: null, projectWallet: false, peerPubkey: 'mia-key', memo: `Paid for ${OFFER_ID} thanks`, timestamp: '03/10/2026', at: DAY },
];
const MEMBERS = [{ publicKey: 'mia-key', callsign: 'Mia' }];
const PLEDGES = [{ id: 'p1', projectTitle: 'Community garden', timestamp: DAY, amount: 25 }];

const ledger = vi.hoisted(() => ({ balance: null as any, rows: [] as any[], escrow: 0, send: null as null | (() => Promise<unknown>) }));

/** What members and the node wrote, and keys: shown as written. */
const OTHERS = [
    'Ana', 'Mia', 'Rex', 'Fix the gate', 'Bike repair', 'Community garden', 'Fresh eggs', 'Paid for', 'thanks', 'mia-key', 'Not allowed here',
].sort((a, b) => b.length - a.length);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons.length = 0;
    net.calls.length = 0;
    blocked.keys = ['rex-key'];
    ledger.balance = RESIDENT;
    ledger.rows = ROWS;
    ledger.escrow = 15;
    ledger.send = null;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    rememberProfile('local', { beans: true, showcase: false });
    net.answer = (name) => {
        if (name === 'getBalance') return Promise.resolve(ledger.balance);
        if (name === 'getTransactions') return Promise.resolve(ledger.rows);
        if (name === 'getMemberProfile') return Promise.resolve({ avatar_url: null });
        if (name === 'getAllCommunityMembers') return Promise.resolve(MEMBERS);
        if (name === 'getEscrowTotal') return Promise.resolve(ledger.escrow);
        if (name === 'getPledgeHistory') return Promise.resolve(PLEDGES);
        if (name === 'sendTransfer') return ledger.send?.() ?? Promise.resolve({});
        return undefined;
    };
    globalThis.fetch = vi.fn(async () => new Response('not json', { status: 500 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

/** The phone's copy of the node's profile, heard just now, so the screen knows its mode without asking. */
function rememberProfile(profile: 'global' | 'local', features: Record<string, boolean>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, screen: ReactElement = createElement(LedgerScreen)) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, screen) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
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
const xx = (english: string) => pseudoLocalise(english);
/** The button whose words include `english` in the pseudo-locale. */
const row = (english: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(xx(english))) ?? null;
const byLabel = (label: string) => host.querySelector(`[aria-label="${label.replace(/"/g, '\\"')}"]`);
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const byPlaceholder = (english: string) => host.querySelector(`[placeholder="${xx(english).replace(/"/g, '\\"')}"]`);
const text = () => host.textContent ?? '';
const styleOf = (el: Element | null | undefined) => JSON.parse(el?.getAttribute('data-style') || '{}');
/** The span whose own words are exactly `shown`. */
const spanSaying = (shown: string) => Array.from(host.querySelectorAll('span')).find((s) => s.textContent === shown) ?? null;

/** Text with letters outside a pseudo-locale bracket, once what others wrote is taken out. */
function outsideBrackets(value: string | null | undefined, others: readonly string[] = OTHERS): boolean {
    if (!value) return false;
    let rest = value;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const o of others) rest = rest.split(o).join('');
    return /\p{L}/u.test(rest);
}
/** A text node's whole sentence: its outermost span (a sentence's bold runs are spans inside it). */
function sentenceOf(n: Node): string {
    let el = n.parentElement;
    while (el?.parentElement?.tagName === 'SPAN') el = el.parentElement;
    return el?.textContent ?? n.nodeValue ?? '';
}
/** Every drawn text, label, placeholder and alert that bypassed t(). */
function bypassing(others: readonly string[] = OTHERS): string[] {
    const out = new Set<string>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const whole = sentenceOf(n);
        if (outsideBrackets(whole, others)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const [attr, kind] of [['aria-label', 'label'], ['placeholder', 'placeholder']] as const) {
        for (const e of Array.from(host.querySelectorAll(`[${attr}]`))) {
            const v = e.getAttribute(attr);
            if (outsideBrackets(v, others)) out.add(`${kind}: ${JSON.stringify(v)}`);
        }
    }
    for (const said of alerts.said) if (outsideBrackets(said, others)) out.add(`alert: ${JSON.stringify(said)}`);
    return [...out];
}
const bracketed = () => Array.from(host.querySelectorAll('span')).filter((s) => /^\[.*\]$/su.test(s.textContent ?? '')).length;

describe('the Ledger in the pseudo-locale: every word on it came through t() (words S3i)', () => {
    it('Levels: the standing hero, the quick actions, every level on the shelf and its card, the way to the next level, what builds trust', async () => {
        await renderIn('xx');
        expect(text()).toContain(xx('YOUR TRUST LEVEL'));
        expect(text()).toContain(xx('Resident'));
        expect(text()).toContain(xx('Level {level} of {levels} · {n} trust').replace('{level}', '2').replace('{levels}', '4').replace('{n}', '200'));
        expect(text()).toContain(xx('Send Beans'));
        expect(text()).toContain(xx('Invite Members'));
        expect(text()).toContain(xx("You've traded real value with the community. Your credit line deepens with every trade — the more value you exchange, the deeper it grows."));
        expect(text()).toContain(xx('WHAT BUILDS YOUR TRUST'));
        expect(byTestId('page-title-ledger')?.textContent ?? text()).toContain(xx('Ledger'));
        expect(bracketed()).toBeGreaterThan(30);
        expect(bypassing(), 'Resident, the own level').toEqual([]);
        for (const tier of ['Newcomer', 'Steward', 'Elder']) {
            const shelf = Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === null && (b.textContent ?? '').startsWith(xx(tier)));
            await click(shelf, tier);
            expect(bypassing(), tier).toEqual([]);
        }
        // Steward, the next level: how far to go, in words.
        await click(Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').startsWith(xx('Steward'))), 'Steward');
        expect(text()).toContain(xx('Next level'));
        expect(text()).toContain(xx('Reach {min} trust ({left} to go) from the real value you trade.').replace('{min}', '600').replace('{left}', '400'));
    });

    it('the credit card: the bar\'s label, the known part frozen, spending paused; Credit Slider Info with its three tabs', async () => {
        await renderIn('xx');
        expect(host.querySelector('[data-later-sweep="CreditBar"]')).not.toBeNull();
        expect(text()).toContain(xx(KNOWN_FROZEN.part));
        expect(text()).toContain(xx('⚠️  Spending paused — your balance is below what your {n} active offer unlock (−{limit}). Post an Offer or trade back up to lift it. You can still receive and sell.').replace('{n}', '1').replace('{limit}', '150'));
        expect(bypassing(), 'the card').toEqual([]);
        await click(byLabel(xx('Credit position — tap to learn how it works')), 'the credit position');
        expect(text()).toContain(xx('Credit Slider Info'));
        expect(text()).toContain(xx('Zero is the Sweet Spot'));
        expect(bypassing(), 'Credit Slider').toEqual([]);
        await click(row('Overdraft Floors'), 'Overdraft Floors');
        expect(text()).toContain(xx('~{amount}B traded').replace('{amount}', '10000'));
        expect(bypassing(), 'Overdraft Floors').toEqual([]);
        await click(row('Idle Balance Tiers'), 'Idle Balance Tiers');
        expect(text()).toContain(xx('{rate}% (Fee-Free Zone)').replace('{rate}', '0.0'));
        expect(text()).toContain(xx('{low} – {high}B').replace('{low}', '1000').replace('{high}', '2000'));
        expect(bypassing(), 'Idle Balance Tiers').toEqual([]);
        expect(byLabel(xx('Close'))).not.toBeNull();
    });

    it('Trust & Reputation: the trust formula and the tiers, every number in place', async () => {
        await renderIn('xx');
        await click(byLabel(xx('How trust works')), 'How trust works');
        expect(text()).toContain(xx('Trust & Reputation'));
        expect(text()).toContain(xx('2. REPUTATION MULTIPLIER'));
        expect(text()).toContain(xx('**{n} stars** = **{share}%** of score').replace('{n}', '5.0').replace('{share}', '100').replace(/\*\*/g, ''));
        expect(text()).toContain(xx('**{n} star** = **{share}%** of score').replace('{n}', '1.0').replace('{share}', '60').replace(/\*\*/g, ''));
        expect(bypassing(), 'Trust Formula').toEqual([]);
        await click(row('Tiers & Perks'), 'Tiers & Perks');
        expect(text()).toContain(xx('OPEN TO EVERYONE — NO TIER REQUIRED'));
        // The node's own table, never a copy: Elder's floor and the cap.
        const { CREDIT_BASE_FLOOR, CREDIT_FLOOR_CAP } = PROTOCOL_CONSTANTS;
        expect(text()).toContain(xx('Reached when your credit floor reaches **{floor}B** (max **{max}B**)')
            .replace('{floor}', String(CREDIT_BASE_FLOOR - TIER_LEVELS[3].minCredit)).replace('{max}', String(CREDIT_BASE_FLOOR - CREDIT_FLOOR_CAP)).replace(/\*\*/g, ''));
        expect(text()).toContain(xx('Reached when your credit floor reaches **{floor}B** (up to {upTo}B)')
            .replace('{floor}', String(CREDIT_BASE_FLOOR - TIER_LEVELS[1].minCredit)).replace('{upTo}', String(CREDIT_BASE_FLOOR - TIER_LEVELS[2].minCredit + 1)).replace(/\*\*/g, ''));
        expect(bypassing(), 'Tiers & Perks').toEqual([]);
    });

    it('the Wallet: the balance and its metrics, Community Circulation, pledges, every kind of row, Export when it fails', async () => {
        await renderIn('xx');
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        expect(text()).toContain(xx('YOUR BALANCE'));
        expect(text()).toContain(xx('IN ESCROW'));
        expect(text()).toContain(xx('⚠️ Balance above 1000 — consider spending!'));
        expect(text()).toContain(xx('-{amount} B').replace('{amount}', '25'));
        expect(text()).toContain(xx('Held in Trust: {title} (to {name})').replace('{title}', 'Fix the gate').replace('{name}', 'Mia'));
        expect(text()).toContain(xx('Held in Trust: {title} (from {name})').replace('{title}', 'Bike repair').replace('{name}', 'Mia'));
        expect(text()).toContain(xx('Project Wallet'));
        expect(text()).toContain(xx(BLOCKED_BEANS_NOTE));
        expect(text()).not.toContain('a note Ana never sees');
        expect(text()).toContain(xx('View Offer'));
        expect(text()).toContain('[3 Öçţ 2026~~~~]');
        expect(bypassing(), 'the Wallet').toEqual([]);
        await click(byLabel(xx('Export CSV')), 'Export CSV');
        expect(alerts.said).toContain(xx('Export Failed'));
        expect(alerts.said).toContain(xx('Export failed'));
        expect(bypassing(), 'Export failed').toEqual([]);
    });

    it('Send Beans: the form, the member picker, each refusal and the sent line', async () => {
        await renderIn('xx');
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        await click(byLabel(xx('Send Beans')), 'Send Beans');
        expect(byLabel(xx('Cancel'))).not.toBeNull();
        await click(row('Select recipient...'), 'Select recipient');
        await type(byPlaceholder('Search members...'), 'zz');
        expect(text()).toContain(xx('No members found'));
        expect(bypassing(), 'no one found').toEqual([]);
        await type(byPlaceholder('Search members...'), '');
        await click(Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').startsWith('Mia')), 'Mia');
        await type(byPlaceholder('Amount'), '5000');
        expect(text()).toContain(xx('Recipient receives:'));
        await click(row('Confirm Transfer'), 'Confirm Transfer');
        expect(text()).toContain(xx('You can only send beans you hold — your balance is {balance}B.').replace('{balance}', '1200.00'));
        await type(byPlaceholder('Amount'), 'abc');
        await click(row('Confirm Transfer'), 'Confirm Transfer');
        expect(text()).toContain(xx('Enter a valid amount'));
        await type(byPlaceholder('Amount'), '1.234');
        await click(row('Confirm Transfer'), 'Confirm Transfer');
        expect(text()).toContain(xx('The amount is a number of Beans above 0, to the cent.'));
        expect(bypassing(), 'refused').toEqual([]);
        await type(byPlaceholder('Amount'), '5');
        await click(row('Confirm Transfer'), 'Confirm Transfer');
        expect(text()).toContain(xx('✓ Sent!'));
        expect(bypassing(), 'sent').toEqual([]);
    });

    it('Available Balance and System Circulation, each tab', async () => {
        await renderIn('xx');
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        await click(byTestId('bean-sheet-open'), 'About your balance');
        expect(text()).toContain(xx('Available Balance'));
        expect(bypassing(), 'Your Balance').toEqual([]);
        await click(row('Floor Balance'), 'Floor Balance');
        expect(text()).toContain(xx('WHY A FLOOR?'));
        expect(bypassing(), 'Floor Balance').toEqual([]);
        await click(byLabel(xx('Close')), 'Close');
        await click(row('Community Circulation ⓘ'), 'Community Circulation');
        expect(text()).toContain(xx('System Circulation'));
        expect(bypassing(), 'the circulation fee').toEqual([]);
        await click(row('Debt Recovery'), 'Debt Recovery');
        expect(text()).toContain(xx('CLEARING YOUR DEBT'));
        expect(bypassing(), 'Debt Recovery').toEqual([]);
    });

    it('a member with no credit line and no trade yet: the starter card, the sends that wait for a first trade and their question, no rows yet', async () => {
        ledger.balance = { ...RESIDENT, balance: 0, floor: 0, usableFloor: 0, liveOffers: 0, activated: false, frozen: false, knownFrozen: false, tier: { name: 'Newcomer', emoji: '🌱' }, tierCredit: 0, earnedCredit: 0, qualifiedValue: 0, reviewCount: 0, avgRating: 0, commons: 0, trustStats: { uniquePartners: 0 } };
        ledger.rows = [];
        ledger.escrow = 0;
        await renderIn('xx');
        expect(text()).toContain(xx('No credit line yet'));
        expect(text()).toContain(xx('no reviews yet'));
        await click(row('Send (needs 1st trade)'), 'Send (needs 1st trade)');
        expect(alerts.said).toEqual([xx('First trade required'), xx('Direct sends are unlocked after your first completed trade on the Marketplace, and require a positive balance.'), xx('OK')]);
        expect(bypassing(), 'Levels').toEqual([]);
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        expect(text()).toContain(xx('Send Beans (needs 1 completed trade)'));
        expect(text()).toContain(xx('No transactions yet.'));
        expect(bypassing(), 'Wallet').toEqual([]);
    });

    it('a line the admins froze, in debit; the highest level; a send that needs Beans held', async () => {
        ledger.balance = { ...RESIDENT, balance: -40, creditFrozen: true, frozen: false, knownFrozen: false, tier: { name: 'Elder', emoji: '⛰️' }, tierCredit: 1500, earnedCredit: 900 };
        await renderIn('xx');
        expect(text()).toContain(xx(KNOWN_FROZEN.title));
        expect(text()).toContain(xx(KNOWN_FROZEN.body));
        expect(text()).toContain(xx('You are {n} Beans in debit. Selling or receiving Beans brings you back up, and once you are above zero you can spend what you hold.').replace('{n}', '40'));
        expect(text()).toContain(xx('✨ Highest level reached'));
        await click(row('Send (needs +ve balance)'), 'Send (needs +ve balance)');
        expect(alerts.said[0]).toBe(xx('Positive balance required'));
        expect(bypassing()).toEqual([]);
    });

    it('a phone that has lost its community: Send asks to connect first', async () => {
        await renderIn('xx');
        store.map.delete('beanpool_anchor_url');
        await click(row('Send Beans'), 'Send Beans');
        expect(alerts.said).toEqual([xx('Not Connected'), xx('Connect to a community first.'), xx('Cancel'), xx('Connect')]);
        expect(bypassing()).toEqual([]);
    });

    it('in preview: the marker\'s labels, and Example Valley\'s rows say who and when in the member\'s language', async () => {
        rememberProfile('global', { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true });
        // Example Valley's own words (core's SAMPLE_COMMUNITY) are the showcase's sweep.
        const sample = [SAMPLE_COMMUNITY.member, SAMPLE_COMMUNITY.name, ...SAMPLE_COMMUNITY.transactions.map((r) => r.what)].sort((a, b) => b.length - a.length);
        await renderIn('xx');
        expect(row('Send Beans')?.getAttribute('data-later-sweep')).toBe('LocalCommunityMark');
        expect(bypassing([...sample, ...OTHERS])).toEqual([]);
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        expect(text()).toContain(xx('yesterday'));
        expect(text()).toContain(xx('a neighbour'));
        expect(row('Export CSV')?.getAttribute('data-later-sweep')).toBe('LocalCommunityMark');
        expect(bypassing([...sample, ...OTHERS])).toEqual([]);
    });

    it('the sheets nothing on the Ledger opens: Pricing & Fees, My Deals & Trust Hold, Invites & Vouching', async () => {
        const sheets: Array<[ReactElement, string[]]> = [
            [createElement(PricingInfoModal, { isOpen: true, onClose() {} }), ['🔒 Transaction Fee']],
            [createElement(DealsInfoModal, { isOpen: true, onClose() {} }), ['⚖️ Disputes', '⭐ Reviews']],
            [createElement(InviteInfoModal, { isOpen: true, onClose() {} }), ['🤝 Vouching']],
        ];
        for (const [sheet, tabs] of sheets) {
            await renderIn('xx', sheet);
            expect(bypassing(['auth_signer']), 'first tab').toEqual([]);
            for (const tab of tabs) {
                await click(row(tab), tab);
                expect(bypassing(['auth_signer']), tab).toEqual([]);
            }
        }
        expect(text()).toContain(xx('They create an account and join as a **{tier}**').replace('{tier}', xx('Newcomer')).replace(/\*\*/g, ''));
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        await renderIn('en');
        expect(bracketed()).toBe(0);
        for (const english of ['YOUR TRUST LEVEL', 'Resident', 'Level 2 of 4 · 200 trust', '400 more trust to 🏛️ Steward', 'Send Beans', 'Invite Members', 'ALL LEVELS',
            "You're here", '600 trust', 'Your current floor', 'Credit floor deepens with the value you trade', 'Invite others to join', '🚀 Reach 🏛️ Steward', 'Trust Manual', '400 trust to go',
            'beans of value to trade', 'THE LEVER', 'new partners (roughly)', 'WHAT BUILDS YOUR TRUST', 'VALUE TRADED', '+150 trust', '3 reviews', 'diverse = faster', 'BEANS', 'Levels', 'Wallet',
            KNOWN_FROZEN.part, '⚠️  Spending paused — your balance is below what your 1 active offer unlock (−150). Post an Offer or trade back up to lift it. You can still receive and sell.']) {
            expect(text(), english).toContain(english);
        }
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        for (const english of ['YOUR BALANCE', '≈ 30.0 hrs of value · Floor -200', 'COMMONS ⓘ', 'CREDIT FLOOR', 'IN ESCROW', 'Community Circulation ⓘ', 'per month → commons pool',
            'PROJECT PLEDGES', '-25 B', '3 Oct 2026', 'RECENT TRANSACTIONS', 'Export CSV', 'Held in Trust: Fix the gate (to Mia)', 'Held in Trust: Bike repair (from Mia)',
            'Held in Trust', 'Project Wallet', BLOCKED_BEANS_NOTE, 'View Offer', '+1200.0']) {
            expect(text(), english).toContain(english);
        }
        expect(text()).toMatch(/\d{1,2} [A-Z][a-z]{2} · \d+d/);
        expect(byLabel('About your balance')).not.toBeNull();
        expect(byLabel('Send Beans')).not.toBeNull();
    });
});

describe('the lines the Ledger takes from utils/credit-line-card.ts, in English exactly as before', () => {
    it('the frozen card and the debit line', () => {
        expect(KNOWN_FROZEN.title).toBe('Your credit line is frozen');
        expect(frozenDebitLine(-400)).toBe('You are 400 Beans in debit. Selling or receiving Beans brings you back up, and once you are above zero you can spend what you hold.');
        expect(frozenDebitLine(-12.34)).toMatch(/^You are 12\.4 Beans in debit\./);
        setLanguage('xx');
        expect(frozenDebitLine(-12.34)).toBe(xx('You are {n} Beans in debit. Selling or receiving Beans brings you back up, and once you are above zero you can spend what you hold.').replace('{n}', '12.4'));
        setLanguage('en');
    });
});

// ── 320 dp with text at 1.3×: longer languages never push words past an edge (checked with the pseudo-locale) ─────────
const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (value: string, px: number) => Array.from(value).reduce((w, c) => w + glyphEm(c) * px, 0);
/** The longest word, without the pseudo-locale's brackets: they mark a sentence; its ~35 % pad models a longer language. */
const longestWord = (value: string) => value.split(/[\s\u200B]+/).map((w) => w.replace(/^\[+|\]+$/g, '')).reduce((a, b) => (widthOf(b, 1) > widthOf(a, 1) ? b : a), '');

describe('the Ledger at 320 dp with 1.3× text, in the pseudo-locale', () => {
    /** Words held to `lines` lines in a column `width` wide: each word fits at the smallest size, and the whole fits the lines. */
    function fitsShrinking(span: Element, width: number, lines: number) {
        const words = span.textContent ?? '';
        expect(span.getAttribute('data-lines'), words).toBe(String(lines));
        expect(span.getAttribute('data-shrinks'), words).toBe('true');
        const px = Number(span.getAttribute('data-font')) * SCALE * Number(span.getAttribute('data-min-scale'));
        expect(widthOf(longestWord(words), px), longestWord(words)).toBeLessThanOrEqual(width);
        expect(widthOf(words, px), words).toBeLessThanOrEqual(lines * width * 0.9);
    }

    it('the shelf\'s four states, the three achievement labels and the two path labels take a second line and shrink, never cut short', async () => {
        await renderIn('xx');
        // 320 - 2 × 16 (the page) - 3 × 8 (the gaps), a quarter, less 2 × 2 (an item's padding).
        const quarter = (320 - 32 - 24) / 4 - 4;
        const states = [xx("You're here"), xx('Reached'), xx('{n} trust').replace('{n}', '600'), xx('{n} trust').replace('{n}', '1400')].map(spanSaying);
        for (const s of states) fitsShrinking(s!, quarter, 2);
        // 320 - 2 × 16 - 2 × 10 (the gaps), a third, less 2 × 12 (a card's padding).
        const third = (320 - 32 - 20) / 3 - 24;
        for (const label of ['VALUE TRADED', 'PARTNERS', 'RATING']) fitsShrinking(spanSaying(xx(label))!, third, 2);
        // 320 - 2 × 16 - 2 × 16 (the card's padding), a half.
        const half = (320 - 32 - 32) / 2;
        for (const label of ['beans of value to trade', 'new partners (roughly)']) fitsShrinking(spanSaying(xx(label))!, half, 2);
    });

    it('the rows that hold words side by side let them wrap rather than run past the edge', async () => {
        await renderIn('xx');
        // Levels: the quick-action pills wrap their words inside the pill; the path card's header shares its row.
        for (const words of ['Send Beans', 'Invite Members']) {
            const span = spanSaying(xx(words))!;
            expect(styleOf(span).flexShrink, words).toBe(1);
            expect(styleOf(span.parentElement).maxWidth, words).toBe('100%');
        }
        expect(styleOf(spanSaying(xx('🚀 Reach {emoji} {tier}').replace('{emoji}', '🏛️').replace('{tier}', xx('Steward')))).flexShrink).toBe(1);
        expect(styleOf(spanSaying(xx('Trust Manual'))).flexShrink).toBe(1);
        // Wallet: Community Circulation's two rows, the transactions heading beside Export, Send Beans, Recipient receives.
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        expect(styleOf(spanSaying(xx('Community Circulation ⓘ'))).flexShrink).toBe(1);
        expect(styleOf(spanSaying(xx('Community Circulation ⓘ'))!.parentElement).flexShrink).toBe(1);
        expect(styleOf(spanSaying(xx('per month → commons pool'))).flexShrink).toBe(1);
        expect(styleOf(spanSaying(xx('RECENT TRANSACTIONS'))).flexShrink).toBe(1);
        await click(byLabel(xx('Send Beans')), 'Send Beans');
        expect(styleOf(spanSaying(xx('Cancel'))).flexShrink).toBe(1);
        await click(row('Select recipient...'), 'Select recipient');
        await click(Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').startsWith('Mia')), 'Mia');
        await type(byPlaceholder('Amount'), '5');
        expect(styleOf(spanSaying(xx('Recipient receives:'))).flexShrink).toBe(1);
        // A sheet's title wraps beside its close button; its bracket rows wrap on their own side.
        await click(byTestId('bean-sheet-open'), 'About your balance');
        const title = spanSaying(xx('Available Balance'))!;
        expect(styleOf(title).flexShrink).toBe(1);
        expect(styleOf(title.parentElement).flexShrink).toBe(1);
    });

    it('the Credit Slider\'s bracket rows wrap each side, the rate kept to the right', async () => {
        await renderIn('xx');
        await click(byLabel(xx('Credit position — tap to learn how it works')), 'the credit position');
        await click(row('Idle Balance Tiers'), 'Idle Balance Tiers');
        const rate = spanSaying(xx('{rate}% (Fee-Free Zone)').replace('{rate}', '0.0'))!;
        expect(styleOf(rate)).toMatchObject({ flexShrink: 1, textAlign: 'right' });
        expect(styleOf(rate.previousElementSibling)).toMatchObject({ flexShrink: 1 });
    });

    it('labels in capitals carry their own capitals: none is upper-cased by the phone', async () => {
        await renderIn('xx');
        const levels = Array.from(host.querySelectorAll('span')).filter((s) => styleOf(s).textTransform);
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        const wallet = Array.from(host.querySelectorAll('span')).filter((s) => styleOf(s).textTransform);
        expect([...levels, ...wallet].map((s) => s.textContent)).toEqual([]);
        for (const label of ['YOUR BALANCE', 'COMMONS ⓘ', 'CREDIT FLOOR', 'IN ESCROW', 'RECENT TRANSACTIONS']) expect(text(), label).toContain(xx(label));
    });
});

describe('the Ledger follows a language picked in Settings', () => {
    const NATIVE_WORDS = path.resolve(__dirname, '../../words');
    const fr = JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, 'fr.json'), 'utf8')) as Record<string, string>;
    const MENU = { menuBtn: {}, menuIconWrap: {}, menuIcon: {}, menuText: {}, menuSub: {}, menuChevron: {} };

    it('a pick redraws it in the new language: the tier, Send Beans, the Commons line, with nothing by hand', async () => {
        ledger.balance = { ...RESIDENT, balance: 150, frozen: false };
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(LanguageRow as any, { styles: MENU }), createElement(LedgerScreen))) as any);
        });
        await settle();
        expect(text()).toContain('Resident');
        expect(text()).toContain('Send Beans');
        await click(byTestId('settings-language'), 'Settings → Language');
        await click(byTestId('language-fr'), 'Français');
        await settle();
        expect(fr['Send Beans']).toBeTruthy();
        expect(fr['Resident\u0004trust tier']).toBeTruthy();
        expect(text()).toContain(fr['Send Beans']);
        expect(text()).toContain(fr['Resident\u0004trust tier']);
        expect(text()).not.toContain('Send Beans');
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        expect(text()).toContain(fr['Nothing goes to the Commons while you hold {free} Beans or less.'].replace('{free}', String(CIRCULATION_FREE_BEANS)));
        expect(text()).toContain('Ana');
    });
});

describe('Send Beans reads the amount in the member\'s language (#2202)', () => {
    const fr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words/fr.json'), 'utf8')) as Record<string, string>;
    /** A sentence as the screen draws it in `lang`: its translation, or the English while it has none (drafts come later). */
    const said = (lang: 'en' | 'fr', english: string) => (lang === 'fr' && fr[english]) || english;

    /** Opens Send Beans in `lang`, picks Mia, types `amount`; returns what sendTransfer was handed. */
    async function sendIn(lang: 'en' | 'fr', amount: string, confirm = true) {
        const sent: unknown[][] = [];
        const answer = net.answer!;
        net.answer = (name, args) => { if (name === 'sendTransfer') sent.push(args); return answer(name, args); };
        await renderIn(lang);
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        await click(byLabel(said(lang, 'Send Beans')), 'Send Beans');
        await click(Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(said(lang, 'Select recipient...'))), 'Select recipient');
        await click(Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').startsWith('Mia')), 'Mia');
        await type(byLabel(said(lang, 'Amount to send')), amount);
        const receives = Array.from(host.querySelectorAll('span')).find((el) => el.textContent === said(lang, 'Recipient receives:'))?.parentElement?.textContent ?? null;
        if (confirm) await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === said(lang, 'Confirm Transfer')), 'Confirm Transfer');
        return { sent, receives };
    }

    it('fr "12,5": the confirmation reads 12,50 and 12.5 Beans are sent, never the 12 parseFloat read', async () => {
        const { sent, receives } = await sendIn('fr', '12,5');
        expect(receives).toContain('12,50');
        expect(sent).toEqual([[me.identity.publicKey, 'mia-key', 12.5, '']]);
        expect(text()).toContain(said('fr', '✓ Sent!'));
    });

    it('fr "12.5" is 12.5 too, shown the French way', async () => {
        const { sent, receives } = await sendIn('fr', '12.5');
        expect(receives).toContain('12,50');
        expect(sent).toEqual([[me.identity.publicKey, 'mia-key', 12.5, '']]);
    });

    it('en "12.5" exactly as before: 12.50 shown, 12.5 sent', async () => {
        const { sent, receives } = await sendIn('en', '12.5');
        expect(receives).toContain('12.50');
        expect(sent).toEqual([[me.identity.publicKey, 'mia-key', 12.5, '']]);
        expect(text()).toContain('✓ Sent!');
    });

    it('fr "1.000" could be a thousand or one: no confirmation line, nothing sent, and words that say why', async () => {
        const { sent, receives } = await sendIn('fr', '1.000');
        expect(receives).toBeNull();
        expect(sent).toEqual([]);
        expect(text()).toContain(formatNumber(1000.5, undefined, 'fr'));
        // The sentence is core's (parseAmount's refusal), so its French is in core's catalog: the draft once it has one, else the English.
        const coreFr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../packages/beanpool-core/words/fr.json'), 'utf8')) as Record<string, string>;
        const why = 'Type the amount without thousands separators, like {example}.';
        expect(text()).toContain((coreFr[why] || why).replace('{example}', formatNumber(1000.5, undefined, 'fr')));
    });

    it('en "1.234" still gets the cents guard\'s own words, and "abc" its own', async () => {
        const cents = await sendIn('en', '1.234');
        expect(cents.sent).toEqual([]);
        expect(text()).toContain('The amount is a number of Beans above 0, to the cent.');
        await type(byLabel('Amount to send'), 'abc');
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Confirm Transfer'), 'Confirm Transfer');
        expect(text()).toContain('Enter a valid amount');
        expect(cents.sent).toEqual([]);
    });
});
