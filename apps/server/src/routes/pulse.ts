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
import { getTodaysPulseEntry, getPulseEntry, type DailyPulseEntry } from '../daily-pulse-entries.js';
import type { RouteDeps } from './types.js';
import { word } from '@beanpool/core';

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
     * The Pulse's activity feed, for members only on every node (https-server.ts MEMBERS_ONLY_READS_EXACT): each card
     * carries its member's key, name, face and their own page elsewhere.
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
     * Daily Pulse — answers today's (or, by ?date=YYYY-MM-DD, a recent day's) entry:
     * { date, headline, body }. Read-only, gated like the Pulse feed beside it.
     */
    router.get('/api/pulse/daily', async (ctx) => {
        const { date } = ctx.query;
        let entry: DailyPulseEntry;
        let dateStr: string;

        if (date !== undefined && date !== '') {
            if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                ctx.status = 400;
                ctx.body = { error: 'invalid_date', message: word('Invalid date') };
                return;
            }
            const [y, m, d] = date.split('-').map(Number);
            const utcMs = Date.UTC(y, m - 1, d);
            const parsed = new Date(utcMs);
            if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
                ctx.status = 400;
                ctx.body = { error: 'invalid_date', message: word('Invalid date') };
                return;
            }

            const now = new Date();
            const localEpochMs = now.getTime() - (now.getTimezoneOffset() * 60 * 1000);
            const todayStr = new Date(localEpochMs).toISOString().split('T')[0];
            if (date > todayStr) {
                ctx.status = 404;
                ctx.body = { error: 'not_found', message: word('Daily Pulse entry not found') };
                return;
            }

            const dayIndex = Math.floor(utcMs / 86400000);
            entry = getPulseEntry(dayIndex);
            dateStr = date;
        } else {
            const now = new Date();
            const localEpochMs = now.getTime() - (now.getTimezoneOffset() * 60 * 1000);
            dateStr = new Date(localEpochMs).toISOString().split('T')[0];
            entry = getTodaysPulseEntry(now);
        }

        ctx.body = {
            date: dateStr,
            headline: entry.headline,
            body: entry.body,
        };
    });

    /**
     * Public thumbnail proxy for Pulse feed items (an <img> cannot sign). A member's item id is 96 random bits that only
     * the members' feed hands out; the curated and Daily Pulse items are BeanPool's own.
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
            ctx.body = { error: word('Signed request required') };
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
