// @vitest-environment jsdom
/**
 * The welcome screen and onboarding in the member's language (words slice S3, sweep B9): app/welcome.tsx rendered for
 * real inside the real LanguageProvider, step by step, with the components welcome draws that this sweep took drawn for
 * real too (KeeperProtectionPanel, SsoEnrolSheet, RecoveryKitButtons, WordsOnScreen's notes, and the ones S1 and P4 took:
 * WelcomeDoors, LanguageSwitch, RestoreCommunityChips, ConsentText). React Native's host components are plain tags
 * carrying their accessibility props and placeholders; the node, the key vault, the sign-ins and the phone's key store
 * are stubbed: nothing here is contacted.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint,
 * placeholder, alert or lock prompt with letters outside a bracket bypassed t(). What members and communities wrote is
 * shown as written (names, addresses), and so are the 12 words, the word a member types to confirm (WIPE: the code
 * compares it) and the sign-ins' brand names.
 *
 * Components welcome shares with screens not yet swept are stand-ins here (their sweeps are the screens they share):
 * WordsDoor's door choices and progress, LinkSignInSheet, AvatarPickerSheet, RecoveryWordsEntry, SavedNodePicker (its
 * stand-in draws the label, action and hint welcome hands it, so those are checked), MemberAvatar and the sign-in
 * buttons' logos (the buttons draw the title welcome hands them).
 *
 * Then 320 dp at 1.3×: on every step, no word of a button's words is wider than the card's line, in the pseudo-locale's
 * longer words. And a language picked while Safety Backup is open redraws it from the real French catalog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Some components don't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
const prompts = vi.hoisted(() => ({ asked: [] as string[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', checkbox: 'checkbox' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, value, onChangeText, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        const s = flat(props.style);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        if (s.textTransform) attrs['data-transform'] = s.textTransform;
        if (s.flexDirection === 'row') attrs['data-row'] = 'true';
        if (s.flexWrap === 'wrap') attrs['data-wrap'] = 'true';
        if ((typeof s.flexShrink === 'number' && s.flexShrink > 0) || (typeof s.flex === 'number' && s.flex > 0)) attrs['data-shrink'] = 'true';
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), FlatList: el('div'),
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
        AppState: { currentState: 'active', addEventListener: listener },
        BackHandler: { addEventListener: listener },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, addEventListener: listener },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
// Whether the screen is the one in view: every case's single welcome is; a case with two in the stack provides it.
const focus = vi.hoisted(() => ({ ctx: null as unknown as ReactAll.Context<boolean> }));
/** Where the screen sent the member with router.push, in order. */
const nav = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect: effect, createContext, useContext } = await import('react');
    focus.ctx = createContext(true);
    return {
        router: { push(to: unknown) { nav.pushed.push(to); }, navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true },
        useGlobalSearchParams: () => params.now,
        useLocalSearchParams: () => params.now,
        useFocusEffect: (cb: () => void | (() => void)) => {
            const focused = useContext(focus.ctx);
            effect(() => (focused ? cb() : undefined), [cb, focused]);
        },
        useIsFocused: () => useContext(focus.ctx),
        ErrorBoundary: () => null,
    };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-linking', () => ({ useURL: () => null, parse: () => ({ queryParams: {} }), openURL: async () => {}, addEventListener: () => ({ remove() {} }), createURL: (p: string) => `beanpool://${p}` }));
const clip = vi.hoisted(() => ({ has: false, text: '' }));
vi.mock('expo-clipboard', () => ({
    hasStringAsync: async () => clip.has, getStringAsync: async () => clip.text, setStringAsync: async () => true,
    isPasteButtonAvailable: false, ClipboardPasteButton: () => null,
}));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-application', () => ({ getInstallReferrerAsync: async () => null }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid', digest: async () => new ArrayBuffer(32) };
});
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: true }),
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: async () => ({ type: 'cancel' }), openBrowserAsync: async () => ({}), dismissAuthSession() {}, dismissBrowser: async () => undefined, maybeCompleteAuthSession: () => ({}) }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: async () => false, signInAsync: async () => ({}), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
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
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { theme: 'light', colors: lightColors, themePreference: 'light', setThemePreference() {}, patternEnabled: false, setPatternEnabled() {} };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx), useOnboardingColors: () => onboardingColors('light') };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: null, setIdentity() {} }) }));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => {} }) }));

// ── The phone's key store, the node, the key vault and the door, as each case sets them ─────────────────────────────
const ids = vi.hoisted(() => {
    const WORDS = 'apple banana cherry delta eagle fabric garden hollow island jungle kettle lemon'.split(' ');
    const OUT_WORDS = 'oven pepper quarter rabbit salad table umbrella valley window yellow zebra anchor'.split(' ');
    return {
        WORDS, OUT_WORDS,
        SALLY: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32), callsign: 'Sally', createdAt: '2026-01-01', mnemonic: WORDS },
        KIM: { publicKey: 'c3'.repeat(32), privateKey: 'd4'.repeat(32), callsign: 'Kim', createdAt: '2026-01-01', mnemonic: OUT_WORDS },
    };
});
const { WORDS, OUT_WORDS, SALLY, KIM } = ids;
const phone = vi.hoisted(() => ({
    stored: null as any,
    pending: null as any,
    enrolment: null as any,
    invite: { valid: true, inviterCallsign: 'Ana', communityName: 'Mullum' } as Record<string, unknown>,
    outgoing: null as any,
    redeemFails: null as string | null,
}));
const door = vi.hoisted(() => ({
    check: { ok: true, profile: { features: {} } } as any,
    answer: null as any,
    signIn: null as any,
    cachedFeatures: null as any,
}));
const vaultState = vi.hoisted(() => ({ waiting: null as any, check: null as any, candidates: [] as any[] }));

vi.mock('../identity', async (importOriginal) => {
    const real = await importOriginal<typeof import('../identity')>();
    return {
        ...real,
        loadIdentity: async () => phone.stored,
        createIdentity: async (callsign: string) => ({ ...ids.SALLY, callsign }),
    };
});
vi.mock('../onboarding-state', async (importOriginal) => {
    const real = await importOriginal<typeof import('../onboarding-state')>();
    return {
        ...real,
        getPendingOnboarding: async () => phone.pending,
        setPendingOnboarding: async () => {}, updatePendingOnboarding: async () => {}, clearPendingOnboarding: async () => {},
        recordJoinKeyMade: async () => {},
    };
});
vi.mock('../db', () => ({
    checkInvite: async () => phone.invite,
    redeemInvite: async () => { if (phone.redeemFails) throw new Error(phone.redeemFails); return {}; },
    updateMemberProfile: async () => {},
    fetchNodeCallsign: async () => 'Sally',
    recordOnboardingEvent: async () => {},
    signedRequestWithMethod: async () => ({}),
    signedRequest: async () => ({}),
}));
vi.mock('../invite-next', async (importOriginal) => {
    const real = await importOriginal<typeof import('../invite-next')>();
    return { ...real, afterSpentInvite: async () => 'spent', redeemRefusalMeansIn: async () => false };
});
vi.mock('../callsign-suggest', () => ({ checkCallsignAvailable: async () => 'free', suggestCallsigns: async () => [] }));
vi.mock('../community-switch', () => ({ communitySwitched: () => {} }));
vi.mock('../rekey-slot-store', () => ({ rekeySlotStore: { get: async () => null, set: async () => {}, clear: async () => {} } }));
vi.mock('../install-referrer', () => ({ takeInstallReferrer: async () => null }));
vi.mock('../one-way-back', () => ({ startOneWayBack: async () => {} }));
vi.mock('../nodes', async (importOriginal) => {
    const real = await importOriginal<typeof import('../nodes')>();
    return { ...real, getSavedNodes: async () => [], addSavedNode: async () => {}, clearGuestNode: async () => {} };
});
vi.mock('../crypto', async (importOriginal) => {
    const real = await importOriginal<typeof import('../crypto')>();
    return { ...real, validateMnemonic: () => true, buildSignedHeaders: async () => ({}) };
});
vi.mock('../LocalAuth', async (importOriginal) => {
    const real = await importOriginal<typeof import('../LocalAuth')>();
    return { ...real, authenticateUser: async (prompt: string) => { prompts.asked.push(prompt); return true; } };
});
vi.mock('../words-behind-lock', () => ({
    readWordsBehindLock: async (account: { mnemonic?: string[] } | null, prompt: string) => { prompts.asked.push(prompt); return account?.mnemonic ?? null; },
}));
vi.mock('../words-put-away', () => ({ usePutAwayAfterLeave: () => {} }));
const lock = vi.hoisted(() => ({ none: true }));
vi.mock('../words-on-screen', async (importOriginal) => {
    const real = await importOriginal<typeof import('../words-on-screen')>();
    return { ...real, holdNoScreenCapture: () => ({ answered: Promise.resolve(), release() {} }), useNoScreenLock: () => lock.none };
});
vi.mock('../words-clipboard', async (importOriginal) => {
    const real = await importOriginal<typeof import('../words-clipboard')>();
    return { ...real, copyWordsForAMinute: async () => {} };
});
vi.mock('../keeper-enrolment', async (importOriginal) => {
    const real = await importOriginal<typeof import('../keeper-enrolment')>();
    return { ...real, enrolKeepers: async () => phone.enrolment ?? { enrolled: [], generation: null, skipped: [], available: 0 } };
});
vi.mock('../restore-account', async (importOriginal) => {
    const real = await importOriginal<typeof import('../restore-account')>();
    return {
        ...real,
        // A different account on this phone: "Replace this phone's account?" is asked, and stays asked.
        restoreFromWords: async (_words: string[], _url: string, opts: { confirmReplace: (outgoing: unknown) => Promise<boolean> }) => {
            await opts.confirmReplace(phone.outgoing);
            return new Promise(() => {});
        },
    };
});
vi.mock('../node-profile', async (importOriginal) => {
    const real = await importOriginal<typeof import('../node-profile')>();
    return { ...real, checkGlobalDoor: async () => door.check, getCachedNodeProfile: async () => (door.cachedFeatures ? { features: door.cachedFeatures } : null) };
});
vi.mock('../global-door-offer', async (importOriginal) => {
    const real = await importOriginal<typeof import('../global-door-offer')>();
    return { ...real, askGlobalDoorOffer: async () => real.globalDoorOffer(), rememberGlobalDoor: () => {} };
});
vi.mock('../global-join', async (importOriginal) => {
    const real = await importOriginal<typeof import('../global-join')>();
    const key = { identity: { ...ids.SALLY }, createdHere: true };
    return {
        ...real,
        joinKeyForThisPhone: async () => key,
        signInAtDoor: async () => door.signIn ?? { kind: 'signed_in', signin: { provider: 'google', idToken: 'x', nonce: 'n' } },
        checkNameAtDoor: async () => ({ kind: 'free' }),
        commitJoinKey: async (k: { identity: unknown }, name: string) => ({ ...(k.identity as object), callsign: name }),
        submitJoin: async () => door.answer,
        submitWordsJoin: async () => door.answer,
        adoptJoinKey: async () => {}, releaseJoinKey: async () => false, keepJoinedIdentity: async (i: unknown) => i,
        joinedUnderNodeName: async (_u: string, _a: unknown, i: unknown) => i,
    };
});
vi.mock('../use-door-work', () => ({
    useDoorWork: () => ({ start: () => ({ state: () => ({ phase: 'ready' }) }), stop() {}, state: () => null, busy: null, runFor: () => null }),
}));
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    return { ...real, returnToApp: async () => {} };
});
vi.mock('../sso-recovery', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-recovery')>();
    return {
        ...real,
        lookupRestorable: async () => vaultState.candidates,
        waitingSsoRestore: async () => vaultState.waiting,
        checkSsoRestore: async () => vaultState.check,
        startSsoRestore: async () => vaultState.waiting,
        stopSsoRestoreAfterWords: async () => {},
        vaultKeepsNoCopyFor: () => false,
    };
});
vi.mock('../bundled-avatars', () => ({ BUNDLED_AVATARS: [], resolveBundledAvatar: () => 1 }));

// Shared with screens not swept yet: stand-ins (see the note above).
vi.mock('../../components/WordsDoor', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../components/WordsDoor')>();
    return {
        ...real,
        DoorChoices: () => createElement('span', { 'data-later-sweep': 'DoorChoices' }),
        DoorWorkProgress: () => null,
        WordsBackupNote: () => createElement('span', { 'data-later-sweep': 'WordsBackupNote' }),
    };
});
vi.mock('../../components/LinkSignInSheet', () => ({ LinkSignInSheet: () => null }));
vi.mock('../../components/AvatarPickerSheet', () => ({ AvatarPickerSheet: () => null }));
vi.mock('../../components/RecoveryWordsEntry', async () => {
    const { useEffect: effect } = await import('react');
    return {
        // Types the 12 words, as a member would.
        RecoveryWordsEntry: ({ onChange }: { onChange: (w: string[]) => void }) => {
            effect(() => { onChange('apple banana cherry delta eagle fabric garden hollow island jungle kettle lemon'.split(' ')); }, []);
            return createElement('span', { 'data-later-sweep': 'RecoveryWordsEntry' });
        },
    };
});
vi.mock('../../components/SavedNodePicker', () => ({
    SavedNodePicker: ({ label, actionLabel, hint }: { label: string; actionLabel: string; hint?: string }) => createElement('div', { 'data-later-sweep': 'SavedNodePicker' },
        createElement('span', null, label), createElement('span', null, actionLabel), hint ? createElement('span', null, hint) : null),
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/SsoButton', () => {
    const button = (name: string) => ({ title, onPress }: { title?: string; onPress: () => void }) => createElement('button', { role: 'button', 'aria-label': title, 'data-sso': name, onClick: onPress }, title);
    return { GoogleButton: button('google'), AppleButton: button('apple'), FacebookButton: button('facebook'), GoogleLogo: () => null, AppleLogo: () => null, FacebookLogo: () => null };
});

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { LanguageSwitch } from '../../components/LanguagePicker';
import WelcomeScreen from '../../app/welcome';
import { noVault, useVault } from './fake-vault';
import { DOOR_MESSAGES } from '../global-join';
import { restoreAtDoorHref } from '../open-door';

const NATIVE_WORDS = path.resolve(__dirname, '../../words');
const catalog = (lang: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, `${lang}.json`), 'utf8'));

/** Written by members or communities, or never translated: shown as written in every language. */
const AS_WRITTEN = ['Sally', 'Kim', 'Ana', 'Mullum', 'mullum.beanpool.org', 'global.beanpool.org', 'WIPE', 'Google', 'Apple', 'Facebook', ...WORDS, ...OUT_WORDS];

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    store.map.clear();
    alerts.said.length = 0; alerts.buttons.length = 0; prompts.asked.length = 0;
    params.now = {};
    nav.pushed.length = 0;
    clip.has = false; clip.text = '';
    lock.none = true;
    phone.stored = null; phone.pending = null; phone.enrolment = null; phone.outgoing = null; phone.redeemFails = null;
    phone.invite = { valid: true, inviterCallsign: 'Ana', communityName: 'Mullum' };
    door.check = { ok: true, profile: { features: {} } }; door.answer = null; door.signIn = null; door.cachedFeatures = null;
    vaultState.waiting = null; vaultState.check = null; vaultState.candidates = [];
    noVault();
    setLanguage('en');
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    noVault();
    setLanguage('en');
});

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(lang: UiLang, extra: unknown[] = []): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, ...(extra as any[]), createElement(WelcomeScreen, { key: 'welcome' })) as any);
    });
    await settle();
    return host;
}
const all = (sel: string) => Array.from(host!.querySelectorAll(sel)) as HTMLElement[];
/** A button by its words (or spoken name), in the pseudo-locale or not. */
function button(words: string, lang: UiLang): HTMLElement {
    const want = lang === 'xx' ? pseudoLocalise(words) : words;
    const found = all('button, [role="button"]').find((b) => b.textContent === want || b.getAttribute('aria-label') === want || (b.textContent ?? '').includes(want));
    expect(found, `a button "${words}"`).toBeTruthy();
    return found!;
}
async function press(words: string, lang: UiLang) {
    const b = button(words, lang);
    await act(async () => { b.click(); });
    await settle();
}
/** A button whose words are exactly these (a sentence with a name in it, as drawn). */
async function pressExactly(words: string) {
    const b = all('button, [role="button"]').find((x) => x.textContent === words);
    expect(b, `a button "${words}"`).toBeTruthy();
    await act(async () => { b!.click(); });
    await settle();
}
async function type(placeholder: string, text: string, lang: UiLang) {
    const want = lang === 'xx' ? pseudoLocalise(placeholder) : placeholder;
    const input = all('input').find((i) => i.getAttribute('placeholder') === want) as HTMLInputElement | undefined;
    expect(input, `a field "${placeholder}"`).toBeTruthy();
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, text);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
}

/** Letters left once every bracket, and what is shown as written, are taken out. */
function outsideBrackets(text: string): string {
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const n of [...AS_WRITTEN].sort((a, b) => b.length - a.length)) rest = rest.split(n).join('');
    return rest.replace(/[^\p{L}]+/gu, ' ').trim();
}
/** Everything a member reads or hears on screen now, and every alert and lock prompt so far. */
function everything(): Array<[where: string, text: string]> {
    const out: Array<[string, string]> = [];
    for (const n of all('span, button, div, input, img, i')) {
        if (n.closest('[data-later-sweep]')?.getAttribute('data-later-sweep') !== 'SavedNodePicker' && n.closest('[data-later-sweep]')) continue;
        const own = Array.from(n.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join('');
        // A name's first letter, in the avatar's place before a photo is picked: the name as written.
        const initial = /^\p{Lu}$/u.test(own.trim()) && AS_WRITTEN.some((name) => name.startsWith(own.trim()));
        if (own.trim() && !initial) out.push(['text', own]);
        for (const attr of ['aria-label', 'data-hint', 'placeholder']) {
            const v = n.getAttribute(attr);
            if (v) out.push([attr, v]);
        }
    }
    for (const said of alerts.said) out.push(['alert', said]);
    for (const asked of prompts.asked) out.push(['lock prompt', asked]);
    return out;
}
/** In the pseudo-locale: nothing on screen bypassed t(). Text is joined per element, so a sentence split into pieces still reads as one. */
function wholly(step: string) {
    const seen = everything();
    expect(seen.length, `${step}: something is on screen`).toBeGreaterThan(3);
    const leaks = seen.filter(([, text]) => outsideBrackets(text) !== '').map(([where, text]) => `${where}: ${text}`);
    expect(leaks, `${step}: English outside t()`).toEqual([]);
}

// ── 320 dp at 1.3× ────────────────────────────────────────────────────────────────────────────────────────────────
const FLOOR = 320;
const FONT_SCALE = 1.3;
/** As language-switch-render.test.ts: 0.62 em a letter, 1.25 an emoji, nothing for joiners and marks. */
const glyphEm = (c: string) => (/\p{M}/u.test(c) ? 0 : '\uFE0F\u200C\u200D\u200B'.includes(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, fontSize: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * fontSize * FONT_SCALE, 0);
/** The widest piece a line can't break inside: a word (the pseudo-locale's ~ padding breaks every five, so it is no word). */
const widestPiece = (text: string) => text.split(/[\s~[\]\u200B]+/).reduce((a, w) => (widthOf(w, 1) > widthOf(a, 1) ? w : a), '');
const fontOf = (el: Element | null): number => { for (let e = el; e; e = e.parentElement) { const f = e.getAttribute('data-font'); if (f) return Number(f); } return 16; };
/** The card's line: the scroll's 24 dp and the card's 24 dp a side. */
const CARD_LINE = FLOOR - 2 * 24 - 2 * 24;
function buttonsFit(step: string) {
    for (const b of all('button')) {
        for (const leaf of [b, ...Array.from(b.querySelectorAll('span'))].filter((e) => Array.from(e.childNodes).some((c) => c.nodeType === 3 && c.textContent!.trim()))) {
            const own = Array.from(leaf.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join('');
            const piece = widestPiece(own);
            expect(widthOf(piece, fontOf(leaf)), `${step}: "${piece}" at ${fontOf(leaf)} on a 320 dp card`).toBeLessThanOrEqual(CARD_LINE);
        }
    }
}
/**
 * A row that doesn't wrap lays its children side by side at their own width: a Text in it longer than the line runs past
 * the edge unless it may shrink (React Native's flexShrink is 0 by default), and then it wraps.
 */
function rowsWrap(step: string) {
    for (const row of all('[data-row]:not([data-wrap])')) {
        for (const child of Array.from(row.children) as HTMLElement[]) {
            if (child.tagName !== 'SPAN' || !/\p{L}/u.test(child.textContent ?? '')) continue;
            if (widthOf(child.textContent!, fontOf(child)) <= CARD_LINE) continue;
            expect(child.getAttribute('data-shrink'), `${step}: "${child.textContent}" runs past its row`).toBe('true');
        }
    }
}
const check = (step: string) => { wholly(step); buttonsFit(step); rowsWrap(step); };

describe('the join wizard in the pseudo-locale: every sentence through t(), at 320 dp with 1.3× text', () => {
    it('Join BeanPool: the paste alerts, the checks before Next, and a spent invite with its way to Recover', async () => {
        clip.has = true; clip.text = 'hello';
        await mount('xx');
        await press('📋 Been sent an invite? Tap to check your clipboard', 'xx');
        expect(alerts.said).toContain(pseudoLocalise('No invite found'));
        check('home, after the clipboard alert');
        await act(async () => { alerts.buttons.find((b) => b.text === pseudoLocalise('OK'))!.onPress!(); });
        await settle();

        await press('Next →', 'xx');
        check('Join BeanPool, no invite');
        await type('Paste your invite link or code', 'BP-ABCD-1234', 'xx');
        await type('Community name or address (e.g. mullum)', 'mullum', 'xx');
        await type('Your name or nickname', 'Sally', 'xx');
        phone.invite = { valid: false, reason: 'used' };
        await press('Next →', 'xx');
        expect(host!.textContent).toContain(pseudoLocalise('This invite has already been used — each one works exactly once. Ask whoever invited you to send a fresh one (it only takes them a minute).'));
        // The way to Recover still shows under the screen's own sentence, in any language (it read the English before).
        button('🔑 Recover an existing account with seed phrase →', 'xx');
        check('Join BeanPool, a spent invite');
    });

    it("Join BeanPool: the redeem had no answer in time, and the reason is in the member's language too", async () => {
        // utils/db.ts REDEEM_NO_ANSWER, the failure a member on a slow link gets (PR #2206 review; welcome-lines.test.ts holds it to db.ts).
        const noAnswer = 'No answer from the community node in time. Check your connection and try again.';
        phone.redeemFails = noAnswer;
        await mount('xx');
        await press('🎟️ Join with an invite', 'xx');
        await type('Paste your invite link or code', 'BP-ABCD-1234', 'xx');
        await type('Community name or address (e.g. mullum)', 'mullum', 'xx');
        await type('Your name or nickname', 'Sally', 'xx');
        await press('Next →', 'xx');
        expect(host!.textContent).toContain(pseudoLocalise('Failed to register identity: {reason}').replace('{reason}', pseudoLocalise(noAnswer)));
        check('Join BeanPool, the redeem with no answer');
    });

    it('Your Photo, Safety Backup (words shown, and the Go back? alert) and How it Works', async () => {
        await mount('xx');
        await press('🎟️ Join with an invite', 'xx');
        await type('Paste your invite link or code', 'BP-ABCD-1234', 'xx');
        await type('Community name or address (e.g. mullum)', 'mullum', 'xx');
        await type('Your name or nickname', 'Sally', 'xx');
        await press('Next →', 'xx');
        // The invite's line: one sentence, the inviter's and the community's names in it as written.
        expect(host!.textContent).toContain(pseudoLocalise('🎟️ Your invite from {inviter} checks out — welcome to {community}!').replace('{inviter}', 'Ana').replace('{community}', 'Mullum'));
        check('Your Photo');

        await press('Next →', 'xx');
        expect(host!.textContent).toContain(pseudoLocalise('No pen handy? Carry on — you can come back to these any time under Settings → Recovery Phrase.'));
        // The 12 words as written: never looked up. Each cell's spoken name places the word in the sentence.
        for (const [i, w] of WORDS.entries()) expect(all('[aria-label]').map((e) => e.getAttribute('aria-label'))).toContain(pseudoLocalise('Word {n}: {word}').replace('{n}', String(i + 1)).replace('{word}', w));
        for (const w of WORDS) expect(host!.textContent).toContain(w);
        check('Safety Backup, words shown');
        await press('← Back', 'xx');
        expect(alerts.said).toEqual(expect.arrayContaining([pseudoLocalise('Have you saved your words?'), pseudoLocalise("If you go back now, you'll need to start over."), pseudoLocalise('Stay'), pseudoLocalise('Go Back')]));
        check('Safety Backup, the Go back? alert');

        await press('Next →', 'xx');
        expect(host!.textContent).toContain(pseudoLocalise('The best place to be is zero (0 Beans).'));
        check('How it Works');
    });

    it('Safety Backup with a sign-in covering the account, one that used to protect another, and How it Works with no Beans', async () => {
        phone.stored = SALLY;
        phone.pending = { step: 'seedBackup', flow: 'global', inviteCode: '', anchorUrl: 'https://global.beanpool.org', callsign: 'Sally', redeemed: true, newKey: SALLY.publicKey,
            joinEnrolment: { enrolled: ['sso'], generation: 1, skipped: [], available: 1, enrolledSso: ['google'], threshold: 1, isSingleBlob: true, replaced: true } };
        door.cachedFeatures = { beans: false };
        await mount('xx');
        expect(host!.textContent).toContain(pseudoLocalise('This {provider} account used to protect a different BeanPool account. It protects this one now, and that one has only its 12 words.').replace('{provider}', 'Google'));
        check('Safety Backup, covered');
        await press('Rather write down 12 words?', 'xx');
        check('Safety Backup, covered, words shown');
        await press('Next →', 'xx');
        expect(host!.textContent).toContain(pseudoLocalise('🌍 A place to meet'));
        expect(host!.textContent).not.toContain(pseudoLocalise('🪙 The Mutual Credit Ledger'));
        check('How it Works, no Beans');
    });
});

describe("the global community's door in the pseudo-locale", () => {
    it('shut: the door\'s own sentence, Try again and Join with an invite', async () => {
        door.check = { ok: false, reason: 'door_closed' };
        await mount('xx');
        await press('🌍 Explore BeanPool worldwide', 'xx');
        expect(host!.textContent).toContain(pseudoLocalise(DOOR_MESSAGES.doorClosed));
        check('the door, shut');
    });

    it('the sign-in, the name step, and an answer that sends the member to restore', async () => {
        useVault();
        await mount('xx');
        await press('🌍 Explore BeanPool worldwide', 'xx');
        check('the door, signing in');
        await press('Continue with Google', 'xx');
        expect(host!.textContent).toContain(pseudoLocalise('✅ Signed in with {provider}').replace('{provider}', 'Google'));
        check('the door, the name step');
        await type('Your name or nickname', 'Sally', 'xx');
        door.answer = { kind: 'already_joined', message: DOOR_MESSAGES.alreadyJoined };
        await press('Join →', 'xx');
        expect(host!.textContent).toContain(pseudoLocalise(DOOR_MESSAGES.alreadyJoined));
        check('the door, already joined');
    });

    it('a door with the 12-words way: the two ways side by side (WordsDoor is a stand-in), and the sign-in again', async () => {
        door.check = { ok: true, profile: { features: { wordsDoor: true } } };
        await mount('xx');
        await press('🌍 Explore BeanPool worldwide', 'xx');
        expect(host!.querySelector('[data-later-sweep="DoorChoices"]')).toBeTruthy();
        check('the door, two ways');
    });
});

describe('restoring an account in the pseudo-locale', () => {
    it('Restore your account, Recover with 12 Words, and "Replace this phone\'s account?" with the outgoing words behind the lock', async () => {
        phone.outgoing = KIM;
        await mount('xx');
        await press('🔑 Already a Member? Restore Account →', 'xx');
        check('Restore your account');
        await press('🔑 Recover with 12 Words', 'xx');
        check('Recover with 12 Words, empty');
        await type('Community name or address (e.g. mullum)', 'mullum', 'xx');
        expect(host!.textContent).toContain(pseudoLocalise('Will connect to {address} — if your community is hosted elsewhere, enter its full address instead.').replace('{address}', 'mullum.beanpool.org'));
        check('Recover with 12 Words, an address');
        await press('Recover Identity', 'xx');
        expect(host!.textContent).toContain(pseudoLocalise("⚠️ Replace this phone's account?"));
        check('Replace, before Show');
        await pressExactly(pseudoLocalise("🔑 Show {name}'s 12 words").replace('{name}', 'Kim'));
        expect(prompts.asked).toContain(pseudoLocalise("Confirm your security to view {name}'s recovery phrase.").replace('{name}', 'Kim'));
        for (const w of OUT_WORDS) expect(host!.textContent).toContain(w);
        check('Replace, the outgoing words shown');
    });

    it('a phone account restored with a sign-in, so it has no words: the warning by its name', async () => {
        phone.outgoing = { ...KIM, mnemonic: undefined };
        await mount('xx');
        await press('🔑 Already a Member? Restore Account →', 'xx');
        await press('🔑 Recover with 12 Words', 'xx');
        await type('Community name or address (e.g. mullum)', 'mullum', 'xx');
        await press('Recover Identity', 'xx');
        expect(host!.textContent).toContain(pseudoLocalise('This phone was restored with a sign-in, so it has no 12 words for {name}. Without a connected sign-in, you cannot get {name} back.').replaceAll('{name}', 'Kim'));
        check('Replace, no words');
    });

    it('a sign-in restore at the community (a build without a key vault): the form, and the account the whole name finds', async () => {
        vaultState.candidates = [{ publicKey: 'e5'.repeat(32), callsign: 'Sally', canRecoverBySso: true, joinedAt: '2026-03-05T00:00:00Z' }];
        await mount('xx');
        await press('🔑 Already a Member? Restore Account →', 'xx');
        await press('🌐 Recover with Social', 'xx');
        check('Recover with Social Sign-In, at the community');
        await type('Your Callsign (e.g. Monnunit)', 'Sally', 'xx');
        await type('Community name or address (e.g. mullum)', 'mullum', 'xx');
        await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
        await settle();
        expect(host!.textContent).toContain(pseudoLocalise('Is this you?'));
        // "joined March 2026": core's month-year pattern writes the date whole, in the language's order and forms.
        expect(host!.textContent).toContain(pseudoLocalise('joined {date}').replace('{date}', pseudoLocalise('March 2026')));
        check('Recover with Social Sign-In, Is this you?');
    });

    it('a sign-in restore at the key vault: waiting for it, and choosing its community once it is back', async () => {
        useVault();
        vaultState.waiting = { v: 1, provider: 'google', sub: 's', holdId: 'h1', until: Date.now() + 5 * 3_600_000 };
        vaultState.check = { status: 'held', until: Date.now() + 5 * 3_600_000 };
        params.now = { mode: 'ssoRecover' };
        await mount('xx');
        expect(host!.textContent).toContain(pseudoLocalise('Keep BeanPool on this phone: it checks by itself. Your 12 words work any time, with no wait.'));
        check('the key vault, waiting');
        act(() => root?.unmount()); host?.remove();

        vaultState.check = { status: 'released', restored: { identity: SALLY } };
        await mount('xx');
        expect(host!.textContent).toContain(pseudoLocalise('Your account is back. Which community do you want to open it in? You can add your other communities afterwards.'));
        check('the key vault, released');
    });

    it('a sign-in restore at the key vault, not started: the three ways back', async () => {
        useVault();
        params.now = { mode: 'ssoRecover' };
        await mount('xx');
        check('the key vault, sign in');
    });
});

describe('a language picked on an open step redraws it, live', () => {
    it('Safety Backup in English, then French from the real catalog; a sentence the drafting pass has not reached yet shows its English', async () => {
        phone.stored = SALLY;
        phone.pending = { step: 'seedBackup', inviteCode: 'BP-1', anchorUrl: 'https://mullum.beanpool.org', callsign: 'Sally', redeemed: true, newKey: SALLY.publicKey };
        const page = await mount('en', [createElement(LanguageSwitch, { key: 'switch' })]);
        expect(page.textContent).toContain('Safety Backup');
        const fr = catalog('fr');
        await act(async () => { (page.querySelector('[data-testid="language-switch"]') as HTMLElement).click(); });
        await settle();
        await act(async () => { (page.querySelector('[data-testid="language-fr"]') as HTMLElement).click(); });
        await settle();
        // The stepper and Next are in the catalog: French now, on the same open step.
        expect(page.textContent).toContain(fr['Safety Backup'] as string);
        expect(page.textContent).toContain(fr['Next →'] as string);
        expect(page.textContent).not.toContain('Safety Backup');
        // A sentence of this sweep's the catalog doesn't have yet: its English, never a gap.
        const pen = 'No pen handy? Carry on — you can come back to these any time under Settings → Recovery Phrase.';
        expect(page.textContent).toContain(typeof fr[pen] === 'string' ? fr[pen] as string : pen);
    });
});

/**
 * PR #2564's deciding review (not blocking, taken): another community's door's **🔑 Restore my account**
 * (app/join-open-door.tsx) opened this restore with an empty address field on a new phone, and the member had to type the
 * address shown under the door's title. The door hands it over in memory (utils/open-door.ts restoreAtDoorHref).
 */
describe("another community's door sent the member here to restore", () => {
    const SELF = 'https://open.riverbend.example';
    const field = () => all('input').find((i) => i.getAttribute('placeholder') === 'Community name or address (e.g. mullum)') as HTMLInputElement | undefined;

    it("with 12 words: the address field is that community's, over the phone's anchor", async () => {
        store.map.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
        restoreAtDoorHref(SELF);
        params.now = { mode: 'member' };
        await mount('en');
        expect(host!.textContent).toContain('🔑 Restore your account');
        await press('🔑 Recover with 12 Words', 'en');
        expect(field()?.value).toBe(SELF);
    });

    it("with a sign-in, at the community: the same address", async () => {
        restoreAtDoorHref(SELF);
        params.now = { mode: 'member' };
        await mount('en');
        await press('🌐 Recover with Social', 'en');
        expect(field()?.value).toBe(SELF);
    });

    it("opened any other way, nothing is handed over: the phone's anchor, as before; and a hand-over is read once", async () => {
        store.map.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
        params.now = { mode: 'member' };
        await mount('en');
        await press('🔑 Recover with 12 Words', 'en');
        expect(field()?.value).toBe('https://mullum.beanpool.org');
        act(() => root?.unmount()); host?.remove();

        restoreAtDoorHref(SELF);
        await mount('en');
        act(() => root?.unmount()); host?.remove();
        await mount('en');
        await press('🔑 Recover with 12 Words', 'en');
        expect(field()?.value).toBe('https://mullum.beanpool.org');
    });

    it("from a door the welcome screen pushed: the welcome in view takes the address, never the one under it", async () => {
        // welcome → the door (router.push) → its Restore (router.replace): the stack is [welcome, welcome], both mounted,
        // and the params are global, so both read mode=member. The one under it, earlier in the tree, took the hand-over
        // first, and the one in view showed the phone's anchor (PR #2564 review). The router runs the one in view's focus
        // effects once its navigation has loaded, after welcome has consumed the param (router.setParams({ mode: '' })).
        store.map.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        const screen = (name: string, focused: boolean) => createElement('div', { key: name, 'data-screen': name }, createElement(focus.ctx.Provider, { value: focused }, createElement(WelcomeScreen)));
        const stack = (...screens: unknown[]) => createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, ...(screens as any[]));
        await act(async () => { root!.render(stack(screen('under', true)) as any); });
        await settle();
        restoreAtDoorHref(SELF);
        params.now = { mode: 'member' };
        await act(async () => { root!.render(stack(screen('under', false), screen('in-view', false)) as any); });
        await settle();
        params.now = { mode: '' };
        await act(async () => { root!.render(stack(screen('under', false), screen('in-view', true)) as any); });
        await settle();
        const inView = host.querySelector('[data-screen="in-view"]') as HTMLElement;
        expect(inView.textContent).toContain('🔑 Restore your account');
        const recover = Array.from(inView.querySelectorAll('button, [role="button"]')).find((b) => (b.textContent ?? '').includes('🔑 Recover with 12 Words')) as HTMLElement;
        expect(recover, 'a button "🔑 Recover with 12 Words"').toBeTruthy();
        await act(async () => { recover.click(); });
        await settle();
        const address = Array.from(inView.querySelectorAll('input')).find((i) => i.getAttribute('placeholder') === 'Community name or address (e.g. mullum)');
        expect(address?.value).toBe(SELF);
    });

    // The door's record still on the phone at its Restore: welcome's resume pushed the door again over the restore it had
    // just opened, and the button read as doing nothing (PR #2564 review). The record stays: Back out of the restore, and
    // the next launch, still resume the door; a restore that lands clears it (utils/restore-account.ts).
    const doorRecord = { step: 'globalJoin', flow: 'global', inviteCode: '', anchorUrl: SELF, callsign: 'Sally', redeemed: false };
    for (const [kind, record] of [
        ['a key an invite join took over (its sign-in had an account there already)', { ...doorRecord, newKey: SALLY.publicKey }],
        ["a key the door made whose join's answer never came", { ...doorRecord, freshKey: SALLY.publicKey, joinsOut: 1 }],
    ] as const) {
        it(`the door's record still on the phone, ${kind}: the restore stays in view, never the door again over it`, async () => {
            phone.stored = SALLY;
            phone.pending = { ...record };
            restoreAtDoorHref(SELF);
            params.now = { mode: 'member' };
            await mount('en');
            expect(nav.pushed).toEqual([]);
            expect(host!.textContent).toContain('🔑 Restore your account');
            await press('🔑 Recover with 12 Words', 'en');
            expect(field()?.value).toBe(SELF);
        });
    }

    it("the door's record still on the phone, from a door the welcome screen pushed: the restore in view, its resume run before its focus, sends nobody back", async () => {
        // welcome (the door's record: back to the door, router.push) → the door's Restore (router.replace). The one in view
        // mounts before its navigation has loaded, so its resume can finish before its focus effect takes the hand-over:
        // it looks without taking it (utils/open-door.ts restoreAtWaiting).
        phone.stored = SALLY;
        phone.pending = { ...doorRecord, newKey: SALLY.publicKey };
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        const screen = (name: string, focused: boolean) => createElement('div', { key: name, 'data-screen': name }, createElement(focus.ctx.Provider, { value: focused }, createElement(WelcomeScreen)));
        const stack = (...screens: unknown[]) => createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, ...(screens as any[]));
        await act(async () => { root!.render(stack(screen('under', true)) as any); });
        await settle();
        expect(nav.pushed).toEqual([{ pathname: '/join-open-door', params: { node: SELF } }]);
        restoreAtDoorHref(SELF);
        params.now = { mode: 'member' };
        await act(async () => { root!.render(stack(screen('under', false), screen('in-view', false)) as any); });
        await settle();
        params.now = { mode: '' };
        await act(async () => { root!.render(stack(screen('under', false), screen('in-view', true)) as any); });
        await settle();
        expect(nav.pushed).toHaveLength(1);
        const inView = host.querySelector('[data-screen="in-view"]') as HTMLElement;
        expect(inView.textContent).toContain('🔑 Restore your account');
        const recover = Array.from(inView.querySelectorAll('button, [role="button"]')).find((b) => (b.textContent ?? '').includes('🔑 Recover with 12 Words')) as HTMLElement;
        expect(recover, 'a button "🔑 Recover with 12 Words"').toBeTruthy();
        await act(async () => { recover.click(); });
        await settle();
        const address = Array.from(inView.querySelectorAll('input')).find((i) => i.getAttribute('placeholder') === 'Community name or address (e.g. mullum)');
        expect(address?.value).toBe(SELF);
    });

    it("the door's record still on the phone, and welcome opened any other way: back to the door, as before", async () => {
        phone.stored = SALLY;
        phone.pending = { ...doorRecord, freshKey: SALLY.publicKey, joinsOut: 1 };
        await mount('en');
        expect(nav.pushed).toEqual([{ pathname: '/join-open-door', params: { node: SELF } }]);
    });
});
