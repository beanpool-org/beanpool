// @vitest-environment jsdom
/**
 * The Settings tab in the member's language (words slice S3, sweep B3): app/(tabs)/settings.tsx rendered for real inside
 * the real LanguageProvider, with what only Settings draws drawn for real too: the consent card, the recovery alert
 * banner (a community's sessions and a restore waiting at the key vault), the move-to-the-key-vault card, Community
 * Admin, Community Keys, My key code, Chat memory, Manage Blocked Users' "Also remove from friends", and the Language
 * row. React Native's host components are plain tags carrying their accessibility props, placeholders and the few
 * layout props the 320 dp checks read; the node answers a small community.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint,
 * placeholder or alert with letters outside a bracket bypassed t(). What members, the community and the vault wrote is
 * shown as written: names, a bio, an address, a node's refusal, the 12 words. Also as written: the words a member types
 * to confirm (CONFIRM, WIPE, DELETE: the code compares them) and beanpool.org.
 *
 * Components Settings shares with other screens are drawn as stand-ins here (their sweeps are the screens they share):
 * AvatarPickerSheet, KeeperProtectionPanel, AddWordsForm, RecoveryKitButtons, SsoEnrolSheet, PricingGuideModal,
 * OneWayBackCard, WordsOnScreen's notes, MemberAvatar, useManageNode's dialog. NoWordsNotice's stand-in draws the action
 * label Settings hands it, so that label is checked.
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

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', switch: 'switch', checkbox: 'checkbox' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        const s = flat(props.style);
        if (s.flexWrap) attrs['data-wrap'] = s.flexWrap;
        if (s.flex !== undefined) attrs['data-flex'] = String(s.flex);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        if (s.textTransform) attrs['data-transform'] = s.textTransform;
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                for (const b of buttons ?? []) { if (b.text) alerts.said.push(b.text); alerts.buttons.push(b); }
            },
        },
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
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useLocalSearchParams: () => params.now,
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
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors, themePreference: 'light', setThemePreference() {}, patternEnabled: false, setPatternEnabled() {} }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});

const WORDS = 'apple banana cherry delta eagle fabric garden hollow island jungle kettle lemon';
const KEY = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity, setIdentity() {} }) }));

// Shared with other screens: drawn as stand-ins (see the note above). NoWordsNotice's draws the label Settings hands it.
vi.mock('../../components/AvatarPickerSheet', () => ({ AvatarPickerSheet: () => null }));
vi.mock('../../components/KeeperProtectionPanel', () => ({ KeeperProtectionPanel: () => createElement('span', { 'data-later-sweep': 'KeeperProtectionPanel' }) }));
vi.mock('../../components/AddWordsForm', () => ({ AddWordsForm: () => createElement('span', { 'data-later-sweep': 'AddWordsForm' }) }));
vi.mock('../../components/RecoveryKitButtons', () => ({ RecoveryKitButtons: () => createElement('span', { 'data-later-sweep': 'RecoveryKitButtons' }) }));
vi.mock('../../components/SsoEnrolSheet', () => ({ SsoEnrolSheet: () => null }));
vi.mock('../../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../../components/OneWayBackCard', () => ({ OneWayBackCard: () => createElement('span', { 'data-later-sweep': 'OneWayBackCard' }) }));
vi.mock('../../components/WordsOnScreen', () => ({
    NoScreenCapture: ({ children }: { children?: unknown }) => createElement(Fragment, null, children as any),
    CopyClearsNote: () => null, NoScreenLockNote: () => null,
}));
vi.mock('../../components/NoWordsNotice', () => ({
    NoWordsNotice: ({ action }: { action?: { label: string } }) => createElement('button', { 'data-later-sweep': 'NoWordsNotice' }, action?.label ?? null),
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ busy: false, start() {}, dialog: null }) }));

// The node, the key vault and the phone's lock, as the cases set them.
const node = vi.hoisted(() => ({
    consent: null as Record<string, unknown> | null,
    sessions: [] as Array<{ collectionId: string; startedAt: string }>,
    role: null as null | 'owner' | 'admin' | 'moderator',
    ownerChecked: null as number | null,
    blocked: [] as string[],
    lastPlan: false,
}));
const vault = vi.hoisted(() => ({ on: false, holds: [] as any[], offer: null as any, note: null as null | string }));
vi.mock('../db', () => ({
    getMemberProfile: async (pk: string) => (pk === 'mia-key' ? { callsign: 'Mia' } : { callsign: 'Ana', bio: 'Grows beans by the river', contact_value: '0400 000 000', contact_visibility: 'friends' }),
    updateMemberProfile: async () => {},
    signedRequest: async (route: string) => (route === '/api/recovery/collect/mine' ? { collections: node.sessions, count: node.sessions.length } : {}),
    signedGet: async (route: string) => {
        if (route === '/api/names/consent') return node.consent ? new Response(JSON.stringify(node.consent), { status: 200 }) : new Response('{}', { status: 404 });
        return new Response(JSON.stringify({ show_as_connection_in_common: 'true' }), { status: 200 });
    },
    signedRequestWithMethod: async () => ({}),
    resetDmChatMemory: async () => ({ ok: true }),
    getDatabaseStats: async () => ({ members: 12, posts: 30, transactions: 4, messages: 51, integrity: 'ok' }),
    isFriendLocal: async () => true,
    removeFriendOnNode: async () => {},
    closeDB: async () => {}, initDB: async () => {}, clearDB: async () => {}, redeemInvite: async () => {}, syncMessages: async () => {},
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => node.blocked, unblockUser: async () => {}, clearBlocklist: async () => {}, BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../node-post', async (importOriginal) => {
    const { PURGE_NO_ANSWER, PURGE_TIMEOUT_MS } = await importOriginal<typeof import('../node-post')>();
    return {
        signedPost: async () => new Response(JSON.stringify({ keepers: [], enrolledSso: [], threshold: 1, recoverable: false, total: 0 }), { status: 200 }),
        anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
        // The node doesn't answer the delete in time: what purgeAccountOnNode throws then.
        purgeAccountOnNode: async () => { throw new Error(PURGE_NO_ANSWER); },
        PURGE_NO_ANSWER, PURGE_TIMEOUT_MS,
    };
});
vi.mock('../membership-probe', () => ({ fetchMembership: async () => ({ ok: true, json: async () => ({ isMember: true }) }) }));
vi.mock('../node-admin', () => ({
    fetchMyNodeRole: async () => ({ role: node.role, communityName: 'Mullum Commons' }),
    rememberNodeRole: () => {},
    canManageNode: (role: string | null) => role === 'owner' || role === 'admin' || role === 'moderator',
}));
vi.mock('../owner-words', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    fetchOwnerWordsStatus: async () => (node.role === 'owner' ? { owner: true, wordsCheckedAt: node.ownerChecked } : { owner: false, wordsCheckedAt: null }),
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
        hasVault: () => vault.on,
        vaultCopyKnowledge: async () => 'known',
        vaultStatus: async () => ({ holds: vault.holds }),
        approvedHolds: async () => [],
        forgetEndedApprovals: async () => {},
    };
});
vi.mock('../keeper-enrolment', async () => {
    const { VaultError, VAULT_MESSAGES } = await import('../vault');
    return {
        vaultProtection: async () => { if (vault.note) throw new VaultError('locked', VAULT_MESSAGES.paused); return { enrolled: [], generation: 1, skipped: [], available: 0, enrolledSso: [], threshold: 1, isSingleBlob: true }; },
        enrolmentFromVault: () => ({ enrolled: [], generation: 1, skipped: [], available: 0, enrolledSso: [], threshold: 1, isSingleBlob: true }),
        disconnectSsoKeeper: async () => ({ success: true }),
    };
});
vi.mock('../vault-move', () => ({ vaultMoveOffer: async () => vault.offer, finishMove: async () => {}, moveLater: async () => {}, removeInstead: async () => true }));
vi.mock('../delete-here', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    planDelete: async () => (node.lastPlan
        ? { kind: 'last', here: NODE, hereName: 'Mullum Commons' }
        : { kind: 'this-one', here: NODE, hereName: 'Mullum Commons', keeps: [{ url: 'https://castle.example', name: 'Castlemaine', membership: 'member' }, { url: 'https://hills.example', name: 'Hills', membership: 'unreachable' }], next: { url: 'https://castle.example', name: 'Castlemaine', membership: 'member' } }),
}));
vi.mock('../../services/pillar-sync', () => ({
    requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended',
    performSyncWhenFree: async () => ({ success: true }), forceResyncNotice: () => ({ title: 'Success', message: '' }), syncCursorKeysOf: () => [],
}));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'join' }));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider, DrawnInLanguage } from '../../components/LanguageProvider';
import { CONSENT_LINES, consentLineWords } from '../../components/KnownConsentCard';
import { ownerRowWords } from '../../components/OwnerWordsCard';
import { holdEndsWords } from '../../components/RecoveryAlertBanner';
import { consentHeading, saveKnownConsent } from '../known-consent';
import { OWNER_WORDS_COPY } from '../owner-words';
import { holdEndsText } from '../vault';
import SettingsScreen from '../../app/(tabs)/settings';

const NODE = 'https://mullum.example';

/** Everything members, the community and the vault wrote, and what is typed or named as it is: shown as written. */
const OTHERS = [
    'Ana', 'Mia', 'Grows beans by the river', '0400 000 000', 'Mullum Commons', 'Castlemaine', 'Hills', NODE, 'https://castle.example',
    'beanpool.org', 'CONFIRM', 'WIPE', 'DELETE', 'Google', 'mia-key', `${KEY.slice(0, 6)}...${KEY.slice(-6)}`, KEY.slice(0, 16),
    'http://192.168.1.55', 'INV-', 'mullum.example', ...WORDS.split(' '),
].sort((a, b) => b.length - a.length);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    params.now = {};
    alerts.said.length = 0;
    alerts.buttons.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true, escrow: true, nearbyListings: { radiusKm: 10, max: 500 } }, checkedAt: new Date().toISOString() } }));
    who.identity = { publicKey: KEY, privateKey: 'me-priv', callsign: 'Ana', mnemonic: WORDS };
    node.consent = null;
    node.sessions = [];
    node.role = null;
    node.ownerChecked = null;
    node.blocked = [];
    node.lastPlan = false;
    vault.on = false;
    vault.holds = [];
    vault.offer = null;
    vault.note = null;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes('/api/members/preferences')) return new Response(JSON.stringify({ holiday_mode: 'false' }), { status: 200 });
        if (u.includes('/api/community/info')) return new Response(JSON.stringify({ memberCount: 14, postCount: 30, transactionCount: 9 }), { status: 200 });
        return new Response('{}', { status: 404 });
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(SettingsScreen)) as any); });
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
/** The button whose own words are `english` in the language drawn now (xx: bracketed). */
const row = (english: string, lang: UiLang = 'xx') => {
    const shown = lang === 'xx' ? pseudoLocalise(english) : english;
    return Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(shown)) ?? null;
};
const byLabel = (label: string) => host.querySelector(`[aria-label="${label.replace(/"/g, '\\"')}"]`);
/** A button's visible words: its text without the emoji or arrow drawn beside them. */
const visibleWords = (b: Element | null) => (b?.textContent ?? '').replace(/^[^\p{L}\p{N}[]+|[^\p{L}\p{N}\]]+$/gu, '');
/** Each button is named by its visible words, one key for both, in the language drawn (WCAG 2.5.3). */
function namedByItsWords(...words: string[]) {
    for (const english of words) {
        const b = row(english);
        expect(b, english).toBeTruthy();
        expect(visibleWords(b), english).toBe(pseudoLocalise(english));
        expect(b!.getAttribute('aria-label'), english).toBe(visibleWords(b));
    }
}

/** Text with letters outside a pseudo-locale bracket, once what others wrote is taken out. */
function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const o of OTHERS) rest = rest.split(o).join('');
    return /\p{L}/u.test(rest);
}
/** Every drawn text, label, hint, placeholder and alert that bypassed t(). */
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

describe('Settings in the pseudo-locale: every word on it came through t() (words S3d)', () => {
    it('the menu: the profile card, every group and row, the toggles, Appearance, the Language row, the version', async () => {
        await renderIn('xx');
        expect(host.textContent).toContain('Grows beans by the river');
        expect(host.textContent).toContain(pseudoLocalise('ACCOUNT & IDENTITY'));
        expect(host.textContent).toContain(pseudoLocalise('Holiday Mode'));
        expect(host.textContent).toContain(pseudoLocalise('Same as phone'));
        expect(host.querySelector('[data-testid="settings-your-area"]')).not.toBeNull();
        expect(bracketed()).toBeGreaterThan(40);
        expect(bypassing()).toEqual([]);
    });

    it('a phone without the 12 words: the View Recovery Phrase row says there is no copy', async () => {
        who.identity = { publicKey: KEY, privateKey: 'me-priv', callsign: 'Ana' };
        await renderIn('xx');
        expect(host.textContent).toContain(pseudoLocalise('No copy on this phone yet. Tap to add your 12 words.'));
        expect(bypassing()).toEqual([]);
    });

    it('what only Settings draws: the consent card, a recovery underway, a restore at the key vault, the move card, Community Admin and Community Keys', async () => {
        node.consent = { known: true, version: '2', text: 'Admins can see your balance.', consentedVersion: '1', consentedAt: new Date(Date.UTC(2026, 9, 5)).toISOString() };
        node.sessions = [{ collectionId: 'c1', startedAt: new Date(Date.now() - 3600_000).toISOString() }, { collectionId: 'c2', startedAt: new Date().toISOString() }];
        node.role = 'owner';
        node.ownerChecked = Date.UTC(2026, 9, 3);
        vault.on = true;
        vault.holds = [{ holdId: 'h1', provider: 'google', openedAt: Date.now() - 3600_000, releaseAt: Date.now() + 5 * 3600_000 }];
        vault.offer = { kind: 'move', provider: 'google', communityUrl: NODE };
        await renderIn('xx');
        OTHERS.push('Admins can see your balance.');
        expect(host.textContent).toContain(pseudoLocalise('Your community changed what its admins can see'));
        expect(host.textContent).toContain(pseudoLocalise('Someone is recovering your account'));
        expect(host.textContent).toContain(pseudoLocalise('Someone is getting back into your account'));
        expect(host.textContent).toContain(pseudoLocalise('COMMUNITY ADMIN'));
        expect(host.textContent).toContain(pseudoLocalise('COMMUNITY KEYS'));
        expect(host.textContent).toContain(pseudoLocalise('{n} active sessions • Started {when}').split('{n}')[0]);
        expect(bypassing()).toEqual([]);
        // The emergency Stop buttons are named by their visible words, one key each, in any language (WCAG 2.5.3).
        for (const words of ['Stop It Now', 'Stop']) expect(row(words)?.getAttribute('aria-label'), words).toBe(pseudoLocalise(words));
        // Their questions and answers.
        await click(row('Stop It Now'), 'Stop It Now');
        await click(row('Stop'), 'Stop (the vault)');
        await click(row("Yes, it's me"), "Yes, it's me");
        await click(row('Remove it instead'), 'Remove it instead');
        await click(row('Sign out everywhere'), 'Sign out everywhere');
        expect(alerts.said.length).toBeGreaterThan(8);
        expect(bypassing()).toEqual([]);
        OTHERS.splice(OTHERS.indexOf('Admins can see your balance.'), 1);
    });

    it('Account Protection: My key code, the vault\'s word when it can\'t say, the 12 words shown, copied and put away', async () => {
        vault.on = true;
        vault.note = 'paused';
        params.now = { section: 'protection' };
        await renderIn('xx');
        expect(host.textContent).toContain(pseudoLocalise('🛡️ Account Protection'));
        expect(host.textContent).toContain(pseudoLocalise('Getting back in with a sign-in is paused for a little while. Your 12 words work any time.'));
        expect(bypassing(), 'before Show').toEqual([]);
        namedByItsWords('Show My 12 Recovery Words');
        await click(row('Show My 12 Recovery Words'), 'Show');
        expect(host.textContent).toContain('apple');
        expect(byLabel(pseudoLocalise('Word {n}: {word}').replace('{n}', '1').replace('{word}', 'apple'))).not.toBeNull();
        await click(row('📋 Copy Words'), 'Copy');
        expect(bypassing(), 'shown').toEqual([]);
    });

    it('View Recovery Phrase: the CONFIRM step and the words; on a phone with none, the add form\'s way to a sign-in', async () => {
        await renderIn('xx');
        await click(row('View Recovery Phrase'), 'View Recovery Phrase');
        expect(host.textContent).toContain(pseudoLocalise("TYPE '{word}' TO VIEW SEED").replace('{word}', 'CONFIRM'));
        await type(host.querySelector('input'), 'CONFIRM');
        await click(row('Show Recovery Phrase'), 'Show Recovery Phrase');
        expect(host.textContent).toContain('lemon');
        expect(bypassing(), 'with words').toEqual([]);

        act(() => root.unmount());
        root = createRoot(host);
        who.identity = { publicKey: KEY, privateKey: 'me-priv', callsign: 'Ana' };
        await renderIn('xx');
        await click(row('View Recovery Phrase'), 'View Recovery Phrase');
        expect(host.textContent).toContain(pseudoLocalise('Connect a sign-in'));
        expect(bypassing(), 'without').toEqual([]);
    });

    it('Edit Profile, Notification Preferences with the event reminders, Chat memory', async () => {
        await renderIn('xx');
        await click(byLabel(pseudoLocalise('Edit profile')), 'Edit profile');
        expect(host.textContent).toContain(pseudoLocalise('Who can see this?'));
        expect(host.textContent).toContain(pseudoLocalise('People you have added as friends'));
        expect(bypassing(), 'profile').toEqual([]);
        await click(row('Cancel'), 'Cancel');
        await click(row('Notification Preferences'), 'Notification Preferences');
        expect(host.textContent).toContain(pseudoLocalise('1 day before'));
        expect(host.textContent).toContain(pseudoLocalise('Reminders arrive with your Marketplace alerts, so they stop if you switch those off. You can change the reminder on any one event.'));
        expect(bypassing(), 'notifications').toEqual([]);
        await click(row('← Back'), 'Back');
        await click(row('Chat memory'), 'Chat memory');
        expect(host.textContent).toContain(pseudoLocalise('Reset'));
        expect(bypassing(), 'chat memory').toEqual([]);
    });

    it('Advanced: saved communities, the global door, Add Manual Node; Database Health with its numbers', async () => {
        await renderIn('xx');
        await click(row('Saved communities'), 'Saved communities');
        await settle();
        expect(host.textContent).toContain(pseudoLocalise('Saved communities'));
        expect(host.textContent).toContain(pseudoLocalise('The communities this phone has joined. Your key and 12 words are the same in each; switch to one to use it.'));
        expect(host.textContent).toContain(pseudoLocalise('Have an invite code for this community?'));
        expect(host.textContent).toContain(pseudoLocalise('Run this community? Owners and admins see Manage {community} at the top of Settings.').replace('{community}', 'mullum.example'));
        expect(host.textContent).toContain(pseudoLocalise('Add a community by address'));
        expect(host.textContent).toContain(pseudoLocalise('Connect to a community by typing its address. Your phone will save it to this list and switch to it.'));
        expect(host.textContent).toContain(pseudoLocalise('🌍 Join the global community'));
        expect(host.textContent).toContain(pseudoLocalise('Active Node'));
        expect(bypassing(), 'advanced').toEqual([]);
        await click(row("Clear this phone's copy and download again"), "Clear this phone's copy and download again");
        expect(bypassing(), 'resync question').toEqual([]);
        await click(row('← Back'), 'Back');
        await click(row('Database Health & Stats'), 'Database Health');
        await settle();
        expect(host.textContent).toContain(pseudoLocalise('Cached Members'));
        expect(host.textContent).toContain(pseudoLocalise('⚠️ Node has {n}').replace('{n}', '14'));
        expect(host.textContent).toContain(pseudoLocalise('{size} MB').replace('{size}', '5.12'));
        expect(bypassing(), 'diagnostics').toEqual([]);
    });

    it('Account Deletion & Sign Out: the options, device sign-out, the permanent delete with what this phone keeps', async () => {
        await renderIn('xx');
        await click(row('Account Deletion & Sign Out'), 'Account Deletion & Sign Out');
        expect(host.textContent).toContain(pseudoLocalise('Remove from This Device Only'));
        expect(bypassing(), 'options').toEqual([]);
        // The final-confirmation buttons are named by their visible words; what else the name said is in the hint.
        namedByItsWords('Sign Out (Device Only)', 'Permanently Delete Account', 'Back to Settings');
        expect(row('Permanently Delete Account')?.getAttribute('data-hint')).toBe(pseudoLocalise('Opens the confirmation to delete your account and node data'));
        await click(row('Sign Out (Device Only)'), 'Sign Out (Device Only)');
        expect(host.textContent).toContain(pseudoLocalise("TYPE '{word}' TO CONFIRM DEVICE SIGN OUT").replace('{word}', 'WIPE'));
        await type(host.querySelector('input'), 'WIPE');
        namedByItsWords('View Recovery Words First', 'Confirm Sign Out', 'Choose Another Option');
        expect(row('Confirm Sign Out')?.getAttribute('data-hint')).toBe(pseudoLocalise('Signs you out of this device'));
        await click(row('Confirm Sign Out'), 'Confirm Sign Out');
        expect(bypassing(), 'device sign-out').toEqual([]);
        await click(row('Choose Another Option'), 'Choose Another Option');
        await click(row('Permanently Delete Account'), 'Permanently Delete Account');
        await settle();
        expect(host.textContent).toContain(pseudoLocalise("{here} goes from this phone's list, with its copy on this phone, and the app opens {next}.").replace('{here}', 'Mullum Commons').replace('{next}', 'Castlemaine'));
        await type(host.querySelector('input'), 'DELETE');
        namedByItsWords('Permanently Purge Account', 'Choose Another Option');
        await click(row('Permanently Purge Account'), 'Permanently Purge Account');
        expect(alerts.said).toContain(pseudoLocalise('Permanent Node Purge'));
        expect(bypassing(), 'delete').toEqual([]);

        // The community doesn't answer in time: the purge's own sentence is in the member's language too, whole.
        const purge = alerts.buttons.find((b) => b.text === pseudoLocalise('Permanently Purge'));
        expect(purge).toBeTruthy();
        await act(async () => { await purge!.onPress?.(); });
        await settle();
        const { PURGE_NO_ANSWER } = await vi.importActual<typeof import('../node-post')>('../node-post');
        expect(alerts.said).toContain(pseudoLocalise('Purge Failed'));
        expect(alerts.said).toContain(pseudoLocalise("{reason}\n\nThis phone's key and 12 words were not touched.").replace('{reason}', pseudoLocalise(PURGE_NO_ANSWER)));
        expect(bypassing(), 'purge timed out').toEqual([]);
    });

    it('the permanent delete at the last community on the phone: View Recovery Words First is named by its words', async () => {
        node.lastPlan = true;
        await renderIn('xx');
        await click(row('Account Deletion & Sign Out'), 'Account Deletion & Sign Out');
        await click(row('Permanently Delete Account'), 'Permanently Delete Account');
        await settle();
        expect(host.textContent).toContain(pseudoLocalise("{here} is the last community on this phone where you are a member, so this phone's key and 12 words go too. Only go ahead if you have written your 12 words down: they are the way back into any other community you belong to.").replace('{here}', 'Mullum Commons'));
        namedByItsWords('View Recovery Words First', 'Permanently Purge Account', 'Choose Another Option');
        expect(bypassing()).toEqual([]);
    });

    it('Manage Blocked Users: a blocked friend, "Also remove from friends" and its question', async () => {
        node.blocked = ['mia-key'];
        await renderIn('xx');
        await click(row('Manage Blocked Users'), 'Manage Blocked Users');
        expect(host.textContent).toContain('Mia');
        expect(host.textContent).toContain(pseudoLocalise('Still your friend. They can notice a removal.'));
        await click(row('Also remove from friends'), 'Also remove from friends');
        await click(row('Unblock All'), 'Unblock All');
        expect(bypassing()).toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        node.role = 'owner';
        await renderIn('en');
        expect(bracketed()).toBe(0);
        for (const english of ['ACCOUNT & IDENTITY', 'Re-run Setup', 'Account Protection', 'APP SETTINGS', 'Holiday Mode', 'Going away? Hide your offers and pause requests',
            'LEGAL & PRIVACY', 'Account Deletion & Sign Out', 'COMMUNITY ADMIN', 'Manage Mullum Commons', "You're an owner · opens the node's settings, signed in as you",
            'Sign out everywhere', 'Same as phone', 'View Recovery Phrase', 'View your 12-word backup seed']) {
            expect(host.textContent, english).toContain(english);
        }
        expect(byLabel('Edit profile')).not.toBeNull();
        expect(host.textContent).toMatch(/BEANPOOL OS \S+ \(Build \d+\)/);
    });
});

describe('the lower layers\' lines the cards translate where they show them, held to their sources', () => {
    it('known-consent.ts\'s heading and refusals; owner-words.ts\'s row lines; vault.ts holdEndsText\'s shape', async () => {
        for (const consentedVersion of ['1', undefined]) {
            const heading = consentHeading({ known: true, version: '2', text: '', confirmed: false, consentedAt: null, consentedVersion: consentedVersion ?? null, withdrawnAt: null });
            expect(consentLineWords(heading)).toBe(heading);
            expect(Object.keys(CONSENT_LINES)).toContain(heading);
        }
        for (const failure of [new TypeError('offline'), new Error('Request failed: 500'), new SyntaxError('x')]) {
            const out = await saveKnownConsent(async () => { throw failure; });
            expect(Object.keys(CONSENT_LINES)).toContain((out as { error: string }).error);
        }
        for (const line of [OWNER_WORDS_COPY.title, OWNER_WORDS_COPY.notChecked, OWNER_WORDS_COPY.unlockTitle, OWNER_WORDS_COPY.unlockSub]) {
            expect(ownerRowWords(line)).toBe(line);
            setLanguage('xx');
            expect(ownerRowWords(line)).toBe(pseudoLocalise(line));
            setLanguage('en');
        }
        expect(OWNER_WORDS_COPY.checked(Date.UTC(2026, 9, 3))).toMatch(/^12 words checked /);
        const now = Date.UTC(2026, 9, 19, 2);
        expect(holdEndsWords(now + 30_000, now)).toBe(holdEndsText(now + 30_000, now));
        expect(holdEndsWords(now + 20 * 60_000, now)).toBe(holdEndsText(now + 20 * 60_000, now));
        expect(holdEndsWords(now + 24 * 3600_000, now)).toMatch(/^in about 24 hours \(/);
        expect(holdEndsText(now + 24 * 3600_000, now)).toMatch(/^in about 24 hours \(/);
        expect(holdEndsWords(now + 3600_000, now)).toMatch(/^in about 1 hour \(/);
    });
});

// ── 320 dp with text at 1.3×: longer languages never push words past an edge (checked with the pseudo-locale) ─────────
const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);
/** The longest word, without the pseudo-locale's brackets: they mark a sentence; its ~35 % pad models a longer language. */
const longestWord = (text: string) => text.split(/[\s\u200B]+/).map((w) => w.replace(/^\[+|\]+$/g, '')).reduce((a, b) => (widthOf(b, 1) > widthOf(a, 1) ? b : a), '');

describe('Settings at 320 dp with 1.3× text, in the pseudo-locale', () => {
    // 320 - 2 × 20 (the page's padding) - 2 × 14 (a row's) - 48 (its icon) = 204; a switch takes 50 more, a chevron ~22.
    const ROW_TEXT = 204;

    /** A menu row's text column: beside a switch, a chevron, or nothing. */
    const columnOf = (span: Element): number => {
        const rowEl = span.getAttribute('data-flex') === '1' ? span.parentElement! : span.parentElement!.parentElement!;
        const kids = Array.from(rowEl.children);
        if (kids.some((k) => k.tagName === 'BUTTON' && !(k.textContent ?? '').trim())) return ROW_TEXT - 50;
        if (kids.some((k) => (k.textContent ?? '').trim() === '›')) return ROW_TEXT - 22;
        return ROW_TEXT;
    };
    /** Each menu row's title (15) and line under it (12): the longest word, at the size it is drawn at its smallest. */
    const tooWide = (): string[] => {
        const out: string[] = [];
        for (const span of Array.from(host.querySelectorAll('span[data-font="15"], span[data-font="12"]'))) {
            const text = span.textContent ?? '';
            if (!/^\[/.test(text) || span.closest('[data-modal]')) continue;
            const min = Number(span.getAttribute('data-min-scale') ?? 1);
            const px = Number(span.getAttribute('data-font')) * SCALE * min;
            const word = longestWord(text);
            if (widthOf(word, px) > columnOf(span)) out.push(`${word} (${Math.round(widthOf(word, px))} > ${columnOf(span)})`);
            // A title held to a few lines must fit them whole at its smallest, never cut short.
            const lines = Number(span.getAttribute('data-lines') ?? 0);
            if (lines && widthOf(text, px) > lines * columnOf(span) * 0.9) out.push(`${text}: more than ${lines} lines`);
        }
        return out;
    };

    it('every menu row\'s words fit their column: no word is wider than the column beside a switch or a chevron', async () => {
        node.role = 'owner';
        await renderIn('xx');
        expect(host.querySelectorAll('span[data-font="15"]').length).toBeGreaterThan(20);
        expect(tooWide()).toEqual([]);
    });

    it('section headers carry their own capitals: none is upper-cased by the phone', async () => {
        node.role = 'moderator';
        await renderIn('xx');
        const headers = Array.from(host.querySelectorAll('span[data-font="11"]'));
        expect(headers.length).toBeGreaterThan(4);
        for (const h of headers) expect(h.getAttribute('data-transform'), h.textContent ?? '').toBeNull();
    });

    it('Appearance\'s three choices: each stays whole on its two lines in its third, shrinking to fit', async () => {
        await renderIn('xx');
        // 320 - 2 × 20 - 2 × 14 (the block's padding) - 2 × 3 (the row's) - 2 × 3 (its gaps), in thirds, less 2 × 4 each.
        const third = (320 - 40 - 28 - 6 - 6) / 3 - 8;
        const radios = Array.from(host.querySelectorAll('[role="radio"]'));
        expect(radios).toHaveLength(3);
        for (const radio of radios) {
            const label = radio.querySelector('span[data-shrinks]')!;
            const text = label.textContent ?? '';
            expect(label.getAttribute('data-lines'), text).toBe('2');
            const px = 13 * SCALE * Number(label.getAttribute('data-min-scale'));
            expect(widthOf(longestWord(text), px), longestWord(text)).toBeLessThanOrEqual(third);
            expect(widthOf(text, px), text).toBeLessThanOrEqual(2 * third * 0.9);
        }
    });
});

describe('Settings follows a language picked on it', () => {
    const NATIVE_WORDS = path.resolve(__dirname, '../../words');
    const fr = JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, 'fr.json'), 'utf8')) as Record<string, unknown>;

    it('a pick redraws the tab in the new language, the Language row with it, with nothing by hand', async () => {
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] }, createElement(DrawnInLanguage, null, createElement(SettingsScreen))) as any);
        });
        await settle();
        const languageRow = () => host.querySelector('[data-testid="settings-language"]');
        const before = languageRow()?.textContent ?? '';
        expect(host.textContent).toContain('Link a device');
        await click(languageRow(), 'Settings → Language');
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        await settle();
        expect(typeof fr['Link a device']).toBe('string');
        expect(host.textContent).toContain(fr['Link a device'] as string);
        expect(host.textContent).not.toContain('Link a device');
        expect(languageRow()?.textContent).not.toBe(before);
        expect(languageRow()?.textContent).toContain('Français');
        expect(host.textContent).toContain('Grows beans by the river');
    });
});
