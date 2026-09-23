import Router from '@koa/router';
import type { RouteDeps } from './types.js';
import { getAvatarService, AvatarService } from '../engine/avatar.js';

export interface AvatarRouteDeps extends Partial<RouteDeps> {
    avatarService?: AvatarService;
}

export function createAvatarRoutes(deps?: AvatarRouteDeps) {
    const router = new Router();
    const avatarService = deps?.avatarService ?? getAvatarService();

    router.get('/api/avatar/:pubkey', async (ctx) => {
        const pubkey = ctx.params?.pubkey;
        if (!pubkey || typeof pubkey !== 'string') {
            ctx.status = 400;
            ctx.body = { error: 'invalid_pubkey', message: 'Public key is required' };
            return;
        }

        const size = ctx.query.size === 'thumb' ? 'thumb' : 'full';
        // `v` (the content-derived version from engine/avatar-url.ts) is deliberately not read.
        // It exists to make the URL change when the photo does, so client caches that key on the
        // URL fetch again; what gets served is always whatever the row holds NOW. Ignoring it
        // also means a stale or absent `v` — an older app build, a hand-typed URL — still gets
        // the current photo rather than a 404.
        const ifNoneMatch = typeof ctx.get === 'function' ? ctx.get('If-None-Match') : ctx.headers?.['if-none-match'];

        const result = await avatarService.getAvatar(pubkey, size, { ifNoneMatch });

        if (result.status === 304) {
            ctx.status = 304;
            if (result.etag) {
                ctx.set('ETag', result.etag);
            }
            ctx.set('Cache-Control', 'public, max-age=0, must-revalidate');
            return;
        }

        if (result.status !== 200 || !result.buffer) {
            ctx.status = result.status;
            ctx.body = { error: result.error || 'Failed to load avatar' };
            return;
        }

        ctx.status = 200;
        ctx.type = result.contentType!;
        ctx.set('Content-Type', result.contentType!);
        // The MIME type is allow-listed in the service, but this route is public and
        // unauthenticated, so refuse sniffing and force a non-navigational disposition too.
        ctx.set('X-Content-Type-Options', 'nosniff');
        ctx.set('Content-Disposition', 'inline');
        if (result.etag) {
            ctx.set('ETag', result.etag);
        }
        // Still NOT `immutable`, though the emitted URL now carries a content-derived `v` that
        // would make it safe for the CURRENT emitters. The URL is public and long-lived: builds
        // already on members' phones, and anything that saved an older unversioned link, would
        // have that stale response frozen in cache for a year with no way to correct it.
        // Revalidating costs one conditional request that answers 304 with an empty body, and
        // the `v` parameter is what actually fixes staleness — it changes the URL, so a changed
        // photo is a cache MISS rather than a revalidation.
        ctx.set('Cache-Control', 'public, max-age=0, must-revalidate');
        ctx.body = result.buffer;
    });

    return router;
}
