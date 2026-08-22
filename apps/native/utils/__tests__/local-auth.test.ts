import { describe, it, expect, vi, beforeEach } from 'vitest';

(globalThis as any).__DEV__ = true;

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-local-authentication', () => ({
    hasHardwareAsync: vi.fn(),
    isEnrolledAsync: vi.fn(),
    authenticateAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn().mockResolvedValue(null),
        setItem: vi.fn().mockResolvedValue(undefined),
        removeItem: vi.fn().mockResolvedValue(undefined),
    },
}));

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAppLockEnabled, setAppLockEnabled } from '../LocalAuth';

describe('LocalAuth - getAppLockEnabled & setAppLockEnabled', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns true when SecureStore has "true"', async () => {
        vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce('true');
        const enabled = await getAppLockEnabled();
        expect(enabled).toBe(true);
        expect(SecureStore.getItemAsync).toHaveBeenCalledWith('beanpool_app_lock_enabled');
    });

    it('returns false when SecureStore has "false"', async () => {
        vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce('false');
        const enabled = await getAppLockEnabled();
        expect(enabled).toBe(false);
    });

    it('migrates from legacy AsyncStorage if SecureStore is empty', async () => {
        vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null);
        vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce('true');

        const enabled = await getAppLockEnabled();

        expect(enabled).toBe(true);
        expect(SecureStore.setItemAsync).toHaveBeenCalledWith('beanpool_app_lock_enabled', 'true');
        expect(AsyncStorage.removeItem).toHaveBeenCalledWith('beanpool_app_lock_enabled');
    });

    it('saves setting to SecureStore in setAppLockEnabled', async () => {
        await setAppLockEnabled(true);
        expect(SecureStore.setItemAsync).toHaveBeenCalledWith('beanpool_app_lock_enabled', 'true');
        expect(AsyncStorage.removeItem).toHaveBeenCalledWith('beanpool_app_lock_enabled');
    });
});
