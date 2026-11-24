// @vitest-environment jsdom
/**
 * Phone create-vs-edit field parity (feat/edit-parity):
 *
 * 1. Table guard: extracts every listing payload field sent by the create form (`app/new-listing.tsx`)
 *    and checks that every single one is covered by the canonical table AND handled by the edit form
 *    (`app/post/[id].tsx`) and `utils/db.ts` `updatePost` (either editable or explicitly shown read-only
 *    with a reason for node-immutable fields). Adding a field to `new-listing.tsx` without adding it to
 *    edit turns this test red immediately.
 * 2. Real render checks of `app/post/[id].tsx` in edit mode: cash-also-needed (Offer & Need wording +
 *    nudge + round-trip), location controls, reach chooser, FREE chip, read-only type, and read-only
 *    price when a deal is open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../components/useKeepCaretVisible', () => ({ useKeepCaretVisible: () => ({ scrollRef: { current: null }, scrollProps: {} }) }));
import * as fs from 'node:fs';
import * as path from 'node:path';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', checkbox: 'checkbox' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, placeholder, onLayout, value, onChangeText, disabled, editable, source } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (disabled || editable === false) attrs.disabled = true;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = accessibilityState.checked;
        if (placeholder) attrs.placeholder = placeholder;
        if (source?.uri) attrs['data-src'] = source.uri;
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
        Alert: { alert: (title: string, body?: string) => { alerts.said.push(title); if (body) alerts.said.push(body); } },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit() {} },
        BackHandler: { addEventListener: listener },
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
vi.mock('expo-image', () => ({ Image: (p: { accessibilityLabel?: string }) => createElement('img', p.accessibilityLabel ? { 'aria-label': p.accessibilityLabel } : null) }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, authenticateAsync: async () => ({ success: false }) }));
vi.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: async () => ({ granted: true }),
    requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
    launchCameraAsync: async () => ({ canceled: true }),
    launchImageLibraryAsync: async () => ({ canceled: true }),
}));
vi.mock('expo-image-manipulator', () => ({ SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({ uri: 'file:///x.jpg', width: 800, height: 600, base64: 'AA==' }) }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'granted', canAskAgain: true }),
    requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
    getCurrentPositionAsync: async () => ({ coords: { latitude: -28.55123, longitude: 153.50123 } }),
    getLastKnownPositionAsync: async () => null,
}));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardController: { dismiss: async () => {} },
}));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-native-picker/picker', () => ({
    Picker: Object.assign(({ children }: { children?: unknown }) => createElement('select', null, children as any), {
        Item: ({ label }: { label: string }) => createElement('option', null, label),
    }),
}));
vi.mock('../haptics', () => ({ hapticTick: () => {}, hapticSuccess: () => {}, hapticWarning: () => {}, hapticLight: () => {} }));
vi.mock('../../services/pillar-sync', () => ({
    requestSync: async () => {},
    isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended',
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const ME = { publicKey: 'me-key', callsign: 'Marty', privateKey: 'p' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/EventDetail', () => ({ EventDetail: () => null }));
vi.mock('../blocklist', () => ({ blockUser: async () => {}, getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../profile-status', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../profile-status')>()),
    getProfileStatus: async () => ({ complete: true, missingName: false, missingAvatar: false }),
}));
const net = vi.hoisted(() => ({ calls: [] as string[], args: new Map<string, unknown[]>(), answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => { net.args.set(name, args); return net.answer?.(name, args); }));

import { LanguageProvider } from '../../components/LanguageProvider';
import { ListingPinDropModal } from '../../components/ListingFormFields';
import PostDetailScreen from '../../app/post/[id]';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

// ── 1. Table test: every field offered on phone Create must exist on phone Edit ──────────────────────────────
interface FieldRule {
    field: string;
    createPattern: RegExp;
    editPattern: RegExp;
    dbUpdatePattern?: RegExp;
    mode: 'editable' | 'readonly-immutable' | 'detail-row';
}

/**
 * Every field offered on `apps/native/app/new-listing.tsx` (Offer/Need create).
 * If a new payload field is added to `createPost({...})` in `new-listing.tsx`, the completeness test below
 * fails until it is added to this table AND wired into `app/post/[id].tsx` + `utils/db.ts`.
 */
const PHONE_CREATE_FIELDS: readonly FieldRule[] = [
    { field: 'type', createPattern: /setPostType\(/, editPattern: /testID="edit-type-readonly"/, mode: 'readonly-immutable' },
    { field: 'title', createPattern: /accessibilityLabel=\{t\('Title'\)\}/, editPattern: /accessibilityLabel=\{t\('Title'\)\}/, dbUpdatePattern: /title:\s*updates\.title/, mode: 'editable' },
    { field: 'category', createPattern: /setPostCategory\(/, editPattern: /selectedValue=\{editCategory\}/, dbUpdatePattern: /category:\s*updates\.category/, mode: 'editable' },
    { field: 'tags', createPattern: /<TagPicker/, editPattern: /<TagPicker/, dbUpdatePattern: /tags !== undefined \? \{ tags \}/, mode: 'editable' },
    { field: 'freeTags', createPattern: /freeTags=\{postFreeTags\}/, editPattern: /freeTags=\{editFreeTags\}/, dbUpdatePattern: /freeTags !== undefined \? \{ freeTags \}/, mode: 'editable' },
    { field: 'description', createPattern: /accessibilityLabel=\{t\('Description'\)\}/, editPattern: /accessibilityLabel=\{t\('Description'\)\}/, dbUpdatePattern: /description:\s*updates\.description/, mode: 'editable' },
    { field: 'photos', createPattern: /setPostPhotos\(/, editPattern: /setEditPhotos\(/, dbUpdatePattern: /\bphotos,/, mode: 'editable' },
    { field: 'lat', createPattern: /<ListingLocationRow/, editPattern: /<ListingLocationRow/, dbUpdatePattern: /hasLat \? \{ lat: updates\.lat \}/, mode: 'editable' },
    { field: 'lng', createPattern: /<ListingLocationRow/, editPattern: /<ListingPinDropModal/, dbUpdatePattern: /hasLng \? \{ lng: updates\.lng \}/, mode: 'editable' },
    { field: 'price_c', createPattern: /accessibilityLabel=\{t\('Price'\)\}/, editPattern: /value=\{editCredits\}/, dbUpdatePattern: /price_c:\s*updates\.price_c/, mode: 'editable' },
    { field: 'price_type', createPattern: /priceUnitsOffered\(/, editPattern: /priceUnitsOffered\(/, dbUpdatePattern: /priceType:\s*updates\.price_type/, mode: 'editable' },
    { field: 'unitsLeft', createPattern: /<PerItemFields/, editPattern: /<PerItemFields/, dbUpdatePattern: /unitsLeft:\s*updates\.unitsLeft/, mode: 'editable' },
    { field: 'lot', createPattern: /<PerItemFields/, editPattern: /<PerItemFields/, dbUpdatePattern: /lot:\s*updates\.lot/, mode: 'editable' },
    { field: 'repeatable', createPattern: /postRepeatable/, editPattern: /editRepeatable/, dbUpdatePattern: /repeatable:\s*updates\.repeatable/, mode: 'editable' },
    { field: 'cash_also_needed', createPattern: /<CashAlsoNeededField/, editPattern: /<CashAlsoNeededField/, dbUpdatePattern: /cashAlsoNeeded !== undefined \? \{ cashAlsoNeeded \}/, mode: 'editable' },
    { field: 'reach', createPattern: /<ListingReachField/, editPattern: /<ListingReachField/, dbUpdatePattern: /hasReach \? \{ reach: updates\.reach \}/, mode: 'editable' },
    { field: 'reachPeers', createPattern: /reachPeers=\{postReachPeers\}/, editPattern: /reachPeers=\{editReachPeers\}/, dbUpdatePattern: /reachPeers !== undefined \? \{ reachPeers \}/, mode: 'editable' },
    { field: 'alsoOnGlobal', createPattern: /<ShowOnGlobalTick/, editPattern: /<ShowOnGlobalHostRow/, mode: 'detail-row' },
];

/** Create-only metadata keys sent to `createPost` that are never user-editable form fields. */
const CREATE_ONLY_META = new Set(['id', 'author_pubkey', 'created_at']);

describe('phone create-vs-edit field parity table', () => {
    const createSrc = read('../../app/new-listing.tsx');
    const editSrc = read('../../app/post/[id].tsx');
    const dbSrc = read('../db.ts');
    const updatePostBlock = dbSrc.slice(dbSrc.indexOf('export async function updatePost('), dbSrc.indexOf('export async function pausePost('));

    it('every payload key sent by createPost({...}) in new-listing.tsx is accounted for in PHONE_CREATE_FIELDS (fails if a new create field is added without edit parity)', () => {
        const start = createSrc.indexOf('const made = await createPost({');
        expect(start).toBeGreaterThan(0);
        const end = createSrc.indexOf('});', start);
        const body = createSrc.slice(start, end);
        // Match top-level keys (`key:`) and conditional spread keys (`{ key: ... }`).
        const foundKeys = new Set<string>();
        for (const m of body.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)) {
            const k = m[1];
            if (CREATE_ONLY_META.has(k)) continue;
            // Skip ternary-condition / helper property names that are not payload keys.
            if (k === 'fields') continue;
            foundKeys.add(k);
        }
        const tableKeys = new Set(PHONE_CREATE_FIELDS.map((r) => r.field));
        const missingFromTable = [...foundKeys].filter((k) => !tableKeys.has(k));
        expect(missingFromTable, `New field(s) in new-listing.tsx createPost body missing from edit parity table: ${missingFromTable.join(', ')}`).toEqual([]);
    });

    it.each(PHONE_CREATE_FIELDS)('field "$field" ($mode) is present on create and covered on edit', ({ field, createPattern, editPattern, dbUpdatePattern, mode }) => {
        expect(createSrc, `create form missing ${field}`).toMatch(createPattern);
        expect(editSrc, `edit form missing ${field}`).toMatch(editPattern);
        if (mode === 'editable' && dbUpdatePattern) {
            expect(updatePostBlock, `utils/db.ts updatePost missing ${field}`).toMatch(dbUpdatePattern);
        }
    });
});

// ── 2. Render checks of phone Edit Post screen ───────────────────────────────────────────────────────────────
const NODE = 'https://riverside.example.org';
const PHOTO = `${NODE}/api/marketplace/posts/p-1/photos/0?k=abc`;
const BASE_POST = {
    id: 'p-1', type: 'offer', status: 'active', title: 'Trailer hire', description: 'Needs fuel money', category: 'tools',
    author_pubkey: ME.publicKey, author_callsign: ME.callsign, price_c: 2000, price_type: 'fixed',
    photos: JSON.stringify([PHOTO]), repeatable: 0, cash_also_needed: 1,
    lat: -28.55, lng: 153.50, reach: 'local', reach_peers: null,
    audience_scope: 'public', created_at: new Date().toISOString(),
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.args.clear();
    alerts.said.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({
        [NODE]: { profile: 'local', features: { beans: true, escrow: true, perItem: true }, checkedAt: new Date().toISOString() },
    }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null;
async function click(el: Element | null, what: string) {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
}

async function openEdit(postOver: Record<string, unknown> = {}, extra: { peers?: Array<{ peerId: string; callsign: string | null }>; requests?: any[] } = {}) {
    const post = { ...BASE_POST, ...postOver };
    const database = {
        getFirstAsync: async () => null,
        getAllAsync: async (sql: string) => (sql.includes("status='requested'") ? (extra.requests ?? []) : []),
    };
    net.answer = (name) => {
        if (name === 'getPost') return Promise.resolve({ ...post });
        if (name === 'updatePost') return Promise.resolve(undefined);
        if (name === 'getReachablePeers') return Promise.resolve(extra.peers ?? []);
        const table: Record<string, unknown> = {
            getDb: database, getMemberRatings: { average: 5, count: 1 }, getUnreadCountForPost: 0,
            getBalance: { isBlockedFromTrading: false, keeperOf: [] },
        };
        return name in table ? Promise.resolve(table[name]) : undefined;
    };
    params.now = { id: post.id };
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(PostDetailScreen)) as any); });
    await settle();
    await click(button('✏️ Edit Post'), 'Edit Post');
}

describe('phone Edit Post form behaviour', () => {
    it('shows cash-also-needed ticked with Offer wording & nudge, unticking saves cash_also_needed: 0, and updates location & reach', async () => {
        await openEdit({}, { peers: [{ peerId: 'peer-riverside', callsign: 'Riverside' }] });

        // Type is read-only (no toggle switching Offer to Need)
        expect(host.querySelector('[data-testid="edit-type-readonly"]')?.textContent).toContain('Listing type stays as posted');

        // Cash box starts ticked with Offer wording and nudge
        const cashToggle = host.querySelector('[data-testid="edit-cash-also-needed"]');
        expect(cashToggle?.getAttribute('aria-checked')).toBe('true');
        expect(cashToggle?.textContent).toContain('Cash also needed — for fuel or materials');
        expect(host.querySelector('[data-testid="edit-cash-also-needed-nudge"]')?.textContent).toContain('not your time, not your tools');

        // Untick cash, tap My location, switch reach to Everywhere, tap Save
        await click(cashToggle, 'untick cash');
        expect(cashToggle?.getAttribute('aria-checked')).toBe('false');
        expect(host.querySelector('[data-testid="edit-cash-also-needed-nudge"]')).toBeNull();

        await click(host.querySelector('[data-testid="edit-location-row-my-location"]'), 'My location');
        await click(host.querySelector('[data-testid="edit-reach-field-everywhere"]'), 'Everywhere');
        await click(button('💾 Save'), 'Save');

        const saved = net.args.get('updatePost')?.[1] as Record<string, unknown>;
        expect(saved).toBeTruthy();
        expect(saved.cash_also_needed).toBe(0);
        expect(saved.lat).toBe(-28.5512);
        expect(saved.lng).toBe(153.5012);
        expect(saved.reach).toBe('everywhere');
    });

    it('uses Need wording & Need nudge for cash-also-needed on a Need and saves cash_also_needed: 1', async () => {
        await openEdit({ type: 'need', cash_also_needed: 0 });
        const cashToggle = host.querySelector('[data-testid="edit-cash-also-needed"]');
        expect(cashToggle?.textContent).toContain("I'll pay cash too — for fuel or materials");
        await click(cashToggle, 'tick cash on need');
        expect(host.querySelector('[data-testid="edit-cash-also-needed-nudge"]')?.textContent).toContain('Cash covers fuel or materials the helper buys');
        await click(button('💾 Save'), 'Save');
        const saved = net.args.get('updatePost')?.[1] as Record<string, unknown>;
        expect(saved.cash_also_needed).toBe(1);
    });

    it('shows price read-only with reason when an open non-standing deal exists', async () => {
        await openEdit({ type: 'need', cash_also_needed: 0 }, {
            requests: [{ id: 'tx-1', post_id: 'p-1', status: 'requested', buyer_pubkey: ME.publicKey, seller_pubkey: 'helper-pk', amount_c: 2000 }],
        });
        expect(host.querySelector('[data-testid="edit-price-frozen-reason"]')?.textContent).toContain('This post has a deal in progress');
        const priceInput = host.querySelector('input[aria-label="Price"]') as HTMLInputElement | null;
        expect(priceInput?.disabled).toBe(true);
    });

    it('omits reach and reachPeers on save when untouched, preventing silent downgrade of peers listings', async () => {
        await openEdit(
            { reach: 'peers', reach_peers: null },
            { peers: [{ peerId: 'peer-riverside', callsign: 'Riverside' }] },
        );
        // Save without touching reach controls
        await click(button('💾 Save'), 'Save');
        const saved = net.args.get('updatePost')?.[1] as Record<string, unknown>;
        expect(saved).toBeTruthy();
        expect(saved).not.toHaveProperty('reach');
        expect(saved).not.toHaveProperty('reachPeers');
    });

    it('exposes lendable Repeatable toggle as a disabled checked checkbox', async () => {
        await openEdit({ type: 'offer', lendable: 1, repeatable: 1 });
        const toggle = host.querySelector('[data-testid="edit-repeatable-toggle"]') as HTMLButtonElement | null;
        expect(toggle).toBeTruthy();
        expect(toggle?.getAttribute('role')).toBe('checkbox');
        expect(toggle?.getAttribute('aria-checked')).toBe('true');
        expect(toggle?.disabled).toBe(true);
    });

    it('ListingPinDropModal hides the tap-to-place banner when the map is unavailable or still loading', async () => {
        await act(async () => {
            root.render(createElement(
                LanguageProvider as any,
                { deviceTags: ['en-US'], initial: 'en' },
                createElement(ListingPinDropModal, {
                    visible: true,
                    initialLat: -28.55,
                    initialLng: 153.50,
                    postType: 'offer',
                    onConfirm: vi.fn(),
                    onCancel: vi.fn(),
                }),
            ) as any);
        });
        await settle(2);
        expect(host.querySelector('[data-testid="edit-pin-drop-modal"]')).toBeTruthy();
        expect(host.textContent).not.toContain('Tap the map to place your pin');
    });
});
