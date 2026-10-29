// @vitest-environment jsdom
/**
 * Welcome's waiting mode (DESIGN-account-without-global-fable.md §2.4 and §4, slice S3; components/welcome/WaitingToJoin.tsx,
 * utils/waiting-to-join.ts) on the real welcome screen, with the harness of look-first-welcome-render.test.ts: React
 * Native's host components as plain tags, the node, the vault, the sign-ins and the phone's key store stubbed. Nothing is
 * contacted.
 *
 *   1. An account that is a member nowhere (no community in use, no wizard): the waiting mode in place of the doors, one
 *      line per community asked, Check again, Ask another community, Join with an invite, Restore. With a community in
 *      use, or a wizard part-way, it is not drawn.
 *   2. A yes: one tap joins it through the invite step, with this phone's key, and the wizard goes on at Your Photo; the
 *      record says the key's words are new (the knock made it), so Safety Backup shows them; the knock's mark goes, and so
 *      does the request.
 *   3. A yes whose redeem the community refuses: the invite step says so, and the phone has no community again (never one
 *      that hasn't taken it).
 *   4. Join with an invite opens the invite step; Ask another community opens Find a community.
 *   5. Restore over the waiting key: Recover with 12 Words still asks "Replace this phone's account?" first.
 *   6. An invite link on a waiting phone, which the root layout hands here (app/_layout.tsx, waiting-to-join.ts
 *      inviteLinkToWelcome): the invite step with the link's invite, its community and the account's name; Next joins with
 *      this key and the wizard goes on at Your Photo with the words new; a refused redeem leaves no community.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Some components don't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
const prompts = vi.hoisted(() => ({ asked: [] as string[] }));
/** The phone's back button: its handlers, as React Native keeps them (the latest first). */
const backs = vi.hoisted(() => ({ handlers: new Set<() => boolean>() }));

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
        BackHandler: {
            addEventListener: (_event: string, handler: () => boolean) => {
                backs.handlers.add(handler);
                return { remove() { backs.handlers.delete(handler); } };
            },
        },
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
const nav = vi.hoisted(() => ({ replaced: [] as unknown[], pushed: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: {
            push(to: unknown) { nav.pushed.push(to); }, navigate() {}, replace(to: unknown) { nav.replaced.push(to); }, back() {},
            setParams(p: Record<string, string>) { Object.assign(params.now, p); }, canGoBack: () => true, canDismiss: () => false, dismissAll() {},
        },
        useGlobalSearchParams: () => params.now,
        useLocalSearchParams: () => params.now,
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useIsFocused: () => true,
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
/** The phone's key item, as expo-secure-store answers for it: none, an item that isn't an account, or a read that throws. */
const keyItem = vi.hoisted(() => ({ value: null as string | null, throws: false }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: async () => { if (keyItem.throws) throw new Error('DecryptException: could not decrypt the value'); return keyItem.value; },
    setItemAsync: async () => {}, deleteItemAsync: async () => {},
}));
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
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: phone.stored, setIdentity() {} }) }));
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
const phone = vi.hoisted(() => ({
    stored: null as any,
    pending: null as any,
    enrolment: null as any,
    invite: { valid: true, inviterCallsign: 'Ana', communityName: 'Mullum' } as Record<string, unknown>,
    outgoing: null as any,
    redeemFails: null as string | null,
    /** Every wizard record the screen wrote, in order. */
    records: [] as any[],
}));
/** The knocks this phone's key sent, what each community says, and the knock's mark on the key (utils/knock-key.ts). */
const knocking = vi.hoisted(() => ({ asked: [] as any[], statuses: {} as Record<string, any>, mark: null as string | null, forgotten: [] as string[] }));
vi.mock('../knock', async (importOriginal) => {
    const real = await importOriginal<typeof import('../knock')>();
    return {
        ...real,
        rememberedKnocks: async () => knocking.asked,
        readKnockStatus: async (url: string) => knocking.statuses[url] ?? { ok: true, value: { status: 'pending' } },
        forgetKnock: async (_pk: string, url: string) => { knocking.forgotten.push(url); knocking.asked = knocking.asked.filter((k) => k.url !== url); },
    };
});
vi.mock('../knock-key', () => ({
    knockKeyIsNew: async (pk: string) => knocking.mark === pk,
    forgetKnockKey: async () => { knocking.mark = null; },
}));
const door = vi.hoisted(() => ({
    check: { ok: true, profile: { features: {} } } as any,
    answer: null as any,
    signIn: null as any,
    cachedFeatures: null as any,
    /** The saved profile of the community in use, whole (look-around.ts lookingAroundHere reads it). */
    cachedProfile: null as any,
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
        setPendingOnboarding: async (r: unknown) => { phone.records.push(r); }, updatePendingOnboarding: async () => {}, clearPendingOnboarding: async () => {},
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
    return { ...real, checkGlobalDoor: async () => door.check, getCachedNodeProfile: async () => door.cachedProfile ?? (door.cachedFeatures ? { features: door.cachedFeatures } : null) };
});
vi.mock('../global-door-offer', async (importOriginal) => {
    const real = await importOriginal<typeof import('../global-door-offer')>();
    return { ...real, askGlobalDoorOffer: async () => real.globalDoorOffer(), rememberGlobalDoor: () => {} };
});
const work = vi.hoisted(() => ({ started: [] as string[], keysDrafted: 0 }));
vi.mock('../global-join', async (importOriginal) => {
    const real = await importOriginal<typeof import('../global-join')>();
    const key = { identity: { ...ids.SALLY }, createdHere: true };
    return {
        ...real,
        joinKeyForThisPhone: async () => { work.keysDrafted++; return key; },
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
    useDoorWork: () => ({
        start: (_url: string, _identity: unknown, way: string) => { work.started.push(way); return { state: () => ({ phase: 'ready' }) }; },
        stop() {}, state: () => null, busy: null, runFor: () => null,
    }),
}));
// The look (utils/global-guest-visit.ts): what the visit answers, who it was asked for, and what the screen's `proceed`
// said when the answer came (the real visit asks it just before its first write; `gate` holds the answer back meanwhile).
const look = vi.hoisted(() => ({ answer: { kind: 'guest' } as { kind: string }, askedFor: [] as unknown[], proceeded: [] as boolean[], gate: null as Promise<void> | null }));
vi.mock('../global-guest-visit', () => ({
    visitGlobalAsGuest: async (identity: unknown, _url?: string, injected?: { proceed?: () => boolean }) => {
        look.askedFor.push(identity);
        if (look.gate) await look.gate;
        if (look.answer.kind !== 'guest' || !injected?.proceed) return look.answer;
        const go = injected.proceed();
        look.proceeded.push(go);
        return go ? look.answer : { kind: 'left' };
    },
}));
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => ({}) }));
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


import { setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import WelcomeScreen from '../../app/welcome';
import { noVault } from './fake-vault';

const RIVERSIDE = 'https://riverside.example.org';
const KNOCKER = { publicKey: 'e7'.repeat(32), privateKey: 'f8'.repeat(32), callsign: 'River Kid', createdAt: '2026-10-29', mnemonic: ids.WORDS };
const knockAt = (url: string, name: string | null) => ({ url, name, key: null, sentAt: '2026-10-29T00:00:00.000Z' });

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    store.map.clear();
    alerts.said.length = 0; alerts.buttons.length = 0; prompts.asked.length = 0;
    params.now = {};
    backs.handlers.clear();
    nav.replaced.length = 0; nav.pushed.length = 0;
    work.started.length = 0; work.keysDrafted = 0;
    clip.has = false; clip.text = '';
    phone.stored = { ...KNOCKER }; phone.pending = null; phone.records = []; phone.redeemFails = null; phone.outgoing = null;
    phone.invite = { valid: true, inviterCallsign: 'Ana', communityName: 'Riverside' };
    keyItem.value = null; keyItem.throws = false;
    knocking.asked = [knockAt(RIVERSIDE, 'Riverside')];
    knocking.statuses = {};
    knocking.mark = KNOCKER.publicKey;
    knocking.forgotten = [];
    door.check = { ok: true, profile: { profile: 'global', features: { openJoin: true, wordsDoor: true } } };
    door.answer = null; door.signIn = null; door.cachedFeatures = null; door.cachedProfile = null;
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

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(WelcomeScreen, { key: 'welcome' })) as any);
    });
    await settle();
}
const all = (sel: string) => Array.from(host!.querySelectorAll(sel)) as HTMLElement[];
const byId = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
function button(name: string): HTMLElement {
    const found = all('button, [role="button"]').find((b) => b.getAttribute('aria-label') === name || b.textContent === name);
    expect(found, `a button "${name}"`).toBeTruthy();
    return found!;
}
async function press(name: string) {
    const b = button(name);
    await act(async () => { b.click(); });
    await settle();
}
const type = async (label: string, text: string) => {
    const input = all('input').find((i) => i.getAttribute('aria-label') === label || i.getAttribute('placeholder') === label) as HTMLInputElement | undefined;
    expect(input, `a field "${label}"`).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
};

describe('1. the waiting mode', () => {
    it('an account in no community, no wizard: the lines and the ways on, in place of the doors', async () => {
        knocking.asked = [knockAt(RIVERSIDE, 'Riverside'), knockAt('https://dale.example.org', 'Dale')];
        knocking.statuses = { 'https://dale.example.org': { ok: true, value: { status: 'none' } } };
        await mount();
        expect(byId('welcome-waiting')).not.toBeNull();
        expect(host!.textContent).toContain('Waiting for Riverside: usually a few days.');
        expect(host!.textContent).toContain('This request is no longer open. You can ask again.');
        for (const b of ['Check again', 'Ask another community', '🎟️ Join with an invite', 'Already a Member? Restore Account']) button(b);
        // Not the first screen's doors.
        expect(all('button').some((b) => b.getAttribute('aria-label') === 'Explore BeanPool worldwide')).toBe(false);
        // Got it forgets a request its community no longer holds.
        await press('Got it');
        expect(knocking.forgotten).toEqual(['https://dale.example.org']);
        expect(host!.textContent).not.toContain('This request is no longer open.');
    });

    it('nothing asked (a wipe that kept the key): the account is here, in no community yet, and the same ways on', async () => {
        knocking.asked = [];
        await mount();
        expect(byId('welcome-waiting-none')?.textContent).toBe('Your account is on this phone. No community has let it in yet.');
        expect(byId('welcome-waiting-check')).toBeNull();
        button('Ask a community to let you in');
        button('🎟️ Join with an invite');
    });

    it('with a community in use, or a wizard part-way, it is not drawn', async () => {
        store.map.set('beanpool_anchor_url', RIVERSIDE);
        await mount();
        expect(byId('welcome-waiting')).toBeNull();
        act(() => root?.unmount()); host?.remove();
        store.map.clear();
        phone.pending = { step: 'create', inviteCode: 'INV-ABCD-EFGH', anchorUrl: RIVERSIDE, callsign: 'River Kid', redeemed: false };
        await mount();
        expect(byId('welcome-waiting')).toBeNull();
    });

    it('with no account at all, the first screen as before, with the quiet row to ask a community', async () => {
        phone.stored = null;
        await mount();
        expect(byId('welcome-waiting')).toBeNull();
        button('Explore BeanPool worldwide');
        await press('Know a community near you? Ask to join it');
        expect(nav.pushed).toEqual(['/find-community']);
    });
});

describe('2. a yes, joined with one tap', () => {
    it('the invite step runs with this key and lands on Your Photo; the words are new; the mark and the request go', async () => {
        knocking.statuses = { [RIVERSIDE]: { ok: true, value: { status: 'approved', invite: 'INV-ABCD-EFGH', expiresAt: null } } };
        await mount();
        expect(host!.textContent).toContain('Riverside said yes. Join now.');
        await press('Join Riverside');
        // Your Photo, the wizard's second step.
        expect(host!.textContent).toContain('Your Photo');
        expect(byId('welcome-waiting')).toBeNull();
        expect(store.map.get('beanpool_anchor_url')).toBe(RIVERSIDE);
        const last = phone.records.at(-1);
        expect(last).toMatchObject({ step: 'profileSetup', inviteCode: 'INV-ABCD-EFGH', anchorUrl: RIVERSIDE, callsign: 'River Kid', redeemed: true, newKey: KNOCKER.publicKey });
        expect(knocking.mark).toBeNull();
        expect(knocking.forgotten).toContain(RIVERSIDE);
    });

    it('a key the knock did not make (a wipe kept an account): its words stay an established account\'s', async () => {
        knocking.mark = null;
        knocking.statuses = { [RIVERSIDE]: { ok: true, value: { status: 'approved', invite: 'INV-ABCD-EFGH', expiresAt: null } } };
        await mount();
        await press('Join Riverside');
        const last = phone.records.at(-1);
        expect(last).toMatchObject({ step: 'profileSetup', anchorUrl: RIVERSIDE });
        expect(last.newKey).toBeUndefined();
    });
});

describe('3. a yes whose redeem is refused', () => {
    it('the invite step says so, and the phone is back with no community', async () => {
        knocking.statuses = { [RIVERSIDE]: { ok: true, value: { status: 'approved', invite: 'INV-ABCD-EFGH', expiresAt: null } } };
        phone.redeemFails = 'This invite has expired.';
        await mount();
        await press('Join Riverside');
        expect(host!.textContent).toContain('This invite has expired.');
        expect(store.map.has('beanpool_anchor_url')).toBe(false);
        expect(phone.records.some((r) => r.step === 'profileSetup')).toBe(false);
        expect(knocking.mark).toBe(KNOCKER.publicKey);
    });
});

describe('4. the other ways on', () => {
    it('Join with an invite opens the invite step; Ask another community opens Find a community', async () => {
        await mount();
        await press('Ask another community');
        expect(nav.pushed).toEqual(['/find-community']);
        await press('🎟️ Join with an invite');
        expect(byId('welcome-waiting')).toBeNull();
        expect(all('input').some((i) => i.getAttribute('aria-label') === 'Invite link or code' || i.getAttribute('placeholder') === 'Invite link or code')).toBe(true);
    });
});

describe('5. Restore over the waiting key', () => {
    it('Recover with 12 Words asks "Replace this phone\'s account?" first', async () => {
        phone.outgoing = KNOCKER;
        await mount();
        await press('Already a Member? Restore Account');
        await press('🔑 Recover with 12 Words');
        await type('Community name or address (e.g. mullum)', 'riverside.example.org');
        await press('Recover Identity');
        expect(host!.textContent).toContain("⚠️ Replace this phone's account?");
    });
});

describe('6. an invite link on a waiting phone, handed here by the root layout', () => {
    const field = (label: string) => all('input').find((i) => i.getAttribute('aria-label') === label) as HTMLInputElement | undefined;

    it('the invite step, filled; Next joins with this key and lands on Your Photo; the words are new; the mark and the request go', async () => {
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
        await mount();
        expect(byId('welcome-waiting')).toBeNull();
        expect(field('Invite link or code')?.value).toBe('INV-ABCD-EFGH');
        expect(field('Community name or node address')?.value).toBe(RIVERSIDE);
        // The account's name, as Join with an invite fills it.
        expect(field('Your name or nickname')?.value).toBe('River Kid');
        await press('Next');
        expect(host!.textContent).toContain('Your Photo');
        expect(store.map.get('beanpool_anchor_url')).toBe(RIVERSIDE);
        expect(phone.records.at(-1)).toMatchObject({ step: 'profileSetup', inviteCode: 'INV-ABCD-EFGH', anchorUrl: RIVERSIDE, callsign: 'River Kid', redeemed: true, newKey: KNOCKER.publicKey });
        expect(knocking.mark).toBeNull();
        expect(knocking.forgotten).toContain(RIVERSIDE);
    });

    it('a refused redeem: the invite step says so, and the phone is back with no community, its words still to be shown', async () => {
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
        phone.redeemFails = 'This invite has expired.';
        await mount();
        await press('Next');
        expect(host!.textContent).toContain('This invite has expired.');
        expect(store.map.has('beanpool_anchor_url')).toBe(false);
        expect(phone.records.some((r) => r.step === 'profileSetup')).toBe(false);
        expect(knocking.mark).toBe(KNOCKER.publicKey);
    });

    it('a name already typed is kept', async () => {
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
        await mount();
        await type('Your name or nickname', 'Riverside Kid');
        expect(field('Your name or nickname')?.value).toBe('Riverside Kid');
    });
});
