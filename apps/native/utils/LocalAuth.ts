import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const APP_LOCK_KEY = 'beanpool_app_lock_enabled';
const isWeb = Platform.OS === 'web';

/**
 * Check if the device hardware supports local authentication.
 */
export async function hasLocalAuthHardware(): Promise<boolean> {
    try {
        return await LocalAuthentication.hasHardwareAsync();
    } catch {
        return false;
    }
}

/**
 * Check if the user has enrolled any biometrics or passcode/PIN on the device.
 */
export async function isLocalAuthEnrolled(): Promise<boolean> {
    try {
        return await LocalAuthentication.isEnrolledAsync();
    } catch {
        return false;
    }
}

/**
 * Authenticates the user using biometric authentication (Face ID / Touch ID)
 * with a fallback to the device passcode, PIN, or pattern.
 * 
 * Returns true if authentication succeeds or if the device has no local
 * security credentials enrolled (to prevent permanent lockouts).
 */
export async function authenticateUser(reason: string): Promise<boolean> {
    try {
        const hasHardware = await hasLocalAuthHardware();
        const isEnrolled = await isLocalAuthEnrolled();
        
        if (!hasHardware || !isEnrolled) {
            // Fail-open: If the device doesn't support local authentication or has
            // no security passcode set up, do not lock the user out.
            return true;
        }

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
