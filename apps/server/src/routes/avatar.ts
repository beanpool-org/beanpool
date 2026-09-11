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
        // NOT `immutable`. The emitted URL carries no version, so `immutable` would freeze a
        // changed avatar in every client cache for a year — and the native `_v=` buster falls
        // back to a static value because almost no caller passes `updatedAt`. Revalidating
        // costs one conditional request that answers 304 with an empty body.
        ctx.set('Cache-Control', 'public, max-age=0, must-revalidate');
        ctx.body = result.buffer;
    });

    return router;
}
