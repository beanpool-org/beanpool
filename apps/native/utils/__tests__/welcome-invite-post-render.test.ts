// @vitest-environment jsdom
/**
 * Invite and share, the phone's joins (utils/post-after-join.ts; app/welcome.tsx): an invite sent from a listing carries
 * `&post=<id>`, and the friend who joins with it lands on that listing. The real welcome screen, with the harness of
 * welcome-waiting-render.test.ts (React Native's host components as plain tags, the node, the vault, the sign-ins and the
 * phone's key store stubbed). Nothing is contacted.
 *
 * The listing is held at the join (the redeem has landed), for the root guard to open once the new member lands on Home
 * (the guard's own take is tested in post-after-join.test.ts). Three ways reach this screen with the listing, each driven here:
 *   1. the app opened by the link, which the root layout hands to welcome as router params (`post`);
 *   2. a link or paste the screen reads itself (the full address pasted into the invite box);
 *   3. a phone that installed from the store, the install referrer (`invite=…&server=…&post=…`).
 * And the cases that must change nothing: an invite with no listing, a listing that is no id, a refused redeem.
 * And 4: the name box beside the invite box refuses an invite or a link, and moves an invite into the invite box.
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
const referrer = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('expo-application', () => ({ getInstallReferrerAsync: async () => referrer.value }));
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
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardStickyView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
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
    /** Every redeem the screen sent: the code and the name. */
    redeems: [] as Array<{ code: string; callsign: string }>,
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
    redeemInvite: async (code: string, callsign: string) => { phone.redeems.push({ code, callsign }); if (phone.redeemFails) throw new Error(phone.redeemFails); return {}; },
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


import { NAME_BOX_WORDS, setLanguage } from '@beanpool/core';
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
    referrer.value = null;
    backs.handlers.clear();
    nav.replaced.length = 0; nav.pushed.length = 0;
    work.started.length = 0; work.keysDrafted = 0;
    clip.has = false; clip.text = '';
    phone.stored = { ...KNOCKER }; phone.pending = null; phone.records = []; phone.redeemFails = null; phone.outgoing = null; phone.redeems = [];
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


const POST = '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34';
const HELD_KEY = 'beanpool_post_after_join';
const field = (label: string) => all('input').find((i) => i.getAttribute('aria-label') === label) as HTMLInputElement | undefined;
const held = () => { const raw = store.map.get(HELD_KEY); return raw ? JSON.parse(raw) : null; };

describe('1. the app opened by the link: the root layout hands welcome the listing as a param', () => {
    it('Next joins, lands on Your Photo, and the listing is held for the landing, for this community', async () => {
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, post: POST, t: '1' };
        await mount();
        expect(field('Invite link or code')?.value).toBe('INV-ABCD-EFGH');
        await press('Next');
        expect(host!.textContent).toContain('Your Photo');
        expect(held()).toMatchObject({ community: RIVERSIDE, id: POST });
        expect(typeof held().at).toBe('number');
        // Held as an id and a community, nothing else.
        expect(Object.keys(held()).sort()).toEqual(['at', 'community', 'id']);
    });

    it('an invite with no listing holds nothing: the join is as it was', async () => {
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
        await mount();
        await press('Next');
        expect(host!.textContent).toContain('Your Photo');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });

    it('a listing that is no id holds nothing, and the join still goes through', async () => {
        for (const bad of ['../../etc/passwd', 'a b', 'https://evil.example/x', '<b>']) {
            store.map.clear();
            params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, post: bad, t: String(Math.random()) };
            await mount();
            await press('Next');
            expect(host!.textContent, bad).toContain('Your Photo');
            expect(store.map.has(HELD_KEY), bad).toBe(false);
            act(() => root?.unmount()); host?.remove(); root = null; host = null;
        }
    });

    it('a refused redeem holds nothing: no join, no landing', async () => {
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, post: POST, t: '1' };
        phone.redeemFails = 'This invite has expired.';
        await mount();
        await press('Next');
        expect(host!.textContent).toContain('This invite has expired.');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });

    it('the listing belongs to its invite: a different code typed over it carries no listing', async () => {
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, post: POST, t: '1' };
        await mount();
        await type('Invite link or code', 'INV-ZZZZ-YYYY');
        await press('Next');
        expect(host!.textContent).toContain('Your Photo');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });
});

describe('2. the whole address pasted into the invite box', () => {
    it('carries its listing too', async () => {
        await mount();
        await press('🎟️ Join with an invite');
        await type('Invite link or code', `${RIVERSIDE}/?invite=INV-ABCD-EFGH&post=${POST}`);
        await press('Next');
        expect(host!.textContent).toContain('Your Photo');
        expect(held()).toMatchObject({ community: RIVERSIDE, id: POST });
    });

    it('a pasted address with no listing holds nothing', async () => {
        await mount();
        await press('🎟️ Join with an invite');
        await type('Invite link or code', `${RIVERSIDE}/?invite=INV-ABCD-EFGH`);
        await press('Next');
        expect(host!.textContent).toContain('Your Photo');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });
});

describe('3. a phone that installed from the store: the install referrer', () => {
    it('invite, server and listing arrive together; Next joins and the listing is held', async () => {
        referrer.value = `invite=INV-ABCD-EFGH&server=${encodeURIComponent(RIVERSIDE)}&post=${POST}`;
        await mount();
        expect(field('Invite link or code')?.value).toBe('INV-ABCD-EFGH');
        await press('Next');
        expect(host!.textContent).toContain('Your Photo');
        expect(held()).toMatchObject({ community: RIVERSIDE, id: POST });
    });

    it('a referrer with no listing holds nothing', async () => {
        referrer.value = `invite=INV-ABCD-EFGH&server=${encodeURIComponent(RIVERSIDE)}`;
        await mount();
        await press('Next');
        expect(host!.textContent).toContain('Your Photo');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });

    it('a referrer whose listing is no id: the invite is still used, with no listing', async () => {
        referrer.value = `invite=INV-ABCD-EFGH&server=${encodeURIComponent(RIVERSIDE)}&post=${encodeURIComponent('../x')}`;
        await mount();
        expect(field('Invite link or code')?.value).toBe('INV-ABCD-EFGH');
        await press('Next');
        expect(host!.textContent).toContain('Your Photo');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });
});

// The name box beside the invite box (Marty, 14 Nov 2026, card callsign-link-guard: a member's invite link pasted into the
// name box became her name on her community). The same real screen and harness as above.
describe('4. the name box takes a name, never an invite or a link', () => {
    it('an invite link pasted into the name box goes to the invite box, the name box is left empty, and one line says why', async () => {
        await mount();
        await press('🎟️ Join with an invite');
        await type('Your name or nickname', `${RIVERSIDE}/?invite=INV-ABCD-EFGH`);
        expect(field('Invite link or code')?.value).toBe('INV-ABCD-EFGH');
        expect(field('Your name or nickname')?.value).toBe('');
        expect(host!.textContent).toContain(NAME_BOX_WORDS.inviteLink);
        expect(phone.redeems).toEqual([]);
        // A name, and Next joins with the invite under it.
        await type('Your name or nickname', 'Rowan');
        await press('Next');
        expect(phone.redeems).toEqual([{ code: 'INV-ABCD-EFGH', callsign: 'Rowan' }]);
    });

    it('a web address as the name is refused on Next with its line, and nothing joins', async () => {
        await mount();
        await press('🎟️ Join with an invite');
        await type('Invite link or code', `${RIVERSIDE}/?invite=INV-ABCD-EFGH`);
        await type('Your name or nickname', 'www.rowan.com');
        await press('Next');
        expect(host!.textContent).toContain(NAME_BOX_WORDS.webLink);
        expect(phone.redeems).toEqual([]);
        expect(field('Your name or nickname')?.value).toBe('www.rowan.com');
    });
});
