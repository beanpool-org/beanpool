// @vitest-environment jsdom
/**
 * The phone's solid buttons read in both themes (Damo, 29 Oct 2026, Android, dark): Settings → Edit Profile's Save was a
 * white bar with no visible words. `primaryBtn` filled with `text.heading` and drew its words in `text.inverse`; in the
 * dark scheme both are white. A text token is an ink, never a fill: a button under words takes the brand pair
 * (`brand.fill` under `text.onBrand`, constants/colors.ts).
 *
 * app/(tabs)/settings.tsx is rendered for real (the same stand-ins as settings-words-render.test.ts), in light and in
 * dark, and each button is read by its background and its words' colour, as drawn: Save Profile, Show Recovery Phrase
 * and Confirm Sign Out. AddWordsForm's submit is read the same way, and the spinner each one shows while busy is read
 * from the source (a render of the busy state needs a stand-in for the key code). Each pair must reach WCAG 2.x's 4.5:1.
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

vi.mock('react-native', () => {
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, testID, placeholder, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        // The style as drawn: what the tests read a button's background and its words' colour from.
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(props.style)) };
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (placeholder) attrs.placeholder = placeholder;
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
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true, getStringAsync: async () => '' }));
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
// The scheme the case draws in: both colour sets are the real ones.
const look = vi.hoisted(() => ({ theme: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: look.theme, colors: look.theme === 'dark' ? darkColors : lightColors, patternEnabled: false });
    return {
        useTheme: () => ({ ...ctx(), themePreference: look.theme, setThemePreference() {}, setPatternEnabled() {} }),
        useStyles: (make: (t: ReturnType<typeof ctx>) => unknown) => make(ctx()),
    };
});

const WORDS = 'apple banana cherry delta eagle fabric garden hollow island jungle kettle lemon';
const KEY = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity, setIdentity() {} }) }));

// Shared with other screens: stand-ins (their own tests draw them).
vi.mock('../../components/AvatarPickerSheet', () => ({ AvatarPickerSheet: () => null }));
vi.mock('../../components/KeeperProtectionPanel', () => ({ KeeperProtectionPanel: () => null }));
vi.mock('../../components/AddWordsForm', () => ({ AddWordsForm: () => null }));
vi.mock('../../components/RecoveryKitButtons', () => ({ RecoveryKitButtons: () => null }));
vi.mock('../../components/SsoEnrolSheet', () => ({ SsoEnrolSheet: () => null }));
vi.mock('../../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../../components/OneWayBackCard', () => ({ OneWayBackCard: () => null }));
vi.mock('../../components/WordsOnScreen', () => ({
    NoScreenCapture: ({ children }: { children?: unknown }) => createElement(Fragment, null, children as any),
    CopyClearsNote: () => null, NoScreenLockNote: () => null,
}));
vi.mock('../../components/NoWordsNotice', () => ({ NoWordsNotice: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ busy: false, start() {}, dialog: null }) }));

vi.mock('../db', () => ({
    getMemberProfile: async () => ({ callsign: 'Ana', bio: 'Grows beans by the river', contact_value: '0400 000 000', contact_visibility: 'friends' }),
    updateMemberProfile: async () => {},
    signedRequest: async (route: string) => (route === '/api/recovery/collect/mine' ? { collections: [], count: 0 } : {}),
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
        anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
        purgeAccountOnNode: async () => { throw new Error(PURGE_NO_ANSWER); },
        PURGE_NO_ANSWER, PURGE_TIMEOUT_MS,
    };
});
vi.mock('../membership-probe', () => ({ fetchMembership: async () => ({ ok: true, json: async () => ({ isMember: true }) }) }));
vi.mock('../node-admin', () => {
    const askNodeRole = async () => ({ role: null, communityName: 'Mullum Commons' });
    return {
        askNodeRole,
        fetchMyNodeRole: async () => ({ role: null, communityName: 'Mullum Commons' }),
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
vi.mock('../delete-here', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    planDelete: async () => ({ kind: 'last', here: 'https://mullum.example', hereName: 'Mullum Commons' }),
}));
vi.mock('../../services/pillar-sync', () => ({
    requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended',
    performSyncWhenFree: async () => ({ success: true }), forceResyncNotice: () => ({ title: 'Success', message: '' }), syncCursorKeysOf: () => [],
}));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'join' }));
vi.mock('../use-global-guest-visit', () => ({ useGlobalGuestVisit: () => ({ visit: async () => ({ kind: 'guest' }), visiting: false }) }));

import { contrastRatio } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { darkColors, lightColors } from '../../constants/colors';
import SettingsScreen from '../../app/(tabs)/settings';

const { AddWordsForm } = await vi.importActual<typeof import('../../components/AddWordsForm')>('../../components/AddWordsForm');

const NODE = 'https://mullum.example';
const SCHEMES = [['light', lightColors], ['dark', darkColors]] as const;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true, escrow: true, nearbyListings: { radiusKm: 10, max: 500 } }, checkedAt: new Date().toISOString() } }));
    who.identity = { publicKey: KEY, privateKey: 'me-priv', callsign: 'Ana', mnemonic: WORDS };
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes('/api/members/preferences')) return new Response(JSON.stringify({ holiday_mode: 'false' }), { status: 200 });
        if (u.includes('/api/community/info')) return new Response(JSON.stringify({ memberCount: 14, postCount: 30, transactionCount: 9 }), { status: 200 });
        return new Response('{}', { status: 404 });
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderSettings() {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(SettingsScreen)) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const type = async (el: Element | null | undefined, text: string) => {
    expect(el).toBeTruthy();
    const input = el as HTMLInputElement;
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};
/** The button whose own words are `words`. */
const buttonSaying = (words: string) =>
    Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim() === words) ?? null;
const styleOf = (e: Element | null | undefined): Record<string, any> => JSON.parse(e?.getAttribute('data-style') ?? '{}');

/** The button's fill and the colour of the words drawn on it, as the screen drew them. */
function pairOf(button: Element | null, words: string) {
    expect(button, `the "${words}" button is on the screen`).toBeTruthy();
    const fill = styleOf(button).backgroundColor as string | undefined;
    const label = Array.from(button!.querySelectorAll('span')).find((s) => (s.textContent ?? '').includes(words));
    const ink = styleOf(label).color as string | undefined;
    expect(fill, `"${words}" has a background`).toMatch(/^#[0-9a-f]{6}$/i);
    expect(ink, `"${words}" has a words colour`).toMatch(/^#[0-9a-f]{6}$/i);
    return { fill: fill!, ink: ink!, ratio: contrastRatio(ink!, fill!) };
}
function expectReadableBrandPair(pair: { fill: string; ink: string; ratio: number }, tree: typeof lightColors | typeof darkColors, what: string) {
    expect(pair.ratio, `${what}: ${pair.ink} on ${pair.fill} is ${pair.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    // One primary colour: the brand pair every other primary button on the phone already draws.
    expect(pair.fill.toLowerCase(), `${what} fill`).toBe(tree.brand.fill.toLowerCase());
    expect(pair.ink.toLowerCase(), `${what} words`).toBe(tree.text.onBrand.toLowerCase());
}

describe.each(SCHEMES)('Settings, %s scheme: its solid buttons read', (scheme, tree) => {
    beforeEach(() => { look.theme = scheme; });

    it('Edit Profile: Save Profile', async () => {
        await renderSettings();
        await click(document.querySelector('[aria-label="Edit profile"]'), 'Edit profile');
        expectReadableBrandPair(pairOf(buttonSaying('Save Profile'), 'Save Profile'), tree, `${scheme} Save Profile`);
    });

    it('View Recovery Phrase: Show Recovery Phrase', async () => {
        await renderSettings();
        await click(buttonSaying('View Recovery Phrase') ?? Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('View Recovery Phrase')), 'View Recovery Phrase');
        await type(host.querySelector('input'), 'CONFIRM');
        expectReadableBrandPair(pairOf(buttonSaying('Show Recovery Phrase'), 'Show Recovery Phrase'), tree, `${scheme} Show Recovery Phrase`);
    });

    it('Sign Out (Device Only): Confirm Sign Out', async () => {
        await renderSettings();
        await click(Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Account Deletion & Sign Out')), 'Account Deletion & Sign Out');
        await click(Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Sign Out (Device Only)')), 'Sign Out (Device Only)');
        await type(host.querySelector('input'), 'WIPE');
        expectReadableBrandPair(pairOf(buttonSaying('Confirm Sign Out'), 'Confirm Sign Out'), tree, `${scheme} Confirm Sign Out`);
    });
});

describe.each(SCHEMES)('Add your 12 words, %s scheme: its submit button reads', (scheme, tree) => {
    it('Add these words', async () => {
        look.theme = scheme;
        await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(AddWordsForm, { onAdded() {}, onCancel() {}, colors: tree } as any)) as any); });
        await settle();
        expectReadableBrandPair(pairOf(buttonSaying('Add these words'), 'Add these words'), tree, `${scheme} Add these words`);
    });
});

describe('the busy spinner on each of these buttons is drawn in the same words colour', () => {
    const native = path.join(__dirname, '..', '..');
    const settings = fs.readFileSync(path.join(native, 'app', '(tabs)', 'settings.tsx'), 'utf8');
    const addWords = fs.readFileSync(path.join(native, 'components', 'AddWordsForm.tsx'), 'utf8');

    it('Save Profile: text.onBrand', () => {
        expect(settings).toMatch(/loading \? <ActivityIndicator color=\{colors\.text\.onBrand\} \/> : <Text style=\{styles\.primaryBtnText\}>\{t\("Save Profile"\)\}/);
    });
    it('Add these words: text.onBrand', () => {
        expect(addWords).toMatch(/<ActivityIndicator color=\{colors\.text\.onBrand\} \/>/);
    });
});
