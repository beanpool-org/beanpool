/**
 * App Lock on by default for anyone holding a role on their community (owner, admin, moderator; decision D3,
 * 2026-10-03). Since key sign-ins stopped asking for the node's 6-digit code (D2), the phone's own lock is a role
 * holder's second factor; App Lock puts it in front of the app too. Once only: a role holder who then turns App Lock
 * off keeps it off. A phone with no screen lock is left alone (App Lock would ask nothing) and is turned on once it has
 * one. Never a gate: a storage error turns nothing on and blocks nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

(globalThis as any).__DEV__ = true;

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(),
    hasHardwareAsync: vi.fn(),
    isEnrolledAsync: vi.fn(),
    authenticateAsync: vi.fn(),
}));

const store = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: vi.fn(async (k: string) => { store.delete(k); }),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn().mockResolvedValue(null),
        setItem: vi.fn().mockResolvedValue(undefined),
        removeItem: vi.fn().mockResolvedValue(undefined),
    },
}));

import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { appLockLocks, getAppLockEnabled, setAppLockEnabled, turnAppLockOnForRole, APP_LOCK_ON_FOR_ROLE } from '../LocalAuth';

const PIN = LocalAuthentication.SecurityLevel.SECRET;
const NONE = LocalAuthentication.SecurityLevel.NONE;

describe('turnAppLockOnForRole', () => {
    beforeEach(() => {
        store.clear();
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockReset().mockResolvedValue(PIN);
        vi.mocked(SecureStore.setItemAsync).mockClear();
    });

    it('turns App Lock on for a role holder whose phone has a screen lock, and says so', async () => {
        expect(await getAppLockEnabled()).toBe(false);
        expect(await turnAppLockOnForRole()).toBe('turned-on');
        expect(await getAppLockEnabled()).toBe(true);
        expect(await appLockLocks()).toBe(true);
        expect(APP_LOCK_ON_FOR_ROLE('Mullum')).toMatch(/App Lock is on/);
        expect(APP_LOCK_ON_FOR_ROLE('Mullum')).toMatch(/Mullum/);
        expect(APP_LOCK_ON_FOR_ROLE('Mullum')).toMatch(/turn it off/i);
    });

    it('does it once: a role holder who turns App Lock off afterwards keeps it off', async () => {
        expect(await turnAppLockOnForRole()).toBe('turned-on');
        await setAppLockEnabled(false);
        expect(await turnAppLockOnForRole()).toBe('left-off');
        expect(await getAppLockEnabled()).toBe(false);
    });

    it('leaves App Lock that is already on as it is, and never turns it on again after it is turned off', async () => {
        await setAppLockEnabled(true);
        expect(await turnAppLockOnForRole()).toBe('already-on');
        await setAppLockEnabled(false);
        expect(await turnAppLockOnForRole()).toBe('left-off');
        expect(await getAppLockEnabled()).toBe(false);
    });

    it('a phone with no screen lock is left alone, and turned on once it has one', async () => {
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValue(NONE);
        expect(await turnAppLockOnForRole()).toBe('no-screen-lock');
        expect(await getAppLockEnabled()).toBe(false);
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValue(PIN);
        expect(await turnAppLockOnForRole()).toBe('turned-on');
        expect(await getAppLockEnabled()).toBe(true);
    });

    it('a phone that cannot say whether it has a lock is left alone', async () => {
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockRejectedValue(new Error('no keyguard'));
        expect(await turnAppLockOnForRole()).toBe('failed');
        expect(await getAppLockEnabled()).toBe(false);
    });

    it('a setting that cannot be saved claims nothing: no "turned on", and the once-only mark is not set', async () => {
        vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
        expect(await turnAppLockOnForRole()).toBe('failed');
        expect(await getAppLockEnabled()).toBe(false);
        expect(await turnAppLockOnForRole()).toBe('turned-on');
    });
});
