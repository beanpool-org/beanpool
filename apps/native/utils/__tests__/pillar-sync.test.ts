import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { performSync } from '../../services/pillar-sync';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
    },
}));

vi.mock('../db', () => ({
    applyDelta: vi.fn().mockResolvedValue(undefined),
    fetchFriendsFromServer: vi.fn().mockResolvedValue([]),
    getDb: vi.fn().mockResolvedValue({
        getFirstAsync: vi.fn().mockResolvedValue({ count: 0 }),
    }),
}));

vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn().mockReturnValue('test.db'),
}));

vi.mock('expo-constants', () => ({
    default: {
        experienceUrl: undefined,
        expoConfig: undefined,
    },
}));

describe('discoverAnchor() via performSync()', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        vi.clearAllMocks();
        // Default AsyncStorage behavior
        vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);
        vi.mocked(AsyncStorage.setItem).mockResolvedValue(undefined);
        vi.mocked(AsyncStorage.removeItem).mockResolvedValue(undefined);
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('uses saved anchor URL if present in AsyncStorage', async () => {
        vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => {
            if (key === 'beanpool_anchor_url') return 'https://saved.beanpool.org';
            return null;
        });

        const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
            if (url.startsWith('https://saved.beanpool.org/api/marketplace/posts')) {
                return { ok: true, text: async () => '[]' };
            }
            return { ok: false, status: 404 };
        });
        global.fetch = fetchSpy as any;

        const result = await performSync();
        expect(result.success).toBe(true);
        // Ensure no health checks were executed because saved anchor exists
        const healthCalls = fetchSpy.mock.calls.filter(([url]) => url.includes('/api/community/health'));
        expect(healthCalls.length).toBe(0);
    });

    it('probes candidate URLs concurrently and picks the first successful one', async () => {
        // Set __DEV__ global if needed
        (globalThis as any).__DEV__ = true;

        const probedUrls: string[] = [];
        const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('/api/community/health')) {
                probedUrls.push(url);
                if (url.startsWith('http://localhost:8080')) {
                    return { ok: true, status: 200 };
                }
                return { ok: false, status: 500 };
            }
            if (url.includes('/api/marketplace/posts')) {
                return { ok: true, text: async () => '[]' };
            }
            return { ok: false, status: 404 };
        });
        global.fetch = fetchSpy as any;

        const result = await performSync();
        expect(result.success).toBe(true);
        expect(AsyncStorage.setItem).toHaveBeenCalledWith('beanpool_anchor_url', 'http://localhost:8080');
        // Multiple candidate URLs should have been probed concurrently
        expect(probedUrls.length).toBeGreaterThan(1);
    });

    it('returns error when all candidate URLs fail health check', async () => {
        (globalThis as any).__DEV__ = true;

        const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('/api/community/health')) {
                throw new Error('Connection refused');
            }
            return { ok: false, status: 500 };
        });
        global.fetch = fetchSpy as any;

        const result = await performSync();
        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe('All node URLs failed the health check connection.');
    });
});
