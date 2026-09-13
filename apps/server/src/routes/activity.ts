/**
 * Living Activity Waterfall Route (#208).
 *
 * Exposes real-time ambient community activity feed:
 * - GET /api/activity/feed
 */

import Router from '@koa/router';
import { getActivityFeed } from '../db/activity-feed-db.js';
import { getActivityVersion } from '../engine/versions.js';
import type { RouteDeps } from './types.js';

export function createActivityRouter(deps: RouteDeps): Router {
    const router = new Router();

    /**
     * GET /api/activity/feed
     * Public endpoint to fetch recent community pulse activity.
     */
    router.get('/api/activity/feed', async (ctx) => {
        const limit = deps.clampLimit(ctx.query.limit, 50);
        const offset = deps.clampOffset(ctx.query.offset);

        // Weak ETag partitioned by version and query parameters (limit, offset).
        // Evaluated before hitting SQLite to return 0-byte 304s for idle pollers.
        const etag = `W/"activity-feed-${getActivityVersion()}-${limit}-${offset}"`;
        ctx.set('ETag', etag);

        // `public`, not `private`: the ambient community activity waterfall does NOT vary
        // by viewer or require authenticated identity. Every member and guest sees the
        // identical public event feed. `max-age=0, must-revalidate` ensures fresh data.
        ctx.set('Cache-Control', 'public, max-age=0, must-revalidate');

        const ifNoneMatch = typeof ctx.get === 'function' ? ctx.get('If-None-Match') : ctx.headers?.['if-none-match'];
        if (ifNoneMatch) {
            const cleanInm = ifNoneMatch.replace(/^W\//, '');
            const cleanEtag = etag.replace(/^W\//, '');
            if (cleanInm === cleanEtag || ifNoneMatch.includes(cleanEtag)) {
                ctx.status = 304;
                return;
            }
        }

        const feed = getActivityFeed(limit, offset);
        ctx.status = 200;
        ctx.body = { feed };
    });

    return router;
}
