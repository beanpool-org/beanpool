// @vitest-environment jsdom
/**
 * A listing priced at 0 Beans reads Free on its page (app/post/[id].tsx, core listing-price.ts): an Offer says Free, a Need says
 * Free help wanted under the label Price, and a price by the hour, day, week or month at 0 is Free too, with no Beans sign.
 * The harness is post-detail-words-render.test.ts: the page rendered for real inside the real LanguageProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../components/useKeepCaretVisible', () => ({ useKeepCaretVisible: () => ({ scrollRef: { current: null }, scrollProps: {} }) })); // the real one needs the keyboard library's native side
import Module from 'node:module';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (props.source?.uri) attrs['data-src'] = props.source.uri; // an <Image>'s photo, so a test can say WHICH photo is drawn
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        const s = flat(props.style);
        if (typeof s.maxWidth === 'number') attrs['data-max-width'] = String(s.maxWidth);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const absolute = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), TouchableOpacity: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: absolute, absoluteFillObject: absolute, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                for (const b of buttons ?? []) if (b.text) alerts.said.push(b.text);
            },
        },
        Linking: { openURL: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {}, canGoBack: () => true, setParams() {} },
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
vi.mock('expo-image', () => ({ Image: (p: { accessibilityLabel?: string; source?: { uri?: string } }) => createElement('img', { ...(p.accessibilityLabel ? { 'aria-label': p.accessibilityLabel } : {}), ...(p.source?.uri ? { 'data-src': p.source.uri } : {}) }) }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, authenticateAsync: async () => ({ success: false }) }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-image-manipulator', () => ({}));
vi.mock('expo-location', () => ({ getForegroundPermissionsAsync: async () => ({ status: 'denied' }), getLastKnownPositionAsync: async () => null }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any), KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any), KeyboardStickyView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
// The category picker: each item's label drawn, so a category's name is checked too.
vi.mock('@react-native-picker/picker', () => ({
    Picker: Object.assign(({ children }: { children?: unknown }) => createElement('select', null, children as any), {
        Item: ({ label }: { label: string }) => createElement('option', null, label),
    }),
}));
vi.mock('../haptics', () => ({ hapticTick: () => {}, hapticSuccess: () => {}, hapticWarning: () => {}, hapticLight: () => {} }));
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const ME = { publicKey: 'me-key', callsign: 'Ana', privateKey: 'p' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
// An event's page is its own screen (components/EventDetail), for the events sweep.
vi.mock('../../components/EventDetail', () => ({ EventDetail: () => null }));
vi.mock('../blocklist', () => ({ blockUser: async () => {}, getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
const profile = vi.hoisted(() => ({ status: { complete: true, missingName: false, missingAvatar: false } }));
vi.mock('../profile-status', async (importOriginal) => ({ ...(await importOriginal<typeof import('../profile-status')>()), getProfileStatus: async () => profile.status }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { ReviewModal } from '../../components/ReviewModal';
import PostDetailScreen from '../../app/post/[id]';

const NODE = 'https://mullum.example';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const KOFI = { pubkey: 'kofi-key', callsign: 'Kofi' };
/** Another member's Offer, with every badge: a photo pair, cash too, recurring, a group's own. */
const OFFER = {
    id: 'p-offer', type: 'offer', status: 'active', title: 'Bike repairs at home', description: 'Flat tyres, brakes, gears',
    category: 'transport', author_pubkey: KOFI.pubkey, author_callsign: KOFI.callsign, price_c: 1200, price_type: 'fixed',
    photos: JSON.stringify(['https://mullum.example/p/1.jpg', 'https://mullum.example/p/2.jpg']), repeatable: 1, cash_also_needed: 1,
    audience_scope: 'group', target_group_id: 'g1', target_group_name: 'Garden club', created_at: iso(now - 3 * 60 * 60_000),
};
const HOURLY = { ...OFFER, id: 'p-hourly', price_type: 'hourly', target_group_id: null, audience_scope: 'public', cash_also_needed: 0, repeatable: 0 };
/** The member's own Need, with two requests waiting. */
const NEED = {
    id: 'p-need', type: 'need', status: 'active', title: 'Help moving a sofa', description: 'Second floor, no lift', category: 'labour',
    author_pubkey: ME.publicKey, author_callsign: ME.callsign, price_c: 2000, price_type: 'hourly', photos: '[]', created_at: iso(now - 26 * 60 * 60_000),
};
const REQUESTS = [
    { id: 'tx-r1', post_id: 'p-need', status: 'requested', buyer_pubkey: ME.publicKey, seller_pubkey: KOFI.pubkey, seller_callsign: KOFI.callsign, amount_c: 4000, hours: 2 },
    { id: 'tx-r2', post_id: 'p-need', status: 'requested', buyer_pubkey: ME.publicKey, seller_pubkey: 'mia-key', seller_callsign: 'Mia', amount_c: 2000, hours: null },
];
/** A deal held in trust on Kofi's Offer: the member pays. */
const HELD = { ...HOURLY, id: 'p-held', status: 'pending', pending_transaction_id: 'tx-held' };
const HELD_TX = { id: 'tx-held', post_id: 'p-held', status: 'pending', buyer_pubkey: ME.publicKey, seller_pubkey: KOFI.pubkey, seller_callsign: KOFI.callsign, amount_c: 2400, hours: 2, created_at: '2026-10-24T10:00:00.000Z' };
/** The member's own Offer held in trust: the member is paid. */
const MINE_HELD = { ...HOURLY, id: 'p-mine-held', status: 'pending', author_pubkey: ME.publicKey, author_callsign: ME.callsign, accepted_by: KOFI.pubkey, accepted_by_callsign: KOFI.callsign, pending_transaction_id: 'tx-mine' };
const MINE_HELD_TX = { id: 'tx-mine', post_id: 'p-mine-held', status: 'pending', buyer_pubkey: KOFI.pubkey, buyer_callsign: KOFI.callsign, seller_pubkey: ME.publicKey, amount_c: 2400, hours: 2 };
const DONE = { ...OFFER, id: 'p-done', status: 'completed', target_group_id: null, audience_scope: 'public', pending_transaction_id: 'tx-done', accepted_by: ME.publicKey };
const PAUSED = { ...HOURLY, id: 'p-paused', status: 'paused', author_pubkey: ME.publicKey, author_callsign: ME.callsign };
/** What members and the node wrote: shown as written. */
const OTHERS = [
    ...[OFFER, NEED].flatMap((p) => [p.title, p.description]),
    KOFI.callsign, 'Mia', ME.callsign, 'Garden club',
].sort((a, b) => b.length - a.length);

function answers(post: Record<string, unknown>, db: { first?: (sql: string, params?: unknown[]) => unknown; all?: (sql: string) => unknown[] } = {}) {
    const database = {
        getFirstAsync: async (sql: string, params?: unknown[]) => db.first?.(sql, params) ?? null,
        getAllAsync: async (sql: string) => db.all?.(sql) ?? [],
    };
    const table: Record<string, unknown> = {
        getPost: post, getDb: database, getMemberRatings: { average: 4.5, count: 3 }, getUnreadCountForPost: 2,
        getBalance: { isBlockedFromTrading: false, keeperOf: [] }, fetchGroupDetails: { group: { viewerRole: 'convenor' } },
        reportAbuse: { wordsLeftOut: undefined },
    };
    return (name: string) => (name in table ? Promise.resolve(table[name]) : undefined);
}
function rememberProfile(features: Record<string, boolean>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features, checkedAt: new Date().toISOString() } }));
}
const LOCAL = { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    alerts.said.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    rememberProfile(LOCAL);
    profile.status = { complete: true, missingName: false, missingAvatar: false };
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(post: Record<string, unknown>, lang: UiLang = 'xx', db?: Parameters<typeof answers>[1], txId?: string) {
    net.answer = answers(post, db);
    params.now = txId ? { id: String(post.id), txId } : { id: String(post.id) };
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(PostDetailScreen)) as any); });
    await settle();
}

function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const o of OTHERS) rest = rest.split(o).join('');
    return /\p{L}/u.test(rest);
}
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
const priceBox = () => host.querySelector('[data-testid="price-terms"]');
const freeLine = () => host.querySelector('[data-testid="price-free"]');

describe("a listing priced at 0 reads Free on its page (phone; core listing-price.ts, the web's page says the same)", () => {
    it('the Need from the report: "Free help wanted" under the label Price, never "Willing to pay 0"', async () => {
        const FREE_NEED = { ...OFFER, id: 'p-free-need', type: 'need', price_c: 0, price_type: 'fixed', title: 'Invites to harvest any sort of spray free food', repeatable: 0, cash_also_needed: 0, audience_scope: 'public', target_group_id: null };
        await open(FREE_NEED, 'en');
        expect(priceBox()?.textContent).toBe('PRICEFree help wanted');
        expect(freeLine()?.textContent).toBe('Free help wanted');
        expect(host.textContent).not.toContain('WILLING TO PAY');
        // No Beans sign and no figure: the price box has no image and no "0", so a screen reader reads "Free help wanted".
        expect(priceBox()?.querySelector('img')).toBeNull();
        expect(priceBox()?.textContent).not.toMatch(/0|\/ Hr|Beans/);
    });

    it('an Offer at 0 says Free, with the label it always had', async () => {
        await open({ ...OFFER, id: 'p-free-offer', price_c: 0, price_type: 'fixed' }, 'en');
        expect(priceBox()?.textContent).toBe('ASKING PRICEFree');
        expect(priceBox()?.querySelector('img')).toBeNull();
    });

    it('a price by the hour, day, week or month at 0 is Free too: never "Free / Hr"', async () => {
        for (const unit of ['hourly', 'daily', 'weekly', 'monthly']) {
            root.unmount();
            root = createRoot(host);
            await open({ ...OFFER, id: `p-free-${unit}`, price_c: 0, price_type: unit }, 'en');
            expect(priceBox()?.textContent, unit).toBe('ASKING PRICEFree');
        }
    });

    it('a Need with a price keeps its label and its figure and unit: nothing changes for a priced listing', async () => {
        await open({ ...OFFER, id: 'p-paid-need', type: 'need', price_c: 2000, price_type: 'hourly' }, 'en');
        expect(priceBox()?.textContent).toContain('WILLING TO PAY');
        expect(priceBox()?.textContent).toContain('20');
        expect(priceBox()?.textContent).toContain('/ Hr');
        expect(freeLine()).toBeNull();
        expect(priceBox()?.textContent).not.toContain('Free');
    });

    it('the pseudo-locale: the words Free help wanted and Price come through t()', async () => {
        await open({ ...OFFER, id: 'p-free-need-xx', type: 'need', price_c: 0, price_type: 'fixed' }, 'xx');
        expect(freeLine()?.textContent).toBe(pseudoLocalise('Free help wanted'));
        expect(bypassing(), 'the page').toEqual([]);
    });
});

// Per-item prices, slice P2 (scratch/fable-design/DESIGN-per-item-price-fable.md §2.2): the price box of an Offer priced for each one
// has three lines in the one box under the label it always had: "300 [bean] each", "20 left", "or all 20 for 5,500 Beans". The
// phone's cached row holds the three columns beside the price.
describe('an Offer priced for each one on its page (phone)', () => {
    const PANELS = { ...OFFER, id: 'p-panels', title: 'Solar panels', price_c: 30000, price_type: 'each', units_left: 20, lot_units: 20, lot_price_c: 550000, repeatable: 0, cash_also_needed: 0, audience_scope: 'public', target_group_id: null };
    const stock = () => host.querySelector('[data-testid="price-each-stock"]');
    const lot = () => host.querySelector('[data-testid="price-each-lot"]');

    it('300 each, 20 left, or all 20 for 5,500 Beans, under ASKING PRICE, with the Beans picture and no hours or unit', async () => {
        await open(PANELS, 'en');
        expect(priceBox()?.textContent).toBe('ASKING PRICE300  each20 leftor all 20 for 5,500 Beans');
        expect(host.querySelector('[data-testid="price-each"]')?.textContent).toBe('300  each');
        expect(stock()?.textContent).toBe('20 left');
        expect(lot()?.textContent).toBe('or all 20 for 5,500 Beans');
        // The sign is the picture, never the emoji, and the screen reader hears the whole line in words.
        expect(priceBox()?.textContent).not.toContain('🫘');
        expect(priceBox()?.querySelectorAll('img')).toHaveLength(1);
        expect(host.querySelector('[data-testid="price-each"]')?.getAttribute('aria-label')).toBe('300 Beans each · 20 left · or all for 5,500');
        expect(priceBox()?.textContent).not.toMatch(/\/ Hr|hrs/);
    });

    it('one taken singly: 19 left and no price for all; all held: words in place of the count', async () => {
        await open({ ...PANELS, units_left: 19 }, 'en');
        expect(stock()?.textContent).toBe('19 left');
        expect(lot()).toBeNull();
        root.unmount();
        root = createRoot(host);
        await open({ ...PANELS, units_left: 0 }, 'en');
        expect(stock()?.textContent).toBe('All taken for now');
        expect(lot()).toBeNull();
    });

    it('a free one says Free (the same words as every free listing) and nothing about a price for all', async () => {
        await open({ ...PANELS, price_c: 0, lot_units: null, lot_price_c: null }, 'en');
        expect(freeLine()?.textContent).toBe('Free');
        expect(lot()).toBeNull();
        expect(priceBox()?.querySelector('img')).toBeNull();
    });

    it('a plain fixed price and an hourly one keep their figure and unit, with no count lines', async () => {
        await open({ ...OFFER, id: 'p-fixed-offer', price_c: 2000, price_type: 'hourly' }, 'en');
        expect(priceBox()?.textContent).toContain('/ Hr');
        expect(stock()).toBeNull();
        expect(lot()).toBeNull();
    });
});
