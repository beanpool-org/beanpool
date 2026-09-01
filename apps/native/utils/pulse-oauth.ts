/**
 * The Pulse — Phase 5: OAuth Upgrade Path & Device-Side Channel Integration.
 *
 * Implements:
 * 1. Platform OAuth connection for TikTok Display API and Instagram (Creator).
 * 2. Secure device-side token storage via expo-secure-store (tokens NEVER sent to node).
 * 3. Automatic token lifecycle & refresh on device.
 * 4. Device-side fetch of creator video lists via platform Display APIs.
 * 5. Node ingestion via signed POST /api/member/pulse/oauth-ingest.
 * 6. Disconnect flow clearing device token and server verification timestamp.
 * 7. Android App Link & Custom Tab interception mitigation via multi-source event race.
 */

import { Platform, DeviceEventEmitter } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as Crypto from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeBase64 } from './crypto';
import { signedPost, anchorUrl } from './node-post';
import type { BeanPoolIdentity } from './identity';

const isWeb = Platform.OS === 'web';

export interface PulseOAuthToken {
    platform: 'tiktok' | 'instagram';
    channelId: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt: number; // Unix timestamp in ms
    refreshExpiresAt?: number; // Unix timestamp in ms
    platformUsername: string;
    openId?: string;
}

export interface PulseOAuthConfig {
    tiktok: {
        enabled: boolean;
        clientKey: string | null;
    };
    instagram: {
        enabled: boolean;
        appId: string | null;
    };
}

export type PulseOAuthFailure =
    | 'unsupported'
    | 'cancelled'
    | 'no-token'
    | 'account-mismatch'
    | 'expired'
    | 'network'
    | 'provider';

export class PulseOAuthError extends Error {
    constructor(readonly reason: PulseOAuthFailure, message: string) {
        super(message);
        this.name = 'PulseOAuthError';
    }
}

/** SecureStore token key prefix per channel */
function tokenKey(channelId: string): string {
    return `pulse_oauth_token_${channelId}`;
}

/**
 * Read stored OAuth credential for a channel from device secure storage.
 * The node NEVER holds or sees these tokens.
 */
export async function getStoredOAuthToken(channelId: string): Promise<PulseOAuthToken | null> {
    try {
        let raw: string | null = null;
        if (isWeb) {
            raw = localStorage.getItem(tokenKey(channelId));
        } else {
            raw = await SecureStore.getItemAsync(tokenKey(channelId));
        }
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.warn(`[PulseOAuth] Could not load token for channel ${channelId}:`, e);
        return null;
    }
}

/**
 * Save OAuth credential for a channel into device secure storage.
 */
export async function saveStoredOAuthToken(token: PulseOAuthToken): Promise<void> {
    const raw = JSON.stringify(token);
    if (isWeb) {
        localStorage.setItem(tokenKey(token.channelId), raw);
    } else {
        await SecureStore.setItemAsync(tokenKey(token.channelId), raw);
    }
}

/**
 * Delete stored OAuth credential for a channel from device secure storage.
 */
export async function deleteStoredOAuthToken(channelId: string): Promise<void> {
    if (isWeb) {
        localStorage.removeItem(tokenKey(channelId));
    } else {
        await SecureStore.deleteItemAsync(tokenKey(channelId));
    }
}

/**
 * Discover platform OAuth availability configuration from the node.
 */
export async function fetchPulseOAuthConfig(nodeUrl?: string): Promise<PulseOAuthConfig> {
    const base = nodeUrl || await anchorUrl();
    if (!base) {
        return {
            tiktok: { enabled: false, clientKey: null },
            instagram: { enabled: false, appId: null },
        };
    }

    try {
        const res = await fetch(`${base}/api/pulse/oauth/config`, {
            headers: { Accept: 'application/json' },
        });
        if (res.ok) {
            const data = await res.json();
            return {
                tiktok: {
                    enabled: Boolean(data?.tiktok?.enabled),
                    clientKey: data?.tiktok?.clientKey || null,
                },
                instagram: {
                    enabled: Boolean(data?.instagram?.enabled),
                    appId: data?.instagram?.appId || null,
                },
            };
        }
    } catch (e) {
        console.warn('[PulseOAuth] Failed to fetch node OAuth configuration:', e);
    }

    return {
        tiktok: { enabled: false, clientKey: null },
        instagram: { enabled: false, appId: null },
    };
}

function toBase64Url(bytes: Uint8Array): string {
    return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkcePair(): { verifier: string; challenge: string } {
    const randomBytes = Crypto.getRandomBytes(32);
    const verifier = toBase64Url(randomBytes);
    const challengeBytes = sha256(new TextEncoder().encode(verifier));
    const challenge = toBase64Url(challengeBytes);
    return { verifier, challenge };
}

function callbackParams(url: string): string {
    const q = url.indexOf('?');
    const h = url.indexOf('#');
    const query = q === -1 ? '' : url.slice(q + 1, h > q ? h : undefined);
    const fragment = h === -1 ? '' : url.slice(h + 1);
    return [query, fragment].filter(Boolean).join('&');
}

function callbackState(url: string): string | null {
    for (const marker of ['?', '#']) {
        const idx = url.indexOf(marker);
        if (idx === -1) continue;
        const rest = url.slice(idx + 1);
        const cut = marker === '?' ? rest.indexOf('#') : -1;
        const state = new URLSearchParams(cut === -1 ? rest : rest.slice(0, cut)).get('state');
        if (state) return state;
    }
    return null;
}

const AUTH_CALLBACK_TIMEOUT_MS = 120_000;
const SPURIOUS_CANCEL_GRACE_MS = Platform.OS === 'ios' ? 0 : 2_000;
const TIMED_OUT = Symbol('pulse-oauth-timeout');

/**
 * Open OAuth browser session with multi-source fallback against Android Custom Tab hijacking.
 */
async function openAuthSessionWithFallback(
    authUrl: string,
    completionUri: string,
    expectedState: string,
    platformName: string
): Promise<string> {
    let resolveArrival: (url: string) => void = () => {};
    const arrival = new Promise<string>((resolve) => {
        resolveArrival = resolve;
    });

    const accept = (incomingUrl: string | null | undefined, source: string): void => {
        if (!incomingUrl) return;
        const state = callbackState(incomingUrl);
        if (state !== expectedState) {
            console.log(`[PulseOAuth] ${platformName}: ignored ${source} callback (state ${state ? 'mismatch' : 'absent'})`);
            return;
        }
        console.log(`[PulseOAuth] ${platformName}: accepted callback from ${source}`);
        resolveArrival(incomingUrl);
    };

    const linkingSub = Linking.addEventListener('url', (event) => accept(event.url, 'Linking'));
    const deviceEventSub = DeviceEventEmitter.addListener('SSO_AUTH_CALLBACK', (url: string) =>
        accept(url, 'native-intent')
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), AUTH_CALLBACK_TIMEOUT_MS);
    });

    const browser = WebBrowser.openAuthSessionAsync(authUrl, completionUri)
        .then(async (result) => {
            if (result.type === 'success' && result.url) {
                accept(result.url, 'browser');
            } else {
                console.log(`[PulseOAuth] ${platformName}: browser reported '${result.type}' — waiting for potential App Link`);
            }
            await new Promise((r) => setTimeout(r, SPURIOUS_CANCEL_GRACE_MS));
            return null;
        })
        .catch((e) => {
            console.log(`[PulseOAuth] ${platformName}: browser threw`, e);
            return null;
        });

    try {
        const outcome = await Promise.race([arrival, browser, deadline]);
        if (typeof outcome === 'string') return outcome;
        if (outcome === TIMED_OUT) {
            throw new PulseOAuthError('provider', `${platformName} connection timed out.`);
        }
        throw new PulseOAuthError('cancelled', 'Connection was cancelled.');
    } finally {
        linkingSub?.remove?.();
        deviceEventSub?.remove?.();
        if (timer) clearTimeout(timer);
        try {
            WebBrowser.dismissAuthSession();
        } catch {}
    }
}

/**
 * Connect a TikTok Creator Channel via TikTok Login Kit + Display API.
 */
export async function connectTikTokChannel(
    channel: { id: string; handle: string | null; url: string | null },
    identity: BeanPoolIdentity,
    nodeUrl: string,
    clientKeyOverride?: string | null
): Promise<{ channel: any; newItemsCount: number }> {
    let clientKey = clientKeyOverride;
    if (!clientKey) {
        const config = await fetchPulseOAuthConfig(nodeUrl);
        clientKey = config.tiktok.clientKey;
    }

    if (!clientKey) {
        throw new PulseOAuthError(
            'unsupported',
            'TikTok connection is not configured on this community node.'
        );
    }

    const { verifier, challenge } = generatePkcePair();
    const state = toBase64Url(Crypto.getRandomBytes(24));
    const redirectUri = 'https://beanpool.org/auth/tiktok';
    const completionUri = 'beanpool://auth/tiktok';

    const authUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${encodeURIComponent(
        clientKey
    )}&scope=user.info.basic,video.list&response_type=code&redirect_uri=${encodeURIComponent(
        redirectUri
    )}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(
        challenge
    )}&code_challenge_method=S256`;

    console.log('[PulseOAuth] Opening TikTok authorization session');
    const callbackUrl = await openAuthSessionWithFallback(authUrl, completionUri, state, 'TikTok');

    const params = new URLSearchParams(callbackParams(callbackUrl));
    const code = params.get('code');
    const error = params.get('error') || params.get('error_description');

    if (error) {
        if (error.includes('cancel') || error.includes('access_denied')) {
            throw new PulseOAuthError('cancelled', 'TikTok connection was cancelled.');
        }
        throw new PulseOAuthError('provider', `TikTok returned error: ${error}`);
    }

    if (!code) {
        throw new PulseOAuthError('no-token', 'TikTok authorization completed without a code.');
    }

    // Token exchange
    console.log('[PulseOAuth] Exchanging TikTok authorization code for access token');
    let tokenData: any;
    try {
        const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_key: clientKey,
                code_verifier: verifier,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri,
            }).toString(),
        });
        tokenData = await tokenRes.json();
    } catch (e: any) {
        throw new PulseOAuthError('network', `Could not reach TikTok: ${e.message}`);
    }

    const data = tokenData?.data || {};
    if (!data.access_token) {
        const msg = tokenData?.error?.message || tokenData?.message || 'Failed to obtain access token from TikTok.';
        throw new PulseOAuthError('provider', msg);
    }

    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;
    const expiresInSec = data.expires_in || 86400;
    const refreshExpiresInSec = data.refresh_expires_in || 31536000;
    const openId = data.open_id;

    // Fetch user profile from TikTok
    console.log('[PulseOAuth] Fetching TikTok user profile');
    let profileData: any;
    try {
        const userRes = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        profileData = await userRes.json();
    } catch (e: any) {
        throw new PulseOAuthError('network', `Could not verify TikTok user profile: ${e.message}`);
    }

    const user = profileData?.data?.user || {};
    const platformUsername = user.username || user.display_name || '';

    if (!platformUsername) {
        throw new PulseOAuthError('provider', 'TikTok did not return an account username.');
    }

    // Verify ownership on node
    console.log(`[PulseOAuth] Verifying channel on node with TikTok username: ${platformUsername}`);
    const verifyRes = await signedPost(
        nodeUrl,
        `/api/member/channels/${channel.id}/verify-oauth`,
        {
            platform: 'tiktok',
            platformUsername,
        },
        identity
    );

    const verifyJson = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok) {
        const errorMsg = verifyJson?.message || verifyJson?.error || 'Verification refused by node.';
        if (verifyJson?.error === 'account_mismatch' || errorMsg.includes('does not match')) {
            throw new PulseOAuthError('account-mismatch', errorMsg);
        }
        throw new PulseOAuthError('provider', errorMsg);
    }

    // Persist token in device SecureStore
    const now = Date.now();
    const storedToken: PulseOAuthToken = {
        platform: 'tiktok',
        channelId: channel.id,
        accessToken,
        refreshToken,
        expiresAt: now + expiresInSec * 1000,
        refreshExpiresAt: now + refreshExpiresInSec * 1000,
        platformUsername,
        openId,
    };
    await saveStoredOAuthToken(storedToken);

    // Fetch and ingest initial video list
    let newItemsCount = 0;
    try {
        const syncResult = await syncChannelVideos(channel.id, identity, nodeUrl, storedToken);
        newItemsCount = syncResult.synced;
    } catch (syncErr) {
        console.warn('[PulseOAuth] Initial video sync error (non-fatal):', syncErr);
    }

    return { channel: verifyJson.channel, newItemsCount };
}

/**
 * Connect an Instagram Creator Channel via Meta Graph API.
 * Structured behind the same interface, ready for when Meta review is complete.
 */
export async function connectInstagramChannel(
    channel: { id: string; handle: string | null; url: string | null },
    identity: BeanPoolIdentity,
    nodeUrl: string,
    appIdOverride?: string | null
): Promise<{ channel: any; newItemsCount: number }> {
    let appId = appIdOverride;
    if (!appId) {
        const config = await fetchPulseOAuthConfig(nodeUrl);
        appId = config.instagram.appId;
    }

    if (!appId) {
        throw new PulseOAuthError(
            'unsupported',
            'Instagram Creator connection is pending Meta app review on this node.'
        );
    }

    const state = toBase64Url(Crypto.getRandomBytes(24));
    const redirectUri = 'https://beanpool.org/auth/instagram';
    const completionUri = 'beanpool://auth/instagram';

    const authUrl = `https://api.instagram.com/oauth/authorize?client_id=${encodeURIComponent(
        appId
    )}&redirect_uri=${encodeURIComponent(
        redirectUri
    )}&scope=user_profile,user_media&response_type=code&state=${encodeURIComponent(state)}`;

    const callbackUrl = await openAuthSessionWithFallback(authUrl, completionUri, state, 'Instagram Creator');

    const params = new URLSearchParams(callbackParams(callbackUrl));
    const code = params.get('code');
    const error = params.get('error') || params.get('error_description');

    if (error || !code) {
        throw new PulseOAuthError('cancelled', 'Instagram Creator connection was cancelled or refused.');
    }

    throw new PulseOAuthError('unsupported', 'Instagram Creator integration is pending app review approval.');
}

/**
 * Refresh an expiring platform token automatically on device.
 */
export async function refreshTokenIfNeeded(
    storedToken: PulseOAuthToken,
    clientKey?: string | null,
    nodeUrl?: string
): Promise<PulseOAuthToken> {
    const now = Date.now();
    // If more than 10 minutes remaining, token is fresh
    if (storedToken.expiresAt > now + 10 * 60 * 1000) {
        return storedToken;
    }

    if (!storedToken.refreshToken) {
        throw new PulseOAuthError('expired', 'Token expired and no refresh token is stored.');
    }

    if (storedToken.refreshExpiresAt && storedToken.refreshExpiresAt <= now) {
        throw new PulseOAuthError('expired', 'Refresh token expired. Please reconnect.');
    }

    if (storedToken.platform === 'tiktok') {
        let key = clientKey;
        if (!key && nodeUrl) {
            const config = await fetchPulseOAuthConfig(nodeUrl);
            key = config.tiktok.clientKey;
        }
        if (!key) {
            const config = await fetchPulseOAuthConfig();
            key = config.tiktok.clientKey;
        }
        if (!key) {
            throw new PulseOAuthError('provider', 'Cannot refresh TikTok token without a client key.');
        }

        const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_key: key,
                grant_type: 'refresh_token',
                refresh_token: storedToken.refreshToken,
            }).toString(),
        });

        const json = await res.json();
        const data = json?.data;
        if (!data?.access_token) {
            throw new PulseOAuthError('expired', 'Failed to refresh TikTok token. Please reconnect.');
        }

        const updated: PulseOAuthToken = {
            ...storedToken,
            accessToken: data.access_token,
            refreshToken: data.refresh_token || storedToken.refreshToken,
            expiresAt: now + (data.expires_in || 86400) * 1000,
            refreshExpiresAt: now + (data.refresh_expires_in || 31536000) * 1000,
        };
        await saveStoredOAuthToken(updated);
        return updated;
    }

    return storedToken;
}

/**
 * Device-side fetch of a creator's video list via Display API, converted into the
 * same item shape the resolver produces, then submitted to the node.
 */
export async function syncChannelVideos(
    channelId: string,
    identity: BeanPoolIdentity,
    nodeUrl: string,
    existingToken?: PulseOAuthToken | null
): Promise<{ synced: number; deduplicated: number }> {
    let token = existingToken || await getStoredOAuthToken(channelId);
    if (!token) {
        return { synced: 0, deduplicated: 0 };
    }

    try {
        const config = await fetchPulseOAuthConfig(nodeUrl);
        token = await refreshTokenIfNeeded(token, config.tiktok.clientKey, nodeUrl);
    } catch (e: any) {
        if (e instanceof PulseOAuthError && e.reason === 'expired') {
            console.log('[PulseOAuth] Token expired during sync');
            return { synced: 0, deduplicated: 0 };
        }
    }

    const itemsToIngest: Array<{
        url: string;
        title?: string;
        thumbnailUrl?: string;
        publishedAt?: string;
        externalId?: string;
    }> = [];

    if (token.platform === 'tiktok') {
        try {
            const listRes = await fetch(
                'https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,duration,cover_image_url,share_url,create_time',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token.accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ max_count: 20 }),
                }
            );

            if (listRes.ok) {
                const listData = await listRes.json();
                const videos = listData?.data?.videos || [];

                for (const v of videos) {
                    if (!v.share_url) continue;
                    itemsToIngest.push({
                        url: v.share_url,
                        title: v.title || v.video_description || 'TikTok Video',
                        thumbnailUrl: v.cover_image_url || undefined,
                        publishedAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : undefined,
                        externalId: v.id ? String(v.id) : undefined,
                    });
                }
            }
        } catch (e) {
            console.warn('[PulseOAuth] Error fetching TikTok video list:', e);
        }
    }

    if (itemsToIngest.length === 0) {
        return { synced: 0, deduplicated: 0 };
    }

    // Submit items to node
    try {
        const ingestRes = await signedPost(
            nodeUrl,
            '/api/member/pulse/oauth-ingest',
            {
                channelId,
                items: itemsToIngest,
            },
            identity
        );

        if (ingestRes.ok) {
            const ingestData = await ingestRes.json();
            return {
                synced: ingestData.count || itemsToIngest.length,
                deduplicated: ingestData.deduplicatedCount || 0,
            };
        }
    } catch (e) {
        console.warn('[PulseOAuth] Error submitting OAuth items to node:', e);
    }

    return { synced: itemsToIngest.length, deduplicated: 0 };
}

/**
 * Disconnect an OAuth channel: drops the device token and calls the server to clear verification.
 */
export async function disconnectOAuthChannel(
    channelId: string,
    identity: BeanPoolIdentity,
    nodeUrl: string
): Promise<any> {
    await deleteStoredOAuthToken(channelId);

    const res = await signedPost(
        nodeUrl,
        `/api/member/channels/${channelId}/disconnect-oauth`,
        {},
        identity
    );

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(json?.message || json?.error || 'Failed to disconnect channel.');
    }

    return json.channel;
}
