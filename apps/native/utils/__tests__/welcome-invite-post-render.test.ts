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
 * And 5: how an invite is found on a new phone (DESIGN-onboarding-home-landing-fable.md §3.1 B, DESIGN-ios-invite-paste-fable.md
 * §4.1), one row per arrival: which screen, which button, which words; no read of the clipboard before a tap; and what a tap
 * brings back that isn't an invite is never shown or sent.
 * And 6: the same screens laid out on an old small phone (320 × 569 dp, the text at 1.3×, three-button navigation; walk 148),
 * light and dark: clear of both system bars, the name box in view, the address asked only where the invite names none, and a
 * refused code said before Join, with everything Join's refusal does.
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
/** The phone: Android, an iPhone with Apple's paste button (iOS 16+), or one without it (iOS 15). */
const plat = vi.hoisted(() => ({ OS: 'android', paste: false, select: (o: Record<string, unknown>) => o.android ?? o.default }));
const prompts = vi.hoisted(() => ({ asked: [] as string[] }));
/** The phone's back button: its handlers, as React Native keeps them (the latest first). */
const backs = vi.hoisted(() => ({ handlers: new Set<() => boolean>() }));

/** §6: the parts' onLayout by testID, the step's scroll view (its onLayout and where it was last scrolled), and the system bars. */
const laid = vi.hoisted(() => new Map<string, (e: unknown) => void>());
const scrolled = vi.hoisted(() => ({ to: [] as number[], assured: 0 }));
const keyboard = vi.hoisted(() => ({ hidden: new Set<() => void>(), up: false }));
const bars = vi.hoisted(() => ({ top: 24, bottom: 0 }));
const look148 = vi.hoisted(() => ({ dark: false }));
/** A scroll view as React Native lays one out: its frame, and its content inside it. */
function scrollBox({ children, contentContainerStyle, onLayout }: Record<string, any>) {
    if (onLayout) laid.set('scroll', onLayout);
    return createElement('div', { 'data-testid': 'scroll', 'data-style': JSON.stringify({ flexGrow: 1, flexShrink: 1, overflow: 'scroll' }) },
        createElement('div', { 'data-testid': 'scroll-content', 'data-style': JSON.stringify(Object.assign({}, ...[contentContainerStyle].flat(3).filter(Boolean))) }, children));
}

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
        // For §6's layout (yoga-dom-layout.ts): the style, a box's room for its line of text, and each measured part's onLayout.
        attrs['data-style'] = JSON.stringify(tag === 'input' ? { ...s, minHeight: 2 * (s.padding ?? 0) + (s.fontSize ?? 14) * 1.3 * 1.25 } : s);
        if (testID && props.onLayout) laid.set(testID, props.onLayout);
        return createElement(tag, attrs, children);
    };
    const scroll = (props: Record<string, any>) => scrollBox({ ...props, contentContainerStyle: flat(props.contentContainerStyle) });
    const listener = () => ({ remove() {} });
    return {
        Platform: plat,
        Image: el('img'),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: scroll, TextInput: el('input'), FlatList: el('div'),
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
        Keyboard: { addListener: (event: string, fn: () => void) => { if (event === 'keyboardDidHide') keyboard.hidden.add(fn); return { remove() { keyboard.hidden.delete(fn); } }; }, dismiss() {}, isVisible: () => keyboard.up },
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
/** `reads`: our own reads of the clipboard (getStringAsync); `asks`: the presence checks, which read nothing. */
const clip = vi.hoisted(() => ({ has: false, text: '', reads: 0, asks: 0, apple: [] as Array<Record<string, any>> }));
vi.mock('expo-clipboard', async () => {
    const { createElement: h } = await import('react');
    return {
        hasStringAsync: async () => { clip.asks++; return clip.has; },
        getStringAsync: async () => { clip.reads++; return clip.text; },
        setStringAsync: async () => true,
        get isPasteButtonAvailable() { return plat.paste; },
        // Apple's button: the system reads what was copied and hands it over at its tap; our code never calls a read for it.
        ClipboardPasteButton: (props: Record<string, any>) => {
            clip.apple.push(props);
            return h('button', { 'data-testid': 'apple-paste', onClick: () => props.onPress({ type: 'text', text: clip.text }) });
        },
    };
});
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
    useSafeAreaInsets: () => ({ top: bars.top, bottom: bars.bottom, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', async () => {
    const { forwardRef, useImperativeHandle } = await import('react');
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    const aware = forwardRef((props: Record<string, any>, ref) => {
        useImperativeHandle(ref, () => ({ scrollTo: (o: { y: number }) => { scrolled.to.push(o.y); }, scrollToEnd() {}, assureFocusedInputVisible() { scrolled.assured++; } }));
        return scrollBox(props);
    });
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: aware, KeyboardStickyView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
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
    const { lightColors, COLOUR_SETS } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { theme: 'light', colors: lightColors, themePreference: 'light', setThemePreference() {}, patternEnabled: false, setPatternEnabled() {} };
    const night = { ...ctx, theme: 'dark', colors: COLOUR_SETS.night, themePreference: 'night' };
    const now = () => (look148.dark ? night : ctx);
    return { useTheme: now, useStyles: (make: (t: unknown) => unknown) => make(now()), useOnboardingColors: () => onboardingColors(look148.dark ? 'night' : 'light') };
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
    /** The node's invite check by code, where a test needs one (else every code gets `invite`). */
    checkFor: null as null | ((code: string) => Promise<unknown>),
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
    checkInvite: async (code: string) => (phone.checkFor ? phone.checkFor(code) : phone.invite),
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
import { palette } from '../../constants/colors';
import { MEMBER_TICKET_REFUSED_TEXT } from '../invite-entries';
import { onboardingColors } from '../onboarding-colors';
import { noVault } from './fake-vault';
import { layOut } from './yoga-dom-layout';

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
    clip.has = false; clip.text = ''; clip.reads = 0; clip.asks = 0; clip.apple.length = 0;
    plat.OS = 'android'; plat.paste = false;
    phone.stored = { ...KNOCKER }; phone.pending = null; phone.records = []; phone.redeemFails = null; phone.outgoing = null; phone.redeems = [];
    phone.invite = { valid: true, inviterCallsign: 'Ana', communityName: 'Riverside' };
    phone.checkFor = null;
    keyItem.value = null; keyItem.throws = false;
    laid.clear(); scrolled.to.length = 0; scrolled.assured = 0; keyboard.up = false; bars.top = 24; bars.bottom = 0; look148.dark = false;
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
/** A found invite skips the box (onboarding §3.1 B): the name screen with its greeting band, and no invite box on it. */
const onNameScreen = () => !!byId('invite-greeting') && !field('Invite link or code');

describe('1. the app opened by the link: the root layout hands welcome the listing as a param', () => {
    it('Join joins, lands on Your photo, and the listing is held for the landing, for this community', async () => {
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, post: POST, t: '1' };
        await mount();
        expect(onNameScreen()).toBe(true);
        await press('Join');
        expect(host!.textContent).toContain('Choose your look');
        expect(held()).toMatchObject({ community: RIVERSIDE, id: POST });
        expect(typeof held().at).toBe('number');
        // Held as an id and a community, nothing else.
        expect(Object.keys(held()).sort()).toEqual(['at', 'community', 'id']);
    });

    it('an invite with no listing holds nothing: the join is as it was', async () => {
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
        await mount();
        await press('Join');
        expect(host!.textContent).toContain('Choose your look');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });

    it('a listing that is no id holds nothing, and the join still goes through', async () => {
        for (const bad of ['../../etc/passwd', 'a b', 'https://evil.example/x', '<b>']) {
            store.map.clear();
            params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, post: bad, t: String(Math.random()) };
            await mount();
            await press('Join');
            expect(host!.textContent, bad).toContain('Choose your look');
            expect(store.map.has(HELD_KEY), bad).toBe(false);
            act(() => root?.unmount()); host?.remove(); root = null; host = null;
        }
    });

    it('a refused redeem holds nothing: no join, no landing', async () => {
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, post: POST, t: '1' };
        phone.redeemFails = 'This invite has expired.';
        await mount();
        await press('Join');
        expect(host!.textContent).toContain('This invite has expired.');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });

    it('the listing belongs to its invite: a different code typed over it carries no listing', async () => {
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, post: POST, t: '1' };
        await mount();
        // The pencil on the greeting: Your invite, with the invite in its box to change.
        await press('Change the invite');
        expect(field('Invite link or code')?.value).toBe('INV-ABCD-EFGH');
        await type('Invite link or code', 'INV-ZZZZ-YYYY');
        await press('Next');
        expect(onNameScreen()).toBe(true);
        await press('Join');
        expect(host!.textContent).toContain('Choose your look');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });

    // Review of #3317: the greeting was matched to the invite by address only, but an inviter belongs to one code.
    it('the greeting belongs to its code: Bob\'s code for the same community never shows Asha\'s name while its own check is unanswered', async () => {
        const band = () => byId('invite-greeting')?.textContent ?? '';
        const checkAnswers = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 700)); }); await settle(); };
        // Asha's code is checked; Bob's check never answers (offline, or the node too slow).
        phone.checkFor = (code) => (code === 'INV-ASHA-AAAA'
            ? Promise.resolve({ valid: true, inviterCallsign: 'Asha', communityName: 'Riverside' })
            : new Promise(() => {}));
        params.now = { invite: 'INV-ASHA-AAAA', server: RIVERSIDE, t: '1' };
        await mount();
        await checkAnswers();
        expect(band()).toContain('Asha invited you to Riverside');
        await press('Change the invite');
        await type('Invite link or code', 'INV-BOBB-BBBB');
        await press('Next');
        expect(onNameScreen()).toBe(true);
        expect(band()).toContain("You're invited");
        expect(band()).not.toContain('Asha');
        await checkAnswers();
        expect(band()).not.toContain('Asha');
        // Asha's code back: her check still stands for it.
        await press('Change the invite');
        await type('Invite link or code', 'INV-ASHA-AAAA');
        await press('Next');
        expect(band()).toContain('Asha invited you to Riverside');
    });
});

describe('2. the whole address pasted into the invite box', () => {
    it('carries its listing too', async () => {
        await mount();
        await press('🎟️ Join with an invite');
        await type('Invite link or code', `${RIVERSIDE}/?invite=INV-ABCD-EFGH&post=${POST}`);
        await press('Next');
        expect(onNameScreen()).toBe(true);
        await press('Join');
        expect(host!.textContent).toContain('Choose your look');
        expect(held()).toMatchObject({ community: RIVERSIDE, id: POST });
    });

    it('a pasted address with no listing holds nothing', async () => {
        await mount();
        await press('🎟️ Join with an invite');
        await type('Invite link or code', `${RIVERSIDE}/?invite=INV-ABCD-EFGH`);
        await press('Next');
        await press('Join');
        expect(host!.textContent).toContain('Choose your look');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });
});

describe('3. a phone that installed from the store: the install referrer', () => {
    it('invite, server and listing arrive together; Join joins and the listing is held', async () => {
        referrer.value = `invite=INV-ABCD-EFGH&server=${encodeURIComponent(RIVERSIDE)}&post=${POST}`;
        await mount();
        expect(onNameScreen()).toBe(true);
        await press('Join');
        expect(host!.textContent).toContain('Choose your look');
        expect(held()).toMatchObject({ community: RIVERSIDE, id: POST });
    });

    it('a referrer with no listing holds nothing', async () => {
        referrer.value = `invite=INV-ABCD-EFGH&server=${encodeURIComponent(RIVERSIDE)}`;
        await mount();
        await press('Join');
        expect(host!.textContent).toContain('Choose your look');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });

    it('a referrer whose listing is no id: the invite is still used, with no listing', async () => {
        referrer.value = `invite=INV-ABCD-EFGH&server=${encodeURIComponent(RIVERSIDE)}&post=${encodeURIComponent('../x')}`;
        await mount();
        expect(onNameScreen()).toBe(true);
        await press('Join');
        expect(host!.textContent).toContain('Choose your look');
        expect(store.map.has(HELD_KEY)).toBe(false);
    });
});

// The name box beside the invite box (Marty, 14 Nov 2026, card callsign-link-guard: a member's invite link pasted into the
// name box became her name on her community). The same real screen and harness as above.
describe('4. the name box takes a name, never an invite or a link', () => {
    it('an invite link pasted into the name box becomes the invite, the name box is left empty, and one line says why', async () => {
        await mount();
        await press('🎟️ Join with an invite');
        await type('Invite link or code', `${RIVERSIDE}/?invite=INV-AAAA-BBBB`);
        await press('Next');
        await type('Your name or nickname', `${RIVERSIDE}/?invite=INV-ABCD-EFGH`);
        expect(field('Your name or nickname')?.value).toBe('');
        // The name screen has no invite box, so its line is its own: core's "it goes in the invite box" is the web's (review
        // of #3317). The invite is used: no box asks for it again.
        expect(host!.textContent).toContain("That's an invite, not a name: it's your invite now.");
        expect(host!.textContent).not.toContain(NAME_BOX_WORDS.inviteLink);
        expect(host!.textContent).not.toContain(NAME_BOX_WORDS.inviteCode);
        expect(field('Invite link or code')).toBeUndefined();
        expect(phone.redeems).toEqual([]);
        // A name, and Join joins with the invite under it.
        await type('Your name or nickname', 'Rowan');
        await press('Join');
        expect(phone.redeems).toEqual([{ code: 'INV-ABCD-EFGH', callsign: 'Rowan' }]);
    });

    it('a web address as the name is refused on Join with its line, and nothing joins', async () => {
        await mount();
        await press('🎟️ Join with an invite');
        await type('Invite link or code', `${RIVERSIDE}/?invite=INV-ABCD-EFGH`);
        await press('Next');
        await type('Your name or nickname', 'www.rowan.com');
        await press('Join');
        expect(host!.textContent).toContain(NAME_BOX_WORDS.webLink);
        expect(phone.redeems).toEqual([]);
        expect(field('Your name or nickname')?.value).toBe('www.rowan.com');
    });
});

describe('5. how an invite is found on a new phone: one row per arrival', () => {
    const LINK = `${RIVERSIDE}/?invite=INV-ABCD-EFGH`;
    const NOT_AN_INVITE = 'milk, eggs, bread';
    const text = () => host!.textContent ?? '';
    const inputs = () => all('input') as HTMLInputElement[];
    /** Nothing a tap brought back that isn't an invite is on screen, in a box, or sent anywhere. */
    const neverShownOrSent = () => {
        expect(text()).not.toContain(NOT_AN_INVITE);
        expect(inputs().some((i) => i.value.includes('milk'))).toBe(false);
        expect(phone.redeems).toEqual([]);
        expect(JSON.stringify(phone.records)).not.toContain('milk');
    };
    const newPhone = (os: 'android' | 'ios', paste: boolean) => {
        phone.stored = null;
        knocking.mark = null;
        knocking.asked = [];
        plat.OS = os; plat.paste = paste;
    };
    const greeted = () => !!byId('invite-greeting') && !field('Invite link or code');

    it('Android, an invite copied: the front door, our "I have an invite" reads at the tap, the name screen greeted', async () => {
        newPhone('android', false);
        clip.has = true; clip.text = LINK;
        await mount();
        expect(byId('front-door')).toBeTruthy();
        for (const words of ['Trade skills, goods and favours with your neighbours.', 'I have an invite', 'No invite? Look around', "I've used BeanPool before", 'More ways in ›']) expect(text()).toContain(words);
        expect(byId('apple-paste')).toBeNull();
        expect(clip.reads).toBe(0);
        // Android never asks whether something is copied either: its button reads at its tap.
        expect(clip.asks).toBe(0);
        await press('I have an invite');
        expect(clip.reads).toBe(1);
        expect(greeted()).toBe(true);
    });

    it('Android, something else copied: Your invite, the copied text dropped (never shown or sent), no line', async () => {
        newPhone('android', false);
        clip.has = true; clip.text = NOT_AN_INVITE;
        await mount();
        await press('I have an invite');
        expect(clip.reads).toBe(1);
        expect(byId('your-invite')).toBeTruthy();
        expect(text()).toContain('Your invite');
        expect(text()).toContain('Have the link? Tap it again.');
        expect(byId('your-invite-note')).toBeNull();
        neverShownOrSent();
    });

    it('iOS 16+, an invite copied: the tile with Apple\'s icon-only button; its tap opens the name screen, our code reads nothing', async () => {
        newPhone('ios', true);
        clip.has = true; clip.text = LINK;
        await mount();
        expect(byId('front-door-invite-tile')).toBeTruthy();
        expect(byId('front-door-invite')).toBeNull();
        for (const words of ['I have an invite', 'Tap to open it', 'Scan or type it instead ›']) expect(text()).toContain(words);
        // Apple's button as the design asks: icon only, our call to action's colours, large corners, full width, 52 dp.
        const apple = clip.apple.at(-1)!;
        expect(apple.displayMode).toBe('iconOnly');
        expect(apple.cornerStyle).toBe('large');
        expect(apple.backgroundColor).toBe('#b85236');
        expect(apple.foregroundColor).toBe('#ffffff');
        expect(apple.style).toMatchObject({ width: '100%', height: 52 });
        expect(clip.reads).toBe(0);
        await act(async () => { byId('apple-paste')!.click(); });
        await settle();
        expect(greeted()).toBe(true);
        expect(clip.reads).toBe(0);
    });

    it('iOS 16+, something else copied: Apple\'s tap brings it, it is dropped: Your invite says so, and nothing is shown or sent', async () => {
        newPhone('ios', true);
        clip.has = true; clip.text = NOT_AN_INVITE;
        await mount();
        await act(async () => { byId('apple-paste')!.click(); });
        await settle();
        expect(byId('your-invite')).toBeTruthy();
        expect(byId('your-invite-note')?.textContent).toBe("That isn't an invite. Type or scan it.");
        expect(clip.reads).toBe(0);
        neverShownOrSent();
    });

    it('iOS 16+, nothing copied: our "I have an invite" opens Your invite without reading anything', async () => {
        newPhone('ios', true);
        clip.has = false;
        await mount();
        expect(byId('front-door-invite-tile')).toBeNull();
        expect(byId('apple-paste')).toBeNull();
        await press('I have an invite');
        expect(clip.reads).toBe(0);
        expect(byId('your-invite')).toBeTruthy();
        expect(byId('apple-paste')).toBeNull();
        expect(text()).toContain('Have the link? Tap it again.');
    });

    it('iOS 16+, text copied, "Scan or type it instead ›": Your invite, with Apple\'s small icon button at the box\'s end', async () => {
        newPhone('ios', true);
        clip.has = true; clip.text = LINK;
        await mount();
        await press('Scan or type it instead ›');
        expect(byId('your-invite')).toBeTruthy();
        expect(byId('apple-paste')).toBeTruthy();
        expect(clip.apple.at(-1)!.displayMode).toBe('iconOnly');
        expect(clip.reads).toBe(0);
        await act(async () => { byId('apple-paste')!.click(); });
        await settle();
        expect(greeted()).toBe(true);
    });

    it('iOS 15 (no Apple button): our "I have an invite" reads at the tap, as on Android; nothing is asked before it', async () => {
        newPhone('ios', false);
        clip.has = true; clip.text = LINK;
        await mount();
        expect(byId('front-door-invite')).toBeTruthy();
        expect(byId('apple-paste')).toBeNull();
        expect(clip.asks).toBe(0);
        expect(clip.reads).toBe(0);
        await press('I have an invite');
        expect(clip.reads).toBe(1);
        expect(greeted()).toBe(true);
    });

    it('an invite link: the name screen at once, no front door, no box, the clipboard untouched', async () => {
        newPhone('ios', true);
        clip.has = true; clip.text = NOT_AN_INVITE;
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
        await mount();
        expect(byId('front-door')).toBeNull();
        expect(greeted()).toBe(true);
        expect(clip.reads).toBe(0);
        neverShownOrSent();
    });

    it('an invite held on the phone: the name screen at once, the clipboard untouched', async () => {
        newPhone('android', false);
        store.map.set('beanpool_held_invite', JSON.stringify({ invite: 'INV-ABCD-EFGH', server: RIVERSIDE, at: Date.now() }));
        await mount();
        expect(byId('front-door')).toBeNull();
        expect(greeted()).toBe(true);
        expect(clip.reads).toBe(0);
    });

    it('Android\'s install referrer: the name screen at once, the clipboard untouched', async () => {
        newPhone('android', false);
        referrer.value = `invite=INV-ABCD-EFGH&server=${encodeURIComponent(RIVERSIDE)}`;
        await mount();
        expect(byId('front-door')).toBeNull();
        expect(greeted()).toBe(true);
        expect(clip.reads).toBe(0);
    });

    // Review of #3317 at c41a6d34: an invite found earlier stayed in hand after ← Back to Home, so "Scan or type it instead ›"
    // (FrontDoor.tsx: "the Your invite screen") drew the name screen again. It is set aside in Your invite's box, as the pencil
    // does: never dropped, Next uses it, and the copy held on the phone stays until it is redeemed.
    const HELD_INVITE = 'beanpool_held_invite';
    const arrivals = [
        ['an invite link', () => { params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' }; }],
        ['an invite held on the phone', () => { store.map.set(HELD_INVITE, JSON.stringify({ invite: 'INV-ABCD-EFGH', server: RIVERSIDE, at: Date.now() })); }],
    ] as const;
    it.each(arrivals)('iOS 16+, %s, ← Back to Home, then "Scan or type it instead ›": Your invite, the invite set aside in its box; Next uses it', async (_arrival, arrive) => {
        newPhone('ios', true);
        clip.has = true; clip.text = NOT_AN_INVITE;
        arrive();
        const heldBefore = store.map.get(HELD_INVITE) ?? null;
        await mount();
        expect(greeted()).toBe(true);
        await press('Back to Home');
        expect(byId('front-door-invite-tile')).toBeTruthy();
        await press('Scan or type it instead ›');
        expect(byId('your-invite')).toBeTruthy();
        expect(onNameScreen()).toBe(false);
        expect(field('Invite link or code')?.value).toBe('INV-ABCD-EFGH');
        expect(byId('your-invite-note')).toBeNull();
        // Not lost: the phone's held copy is as it was, and nothing was redeemed or read on the way.
        expect(store.map.get(HELD_INVITE) ?? null).toBe(heldBefore);
        expect(phone.redeems).toEqual([]);
        expect(clip.reads).toBe(0);
        await press('Next');
        expect(greeted()).toBe(true);
    });

    it('iOS 16+, an invite link, ← Back to Home, then Apple\'s tap brings something that isn\'t one: Your invite, its line seen, the invite kept in the box', async () => {
        newPhone('ios', true);
        clip.has = true; clip.text = NOT_AN_INVITE;
        params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
        await mount();
        expect(greeted()).toBe(true);
        await press('Back to Home');
        await act(async () => { byId('apple-paste')!.click(); });
        await settle();
        expect(byId('your-invite')).toBeTruthy();
        expect(byId('your-invite-note')?.textContent).toBe("That isn't an invite. Type or scan it.");
        expect(field('Invite link or code')?.value).toBe('INV-ABCD-EFGH');
        expect(clip.reads).toBe(0);
        neverShownOrSent();
    });
});

describe('6. "I\'ve used BeanPool before": every way back opens from the front door (review of #3317)', () => {
    const text = () => host!.textContent ?? '';
    /** A row of Restore your account, by the words it starts with (the third and fifth carry their hint under the label). */
    const row = (label: string) => {
        const found = all('button, [role="button"]').find((b) => (b.textContent ?? '').startsWith(label));
        expect(found, `a row "${label}"`).toBeTruthy();
        return found!;
    };
    const tapRow = async (label: string) => { const r = row(label); await act(async () => { r.click(); }); await settle(); };
    const onWaysBack = () => text().includes('🔑 Restore your account') && !byId('front-door');
    async function toWaysBack(): Promise<void> {
        phone.stored = null;
        knocking.mark = null;
        knocking.asked = [];
        await mount();
        expect(byId('front-door')).toBeTruthy();
        await press("I've used BeanPool before");
        expect(onWaysBack()).toBe(true);
    }

    it('opens Restore your account: the five rows, Start a new account instead, Back; nothing is made or sent', async () => {
        await toWaysBack();
        for (const label of ['🌐 Recover with Social', '🔑 Recover with 12 Words', '🤝 My community can bring me back', '🪪 An admin gave me a re-key code', '💻 Scan from a browser']) row(label);
        button('Start a new account instead');
        button('Back to Home');
        expect(work.keysDrafted).toBe(0);
        expect(phone.records).toEqual([]);
        expect(phone.redeems).toEqual([]);
        expect(nav.pushed).toEqual([]);
    });

    it('Social: the sign-in restore, and its Back returns to the ways back', async () => {
        await toWaysBack();
        await press('Recover with Social Sign-In');
        expect(text()).toContain('🌐 Recover with Social Sign-In');
        expect(text()).not.toContain('🔑 Restore your account');
        await press('Back to Restore Options');
        expect(onWaysBack()).toBe(true);
    });

    it('12 Words: the words screen, and its Back returns to the ways back', async () => {
        await toWaysBack();
        await tapRow('🔑 Recover with 12 Words');
        expect(text()).toContain('🔑 Recover Identity');
        expect(text()).not.toContain('🔑 Restore your account');
        await press('Back to Restore Options');
        expect(onWaysBack()).toBe(true);
    });

    it.each([
        ['🤝 My community can bring me back', { pathname: '/rekey-code', params: { bringBack: '1' } }],
        ['🪪 An admin gave me a re-key code', '/rekey-code'],
        ['💻 Scan from a browser', '/pair-in'],
    ] as const)('%s opens its own screen, and only that one', async (label, to) => {
        await toWaysBack();
        await tapRow(label);
        expect(nav.pushed).toEqual([to]);
        expect(work.keysDrafted).toBe(0);
    });

    it('Back to Home and Start a new account instead both return to the front door', async () => {
        await toWaysBack();
        await press('Back to Home');
        expect(byId('front-door')).toBeTruthy();
        await press("I've used BeanPool before");
        expect(onWaysBack()).toBe(true);
        await press('Start a new account instead');
        expect(byId('front-door')).toBeTruthy();
        expect(work.keysDrafted).toBe(0);
    });
});

// Walk 148 (the 1.4.8 phone build on API 26, 320 × 569 dp at 1.3×, three-button navigation): words scrolled up under the
// status bar, "More ways in ›" sat half under the navigation bar at the end of the scroll, the name box sat under the Join
// footer, and the address box and "Required — the community node…" showed although the link had named the community.
describe('6. an old small phone: 320 × 569 dp, the text at 1.3×, the navigation bar drawn over the screen', () => {
    const SCREEN = { width: 320, height: 569 };
    const STATUS = 24;
    const NAV = 48;
    const ADDRESS = 'Community name or node address';
    const REQUIRED = "Required — the community node you're joining.";
    const text = () => host!.textContent ?? '';
    const checkAnswers = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 700)); }); await settle(); };
    const smallPhone = (dark: boolean) => {
        phone.stored = null; knocking.mark = null; knocking.asked = [];
        bars.top = STATUS; bars.bottom = NAV; look148.dark = dark;
    };
    const leave = () => { act(() => root?.unmount()); host?.remove(); root = null; host = null; };
    /** The screen laid out, and where a part is on it, scrolled to its top. */
    function lay() {
        const screen = host!.firstElementChild!;
        const layout = layOut(screen, SCREEN, { fontScale: 1.3 });
        const at = (el: Element) => {
            let top = 0;
            for (let e: Element | null = el; e; e = e === screen ? null : e.parentElement) top += layout.box(e).top;
            return { top, bottom: top + layout.box(el).height };
        };
        return { at, box: layout.box };
    }
    const part = (id: string) => { const el = byId(id); expect(el, id).toBeTruthy(); return el!; };
    /** The phone measures the name step's parts, as the layout has them, and each tells the step. */
    async function measureNameStep(opened = true) {
        const { box } = lay();
        const tell = async (id: string, el: Element) => { await act(async () => { laid.get(id)!({ nativeEvent: { layout: { y: box(el).top, height: box(el).height } } }); }); };
        if (opened) await tell('scroll', part('scroll'));
        await tell('name-step-card', part('name-step-card'));
        await tell('name-step-name', part('name-step-name'));
    }
    /** How far the step is scrolled: never past its end. */
    function scrolledTo(): number {
        const { box } = lay();
        return Math.min(scrolled.to.at(-1) ?? 0, Math.max(0, box(part('scroll-content')).height - box(part('scroll')).height));
    }
    const nameBoxSeen = () => {
        const { at } = lay();
        const y = scrolledTo();
        const name = at(all('input').find((i) => i.getAttribute('aria-label') === 'Your name or nickname')!);
        return { top: name.top - y, bottom: name.bottom - y, view: at(part('scroll')) };
    };

    describe.each([false, true])('dark: %s', (dark) => {
        it('the name step, its community named by the link: no address box, no "Required", the name box above the Join footer with nothing scrolled', async () => {
            smallPhone(dark);
            params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
            phone.invite = { valid: true, inviterCallsign: 'Sam', communityName: 'Riverside Walk' };
            await mount();
            await checkAnswers();
            expect(byId('invite-greeting')?.textContent).toContain('Sam invited you to Riverside Walk');
            expect(field(ADDRESS)).toBeUndefined();
            expect(text()).not.toContain(REQUIRED);
            await measureNameStep();
            expect(scrolled.to).toEqual([]);
            const seen = nameBoxSeen();
            expect(seen.bottom).toBeLessThanOrEqual(lay().at(part('step-footer-invite')).top);
            expect(seen.view.top, 'the step scrolls below the status bar').toBe(STATUS);
            expect(lay().at(part('step-dots')).top).toBeGreaterThanOrEqual(STATUS);
        });

        it.each([
            ['a bare code (the address asked for)', { invite: 'INV-ABCD-EFGH', t: '1' }, 'Riverside'],
            ['a long community name', { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '2' }, 'The Riverside and Upper Valley Neighbours and Growers Community'],
        ] as Array<[string, Record<string, string>, string]>)('%s: the step scrolls just far enough for the name box, and again once the keyboard has gone', async (_what, invite, community) => {
            smallPhone(dark);
            params.now = invite;
            phone.invite = { valid: true, inviterCallsign: 'Wilhelmina', communityName: community };
            await mount();
            await checkAnswers();
            if (!invite.server) { expect(field(ADDRESS)).toBeTruthy(); expect(text()).toContain(REQUIRED); }
            await measureNameStep();
            const before = scrolled.to.length;
            expect(before).toBeGreaterThan(0);
            const seen = nameBoxSeen();
            expect(seen.bottom).toBeLessThanOrEqual(seen.view.bottom);
            expect(seen.top).toBeGreaterThanOrEqual(seen.view.top);
            // The keyboard's scroll view goes back to where it was as the keyboard hides: the step is scrolled again.
            expect(keyboard.hidden.size).toBe(1);
            await act(async () => { keyboard.hidden.forEach((fn) => fn()); });
            expect(scrolled.to.length).toBe(before + 1);
            expect(scrolled.to.at(-1)).toBe(scrolled.to.at(-2));
            // Nothing moved: nothing is scrolled under the reader.
            await measureNameStep(false);
            expect(scrolled.to.length).toBe(before + 1);
            // The step drawn anew (the pencil and back) starts at its top: scrolled again, though every part is where it was.
            await measureNameStep();
            expect(scrolled.to.length).toBe(before + 2);
        });

        it('the greeting grows while the name is being typed: the keyboard keeps its box clear, never scrolled back behind it', async () => {
            smallPhone(dark);
            params.now = { invite: 'INV-ABCD-EFGH', t: '1' };
            await mount();
            await measureNameStep();
            const before = scrolled.to.length;
            keyboard.up = true;
            phone.invite = { valid: true, inviterCallsign: 'Wilhelmina', communityName: 'The Riverside and Upper Valley Growers' };
            await type(ADDRESS, RIVERSIDE);
            await checkAnswers();
            expect(byId('invite-greeting')?.textContent).toContain('Wilhelmina');
            await measureNameStep(false);
            expect(scrolled.to.length).toBe(before);
            expect(scrolled.assured).toBeGreaterThan(0);
        });

        it('the front door: below the status bar, and at the end of its scroll "More ways in ›" is above the navigation bar', async () => {
            smallPhone(dark);
            await mount();
            const { at, box } = lay();
            expect(at(part('scroll')).top).toBe(STATUS);
            const under = box(part('scroll-content')).height - (at(part('front-door-more')).bottom - at(part('scroll-content')).top);
            expect(under, 'the room under the last link').toBeGreaterThanOrEqual(NAV);
            // The scroll view itself reaches the screen's end: the page shows behind a see-through bar.
            expect(at(part('scroll')).bottom).toBe(SCREEN.height);
        });
    });

    it("every scroll on the welcome screens: above a footer, which keeps the bar's room itself, or ending above the bar", async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const src = readFileSync(resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
        const scrolls = [...src.matchAll(/contentContainerStyle=\{styles\.(\w+)\}/g)];
        expect(scrolls.length).toBeGreaterThan(10);
        scrolls.forEach((m, i) => {
            const step = src.slice(m.index, scrolls[i + 1]?.index ?? src.length);
            expect(['scroll', 'scrollToEnd', 'homeContent'], m[0]).toContain(m[1]);
            expect(step.includes('<StepFooter'), `${m[1]} at line ${src.slice(0, m.index).split('\n').length}`).toBe(m[1] === 'scroll');
        });
        // Every screen of it sits on the one ground that keeps clear of the status bar.
        expect(src.match(/<SafeAreaView style=\{styles\.container\}>/g)?.length).toBe(src.match(/<SafeAreaView/g)?.length);
    });

    describe('the address box: only for a bare code that names no community, or an address that did not do', () => {
        it.each([
            ['a link tapped (router params)', async () => { params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' }; await mount(); }],
            ['the install referrer', async () => { referrer.value = `invite=INV-ABCD-EFGH&server=${encodeURIComponent(RIVERSIDE)}`; await mount(); }],
            ['a link copied', async () => { clip.text = `${RIVERSIDE}/?invite=INV-ABCD-EFGH`; await mount(); await press('I have an invite'); }],
            ['a link typed', async () => { await mount(); await press('I have an invite'); await type('Invite link or code', `${RIVERSIDE}/?invite=INV-ABCD-EFGH`); await press('Next'); }],
            ['a message with its address line', async () => { clip.text = 'Join us on BeanPool. Your invite code: INV-ABCD-EFGH\nCommunity address: riverside.example.org'; await mount(); await press('I have an invite'); }],
        ] as Array<[string, () => Promise<void>]>)('%s: not asked', async (_how, arrive) => {
            smallPhone(false);
            await arrive();
            expect(onNameScreen()).toBe(true);
            expect(field(ADDRESS)).toBeUndefined();
            expect(text()).not.toContain(REQUIRED);
            await type('Your name or nickname', 'Rowan');
            await press('Join');
            expect(phone.redeems).toEqual([{ code: 'INV-ABCD-EFGH', callsign: 'Rowan' }]);
        });

        it.each([null, 'https://lastused.example.org'])('a bare code copied, the community this phone last used %s: asked', async (last) => {
            smallPhone(false);
            if (last) store.map.set('beanpool_anchor_url', last);
            clip.text = 'INV-ABCD-EFGH';
            await mount();
            await press('I have an invite');
            expect(onNameScreen()).toBe(true);
            expect(field(ADDRESS)).toBeTruthy();
            expect(text()).toContain(REQUIRED);
        });

        it("the pencil and back with the same code: still the link's community; with another code alone: asked", async () => {
            smallPhone(false);
            params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
            await mount();
            await press('Change the invite');
            await press('Next');
            expect(onNameScreen()).toBe(true);
            expect(field(ADDRESS)).toBeUndefined();
            await press('Change the invite');
            await type('Invite link or code', 'INV-ZZZZ-YYYY');
            await press('Next');
            expect(field(ADDRESS)?.value).toBe(RIVERSIDE);
            expect(text()).toContain(REQUIRED);
        });

        it.each([
            ['not_a_community', 'riverside.example.org'],
            ['invites_off', 'riverside.example.org'],
            ['unknown_inviter', "Double-check you're joining the right community"],
        ])('the check says %s: the box is drawn to put it right, and the words say so before Join', async (reason, words) => {
            smallPhone(false);
            params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
            phone.invite = { valid: false, reason };
            await mount();
            expect(field(ADDRESS)).toBeUndefined();
            await checkAnswers();
            expect(field(ADDRESS)?.value).toBe(RIVERSIDE);
            expect(byId('invite-refused')?.textContent).toContain(words);
            // Put right: those words were for the old address.
            await type(ADDRESS, 'https://upstream.example.org');
            expect(byId('invite-refused')).toBeNull();
            expect(phone.redeems).toEqual([]);
        });

        it('nothing answers at Join: the address it tried is drawn', async () => {
            smallPhone(false);
            params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
            phone.checkFor = async () => null;
            phone.redeemFails = 'Network request failed';
            await mount();
            await type('Your name or nickname', 'Rowan');
            expect(field(ADDRESS)).toBeUndefined();
            await press('Join');
            expect(field(ADDRESS)?.value).toBe(RIVERSIDE);
        });

        it('a redeem refused, and the check after it says the community does not know the inviter: the box is drawn', async () => {
            smallPhone(false);
            params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
            phone.redeemFails = 'Not now';
            await mount();
            await type('Your name or nickname', 'Rowan');
            let asked = 0;
            phone.checkFor = async () => (asked++ === 0 ? { valid: true, inviterCallsign: 'Ana', communityName: 'Riverside' } : { valid: false, reason: 'unknown_inviter' });
            await press('Join');
            expect(asked).toBe(2);
            expect(text()).toContain('Not now');
            expect(field(ADDRESS)?.value).toBe(RIVERSIDE);
        });

        it('never hidden under the typing: the address the invite named, typed again in the box, leaves the box where it is', async () => {
            smallPhone(false);
            params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
            phone.invite = { valid: false, reason: 'invites_off' };
            await mount();
            await checkAnswers();
            await type(ADDRESS, 'https://upstream.example.org');
            // The same code again: the box is drawn for the address in hand, which isn't the one the invite named.
            await press('Change the invite');
            await press('Next');
            expect(field(ADDRESS)?.value).toBe('https://upstream.example.org');
            await type(ADDRESS, RIVERSIDE);
            expect(field(ADDRESS)?.value).toBe(RIVERSIDE);
        });

        describe('a join resumed after a restart', () => {
            const resume = (pending: Record<string, unknown>) => {
                smallPhone(false);
                phone.stored = { ...KNOCKER };
                phone.pending = { inviteCode: 'INV-ABCD-EFGH', anchorUrl: RIVERSIDE, callsign: 'Rowan', redeemed: false, ...pending };
            };

            it.each([
                ['no link', {}],
                ['the same link tapped again, its address written another way', { invite: 'INV-ABCD-EFGH', server: 'riverside.example.org', t: '1' }],
            ] as Array<[string, Record<string, string>]>)('at the name step, %s: not asked, and Join goes to that community', async (_how, link) => {
                resume({ step: 'create' });
                params.now = link;
                await mount();
                expect(onNameScreen()).toBe(true);
                expect(field(ADDRESS)).toBeUndefined();
                expect(text()).not.toContain(REQUIRED);
                await checkAnswers();
                expect(byId('invite-greeting')?.textContent).toContain('Ana invited you to Riverside');
                expect(field(ADDRESS)).toBeUndefined();
                await press('Join');
                expect(phone.redeems).toEqual([{ code: 'INV-ABCD-EFGH', callsign: 'Rowan' }]);
                expect(store.map.get('beanpool_anchor_url')).toBe(RIVERSIDE);
            });

            it('at the photo step, then its ‹: not asked', async () => {
                resume({ step: 'profileSetup', redeemed: true });
                phone.invite = { valid: false, reason: 'used', communityName: 'Riverside' };
                await mount();
                expect(text()).toContain('Choose your look');
                await press('Back');
                expect(onNameScreen()).toBe(true);
                expect(field(ADDRESS)).toBeUndefined();
                expect(text()).not.toContain(REQUIRED);
                // Its own code, spent by its own key: Join asks the node that, and nothing is said before.
                await checkAnswers();
                expect(byId('invite-refused')).toBeNull();
                expect(field(ADDRESS)).toBeUndefined();
            });

            it('nothing answers there at Join: the box is drawn, to put it right', async () => {
                resume({ step: 'create' });
                phone.checkFor = async () => null;
                phone.redeemFails = 'Network request failed';
                await mount();
                expect(field(ADDRESS)).toBeUndefined();
                await press('Join');
                expect(field(ADDRESS)?.value).toBe(RIVERSIDE);
            });

            it('no community in the record: asked', async () => {
                resume({ step: 'create', anchorUrl: '' });
                await mount();
                expect(onNameScreen()).toBe(true);
                expect(field(ADDRESS)).toBeTruthy();
                expect(text()).toContain(REQUIRED);
            });
        });
    });

    describe('a refused code, said on the name step by the check the greeting already makes', () => {
        const UNKNOWN = "That invite wasn't recognised by your community.";
        const USED = 'This invite has already been used';

        it('a made-up code: said under the band, nothing redeemed, Join still there', async () => {
            smallPhone(false);
            params.now = { invite: 'INV-2222-2222', server: RIVERSIDE, t: '1' };
            phone.invite = { valid: false, reason: 'invalid', communityName: 'Riverside' };
            await mount();
            expect(byId('invite-refused')).toBeNull();
            await checkAnswers();
            expect(byId('invite-refused')?.textContent).toContain(UNKNOWN);
            expect(field(ADDRESS), 'the address did: only the code did not').toBeUndefined();
            expect(phone.redeems).toEqual([]);
            // Join says the same, once: in its own place, with the note gone.
            await type('Your name or nickname', 'Rowan');
            await press('Join');
            expect(text().split(UNKNOWN).length - 1).toBe(1);
            expect(byId('invite-refused')).toBeNull();
            expect(phone.redeems).toEqual([]);
        });

        it('an address being typed for a bare code: checked half typed, nothing said until Join', async () => {
            smallPhone(false);
            params.now = { invite: 'INV-ABCD-EFGH', t: '1' };
            phone.invite = { valid: false, reason: 'not_a_community' };
            await mount();
            await type(ADDRESS, 'https://river.example.org');
            await checkAnswers();
            expect(byId('invite-refused')).toBeNull();
        });

        it('belongs to its code: another code for the same community has none until its own check', async () => {
            smallPhone(false);
            params.now = { invite: 'INV-2222-2222', server: RIVERSIDE, t: '1' };
            phone.checkFor = async (code) => (code === 'INV-2222-2222' ? { valid: false, reason: 'invalid' } : { valid: true, inviterCallsign: 'Asha', communityName: 'Riverside' });
            await mount();
            await checkAnswers();
            expect(byId('invite-refused')).toBeTruthy();
            await press('Change the invite');
            await type('Invite link or code', 'INV-ASHA-AAAA');
            await press('Next');
            expect(byId('invite-refused')).toBeNull();
            await checkAnswers();
            expect(byId('invite-refused')).toBeNull();
            expect(byId('invite-greeting')?.textContent).toContain('Asha invited you to Riverside');
        });

        it('a spent code: said on a phone with no account; with one, only Join asks the node whose it was', async () => {
            smallPhone(false);
            params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
            phone.invite = { valid: false, reason: 'used', communityName: 'Riverside' };
            await mount();
            await checkAnswers();
            expect(byId('invite-refused')?.textContent).toContain(USED);
            leave();
            phone.stored = { ...KNOCKER };
            params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '2' };
            await mount();
            await checkAnswers();
            expect(onNameScreen()).toBe(true);
            expect(byId('invite-refused')).toBeNull();
        });

        it('no answer (offline): nothing said, Join as before', async () => {
            smallPhone(false);
            params.now = { invite: 'INV-ABCD-EFGH', server: RIVERSIDE, t: '1' };
            phone.checkFor = async () => null;
            await mount();
            await checkAnswers();
            expect(byId('invite-refused')).toBeNull();
            expect(byId('invite-greeting')?.textContent).toContain("You're invited");
        });
    });

    // Review of #3361 at bac287d9: the early check said Join's words and did nothing else of what Join's refusal does. The held
    // link reopened every launch on a dead code, a spent one had no way to Recover, and "the right community" had no box.
    describe('a refused code: the check as the step opens and Join do the same', () => {
        const HELD_INVITE = 'beanpool_held_invite';
        const CODE = 'INV-ABCD-EFGH';
        const RECOVER = '🔑 Recover an existing account with seed phrase →';
        const NAME = 'Your name or nickname';
        const hold = (invite: Record<string, unknown> = { invite: CODE, server: RIVERSIDE }) => store.map.set(HELD_INVITE, JSON.stringify({ ...invite, at: Date.now() }));
        const heldCode = () => { const raw = store.map.get(HELD_INVITE); return raw ? JSON.parse(raw).invite : null; };
        const styleOf = (el: Element) => JSON.parse(el.getAttribute('data-style') ?? '{}') as Record<string, any>;
        /** The lines in the error's style: what the step says is wrong, wherever on it. */
        const problems = () => all('span').filter((el) => styleOf(el).color === onboardingColors(look148.dark ? 'night' : 'light').colors.feedback.danger.fg && styleOf(el).textAlign === 'center');
        const recovers = () => all('button').filter((b) => b.textContent === RECOVER);
        /** What the refusal says (once), offers right under it, asks for, and leaves held. */
        const outcome = () => ({
            words: problems().map((el) => el.textContent),
            recover: recovers().map((b) => b.previousElementSibling?.textContent),
            addressBox: field(ADDRESS)?.value ?? null,
            held: heldCode(),
        });
        /** The refusal heard by the check as the step opens. Join is never tapped. */
        async function early(reason: string | undefined, dark = false) {
            smallPhone(dark);
            hold();
            phone.invite = { valid: false, reason, communityName: 'Riverside' };
            await mount();
            expect(onNameScreen()).toBe(true);
            await checkAnswers();
            expect(byId('invite-refused')).toBeTruthy();
            return outcome();
        }
        /** The refusal heard by Join alone: the check as the step opens has no answer. */
        async function atJoin(reason: string | undefined, dark = false) {
            smallPhone(dark);
            hold();
            let joining = false;
            phone.checkFor = async () => (joining ? { valid: false, reason, communityName: 'Riverside' } : null);
            await mount();
            await type(NAME, 'Rowan');
            expect(heldCode()).toBe(CODE);
            joining = true;
            await press('Join');
            expect(byId('invite-refused')).toBeNull();
            return outcome();
        }
        async function relaunch() {
            leave();
            phone.checkFor = null;
            await mount();
        }

        const ROWS: Array<[reason: string | undefined, words: string, forgotten: boolean, recover: boolean, box: boolean]> = [
            ['used', 'This invite has already been used', true, true, false],
            ['expired', 'This invite has expired', true, false, false],
            ['invalid', "That invite wasn't recognised by your community.", true, false, false],
            ['malformed', "That invite wasn't recognised by your community.", true, false, false],
            ['unknown_inviter', "This community doesn't know the person who made this invite. Double-check you're joining the right community", false, false, true],
            ['invites_off', 'riverside.example.org doesn’t use invites', false, false, true],
            ['not_a_community', 'There is no BeanPool community at riverside.example.org.', false, false, true],
            ['admins_only', MEMBER_TICKET_REFUSED_TEXT, false, false, false],
            [undefined, "That invite wasn't recognised by your community.", false, false, false],
        ];
        describe.each([false, true])('dark: %s', (dark) => {
            it.each(ROWS)('%s: the words, what is offered, the address box and what stays held', async (reason, words, forgotten, recover, box) => {
                const first = await early(reason, dark);
                expect(first.words).toEqual([expect.stringContaining(words)]);
                expect(first).toMatchObject({ recover: recover ? first.words : [], addressBox: box ? RIVERSIDE : null, held: forgotten ? null : CODE });
                // The next launch: the front door for a dead code, else the invite again.
                await relaunch();
                expect(!!byId('front-door'), 'the front door').toBe(forgotten);
                expect(onNameScreen()).toBe(!forgotten);
                leave();

                store.map.clear();
                const join = await atJoin(reason, dark);
                expect(join).toEqual(first);
                await relaunch();
                expect(!!byId('front-door'), 'the front door').toBe(forgotten);
                expect(phone.redeems).toEqual([]);
            });

            it.each([['early', early], ['at Join', atJoin]] as const)('a spent code said %s: Recover is in the set drawn, and opens the words screen', async (_when, hear) => {
                await hear('used', dark);
                const recover = button(RECOVER);
                const { colors } = onboardingColors(dark ? 'night' : 'light');
                expect(styleOf(recover).backgroundColor).toBe(dark ? colors.feedback.info.bg : palette.blue50);
                expect(styleOf(recover).borderColor).toBe(dark ? colors.feedback.info.border : palette.blue200);
                expect(styleOf(recover.firstElementChild!).color).toBe(dark ? palette.blue400 : palette.blue600);
                await press(RECOVER);
                expect(text()).toContain('🔑 Recover Identity');
                expect(phone.redeems).toEqual([]);
            });

            it.each(['used', 'expired', 'invalid', 'unknown_inviter'])('%s, as the step opens: the name box above the Join footer, with it what is offered and the end of the words, inside the width', async (reason) => {
                await early(reason, dark);
                await measureNameStep();
                const { at, box } = lay();
                const y = scrolledTo();
                const view = at(part('scroll'));
                expect(view.bottom).toBe(at(part('step-footer-invite')).top);
                // The address box where the answer is about the address, then the name box.
                expect(all('input').length).toBe(reason === 'unknown_inviter' ? 2 : 1);
                expect(recovers().length).toBe(reason === 'used' ? 1 : 0);
                for (const el of [...recovers(), ...all('input')]) {
                    expect(at(el).top - y).toBeGreaterThanOrEqual(view.top);
                    expect(at(el).bottom - y).toBeLessThanOrEqual(view.bottom);
                }
                expect(at(part('invite-refused')).bottom - y).toBeGreaterThan(view.top);
                for (const el of [part('invite-refused'), ...recovers(), ...all('input')]) {
                    expect(box(el).width).toBeGreaterThan(0);
                    expect(box(el).width).toBeLessThanOrEqual(SCREEN.width - 2 * 24);
                    expect(el.getAttribute('data-lines')).toBeNull();
                }
                for (const b of recovers()) expect(box(b).height, 'a thumb').toBeGreaterThanOrEqual(44);
            });
        });

        it('a fresh link copied after the early refusal, the app opened again: "I have an invite" reads it', async () => {
            await early('expired');
            await relaunch();
            clip.has = true; clip.text = `${RIVERSIDE}/?invite=INV-FRSH-LINK`;
            phone.invite = { valid: true, inviterCallsign: 'Ana', communityName: 'Riverside' };
            await press('I have an invite');
            expect(clip.reads).toBe(1);
            await checkAnswers();
            expect(byId('invite-greeting')?.textContent).toContain('Ana invited you to Riverside');
            expect(byId('invite-refused')).toBeNull();
        });

        // Review of #3361 (pre-existing): after a dead code was refused, ‹ kept it in hand, so "I have an invite" read neither the
        // phone's held invite nor the clipboard and went straight back to the same dead code. A dead code goes with the step's ‹;
        // any other refusal's code stays in hand, as before (its community or its address may still do).
        const BACK_THEN_TAP: Array<[reason: string, dead: boolean]> = [
            ['used', true], ['expired', true], ['invalid', true], ['malformed', true],
            ['unknown_inviter', false], ['invites_off', false],
        ];
        it.each(BACK_THEN_TAP.flatMap(([reason, dead]) => (['early', 'at Join'] as const).map((when) => [reason, when, dead] as const)))(
            '%s, said %s, then ‹ and "I have an invite": a dead code is gone, the clipboard is read; any other stays in hand',
            async (reason, when, dead) => {
                await (when === 'early' ? early(reason) : atJoin(reason));
                await press('Back to Home');
                expect(byId('front-door')).toBeTruthy();
                // Nothing copied: Your invite, its box empty, for a dead code; the same code again, for any other.
                await press('I have an invite');
                expect(clip.reads, 'the clipboard is read only with no code in hand').toBe(dead ? 1 : 0);
                expect(onNameScreen(), 'the refused code\'s name screen again').toBe(!dead);
                if (dead) expect(field('Invite link or code')?.value).toBe('');
                await press(dead ? 'Back' : 'Back to Home');
                // A fresh invite copied meanwhile: read at the tap, and greeted.
                clip.has = true; clip.text = `${RIVERSIDE}/?invite=INV-FRSH-LINK`;
                phone.checkFor = null;
                phone.invite = { valid: true, inviterCallsign: 'Ana', communityName: 'Riverside' };
                const readsBefore = clip.reads;
                await press('I have an invite');
                await checkAnswers();
                expect(clip.reads - readsBefore).toBe(dead ? 1 : 0);
                expect(onNameScreen()).toBe(true);
                if (dead) {
                    expect(byId('invite-greeting')?.textContent).toContain('Ana invited you to Riverside');
                    expect(byId('invite-refused')).toBeNull();
                }
                expect(phone.redeems).toEqual([]);
            },
        );

        it('a newer link held meanwhile stays: only the refused code is forgotten', async () => {
            smallPhone(false);
            params.now = { invite: CODE, server: RIVERSIDE, t: '1' };
            hold({ invite: 'INV-NEWR-LINK', server: RIVERSIDE });
            phone.invite = { valid: false, reason: 'expired' };
            await mount();
            await checkAnswers();
            expect(byId('invite-refused')).toBeTruthy();
            expect(heldCode()).toBe('INV-NEWR-LINK');
        });

        it.each(['used', 'expired', 'invalid'])('a held code with an address being typed, which answers %s: nothing said, and it stays held', async (reason) => {
            smallPhone(false);
            hold({ invite: CODE });
            phone.invite = { valid: false, reason };
            await mount();
            await type(ADDRESS, 'https://river.example.org');
            await checkAnswers();
            expect(byId('invite-refused')).toBeNull();
            expect(heldCode()).toBe(CODE);
        });

        it("the link's address changed in the box to one that answers invalid: nothing said before Join, and it stays held", async () => {
            await early('unknown_inviter');
            phone.invite = { valid: false, reason: 'invalid' };
            await type(ADDRESS, 'https://upstream.example.org');
            await checkAnswers();
            expect(byId('invite-refused')).toBeNull();
            expect(heldCode()).toBe(CODE);
        });

        it.each(['expired', 'invalid'])('a resumed join whose code is %s now: said as the step opens, and forgotten', async (reason) => {
            smallPhone(false);
            hold();
            phone.stored = { ...KNOCKER };
            phone.pending = { step: 'create', inviteCode: CODE, anchorUrl: RIVERSIDE, callsign: 'Rowan', redeemed: false };
            phone.invite = { valid: false, reason, communityName: 'Riverside' };
            await mount();
            await checkAnswers();
            expect(byId('invite-refused')).toBeTruthy();
            expect(field(ADDRESS)).toBeUndefined();
            expect(heldCode()).toBeNull();
        });

        it('a spent code on a phone with an account: nothing early, so nothing is forgotten until Join has asked whose it was', async () => {
            smallPhone(false);
            phone.stored = { ...KNOCKER };
            hold();
            params.now = { invite: CODE, server: RIVERSIDE, t: '1' };
            phone.invite = { valid: false, reason: 'used', communityName: 'Riverside' };
            await mount();
            await checkAnswers();
            expect(byId('invite-refused')).toBeNull();
            expect(heldCode()).toBe(CODE);
        });
    });
});
