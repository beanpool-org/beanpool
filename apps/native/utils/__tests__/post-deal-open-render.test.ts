// @vitest-environment jsdom
/**
 * A deal already under way (the node's `deal_open`, apps/server engine/escrow.ts; scratch/fable-design/DESIGN-deals-fable.md
 * slice S2): app/post/[id].tsx rendered for real. A member takes up a recurring Offer they already have a deal on (made on
 * another device, or on a screen from before it): the node refuses, and the screen says so in the phone's own words, closes the
 * confirmation and asks for a sync; once the sync lands, the listing shows that deal (Release, Cancel) where Accept was. An offer
 * to help with a recurring Need the member is already helping with, the same. Any other refusal is as it was.
 *
 * The listing page's harness is post-detail-words-render.test.ts's; here the sync's event is kept, so it can land.
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
const DAMO = { pubkey: 'damo-key', callsign: 'Damo' };
const KOFI = { pubkey: 'kofi-key', callsign: 'Kofi' };
/** A recurring Offer: it stays on the board while its deals run. */
const COURSE = {
    id: 'p-course', type: 'offer', status: 'active', title: 'Pottery course', description: 'Six weeks on the wheel', category: 'education',
    author_pubkey: DAMO.pubkey, author_callsign: DAMO.callsign, credits: 45, price_type: 'fixed', photos: '[]', repeatable: 1,
    audience_scope: 'public', created_at: iso(Date.now() - 3 * 60 * 60_000),
};
/** The member's deal on it, held in trust: made on their other device, not yet on this phone. */
const COURSE_DEAL = {
    id: 'tx-course', post_id: 'p-course', status: 'pending', buyer_pubkey: ME.publicKey, buyer_callsign: ME.callsign,
    seller_pubkey: DAMO.pubkey, seller_callsign: DAMO.callsign, credits: 45, hours: null, created_at: iso(Date.now() - 60 * 60_000),
};
/** A recurring Need of Kofi's, and the member's deal helping with it, approved: Kofi's Beans held. */
const STALL = {
    id: 'p-stall', type: 'need', status: 'active', title: 'Help at the market stall', description: 'Saturday mornings', category: 'labour',
    author_pubkey: KOFI.pubkey, author_callsign: KOFI.callsign, credits: 20, price_type: 'fixed', photos: '[]', repeatable: 1,
    audience_scope: 'public', created_at: iso(Date.now() - 26 * 60 * 60_000),
};
const STALL_DEAL = {
    id: 'tx-stall', post_id: 'p-stall', status: 'pending', buyer_pubkey: KOFI.pubkey, buyer_callsign: KOFI.callsign,
    seller_pubkey: ME.publicKey, seller_callsign: ME.callsign, credits: 20, hours: null, created_at: iso(Date.now() - 60 * 60_000),
};

const DEAL_OPEN_WORDS = 'You already have a deal under way on this. Finish or cancel it first.';
/** What the node answers a step it refuses because the member's deal is under way (utils/db.ts _signedRequest's error). */
const dealOpen = (transactionId: string) => Object.assign(new Error('Vous avez déjà un échange en cours ici.'), { status: 409, code: 'deal_open', nodeAnswered: true, transactionId });

/** The phone's own rows: the deals it holds so far (none, until the sync lands). */
const local = { deals: [] as Array<Record<string, unknown>> };

function answers(post: Record<string, unknown>, refusal: () => Error) {
    const database = {
        getFirstAsync: async (sql: string, args: unknown[] = []) => {
            if (!sql.includes('FROM marketplace_transactions')) return null;
            if (sql.includes('WHERE t.id = ?')) return local.deals.find(d => d.id === args[0]) ?? null;
            return local.deals.find(d => d.post_id === args[0] && d.status === 'pending'
                && (!sql.includes('t.buyer_pubkey=?') || d.buyer_pubkey === args[1] || d.seller_pubkey === args[2])) ?? null;
        },
        getAllAsync: async (sql: string, args: unknown[] = []) => (sql.includes("status='requested'")
            ? local.deals.filter(d => d.post_id === args[0] && d.status === 'requested') : []),
    };
    const table: Record<string, unknown> = {
        getPost: post, getDb: database, getMemberRatings: { average: 4.5, count: 3 }, getUnreadCountForPost: 0,
        getBalance: { isBlockedFromTrading: false, keeperOf: [] }, fetchGroupDetails: { group: { viewerRole: null } },
    };
    return (name: string) => {
        if (name === 'acceptMarketplacePost' || name === 'requestMarketplacePost') return Promise.reject(refusal());
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
    sync.asked = 0;
    local.deals = [];
    events.listeners.clear();
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: {
        profile: 'local', features: { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false }, checkedAt: new Date().toISOString(),
    } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(post: Record<string, unknown>, refusal: () => Error) {
    net.answer = answers(post, refusal);
    params.now = { id: String(post.id) };
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(PostDetailScreen)) as any); });
    await settle();
}
const press = async (text: string) => {
    const el = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
    expect(el, text).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};
/** The sync the screen asked for lands: the phone now holds the deal, and the screen hears of it. */
async function syncLands(deal: Record<string, unknown>) {
    local.deals = [deal];
    await act(async () => { for (const fn of events.listeners.get('sync_data_updated') ?? []) fn(); });
    await settle();
}

describe('a deal already under way on the listing (deal_open)', () => {
    it('a recurring Offer taken up again: the phone says so, refreshes, and shows the deal in place of Accept', async () => {
        await open(COURSE, () => dealOpen('tx-course'));
        await press('🤝 Accept Offer');
        expect(host.textContent).toContain('Accept this Offer?');
        await press('Confirm');

        expect(net.calls).toContain('db.acceptMarketplacePost');
        expect(alerts.said).toEqual(['Already under way', DEAL_OPEN_WORDS]);
        expect(sync.asked).toBe(1);
        expect(host.textContent).not.toContain('Accept this Offer?');
        // Not the success path: no chat opened, nothing navigated to.
        expect(net.calls).not.toContain('db.createConversationApi');
        expect(nav.to).toEqual([]);

        await syncLands(COURSE_DEAL);
        // The payer's deal panel (S1's words, both apps): shown in place of Accept.
        expect(host.textContent).toContain("Release the Beans when it's done.");
        expect(host.textContent).toContain('✅ Release Credits');
        expect(host.textContent).toContain('❌ Cancel Trust Hold');
        expect(host.textContent).not.toContain('🤝 Accept Offer');
    });

    it('an offer to help with a recurring Need already being helped with: the same, and the deal shows for the one paid', async () => {
        await open(STALL, () => dealOpen('tx-stall'));
        await press('✋ Offer to Fulfill');
        await press('Confirm');

        expect(net.calls).toContain('db.requestMarketplacePost');
        expect(alerts.said).toEqual(['Already under way', DEAL_OPEN_WORDS]);
        expect(sync.asked).toBe(1);
        expect(host.textContent).not.toContain('Offer to Fulfill?');

        await syncLands(STALL_DEAL);
        expect(host.textContent).toContain('⏳ Pending Release by Kofi');
        expect(host.textContent).toContain('❌ Cancel Trust Hold');
        expect(host.textContent).not.toContain('✋ Offer to Fulfill');
    });

    it('any other refusal is as it was: the node\'s words under Error, no sync, the confirmation left open', async () => {
        await open(COURSE, () => Object.assign(new Error('Insufficient balance to accept this offer'), { status: 400, nodeAnswered: true }));
        await press('🤝 Accept Offer');
        await press('Confirm');
        expect(alerts.said).toEqual(['Error', 'Insufficient balance to accept this offer']);
        expect(sync.asked).toBe(0);
        expect(host.textContent).toContain('Accept this Offer?');
    });
});
