import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { appLockNow, clockReadFailures } from './app-lock-clock';

const APP_LOCK_KEY = 'beanpool_app_lock_enabled';
const isWeb = Platform.OS === 'web';

export type ScreenLock = 'none' | 'set' | 'unknown';

/**
 * What the phone has to ask with: 'set' for any screen lock (a PIN, pattern, password or passcode, with or without a
 * fingerprint or face), 'none' for no screen lock at all, 'unknown' when the phone can't say.
 *
 * From getEnrolledLevelAsync, which counts the screen lock (Android: KeyguardManager#isDeviceSecure; iOS: the
 * deviceOwnerAuthentication policy). hasHardwareAsync and isEnrolledAsync below answer for a fingerprint or face only.
 * The web build has none (the module's web stub answers NONE).
 */
export async function getScreenLock(): Promise<ScreenLock> {
    try {
        const level = await LocalAuthentication.getEnrolledLevelAsync();
        return level === LocalAuthentication.SecurityLevel.NONE ? 'none' : 'set';
    } catch {
        return 'unknown';
    }
}

/**
 * Whether the phone has a fingerprint or face sensor. Not a screen lock check: see getScreenLock.
 */
export async function hasLocalAuthHardware(): Promise<boolean> {
    try {
        return await LocalAuthentication.hasHardwareAsync();
    } catch {
        return false;
    }
}

/**
 * Whether a fingerprint or face is enrolled. A phone with only a PIN, pattern or passcode answers false: see
 * getScreenLock.
 */
export async function isLocalAuthEnrolled(): Promise<boolean> {
    try {
        return await LocalAuthentication.isEnrolledAsync();
    } catch {
        return false;
    }
}

/**
 * True only when the phone says it has no screen lock at all: no PIN, pattern, password, fingerprint or face
 * (getEnrolledLevelAsync is NONE; isEnrolledAsync above answers for fingerprints and faces only). A phone that can't
 * say, or the web, answers false. For one plain line under the 12 words (words-on-screen.ts), never for a gate.
 */
export async function phoneHasNoScreenLock(): Promise<boolean> {
    if (isWeb) return false;
    try {
        return (await LocalAuthentication.getEnrolledLevelAsync()) === LocalAuthentication.SecurityLevel.NONE;
    } catch {
        return false;
    }
}

/**
 * Authenticates the user using biometric authentication (Face ID / Touch ID)
 * with a fallback to the device passcode, PIN, or pattern.
 *
 * The phone's lock, before a step that shows or moves the account (the 12 words, pairing a computer, linking a sign-in,
 * taking the account off the phone) and before App Lock is turned on or off. App Lock's own unlock asks
 * authenticateForAppLock.
 *
 * Whatever screen lock the phone has is asked, through its own prompt: a fingerprint or face where one is enrolled,
 * its PIN, pattern or passcode otherwise (disableDeviceFallback: false). Biometrics stay at the default WEAK: Android
 * can't offer the PIN beside STRONG on Android 9 and 10. A phone with a PIN but no fingerprint or face used to pass
 * here unasked, as if it had no lock.
 *
 * True when the prompt passes in time (doorPassCounts), or when there is nothing to ask with: no screen lock at all, so
 * a member is never locked out by their phone. A phone that can't say what lock it has keeps the rule from before this
 * check read the screen lock: asked only with a fingerprint or face enrolled. A prompt that fails, is cancelled or throws
 * gives false, and so does a pass that reached the app too late to be one given for this request (a pass the phone held
 * while the app was away): every caller then does nothing, and the member asks again.
 */
export async function authenticateUser(reason: string): Promise<boolean> {
    return askPhoneLock(reason, true);
}

/**
 * authenticateUser for App Lock's unlock only (return-lock.ts unlockWithPhoneLock: the launch lock, Unlock App and the
 * return lock's own prompt): the same prompt and the same rule for a phone with no lock, but a late pass is the return
 * lock's to judge (returnLockAction, unlockWithPhoneLock), as #1311 settled it. That pass shows only the app, over which
 * the lock screen comes back after 15 seconds or more away; a door's shows or hands off the account.
 */
export async function authenticateForAppLock(reason: string): Promise<boolean> {
    return askPhoneLock(reason, false);
}

async function askPhoneLock(reason: string, door: boolean): Promise<boolean> {
    const lock = await getScreenLock();
    if (lock === 'none') return true;
    if (lock === 'unknown' && !((await hasLocalAuthHardware()) && (await isLocalAuthEnrolled()))) return true;
    if (!door) appLockPromptOpened();
    try {
        const passCounts = door ? timeDoorPrompt() : () => true;
        const res = await phoneLockPrompt({
            promptMessage: reason,
            fallbackLabel: 'Use Passcode',
            disableDeviceFallback: false,
        }, door ? 'door' : 'app-lock');

        return res.success && passCounts();
    } catch (e) {
        console.warn('Local authentication error:', e);
        return false;
    } finally {
        if (!door) appLockPromptClosed();
    }
}

/**
 * App Lock's own unlock prompt (authenticateForAppLock: the launch lock, Unlock App and the return lock's prompt), as
 * apart from a door's. It takes the app out of the front while it is open (iOS's Face ID and passcode make it inactive,
 * Android 8-10's PIN screen backgrounds it), and the full-screen "Update required" (utils/force-update.ts) must not take
 * that for the member leaving: it comes at the very moments the update screen waits for, a cold start and a return. A
 * door's prompt is the member in the middle of something (their words, a payment), so it is not counted here but in
 * doorPrompts below, as a leave: the update screen never lands on it.
 */
let openAppLockPrompts = 0;
let appLockCloseWaiters: Array<() => void> = [];

function appLockPromptOpened(): void {
    openAppLockPrompts++;
}

function appLockPromptClosed(): void {
    if (--openAppLockPrompts > 0) return;
    openAppLockPrompts = 0;
    const waiters = appLockCloseWaiters;
    appLockCloseWaiters = [];
    waiters.forEach(resolve => resolve());
}

/** Whether App Lock's own unlock prompt is open now (from just before the phone's prompt opens until its answer). */
export function isAppLockPromptOpen(): boolean {
    return openAppLockPrompts > 0;
}

/** Resolves when no App Lock prompt is open: at once if none is. */
export function whenAppLockPromptsClose(): Promise<void> {
    if (openAppLockPrompts === 0) return Promise.resolve();
    return new Promise(resolve => appLockCloseWaiters.push(resolve));
}

/**
 * The phone's lock prompts opened for anything but App Lock's unlock: a door's (the 12 words, a payment, pairing a
 * computer, Manage community, leaving), so far on this run, and whether one is open now.
 *
 * For the full-screen "Update required" (utils/force-update.ts), which must never land on what the member started. On
 * iOS and on Android 8-10's PIN screen a prompt takes the app out of the front, and the update screen counts that as the
 * member leaving. On Android 11 and later (and with a fingerprint on 8-10) it doesn't: expo-local-authentication asks
 * through androidx BiometricPrompt, a system window over the app, so the app is never paused and AppState never changes
 * (#1415's third deciding review). So the update screen counts these instead, whatever AppState did: a door's prompt
 * opened since its safe moment, or open now, is a leave. App Lock's own prompt is not one (isAppLockPromptOpen above).
 */
let doorPromptsSoFar = 0;
let openDoorPrompts = 0;

export function doorPrompts(): { opened: number; open: boolean } {
    return { opened: doorPromptsSoFar, open: openDoorPrompts > 0 };
}

/**
 * The phone's own lock prompt, the one way the app opens it: authenticateAsync, with the prompt marker below around it so
 * the return lock knows the time it was open is not time away. authenticateUser and node-admin's requireDeviceUnlock
 * (Manage community, sign in on a computer, take over with this phone) both ask through here, each with its own rule for
 * a phone with no lock, and both act only on a pass that reached the app in time (timeDoorPrompt). Answers and throws what
 * authenticateAsync does; the marker closes either way.
 *
 * `kind`: 'app-lock' for App Lock's own unlock (authenticateForAppLock) only. Every other prompt is a door's and is
 * counted in doorPrompts: the default, so that no new caller is missed.
 */
export async function phoneLockPrompt(
    options: LocalAuthentication.LocalAuthenticationOptions,
    kind: 'door' | 'app-lock' = 'door',
): Promise<LocalAuthentication.LocalAuthenticationResult> {
    promptOpened();
    const door = kind !== 'app-lock';
    if (door) {
        doorPromptsSoFar++;
        openDoorPrompts++;
    }
    let passed = false;
    try {
        const res = await LocalAuthentication.authenticateAsync(options);
        passed = res.success === true;
        return res;
    } finally {
        promptClosed(passed);
        if (door) openDoorPrompts = Math.max(0, openDoorPrompts - 1);
    }
}

/**
 * How long after it opened a prompt's pass can still count. A prompt's answer reaches the app when the phone hands it
 * over, not when the member gave it: Android 8-10 holds the PIN screen's result until BeanPool is back in front, so a
 * member who passes it and presses home during the moment it closes leaves a pass that arrives whenever BeanPool is next
 * opened, an hour later, by whoever has the phone. The app can't tell that pass from one given just now.
 *
 * Two minutes: long enough for the slowest prompts a member gives. Android's lock (AOSP gatekeeper, ComputeRetryTimeout)
 * makes the 5th and the 10th wrong PIN in a row wait 30 seconds each, so ten tries with both waits come to about a minute
 * and a half; iOS's first passcode wait, after the 4th wrong one, is a minute (Apple Platform Security; the 5th brings
 * five). A prompt longer than that is asked once more after it passes: one more prompt, never a way in.
 *
 * Two readers:
 * - The doors (authenticateUser, node-admin's requireDeviceUnlock): a pass that reaches the app more than this long after
 *   its prompt opened opens nothing (doorPassCounts).
 * - App Lock's return lock (utils/return-lock.ts, returnLockAction): one prompt that passed covers only the time away
 *   within this long of the prompt opening, and the rest counts as away. The cover counts from the opening, not from the
 *   leave, so the part of a prompt before the leave (an earlier absence or return included) uses it up first. Such a pass
 *   opens the app only for whoever opens it within two minutes and 15 seconds of the prompt opening
 *   (RETURN_LOCK_GRACE_MS on top). A prompt that did not pass covers the whole time it was open: it opens nothing, and
 *   the app stays behind the lock screen ('lock').
 */
export const PROMPT_COVER_MAX_MS = 120000;

/**
 * Whether a door's pass counts: it reached the app (answeredAt) no more than PROMPT_COVER_MAX_MS after its prompt opened
 * (openedAt), both on App Lock's clock, and that clock could be read in between (clockUntrusted false: see timeDoorPrompt).
 * A door acts only on a pass given for this request while the member was there, and the app can tell a pass the phone
 * held while it was away from one given just now only by how late it came.
 *
 * All the time from the prompt opening to its answer is the prompt's: the prompt takes the app out of the front itself
 * (Android 8-10's PIN screen backgrounds it, iOS's passcode prompt makes it inactive), so a member who left while it was
 * open looks the same as one who took long over it. The return lock counts such time as the prompt's for up to
 * PROMPT_COVER_MAX_MS, so no time away inside it reaches its 15 seconds before this refuses; and a door refuses a pass
 * later than that however the app came and went, App Lock on or off.
 *
 * Times that aren't finite, or an answer that reads earlier than the opening, can't say how late the pass came: it
 * doesn't count.
 */
export function doorPassCounts(openedAt: number, answeredAt: number, clockUntrusted = false): boolean {
    const took = answeredAt - openedAt;
    // NaN fails every comparison: a time that isn't one never counts.
    return !clockUntrusted && took >= 0 && took <= PROMPT_COVER_MAX_MS;
}

/**
 * A door's watch on its own prompt, started just before the prompt opens: the function it returns, called once the
 * prompt's pass has reached the app, says whether that pass counts (doorPassCounts). The clock is App Lock's: the phone's
 * since-boot clock (utils/app-lock-clock.ts), which setting the phone's date and time can't move, so the prompt is timed
 * the same whatever the wall clock did meanwhile. A reading that failed at either end or in between, as the return lock
 * has it, leaves the time untold: a phone app built before the since-boot clock's module refuses every door's pass until
 * it is rebuilt with it, as its App Lock asks after every leave.
 */
export function timeDoorPrompt(): () => boolean {
    const openedAt = appLockNow();
    const failures = clockReadFailures();
    return () => {
        const answeredAt = appLockNow();
        return doorPassCounts(openedAt, answeredAt, clockReadFailures() !== failures);
    };
}

/**
 * A stretch of time the phone's own lock prompt was open: from the first phoneLockPrompt opening to the last one closing,
 * with passed true when the one that closed it passed. Overlapping calls make one stretch. expo-local-authentication
 * 55.0.18 answers a second call while one is open with app_cancel at once, so the first closes it; 55.0.15 answers the
 * first with app_cancel and the second takes over the prompt and closes it. Either way the closing answer is the one the
 * member gave last; an earlier pass inside the stretch doesn't count, and a stretch still open has not passed.
 *
 * The prompt takes the app out of the front while it is open: Android 8-10's PIN screen backgrounds it, iOS's makes it
 * inactive. The return lock (utils/return-lock.ts) reads these so that time is not counted as the member being away.
 * openedAt and closedAt are on App Lock's clock (utils/app-lock-clock.ts), as the return lock's own times are: the phone's
 * since-boot clock, which setting the phone's date and time can't move. NaN where a phone couldn't read it: such a stretch
 * covers none of the time away.
 */
export type LocalAuthPromptStretch = { openedAt: number; closedAt: number | null; passed: boolean };

/** Kept to the last few: the return lock only looks at the ones since the app last left the front. */
const PROMPT_STRETCHES_KEPT = 16;
let openPrompts = 0;
const promptStretches: LocalAuthPromptStretch[] = [];
let promptCloseWaiters: Array<() => void> = [];

function promptOpened(): void {
    if (openPrompts++ === 0) {
        promptStretches.push({ openedAt: appLockNow(), closedAt: null, passed: false });
        if (promptStretches.length > PROMPT_STRETCHES_KEPT) promptStretches.shift();
    }
}

function promptClosed(passed: boolean): void {
    if (--openPrompts > 0) return;
    openPrompts = 0;
    const current = promptStretches[promptStretches.length - 1];
    if (current) {
        current.closedAt = appLockNow();
        current.passed = passed;
    }
    const waiters = promptCloseWaiters;
    promptCloseWaiters = [];
    waiters.forEach(resolve => resolve());
}

/** Whether one of phoneLockPrompt's prompts is open now. */
export function isLocalAuthPromptOpen(): boolean {
    return openPrompts > 0;
}

/** The prompt stretches, oldest first; the last one has closedAt null while a prompt is open. Copies. */
export function localAuthPromptStretches(): LocalAuthPromptStretch[] {
    return promptStretches.map(s => ({ ...s }));
}

/** Resolves when no prompt is open: at once if none is. */
export function whenLocalAuthPromptsClose(): Promise<void> {
    if (openPrompts === 0) return Promise.resolve();
    return new Promise(resolve => promptCloseWaiters.push(resolve));
}

/** App Lock's setting as last read or saved on this run (appLockLocks, getAppLockEnabled, setAppLockEnabled): null before. */
let appLockLastKnown: boolean | null = null;

/** App Lock's setting as stored: true for on. Throws when it can't be read. */
async function readAppLockSetting(): Promise<boolean> {
    const val = isWeb ? localStorage.getItem(APP_LOCK_KEY) : await SecureStore.getItemAsync(APP_LOCK_KEY);
    if (val !== null) {
        return val === 'true';
    }

    // Fallback / auto-migrate legacy preference stored in AsyncStorage. A move that fails keeps the value it read: it is
    // the setting, wherever it is kept.
    const legacyVal = await AsyncStorage.getItem(APP_LOCK_KEY);
    if (legacyVal === null) return false;
    try {
        if (isWeb) {
            localStorage.setItem(APP_LOCK_KEY, legacyVal);
        } else {
            await SecureStore.setItemAsync(APP_LOCK_KEY, legacyVal);
        }
        await AsyncStorage.removeItem(APP_LOCK_KEY).catch(() => {});
    } catch (e) {
        console.warn('[AppLock] The setting could not be moved to secure storage', e);
    }
    return legacyVal === 'true';
}

/**
 * Whether App Lock is on, for Settings' switch: false when the setting can't be read. The launch lock and the return
 * lock ask {@link appLockLocks} instead.
 */
export async function getAppLockEnabled(): Promise<boolean> {
    try {
        return (appLockLastKnown = await readAppLockSetting());
    } catch {
        return false;
    }
}

/**
 * Whether App Lock locks the app: its setting is on, or can't be read. Asked by the launch lock (app/_layout.tsx) and the
 * return lock (return-lock.ts). A setting that couldn't be read used to read as off, so a keychain that was briefly
 * unavailable (seen after a restart on some phones) opened the app unlocked for that launch, with no message
 * (FABLE-sec-native LOW-2, 2026-10-01). Locking then never locks anyone out: Unlock App asks the phone's own lock, and a
 * phone with no screen lock passes it unasked (authenticateForAppLock).
 */
export async function appLockLocks(): Promise<boolean> {
    try {
        return (appLockLastKnown = await readAppLockSetting());
    } catch {
        return (appLockLastKnown = true);
    }
}

/**
 * Whether App Lock locked (or its setting couldn't be read) when it was last read or saved on this run, without reading
 * it again: for the moment the app leaves the front, which can't wait for a read (return-lock.ts's cover). False before
 * the first read, which the launch lock makes as the app opens.
 */
export function appLockWasOn(): boolean {
    return appLockLastKnown === true;
}

/**
 * Enable or disable app launch security lock.
 */
export async function setAppLockEnabled(enabled: boolean): Promise<void> {
    try {
        const strVal = enabled ? 'true' : 'false';
        if (isWeb) {
            localStorage.setItem(APP_LOCK_KEY, strVal);
        } else {
            await SecureStore.setItemAsync(APP_LOCK_KEY, strVal);
        }
        appLockLastKnown = enabled;
        await AsyncStorage.removeItem(APP_LOCK_KEY).catch(() => {});
    } catch (e) {
        console.error('Failed to save app lock preference:', e);
    }
}

/** Set once App Lock has been turned on (or found on) for a role holder, so that turning it off afterwards sticks. */
const APP_LOCK_ROLE_DEFAULT_KEY = 'beanpool_app_lock_role_default';

export type RoleAppLockResult = 'turned-on' | 'already-on' | 'left-off' | 'no-screen-lock' | 'failed';

/**
 * App Lock on by default for anyone holding a role on their community: owner, admin or moderator (decision D3,
 * 2026-10-03). Key sign-ins no longer ask for the node's 6-digit code (D2): the phone's own lock is a role holder's
 * second factor, and App Lock puts it in front of the app as well as in front of Manage. Once only: whoever turns it
 * off afterwards keeps it off ('left-off'). A phone with no screen lock, or one that can't say, is left alone (App Lock
 * would ask nothing) and is turned on at a later call once it has one. Never a gate, and never a false 'turned-on': a
 * setting that can't be saved answers 'failed' and leaves the once-only mark unset.
 */
export async function turnAppLockOnForRole(): Promise<RoleAppLockResult> {
    try {
        const done = isWeb ? localStorage.getItem(APP_LOCK_ROLE_DEFAULT_KEY) : await SecureStore.getItemAsync(APP_LOCK_ROLE_DEFAULT_KEY);
        const on = await readAppLockSetting();
        const markDone = () => isWeb
            ? Promise.resolve(localStorage.setItem(APP_LOCK_ROLE_DEFAULT_KEY, 'true'))
            : SecureStore.setItemAsync(APP_LOCK_ROLE_DEFAULT_KEY, 'true');
        if (on) {
            if (done !== 'true') await markDone();
            return 'already-on';
        }
        if (done === 'true') return 'left-off';
        const level = await LocalAuthentication.getEnrolledLevelAsync();
        if (level === LocalAuthentication.SecurityLevel.NONE) return 'no-screen-lock';
        if (isWeb) {
            localStorage.setItem(APP_LOCK_KEY, 'true');
        } else {
            await SecureStore.setItemAsync(APP_LOCK_KEY, 'true');
        }
        appLockLastKnown = true;
        await markDone();
        return 'turned-on';
    } catch {
        return 'failed';
    }
}

/** What the app says when {@link turnAppLockOnForRole} turned App Lock on. */
export const APP_LOCK_ON_FOR_ROLE = (communityName: string) =>
    `App Lock is on. You help run ${communityName}, so BeanPool now asks for your phone's own lock (fingerprint, face or PIN) when it ` +
    'opens. Your phone\'s lock is what keeps your role safe if someone else picks it up. You can turn it off in ' +
    'Settings → App Lock.';

/** Settings' App Lock, turned on on a phone with no screen lock: it would ask nothing, so it stays off and says why. */
export const APP_LOCK_NEEDS_SCREEN_LOCK =
    "App Lock asks for your phone's own screen lock (a PIN, pattern, password, fingerprint or face) when BeanPool " +
    "opens. This phone has no screen lock set, so there is nothing for it to ask. Set one in your phone's settings, " +
    'then turn App Lock on.';
