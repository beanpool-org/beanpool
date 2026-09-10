/**
 * Pulse routes — The Pulse (Phase 2).
 *
 * Implements Contract B verbatim:
 * 1. GET /api/pulse/feed (public read, unsigned, cursor-paginated by published_at DESC,
 *    gated visibility).
 * 2. POST /api/member/pulse/items/:id/mute (signed, owner-scoped via ctx.state.actor).
 */

import Router from '@koa/router';
import { getPulseFeed, setPulseItemMute, PulseError } from '../engine/pulse-resolver.js';
import { getPulseThumbnailService, PulseThumbnailService } from '../engine/pulse-thumbnail.js';
import type { RouteDeps } from './types.js';

export interface PulseRouteDeps extends RouteDeps {
    thumbnailService?: PulseThumbnailService;
}

function asBool(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
        throw new PulseError('BAD_FIELD', `${field} must be true or false.`);
    }
    return value;
}

function pulseErrorStatus(code: string): number {
    switch (code) {
        case 'NOT_FOUND': return 404;
        case 'NOT_YOURS': return 403;
        case 'BAD_FIELD': return 400;
        default: return 400;
    }
}

export function createPulseRoutes(deps: RouteDeps | PulseRouteDeps): Router {
    const router = new Router();
    const thumbnailService = (deps as PulseRouteDeps)?.thumbnailService ?? getPulseThumbnailService();

    /**
     * Public activity feed for The Pulse.
     *
     * Cursor-paginated (by published_at DESC).
     * Filterable by category.
     * Visibility rules:
     * - Channel not deleted & syndicate_to_node = 1
     * - Item not deleted & muted = 0
     * - Member status = 'active'
     */
    router.get('/api/pulse/feed', async (ctx) => {
        const { cursor, category, limit } = ctx.query;
        const parsedLimit = limit !== undefined ? parseInt(String(limit), 10) : undefined;

        const result = getPulseFeed({
            cursor: typeof cursor === 'string' ? cursor : undefined,
            category: typeof category === 'string' ? category : undefined,
            limit: parsedLimit !== undefined && !isNaN(parsedLimit) ? parsedLimit : undefined,
        });

        ctx.body = result;
    });

    /**
     * Public thumbnail proxy for Pulse feed items.
     *
     * Serves image bytes from the node origin to satisfy CSP (img-src 'self'),
     * prevent member IP leakage to external CDNs, and survive CDN link expiry.
     */
    async function handleThumbnail(ctx: any) {
        const id = ctx.params?.id;
        if (!id || typeof id !== 'string') {
            ctx.status = 400;
            ctx.body = { error: 'invalid_id', message: 'Item ID is required' };
            return;
        }

        const ifNoneMatch = typeof ctx.get === 'function' ? ctx.get('If-None-Match') : ctx.headers?.['if-none-match'];
        const result = await thumbnailService.getThumbnail(id, { ifNoneMatch });

        if (result.status === 304) {
            ctx.status = 304;
            return;
        }

        if (result.status !== 200 || !result.buffer) {
            ctx.status = result.status;
            ctx.body = { error: result.error || 'Failed to load thumbnail' };
            return;
        }

        ctx.status = 200;
        ctx.type = result.contentType!;
        ctx.set('Content-Type', result.contentType!);
        if (result.etag) {
            ctx.set('ETag', result.etag);
        }
        ctx.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
        ctx.body = result.buffer;
    }

    router.get('/api/pulse/items/:id/thumbnail', handleThumbnail);

    /**
     * Mute / un-mute a pulse feed item.
     *
     * Owner-scoped mutation: uses ctx.state.actor to ensure a member can only mute their own items.
     */
    router.post('/api/member/pulse/items/:id/mute', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }

        const body = (ctx as any).requestBody || {};
        try {
            const muted = asBool(body.muted, 'muted');
            const result = setPulseItemMute(actor, ctx.params.id, muted);
            ctx.body = result;
        } catch (e: any) {
            if (e instanceof PulseError) {
                ctx.status = pulseErrorStatus(e.code);
                ctx.body = { error: e.code.toLowerCase(), message: e.message };
                return;
            }
            throw e;
        }
    });

    return router;
}
