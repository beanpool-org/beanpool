// @vitest-environment jsdom
/**
 * Settings: the words beside a switch leave a gap before it (Marty's Pixel, 1.3.2, Settings → Notifications: "Credits held in
 * trust, released, or disputed" ran right up to its switch). app/(tabs)/settings.tsx is rendered for real inside the real
 * LanguageProvider, React Native's host components are plain tags that write their flattened style into `data-style`, and
 * the tree is laid out with Yoga (yoga-dom-layout.ts, the engine a phone runs) in a 320 dp viewport at 1.3x text and in a
 * normal phone's, in English, in German and Russian (their machine drafts) and in the pseudo-locale (every sentence
 * padded ~35 %).
 *
 * What it proves: for EVERY switch row on the Settings menu and on Settings → Notifications (a `toggle`: 50 x 28), the
 * text column before it ends at least Spacing.sm (8) short of the switch, the switch keeps its 50 dp, and no line of the
 * column is cut to a number of lines (the words wrap). What it does not prove: pixels of words. Yoga here measures a Text by
 * a character-count rule (yoga-dom-layout.ts), so a text-heavy height is an estimate; the gap is a box, which Yoga gives
 * exactly. A control measures the same rows with the column's old style (`flex: 1` and nothing else), to show the check
 * sees the fault: that gap is 0, the screenshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { layOut } from './yoga-dom-layout';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', switch: 'switch', checkbox: 'checkbox' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, onLayout, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(props.style)) };
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        RefreshControl: () => null,
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: () => {} },
        Share: { share: async () => ({}) },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useLocalSearchParams: () => ({}),
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.map.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => store.map.delete(k)); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: async () => ({}), openAuthSessionAsync: async () => ({ type: 'cancel' }), maybeCompleteAuthSession: () => ({}) }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => createElement('div', { 'data-qr': 'true' }) }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
});
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: true }),
}));
vi.mock('expo-file-system/legacy', () => ({
    documentDirectory: 'file:///data/user/0/app/files/',
    getInfoAsync: async () => ({ exists: true, size: 5 * 1024 * 1024 + 123_456 }),
    readDirectoryAsync: async () => [],
    deleteAsync: async () => {},
}));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'granted', canAskAgain: true }),
    requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
}));
// Colours do not move a box: the light set stands for both.
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors, themePreference: 'light', setThemePreference() {}, patternEnabled: false, setPatternEnabled() {} }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});

const WORDS = 'apple banana cherry delta eagle fabric garden hollow island jungle kettle lemon';
const KEY = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
// One object for every render: Settings' effects run again when `identity` changes, and a fresh one each time never settles.
const who = vi.hoisted(() => ({ identity: null as any }));
who.identity = { publicKey: KEY, privateKey: 'me-priv', callsign: 'Ana', mnemonic: WORDS };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity, setIdentity() {} }) }));

// Shared with other screens: drawn as nothing here (their sweeps are the screens they share).
vi.mock('../../components/AvatarPickerSheet', () => ({ AvatarPickerSheet: () => null }));
vi.mock('../../components/KeeperProtectionPanel', () => ({ KeeperProtectionPanel: () => null }));
vi.mock('../../components/AddWordsForm', () => ({ AddWordsForm: () => null }));
vi.mock('../../components/RecoveryKitButtons', () => ({ RecoveryKitButtons: () => null }));
vi.mock('../../components/SsoEnrolSheet', () => ({ SsoEnrolSheet: () => null }));
vi.mock('../../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../../components/OneWayBackCard', () => ({ OneWayBackCard: () => null }));
vi.mock('../../components/WordsOnScreen', () => ({ NoScreenCapture: ({ children }: { children?: unknown }) => createElement('div', null, children as any), CopyClearsNote: () => null, NoScreenLockNote: () => null }));
vi.mock('../../components/NoWordsNotice', () => ({ NoWordsNotice: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ busy: false, start() {}, dialog: null }) }));

// The node (a small local community that sends the asked push) and the phone's lock.
vi.mock('../db', () => ({
    getMemberProfile: async () => ({ callsign: 'Ana', bio: 'Grows beans by the river', contact_value: '0400 000 000', contact_visibility: 'friends' }),
    updateMemberProfile: async () => {},
    signedRequest: async () => ({}),
    signedGet: async () => new Response(JSON.stringify({ show_as_connection_in_common: 'true' }), { status: 200 }),
    signedRequestWithMethod: async () => ({}),
    resetDmChatMemory: async () => ({ ok: true }),
    getDatabaseStats: async () => ({ members: 12, posts: 30, transactions: 4, messages: 51, integrity: 'ok' }),
    isFriendLocal: async () => true,
    removeFriendOnNode: async () => {},
    closeDB: async () => {}, initDB: async () => {}, clearDB: async () => {}, redeemInvite: async () => {}, syncMessages: async () => {},
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], unblockUser: async () => {}, clearBlocklist: async () => {}, BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../node-post', async (importOriginal) => {
    const { PURGE_NO_ANSWER, PURGE_TIMEOUT_MS } = await importOriginal<typeof import('../node-post')>();
    return {
        signedPost: async () => new Response(JSON.stringify({ keepers: [], enrolledSso: [], threshold: 1, recoverable: false, total: 0 }), { status: 200 }),
        signedGet: async () => new Response('{}', { status: 404 }),
        anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
        purgeAccountOnNode: async () => { throw new Error(PURGE_NO_ANSWER); },
        PURGE_NO_ANSWER, PURGE_TIMEOUT_MS,
    };
});
vi.mock('../membership-probe', () => ({ fetchMembership: async () => ({ ok: true, json: async () => ({ isMember: true }) }) }));
vi.mock('../node-admin', () => {
    // A plain member: no role, so Requests to join has a switch (knockSwitchShown).
    const askNodeRole = async () => ({ role: null, communityName: 'Mullum Commons' });
    return {
        askNodeRole,
        fetchMyNodeRole: async () => (await askNodeRole()),
        rememberNodeRole: () => {},
        canManageNode: (role: string | null) => role === 'owner' || role === 'admin' || role === 'moderator',
    };
});
vi.mock('../owner-words', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    fetchOwnerWordsStatus: async () => ({ owner: false, wordsCheckedAt: null }),
}));
vi.mock('../takeover-unlock', () => ({ readLockPin: async () => null, runLockOpenCheck: async () => {} }));
vi.mock('../LocalAuth', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    authenticateUser: async () => true,
    getAppLockEnabled: async () => false,
    getScreenLock: async () => 'none',
    setAppLockEnabled: async () => {},
    turnAppLockOnForRole: async () => 'already-on',
}));
vi.mock('../words-behind-lock', () => ({ readWordsBehindLock: async () => WORDS.split(' ') }));
vi.mock('../vault', async (importOriginal) => {
    const real = await importOriginal<Record<string, any>>();
    return {
        ...real,
        hasVault: () => false,
        signInCopiesAt: () => 'community',
        vaultCopyKnowledge: async () => 'known',
        vaultStatus: async () => ({ holds: [] }),
        approvedHolds: async () => [],
        forgetEndedApprovals: async () => {},
    };
});
vi.mock('../keeper-enrolment', () => ({
    vaultProtection: async () => ({ enrolled: [], generation: 1, skipped: [], available: 0, enrolledSso: [], threshold: 1, isSingleBlob: true }),
    enrolmentFromVault: () => ({ enrolled: [], generation: 1, skipped: [], available: 0, enrolledSso: [], threshold: 1, isSingleBlob: true }),
    disconnectSsoKeeper: async () => ({ success: true }),
}));
vi.mock('../vault-move', () => ({ vaultMoveOffer: async () => null, finishMove: async () => {}, moveLater: async () => {}, removeInstead: async () => true }));
vi.mock('../../services/pillar-sync', () => ({
    requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended',
    performSyncWhenFree: async () => ({ success: true }), forceResyncNotice: () => ({ title: 'Success', message: '' }), syncCursorKeysOf: () => [],
}));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'join' }));
vi.mock('../use-global-guest-visit', () => ({ useGlobalGuestVisit: () => ({ visit: async () => ({ kind: 'guest' }), visiting: false }) }));

import { type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { Spacing } from '../../constants/responsive';
import SettingsScreen from '../../app/(tabs)/settings';

const NODE = 'https://mullum.example';
/** styles.toggle in settings.tsx: the switch every row ends in. */
const TOGGLE = { width: 50, height: 28 };
/** The Settings menu's switches (Background pattern, App Lock, Location, Holiday Mode, Show me as a connection) and the Notifications screen's (Direct Messages, Marketplace, asked, Held in Trust, Requests to join). */
const MENU_SWITCHES = 5;
const NOTIFICATION_SWITCHES = 5;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({
        [NODE]: { profile: 'local', features: { beans: true, escrow: true, askedPush: true, nearbyListings: { radiusKm: 10, max: 500 } }, checkedAt: new Date().toISOString() },
    }));
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes('/api/members/preferences')) return new Response(JSON.stringify({ holiday_mode: 'false' }), { status: 200 });
        if (u.includes('/api/community/info')) return new Response(JSON.stringify({ memberCount: 14, postCount: 30, transactionCount: 9 }), { status: 200 });
        return new Response('{}', { status: 404 });
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const styleOf = (e: Element): Record<string, unknown> => JSON.parse(e.getAttribute('data-style') ?? '{}');

/** The screen drawn in `lang` inside a floor `width` dp wide, the way a phone of that width gives it. */
async function renderIn(lang: UiLang, width: number) {
    await act(async () => {
        root.render(createElement('div', { 'data-style': JSON.stringify({ width }), 'data-testid': 'floor' },
            createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(SettingsScreen))) as any);
    });
    await settle();
}
const floor = () => host.querySelector('[data-testid="floor"]')!;
/** Every `toggle` drawn now. */
const switches = () => Array.from(host.querySelectorAll('button')).filter((b) => {
    const s = styleOf(b);
    return s.width === TOGGLE.width && s.height === TOGGLE.height;
});
/** The text column of a switch's row: what is drawn just before it. */
const columnOf = (toggle: Element) => toggle.previousElementSibling!;
/** Settings → Notification Preferences: the menu row with the bell (found by its icon, which every language shares). */
const openNotifications = async () => {
    const row = Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('🔔'));
    expect(row, 'the Notification Preferences row').toBeTruthy();
    await act(async () => { (row as HTMLElement).click(); });
    await settle(12);
};

/** For every switch drawn: the room between its text column and it, and what else the row must hold. */
function measure(width: number, fontScale: number) {
    const layout = layOut(floor(), { width, height: 20000 }, { fontScale });
    return switches().map((toggle) => {
        const col = columnOf(toggle);
        const t = layout.box(toggle);
        const c = layout.box(col);
        return {
            name: toggle.getAttribute('aria-label') ?? '?',
            gap: t.left - (c.left + c.width),
            switchWidth: t.width,
            columnWidth: c.width,
            cutToLines: col.querySelector('[data-lines]') !== null,
        };
    });
}

const PHONES = [
    { name: '320 dp at 1.3x text', width: 320, fontScale: 1.3 },
    { name: 'a normal phone (393 dp, 1.0x)', width: 393, fontScale: 1.0 },
];
const LANGUAGES: UiLang[] = ['en', 'de', 'ru', 'xx'];

describe.each(LANGUAGES)('Settings in %s: the words beside a switch leave a gap before it', (lang) => {
    describe.each(PHONES)('$name', ({ width, fontScale }) => {
        it(`the Settings menu: all ${MENU_SWITCHES} switch rows`, async () => {
            await renderIn(lang, width);
            const rows = measure(width, fontScale);
            expect(rows.length, 'switch rows drawn on the menu').toBe(MENU_SWITCHES);
            for (const r of rows) {
                expect(r.gap, `${r.name}: room between its words and its switch`).toBeGreaterThanOrEqual(Spacing.sm);
                expect(r.switchWidth, `${r.name}: the switch keeps its width`).toBe(TOGGLE.width);
                expect(r.columnWidth, `${r.name}: the words have room`).toBeGreaterThan(60);
                expect(r.cutToLines, `${r.name}: the words wrap, never cut`).toBe(false);
            }
        });

        it(`Settings → Notifications: all ${NOTIFICATION_SWITCHES} switch rows, "Held in Trust & System" among them`, async () => {
            await renderIn(lang, width);
            await openNotifications();
            const rows = measure(width, fontScale);
            // This is a screen of its own (the menu's rows are gone): all that is drawn is the five.
            expect(rows.length, 'switch rows drawn on Notifications').toBe(NOTIFICATION_SWITCHES);
            for (const r of rows) {
                expect(r.gap, `${r.name}: room between its words and its switch`).toBeGreaterThanOrEqual(Spacing.sm);
                expect(r.switchWidth, `${r.name}: the switch keeps its width`).toBe(TOGGLE.width);
                expect(r.columnWidth, `${r.name}: the words have room`).toBeGreaterThan(60);
                expect(r.cutToLines, `${r.name}: the words wrap, never cut`).toBe(false);
            }
        });
    });
});

describe('the control: the old column style (flex: 1 and nothing else) leaves no room', () => {
    it('at 320 dp and 1.3x text every switch on Notifications touches its words, as in the screenshot', async () => {
        await renderIn('en', 320);
        await openNotifications();
        // The column as it was before the fix.
        for (const toggle of switches()) columnOf(toggle).setAttribute('data-style', JSON.stringify({ flex: 1 }));
        const rows = measure(320, 1.3);
        expect(rows.length).toBe(NOTIFICATION_SWITCHES);
        for (const r of rows) expect(r.gap, r.name).toBe(0);
    });
});
