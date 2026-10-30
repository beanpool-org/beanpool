// @vitest-environment jsdom
/**
 * The Ledger's doors to deals (deals S6, scratch/fable-design/DESIGN-deals-fable.md §2.2 and §5): app/(tabs)/ledger.tsx
 * rendered for real, its Wallet tab at 320 dp × 1.3 text. The IN ESCROW total is one button that opens Your deals on
 * In Progress; a "Held in Trust" row whose deal the phone has is one button that opens that deal (the post, at its
 * transaction: what Your deals does for a card); a hold the phone has no deal for, and every other row, stay plain rows.
 *
 * React Native's host components are plain tags carrying their accessibility props and the layout props read here;
 * `router.push` is the spy. Components the Ledger shares with other screens are stand-ins, as in
 * ledger-words-render.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pushed = vi.hoisted(() => [] as Array<{ pathname: string; params?: Record<string, string> }>);

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(6).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        attrs['data-style'] = JSON.stringify(flat(props.style));
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
        Alert: { alert() {} },
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
        router: { push: (to: { pathname: string; params?: Record<string, string> }) => { pushed.push(to); }, navigate() {}, replace() {}, back() {} },
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
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const me = vi.hoisted(() => ({ identity: { publicKey: 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12', callsign: 'Ana' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => me }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}),
    signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../../components/CreditBar', () => ({ CreditBar: () => createElement('span') }));
vi.mock('../../components/RepaymentCard', () => ({ RepaymentCard: () => createElement('span') }));
vi.mock('../../components/CommonsInfoModal', () => ({ CommonsInfoModal: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({
    LocalCommunityMark: () => createElement('button'),
    LocalCommunitySheet: () => null,
    ExampleHeader: () => null,
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
vi.mock('../../components/TrustBadge', () => ({ TrustBadge: () => createElement('span') }));

import { setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import LedgerScreen from '../../app/(tabs)/ledger';

const NODE = 'https://mullum.example';
const LISTING = '123e4567-e89b-12d3-a456-426614174000';
const DEAL = 'deal-0001';
const DAY = Date.UTC(2026, 9, 3, 12);

const RESIDENT = {
    balance: 1200, floor: -200, usableFloor: -150, liveOffers: 1, activated: true, frozen: false, creditFrozen: false, knownFrozen: false, knownGrant: 0,
    tier: { name: 'Resident', emoji: '🏠' }, tierCredit: 200, earnedCredit: 150, qualifiedValue: 300, avgRating: 4.5, reviewCount: 3, commons: 12.5,
    trustStats: { uniquePartners: 4 },
};
const base = { projectWallet: false, timestamp: '03/10/2026', at: DAY };
const ROWS = [
    // A hold the phone has the deal for: opens it.
    { ...base, id: 'h1', type: 'debit', amount: 30, peer: 'Held in Trust: Fix the gate (to Mia)', peerPubkey: `escrow_${DEAL}`, memo: `Held in trust for offer ${LISTING}`,
        held: { title: 'Fix the gate', counterparty: 'Mia', toCounterparty: true, dealId: DEAL, postId: LISTING } },
    // A hold with no deal known here: a plain row.
    { ...base, id: 'h2', type: 'debit', amount: 5, peer: 'Held in Trust', peerPubkey: 'escrow_unknown', memo: '',
        held: { title: null, counterparty: null, toCounterparty: false } },
    // Beans from a member that names a listing: the "View Offer" link, as before.
    { ...base, id: 'p1', type: 'credit', amount: 40, peer: 'Mia', peerPubkey: 'mia-key', memo: `Paid for ${LISTING} thanks`, held: null },
];

const ledger = vi.hoisted(() => ({ rows: [] as any[], escrow: 0 }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    pushed.length = 0;
    net.calls.length = 0;
    ledger.rows = ROWS;
    ledger.escrow = 15;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true, showcase: false }, checkedAt: new Date().toISOString() } }));
    net.answer = (name) => {
        if (name === 'getBalance') return Promise.resolve(RESIDENT);
        if (name === 'getTransactions') return Promise.resolve(ledger.rows);
        if (name === 'getMemberProfile') return Promise.resolve({ avatar_url: null });
        if (name === 'getAllCommunityMembers') return Promise.resolve([]);
        if (name === 'getEscrowTotal') return Promise.resolve(ledger.escrow);
        if (name === 'getPledgeHistory') return Promise.resolve([]);
        return undefined;
    };
    globalThis.fetch = vi.fn(async () => new Response('not json', { status: 500 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const realSetTimeout = setTimeout;
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => realSetTimeout(r, 0)); }); };
async function openWallet() {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(LedgerScreen)) as any); });
    await settle();
    await click(byTestId('ledger-wallet-tab'));
}
const click = async (el: Element | null | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const heldRows = () => Array.from(host.querySelectorAll('[data-testid="ledger-held-row"]'));
const styleOf = (el: Element | null | undefined) => JSON.parse(el?.getAttribute('data-style') || '{}');

describe('the Ledger opens the deals behind what is held in trust (deals S6)', () => {
    it('the IN ESCROW total is a button, at least 44 dp tall, that opens Your deals on In Progress', async () => {
        await openWallet();
        const total = byTestId('ledger-in-escrow');
        expect(total?.tagName).toBe('BUTTON');
        expect(total?.getAttribute('role')).toBe('button');
        // Its name is what it shows, and the hint says where it goes.
        expect(total?.textContent).toContain('15.0');
        expect(total?.textContent).toContain('IN ESCROW');
        expect(total?.getAttribute('data-hint')).toBe('Opens your deals in progress');
        expect(styleOf(total).minHeight).toBeGreaterThanOrEqual(44);

        await click(total);
        // The Market's sheet on its In Progress tab ('pending'), the route the listing's "All your deals" and a push use.
        expect(pushed).toEqual([{ pathname: '/(tabs)/market', params: { tab: 'deals', dealsTab: 'pending' } }]);
    });

    it('nothing held: no total, so no door', async () => {
        ledger.escrow = 0;
        await openWallet();
        expect(byTestId('ledger-in-escrow')).toBeNull();
    });

    it('a Held in Trust row whose deal the phone has is one button, at least 44 dp, that opens that deal by its ids', async () => {
        await openWallet();
        expect(heldRows()).toHaveLength(1);
        const held = heldRows()[0];
        expect(held.tagName).toBe('BUTTON');
        expect(held.getAttribute('role')).toBe('button');
        expect(held.getAttribute('data-hint')).toBe('Opens the deal');
        // The name is the row's own words: who it was with, what it was for, the day, the Beans.
        expect(held.textContent).toContain('Held in Trust: Fix the gate (to Mia)');
        expect(held.textContent).toContain('3 Oct 2026');
        expect(held.textContent).toContain('-30');
        expect(styleOf(held).minHeight).toBeGreaterThanOrEqual(44);

        await click(held);
        expect(pushed).toEqual([{ pathname: '/post/[id]', params: { id: LISTING, txId: DEAL } }]);
    });

    it('that row is the one door: its note drops the listing id and the View Offer link inside the button', async () => {
        await openWallet();
        const held = heldRows()[0];
        expect(held.textContent).toContain('Held in trust for offer');
        expect(held.textContent).not.toContain(LISTING);
        expect(held.textContent).not.toContain('View Offer');
        expect(held.querySelectorAll('button')).toHaveLength(0);
    });

    it('a hold with no deal known here, and every other row, stay plain rows (the View Offer link still works)', async () => {
        await openWallet();
        // The hold with no title and no deal (h2) reads "Held in Trust" and sits in no button.
        const unknown = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === 'Held in Trust');
        expect(unknown).toBeTruthy();
        expect(unknown?.closest('button')).toBeNull();
        // The member's own Beans for a listing keep the inline link, and are not a door.
        const link = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === 'View Offer');
        expect(link).toBeTruthy();
        await click(link);
        expect(pushed).toEqual([{ pathname: '/post/[id]', params: { id: LISTING } }]);
    });
});
