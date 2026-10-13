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
    disconnectChannelOauth, getChannel, connectTarget, connectTargetIsProven, badgeChannelFromIdentity,
    otherVideoChannels, ChannelError, CHANNEL_PLATFORMS, CHANNEL_CATEGORIES,
    type ConnectTarget, type CreatorChannel,
} from '../engine/creator-channels.js';
import { platformRequest, readPlatformIdentity, IdentityUnavailable, type PlatformIdentity } from '../engine/platform-identity.js';
import type { RouteDeps } from './types.js';
import { respondIfMuted } from './profile-feature-gate.js';

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

const UPDATE_REQUIRED_MESSAGE =
    'Update BeanPool to connect this channel: the node now asks the platform which account you signed in to.';

/**
 * Every exchange spends OUR platform app's quota, so the relay is capped: 10 an hour per member and
 * 120 an hour per node (#1830 §3.8). In memory: a restart forgets, which errs toward letting members in.
 */
const RELAY_PER_ACTOR_PER_HOUR = 10;
const RELAY_PER_NODE_PER_HOUR = 120;
const HOUR_MS = 3_600_000;
const relayCallsByActor = new Map<string, number[]>();
let relayCallsOnNode: number[] = [];

function relayAllowed(actor: string, now = Date.now()): boolean {
    const cutoff = now - HOUR_MS;
    relayCallsOnNode = relayCallsOnNode.filter(t => t > cutoff);
    const mine = (relayCallsByActor.get(actor) || []).filter(t => t > cutoff);
    if (mine.length >= RELAY_PER_ACTOR_PER_HOUR || relayCallsOnNode.length >= RELAY_PER_NODE_PER_HOUR) {
        if (mine.length > 0) relayCallsByActor.set(actor, mine); else relayCallsByActor.delete(actor);
        return false;
    }
    mine.push(now);
    relayCallsByActor.set(actor, mine);
    relayCallsOnNode.push(now);
    return true;
}

/** Suites reset the relay caps between scenarios. */
export function resetPulseOAuthRelayLimits(): void {
    relayCallsByActor.clear();
    relayCallsOnNode = [];
}

/** The ChannelError → response mapping every route here uses. */
function respondChannelError(ctx: any, e: ChannelError): void {
    ctx.status = channelErrorStatus(e.code);
    ctx.body = { error: e.code.toLowerCase(), message: e.message };
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
        // A channel's items reach everyone's Pulse feed, so a muted member (G3) adds or changes none. Deleting one,
        // or disconnecting it, stays open.
        if (respondIfMuted(ctx, actor)) return;
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
        if (respondIfMuted(ctx, actor)) return;
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
     * Gone (#1830). This route set the badge on a username the PHONE supplied, so anyone could badge
     * a neighbour's handle. The badge is now set inside `/api/member/pulse/oauth-exchange`, where the
     * node asks the platform itself. An older phone that still calls this gets a plain refusal that
     * tells the member what to do, never a badge.
     */
    router.post('/api/member/channels/:id/verify-oauth', async (ctx) => {
        if (!ctx.state.actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }
        ctx.status = 410;
        ctx.body = { error: 'update_required', message: UPDATE_REQUIRED_MESSAGE };
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

    /**
     * Relay the OAuth code exchange for TikTok and Instagram with the node's client secrets, and set
     * the verified-account badge from what the PLATFORM says (#1830).
     *
     * Body: `{ platform, grantType, code | refreshToken, codeVerifier?, redirectUri?, channelId }`.
     * With the token still in this handler's local variable the node asks the platform who it
     * belongs to (`readPlatformIdentity`), matches that exactly against the channel row
     * (`badgeChannelFromIdentity`), returns the token to the phone and forgets it. The node never
     * stores a token, and nothing in the body names the account: there is no username field to trust.
     *
     * - A refused connect (wrong account, not verifiable, identity unavailable) returns NO token: the
     *   member authorised something this channel cannot use.
     * - A refresh with `channelId` asks the platform only when the row has no proven badge yet (the
     *   silent TikTok re-verify, Marty 13 Oct); a routine refresh before a sync costs one token call.
     * - A refresh with no `channelId` is a plain relay: no identity call, no badge.
     * - Logs carry the platform and outcome only, never a token, handle or account id.
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

        if (body.code && String(body.code).length > 1024) {
            ctx.status = 400;
            ctx.body = { error: 'Code exceeds maximum length of 1024 characters.' };
            return;
        }
        if (body.codeVerifier && String(body.codeVerifier).length > 256) {
            ctx.status = 400;
            ctx.body = { error: 'Code verifier exceeds maximum length of 256 characters.' };
            return;
        }
        if (body.refreshToken && String(body.refreshToken).length > 2048) {
            ctx.status = 400;
            ctx.body = { error: 'Refresh token exceeds maximum length of 2048 characters.' };
            return;
        }

        const supported = (platform === 'tiktok' && (grantType === 'authorization_code' || grantType === 'refresh_token'))
            || (platform === 'instagram' && grantType === 'authorization_code');
        if (!supported) {
            ctx.status = 400;
            ctx.body = { error: 'Unsupported platform or grant type' };
            return;
        }

        const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
        if (channelId.length > 200) {
            ctx.status = 400;
            ctx.body = { error: 'Channel id is too long.' };
            return;
        }
        // An older phone connects without naming the channel and then asks verify-oauth to badge a
        // username it supplies. That second step is gone, so the connect is refused up front with
        // words the member can act on, before any code is spent.
        if (!channelId && grantType === 'authorization_code') {
            ctx.status = 400;
            ctx.body = { error: 'update_required', message: UPDATE_REQUIRED_MESSAGE };
            return;
        }

        const tiktokKey = process.env.TIKTOK_CLIENT_KEY || process.env.TIKTOK_CLIENT_ID;
        const tiktokSecret = process.env.TIKTOK_CLIENT_SECRET;
        const instagramAppId = process.env.INSTAGRAM_APP_ID;
        const instagramSecret = process.env.INSTAGRAM_APP_SECRET || process.env.INSTAGRAM_CLIENT_SECRET;
        if (platform === 'tiktok' && (!tiktokKey || !tiktokSecret)) {
            ctx.status = 503;
            ctx.body = { error: 'TikTok client secret is not configured on this node.' };
            return;
        }
        if (platform === 'instagram' && (!instagramAppId || !instagramSecret)) {
            ctx.status = 503;
            ctx.body = { error: 'Instagram app secret is not configured on this node.' };
            return;
        }

        // Ownership, platform and verifiability are checked BEFORE the exchange, so a connect that
        // cannot badge never puts a token in hand.
        let target: ConnectTarget | null = null;
        if (channelId) {
            try {
                target = connectTarget(actor, channelId, platform);
            } catch (e: any) {
                if (e instanceof ChannelError) return respondChannelError(ctx, e);
                throw e;
            }
        }

        let redirectUri: string | undefined;
        if (grantType === 'authorization_code') {
            if (!body.code) {
                ctx.status = 400;
                ctx.body = { error: 'Code is required' };
                return;
            }
            try {
                redirectUri = validateRedirectUri(body.redirectUri, platform);
            } catch (e: any) {
                ctx.status = 400;
                ctx.body = { error: e.message };
                return;
            }
        } else if (!body.refreshToken) {
            ctx.status = 400;
            ctx.body = { error: 'Refresh token is required' };
            return;
        }

        if (!relayAllowed(actor)) {
            ctx.status = 429;
            ctx.body = { error: 'rate_limited', message: 'Too many connection attempts. Try again in an hour.' };
            return;
        }

        /**
         * Ask the platform who the token belongs to and set the badge, or answer the refusal.
         * Returns null when a response has been written.
         */
        const identify = async (accessToken: string, tokenAccountId?: unknown): Promise<{ channel: CreatorChannel; found: PlatformIdentity } | null> => {
            if (!target) return null;
            let found: PlatformIdentity;
            try {
                found = await readPlatformIdentity(platform, accessToken, tokenAccountId);
            } catch (e: any) {
                if (e instanceof IdentityUnavailable) {
                    console.log(`[PulseOAuthRelay] ${platform} identity unavailable`);
                    ctx.status = 502;
                    ctx.body = { error: 'identity_unavailable', message: e.hint };
                    return null;
                }
                throw e;
            }
            try {
                const channel = badgeChannelFromIdentity(actor, target, found);
                console.log(`[PulseOAuthRelay] ${platform} channel verified`);
                return { channel, found };
            } catch (e: any) {
                if (e instanceof ChannelError) {
                    console.log(`[PulseOAuthRelay] ${platform} identity refused: ${e.code.toLowerCase()}`);
                    respondChannelError(ctx, e);
                    return null;
                }
                throw e;
            }
        };

        if (platform === 'tiktok') {
            const params: Record<string, string> = {
                client_key: tiktokKey!,
                client_secret: tiktokSecret!,
                grant_type: grantType,
            };
            if (grantType === 'authorization_code') {
                params.code = String(body.code).replace(/#.*$/, '').trim();
                if (body.codeVerifier) params.code_verifier = String(body.codeVerifier);
                params.redirect_uri = redirectUri!;
            } else {
                params.refresh_token = String(body.refreshToken);
            }

            let status: number;
            let json: any;
            try {
                console.log(`[PulseOAuthRelay] Calling TikTok token endpoint for client_key=${tiktokKey}, redirect_uri=${params.redirect_uri}`);
                ({ status, json } = await platformRequest('POST', 'https://open.tiktokapis.com/v2/oauth/token/', { form: params }));
            } catch (e: any) {
                console.error('[PulseOAuthRelay] TikTok token endpoint unreachable:', e?.message);
                ctx.status = 502;
                ctx.body = { error: 'Failed to contact TikTok token endpoint', message: e?.message };
                return;
            }
            json = json && typeof json === 'object' ? json : {};
            console.log('[PulseOAuthRelay] TikTok token endpoint response:', {
                status,
                has_access_token: Boolean(json.access_token || json.data?.access_token),
                has_refresh_token: Boolean(json.refresh_token || json.data?.refresh_token),
                error: json.error || json.data?.error,
                error_description: json.error_description || json.data?.error_description || json.message || json.data?.description,
            });
            const tokenFields = {
                ...(json.data || {}),
                access_token: json.access_token || json.data?.access_token,
                refresh_token: json.refresh_token || json.data?.refresh_token,
                expires_in: json.expires_in || json.data?.expires_in,
                refresh_expires_in: json.refresh_expires_in || json.data?.refresh_expires_in,
                open_id: json.open_id || json.data?.open_id,
                scope: json.scope || json.data?.scope,
                token_type: json.token_type || json.data?.token_type,
            };
            if (status >= 400 || !tokenFields.access_token) {
                // A platform error passes through as it always has; it carries no token.
                ctx.status = status >= 400 ? status : 400;
                ctx.body = { ...json, data: { ...(json.data || {}), access_token: undefined, refresh_token: undefined } };
                return;
            }

            let channel: CreatorChannel | null = null;
            let identity: { handle: string | null } | undefined;
            if (target && (grantType === 'authorization_code' || !connectTargetIsProven(target))) {
                const result = await identify(tokenFields.access_token);
                if (!result) return;
                channel = result.channel;
                identity = { handle: result.found.handle };
            } else if (target) {
                channel = getChannel(target.row.id);
            }
            ctx.body = { data: tokenFields, channel, identity };
            return;
        }

        // Instagram (API with Instagram Login): code → short-lived token → identity → long-lived token.
        const cleanCode = String(body.code).replace(/#.*$/, '').trim();
        let tokenStatus: number;
        let tokenJson: any;
        try {
            console.log(`[PulseOAuthRelay] Calling Instagram token endpoint for appId=${instagramAppId}, redirectUri=${redirectUri}`);
            ({ status: tokenStatus, json: tokenJson } = await platformRequest('POST', 'https://api.instagram.com/oauth/access_token', {
                form: {
                    client_id: instagramAppId!,
                    client_secret: instagramSecret!,
                    grant_type: 'authorization_code',
                    redirect_uri: redirectUri!,
                    code: cleanCode,
                },
            }));
        } catch (e: any) {
            console.error('[PulseOAuthRelay] Instagram token endpoint unreachable:', e?.message);
            ctx.status = 502;
            ctx.body = { error: 'Failed to contact Instagram token endpoint', message: e?.message };
            return;
        }
        tokenJson = tokenJson && typeof tokenJson === 'object' ? tokenJson : {};
        console.log('[PulseOAuthRelay] Instagram token endpoint response:', {
            status: tokenStatus,
            has_access_token: Boolean(tokenJson.access_token),
            error_type: tokenJson.error_type || tokenJson.error?.type,
            error_message: tokenJson.error_message || tokenJson.error?.message || (typeof tokenJson.error === 'string' ? tokenJson.error : undefined),
        });
        if (tokenStatus >= 400 || !tokenJson.access_token) {
            ctx.status = tokenStatus >= 400 ? tokenStatus : 400;
            ctx.body = { ...tokenJson, access_token: undefined };
            return;
        }

        const result = await identify(tokenJson.access_token, tokenJson.user_id);
        if (!result) return;

        // Exchange the short-lived token for a long-lived one (60 days) only once the account is proven.
        let finalToken = tokenJson.access_token;
        let expiresIn = tokenJson.expires_in || 3600;
        try {
            const { status: longStatus, json: longJson } = await platformRequest('GET',
                `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(
                    instagramSecret!
                )}&access_token=${encodeURIComponent(tokenJson.access_token)}`);
            if (longStatus < 400 && longJson?.access_token) {
                finalToken = longJson.access_token;
                expiresIn = longJson.expires_in || 5184000; // 60 days
            }
        } catch { /* the short-lived token still works for this session */ }

        ctx.body = {
            data: {
                access_token: finalToken,
                user_id: tokenJson.user_id,
                expires_in: expiresIn,
            },
            channel: result.channel,
            identity: { handle: result.found.handle },
        };
    });

    return router;
}
