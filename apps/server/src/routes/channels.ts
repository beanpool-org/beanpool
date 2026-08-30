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
 * ## Reads are public, writes are not
 *
 * `GET /api/members/:publicKey/channels` returns the channels a member chose to syndicate. That is
 * deliberately unauthenticated within the node — it is the data behind the link chips on a public
 * profile, and it contains nothing the member has not explicitly published.
 */

import Router from '@koa/router';
import {
    listChannels, listPublicChannels, addChannel, updateChannel, deleteChannel,
    otherVideoChannels, ChannelError, CHANNEL_PLATFORMS, CHANNEL_CATEGORIES,
} from '../engine/creator-channels.js';
import type { RouteDeps } from './types.js';

/** Map a ChannelError onto a status code. Anything unrecognised is a 400, never a 500. */
function channelErrorStatus(code: string): number {
    switch (code) {
        case 'NOT_FOUND': return 404;
        case 'NOT_YOURS': return 403;
        case 'DUPLICATE': return 409;
        case 'TOO_MANY': return 429;
        default: return 400;
    }
}

export function createChannelRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    /** The platform and category vocabularies, so the client never hardcodes a drifting list. */
    router.get('/api/channels/options', async (ctx) => {
        ctx.body = { platforms: CHANNEL_PLATFORMS, categories: CHANNEL_CATEGORIES };
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

    return router;
}
