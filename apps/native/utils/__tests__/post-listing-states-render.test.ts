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

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
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
            alert: (title: string, body?: string) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
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

const node = { mine: [] as Array<Record<string, unknown>>, kept: [] as Array<Record<string, unknown>>, keeperOf: [] as string[] };
function answers(post: Record<string, unknown>) {
    const snake = (d: Record<string, any>) => ({ id: d.id, post_id: d.postId, status: d.status, buyer_pubkey: d.buyerPublicKey, buyer_callsign: d.buyerCallsign,
        seller_pubkey: d.sellerPublicKey, seller_callsign: d.sellerCallsign, credits: d.credits, hours: d.hours, created_at: d.createdAt });
    const database = {
        getFirstAsync: async (sql: string, args: unknown[] = []) => {
            if (!sql.includes('FROM marketplace_transactions')) return null;
            const rows = node.mine.map(snake);
            return rows.find(d => d.post_id === args[0] && d.status === 'pending'
                && (!sql.includes('t.buyer_pubkey=?') || d.buyer_pubkey === args[1] || d.seller_pubkey === args[2])) ?? null;
        },
        getAllAsync: async (sql: string, args: unknown[] = []) => (sql.includes("status='requested'")
            ? node.mine.map(snake).filter(d => d.post_id === args[0] && d.status === 'requested') : []),
    };
    const table: Record<string, unknown> = {
        getPost: post, getDb: database, getMemberRatings: { average: 4.5, count: 3 }, getUnreadCountForPost: 0,
        getBalance: { isBlockedFromTrading: false, keeperOf: node.keeperOf }, fetchGroupDetails: { group: { viewerRole: null } },
        getMarketplaceTransactions: node.mine, getDealsFor: node.kept, treasuryComplete: { success: true }, completeMarketplaceTransaction: { success: true },
    };
    return (name: string) => (name in table ? Promise.resolve(table[name]) : undefined);
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
    node.mine = []; node.kept = []; node.keeperOf = [];
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

        it('a helper on a Need, approved: the Beans held for them, the payer named, Cancel; no Release', async () => {
            node.mine = [deal({ buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME.publicKey, credits: 20 })];
            await open(listing({ type: 'need', title: 'Stall help', author_pubkey: 'kofi-key', author_callsign: 'Kofi', credits: 20 }));
            expect(host.textContent).toContain("You're helping with this · 20 Beans held for you");
            expect(host.textContent).toContain('⏳ Pending Release by Kofi');
            expect(host.textContent).toContain('❌ Cancel Trust Hold');
            expect(host.textContent).not.toContain('✅ Release Credits');
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
