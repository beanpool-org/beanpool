// @vitest-environment jsdom
/**
 * The key, sign-in and recovery screens in the member's language (words S3, sweep B10), rendered for real inside the real
 * LanguageProvider with React Native's host components as plain tags (key-words-harness.ts): Restore Account
 * (app/recover-identity.tsx), the four sign-in returns (app/auth/*), a new phone's code (new-phone-code.tsx), the old
 * 12 words (old-words-unlock.tsx), confirming a member's new phone (confirm-new-phone.tsx), an owner's words check
 * (owner-words-check.tsx), signing a computer in (settings-signin.tsx), taking over or restoring with this phone
 * (unlock-keys.tsx) and linking a device (pair-device.tsx). The camera, the community, the phone's lock and every key,
 * seal and signature step are stubbed at the screens' own imports; what they answer is in the files that write it.
 *
 * In the pseudo-locale (`xx`) any text, label, hint, placeholder or alert with letters outside a bracket bypassed t().
 * Shown as written: members' names and callsigns, communities' and servers' names and addresses, groups' names, codes,
 * a browser's name, the words a member types (the 12 words are never looked up), and "word word word …": the sample in
 * the owners' check box, kept English on purpose (the 12 words are English words from the list).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Some screens don't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock('react-native', async () => (await import('./key-words-harness')).nativeMock(alerts));
const nav = vi.hoisted(() => ({ params: {} as Record<string, string | undefined>, back: 0, replaced: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    const r = { replace: (to: unknown) => nav.replaced.push(to), push() {}, back: () => { nav.back++; }, canGoBack: () => true, navigate() {} };
    return {
        router: r, useRouter: () => r,
        useLocalSearchParams: () => nav.params,
        useNavigation: () => ({ setParams() {} }),
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        useIsFocused: () => true,
        ErrorBoundary: () => null,
    };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-haptics', () => ({
    notificationAsync: async () => {}, selectionAsync: async () => {}, NotificationFeedbackType: { Success: 's', Error: 'e' },
}));
vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: () => ({}) }));
vi.mock('expo-linking', () => ({ useURL: () => null }));
const camera = vi.hoisted(() => ({ onScanned: null as null | ((r: { data: string }) => void), granted: true }));
vi.mock('expo-camera', async () => {
    const { createElement: h } = await import('react');
    return {
        useCameraPermissions: () => [{ granted: camera.granted, canAskAgain: true }, async () => ({ granted: camera.granted })],
        CameraView: ({ onBarcodeScanned }: { onBarcodeScanned?: (r: { data: string }) => void }) => {
            camera.onScanned = onBarcodeScanned ?? null;
            return h('div', { 'data-camera': 'true' });
        },
    };
});
vi.mock('react-native-qrcode-svg', async () => {
    const { createElement: h } = await import('react');
    return { default: () => h('div', { 'data-qr': 'true' }) };
});
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return {
        useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
        SafeAreaView: ({ children }: { children?: unknown }) => h('div', null, children as any),
    };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    const pass = ({ children }: { children?: unknown }) => h('div', null, children as any);
    return { KeyboardAwareScrollView: pass, KeyboardStickyView: pass, KeyboardAvoidingView: pass };
});
vi.mock('@expo/vector-icons', async () => {
    const { createElement: h } = await import('react');
    return { MaterialCommunityIcons: ({ name }: { name: string }) => h('i', { 'data-icon': name }) };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx), useOnboardingColors: () => onboardingColors('light') };
});
const me = vi.hoisted(() => ({ identity: { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Sally' } as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity, setIdentity() {}, isLoading: false }) }));
const clip = vi.hoisted(() => ({ text: '' }));
vi.mock('expo-clipboard', () => ({ getStringAsync: async () => clip.text }));
vi.mock('../../components/WordsOnScreen', async () => {
    const { createElement: h } = await import('react');
    return { NoScreenCapture: ({ children }: { children?: unknown }) => h('div', null, children as any), NoScreenLockNote: () => null };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)) };
});
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, getEnrolledLevelAsync: async () => 0,
    authenticateAsync: async () => ({ success: false }),
}));
// The groups and the database the group-history screens read: what the test says.
const groups = vi.hoisted(() => ({ items: [{ kind: 'group', id: 'g1', name: 'Riverbend Garden' }] as any[] }));
vi.mock('../../components/useYourGroups', () => ({ yourGroupsStore: { getState: () => ({ items: groups.items }) } }));
const db = vi.hoisted(() => ({
    code: 'beanpool-new-phone/1:abc' as string | null,
    notes: [] as Array<{ name: string; at: number }>,
    unlock: null as any,
    check: null as any,
    confirmed: null as any,
}));
vi.mock('../db', () => ({
    newPhoneCode: async () => db.code,
    newPhoneHandOvers: async () => new Set<string>(),
    newPhoneConfirmedNotes: async () => db.notes,
    lockedHistoryRows: async () => ({}),
    unlockGroupHistoryWithWords: async (_w: string[], _g: unknown, progress: (d: number, t: number) => void) => { progress(1, 3); return db.unlock; },
    checkScannedNewPhone: async () => db.check,
    confirmScannedNewPhone: async (_c: unknown, progress: (n: number, m: number) => void) => { progress(1, 2); return db.confirmed; },
}));
vi.mock('../node-post', () => ({ anchorUrl: async () => 'https://mullum.example' }));
// The owners' check: the words are compared with this account on the phone; here, the answer the test says.
const owner = vi.hoisted(() => ({ matches: false, hasWords: true }));
vi.mock('../owner-words', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../owner-words')>()),
    checkMyWords: async (typed: string) => (typed.trim().split(/\s+/).filter(Boolean).length !== 12 ? { matches: false, reason: 'count' } : { matches: owner.matches }),
    sendOwnerWordsAttestation: async () => null,
    forgetOwnerWordsStatus: () => {},
    saveCheckedWords: async () => ({ ok: false }),
    shouldOfferSaveWords: () => !owner.hasWords,
}));
vi.mock('../identity', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../identity')>()),
    hasMnemonic: () => owner.hasWords,
    getMnemonic: async () => null,
}));
// A computer signing in: the scan, the node's answer and the approval are the test's.
const signin = vi.hoisted(() => ({ scan: null as any, look: null as any, outcome: null as any }));
vi.mock('../settings-signin', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../settings-signin')>()),
    readSigninScan: () => signin.scan,
    lookupPairing: async () => signin.look,
    approveComputerSignin: async () => signin.outcome,
    declineComputerSignin: async () => {},
}));
// A take-over or restore: likewise.
const unlock = vi.hoisted(() => ({ fromLink: null as string | null, scan: null as any, look: null as any, outcome: null as any }));
vi.mock('../takeover-unlock', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../takeover-unlock')>()),
    unlockTextFromParams: () => unlock.fromLink,
    readUnlockScan: () => unlock.scan,
    readLockPin: async () => null,
    lookupUnlock: async () => unlock.look,
    approveUnlock: async () => unlock.outcome,
}));
// Linking a device: the code read, where it may go, and the phone's lock.
const pair = vi.hoisted(() => ({ target: null as any, unlocked: 'no-device-lock' as string }));
vi.mock('../pair-device-target', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../pair-device-target')>()),
    readPairingCode: () => ({ kind: 'pairing', qr: { nodeUrl: 'https://mullum.example', sessionId: 's1', desktopPubHex: 'cd'.repeat(32) } }),
    transferTarget: () => pair.target,
}));
vi.mock('../node-admin', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-admin')>()),
    requireDeviceUnlock: async () => pair.unlocked,
}));
vi.mock('../nodes', () => ({ getSavedNodes: async () => [] }));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import RecoverIdentityScreen from '../../app/recover-identity';
import FacebookAuthCallbackScreen from '../../app/auth/facebook';
import GoogleAuthCallbackScreen from '../../app/auth/google';
import InstagramAuthCallbackScreen from '../../app/auth/instagram';
import TikTokAuthCallbackScreen from '../../app/auth/tiktok';
import NewPhoneCodeScreen from '../../app/new-phone-code';
import OldWordsUnlockScreen from '../../app/old-words-unlock';
import ConfirmNewPhoneScreen from '../../app/confirm-new-phone';
import OwnerWordsCheckScreen from '../../app/owner-words-check';
import SettingsSigninScreen from '../../app/settings-signin';
import UnlockKeysScreen from '../../app/unlock-keys';
import PairDeviceScreen from '../../app/pair-device';
import { NO_DEVICE_LOCK_MESSAGE } from '../node-admin';
import { newPhoneNotListedText, oldWordsWithheldText } from '../group-history-unlock';
import { OWNER_WORDS_COPY } from '../owner-words';
import { SIGNIN_QUESTION } from '../settings-signin';
import { bypassing, unfit } from './key-words-harness';

const TWELVE = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
/** Names, addresses, codes and a browser: shown as written. */
const WRITTEN = [
    'Sally', 'Wren', 'Riverbend Garden', 'Tool Library', 'Riverbend', 'mullum.example', 'standby.riverbend.example', 'K7F 3QX', 'Firefox on Linux',
    '203.0.113.7', 'Claude', 'api.example.com', 'abcdef12', 'BeanPool', 'Google', 'Facebook', 'Instagram Creator', 'TikTok', 'word word word …',
    // This account's key, its first and last characters.
    `${'a'.repeat(10)}...${'a'.repeat(6)}`,
    ...TWELVE,
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    nav.params = {};
    nav.back = 0;
    camera.granted = true;
    camera.onScanned = null;
    store.map.clear();
    owner.matches = false;
    owner.hasWords = true;
    unlock.fromLink = null;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, Screen: () => unknown) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(Screen as any)) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
const buttonWith = (english: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(pseudoLocalise(english))) ?? null;
const scan = async (data = 'scanned') => {
    expect(camera.onScanned, 'the camera is waiting').toBeTruthy();
    await act(async () => { camera.onScanned!({ data }); });
    await settle();
};
async function type(into: Element | null, value: string) {
    expect(into, 'the field').toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(into, value);
        into!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
}
const clean = () => bypassing(host, WRITTEN, alerts.said);

describe('Restore Account and the sign-in returns in the pseudo-locale', () => {
    it('Restore Account: both ways back and Back to Welcome', async () => {
        await renderIn('xx', RecoverIdentityScreen);
        expect(host.querySelector('[role="heading"]')?.textContent).toBe(pseudoLocalise('Restore Account'));
        expect(clean()).toEqual([]);
        // 320 - 2 × 24 (the scroll) - 2 × 24 (the card) - 2 × 16 (an option) - the icon and chevron with their gaps.
        expect(unfit(host, 320 - 48 - 48 - 32, WRITTEN)).toEqual([]);
    });

    it('the four sign-in returns', async () => {
        for (const Screen of [FacebookAuthCallbackScreen, GoogleAuthCallbackScreen, InstagramAuthCallbackScreen, TikTokAuthCallbackScreen]) {
            await renderIn('xx', Screen);
            expect(clean(), Screen.name).toEqual([]);
            expect(unfit(host, 320 - 32, WRITTEN), Screen.name).toEqual([]);
        }
    });
});

describe('the old 12 words and a new phone in the pseudo-locale', () => {
    it('a new phone\'s code, and who confirmed it', async () => {
        db.code = 'beanpool-new-phone/1:abc';
        db.notes = [{ name: 'Wren', at: new Date(2026, 9, 3).getTime() }];
        await renderIn('xx', NewPhoneCodeScreen);
        expect(host.textContent).toContain('Wren');
        expect(host.querySelector('[data-qr]')).not.toBeNull();
        expect(clean()).toEqual([]);
        expect(unfit(host, 320 - 32, WRITTEN)).toEqual([]);
        act(() => root.unmount());
        root = createRoot(host);
        db.code = null;
        await renderIn('xx', NewPhoneCodeScreen);
        expect(host.textContent).toContain(pseudoLocalise("This phone doesn't know which key it replaced yet. Confirm your re-key when the app asks, then come back."));
        expect(clean()).toEqual([]);
    });

    it('the old 12 words: typed, then the progress and an ending that names the group the node withheld', async () => {
        db.unlock = { outcome: 'done', unlocked: { g1: 2 }, withheld: [{ id: 'g2', name: 'Tool Library' }], refused: 0 };
        await renderIn('xx', OldWordsUnlockScreen);
        expect(clean()).toEqual([]);
        clip.text = TWELVE.join(' ');
        await click(buttonWith('📋 Paste'), 'Paste');
        await click(buttonWith('Unlock earlier messages'), 'Unlock');
        expect(host.textContent).toContain(pseudoLocalise('Done. Your earlier messages are unlocked on this phone.'));
        expect(host.textContent).toContain(pseudoLocalise(oldWordsWithheldText('{name}')).replace('{name}', 'Tool Library'));
        expect(clean()).toEqual([]);
        expect(unfit(host, 320 - 32, WRITTEN)).toEqual([]);
    });

    it('confirming a member\'s new phone: a refusal by name, then what confirming does, then the end', async () => {
        db.check = { ok: false, reason: 'not_listed', text: newPhoneNotListedText('Wren') };
        await renderIn('xx', ConfirmNewPhoneScreen);
        expect(clean()).toEqual([]);
        await scan();
        expect(host.textContent).toContain(pseudoLocalise("This isn't the phone the community lists for {name}.").replace('{name}', 'Wren'));
        expect(clean()).toEqual([]);
        db.check = { ok: true, name: 'Wren', oldKey: 'o', newKey: 'n', groups: [{ id: 'g1', name: 'Riverbend Garden' }, { id: 'g2', name: 'Tool Library' }] };
        db.confirmed = { total: 2, planned: 2, stopped: false };
        await click(buttonWith('Scan again'), 'Scan again');
        await scan();
        expect(host.textContent).toContain('Riverbend Garden');
        expect(clean()).toEqual([]);
        await click(buttonWith('Confirm'), 'Confirm');
        expect(host.textContent).toContain(pseudoLocalise("Done. {name}'s new phone can read those conversations.").replace('{name}', 'Wren'));
        expect(clean()).toEqual([]);
        expect(unfit(host, 320 - 32, WRITTEN)).toEqual([]);
    });
});

describe('an owner\'s 12 words check in the pseudo-locale', () => {
    it('too few words, the wrong words, then the right words on a phone with no copy', async () => {
        await renderIn('xx', OwnerWordsCheckScreen);
        expect(host.textContent).toContain(pseudoLocalise(OWNER_WORDS_COPY.why));
        expect(clean()).toEqual([]);
        const box = host.querySelector('input');
        await type(box, TWELVE.slice(0, 3).join(' '));
        await click(buttonWith('Check my words'), 'Check');
        expect(host.textContent).toContain(pseudoLocalise("That's {n} words. Type all 12, in order.").replace('{n}', '3'));
        expect(clean()).toEqual([]);
        await type(host.querySelector('input'), TWELVE.join(' '));
        await click(buttonWith('Check my words'), 'Check');
        expect(host.textContent).toContain(pseudoLocalise(OWNER_WORDS_COPY.mismatch));
        owner.matches = true;
        owner.hasWords = false;
        await type(host.querySelector('input'), TWELVE.join(' '));
        await click(buttonWith('Check my words'), 'Check');
        expect(host.textContent).toContain(pseudoLocalise(OWNER_WORDS_COPY.saveOffer));
        expect(clean()).toEqual([]);
        expect(unfit(host, 320 - 32, WRITTEN)).toEqual([]);
    });
});

describe('signing a computer in, in the pseudo-locale', () => {
    const qr = { nodeUrl: 'https://mullum.example', pairingId: 'p1', shortCode: 'K7F3QX' };
    const look = (agent: unknown = null) => ({
        kind: 'ok', browser: 'Firefox on Linux', expiresAt: 0, expiresInSeconds: 95, askedSecondsAgo: 12, fromAddress: '203.0.113.7', sameNetwork: true, agent,
    });

    it('a code it can\'t read: the alert', async () => {
        nav.params = { community: 'Riverbend' };
        signin.scan = { kind: 'malformed' };
        await renderIn('xx', SettingsSigninScreen);
        expect(clean()).toEqual([]);
        await scan();
        expect(alerts.said[0]).toBe(pseudoLocalise("Can't read that code"));
        expect(clean()).toEqual([]);
    });

    it('the question, the computer\'s lines, the time left; then the digits; then a refusal', async () => {
        nav.params = { community: 'Riverbend' };
        signin.scan = { kind: 'ok', qr };
        signin.look = look();
        signin.outcome = { kind: 'approved', confirmCode: '42' };
        await renderIn('xx', SettingsSigninScreen);
        await scan();
        expect(host.textContent).toContain(pseudoLocalise(SIGNIN_QUESTION));
        expect(host.textContent).toContain(pseudoLocalise('Computer: {browser}').replace('{browser}', 'Firefox on Linux'));
        expect(clean()).toEqual([]);
        // 320 - 2 × 20 (the sheet's padding) - 2 × 12 (the box's).
        expect(unfit(host, 320 - 40 - 24, WRITTEN)).toEqual([]);
        await click(buttonWith('Sign in'), 'Sign in');
        expect(host.textContent).toContain(pseudoLocalise('On the computer, type {code}').replace('{code}', '42'));
        expect(host.textContent).toContain(pseudoLocalise("The computer opens {name}'s Settings only when these are typed there, within 30 seconds. If no computer in front of you is asking for them, do nothing: nobody gets in.").replace('{name}', 'Riverbend'));
        expect(clean()).toEqual([]);
    });

    it('an assistant asking to connect, and a screen lock missing', async () => {
        nav.params = { community: 'Riverbend' };
        signin.scan = { kind: 'ok', qr };
        signin.look = look({ name: 'Claude', sendsTo: 'api.example.com' });
        signin.outcome = { kind: 'no-device-lock' };
        await renderIn('xx', SettingsSigninScreen);
        await scan();
        expect(host.textContent).toContain(pseudoLocalise('Sends what it reads to: {host}').replace('{host}', 'api.example.com'));
        expect(clean()).toEqual([]);
        await click(buttonWith('Connect'), 'Connect');
        expect(alerts.said).toEqual(expect.arrayContaining([pseudoLocalise('Set a screen lock first'), pseudoLocalise(NO_DEVICE_LOCK_MESSAGE)]));
        expect(clean()).toEqual([]);
    });
});

describe('taking over or restoring with this phone, in the pseudo-locale', () => {
    const look = (over: Record<string, unknown> = {}) => ({
        kind: 'ok', host: 'standby.riverbend.example', sameCommunity: true,
        check: { header: { communityId: 'abcdef1234567890', createdAt: '2026-10-03T09:05:00.000Z' }, signer: 'community' },
        described: { purpose: 'takeover', takeover: { mainServerAnswers: true } },
        ...over,
    });

    it('a take-over opened from a link: the warnings, the lines, Unlock; then a refusal', async () => {
        nav.params = { community: 'Riverbend' };
        unlock.fromLink = 'beanpool://unlock-keys?u=x';
        unlock.scan = { kind: 'ok', qr: {} };
        unlock.look = look();
        unlock.outcome = { kind: 'refused', message: "This phone's key did not open its part of the lock. Try another owner, or the recovery code." };
        await renderIn('xx', UnlockKeysScreen);
        expect(host.querySelector('[role="heading"]')?.textContent).toBe(pseudoLocalise('Take over {name} on {host}?').replace('{name}', 'Riverbend').replace('{host}', 'standby.riverbend.example'));
        expect(clean(), 'the take-over').toEqual([]);
        expect(unfit(host, 320 - 40 - 24, WRITTEN)).toEqual([]);
        await click(buttonWith('Unlock for the take-over'), 'Unlock');
        expect(alerts.said).toContain(pseudoLocalise("This phone's key did not open its part of the lock. Try another owner, or the recovery code."));
        expect(clean()).toEqual([]);
    });

    it('a restore from another machine\'s backup, of another community, by scanning; then Unlocked', async () => {
        unlock.scan = { kind: 'ok', qr: {} };
        unlock.look = look({
            sameCommunity: false, check: { header: { communityId: 'abcdef1234567890', createdAt: 'not a date' }, signer: 'other' },
            described: { purpose: 'restore', restore: { databaseOnly: true, backup: { createdAt: '2026-10-01T12:00:00.000Z' } } },
        });
        unlock.outcome = { kind: 'unlocked', purpose: 'restore' };
        await renderIn('xx', UnlockKeysScreen);
        expect(clean()).toEqual([]);
        await scan();
        expect(host.textContent).toContain(pseudoLocalise('Community: community {id}').replace('{id}', 'abcdef12'));
        // A lock date the server sent that isn't a date is shown as it came, inside the sentence.
        expect(host.textContent).toContain('not a date');
        expect(clean(), 'the restore').toEqual([]);
        await click(buttonWith('Unlock the backup'), 'Unlock');
        expect(host.textContent).toContain(pseudoLocalise('{host} is restoring the backup and will restart by itself.').replace('{host}', 'standby.riverbend.example'));
        expect(clean()).toEqual([]);
    });

    it('no camera: the screen says why it needs one', async () => {
        camera.granted = false;
        await renderIn('xx', UnlockKeysScreen);
        expect(host.textContent).toContain(pseudoLocalise('📷 Camera needed'));
        expect(clean()).toEqual([]);
    });
});

describe('linking a device, in the pseudo-locale', () => {
    it('a code from a server this phone doesn\'t use: refused first, nothing sent', async () => {
        pair.target = { kind: 'foreign', scannedHost: 'standby.riverbend.example', appHost: 'mullum.example' };
        await renderIn('xx', PairDeviceScreen);
        expect(clean()).toEqual([]);
        await scan('pairing');
        expect(host.textContent).toContain(pseudoLocalise('Send your whole account to another device?'));
        expect(clean()).toEqual([]);
        expect(unfit(host, 320 - 48, WRITTEN)).toEqual([]);
    });

    it('a code it may send to, with no screen lock: the refusal and the sheet\'s labels', async () => {
        pair.target = { kind: 'ok', nodeUrl: 'https://mullum.example' };
        pair.unlocked = 'no-device-lock';
        await renderIn('xx', PairDeviceScreen);
        await scan('pairing');
        expect(host.textContent).toContain(pseudoLocalise('Public Key'));
        await click(buttonWith('Confirm & Link Device'), 'Confirm');
        expect(host.textContent).toContain(pseudoLocalise("Your phone has no screen lock, so BeanPool will not send your account. Set a PIN, pattern or password in your phone's Settings, under Security, then try again."));
        expect(clean()).toEqual([]);
    });

    it('no camera yet', async () => {
        camera.granted = false;
        await renderIn('xx', PairDeviceScreen);
        expect(host.textContent).toContain(pseudoLocalise('📷 Camera Permission Needed'));
        expect(clean()).toEqual([]);
    });
});
