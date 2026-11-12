// @vitest-environment jsdom
/**
 * Per-item prices, slice P3 (scratch/fable-design/DESIGN-per-item-price-fable.md §2.2, §2.3), on the phone's item page
 * (app/post/[id].tsx): the buyer's "How many would you like?" box (a number, all of them, the refusals), what Confirm sends, and
 * both sides' deal lines. The harness is post-detail-free-render.test.ts's: the page rendered for real inside the real
 * LanguageProvider, utils/db stood in by name. Rob's panels: 300 Beans each, 20 of them, or all 20 for 5,500. Each check names
 * the change that turns it red.
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
import PostDetailScreen from '../../app/post/[id]';

const NODE = 'https://mullum.example';
const ROB = { pubkey: 'rob-key', callsign: 'Rob' };
const DANA = { pubkey: 'dana-key', callsign: 'Dana' };
/** Rob's panels as the phone's copy holds them: 300 each, 20 left, all 20 for 5,500. */
const PANELS = {
    id: 'p-panels', type: 'offer', status: 'active', title: 'Solar panels', description: 'Used, all working', category: 'tools',
    author_pubkey: ROB.pubkey, author_callsign: ROB.callsign, price_c: 30000, price_type: 'each', units_left: 20, lot_units: 20,
    lot_price_c: 550000, repeatable: 0, cash_also_needed: 0, audience_scope: 'public', photos: '[]', created_at: '2026-11-10T09:00:00.000Z',
};
const HELD_AT = '2026-11-11T10:00:00.000Z';

const said = { accept: [] as unknown[][], complete: [] as unknown[][], refreshed: [] as unknown[] };
function answers(post: Record<string, unknown>, o: {
    accept?: () => Promise<unknown>; activeTx?: Record<string, unknown> | null; deals?: unknown[]; after?: Record<string, unknown>;
} = {}) {
    let shown = post;
    const database = {
        getFirstAsync: async (sql: string) => (/status='pending'/.test(sql) ? o.activeTx ?? null : null),
        getAllAsync: async () => [],
    };
    return (name: string, args: unknown[]) => {
        if (name === 'getPost') return Promise.resolve(shown);
        if (name === 'getDb') return Promise.resolve(database);
        if (name === 'getMemberRatings') return Promise.resolve({ average: 4.5, count: 3 });
        if (name === 'getUnreadCountForPost') return Promise.resolve(0);
        if (name === 'getBalance') return Promise.resolve({ isBlockedFromTrading: false, keeperOf: [] });
        if (name === 'getMarketplaceTransactions') return Promise.resolve(o.deals ?? []);
        if (name === 'createConversationApi') return Promise.resolve(null);
        if (name === 'acceptMarketplacePost') { said.accept.push(args); return o.accept ? o.accept() : Promise.resolve({ success: true, transaction: { id: 'tx-new' } }); }
        if (name === 'completeMarketplaceTransaction') { said.complete.push(args); return Promise.resolve({ success: true }); }
        // The node's listing read again after a refusal: the page then shows it as it is now.
        if (name === 'refreshPost') { said.refreshed.push(args[0]); if (o.after) shown = o.after; return Promise.resolve(true); }
        return undefined;
    };
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
    said.accept.length = 0;
    said.complete.length = 0;
    said.refreshed.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: LOCAL, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(post: Record<string, unknown>, o: Parameters<typeof answers>[1] = {}, lang: UiLang = 'en') {
    net.answer = answers(post, o);
    params.now = { id: String(post.id) };
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(PostDetailScreen)) as any); });
    await settle();
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function tap(id: string) {
    const el = q(id);
    if (!el) throw new Error(`no ${id}`);
    await act(async () => { el.click(); });
    await settle();
}
async function type(id: string, value: string) {
    const el = q(id) as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
}
async function reopen(post: Record<string, unknown>, o: Parameters<typeof answers>[1] = {}) {
    act(() => root.unmount());
    root = createRoot(host);
    await open(post, o);
}

describe("the buyer's box (§2.2): how many, or all of them", () => {
    it('Accept Offer opens it at one: the price and count by the stepper, all 20 as the second choice, the total (red if an Each Offer gets the hours box)', async () => {
        await open(PANELS);
        await tap('post-take-up');
        expect(q('each-confirm')?.textContent).toContain('How many would you like?');
        expect(q('each-line')?.textContent).toBe('300 Beans each · 20 left');
        expect(q('each-all')?.textContent).toBe('All 20 for 5,500 Beans500 less than one by one');
        expect(q('each-total')?.textContent).toBe('1 × 300 = 300 Beans');
        expect(host.textContent).not.toContain('TRUST COMMITMENT (HOURS)');
    });

    it('3 of them: the total and what Rob receives, and Confirm sends 3 at exactly 900 (red if expect_c is not the total shown)', async () => {
        await open(PANELS);
        await tap('post-take-up');
        await tap('each-more');
        await tap('each-more');
        expect((q('each-count') as HTMLInputElement).value).toBe('3');
        expect(q('each-total')?.textContent).toBe('3 × 300 = 900 Beans');
        expect(q('each-trust')?.textContent).toBe('900 Beans go into trust now. Rob receives 886.50 when you release them (1.5% goes to the community).');
        await tap('each-confirm-btn');
        expect(said.accept).toEqual([['p-panels', ME.publicKey, 3, undefined, { itemOption: 'each', expect_c: 90000 }]]);
    });

    it('all of them: picked, or typed as 20, is the price for all, and Confirm sends all 20 at 5,500 (red if 20 goes one by one at 6,000)', async () => {
        await open(PANELS);
        await tap('post-take-up');
        await tap('each-all');
        expect(q('each-total')?.textContent).toBe('All 20 for 5,500 Beans');
        expect(q('each-trust')?.textContent).toBe('5,500 Beans go into trust now. Rob receives 5,417.50 when you release them (1.5% goes to the community).');
        await tap('each-confirm-btn');
        expect(said.accept.at(-1)).toEqual(['p-panels', ME.publicKey, 20, undefined, { itemOption: 'lot', expect_c: 550000 }]);
        await reopen(PANELS);
        await tap('post-take-up');
        await type('each-count', '20');
        expect(q('each-total')?.textContent).toBe('All 20 for 5,500 Beans');
    });

    it('more than are left, or not a whole number: said in the box and Confirm does nothing (red if the box sends what the node refuses)', async () => {
        await open(PANELS);
        await tap('post-take-up');
        await type('each-count', '25');
        expect(q('each-refusal')?.textContent).toBe('Only 20 left now. Choose 20 or fewer.');
        await tap('each-confirm-btn');
        await type('each-count', '2.5');
        expect(q('each-refusal')?.textContent).toBe('Choose a whole number, 1 or more.');
        await tap('each-confirm-btn');
        expect(said.accept).toEqual([]);
    });
});

describe('when the node says the listing moved on: said in the box, read again, never a different amount', () => {
    it('units_gone: "Only 2 left now. Choose 2 or fewer.", the listing read again, and no alert (red if the refusal is not read)', async () => {
        const after = { ...PANELS, units_left: 2, updated_at: 'later' };
        await open(PANELS, { accept: () => Promise.reject(Object.assign(new Error('Only 2 left now. Choose 2 or fewer.'), { code: 'units_gone', unitsLeft: 2 })), after });
        await tap('post-take-up');
        await tap('each-more');
        await tap('each-more');
        await tap('each-confirm-btn');
        expect(q('each-refusal')?.textContent).toBe('Only 2 left now. Choose 2 or fewer.');
        expect(said.refreshed).toEqual(['p-panels']);
        expect(alerts.said).toEqual([]);
        // Still open on the member's own number: they choose again, and nothing more was sent for them.
        expect((q('each-count') as HTMLInputElement).value).toBe('3');
        expect(said.accept).toHaveLength(1);
    });

    it('lot_gone and price_changed have their sentences', async () => {
        for (const [code, words] of [
            ['lot_gone', 'One has just been taken, so the price for all of them is off. You can still take what is left one by one.'],
            ['price_changed', 'The price changed while you were looking. Check it and try again.'],
        ] as const) {
            await reopen(PANELS, { accept: () => Promise.reject(Object.assign(new Error('x'), { code })) });
            await tap('post-take-up');
            await tap('each-all');
            await tap('each-confirm-btn');
            expect(q('each-refusal')?.textContent, code).toBe(words);
        }
    });

    it("a deal already under way keeps today's words", async () => {
        await open(PANELS, { accept: () => Promise.reject(Object.assign(new Error('x'), { code: 'deal_open' })) });
        await tap('post-take-up');
        await tap('each-confirm-btn');
        expect(alerts.said).toContain('You already have a deal under way on this. Finish or cancel it first.');
        expect(q('each-refusal')).toBeNull();
    });

    it('none left: no Accept Offer, "All taken for now" in its place', async () => {
        await open({ ...PANELS, units_left: 0 });
        expect(q('post-take-up')).toBeNull();
        expect(q('each-all-taken')?.textContent).toBe('All taken for now');
    });
});

describe('both sides of the deal (§2.3)', () => {
    const HELD_TX = { id: 'tx-3', post_id: 'p-panels', status: 'pending', buyer_pubkey: ME.publicKey, seller_pubkey: ROB.pubkey, seller_callsign: ROB.callsign, amount_c: 90000, hours: 3, item_option: 'each', created_at: HELD_AT };
    const HELD_ROW = { id: 'tx-3', postId: 'p-panels', status: 'pending', buyerPublicKey: ME.publicKey, sellerPublicKey: ROB.pubkey, sellerCallsign: 'Rob', amount_c: 90000, hours: 3, itemOption: 'each', createdAt: HELD_AT };

    it('the buyer: "✅ You took up 3 on 11 Nov · 900 Beans held in trust", and Release asks no number and sends none (red if the deal is re-rated)', async () => {
        await open({ ...PANELS, units_left: 17 }, { activeTx: HELD_TX, deals: [HELD_ROW] });
        expect(q('taker-line')?.textContent).toBe('✅ You took up 3 on 11 Nov · 900 Beans held in trust');
        await tap('release-open');
        expect(host.querySelector('[aria-label="Actual time worked"]')).toBeNull();
        expect(q('release-line-panel')?.textContent).toBe('Transferring 900 B to Rob');
        await tap('release-confirm');
        expect(said.complete).toEqual([['tx-3', ME.publicKey, undefined]]);
    });

    it('all of them: "✅ You took up all 20 on 11 Nov · 5,500 Beans held in trust"', async () => {
        await open({ ...PANELS, units_left: 0 }, { activeTx: { ...HELD_TX, amount_c: 550000, hours: 20, item_option: 'lot' } });
        expect(q('taker-line')?.textContent).toBe('✅ You took up all 20 on 11 Nov · 5,500 Beans held in trust');
    });

    it('the seller: "17 left · 3 held for buyers" in the price box, and the row "Dana · 3 for 900 Beans held · since 11 Nov"', async () => {
        const mine = { ...PANELS, units_left: 17, author_pubkey: ME.publicKey, author_callsign: ME.callsign };
        const deal = { ...HELD_ROW, id: 'tx-d', buyerPublicKey: DANA.pubkey, buyerCallsign: DANA.callsign, sellerPublicKey: ME.publicKey, sellerCallsign: ME.callsign };
        await open(mine, { deals: [deal] });
        expect(q('price-each-stock')?.textContent).toBe('17 left · 3 held for buyers');
        expect(q('deal-row-tx-d')?.textContent).toContain('Dana · 3 for 900 Beans held · since 11 Nov');
    });
});

describe('the words come through the words layer', () => {
    it('the pseudo-locale: the box is translated (red if a line is written past t())', async () => {
        await open(PANELS, {}, 'xx');
        await tap('post-take-up');
        expect(q('each-confirm')?.textContent).toContain(pseudoLocalise('How many would you like?'));
        expect(q('each-confirm')?.textContent).toContain(pseudoLocalise('Choose how many'));
        expect(q('each-confirm')?.textContent).not.toContain('How many would you like?');
    });
});
