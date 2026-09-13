/**
 * Living Activity Waterfall Route (#208).
 *
 * Exposes real-time ambient community activity feed:
 * - GET /api/activity/feed
 */

import Router from '@koa/router';
import { getActivityFeed, ACTIVITY_FEED_MAX_LIMIT } from '../db/activity-feed-db.js';
import { getActivityVersion, getMembersVersion } from '../engine/versions.js';
import type { RouteDeps } from './types.js';

export function createActivityRouter(deps: RouteDeps): Router {
    const router = new Router();

    /**
     * GET /api/activity/feed
     * Public endpoint to fetch recent community pulse activity.
     */
    router.get('/api/activity/feed', async (ctx) => {
        // Clamped to the SAME bound the query applies. deps.clampLimit allows up to 200 while
        // getActivityFeed caps at 100, so limits 101-200 produced distinct ETags for byte-identical
        // bodies — never wrong content, but a cache entry per requested limit for no reason.
        const limit = Math.min(deps.clampLimit(ctx.query.limit, 50), ACTIVITY_FEED_MAX_LIMIT);
        const offset = deps.clampOffset(ctx.query.offset);

        // Partitioned by BOTH counters, and the members one is not decoration: getActivityFeed
        // LEFT JOINs members twice and selects actor.callsign and target.callsign, so the feed's
        // body changes whenever a member is renamed — including a federation visitor whose
        // placeholder `Visitor-xxxx` is replaced by their real callsign. Gating only on
        // activityVersion meant a rename left every client's feed showing the OLD callsign
        // indefinitely, since a 304 never reads the database to notice. Reusing membersVersion
        // rather than adding more bump sites also means any future member column added to that
        // join is invalidated automatically instead of silently going stale.
        const etag = `W/"activity-feed-${getActivityVersion()}-${getMembersVersion()}-${limit}-${offset}"`;
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
