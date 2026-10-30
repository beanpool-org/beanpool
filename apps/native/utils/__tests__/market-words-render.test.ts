// @vitest-environment jsdom
/**
 * The Market in the member's language (words slice S3, sweep B1): app/(tabs)/market.tsx rendered for real inside the real
 * LanguageProvider, with the components only the Market uses drawn for real too (the cards, the filter rows and their
 * tiles, the trust and distance pickers, Your deals, the poll and event cards, the activity feed, the example cards, the
 * new-post chooser). React Native's host components are plain tags carrying their accessibility props, placeholders and
 * the few layout props the 320 dp checks read; the node is the net-spy stand-in for utils/db, answering a small community.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint,
 * placeholder or alert with letters outside a bracket bypassed t(). What members wrote is shown as written: titles, names,
 * groups, places, poll answers. The 320 dp × 1.3 checks model widths as tab-bar-words-render.test.ts does (a generous
 * 0.62 em a letter), and for the category tiles at the emulator-measured ~5.6 dp a letter (utils/filter-chips.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The width every measured view reports (onLayout): the category panel's at 320 dp, 16 dp gutters, -8 dp margins. */
const PANEL_WIDTH = 304;
const alerts = vi.hoisted(() => ({ said: [] as string[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', summary: 'region' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, horizontal, onLayout, value, onChangeText, disabled } = props;
        // A view that measures itself hears the panel's width once, as on a phone.
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: PANEL_WIDTH, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        if (horizontal) attrs['data-horizontal'] = 'true';
        const s = flat(props.style);
        if (s.flexWrap) attrs['data-wrap'] = s.flexWrap;
        if (typeof s.width === 'number') attrs['data-width'] = String(s.width);
        if (typeof s.maxWidth === 'number') attrs['data-max-width'] = String(s.maxWidth);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
        ListHeaderComponent,
        (data ?? []).length
            ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
            : ListEmptyComponent,
        ListFooterComponent);
    class Value { constructor(public v = 0) {} setValue() {} setOffset() {} stopAnimation() {} interpolate() { return this; } addListener() { return ''; } removeListener() {} removeAllListeners() {} }
    const animation = () => ({ start(cb?: () => void) { cb?.(); }, stop() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList,
        Animated: {
            FlatList, View: el('div'), Value, event: () => () => {}, timing: animation, spring: animation, decay: animation,
            diffClamp: () => new Value(), add: () => new Value(), multiply: () => new Value(), subtract: () => new Value(), modulo: () => new Value(),
        },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string) => { alerts.said.push(title); if (body) alerts.said.push(body); } },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Easing: { out: (f: unknown) => f, cubic: () => 0, ease: () => 0, inOut: (f: unknown) => f },
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
        router: { push() {}, navigate() {}, setParams() {} },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => params.now,
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
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'denied', canAskAgain: false }), getLastKnownPositionAsync: async () => null,
    requestForegroundPermissionsAsync: async () => ({ status: 'denied' }), getCurrentPositionAsync: async () => null,
}));
vi.mock('react-native-maps', () => ({ default: () => null, Marker: () => null, Circle: () => null, PROVIDER_DEFAULT: 'default' }));
vi.mock('@react-native-community/slider', () => ({ default: () => createElement('input', { type: 'range' }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, authenticateAsync: async () => ({ success: false }) }));
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
// A member's picture: drawn from what they chose, never words.
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
// The poll and event composers are their own screens (NewPollModal, NewEventModal), for a later sweep; closed here.
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: () => null }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../home-store', () => ({ readPhoneInterests: async () => interests.now, saveInterests: async () => {} }));
const interests = vi.hoisted(() => ({ now: [] as string[] }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { DrawnInLanguage, LanguageProvider } from '../../components/LanguageProvider';
import { LanguageRow } from '../../components/LanguagePicker';
import { FilterChipPanel } from '../../components/FilterChipPicker';
import { CATEGORY_FILTER_CHIPS } from '../map-filters';
import { TILE_LETTER_DP, TILE_PANEL_PADDING, longestWordLength } from '../filter-chips';
import MarketScreen from '../../app/(tabs)/market';

const NODE = 'https://mullum.example';
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();

/** A small community: an offer with every badge, the member's own group Need, an older offer, a poll and an event. */
const POSTS = [
    {
        id: 'p-eggs', type: 'offer', status: 'active', title: 'Fresh duck eggs', description: 'A dozen a week', category: 'food',
        author_pubkey: 'kofi-key', author_callsign: 'Kofi', author_energy_cycled: 0, authorFoundingNeeded: true,
        credits: 5, price_type: 'hourly', photos: '[]', repeatable: 1, cash_also_needed: 1, created_at: iso(now - 60_000),
    },
    {
        id: 'p-ladder', type: 'need', status: 'active', title: 'Borrow a long ladder', description: 'For the gutters', category: 'tools',
        author_pubkey: ME.publicKey, author_callsign: ME.callsign, author_energy_cycled: 700, credits: 3, price_type: 'daily',
        photos: '[]', audience_scope: 'group', target_group_id: 'g1', target_group_name: 'Garden club', created_at: iso(now - DAY),
    },
    {
        id: 'p-maths', type: 'offer', status: 'active', title: 'Maths tutoring', description: 'Year 7 to 10', category: 'education',
        author_pubkey: 'mia-key', author_callsign: 'Mia', author_energy_cycled: 2000, credits: 20, price_type: 'weekly',
        photos: '[]', created_at: iso(now - 10 * DAY),
    },
    {
        id: 'p-poll', type: 'poll', status: 'active', title: 'Where should the market go?', description: 'Saturdays from March',
        author_pubkey: 'kofi-key', author_callsign: 'Kofi', poll_closes_at: iso(now + 3 * DAY), pollOpenVote: true,
        pollOptions: [{ id: 'o1', text: 'The hall', votes: 3 }, { id: 'o2', text: 'The park', votes: 1 }],
        pollVotes: [{ optionId: 'o1', voterPubkey: 'mia-key', voterCallsign: 'Mia' }], created_at: iso(now - 2 * DAY),
    },
    {
        id: 'p-event', type: 'event', status: 'active', title: 'Repair café', event_place_name: 'Scout hall',
        event_start_at: iso(now + 2 * DAY), event_end_at: iso(now + 2 * DAY + 2 * 60 * 60 * 1000),
        author_pubkey: 'mia-key', author_callsign: 'Mia', goingCount: 2, interestedCount: 1, created_at: iso(now - 3 * DAY),
    },
];
/** Your deals: the Need held in trust, and a finished deal waiting on the member's review. */
const TRANSACTIONS = [
    { id: 'tx-held', postId: 'p-ladder', postTitle: 'Borrow a long ladder', status: 'pending', buyerPublicKey: ME.publicKey, sellerPublicKey: 'mia-key', sellerCallsign: 'Mia', credits: 3, createdAt: iso(now - DAY) },
    { id: 'tx-done', postId: 'p-old', postTitle: 'Bike tune-up', status: 'completed', buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME.publicKey, credits: 8, createdAt: iso(now - 5 * DAY) },
];
const ACTIVITY = [
    { id: 1, eventType: 'member_joined', actorPubkey: 'zoe-key', actorCallsign: 'Zoe', createdAt: iso(now - 5 * 60_000) },
    { id: 2, eventType: 'trade_completed', actorPubkey: 'kofi-key', actorCallsign: 'Kofi', targetPubkey: 'mia-key', targetCallsign: 'Mia', metadata: { credits: 12 }, createdAt: iso(now - 3 * 60 * 60_000) },
    { id: 3, eventType: 'rating_given', actorPubkey: 'mia-key', actorCallsign: 'Mia', targetPubkey: 'kofi-key', targetCallsign: 'Kofi', metadata: { stars: 4 }, createdAt: iso(now - 2 * DAY) },
    { id: 4, eventType: 'post_created', actorPubkey: 'zoe-key', actorCallsign: 'Zoe', metadata: { title: 'Lemons to share' }, createdAt: iso(now - 30_000) },
];
/** Everything members and the community wrote: shown as written, in every language. */
const OTHERS = [
    ...POSTS.flatMap((p: any) => [p.title, p.description, p.author_callsign, p.target_group_name, p.event_place_name, ...(p.pollOptions ?? []).map((o: any) => o.text)]),
    ...TRANSACTIONS.flatMap((x: any) => [x.postTitle, x.sellerCallsign, x.buyerCallsign]),
    ...ACTIVITY.flatMap((a: any) => [a.actorCallsign, a.targetCallsign, a.metadata?.title]),
    'Garden club', ME.callsign,
].filter((s): s is string => typeof s === 'string' && /\p{L}/u.test(s)).sort((a, b) => b.length - a.length);

type Answers = Record<string, unknown>;
function community(over: Answers = {}): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Answers = {
        getPosts: POSTS, getMarketplaceTransactions: TRANSACTIONS, getMyPosts: [], fetchMyEvents: [],
        getBalance: { isBlockedFromTrading: true }, fetchGroups: [{ id: 'g1', name: 'Garden club', viewerStatus: 'active' }],
        getMemberRatings: { average: 4, count: 2 },
        signedGet: { status: 200, ok: true, json: async () => ({ feed: ACTIVITY }) },
        ...over,
    };
    return (name) => (name in answers ? Promise.resolve(answers[name]) : undefined);
}
function rememberProfile(features: Record<string, boolean>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features, checkedAt: new Date().toISOString() } }));
}
const LOCAL = { beans: true, escrow: true, showcase: false, exampleListings: true };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.answer = community();
    params.now = {};
    interests.now = [];
    alerts.said.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    rememberProfile(LOCAL);
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, screen: unknown = createElement(MarketScreen)) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, screen as any) as any); });
    await settle();
}
const click = async (el: Element | null, what: string) => {
    expect(el, what).not.toBeNull();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`);
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

/** Text with letters outside a pseudo-locale bracket, once what others wrote is taken out. */
function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
    // Innermost first: a translated sentence can hold another as a value ("[[Ƒööđ~] ▾~~]").
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const o of OTHERS) rest = rest.split(o).join('');
    return /\p{L}/u.test(rest);
}
/** Every drawn text (per text element, so a sentence with a bold name in it reads whole), label, hint, placeholder and alert that bypassed t(). */
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

describe('the Market in the pseudo-locale: every word on it came through t() (words S3b)', () => {
    it('the feed in list view: the search, Your deals, the type and filter rows, the group pills, every card and heading, the poll and event cards, the welcome quest and the fresh banner', async () => {
        await renderIn('xx');
        expect(host.textContent).toContain('Fresh duck eggs');
        expect(host.textContent).toContain('Where should the market go?');
        expect(host.textContent).toContain('Repair café');
        expect(byTestId('page-title-market')).not.toBeNull();
        expect(host.querySelector('[data-testid="category-tile"]')).not.toBeNull();
        expect(bracketed()).toBeGreaterThan(30);
        expect(bypassing()).toEqual([]);
    });

    it('the grid and compact views', async () => {
        await renderIn('xx');
        await click(host.querySelector(`[aria-label="${pseudoLocalise('Grid view')}"]`), 'the view toggle');
        expect(byTestId('grid-badge-row')).not.toBeNull();
        expect(host.querySelector('[data-testid="category-tile"]')).not.toBeNull();
        expect(bypassing()).toEqual([]);
        await click(host.querySelector(`[aria-label="${pseudoLocalise('Compact view')}"]`), 'the view toggle, again');
        expect(host.querySelector('[data-testid="category-tile"]')).not.toBeNull();
        expect(host.textContent).toContain('Kofi');
        expect(bypassing()).toEqual([]);
    });

    it('For You: the interests to pick, then the summary once some are picked', async () => {
        await renderIn('xx');
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === pseudoLocalise('★ For You')) ?? null, 'the For You pill');
        expect(host.textContent).toContain(pseudoLocalise('★ CUSTOMIZE INTERESTS'));
        expect(bypassing()).toEqual([]);
        interests.now = ['food', 'tools'];
        root.unmount();
        root = createRoot(host);
        await renderIn('xx');
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === pseudoLocalise('★ For You')) ?? null, 'the For You pill');
        expect(bypassing()).toEqual([]);
    });

    it('the Events and Polls pills: the date chips, the Distance and Trust chips', async () => {
        await renderIn('xx');
        for (const pill of ['Events', 'Polls']) {
            await click(Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === pseudoLocalise(pill)) ?? null, pill);
            expect(bypassing(), pill).toEqual([]);
        }
    });

    it('the category tiles, the trust picker, the distance picker, Your deals (every tab) and the new-post chooser', async () => {
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Filter by category')), 'the category chip');
        expect(host.textContent).toContain(pseudoLocalise('Education'));
        expect(bypassing(), 'tiles').toEqual([]);
        await click(byLabel(pseudoLocalise('Close categories')), 'a tap on the feed');

        await click(byLabel(pseudoLocalise('Filter by trust level')), 'the Trust chip');
        expect(host.textContent).toContain(pseudoLocalise('Filter by Trust Level'));
        expect(bypassing(), 'trust').toEqual([]);
        await click(host.querySelector('[data-modal] [aria-label]'), 'the sheet\'s backdrop');

        await click(byLabel(pseudoLocalise('Filter by distance')), 'the Distance chip');
        expect(host.textContent).toContain(pseudoLocalise('Search radius'));
        expect(bypassing(), 'distance').toEqual([]);
        await click(byLabel(pseudoLocalise('Cancel location picker')), 'Cancel');

        await click(host.querySelector(`[aria-label^="${pseudoLocalise('Your deals, {n} pending').slice(0, 6)}"]`), 'Your deals');
        // In Progress lists the deal held in trust (its own card, Deals S3b), History the finished deal.
        expect(byTestId('deal-card-tx-held')).not.toBeNull();
        expect(bypassing(), 'Your deals, in progress').toEqual([]);
        for (const tab of ['My Posts', 'History']) {
            await click(Array.from(host.querySelectorAll('[data-modal] button')).find((b) => b.textContent === pseudoLocalise(tab)) ?? null, tab);
            expect(bypassing(), `Your deals, ${tab}`).toEqual([]);
        }
        expect(byTestId('deal-card-tx-done')).not.toBeNull();
        await click(host.querySelector(`[data-modal] [aria-label="${pseudoLocalise('Close')}"]`), 'close Your deals');

        await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(pseudoLocalise('ADD POST'))) ?? null, 'ADD POST');
        expect(host.textContent).toContain(pseudoLocalise('Create New Post'));
        expect(bypassing(), 'the chooser').toEqual([]);
    });

    it('a search: the active-filter summary\'s words, Save this search to Home, and no matches', async () => {
        await renderIn('xx');
        const search = host.querySelector('input[placeholder]') as HTMLInputElement;
        expect(search.getAttribute('placeholder')).toBe(pseudoLocalise('Search'));
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(search, 'zzzz');
            search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await settle();
        expect(byTestId('market-save-search')).not.toBeNull();
        expect(host.textContent).toContain(pseudoLocalise('No items found'));
        expect(bypassing()).toEqual([]);
    });

    it('the empty Market: the first sync, the activity feed and the example cards', async () => {
        net.answer = community({ getPosts: [], getMarketplaceTransactions: [] });
        await renderIn('xx');
        expect(host.textContent).toContain(pseudoLocalise('Loading the marketplace…'));
        expect(bypassing(), 'loading').toEqual([]);
    });

    it('a community that refuses this phone its listings: the members-only card', async () => {
        store.map.set(`beanpool_members_only_${NODE}`, '1');
        net.answer = community({ getPosts: [] });
        await renderIn('xx');
        expect(bypassing()).toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        await renderIn('en');
        expect(bracketed()).toBe(0);
        expect(host.textContent).toContain('Your deals');
        expect(host.textContent).toContain('🔒 Only Garden club can see this');
        expect(host.textContent).toContain('🫘 Welcome, Ana! One step to unlock trading');
        expect(host.textContent).toContain('1 fresh listing posted today!');
        expect(host.textContent).toContain('📊 4 total votes cast');
        expect(host.textContent).toContain('2 going · 1 interested');
        expect(byLabel('Your deals, 1 pending')).not.toBeNull();
    });
});

describe('the activity feed and the example cards in the pseudo-locale (the empty Market)', () => {
    it('every line is one sentence with the names in it, and every card says it is an example first', async () => {
        const { ActivityWaterfall } = await import('../../components/ActivityWaterfall');
        const { ExampleListings } = await import('../../components/ExampleListings');
        await renderIn('xx', createElement('div', null, createElement(ExampleListings), createElement(ActivityWaterfall, { onCreatePostPress: () => {} })));
        expect(host.textContent).toContain('Zoe');
        expect(host.querySelectorAll('[data-testid="example-card"]').length).toBeGreaterThan(2);
        for (const card of Array.from(host.querySelectorAll('[data-testid="example-card"]'))) {
            expect(card.getAttribute('aria-label')!.startsWith(pseudoLocalise('Example, not a real listing. Offer: {title}. {description}').slice(0, 8))).toBe(true);
        }
        expect(bypassing()).toEqual([]);
    });
});

// ── 320 dp with text at 1.3×: longer languages never push words past an edge (checked with the pseudo-locale) ─────────
const FLOOR = 320;
const SCALE = 1.3;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : CJK.test(c) ? 1 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);

describe('the Market at 320 dp with 1.3× text, in the pseudo-locale', () => {
    it('the category tiles: every label\'s longest word fits its tile (fewer columns for longer words); English keeps four a row', async () => {
        const drawn = async (lang: UiLang) => {
            root.unmount();
            root = createRoot(host);
            await renderIn(lang, createElement(FilterChipPanel as any, { chips: CATEGORY_FILTER_CHIPS, selected: 'all', onSelect: () => {}, activeColor: '#000' }));
            const tiles = Array.from(host.querySelectorAll('button[data-width]'));
            return { tiles, width: Number(tiles[0].getAttribute('data-width')), labels: tiles.map((b) => b.querySelector('span[data-lines]')!.textContent!) };
        };
        const inner = PANEL_WIDTH - 2 * TILE_PANEL_PADDING;
        const en = await drawn('en');
        expect(en.tiles.length).toBe(CATEGORY_FILTER_CHIPS.length);
        expect(en.width).toBe(Math.floor((inner - 4 * 3) / 4));
        const xx = await drawn('xx');
        expect(xx.labels.every((l) => /^\[.*\]$/su.test(l))).toBe(true);
        expect(xx.width).toBeGreaterThan(en.width);
        // The tile's text is 11 dp, scaled; a word never breaks across its two lines, so the longest must fit across.
        const longest = longestWordLength(xx.labels);
        expect(longest * TILE_LETTER_DP * SCALE + 4).toBeLessThanOrEqual(xx.width);
        for (const tile of xx.tiles) expect(tile.querySelector('span[data-lines]')!.getAttribute('data-lines')).toBe('2');
    });

    it('the trust picker\'s labels shrink to one line in their third of the sheet, and the longest fits at the smallest', async () => {
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Filter by trust level')), 'the Trust chip');
        const items = Array.from(host.querySelectorAll('[data-modal] button')).filter((b) => b.querySelector(':scope > span[data-shrinks]'));
        expect(items.length).toBe(6);
        const itemWidth = (FLOOR - 48 - 24) / 3;
        for (const item of items) {
            const label = item.querySelector('span[data-shrinks]')!;
            expect(label.getAttribute('data-lines')).toBe('1');
            const min = Number(label.getAttribute('data-min-scale'));
            expect(widthOf(label.textContent!, 11 * SCALE) * min, label.textContent!).toBeLessThanOrEqual(itemWidth);
        }
    });

    it('Your deals in the search row is capped and shrinks its words, so the search keeps room; its words fit at the smallest', async () => {
        await renderIn('xx');
        const pill = host.querySelector(`[aria-label^="${pseudoLocalise('Your deals, {n} pending').slice(0, 6)}"]`)!;
        const cap = Number(pill.getAttribute('data-max-width'));
        expect(cap).toBe(120);
        const label = Array.from(pill.querySelectorAll('span[data-shrinks]'))[0];
        expect(label.textContent).toBe(pseudoLocalise('Your deals'));
        expect(label.getAttribute('data-lines')).toBe('1');
        expect(widthOf(label.textContent!, 11 * SCALE) * Number(label.getAttribute('data-min-scale'))).toBeLessThanOrEqual(cap - 28);
        // The row: 16 dp gutters, two 8 dp gaps, the 38 dp view toggle; the search keeps at least a third of the width.
        expect(FLOOR - 32 - 16 - 38 - cap).toBeGreaterThanOrEqual(FLOOR / 3);
    });

    it('the rows that hold words side by side wrap instead of running past the edge; the chip rows scroll sideways', async () => {
        await renderIn('xx');
        // The type pills and the filter chips: one line each that scrolls (FilterChipBar), never clipped.
        expect(host.querySelectorAll('[data-horizontal="true"]').length).toBeGreaterThanOrEqual(3);
        // A list card's badges (type, category, RECURRING, CASH TOO, the group's) and the author's tier and FOUNDING.
        const eggs = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Fresh duck eggs'))!;
        expect(eggs.querySelectorAll('[data-wrap="wrap"]').length).toBeGreaterThanOrEqual(2);
        await click(host.querySelector(`[aria-label="${pseudoLocalise('Grid view')}"]`), 'the view toggle');
        // The grid card's foot: RECURRING, YOU and the price in one row that wraps upwards.
        for (const row of Array.from(host.querySelectorAll('[data-testid="grid-badge-row"]'))) expect(row.getAttribute('data-wrap')).toBe('wrap');
    });
});

describe('words in capitals, the language\'s way (never toUpperCase on a translated word)', () => {
    const catalog = (lang: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words', `${lang}.json`), 'utf8')) as Record<string, string>;

    it('Turkish: a feed heading\'s "i" is a dotted capital "İ"', async () => {
        const events = catalog('tr')['Upcoming events'];
        expect(events).toMatch(/i/);
        await renderIn('tr');
        expect(host.textContent).toContain('Repair café');
        expect(host.textContent).toContain(events.toLocaleUpperCase('tr'));
        expect(host.textContent).not.toContain(events.toUpperCase());
    });

    it('Greek: an example card\'s badge drops its accents in capitals', async () => {
        const { ExampleListings } = await import('../../components/ExampleListings');
        const example = catalog('el')['Example'];
        expect(example.toUpperCase()).not.toBe(example.toLocaleUpperCase('el'));
        await renderIn('el', createElement(ExampleListings));
        expect(host.textContent).toContain(example.toLocaleUpperCase('el'));
        expect(host.textContent).not.toContain(example.toUpperCase());
    });
});

describe('the Market follows a language picked in Settings', () => {
    const NATIVE_WORDS = path.resolve(__dirname, '../../words');
    const fr = JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, 'fr.json'), 'utf8')) as Record<string, string>;
    const MENU = { menuBtn: {}, menuIconWrap: {}, menuIcon: {}, menuText: {}, menuSub: {}, menuChevron: {} };

    it('a pick redraws it in the new language: its pills, the category chip and the cards\' badges, with nothing by hand', async () => {
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(LanguageRow as any, { styles: MENU }), createElement(MarketScreen))) as any);
        });
        await settle();
        const pills = () => Array.from(host.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
        expect(pills()).toContain('Offers');
        expect(host.textContent).toContain('🏷️ All Categories ▾');
        await click(byTestId('settings-language'), 'Settings → Language');
        await click(byTestId('language-fr'), 'Français');
        expect(fr['Offers']).toBeTruthy();
        expect(pills()).toContain(fr['Offers']);
        expect(pills()).toContain(fr['Needs']);
        expect(pills()).not.toContain('Offers');
        expect(host.textContent).toContain(`🏷️ ${fr['All Categories']} ▾`);
        expect(host.textContent).toContain(fr['OFFER']);
        expect(host.textContent).toContain('Fresh duck eggs');
    });
});
