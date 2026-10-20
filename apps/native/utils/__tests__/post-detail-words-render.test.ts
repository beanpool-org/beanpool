// @vitest-environment jsdom
/**
 * A listing's own page in the member's language (words slice S3, sweep B1): app/post/[id].tsx rendered for real inside
 * the real LanguageProvider, with its photo viewer and review sheet drawn for real, in every state a member meets: another
 * member's Offer to accept (the confirmation, by the job and by the hour), the report form and the block question; the
 * member's own Need with requests to approve or deny (and the decline note), its edit form, a paused offer; a deal held in
 * trust, as the one who pays and as the one paid; a finished deal to rate; the Daily Pulse; a community with Beans off.
 *
 * In the pseudo-locale (`xx`) any text, screen-reader label, hint, placeholder, picker item, alert title, body or button
 * with letters outside a bracket bypassed t(), except what members wrote (titles, descriptions, names, a group's name) and
 * what the node said (an error's own sentence, slice S4). The market-words-render.test.ts harness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    category: 'transport', author_pubkey: KOFI.pubkey, author_callsign: KOFI.callsign, credits: 12, price_type: 'fixed',
    photos: JSON.stringify(['https://mullum.example/p/1.jpg', 'https://mullum.example/p/2.jpg']), repeatable: 1, cash_also_needed: 1,
    audience_scope: 'group', target_group_id: 'g1', target_group_name: 'Garden club', created_at: iso(now - 3 * 60 * 60_000),
};
const HOURLY = { ...OFFER, id: 'p-hourly', price_type: 'hourly', target_group_id: null, audience_scope: 'public', cash_also_needed: 0, repeatable: 0 };
/** The member's own Need, with two requests waiting. */
const NEED = {
    id: 'p-need', type: 'need', status: 'active', title: 'Help moving a sofa', description: 'Second floor, no lift', category: 'labour',
    author_pubkey: ME.publicKey, author_callsign: ME.callsign, credits: 20, price_type: 'hourly', photos: '[]', created_at: iso(now - 26 * 60 * 60_000),
};
const REQUESTS = [
    { id: 'tx-r1', post_id: 'p-need', status: 'requested', buyer_pubkey: ME.publicKey, seller_pubkey: KOFI.pubkey, seller_callsign: KOFI.callsign, credits: 40, hours: 2 },
    { id: 'tx-r2', post_id: 'p-need', status: 'requested', buyer_pubkey: ME.publicKey, seller_pubkey: 'mia-key', seller_callsign: 'Mia', credits: 20, hours: null },
];
/** A deal held in trust on Kofi's Offer: the member pays. */
const HELD = { ...HOURLY, id: 'p-held', status: 'pending', pending_transaction_id: 'tx-held' };
const HELD_TX = { id: 'tx-held', post_id: 'p-held', status: 'pending', buyer_pubkey: ME.publicKey, seller_pubkey: KOFI.pubkey, seller_callsign: KOFI.callsign, credits: 24, hours: 2 };
/** The member's own Offer held in trust: the member is paid. */
const MINE_HELD = { ...HOURLY, id: 'p-mine-held', status: 'pending', author_pubkey: ME.publicKey, author_callsign: ME.callsign, accepted_by: KOFI.pubkey, accepted_by_callsign: KOFI.callsign, pending_transaction_id: 'tx-mine' };
const MINE_HELD_TX = { id: 'tx-mine', post_id: 'p-mine-held', status: 'pending', buyer_pubkey: KOFI.pubkey, buyer_callsign: KOFI.callsign, seller_pubkey: ME.publicKey, credits: 24, hours: 2 };
const DONE = { ...OFFER, id: 'p-done', status: 'completed', target_group_id: null, audience_scope: 'public', pending_transaction_id: 'tx-done', accepted_by: ME.publicKey };
const PAUSED = { ...HOURLY, id: 'p-paused', status: 'paused', author_pubkey: ME.publicKey, author_callsign: ME.callsign };
const PULSE = { id: 'p-pulse', type: 'offer', status: 'active', title: 'Gift economies grow trust', description: 'Today’s thought.', category: 'general', author_pubkey: 'pulse-key', author_callsign: 'Daily Pulse', credits: 0, price_type: 'fixed', photos: '[]', created_at: iso(now - 60_000) };

/** What members and the node wrote: shown as written. */
const OTHERS = [
    ...[OFFER, NEED, PULSE].flatMap((p) => [p.title, p.description]),
    KOFI.callsign, 'Mia', ME.callsign, 'Garden club', 'Daily Pulse',
].sort((a, b) => b.length - a.length);

function answers(post: Record<string, unknown>, db: { first?: (sql: string) => unknown; all?: (sql: string) => unknown[] } = {}) {
    const database = {
        getFirstAsync: async (sql: string) => db.first?.(sql) ?? null,
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
/** A button by its words in the pseudo-locale; for a sentence with a {name} in it, by the words before the name. */
const press = async (text: string) => {
    const want = pseudoLocalise(text).split('{')[0];
    const el = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(want) || b.getAttribute('aria-label') === want);
    expect(el, text).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};

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
const bracketed = () => Array.from(host.querySelectorAll('span')).filter((s) => /^\[.*\]$/su.test(s.textContent ?? '')).length;

describe("a listing's page in the pseudo-locale: every word on it came through t() (words S3b)", () => {
    it("another member's Offer: the badges, the price, the poster, the photos; accepting it; the report form; blocking", async () => {
        await open(OFFER);
        expect(host.textContent).toContain('Bike repairs at home');
        expect(host.querySelector(`img[aria-label="${pseudoLocalise('Photo {n} of {count}').replace('{n}', '1').replace('{count}', '2')}"]`)).not.toBeNull();
        expect(bracketed()).toBeGreaterThan(10);
        expect(bypassing(), 'the page').toEqual([]);
        await press('🤝 Accept Offer');
        expect(host.textContent).toContain(pseudoLocalise('🔒 Trust Wallet Protocol'));
        expect(bypassing(), 'the confirmation').toEqual([]);
        await press('Report Post');
        expect(host.textContent).toContain(pseudoLocalise('SELECT REPORT REASON'));
        await press('Spam or scam');
        expect(bypassing(), 'the report form').toEqual([]);
        await press('Block User');
        expect(alerts.said.length).toBeGreaterThan(2);
        expect(bypassing(), 'the block question').toEqual([]);
    });

    it('an Offer by the hour: the confirmation asks the hours; a profile with no photo is asked for one first', async () => {
        await open(HOURLY);
        await press('🤝 Accept Offer');
        expect(host.textContent).toContain(pseudoLocalise('TRUST COMMITMENT (HOURS)'));
        expect(bypassing()).toEqual([]);
        root.unmount();
        root = createRoot(host);
        profile.status = { complete: false, missingName: false, missingAvatar: true };
        await open(HOURLY);
        await press('🤝 Accept Offer');
        expect(alerts.said).toContain(pseudoLocalise('Finish your profile first'));
        expect(bypassing()).toEqual([]);
    });

    it('a lendable Offer is asked for, never taken in one step (Free and priced); then the borrower waits for the yes', async () => {
        const LENT = { ...OFFER, id: 'p-lent', credits: 0, lendable: 1, audience_scope: 'public', target_group_id: null, cash_also_needed: 0 };
        await open(LENT);
        expect(host.textContent).not.toContain(pseudoLocalise('🤝 Accept Offer'));
        await press('📦 Ask to borrow');
        expect(host.textContent).toContain(pseudoLocalise('Ask to borrow this?'));
        expect(host.textContent).toContain(pseudoLocalise('Free to borrow. Nothing is held: the lender says yes first.'));
        expect(bypassing(), 'the ask').toEqual([]);
        await press('Confirm');
        expect(net.calls).toContain('db.requestMarketplacePost');
        expect(net.calls).not.toContain('db.acceptMarketplacePost');

        act(() => root.unmount());
        root = createRoot(host);
        net.calls.length = 0;
        await open({ ...LENT, id: 'p-lent-fee', credits: 8 });
        await press('📦 Ask to borrow');
        expect(host.textContent).toContain(pseudoLocalise('Nothing is held until the lender says yes. Then the fee goes into a temporary Trust Wallet, and once it is back the lender receives it net of 1.5% transaction fee {owned} to fund the Commons Pool.').split('{owned}')[0]);
        expect(bypassing(), 'the priced ask').toEqual([]);
        await press('Confirm');
        expect(net.calls).toContain('db.requestMarketplacePost');
        expect(net.calls).not.toContain('db.acceptMarketplacePost');

        act(() => root.unmount());
        root = createRoot(host);
        const ASKED = [{ id: 'tx-ask', post_id: 'p-lent', status: 'requested', buyer_pubkey: ME.publicKey, seller_pubkey: KOFI.pubkey, seller_callsign: KOFI.callsign, credits: 0, hours: 3 }];
        await open(LENT, 'xx', { all: (sql) => (sql.includes("status='requested'") ? ASKED : []) });
        expect(host.textContent).toContain(pseudoLocalise('Asked to borrow'));
        expect(host.textContent).toContain(pseudoLocalise('Nothing is held until the lender says yes.'));
        expect(host.textContent).not.toContain(pseudoLocalise('Deal Established'));
        expect(bypassing(), 'the ask waiting').toEqual([]);
    });

    it("the member's own Need: its requests to approve or deny, the decline note, and its edit form", async () => {
        await open(NEED, 'xx', { all: (sql) => (sql.includes("status='requested'") ? REQUESTS : []) });
        expect(host.textContent).toContain('Mia');
        expect(bypassing(), 'requests').toEqual([]);
        await press('Deny');
        expect(host.textContent).toContain(pseudoLocalise('Decline Offer'));
        expect(bypassing(), 'the decline note').toEqual([]);
        await press('Cancel');
        await press('✏️ Edit Post');
        expect(host.querySelectorAll('option').length).toBeGreaterThan(10);
        expect(bypassing(), 'the edit form').toEqual([]);
    });

    it('requests word quantity in the price’s unit: daily says days, fixed lendable loan says days, hourly says hours', async () => {
        // Hourly deal unchanged
        await open(NEED, 'xx', { all: (sql) => (sql.includes("status='requested'") ? REQUESTS : []) });
        expect(host.textContent).toContain(pseudoLocalise('{n} hours estimated').replace('{n}', '2'));
        expect(bypassing(), 'hourly requests').toEqual([]);

        // Daily deal as days
        act(() => root.unmount());
        root = createRoot(host);
        const DAILY_NEED = { ...NEED, id: 'p-daily-need', price_type: 'daily' };
        await open(DAILY_NEED, 'xx', { all: (sql) => (sql.includes("status='requested'") ? REQUESTS : []) });
        expect(host.textContent).toContain(pseudoLocalise('{n} days').replace('{n}', '2'));
        expect(bypassing(), 'daily requests').toEqual([]);

        // Fixed lendable loan as days
        act(() => root.unmount());
        root = createRoot(host);
        const LENDABLE_OFFER = { ...OFFER, id: 'p-loan', author_pubkey: ME.publicKey, author_callsign: ME.callsign, price_type: 'fixed', lendable: 1 };
        const LOAN_REQUESTS = [{ id: 'tx-loan', post_id: 'p-loan', status: 'requested', buyer_pubkey: KOFI.pubkey, buyer_callsign: KOFI.callsign, credits: 0, hours: 3 }];
        await open(LENDABLE_OFFER, 'xx', { all: (sql) => (sql.includes("status='requested'") ? LOAN_REQUESTS : []) });
        expect(host.textContent).toContain(pseudoLocalise('for {n} days').replace('{n}', '3'));
        expect(bypassing(), 'loan requests').toEqual([]);

        // Weekly lendable loan as weeks
        act(() => root.unmount());
        root = createRoot(host);
        const WEEKLY_LENDABLE_OFFER = { ...OFFER, id: 'p-loan-wk', author_pubkey: ME.publicKey, author_callsign: ME.callsign, price_type: 'weekly', lendable: 1 };
        const WEEKLY_LOAN_REQUESTS = [{ id: 'tx-loan-wk', post_id: 'p-loan-wk', status: 'requested', buyer_pubkey: KOFI.pubkey, buyer_callsign: KOFI.callsign, credits: 0, hours: 2 }];
        await open(WEEKLY_LENDABLE_OFFER, 'xx', { all: (sql) => (sql.includes("status='requested'") ? WEEKLY_LOAN_REQUESTS : []) });
        expect(host.textContent).toContain(pseudoLocalise('for {n} weeks').replace('{n}', '2'));
        expect(bypassing(), 'weekly loan requests').toEqual([]);

        // Fixed non-loan: no quantity unit line
        act(() => root.unmount());
        root = createRoot(host);
        const FIXED_NEED = { ...NEED, id: 'p-fixed-need', price_type: 'fixed' };
        await open(FIXED_NEED, 'xx', { all: (sql) => (sql.includes("status='requested'") ? REQUESTS : []) });
        expect(host.textContent).not.toContain('estimated');
        expect(bypassing(), 'fixed non-loan requests').toEqual([]);

        // Fixed non-loan need commitment: no hours in commitment sentence
        act(() => root.unmount());
        root = createRoot(host);
        const OTHER_FIXED_NEED = { ...NEED, id: 'p-other-fixed-need', author_pubkey: KOFI.pubkey, author_callsign: KOFI.callsign, price_type: 'fixed' };
        const MY_FIXED_NEED_REQUEST = [{ id: 'tx-req-fixed', post_id: 'p-other-fixed-need', status: 'requested', buyer_pubkey: KOFI.pubkey, seller_pubkey: ME.publicKey, seller_callsign: ME.callsign, credits: 20, hours: 2 }];
        await open(OTHER_FIXED_NEED, 'xx', { all: (sql) => (sql.includes("status='requested'") ? MY_FIXED_NEED_REQUEST : []) });
        expect(host.textContent).toContain(pseudoLocalise('Deal Established'));
        expect(host.textContent).not.toContain(pseudoLocalise('{hours} hours').replace('{hours}', '2'));
        expect(bypassing(), 'fixed need commitment').toEqual([]);

        // In English: words read as expected
        act(() => root.unmount());
        root = createRoot(host);
        await open(NEED, 'en', { all: (sql) => (sql.includes("status='requested'") ? REQUESTS : []) });
        expect(host.textContent).toContain('2 hours estimated');

        act(() => root.unmount());
        root = createRoot(host);
        await open(DAILY_NEED, 'en', { all: (sql) => (sql.includes("status='requested'") ? REQUESTS : []) });
        expect(host.textContent).toContain('2 days');

        act(() => root.unmount());
        root = createRoot(host);
        await open(LENDABLE_OFFER, 'en', { all: (sql) => (sql.includes("status='requested'") ? LOAN_REQUESTS : []) });
        expect(host.textContent).toContain('for 3 days');

        act(() => root.unmount());
        root = createRoot(host);
        await open(WEEKLY_LENDABLE_OFFER, 'en', { all: (sql) => (sql.includes("status='requested'") ? WEEKLY_LOAN_REQUESTS : []) });
        expect(host.textContent).toContain('for 2 weeks');

        act(() => root.unmount());
        root = createRoot(host);
        await open(OTHER_FIXED_NEED, 'en', { all: (sql) => (sql.includes("status='requested'") ? MY_FIXED_NEED_REQUEST : []) });
        expect(host.textContent).toContain('Deal Established');
        expect(host.textContent).toContain('You have requested to earn 20 credits (19.70 net after 1.5% transaction fee)');
        expect(host.textContent).not.toContain('hours');
    });

    it('a deal held in trust: the one who pays, releasing the credits by the hour', async () => {
        await open(HELD, 'xx', { first: (sql) => (sql.includes('marketplace_transactions') ? HELD_TX : null) }, 'tx-held');
        expect(host.textContent).toContain(pseudoLocalise('✅ Action Required: Release Credits'));
        expect(bypassing(), 'held').toEqual([]);
        await press('✅ Release Credits');
        expect(host.textContent).toContain(pseudoLocalise('CONFIRM ACTUAL HOURS WORKED'));
        expect(bypassing(), 'release').toEqual([]);
        await press('❌ Cancel Trust Hold');
        expect(bypassing(), 'the cancel question').toEqual([]);
    });

    it('a deal held in trust: the one paid', async () => {
        await open(MINE_HELD, 'xx', { first: (sql) => (sql.includes('marketplace_transactions') ? MINE_HELD_TX : null) }, 'tx-mine');
        expect(host.textContent).toContain(pseudoLocalise('Note: If this post is still visible here, you have not yet received your credits.'));
        expect(bypassing()).toEqual([]);
    });

    it('a finished deal: rating the other member', async () => {
        await open(DONE);
        await press('★ Rate {name}');
        expect(bypassing()).toEqual([]);
    });

    it('a paused offer of the member\'s own; the Daily Pulse; a community with Beans off', async () => {
        await open(PAUSED);
        expect(host.textContent).toContain(pseudoLocalise('⏸️ Offer paused'));
        expect(bypassing(), 'paused').toEqual([]);
        root.unmount();
        root = createRoot(host);
        await open(PULSE);
        expect(host.textContent).toContain(pseudoLocalise('Feeling Inspired?'));
        expect(bypassing(), 'the Pulse').toEqual([]);
        root.unmount();
        root = createRoot(host);
        rememberProfile({ ...LOCAL, beans: false, escrow: false });
        await open(OFFER);
        expect(host.querySelector('[data-testid="no-beans-terms"]')).not.toBeNull();
        expect(bypassing(), 'Beans off').toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        await open(OFFER, 'en');
        expect(bracketed()).toBe(0);
        expect(host.textContent).toContain('● OFFER · TRANSPORT · RECURRING');
        expect(host.textContent).toContain('Only Garden club can see this');
        expect(host.textContent).toContain('💸 Cash also needed for fuel or materials, at cost.');
        expect(host.textContent).toContain('(4.5) • 3 Reviews');
        expect(host.textContent).toContain('ASKING PRICE');
        expect(host.querySelector('img[aria-label="Photo 2 of 2"]')).not.toBeNull();
    });
});

describe('the review sheet after a deal, in the pseudo-locale', () => {
    it('its title, the question with the name in it, the stars, the note and both buttons', async () => {
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'xx' },
                createElement(ReviewModal, { visible: true, txId: 'tx-done', targetPubkey: KOFI.pubkey, targetCallsign: KOFI.callsign, onClose: () => {}, onSuccess: () => {} })) as any);
        });
        net.answer = answers(DONE);
        await settle();
        expect(host.textContent).toContain('Kofi');
        expect(host.textContent).toContain(pseudoLocalise('Deal Complete!'));
        expect(bypassing()).toEqual([]);
    });
});

describe("the listing's type and category line in capitals, the language's way", () => {
    it('Greek: the category drops its accents in capitals (never toUpperCase on a translated word)', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const el = JSON.parse(readFileSync(resolve(__dirname, '../../words/el.json'), 'utf8')) as Record<string, string>;
        const transport = el['Transport'];
        expect(transport.toUpperCase()).not.toBe(transport.toLocaleUpperCase('el'));
        await open(OFFER, 'el');
        expect(host.textContent).toContain('Bike repairs at home');
        expect(host.textContent).toContain(`· ${transport.toLocaleUpperCase('el')}`);
        expect(host.textContent).not.toContain(transport.toUpperCase());
    });
});

describe('the page at 320 dp with 1.3× text: the fixed-width words shrink to fit rather than being cut', () => {
    it('Back grows to 120 dp and then shrinks; Deny and Approve & Commit stay one line, shrinking', async () => {
        await open(NEED, 'xx', { all: (sql) => (sql.includes("status='requested'") ? REQUESTS : []) });
        const back = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(pseudoLocalise('Back')))!;
        expect(back.getAttribute('data-max-width')).toBe('120');
        for (const word of ['Back', 'Deny', 'Approve & Commit']) {
            const label = Array.from(host.querySelectorAll('span[data-shrinks]')).find((s) => s.textContent === pseudoLocalise(word));
            expect(label, word).toBeTruthy();
            expect(label!.getAttribute('data-lines')).toBe('1');
            expect(Number(label!.getAttribute('data-min-scale'))).toBeLessThanOrEqual(0.7);
        }
    });
});
