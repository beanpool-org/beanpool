// @vitest-environment jsdom
/**
 * Deals S4 (scratch/fable-design/DESIGN-deals-fable.md §3.2): app/post/[id].tsx rendered for real at 320 dp × 1.3, light
 * and dark, the listing as each of its people reads it. The author of a recurring Offer sees one row per deal under way;
 * a keeper of the enterprise that wrote a Need sees its deal (read for it from the node) with Release at the enterprise's
 * own door and no Cancel (the node has no door for that); a helper sees the Beans held for them; one who asked sees whom
 * they wait on; a stranger reached by a link is told it is taken. The words are core's (listingDealLines), the same on the
 * web (apps/pwa MarketplacePage.test.tsx "deals-s4").
 *
 * The listing page's harness is post-deal-open-render.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// What each alert said, and the last one's buttons (a test presses one: "Yes, Cancel").
const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
const events = vi.hoisted(() => ({ listeners: new Map<string, Set<(...args: unknown[]) => void>>() }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        void flat(props.style);
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
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                alerts.buttons = buttons ?? [];
            },
        },
        Linking: { openURL: async () => {} },
        // The sync's event is kept, so a test can let it land (the screen reloads on it).
        DeviceEventEmitter: {
            addListener: (name: string, fn: (...args: unknown[]) => void) => {
                const set = events.listeners.get(name) ?? new Set();
                set.add(fn);
                events.listeners.set(name, set);
                return { remove() { set.delete(fn); } };
            },
            emit: (name: string, ...args: unknown[]) => { for (const fn of events.listeners.get(name) ?? []) fn(...args); },
        },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
const nav = vi.hoisted(() => ({ to: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: {
            push(to: unknown) { nav.to.push(to); }, navigate(to: unknown) { nav.to.push(to); }, replace(to: unknown) { nav.to.push(to); },
            back() {}, canGoBack: () => true, setParams() {},
        },
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
vi.mock('expo-image', () => ({ Image: (p: { accessibilityLabel?: string }) => createElement('img', p.accessibilityLabel ? { 'aria-label': p.accessibilityLabel } : null) }));
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
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@react-native-picker/picker', () => ({
    Picker: Object.assign(({ children }: { children?: unknown }) => createElement('select', null, children as any), {
        Item: ({ label }: { label: string }) => createElement('option', null, label),
    }),
}));
vi.mock('../haptics', () => ({ hapticTick: () => {}, hapticSuccess: () => {}, hapticWarning: () => {}, hapticLight: () => {} }));
const sync = vi.hoisted(() => ({ asked: 0 }));
vi.mock('../../services/pillar-sync', () => ({
    requestSync: async () => { sync.asked++; },
    isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended',
}));
const look = vi.hoisted(() => ({ theme: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const colors = () => (look.theme === 'dark' ? darkColors : lightColors);
    return {
        useTheme: () => ({ theme: look.theme, colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: look.theme, colors: colors() }),
    };
});
const ME = { publicKey: 'me-key', callsign: 'Ana', privateKey: 'p' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/EventDetail', () => ({ EventDetail: () => null }));
vi.mock('../blocklist', () => ({ blockUser: async () => {}, getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../profile-status', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../profile-status')>()),
    getProfileStatus: async () => ({ complete: true, missingName: false, missingAvatar: false }),
}));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import { LanguageProvider } from '../../components/LanguageProvider';
import PostDetailScreen from '../../app/post/[id]';

const NODE = 'https://mullum.example';
const iso = (ms: number) => new Date(ms).toISOString();
const AT = '2026-10-24T10:00:00.000Z';
const ENT = 'farm-co-key';
const listing = (over: Record<string, unknown>) => ({
    id: 'p-1', type: 'offer', status: 'active', title: 'Pottery course', description: 'Six weeks on the wheel', category: 'education',
    author_pubkey: 'damo-key', author_callsign: 'Damo', credits: 45, price_type: 'fixed', photos: '[]', repeatable: 1,
    audience_scope: 'public', created_at: iso(Date.now() - 3 * 60 * 60_000), ...over,
});
/** A deal as utils/db.ts getMarketplaceTransactions and getDealsFor answer it (camelCase, the node's shape). */
const deal = (over: Record<string, unknown>) => ({
    id: 'tx-1', postId: 'p-1', status: 'pending', buyerPublicKey: ME.publicKey, buyerCallsign: ME.callsign, sellerPublicKey: 'damo-key',
    sellerCallsign: 'Damo', credits: 45, hours: null, createdAt: AT, ...over,
});

const node = {
    mine: [] as Array<Record<string, unknown>>, kept: [] as Array<Record<string, unknown>>, keeperOf: [] as string[],
    /** Messages unread on this listing, by the one who wrote them; and every chat the page opened (its arguments). */
    unread: {} as Record<string, number>, chats: [] as unknown[][],
};
function answers(post: Record<string, unknown>) {
    const snake = (d: Record<string, any>) => ({ id: d.id, post_id: d.postId, status: d.status, buyer_pubkey: d.buyerPublicKey, buyer_callsign: d.buyerCallsign,
        seller_pubkey: d.sellerPublicKey, seller_callsign: d.sellerCallsign, credits: d.credits, hours: d.hours, created_at: d.createdAt });
    const database = {
        getFirstAsync: async (sql: string, args: unknown[] = []) => {
            if (!sql.includes('FROM marketplace_transactions')) return null;
            const rows = node.mine.map(snake);
            // The deal a door named, by its id on its listing, whatever its status (the phone's copy keeps finished deals).
            if (sql.includes('WHERE t.id = ?')) return rows.find(d => d.id === args[0] && d.post_id === args[1]) ?? null;
            return rows.find(d => d.post_id === args[0] && d.status === 'pending'
                && (!sql.includes('t.buyer_pubkey=?') || d.buyer_pubkey === args[1] || d.seller_pubkey === args[2])) ?? null;
        },
        getAllAsync: async (sql: string, args: unknown[] = []) => (sql.includes("status='requested'")
            ? node.mine.map(snake).filter(d => d.post_id === args[0] && d.status === 'requested') : []),
    };
    const table: Record<string, unknown> = {
        getPost: post, getDb: database, getMemberRatings: { average: 4.5, count: 3 },
        getBalance: { isBlockedFromTrading: false, keeperOf: node.keeperOf }, fetchGroupDetails: { group: { viewerRole: null } },
        getMarketplaceTransactions: node.mine, getDealsFor: node.kept, treasuryComplete: { success: true }, completeMarketplaceTransaction: { success: true },
        treasuryReject: { success: true },
    };
    return (name: string, args: unknown[]) => {
        if (name === 'getUnreadCountForPost') return Promise.resolve(node.unread[String(args[2])] ?? 0);
        if (name === 'createConversationApi') { node.chats.push(args); return Promise.resolve({ id: 'conv-1' }); }
        return name in table ? Promise.resolve(table[name]) : undefined;
    };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    nav.to.length = 0;
    alerts.said.length = 0;
    alerts.buttons = [];
    node.mine = []; node.kept = []; node.keeperOf = []; node.unread = {}; node.chats = [];
    events.listeners.clear();
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: {
        profile: 'local', features: { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false }, checkedAt: new Date().toISOString(),
    } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(post: Record<string, unknown>, extra: Record<string, string> = {}) {
    net.answer = answers(post);
    params.now = { id: String(post.id), ...extra };
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(PostDetailScreen)) as any); });
    await settle();
}
const row = (id: string) => host.querySelector(`[data-testid="deal-row-${id}"]`) as HTMLElement | null;
const press = async (scope: HTMLElement, text: string) => {
    const el = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
    expect(el, text).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};
/** Types into a field as a member does (React reads the input event, not a bare value change). */
const typeInto = async (input: HTMLInputElement, text: string) => {
    expect(input).toBeTruthy();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(2);
};
const buttons = () => Array.from(host.querySelectorAll('button')).map((b) => b.textContent ?? '');

for (const theme of ['light', 'dark'] as const) {
    describe(`a listing by who you are, at 320 dp × 1.3 (${theme})`, () => {
        beforeEach(() => { look.theme = theme; });

        it('the author of a recurring Offer with two deals under way: one row each, the one the alert named first', async () => {
            node.mine = [
                deal({ id: 'tx-a', buyerPublicKey: 'marty-key', buyerCallsign: 'Marty', sellerPublicKey: ME.publicKey, createdAt: '2026-10-26T10:00:00.000Z' }),
                deal({ id: 'tx-b', buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME.publicKey, credits: 30, createdAt: AT }),
            ];
            await open(listing({ author_pubkey: ME.publicKey, author_callsign: ME.callsign }), { txId: 'tx-b' });
            const list = host.querySelector('[data-testid="deals-under-way"]') as HTMLElement;
            expect(list?.textContent).toContain('Deals under way: 2');
            expect(Array.from(list.querySelectorAll('[data-testid^="deal-row-"]')).map(r => r.getAttribute('data-testid'))).toEqual(['deal-row-tx-b', 'deal-row-tx-a']);
            expect(row('tx-a')?.textContent).toContain('Marty · 45 Beans held · since 26 Oct');
            expect(row('tx-b')?.textContent).toContain('Kofi · 30 Beans held · since 24 Oct');
            expect(row('tx-a')?.textContent).toContain('⏳ Pending Release by Marty');
            expect(host.textContent).not.toContain('✅ Release Credits');
            expect(host.textContent?.match(/❌ Cancel Trust Hold/g)).toHaveLength(2);
            expect(host.textContent).not.toContain('🤝 Accept Offer');
        });

        it("a row's Cancel on a deal already over elsewhere: said so, the sync asked for, and that row gone at once", async () => {
            node.mine = [
                deal({ id: 'tx-a', buyerPublicKey: 'marty-key', buyerCallsign: 'Marty', sellerPublicKey: ME.publicKey, createdAt: '2026-10-26T10:00:00.000Z' }),
                deal({ id: 'tx-b', buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME.publicKey, credits: 30, createdAt: AT }),
            ];
            await open(listing({ author_pubkey: ME.publicKey, author_callsign: ME.callsign }));
            // The node: Marty cancelled tx-a on his side a moment ago.
            const base = net.answer!;
            net.answer = (name, args) => (name === 'cancelMarketplaceTransaction'
                ? Promise.reject(Object.assign(new Error('That deal is no longer open.'), { code: 'transaction_gone' }))
                : base(name, args));
            const asked = sync.asked;
            await press(row('tx-a')!, '❌ Cancel Trust Hold');
            const yes = alerts.buttons.find(b => b.text === 'Yes, Cancel');
            expect(yes).toBeTruthy();
            await act(async () => { await yes!.onPress?.(); });
            await settle(4);
            expect(net.calls).toContain('db.cancelMarketplaceTransaction');
            expect(alerts.said).toContain('Already Updated');
            expect(alerts.said).not.toContain('Error');
            expect(alerts.said).not.toContain('That deal is no longer open.');
            expect(sync.asked).toBeGreaterThan(asked);
            expect(row('tx-a')).toBeNull();
            expect(row('tx-b')?.textContent).toContain('Kofi · 30 Beans held · since 24 Oct');
        });

        it("the author messages each deal's other side from its row (its unread on it), and reaches all their deals", async () => {
            node.mine = [
                deal({ id: 'tx-a', buyerPublicKey: 'marty-key', buyerCallsign: 'Marty', sellerPublicKey: ME.publicKey, createdAt: '2026-10-26T10:00:00.000Z' }),
                deal({ id: 'tx-b', buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME.publicKey, credits: 30, createdAt: AT }),
            ];
            node.unread = { 'kofi-key': 2 };
            await open(listing({ author_pubkey: ME.publicKey, author_callsign: ME.callsign }));
            const list = host.querySelector('[data-testid="deals-under-way"]') as HTMLElement;
            const message = (id: string) => Array.from(row(id)!.querySelectorAll('button')).find(b => b.textContent?.startsWith('💬 Message'))?.textContent;
            expect(message('tx-a')).toBe('💬 Message Marty');
            expect(message('tx-b')).toBe('💬 Message Kofi2');
            expect(Array.from(list.querySelectorAll('button')).some(b => b.textContent === 'All your deals ›')).toBe(true);
            await press(row('tx-a')!, '💬 Message Marty');
            expect(node.chats).toEqual([['dm', ['marty-key', ME.publicKey], ME.publicKey, undefined, 'p-1']]);
            expect(nav.to).toContain('/chat/conv-1');
        });

        it('a lender with a free loan out: the row says no Beans are held, never "0 Beans held"', async () => {
            node.mine = [deal({ id: 'tx-l', credits: 0, buyerPublicKey: 'mo-key', buyerCallsign: 'Mo', sellerPublicKey: ME.publicKey, sellerCallsign: ME.callsign })];
            await open(listing({ title: 'Ladder', lendable: 1, repeatable: 0, credits: 0, status: 'pending', author_pubkey: ME.publicKey, author_callsign: ME.callsign }));
            expect(row('tx-l')?.textContent).toContain('Mo · no Beans held · since 24 Oct');
            expect(host.textContent).not.toContain('0 Beans held');
        });

        it("a keeper of the enterprise on its Need: its deal read for it, Release at the enterprise's door, no Cancel", async () => {
            node.keeperOf = [ENT];
            node.kept = [deal({ id: 'tx-f', postId: 'p-1', buyerPublicKey: ENT, buyerCallsign: 'Farm Co-op', sellerPublicKey: 'mo-key', sellerCallsign: 'Mo', credits: 20 })];
            await open(listing({ type: 'need', title: 'Mend the polytunnel', author_pubkey: ENT, author_callsign: 'Farm Co-op', credits: 20 }));
            expect(net.calls).toContain('db.getDealsFor');
            expect(host.textContent).toContain('You act for Farm Co-op here.');
            const r = row('tx-f')!;
            expect(r.textContent).toContain('Mo · 20 Beans held · since 24 Oct');
            expect(r.textContent).not.toContain('❌ Cancel Trust Hold');
            // The keeper messages Mo as themselves (the panel this replaced did too).
            expect(r.textContent).toContain('💬 Message Mo');
            await press(r, '✅ Release Credits');
            await press(r, 'Release Credits');
            expect(net.calls).toContain('db.treasuryComplete');
            expect(net.calls).not.toContain('db.completeMarketplaceTransaction');
            // The enterprise's trade is not the keeper's to rate.
            expect(host.textContent).not.toContain('How was your experience');
        });

        it("a Need's author, who pays, releases from their row: then asked to rate the helper, as the web asks", async () => {
            node.mine = [deal({ id: 'tx-h', credits: 20, buyerPublicKey: ME.publicKey, buyerCallsign: ME.callsign, sellerPublicKey: 'helper-key', sellerCallsign: 'Helper' })];
            await open(listing({ type: 'need', title: 'Fix the fence', author_pubkey: ME.publicKey, author_callsign: ME.callsign, credits: 20 }));
            const r = row('tx-h')!;
            expect(host.textContent).not.toContain('How was your experience');
            await press(r, '✅ Release Credits');
            await press(r, 'Release Credits');
            expect(net.calls).toContain('db.completeMarketplaceTransaction');
            expect(host.textContent).toContain('How was your experience with Helper?');
        });

        it("a daily Need's author releasing from their row is asked for DAYS, with what changing them does, as the panel asks", async () => {
            node.mine = [deal({ id: 'tx-d', credits: 60, hours: 3, buyerPublicKey: ME.publicKey, buyerCallsign: ME.callsign, sellerPublicKey: 'helper-key', sellerCallsign: 'Helper' })];
            await open(listing({ type: 'need', title: 'Pick the olives', author_pubkey: ME.publicKey, author_callsign: ME.callsign, credits: 20, price_type: 'daily' }));
            const r = row('tx-d')!;
            await press(r, '✅ Release Credits');
            expect(r.textContent).toContain('CONFIRM ACTUAL DAYS WORKED');
            expect(r.textContent).toContain('Adjust the final time up or down if the scope changed.');
            expect((r.querySelector('input[aria-label="Actual time worked"]') as HTMLInputElement).value).toBe('3');
        });

        it("a daily Need's author changing 3 days to 5 on their row sees the 100 Beans that will go, not the 60 held, as the web says", async () => {
            node.mine = [deal({ id: 'tx-d', credits: 60, hours: 3, buyerPublicKey: ME.publicKey, buyerCallsign: ME.callsign, sellerPublicKey: 'helper-key', sellerCallsign: 'Helper' })];
            await open(listing({ type: 'need', title: 'Pick the olives', author_pubkey: ME.publicKey, author_callsign: ME.callsign, credits: 20, price_type: 'daily' }));
            const r = row('tx-d')!;
            await press(r, '✅ Release Credits');
            const line = () => r.querySelector('[data-testid="release-line-tx-d"]')?.textContent;
            expect(line()).toBe('Transferring 60 B to Helper');
            await typeInto(r.querySelector('input[aria-label="Actual time worked"]') as HTMLInputElement, '5');
            expect(line()).toBe('Transferring 100 B to Helper');
            // A time that could mean two numbers says why, as the panel says it.
            await typeInto(r.querySelector('input[aria-label="Actual time worked"]') as HTMLInputElement, '1,000');
            expect(line()).toBe('Type the amount without thousands separators, like 1000.5.');
        });

        it("one who took up an hourly Offer releases from the panel: the deal's own total, to the one they pay", async () => {
            node.mine = [deal({ id: 'tx-h', credits: 30, hours: 2 })];
            await open(listing({ title: 'Garden help', repeatable: 0, status: 'pending', accepted_by: ME.publicKey, credits: 15, price_type: 'hourly' }));
            await press(host, '✅ Release Credits');
            const line = () => host.querySelector('[data-testid="release-line-panel"]')?.textContent;
            expect(line()).toBe('Transferring 30 B to Damo');
            await typeInto(host.querySelector('input[aria-label="Actual time worked"]') as HTMLInputElement, '3');
            expect(line()).toBe('Transferring 45 B to Damo');
        });

        it("a keeper denies a request on the enterprise's Need at its door: it leaves the page at once", async () => {
            node.keeperOf = [ENT];
            node.kept = [deal({ id: 'tx-q', status: 'requested', buyerPublicKey: ENT, buyerCallsign: 'Farm Co-op', sellerPublicKey: 'mo-key', sellerCallsign: 'Mo', credits: 20 })];
            await open(listing({ type: 'need', title: 'Mend the polytunnel', author_pubkey: ENT, author_callsign: 'Farm Co-op', credits: 20 }));
            expect(host.textContent).toContain('✋ Fulfillment Requests (1)');
            await press(host, 'Deny');
            // The modal's own Decline (its overlay is a button around it, which closes it).
            const decline = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Decline');
            expect(decline).toBeTruthy();
            await act(async () => { decline!.click(); });
            await settle(4);
            expect(net.calls).toContain('db.treasuryReject');
            expect(net.calls).not.toContain('db.rejectMarketplaceRequest');
            expect(host.textContent).not.toContain('✋ Fulfillment Requests');
            expect(Array.from(host.querySelectorAll('button')).some(b => b.textContent === 'Approve & Commit')).toBe(false);
        });

        it("a keeper's own offer to help on the enterprise's Need: theirs to withdraw, never on the farm's list to approve or deny", async () => {
            node.keeperOf = [ENT];
            const mine = deal({ id: 'tx-mine', status: 'requested', buyerPublicKey: ENT, buyerCallsign: 'Farm Co-op', sellerPublicKey: ME.publicKey, sellerCallsign: ME.callsign, credits: 20 });
            node.mine = [mine];
            node.kept = [mine, deal({ id: 'tx-mo', status: 'requested', buyerPublicKey: ENT, buyerCallsign: 'Farm Co-op', sellerPublicKey: 'mo-key', sellerCallsign: 'Mo', credits: 20 })];
            await open(listing({ type: 'need', title: 'Mend the polytunnel', author_pubkey: ENT, author_callsign: 'Farm Co-op', credits: 20 }));
            // Mo's offer is the farm's to answer; the keeper's own is not.
            expect(host.textContent).toContain('✋ Fulfillment Requests (1)');
            expect(Array.from(host.querySelectorAll('button')).filter(b => b.textContent === 'Approve & Commit')).toHaveLength(1);
            expect(Array.from(host.querySelectorAll('button')).filter(b => b.textContent === 'Deny')).toHaveLength(1);
            expect(host.textContent).toContain('You offered to help · waiting on Farm Co-op');
            await press(host, 'Withdraw Request');
            expect(net.calls).toContain('db.cancelMarketplaceRequest');
            expect(net.calls).not.toContain('db.treasuryReject');
        });

        it('a helper on a Need, approved: the Beans held for them, the payer named, Cancel; no Release', async () => {
            node.mine = [deal({ buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME.publicKey, credits: 20 })];
            await open(listing({ type: 'need', title: 'Stall help', author_pubkey: 'kofi-key', author_callsign: 'Kofi', credits: 20 }));
            expect(host.textContent).toContain("You're helping with this · 20 Beans held for you");
            expect(host.textContent).toContain('⏳ Pending Release by Kofi');
            expect(host.textContent).toContain('❌ Cancel Trust Hold');
            expect(host.textContent).not.toContain('✅ Release Credits');
        });

        it('a helper on a free Need, approved: no Beans held, never "0 Beans held for you"', async () => {
            node.mine = [deal({ buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME.publicKey, credits: 0 })];
            await open(listing({ type: 'need', title: 'Carry chairs', author_pubkey: 'kofi-key', author_callsign: 'Kofi', credits: 0 }));
            expect(host.textContent).toContain("You're helping with this · no Beans held");
            expect(host.textContent).not.toContain('0 Beans held');
        });

        it('one who asked to borrow: whom they wait on, and nothing held', async () => {
            node.mine = [deal({ status: 'requested' })];
            await open(listing({ title: 'Ladder', lendable: 1, repeatable: 0 }));
            expect(host.textContent).toContain('You asked to borrow it · nothing is held until Damo says yes');
        });

        it('a stranger reaching a one-off someone else has taken: told so, and shown nothing of their deal', async () => {
            await open(listing({ title: 'Lawn mower', repeatable: 0, status: 'pending', accepted_by: 'kofi-key' }));
            expect(host.querySelector('[data-testid="taken-by-other"]')?.textContent).toBe('Taken up by someone else for now.');
            expect(host.textContent).not.toContain('✅ Release Credits');
            expect(host.textContent).not.toContain('❌ Cancel Trust Hold');
        });
    });
}

/**
 * A deal's alert opens its listing with the deal's id (push-notice-check.ts noticeRoute). The pushes for a deal that is over
 * (engine/escrow.ts: ❌ Request Declined, 🚫 Deal Cancelled, 🎉 Deal Completed!, ⚖️ Escrow Dispute Resolved as a refund or
 * a release) land on the listing as it stands for the member now, with what they may do on it, and one line on what
 * became of that deal; never a page with the deal over and no way to take the listing up again (review on #2588).
 */
describe("a finished deal's alert lands on the listing as it is now (review on #2588)", () => {
    beforeEach(() => { look.theme = 'light'; });
    const over = () => host.querySelector('[data-testid="pinned-deal-over"]')?.textContent ?? null;
    const kinds = [
        {
            push: '❌ Request Declined: a helper whose offer Kofi declined',
            post: { type: 'need', title: 'Stall help', author_pubkey: 'kofi-key', author_callsign: 'Kofi', credits: 20, repeatable: 0 },
            tx: { id: 'tx-r', status: 'rejected', buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME.publicKey, sellerCallsign: ME.callsign, credits: 20 },
            takeUp: '✋ Offer to Fulfill', said: 'That request was declined.',
        },
        {
            push: '🚫 Deal Cancelled: a taker whose one-off Offer deal was cancelled',
            post: { title: 'Lawn mower', repeatable: 0 },
            tx: { id: 'tx-c', status: 'cancelled' },
            takeUp: '🤝 Accept Offer', said: 'That deal was cancelled.',
        },
        {
            push: '🎉 Deal Completed!: a taker of a recurring Offer, released',
            post: { title: 'Pottery course', repeatable: 1 },
            tx: { id: 'tx-d', status: 'completed', completedAt: '2026-10-27T10:00:00.000Z' },
            takeUp: '🤝 Accept Offer', said: 'That deal is done.',
        },
        {
            push: '⚖️ Escrow Dispute Resolved, refunded: a borrower on a lendable Offer',
            post: { title: 'Ladder', lendable: 1, repeatable: 0, credits: 5 },
            tx: { id: 'tx-x', status: 'cancelled', credits: 5 },
            takeUp: '📦 Ask to borrow', said: 'That deal was cancelled.',
        },
        {
            push: '⚖️ Escrow Dispute Resolved, released: a helper on a repeatable Need',
            post: { type: 'need', title: 'Weekly weeding', author_pubkey: 'kofi-key', author_callsign: 'Kofi', credits: 20, repeatable: 1 },
            tx: { id: 'tx-y', status: 'completed', buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME.publicKey, sellerCallsign: ME.callsign, credits: 20, completedAt: '2026-10-27T10:00:00.000Z' },
            takeUp: '✋ Offer to Fulfill', said: 'That deal is done.',
        },
    ];
    for (const k of kinds) {
        it(`${k.push}: the take-up button, as from the feed, and what became of the deal`, async () => {
            node.mine = [deal(k.tx)];
            // From the feed: the listing as it stands.
            await open(listing(k.post));
            const fromFeed = buttons();
            expect(fromFeed.some((b) => b.includes(k.takeUp))).toBe(true);
            expect(over()).toBeNull();
            act(() => root.unmount());
            root = createRoot(host);
            // From the alert, which names the deal: the same buttons, and one line on that deal.
            await open(listing(k.post), { txId: k.tx.id });
            expect(buttons().some((b) => b.includes(k.takeUp))).toBe(true);
            expect(buttons()).toEqual(fromFeed);
            expect(over()).toBe(k.said);
            expect(host.textContent).not.toContain('✅ Release Credits');
            expect(host.textContent).not.toContain('❌ Cancel Trust Hold');
        });
    }

    it("a deal's alert while it is open still lands on it: an approved helper sees the Beans held for them, no take-up", async () => {
        node.mine = [deal({ id: 'tx-a', buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME.publicKey, credits: 20 })];
        await open(listing({ type: 'need', title: 'Stall help', author_pubkey: 'kofi-key', author_callsign: 'Kofi', credits: 20, status: 'pending', accepted_by: ME.publicKey }), { txId: 'tx-a' });
        expect(host.textContent).toContain("You're helping with this · 20 Beans held for you");
        expect(host.textContent).toContain('❌ Cancel Trust Hold');
        expect(buttons().some((b) => b.includes('✋ Offer to Fulfill'))).toBe(false);
        expect(over()).toBeNull();
    });

    it('one who asked to borrow, opened on their request by its id (My Deals, Home): whom they wait on, and Withdraw', async () => {
        node.mine = [deal({ id: 'tx-q', status: 'requested' })];
        await open(listing({ title: 'Ladder', lendable: 1, repeatable: 0 }), { txId: 'tx-q' });
        expect(host.textContent).toContain('You asked to borrow it · nothing is held until Damo says yes');
        expect(buttons().some((b) => b.includes('Withdraw Request'))).toBe(true);
        expect(over()).toBeNull();
    });

    it("a recurring Offer's author opened on one finished deal by its alert: the other deal's row and Edit, and that one's line", async () => {
        node.mine = [
            deal({ id: 'tx-done', status: 'completed', buyerPublicKey: 'marty-key', buyerCallsign: 'Marty', sellerPublicKey: ME.publicKey, completedAt: '2026-10-27T10:00:00.000Z' }),
            deal({ id: 'tx-b', buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME.publicKey, credits: 30, createdAt: AT }),
        ];
        await open(listing({ author_pubkey: ME.publicKey, author_callsign: ME.callsign }), { txId: 'tx-done' });
        expect(over()).toBe('That deal is done.');
        expect(row('tx-b')?.textContent).toContain('Kofi · 30 Beans held · since 24 Oct');
        expect(row('tx-done')).toBeNull();
        // Its own completed badge is for a one-off that is over, not for one deal of a recurring listing still under way.
        expect(host.textContent).not.toContain('✅ Deal Completed');
    });
});
