import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));

vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));

vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(),
    dismissAuthSession: vi.fn(),
}));

vi.mock('expo-linking', () => ({
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
}));

vi.mock('../node-post', () => ({
    anchorUrl: vi.fn(async () => 'https://test.beanpool.org'),
    signedPost: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

import * as SecureStore from 'expo-secure-store';
import {
    refreshTokenIfNeeded,
    PulseOAuthError,
    type PulseOAuthToken,
} from '../pulse-oauth';
import { anchorUrl } from '../node-post';

describe('pulse-oauth utility (native)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(anchorUrl).mockResolvedValue('https://test.beanpool.org');
    });

    const now = Date.now();
    const mockToken: PulseOAuthToken = {
        platform: 'tiktok',
        channelId: 'chan_123',
        accessToken: 'old_access_token',
        refreshToken: 'valid_refresh_token',
        expiresAt: now - 1000, // expired
        refreshExpiresAt: now + 30 * 86400 * 1000, // 30 days remaining
        platformUsername: 'alice_pottery',
    };

    describe('refreshTokenIfNeeded', () => {
        it('returns stored token untouched if still fresh (>10 min remaining)', async () => {
            const freshToken: PulseOAuthToken = {
                ...mockToken,
                expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour remaining
            };
            const result = await refreshTokenIfNeeded(freshToken);
            expect(result).toBe(freshToken);
        });

        it('throws expired error if no refresh token is stored', async () => {
            const noRefreshToken: PulseOAuthToken = {
                ...mockToken,
                refreshToken: undefined,
            };
            await expect(refreshTokenIfNeeded(noRefreshToken)).rejects.toThrow(
                'Token expired and no refresh token is stored.'
            );
        });

        it('throws expired error if refresh token itself has expired', async () => {
            const expiredRefresh: PulseOAuthToken = {
                ...mockToken,
                refreshExpiresAt: Date.now() - 1000,
            };
            await expect(refreshTokenIfNeeded(expiredRefresh)).rejects.toThrow(
                'Refresh token expired. Please reconnect.'
            );
        });

        it('throws provider error when refresh path is invoked without a client key and none on node', async () => {
            // Mock fetchPulseOAuthConfig returning no client key
            global.fetch = vi.fn().mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    tiktok: { enabled: false, clientKey: null },
                    instagram: { enabled: false, appId: null },
                }),
            });

            await expect(refreshTokenIfNeeded(mockToken)).rejects.toThrow(
                'Cannot refresh TikTok token without a client key.'
            );
        });

        it('successfully refreshes TikTok token when clientKey is explicitly provided', async () => {
            const mockFetch = vi.fn().mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: {
                        access_token: 'new_access_token',
                        refresh_token: 'new_refresh_token',
                        expires_in: 86400,
                        refresh_expires_in: 31536000,
                    },
                }),
            });
            global.fetch = mockFetch;

            const updated = await refreshTokenIfNeeded(mockToken, 'test_client_key_abc');

            expect(updated.accessToken).toBe('new_access_token');
            expect(updated.refreshToken).toBe('new_refresh_token');
            expect(mockFetch).toHaveBeenCalledWith(
                'https://open.tiktokapis.com/v2/oauth/token/',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: expect.stringContaining('client_key=test_client_key_abc'),
                })
            );
            expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
                'pulse_oauth_token_chan_123',
                expect.stringContaining('new_access_token')
            );
        });

        it('resolves clientKey from node config when omitted and nodeUrl is supplied', async () => {
            const mockFetch = vi.fn()
                // First call: fetchPulseOAuthConfig
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        tiktok: { enabled: true, clientKey: 'resolved_node_key_xyz' },
                    }),
                })
                // Second call: TikTok token refresh POST
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        data: {
                            access_token: 'auto_refreshed_token',
                            refresh_token: 'auto_refresh_refresh_token',
                            expires_in: 86400,
                            refresh_expires_in: 31536000,
                        },
                    }),
                });
            global.fetch = mockFetch;

            const updated = await refreshTokenIfNeeded(mockToken, null, 'https://test.beanpool.org');

            expect(updated.accessToken).toBe('auto_refreshed_token');
            expect(mockFetch).toHaveBeenNthCalledWith(
                2,
                'https://open.tiktokapis.com/v2/oauth/token/',
                expect.objectContaining({
                    body: expect.stringContaining('client_key=resolved_node_key_xyz'),
                })
            );
        });
    });
});
