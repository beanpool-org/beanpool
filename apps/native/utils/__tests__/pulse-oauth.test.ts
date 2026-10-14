import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));

vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
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
                expect.stringContaining('new_access_token'),
                // This phone only (pulse-token-store.ts).
                { keychainAccessible: 6 }
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

    // The node asks the platform who a token belongs to (#1830): the phone names the channel and
    // never says who it is, makes no identity call of its own, and shows words for each refusal.
    describe('connect through the node (#1830)', () => {
        const mockIdentity: any = { publicKeyHex: 'alice_pubkey', secretKeyHex: 'alice_sec' };
        const mockChannel = { id: 'chan_123', handle: '@alice_pottery', url: 'https://www.tiktok.com/@alice_pottery' };
        const igChannel = { id: 'chan_ig', handle: '@alice_ig', url: 'https://www.instagram.com/alice_ig/' };
        const mockState = 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ';

        const nodeAnswers = (status: number, body: unknown) => async (_nodeUrl: string, path: string) => {
            if (path === '/api/member/pulse/oauth-exchange') {
                return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body } as any;
            }
            return { ok: true, status: 200, json: async () => ({ items: [] }), text: async () => '{}' } as any;
        };

        const signIn = async (platform: 'tiktok' | 'instagram') => {
            const { openAuthSessionAsync } = await import('expo-web-browser');
            vi.mocked(openAuthSessionAsync).mockResolvedValueOnce({
                type: 'success',
                url: `beanpool://auth/${platform}?code=test_auth_code&state=${mockState}`,
            } as any);
        };

        it('sends channelId with the exchange, no username, and calls no platform itself', async () => {
            const { connectTikTokChannel } = await import('../pulse-oauth');
            const { openAuthSessionAsync } = await import('expo-web-browser');
            const { signedPost } = await import('../node-post');
            await signIn('tiktok');
            vi.mocked(signedPost).mockImplementation(nodeAnswers(200, {
                data: { access_token: 'test_token', refresh_token: 'test_refresh', open_id: 'test_open_id', expires_in: 86400 },
                channel: { id: 'chan_123', oauthVerifiedAt: new Date().toISOString(), verifiedHandle: 'alice_pottery' },
                identity: { handle: 'alice_pottery' },
            }));
            const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { videos: [] } }) });
            global.fetch = mockFetch;
            const logged = vi.spyOn(console, 'log');

            const res = await connectTikTokChannel(mockChannel, mockIdentity, 'https://test.beanpool.org', 'test_client_key');

            expect(openAuthSessionAsync).toHaveBeenCalledWith(
                expect.stringContaining('scope=user.info.basic,user.info.profile,video.list'),
                'beanpool://auth/tiktok'
            );
            // Without disable_auto_auth=1 TikTok reuses an existing grant and returns a code
            // with no authorization page, so the creator never sees what they are granting.
            expect(openAuthSessionAsync).toHaveBeenCalledWith(expect.stringContaining('disable_auto_auth=1'), 'beanpool://auth/tiktok');

            const exchange = vi.mocked(signedPost).mock.calls.find(c => c[1] === '/api/member/pulse/oauth-exchange')!;
            expect(exchange[2]).toMatchObject({ platform: 'tiktok', grantType: 'authorization_code', code: 'test_auth_code', channelId: 'chan_123' });
            expect(exchange[2]).not.toHaveProperty('platformUsername');
            expect(exchange[2]).not.toHaveProperty('username');
            expect(vi.mocked(signedPost).mock.calls.some(c => String(c[1]).includes('verify-oauth'))).toBe(false);
            expect(mockFetch.mock.calls.some(c => String(c[0]).includes('/v2/user/info/'))).toBe(false);
            expect(logged.mock.calls.some(c => c.join(' ').includes('alice_pottery'))).toBe(false);

            expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
                'pulse_oauth_token_chan_123',
                expect.stringContaining('"platformUsername":"alice_pottery"'),
                { keychainAccessible: 6 }
            );
            expect(res.channel.id).toBe('chan_123');
        });

        it.each([
            [400, { error: 'account_mismatch', message: 'node words' }, 'account-mismatch', 'The TikTok account you signed in to is not @alice_pottery. Sign in to that account and connect again.'],
            [400, { error: 'not_verifiable', message: 'node words' }, 'not-verifiable', 'BeanPool can only verify a TikTok channel added as @handle. Remove this one and add it again as @handle.'],
            [502, { error: 'identity_unavailable', message: 'TikTok did not say which account this is. Connect again and allow BeanPool to read your profile.' }, 'provider', 'TikTok did not say which account this is. Connect again and allow BeanPool to read your profile.'],
            [400, { error: 'update_required', message: 'node words' }, 'provider', 'Update BeanPool to connect this channel.'],
            [429, { error: 'rate_limited', message: 'node words' }, 'provider', 'Too many connection attempts. Try again in an hour.'],
        ])('a %s %o refusal reads as %s with its own words, and no token is saved', async (status, body, reason, copy) => {
            const { connectTikTokChannel } = await import('../pulse-oauth');
            const { signedPost } = await import('../node-post');
            await signIn('tiktok');
            vi.mocked(signedPost).mockImplementation(nodeAnswers(status, body));
            global.fetch = vi.fn();

            const err = await connectTikTokChannel(mockChannel, mockIdentity, 'https://test.beanpool.org', 'test_client_key').catch(e => e);
            expect(err).toBeInstanceOf(PulseOAuthError);
            expect(err.reason).toBe(reason);
            expect(err.message).toBe(copy);
            expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
        });

        it('Instagram sends channelId, calls no /me itself, and has no display-name fallback', async () => {
            const { connectInstagramChannel } = await import('../pulse-oauth');
            const { signedPost } = await import('../node-post');
            await signIn('instagram');
            const hint = 'Instagram did not say which account this is. While the BeanPool Pulse app is in review, only accounts added as Instagram Testers can connect.';
            vi.mocked(signedPost).mockImplementation(nodeAnswers(502, { error: 'identity_unavailable', message: hint }));
            const mockFetch = vi.fn();
            global.fetch = mockFetch;

            const err = await connectInstagramChannel(igChannel, mockIdentity, 'https://test.beanpool.org', 'ig_app').catch(e => e);
            expect(err.message).toBe(hint);
            const exchange = vi.mocked(signedPost).mock.calls.find(c => c[1] === '/api/member/pulse/oauth-exchange')!;
            expect(exchange[2]).toMatchObject({ platform: 'instagram', channelId: 'chan_ig' });
            expect(exchange[2]).not.toHaveProperty('platformUsername');
            expect(mockFetch).not.toHaveBeenCalled();
            expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
        });

        it('a relay refresh names the channel, so an unbadged one re-verifies silently', async () => {
            const { signedPost } = await import('../node-post');
            vi.mocked(signedPost).mockResolvedValueOnce({
                ok: true, status: 200,
                json: async () => ({ data: { access_token: 'relayed', refresh_token: 'r2', expires_in: 86400 } }),
            } as any);
            const updated = await refreshTokenIfNeeded(mockToken, 'key', 'https://test.beanpool.org', mockIdentity);
            expect(updated.accessToken).toBe('relayed');
            expect(vi.mocked(signedPost).mock.calls[0][2]).toMatchObject({ grantType: 'refresh_token', refreshToken: 'valid_refresh_token', channelId: 'chan_123' });
        });

        it('restoreVerifiedBadge re-verifies a TikTok channel from the stored token, and drops a token for another account', async () => {
            const { restoreVerifiedBadge } = await import('../pulse-oauth');
            const { signedPost } = await import('../node-post');
            vi.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify(mockToken));
            vi.mocked(signedPost).mockImplementation(nodeAnswers(200, {
                data: { access_token: 'fresh', refresh_token: 'fresh_r', expires_in: 86400 },
                channel: { id: 'chan_123', oauthVerifiedAt: new Date().toISOString() },
                identity: { handle: 'alice_pottery' },
            }));
            const channel = await restoreVerifiedBadge({ id: 'chan_123', platform: 'tiktok', handle: '@alice_pottery' }, mockIdentity, 'https://test.beanpool.org');
            expect(channel.oauthVerifiedAt).toBeTruthy();
            expect(vi.mocked(signedPost).mock.calls[0][2]).toMatchObject({ grantType: 'refresh_token', channelId: 'chan_123' });
            expect(SecureStore.setItemAsync).toHaveBeenCalledWith('pulse_oauth_token_chan_123', expect.stringContaining('"accessToken":"fresh"'), { keychainAccessible: 6 });

            vi.mocked(signedPost).mockImplementation(nodeAnswers(400, { error: 'account_mismatch' }));
            const err = await restoreVerifiedBadge({ id: 'chan_123', platform: 'tiktok', handle: '@alice_pottery' }, mockIdentity, 'https://test.beanpool.org').catch(e => e);
            expect(err.reason).toBe('account-mismatch');
            expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('pulse_oauth_token_chan_123');

            expect(await restoreVerifiedBadge({ id: 'chan_ig', platform: 'instagram', handle: '@x' }, mockIdentity, 'https://test.beanpool.org')).toBeNull();
        });
    });
});
