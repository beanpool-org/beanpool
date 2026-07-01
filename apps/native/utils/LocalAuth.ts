import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';

const APP_LOCK_KEY = 'beanpool_app_lock_enabled';

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
        const val = await AsyncStorage.getItem(APP_LOCK_KEY);
        return val === 'true';
    } catch {
        return false;
    }
}

/**
 * Enable or disable app launch security lock.
 */
export async function setAppLockEnabled(enabled: boolean): Promise<void> {
    try {
        await AsyncStorage.setItem(APP_LOCK_KEY, enabled ? 'true' : 'false');
    } catch (e) {
        console.error('Failed to save app lock preference:', e);
    }
}
