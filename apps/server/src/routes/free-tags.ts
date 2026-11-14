/**
 * This community's typed tags for the Tags field (engine/free-tags.ts, DESIGN-tags-free-entry-fable.md §3 and §5, slice F3).
 * Signed; a member of this community who reads as one (readsAsMember): a visitor does not compose, so anyone else 403
 * `not_member`, a paused member 403 `not_active`, unsigned 401 `unsigned`.
 *   GET /api/free-tags → { tags: [{ tag, listings, mergeInto? }] }   (most used first; the apps filter as the member types)
 * The owners' and admins' page and its rules are routes/admin.ts (/api/local/admin/free-tags).
 */
import Router from '@koa/router';
import { word } from '@beanpool/core';
import { isNodeMember, readsAsMember } from '../state-engine.js';
import { offeredFreeTags } from '../engine/free-tags.js';
import type { RouteDeps } from './types.js';

const ONLY_MEMBERS = word("Only a member of this community can see the tags its members use.");
const PAUSED = word('Your account here is paused for now.');

export function createFreeTagRoutes(_deps?: RouteDeps): Router {
    const router = new Router();

    router.get('/api/free-tags', (ctx) => {
        const key = (ctx.state as { actor?: string })?.actor;
        if (!key) { ctx.status = 401; ctx.body = { error: word('A signed request is required.'), code: 'unsigned' }; return; }
        if (!isNodeMember(key)) { ctx.status = 403; ctx.body = { error: ONLY_MEMBERS, code: 'not_member' }; return; }
        if (!readsAsMember(key)) { ctx.status = 403; ctx.body = { error: PAUSED, code: 'not_active' }; return; }
        ctx.set('Cache-Control', 'private, no-store');
        ctx.body = { tags: offeredFreeTags() };
    });

    return router;
}
