// @vitest-environment jsdom
/**
 * Look before you join on a new phone (DESIGN-entry-points-fable.md §3.3, slice S12; utils/look-around.ts), on the real
 * welcome screen (app/welcome.tsx) with the harness of welcome-words-render.test.ts: React Native's host components as
 * plain tags, the node, the vault, the sign-ins and the phone's key store stubbed. Nothing is contacted.
 *
 * 1. A phone with no account taps Explore BeanPool worldwide: the global community is looked at first (the visit with
 *    no identity), and the phone goes to the Market. No key is drafted and none of the door's work starts: that is
 *    Join's. Before S12 the tap opened the door at once, which drafted the key and started the 12-words work.
 * 2. Where it can't be looked at (the door shut or unreachable, an offline first open): the door opens as before, says
 *    why, and the work starts only there.
 * 3. Join from the look (`/welcome?join=look`, utils/look-around.ts LOOK_DOOR): the door opens, its work starts at that
 *    tap, and its Back returns to the look, not to the first screen.
 * 4. A phone that looked around, back on the first screen (a restart): the community in use is the look's, and never
 *    fills an invite's address. An invite's own server is the one used, and a bare code asks for its community.
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
// The look (utils/global-guest-visit.ts): what the visit answers, and who it was asked for.
const look = vi.hoisted(() => ({ answer: { kind: 'guest' } as { kind: string }, askedFor: [] as unknown[] }));
vi.mock('../global-guest-visit', () => ({
    visitGlobalAsGuest: async (identity: unknown) => { look.askedFor.push(identity); return look.answer; },
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

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    store.map.clear();
    alerts.said.length = 0; alerts.buttons.length = 0; prompts.asked.length = 0;
    params.now = {};
    nav.replaced.length = 0; nav.pushed.length = 0;
    work.started.length = 0; work.keysDrafted = 0;
    look.answer = { kind: 'guest' }; look.askedFor.length = 0;
    clip.has = false; clip.text = '';
    phone.stored = null; phone.pending = null;
    // An open door with both ways in: opened, it would draft the key and start the 12-words work at once.
    door.check = { ok: true, profile: { profile: 'global', features: { openJoin: true, wordsDoor: true, guestListingsOnly: true } } };
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

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
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
    const input = all('input').find((i) => i.getAttribute('aria-label') === label) as HTMLInputElement | undefined;
    expect(input, `a field "${label}"`).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
};
const communityField = () => (all('input').find((i) => i.getAttribute('aria-label') === 'Community name or node address') as HTMLInputElement | undefined)?.value;
const GLOBAL = 'https://global.beanpool.org';
const MULLUM = 'https://mullum.beanpool.org';
/** What the look leaves on the phone (global-guest-visit.ts with no identity): global in use, marked a guest visit. */
function lookedAround() {
    store.map.set('beanpool_anchor_url', GLOBAL);
    store.map.set('beanpool_guest_nodes', JSON.stringify([GLOBAL]));
    door.cachedProfile = { profile: 'global', features: { openJoin: true, guestListingsOnly: true } };
}
/** The door's own screen is up: its two ways in (WordsDoor's DoorChoices, a stand-in here). */
const doorOpen = () => all('[data-later-sweep="DoorChoices"]').length > 0;

describe('look before you join on a new phone (slice S12)', () => {
    it('1. Explore BeanPool worldwide with no account: looked at first, then the Market; no key drafted, no door work started', async () => {
        await mount();
        expect(doorOpen()).toBe(false);
        await press('Explore BeanPool worldwide');
        expect(look.askedFor).toEqual([null]);
        expect(nav.replaced).toEqual(['/(tabs)/market']);
        expect(doorOpen()).toBe(false);
        expect(work.keysDrafted).toBe(0);
        expect(work.started).toEqual([]);
    });

    it('2. where it can\'t be looked at (an offline first open, a shut door): the door as before, and its work starts there', async () => {
        look.answer = { kind: 'door' };
        await mount();
        await press('Explore BeanPool worldwide');
        expect(look.askedFor).toEqual([null]);
        expect(nav.replaced).toEqual([]);
        expect(doorOpen()).toBe(true);
        expect(work.keysDrafted).toBeGreaterThan(0);
        expect(work.started).toEqual(['words']);
    });

    it('3. Join from the look: the door opens, its work starts at that tap, and Back returns to the look', async () => {
        params.now = { join: 'look' };
        await mount();
        expect(look.askedFor).toEqual([]);
        expect(doorOpen()).toBe(true);
        expect(work.started).toEqual(['words']);
        await press('Back');
        expect(nav.replaced).toEqual(['/(tabs)/market']);
    });

    it('3b. not from the look, the door\'s Back is the first screen\'s, as before', async () => {
        look.answer = { kind: 'door' };
        await mount();
        await press('Explore BeanPool worldwide');
        await press('Back to Home');
        expect(nav.replaced).toEqual([]);
        expect(doorOpen()).toBe(false);
        expect(button('Explore BeanPool worldwide')).toBeTruthy();
    });

    it('4a. a phone that looked around, then sent an invite with its server: the invite\'s server is the one used, not the look\'s', async () => {
        lookedAround();
        params.now = { invite: 'MULL-1234', server: MULLUM };
        await mount();
        expect(communityField()).toBe(MULLUM);
    });

    it('4b. a phone that looked around, a bare invite code: the community field is empty, as on a new phone, never the look\'s', async () => {
        lookedAround();
        await mount();
        await press('Join with an invite');
        await type('Invite link or code', 'MULL-1234');
        expect(communityField()).toBe('');
    });

    it('4c. not looking around (the community in use is no guest visit): the field holds the phone\'s community, as before', async () => {
        store.map.set('beanpool_anchor_url', MULLUM);
        await mount();
        await press('Join with an invite');
        await type('Invite link or code', 'MULL-1234');
        expect(communityField()).toBe(MULLUM);
    });
});
