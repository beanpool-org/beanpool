import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

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
 * The phone's lock, before a step that shows or moves the account (the 12 words, pairing a computer, linking a sign-in,
 * taking the account off the phone) and for App Lock.
 *
 * Whatever screen lock the phone has is asked, through its own prompt: a fingerprint or face where one is enrolled,
 * its PIN, pattern or passcode otherwise (disableDeviceFallback: false). Biometrics stay at the default WEAK: Android
 * can't offer the PIN beside STRONG on Android 9 and 10. A phone with a PIN but no fingerprint or face used to pass
 * here unasked, as if it had no lock.
 *
 * True when the prompt passes, or when there is nothing to ask with: no screen lock at all, so a member is never
 * locked out by their phone. A phone that can't say what lock it has keeps the rule from before this check read the
 * screen lock: asked only with a fingerprint or face enrolled. A prompt that fails, is cancelled or throws gives false:
 * every caller then does nothing, and the launch lock keeps its Unlock App button to ask again.
 */
export async function authenticateUser(reason: string): Promise<boolean> {
    const lock = await getScreenLock();
    if (lock === 'none') return true;
    if (lock === 'unknown' && !((await hasLocalAuthHardware()) && (await isLocalAuthEnrolled()))) return true;
    try {
        const res = await LocalAuthentication.authenticateAsync({
            promptMessage: reason,
            fallbackLabel: 'Use Passcode',
            disableDeviceFallback: false,
        });

        return res.success;
    } catch (e) {
        console.warn('Local authentication error:', e);
        return false;
    }
}

/**
 * Check if app launch security lock is enabled.
 */
export async function getAppLockEnabled(): Promise<boolean> {
    try {
        let val: string | null = null;
        if (isWeb) {
            val = localStorage.getItem(APP_LOCK_KEY);
        } else {
            val = await SecureStore.getItemAsync(APP_LOCK_KEY);
        }
        if (val !== null) {
            return val === 'true';
        }

        // Fallback / auto-migrate legacy preference stored in AsyncStorage
        const legacyVal = await AsyncStorage.getItem(APP_LOCK_KEY);
        if (legacyVal !== null) {
            if (isWeb) {
                localStorage.setItem(APP_LOCK_KEY, legacyVal);
            } else {
                await SecureStore.setItemAsync(APP_LOCK_KEY, legacyVal);
            }
            await AsyncStorage.removeItem(APP_LOCK_KEY).catch(() => {});
            return legacyVal === 'true';
        }
        return false;
    } catch {
        return false;
    }
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
        await AsyncStorage.removeItem(APP_LOCK_KEY).catch(() => {});
    } catch (e) {
        console.error('Failed to save app lock preference:', e);
    }
}

/** Settings' App Lock, turned on on a phone with no screen lock: it would ask nothing, so it stays off and says why. */
export const APP_LOCK_NEEDS_SCREEN_LOCK =
    "App Lock asks for your phone's own screen lock (a PIN, pattern, password, fingerprint or face) when BeanPool " +
    "opens. This phone has no screen lock set, so there is nothing for it to ask. Set one in your phone's settings, " +
    'then turn App Lock on.';
