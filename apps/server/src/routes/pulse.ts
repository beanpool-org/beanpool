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
import { knowledgePulseCards, showingTo } from '../engine/knowledge.js';
import { featuresFor } from '../config/features-for.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { readsAsMember } from '../state-engine.js';
import type { RouteDeps } from './types.js';
import { PULSE_KNOWLEDGE_WITH, word, type PulseKnowledgeCard } from '@beanpool/core';

export interface PulseRouteDeps extends RouteDeps {
    thumbnailService?: PulseThumbnailService;
}

function asBool(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
        throw new PulseError('BAD_FIELD', `${field} must be true or false.`);
    }
    return value;
}

/** Whether a read's `with=` names this word: one word, several comma separated, or the key given more than once. */
function asksWith(raw: unknown, wanted: string): boolean {
    const given = Array.isArray(raw) ? raw : [raw];
    return given.some((v) => typeof v === 'string' && v.split(',').some((w) => w.trim() === wanted));
}

/**
 * Local knowledge's cards for this read of the feed (DESIGN-local-knowledge-amend-fable.md §2.12, slice KP): only to an app
 * that asks (`with=knowledge`: an app from before it never meets one), only under "All" (a read the feed itself filters by
 * `category` gets none), and only as Home's Learn card is given (routes/home-answer.ts learnPagesFor): to a reader who
 * reads as a member here (not a suspended member, a visitor or an unsigned read), where Learn is on, never on a node
 * with the visitors' view (the global community). Worked out from the pages Learn shows this reader, nothing stored.
 * A read that fails leaves the cards out, never the feed: the creators' items are what the Pulse is for.
 */
function knowledgeCardsFor(actor: unknown, withWords: unknown, feedCategory: string | undefined): PulseKnowledgeCard[] {
    if (!asksWith(withWords, PULSE_KNOWLEDGE_WITH) || feedCategory) return [];
    if (typeof actor !== 'string' || !readsAsMember(actor)) return [];
    if (featuresFor(actor).knowledge !== true || getProfileSwitches().guestListingsOnly) return [];
    try {
        return knowledgePulseCards(showingTo(actor));
    } catch (e) {
        console.warn('[Pulse] the Local knowledge cards could not be read:', (e as Error)?.message || e);
        return [];
    }
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
     *
     * `with=knowledge` (slice KP): also Local knowledge's cards, one a day at most, merged into the same order with the same
     * cursor (knowledgeCardsFor says who gets them). Without it the answer is what it always was.
     */
    router.get('/api/pulse/feed', async (ctx) => {
        const { cursor, category, limit } = ctx.query;
        const parsedLimit = limit !== undefined ? parseInt(String(limit), 10) : undefined;
        const feedCategory = typeof category === 'string' ? category : undefined;

        const result = getPulseFeed({
            cursor: typeof cursor === 'string' ? cursor : undefined,
            category: feedCategory,
            limit: parsedLimit !== undefined && !isNaN(parsedLimit) ? parsedLimit : undefined,
            extra: knowledgeCardsFor(ctx.state?.actor, ctx.query.with, feedCategory),
        });

        ctx.body = result;
    });

    /**
     * Public thumbnail proxy for Pulse feed items (an <img> cannot sign). A member's item id is 96 random bits that only
     * the members' feed hands out; the curated items are BeanPool's own.
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
