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
import type { RouteDeps } from './types.js';

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

export function createPulseRoutes(_deps: RouteDeps): Router {
    const router = new Router();

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
