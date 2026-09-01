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
                params.code = body.code;
                if (body.codeVerifier) params.code_verifier = body.codeVerifier;
                if (body.redirectUri) params.redirect_uri = body.redirectUri;
            } else if (grantType === 'refresh_token') {
                if (!body.refreshToken) {
                    ctx.status = 400;
                    ctx.body = { error: 'Refresh token is required' };
                    return;
                }
                params.refresh_token = body.refreshToken;
            }

            try {
                const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams(params).toString(),
                });
                const json = await res.json();
                ctx.status = res.status;
                ctx.body = json;
            } catch (e: any) {
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
                const redirectUri = body.redirectUri || 'https://beanpool.org/auth/instagram';
                try {
                    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            client_id: appId,
                            client_secret: appSecret,
                            grant_type: 'authorization_code',
                            redirect_uri: redirectUri,
                            code: body.code,
                        }).toString(),
                    });
                    const tokenJson = await tokenRes.json();
                    if (!tokenRes.ok) {
                        ctx.status = tokenRes.status;
                        ctx.body = tokenJson;
                        return;
                    }

                    // Exchange short-lived token for long-lived token (60 days)
                    let finalToken = tokenJson.access_token;
                    let expiresIn = tokenJson.expires_in || 3600;
                    try {
                        const longRes = await fetch(
                            `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(
                                appSecret
                            )}&access_token=${encodeURIComponent(tokenJson.access_token)}`
                        );
                        if (longRes.ok) {
                            const longJson = await longRes.json();
                            if (longJson.access_token) {
                                finalToken = longJson.access_token;
                                expiresIn = longJson.expires_in || 5184000; // 60 days
                            }
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
