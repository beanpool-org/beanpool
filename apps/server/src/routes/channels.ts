/**
 * Creator channel routes — a member's own external publishing accounts (The Pulse, Phase 1).
 *
 * ## Every mutation takes its owner from the signature, never from the body
 *
 * `ctx.state.actor` is the key that signed the request. `/api/profile/update` still tolerates a
 * `publicKey` in the request body as a fallback, and that pattern must NOT be copied here: for
 * channels it would let anyone attach `@mullum_ceramics` to their own profile, and the feed would
 * then show cards attributed to a neighbour who never consented, with Message and Trade buttons
 * pointing at the wrong person.
 *
 * So the owner is only ever `ctx.state.actor`, and a request without one is a 401 rather than a
 * best guess.
 *
 * ## Reads are gated like the profile they belong to
 *
 * `GET /api/members/:publicKey/channels` returns the channels a member chose to syndicate — the
 * link chips on their profile. It is NOT on the public-read allowlist, because
 * `GET /api/profile/:publicKey` is not either: under ENFORCE_READ_AUTH the profile requires a
 * member identity, and a member's external handles are no less identifying than the profile that
 * carries them. Syndication is a choice about what other *members* see, not a decision to publish
 * to anyone who can reach the node.
 */

import Router from '@koa/router';
import https from 'node:https';
import {
    listChannels, listPublicChannels, addChannel, updateChannel, deleteChannel,
    verifyChannelOauth, disconnectChannelOauth,
    otherVideoChannels, ChannelError, CHANNEL_PLATFORMS, CHANNEL_CATEGORIES,
} from '../engine/creator-channels.js';
import type { RouteDeps } from './types.js';

export function getPulseOAuthConfig(): {
    tiktok: { enabled: boolean; clientKey: string | null };
    instagram: { enabled: boolean; appId: string | null };
} {
    const tiktokKey = process.env.TIKTOK_CLIENT_KEY || process.env.TIKTOK_CLIENT_ID || null;
    const instagramAppId = process.env.INSTAGRAM_APP_ID || null;
    return {
        tiktok: {
            enabled: Boolean(tiktokKey),
            clientKey: tiktokKey,
        },
        instagram: {
            enabled: Boolean(instagramAppId),
            appId: instagramAppId,
        },
    };
}

/** Map a ChannelError onto a status code. Anything unrecognised is a 400, never a 500. */
function channelErrorStatus(code: string): number {
    switch (code) {
        case 'NOT_FOUND': return 404;
        case 'NOT_YOURS': return 403;
        case 'ACCOUNT_MISMATCH':
        case 'BAD_PLATFORM':
        case 'EMPTY':
            return 400;
        case 'DUPLICATE': return 409;
        // A standing limit, not a rate: 429 would invite the client to retry, and retrying never
        // helps — the member has to remove a channel first.
        case 'AT_LIMIT': return 409;
        case 'TOO_MANY': return 429;
        default: return 400;
    }
}

export function createChannelRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    /** The platform and category vocabularies, so the client never hardcodes a drifting list. */
    router.get('/api/channels/options', async (ctx) => {
        ctx.body = {
            platforms: CHANNEL_PLATFORMS,
            categories: CHANNEL_CATEGORIES,
            oauth: getPulseOAuthConfig(),
        };
    });

    /**
     * The caller's own channels, including ones switched off for the feed.
     *
     * POST rather than GET: `ctx.state.actor` is only populated for signed requests, and the
     * management view must be scoped to the signer rather than to a public key in the path —
     * otherwise it becomes a way to read anyone's switched-off channels.
     */
    router.post('/api/channels/mine', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }
        ctx.body = { channels: listChannels(actor) };
    });

    /** The channels a member publishes — the link chips on their public profile. */
    router.get('/api/members/:publicKey/channels', async (ctx) => {
        const publicKey = ctx.params.publicKey;
        if (!publicKey || !/^[0-9a-f]{64}$/i.test(publicKey)) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid public key' };
            return;
        }
        ctx.body = { channels: listPublicChannels(publicKey) };
    });

    router.post('/api/member/channels', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }
        const { platform, url, handle, category, syndicateToNode, isPrimaryVideo } =
            (ctx as any).requestBody || {};

        // `url` and `handle` are the same field to a member — they paste whichever they have.
        const raw = typeof url === 'string' && url.trim() ? url : handle;
        if (typeof raw !== 'string' || !raw.trim()) {
            ctx.status = 400;
            ctx.body = { error: 'A link or handle is required' };
            return;
        }

        try {
            const channel = addChannel({
                ownerPubkey: actor,
                platform: String(platform || ''),
                raw,
                category: String(category || 'other'),
                syndicateToNode,
                isPrimaryVideo,
            });
            // Returned alongside the new channel so the client can raise the cross-post warning
            // without a second round trip — a creator posting the same reel to two platforms would
            // otherwise appear twice on the feed, and the moment to say so is now.
            const others = otherVideoChannels(actor, channel.id);
            ctx.body = { success: true, channel, otherVideoChannels: others };
        } catch (e: any) {
            if (e instanceof ChannelError) {
                ctx.status = channelErrorStatus(e.code);
                ctx.body = { error: e.code.toLowerCase(), message: e.message };
                return;
            }
            throw e;
        }
    });

    router.post('/api/member/channels/:id', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }
        const { category, syndicateToNode, isPrimaryVideo, autopublish } = (ctx as any).requestBody || {};
        try {
            const channel = updateChannel(actor, ctx.params.id, {
                category, syndicateToNode, isPrimaryVideo, autopublish,
            });
            ctx.body = { success: true, channel };
        } catch (e: any) {
            if (e instanceof ChannelError) {
                ctx.status = channelErrorStatus(e.code);
                ctx.body = { error: e.code.toLowerCase(), message: e.message };
                return;
            }
            throw e;
        }
    });

    /**
     * Attach OAuth verification to a creator channel (The Pulse, Phase 5).
     *
     * Takes owner strictly from ctx.state.actor and verifies the authenticated platform username
     * matches the channel before setting oauth_verified_at.
     */
    router.post('/api/member/channels/:id/verify-oauth', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }

        const body = (ctx as any).requestBody || {};
        const platform = typeof body.platform === 'string' ? body.platform.trim() : '';
        const platformUsername = typeof body.platformUsername === 'string' ? body.platformUsername.trim() : '';

        if (!platform || !platformUsername) {
            ctx.status = 400;
            ctx.body = { error: 'empty', message: 'Platform and platformUsername are required.' };
            return;
        }

        try {
            const channel = verifyChannelOauth(actor, ctx.params.id, {
                platform,
                platformUsername,
            });
            ctx.body = { success: true, channel };
        } catch (e: any) {
            if (e instanceof ChannelError) {
                ctx.status = channelErrorStatus(e.code);
                ctx.body = { error: e.code.toLowerCase(), message: e.message };
                return;
            }
            throw e;
        }
    });

    /**
     * Disconnect OAuth verification from a creator channel (The Pulse, Phase 5).
     *
     * Drops oauth_verified_at and resets autolist support. Existing items stay in pulse_items.
     */
    router.post('/api/member/channels/:id/disconnect-oauth', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }

        try {
            const channel = disconnectChannelOauth(actor, ctx.params.id);
            ctx.body = { success: true, channel };
        } catch (e: any) {
            if (e instanceof ChannelError) {
                ctx.status = channelErrorStatus(e.code);
                ctx.body = { error: e.code.toLowerCase(), message: e.message };
                return;
            }
            throw e;
        }
    });

    /**
     * Remove a channel.
     *
     * POST rather than DELETE so it travels the same signed-body path as every other mutation
     * here — the signature covers the method and path, and the client's signing helper is built
     * around GET and POST.
     */
    router.post('/api/member/channels/:id/delete', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }
        try {
            const removed = deleteChannel(actor, ctx.params.id);
            if (!removed) {
                ctx.status = 404;
                ctx.body = { error: 'not_found', message: 'Channel not found.' };
                return;
            }
            ctx.body = { success: true };
        } catch (e: any) {
            if (e instanceof ChannelError) {
                ctx.status = channelErrorStatus(e.code);
                ctx.body = { error: e.code.toLowerCase(), message: e.message };
                return;
            }
            throw e;
        }
    });

const ALLOWED_REDIRECT_URIS = new Set([
    'https://beanpool.org/auth/tiktok',
    'https://beanpool.org/auth/tiktok/',
    'https://beanpool.org/auth/instagram',
    'https://beanpool.org/auth/instagram/',
    'beanpool://auth/tiktok',
    'beanpool://auth/instagram',
]);

function validateRedirectUri(uri: string | undefined, platform: 'tiktok' | 'instagram'): string {
    const defaultUri = `https://beanpool.org/auth/${platform}`;
    if (!uri) return defaultUri;
    if (!ALLOWED_REDIRECT_URIS.has(uri)) {
        throw new Error(`Unauthorized redirect URI for ${platform}: ${uri}`);
    }
    return uri;
}

function postFormWithIPv4(urlStr: string, params: Record<string, string>): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const data = new URLSearchParams(params).toString();
        const req = https.request(
            url,
            {
                method: 'POST',
                family: 4,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(data),
                },
                timeout: 10000,
            },
            (res) => {
                let resData = '';
                res.on('data', (chunk) => { resData += chunk; });
                res.on('end', () => {
                    let json: any;
                    try {
                        json = JSON.parse(resData);
                    } catch {
                        json = { error: resData || `HTTP ${res.statusCode}` };
                    }
                    resolve({ status: res.statusCode || 200, json });
                });
            }
        );
        req.on('timeout', () => {
            req.destroy(new Error('Request timed out'));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function getJsonWithIPv4(urlStr: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const req = https.request(
            url,
            {
                method: 'GET',
                family: 4,
                headers: { 'Accept': 'application/json' },
                timeout: 10000,
            },
            (res) => {
                let resData = '';
                res.on('data', (chunk) => { resData += chunk; });
                res.on('end', () => {
                    let json: any;
                    try {
                        json = JSON.parse(resData);
                    } catch {
                        json = { error: resData || `HTTP ${res.statusCode}` };
                    }
                    resolve({ status: res.statusCode || 200, json });
                });
            }
        );
        req.on('timeout', () => {
            req.destroy(new Error('Request timed out'));
        });
        req.on('error', reject);
        req.end();
    });
}

    /**
     * Relay OAuth code exchange for TikTok and Instagram using server-side client secrets.
     * The node NEVER persists the resulting tokens — it strictly acts as a confidential client proxy.
     */
    router.post('/api/member/pulse/oauth-exchange', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }

        const body = (ctx as any).requestBody || {};
        const platform = body.platform;
        const grantType = body.grantType || 'authorization_code';

        if (platform === 'tiktok') {
            const clientKey = process.env.TIKTOK_CLIENT_KEY || process.env.TIKTOK_CLIENT_ID;
            const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
            if (!clientKey || !clientSecret) {
                ctx.status = 503;
                ctx.body = { error: 'TikTok client secret is not configured on this node.' };
                return;
            }

            const params: Record<string, string> = {
                client_key: clientKey,
                client_secret: clientSecret,
                grant_type: grantType,
            };

            if (grantType === 'authorization_code') {
                if (!body.code) {
                    ctx.status = 400;
                    ctx.body = { error: 'Code is required' };
                    return;
                }
                params.code = String(body.code).replace(/#.*$/, '').trim();
                if (body.codeVerifier) params.code_verifier = body.codeVerifier;
                try {
                    params.redirect_uri = validateRedirectUri(body.redirectUri, 'tiktok');
                } catch (e: any) {
                    ctx.status = 400;
                    ctx.body = { error: e.message };
                    return;
                }
            } else if (grantType === 'refresh_token') {
                if (!body.refreshToken) {
                    ctx.status = 400;
                    ctx.body = { error: 'Refresh token is required' };
                    return;
                }
                params.refresh_token = body.refreshToken;
            }

            try {
                console.log(`[PulseOAuthRelay] Calling TikTok token endpoint for client_key=${clientKey}, redirect_uri=${params.redirect_uri}`);
                const { status, json } = await postFormWithIPv4('https://open.tiktokapis.com/v2/oauth/token/', params);
                console.log('[PulseOAuthRelay] TikTok token endpoint response:', status, JSON.stringify(json));
                const normalizedData = {
                    ...(json.data || {}),
                    access_token: json.access_token || json.data?.access_token,
                    refresh_token: json.refresh_token || json.data?.refresh_token,
                    expires_in: json.expires_in || json.data?.expires_in,
                    refresh_expires_in: json.refresh_expires_in || json.data?.refresh_expires_in,
                    open_id: json.open_id || json.data?.open_id,
                    scope: json.scope || json.data?.scope,
                    token_type: json.token_type || json.data?.token_type,
                };
                ctx.status = status;
                ctx.body = {
                    ...json,
                    data: normalizedData,
                };
            } catch (e: any) {
                console.error('[PulseOAuthRelay] TikTok fetch exception:', e);
                ctx.status = 502;
                ctx.body = { error: 'Failed to contact TikTok token endpoint', message: e.message };
            }
            return;
        }

        if (platform === 'instagram') {
            const appId = process.env.INSTAGRAM_APP_ID;
            const appSecret = process.env.INSTAGRAM_APP_SECRET || process.env.INSTAGRAM_CLIENT_SECRET;
            if (!appId || !appSecret) {
                ctx.status = 503;
                ctx.body = { error: 'Instagram app secret is not configured on this node.' };
                return;
            }

            if (grantType === 'authorization_code') {
                if (!body.code) {
                    ctx.status = 400;
                    ctx.body = { error: 'Code is required' };
                    return;
                }
                const cleanCode = String(body.code).replace(/#.*$/, '').trim();
                let redirectUri: string;
                try {
                    redirectUri = validateRedirectUri(body.redirectUri, 'instagram');
                } catch (e: any) {
                    ctx.status = 400;
                    ctx.body = { error: e.message };
                    return;
                }
                try {
                    console.log(`[PulseOAuthRelay] Calling Instagram token endpoint for appId=${appId}, redirectUri=${redirectUri}`);
                    let { status: tokenStatus, json: tokenJson } = await postFormWithIPv4('https://api.instagram.com/oauth/access_token', {
                        client_id: appId,
                        client_secret: appSecret,
                        grant_type: 'authorization_code',
                        redirect_uri: redirectUri,
                        code: cleanCode,
                    });
                    console.log('[PulseOAuthRelay] Instagram token endpoint response:', tokenStatus, JSON.stringify(tokenJson));

                    // If Meta rejects due to trailing slash mismatch, try the opposite slash variant
                    if ((tokenStatus >= 400 || !tokenJson.access_token) && tokenJson?.error_message?.includes('redirect_uri')) {
                        const altUri = redirectUri.endsWith('/') ? redirectUri.slice(0, -1) : redirectUri + '/';
                        console.log(`[PulseOAuthRelay] Retrying Instagram token endpoint with alt redirectUri=${altUri}`);
                        const altRes = await postFormWithIPv4('https://api.instagram.com/oauth/access_token', {
                            client_id: appId,
                            client_secret: appSecret,
                            grant_type: 'authorization_code',
                            redirect_uri: altUri,
                            code: cleanCode,
                        });
                        console.log('[PulseOAuthRelay] Instagram alt token endpoint response:', altRes.status, JSON.stringify(altRes.json));
                        if (altRes.status < 400 && altRes.json?.access_token) {
                            tokenStatus = altRes.status;
                            tokenJson = altRes.json;
                        }
                    }

                    if (tokenStatus >= 400 || !tokenJson.access_token) {
                        ctx.status = tokenStatus >= 400 ? tokenStatus : 400;
                        ctx.body = tokenJson;
                        return;
                    }

                    // Exchange short-lived token for long-lived token (60 days)
                    let finalToken = tokenJson.access_token;
                    let expiresIn = tokenJson.expires_in || 3600;
                    try {
                        const { status: longStatus, json: longJson } = await getJsonWithIPv4(
                            `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(
                                appSecret
                            )}&access_token=${encodeURIComponent(tokenJson.access_token)}`
                        );
                        if (longStatus < 400 && longJson?.access_token) {
                            finalToken = longJson.access_token;
                            expiresIn = longJson.expires_in || 5184000; // 60 days
                        }
                    } catch {}

                    ctx.body = {
                        data: {
                            access_token: finalToken,
                            user_id: tokenJson.user_id,
                            expires_in: expiresIn,
                        },
                    };
                } catch (e: any) {
                    console.error('[PulseOAuthRelay] Instagram fetch exception:', e);
                    ctx.status = 502;
                    ctx.body = { error: 'Failed to contact Instagram token endpoint', message: e.message };
                }
                return;
            }
        }

        ctx.status = 400;
        ctx.body = { error: 'Unsupported platform or grant type' };
    });

    return router;
}
