/**
 * Living Activity Waterfall Route (#208).
 *
 * Exposes real-time ambient community activity feed:
 * - GET /api/activity/feed
 */

import Router from '@koa/router';
import { getActivityFeed } from '../db/activity-feed-db.js';
import type { RouteDeps } from './types.js';

export function createActivityRouter(deps: RouteDeps): Router {
    const router = new Router();

    /**
     * GET /api/activity/feed
     * Public endpoint to fetch recent community pulse activity.
     */
    router.get('/api/activity/feed', async (ctx) => {
        if (!deps.rateLimit(ctx)) return;

        const limit = Math.min(Number(ctx.query.limit) || 50, 100);
        const offset = Math.max(0, Number(ctx.query.offset) || 0);

        const feed = getActivityFeed(limit, offset);
        ctx.body = { feed };
    });

    return router;
}
