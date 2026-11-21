// @vitest-environment jsdom
/**
 * The join's last screen never waits on the network, and never strands the member (review of #3335 at 95336d22: finding 1,
 * the owner's counts were awaited before the phone's pop-up and before Home; finding 2, a failed end was drawn nowhere;
 * DESIGN-notify-and-backup-asks-fable-amend2.md §4.2 "The screen waits on no network"; onboarding: never block, never a
 * hard gate). app/welcome.tsx rendered for real, resumed on the notifications screen (or on the way back, for the hand-over),
 * with the community, the phone's notifications module and the join's end each made to hang or fail, one row per wait
 * between a tap and the next screen:
 *
 * - the owner's count of the showing, and of the answer (each a signed POST a slow community holds): Turn on still brings
 *   the phone's pop-up at the tap and goes on to Home, Later goes straight to Home, and each count is sent once;
 * - the phone's state read (on the way in, at the screen, and at the tap) and Android's channels: bounded, never a spinner
 *   for good;
 * - the join's end itself: its photo publish bounded, and a failed end says so in the words the way back and the owner's card
 *   use, with Try again, which ends the join.
 *
 * The harness (React Native's host components as plain tags, every lower layer stubbed, nothing contacted) is
 * welcome-words-render.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Some components don't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

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
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardStickyView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
});
// The phone's notifications module, as each row sets it: its state read, Android's channels, its own pop-up.
const os = vi.hoisted(() => ({
    order: [] as string[],
    read: async (): Promise<{ status: string; canAskAgain: boolean }> => ({ status: 'undetermined', canAskAgain: true }),
    channel: async (): Promise<null> => null,
    ask: async (): Promise<{ status: string; canAskAgain: boolean }> => ({ status: 'granted', canAskAgain: true }),
}));
vi.mock('expo-notifications', () => {
    const mod = {
        getPermissionsAsync: () => os.read(),
        setNotificationChannelAsync: (id: string) => { os.order.push(`channel:${id}`); return os.channel(); },
        requestPermissionsAsync: () => { os.order.push('ask'); return os.ask(); },
        AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1, NONE: 0 },
    };
    return { default: mod, ...mod };
});
vi.mock('../../services/push-notifications', () => ({ registerForPushNotifications: async () => null }));
// The community: each owner's count (a signed POST, which a slow community holds), the photo's publish, and the join's end.
const net = vi.hoisted(() => ({
    counts: [] as string[],
    count: async (_event: string): Promise<void> => {},
    ends: 0,
    endFails: 0,
}));
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
// The join's end (handleConfirmSeed): the account the app is handed, and which way Home's "Your way back in" card starts
// (slice S4: put away only when a way back is kept). `keptBefore`: what the phone already knew (utils/way-back-kept.ts).
const landing = vi.hoisted(() => ({ identity: null as unknown, reminder: null as null | 'putAway' | 'shown', keptBefore: false }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: null, setIdentity(i: unknown) { landing.identity = i; } }) }));
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
    invite: { valid: true, inviterCallsign: 'Ana', communityName: 'Riverside' } as Record<string, unknown>,
    outgoing: null as any,
    redeemFails: null as string | null,
}));
const door = vi.hoisted(() => ({
    check: { ok: true, profile: { features: {} } } as any,
    answer: null as any,
    signIn: null as any,
    cachedFeatures: null as any,
    /** The community's rule for copies as this phone kept it just now (fresh), or null when it never heard one. */
    cachedRule: null as null | string,
    /** Where a case gives each community its own rule: by the address asked, over `cachedRule`. */
    rulesAt: {} as Record<string, string>,
    /** Each address whose kept answer was read, in order. */
    profilesAsked: [] as string[],
}));
/** The add-a-sign-in sheet as welcome last drew it (a stand-in: components/LinkSignInSheet is swept with the key components). */
const linkSheet = vi.hoisted(() => ({ props: null as null | Record<string, any> }));
/** The sign-in sheet's connect, when a case answers it (utils/sso-sheet-connect.ts); otherwise the real one. */
const sheetConnect = vi.hoisted(() => ({ answer: null as null | ((options: Record<string, unknown>) => Promise<unknown>) }));
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
        setPendingOnboarding: async () => {}, updatePendingOnboarding: async () => {},
        clearPendingOnboarding: async () => { net.ends += 1; if (net.endFails > 0) { net.endFails -= 1; throw new Error(''); } },
        recordJoinKeyMade: async () => {},
    };
});
vi.mock('../db', () => ({
    checkInvite: async () => phone.invite,
    redeemInvite: async () => { if (phone.redeemFails) throw new Error(phone.redeemFails); return {}; },
    updateMemberProfile: async () => {},
    fetchNodeCallsign: async () => 'Sally',
    recordOnboardingEvent: (event: string, variant?: string) => { net.counts.push(variant ? `${event}:${variant}` : event); return net.count(event); },
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
vi.mock('../one-way-back', () => ({
    startOneWayBack: async () => {},
    startOneWayBackPutAway: async () => { landing.reminder = 'putAway'; },
    startOneWayBackShown: async () => { landing.reminder = 'shown'; },
}));
vi.mock('../way-back-kept', () => ({ wayBackKeptBefore: async () => landing.keptBefore }));
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
    return {
        ...real,
        checkGlobalDoor: async () => door.check,
        getCachedNodeProfile: async (url?: string | null) => {
            if (url) door.profilesAsked.push(url);
            const rule = (url ? door.rulesAt[url] : undefined) ?? door.cachedRule;
            return rule
                ? { features: door.cachedFeatures ?? {}, recoveryCopies: rule, checkedAt: new Date().toISOString() }
                : door.cachedFeatures ? { features: door.cachedFeatures } : null;
        },
    };
});
vi.mock('../sso-sheet-connect', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-sheet-connect')>();
    return { ...real, connectAndDeposit: (options: any) => (sheetConnect.answer ? sheetConnect.answer(options) : real.connectAndDeposit(options)) };
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
        // The community's find (recovery S2): it names `candidates` for the sign-in, and with several the screen asks which.
        // Nothing is restored here: the test reads the screens up to the pick.
        recoverAccountWithSso: async (o: { pickAccount?: (accounts: unknown[]) => Promise<unknown> }) => {
            if (vaultState.candidates.length > 1) await o.pickAccount?.(vaultState.candidates);
            throw Object.assign(new Error('Sign-in was cancelled.'), { reason: 'cancelled' });
        },
        waitingSsoRestore: async () => vaultState.waiting,
        checkSsoRestore: async () => vaultState.check,
        startSsoRestore: async () => vaultState.waiting,
        stopSsoRestoreAfterWords: async () => {},
        vaultKeepsNoCopyFor: () => false,
    };
});
vi.mock('../bundled-avatars', () => ({ BUNDLED_AVATARS: [], resolveBundledAvatar: () => 1 }));

// Shared with screens not swept yet: stand-ins (see the note above). The two ways in (DoorChoices) are the real ones.
vi.mock('../../components/WordsDoor', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../components/WordsDoor')>();
    return {
        ...real,
        DoorWorkProgress: () => null,
        WordsBackupNote: () => createElement('span', { 'data-later-sweep': 'WordsBackupNote' }),
    };
});
vi.mock('../../components/LinkSignInSheet', () => ({ LinkSignInSheet: (props: Record<string, any>) => { linkSheet.props = props; return null; } }));
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

import { NOTIFY_CHOICE, NOTIFY_SHOWN, setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import WelcomeScreen from '../../app/welcome';
import { noVault } from './fake-vault';
import { NOTIFY_JOIN_WAIT_MS } from '../notify-join-step';
import { JOIN_END_WAIT_MS } from '../join-steps';
import { readNotificationPermissionRecord } from '../notification-permission';

const HERE = 'https://riverside.example';
const never = <T,>() => new Promise<T>(() => {});
const WAITS = { phone: NOTIFY_JOIN_WAIT_MS.phone, photo: JOIN_END_WAIT_MS.photo };
const realFetch = globalThis.fetch;
/** Each publish of the photo the join's end sent, and whether it carried a way to stop it. */
const photo = { sent: [] as Array<{ url: string; stoppable: boolean }> };

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    store.map.clear();
    alerts.said.length = 0; alerts.buttons.length = 0; prompts.asked.length = 0;
    params.now = {};
    nav.pushed.length = 0;
    phone.stored = SALLY;
    phone.pending = { step: 'notify', flow: 'invite', inviteCode: 'BP-ABCD-1234', anchorUrl: HERE, callsign: 'Sally', redeemed: true, newKey: SALLY.publicKey };
    phone.enrolment = null; phone.outgoing = null; phone.redeemFails = null;
    phone.invite = { valid: true, inviterCallsign: 'Ana', communityName: 'Riverside' };
    landing.identity = null; landing.reminder = null; landing.keptBefore = false;
    door.check = { ok: true, profile: { features: {} } }; door.answer = null; door.signIn = null; door.cachedFeatures = null; door.cachedRule = null;
    door.rulesAt = {}; door.profilesAsked.length = 0;
    vaultState.waiting = null; vaultState.check = null; vaultState.candidates = [];
    os.order.length = 0;
    os.read = async () => ({ status: 'undetermined', canAskAgain: true });
    os.channel = async () => null;
    os.ask = async () => ({ status: 'granted', canAskAgain: true });
    net.counts.length = 0; net.count = async () => {}; net.ends = 0; net.endFails = 0;
    photo.sent.length = 0;
    NOTIFY_JOIN_WAIT_MS.phone = 40;
    JOIN_END_WAIT_MS.photo = 40;
    store.map.set('beanpool_anchor_url', HERE);
    noVault();
    setLanguage('en');
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    NOTIFY_JOIN_WAIT_MS.phone = WAITS.phone;
    JOIN_END_WAIT_MS.photo = WAITS.photo;
    globalThis.fetch = realFetch;
    noVault();
    setLanguage('en');
});

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(WelcomeScreen, { key: 'welcome' })) as any);
    });
    await settle();
    return host;
}
const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function tap(id: string) {
    const b = q(id);
    expect(b, id).toBeTruthy();
    await act(async () => { b!.click(); });
    await settle();
}
/** Waits (well past the bounds of 40 ms, well inside a 12 s POST) until `ok` holds; false if it never does. */
async function until(ok: () => boolean, ms = 600): Promise<boolean> {
    for (const end = Date.now() + ms; Date.now() < end;) {
        if (ok()) return true;
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    return ok();
}
const atHome = () => landing.identity !== null;
/** The notifications screen's own counts (the join sends others: its end's, the way back's). */
const notifyCounts = () => net.counts.filter((c) => c.startsWith('notify_'));

describe('the notifications screen: nothing between a tap and the next screen waits on the community', () => {
    it('resumed on it, the screen is drawn: Turn on notifications and Later', async () => {
        await mount();
        expect(q('notify-step-turn-on'), 'the screen').toBeTruthy();
        expect(q('notify-step-later')).toBeTruthy();
        expect(notifyCounts()).toEqual([NOTIFY_SHOWN]);
    });

    const COUNTS: Array<{ name: string; count: (event: string) => Promise<void> }> = [
        { name: "the showing's count hangs", count: (e) => (e === NOTIFY_SHOWN ? never() : Promise.resolve()) },
        { name: "the answer's count hangs", count: (e) => (e === NOTIFY_CHOICE ? never() : Promise.resolve()) },
        { name: 'every count hangs', count: () => never() },
        // The screen's counts refused (utils/db.ts swallows its own failures; this one doesn't, to show the screen does).
        { name: 'every count fails', count: async (e) => { if (e.startsWith('notify_')) throw new Error('502 Bad Gateway'); } },
    ];
    for (const c of COUNTS) {
        it(`${c.name}: Turn on brings the pop-up at the tap, then Home; each count sent once`, async () => {
            net.count = c.count;
            await mount();
            await tap('notify-step-turn-on');
            expect(os.order, 'the pop-up, at the tap').toContain('ask');
            expect(await until(atHome), 'Home').toBe(true);
            expect(notifyCounts()).toEqual([NOTIFY_SHOWN, `${NOTIFY_CHOICE}:on`]);
        });
        it(`${c.name}: Later goes straight to Home, no pop-up; each count sent once`, async () => {
            net.count = c.count;
            await mount();
            await tap('notify-step-later');
            expect(await until(atHome), 'Home').toBe(true);
            expect(os.order).not.toContain('ask');
            expect(notifyCounts()).toEqual([NOTIFY_SHOWN, `${NOTIFY_CHOICE}:later`]);
            expect((await readNotificationPermissionRecord()).phoneNoAt).toBeUndefined();
        });
    }
});

describe('the notifications screen: a phone that never answers holds nobody', () => {
    it('its state never read, on the way in from the way back: on to Home, no screen', async () => {
        phone.pending = { ...phone.pending, step: 'seedBackup' };
        os.read = () => never();
        await mount();
        await tap('way-back-button');
        expect(await until(atHome), 'Home').toBe(true);
        expect(os.order).toEqual([]);
        expect(notifyCounts()).toEqual([]);
    });

    it('its state never read, resumed on the screen: on to Home, never stranded on a spinner', async () => {
        os.read = () => never();
        await mount();
        expect(await until(atHome), 'Home').toBe(true);
        expect(os.order).toEqual([]);
    });

    it('its state read for the screen, then never again at the tap: a Later, no pop-up, Home', async () => {
        let atTap = false;
        os.read = () => (atTap ? never() : Promise.resolve({ status: 'undetermined', canAskAgain: true }));
        await mount();
        // Past the bound: the screen stays drawn while nobody taps.
        await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
        expect(q('notify-step-turn-on')).toBeTruthy();
        expect(atHome()).toBe(false);
        atTap = true;
        await tap('notify-step-turn-on');
        expect(await until(atHome), 'Home').toBe(true);
        expect(os.order).not.toContain('ask');
        expect(notifyCounts()).toEqual([NOTIFY_SHOWN, `${NOTIFY_CHOICE}:later`]);
        const rec = await readNotificationPermissionRecord();
        expect(typeof rec.laterAt).toBe('number');
        expect(rec.phoneNoAt).toBeUndefined();
    });

    it('Android never finishes making its channels: the pop-up all the same, then Home', async () => {
        os.channel = () => never();
        await mount();
        await tap('notify-step-turn-on');
        expect(await until(() => os.order.includes('ask')), 'the pop-up').toBe(true);
        expect(os.order[0]).toBe('channel:default');
        expect(await until(atHome), 'Home').toBe(true);
    });

    it("Android can't make its channels: the pop-up all the same, then Home", async () => {
        os.channel = async () => { throw new Error('no channel'); };
        await mount();
        await tap('notify-step-turn-on');
        expect(os.order).toContain('ask');
        expect(await until(atHome), 'Home').toBe(true);
    });
});

describe("the join's end, run from the notifications screen", () => {
    it("the end fails: its message on the screen, as the way back and the owner's card show it, and Try again ends the join", async () => {
        net.endFails = 1;
        await mount();
        await tap('notify-step-later');
        expect(await until(() => q('notify-step-error') !== null), 'the message').toBe(true);
        expect(q('notify-step-error')!.textContent).toBe('Failed to complete registration.');
        expect(atHome()).toBe(false);
        expect(q('notify-step-later'), 'the answer is kept: one button').toBeNull();
        await tap('notify-step-retry');
        expect(await until(atHome), 'Home').toBe(true);
        expect(net.ends).toBe(2);
        // The answer was not given twice.
        expect(notifyCounts()).toEqual([NOTIFY_SHOWN, `${NOTIFY_CHOICE}:later`]);
    });

    it('resumed on the screen after the phone answered, the end it goes on to fails: the message there too, and Try again ends the join', async () => {
        os.read = async () => ({ status: 'granted', canAskAgain: true });
        net.endFails = 1;
        await mount();
        expect(await until(() => q('notify-step-error') !== null), 'the message').toBe(true);
        expect(q('notify-step-error')!.textContent).toBe('Failed to complete registration.');
        expect(q('notify-step-turn-on'), 'nothing left to ask').toBeNull();
        await tap('notify-step-retry');
        expect(await until(atHome), 'Home').toBe(true);
        expect(os.order).toEqual([]);
        expect(notifyCounts()).toEqual([]);
    });

    it("the community never answers the photo's publish: the photo kept for later, and Home", async () => {
        phone.pending = { ...phone.pending, avatar: 'file:///photo.jpg' };
        globalThis.fetch = ((url: string, init?: { signal?: AbortSignal }) => {
            if (!String(url).endsWith('/api/profile/update')) return Promise.reject(new Error('not here'));
            photo.sent.push({ url: String(url), stoppable: !!init?.signal });
            return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        }) as typeof fetch;
        await mount();
        await tap('notify-step-later');
        expect(await until(atHome), 'Home').toBe(true);
        expect(photo.sent).toEqual([{ url: `${HERE}/api/profile/update`, stoppable: true }]);
    });
});
