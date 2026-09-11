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
            ctx.set('Cache-Control', 'public, max-age=31536000, immutable');
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
        if (result.etag) {
            ctx.set('ETag', result.etag);
        }
        ctx.set('Cache-Control', 'public, max-age=31536000, immutable');
        ctx.body = result.buffer;
    });

    return router;
}
