/**
 * Settings → Moderation → "Taken down by assistants" (scratch/fable-design/DESIGN-mcp-moderation-fable.md §3.13): what an owner's
 * assistant took down, with Put back and Remove now. An assistant has no way to any of this.
 *
 * - No token reaches these routes (automation-tokens.ts isRefusedToEveryToken refuses every token on /agent/ paths): a person's
 *   session only, an owner's or an admin's, as they read the posts and restore or remove one today.
 * - One post: an owner or an admin, as Settings' own restore and delete are; Remove now for one post IS that delete route, so its
 *   refund and its warnings are the ones a person already gets.
 * - A whole call, or everything since a time: an owner's (the line Settings' bulk delete draws, design case 18 D1; requireAdminRole
 *   reads the role, so an admin's session and the phone's step-up are asked as they always are). Remove now for a call also asks
 *   the owner's fresh proof, as "Remove its posts" does, and never goes past a deal in escrow or an open Child safety report: nobody
 *   reads a post on that tap, so each of those is a person's, one at a time.
 * - Put back asks no more than that: it is the undo of a stolen token's day, and has to be one tap.
 */
import Router from '@koa/router';
import type { RouteDeps } from '../routes/types.js';
import { requireAdminRole, requireFreshProof } from '../admin-auth.js';
import { logger } from '../logger.js';
import { putBackTakedowns } from '../state-engine.js';
import { listTakedowns, removeTakedownNow, TAKEDOWN } from '../engine/agent-takedowns.js';
import { cleanMemberText } from './fence.js';

const ROLE_ERROR = 'Only an owner or an admin of this node can see what AI assistants took down';
const OWNER_ERROR = 'Only an owner acts on a whole call or a whole day: an admin puts posts back one at a time';

const body = (ctx: any): Record<string, unknown> => {
    const b = ctx.requestBody ?? ctx.request?.body;
    return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
};
const actor = (ctx: any): string => String(ctx.state?.actor ?? 'owner:password').slice(0, 16);

/** A person's session, an owner or an admin, never a token (refused before this; said again). */
async function personOnly(ctx: any, deps: RouteDeps): Promise<boolean> {
    if (!(await deps.checkAdminAuth(ctx))) return false;
    if (ctx.state?.automationTokenId) {
        ctx.status = 403;
        ctx.body = { error: 'An automation token cannot act on what AI assistants took down' };
        return false;
    }
    return requireAdminRole(ctx, ['owner', 'admin'], ROLE_ERROR);
}

// Paths written out in full, so the route sweeps (test-guest-view.ts, test-automation-tokens.ts) find them.
export function createTakedownRoutes(deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/local/admin/agent/takedowns', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await personOnly(ctx, deps))) return;
        ctx.body = {
            holdDays: TAKEDOWN.holdDays,
            canActOnMany: (ctx.state as any)?.adminRole === 'owner',
            takedowns: listTakedowns().map((t) => ({
                ...t, grantName: cleanMemberText(t.grantName, 60), member: cleanMemberText(t.member ?? '', 60) || null, why: cleanMemberText(t.why, TAKEDOWN.whyMax),
                posts: t.posts.map((p) => ({ ...p, title: cleanMemberText(p.title ?? '', 120) || null, author: cleanMemberText(p.author ?? '', 60) || null })),
            })),
        };
    });

    /** { postId }, one post; { takedownId }, one call; { grantId, since }, all one assistant took down since a time. */
    router.post('/api/local/admin/agent/takedowns/put-back', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await personOnly(ctx, deps))) return;
        const b = body(ctx);
        const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
        const postId = str(b.postId), takedownId = str(b.takedownId), grantId = str(b.grantId);
        const since = typeof b.since === 'string' && Number.isFinite(Date.parse(b.since)) ? new Date(b.since).toISOString() : '';
        const scope = postId ? { postId } : takedownId ? { takedownId } : grantId && since ? { grantId, since } : null;
        if (!scope) {
            ctx.status = 400;
            ctx.body = { error: 'Name a postId, a takedownId, or a grantId and a since time' };
            return;
        }
        if (!postId && !requireAdminRole(ctx, ['owner'], OWNER_ERROR)) return;
        const out = putBackTakedowns(scope);
        if (out.back.length === 0 && out.gone === 0) {
            ctx.status = 404;
            ctx.body = { error: 'Nothing here is waiting to be put back: it was put back already, or it is final' };
            return;
        }
        logger.info('ADMIN', 'Posts an AI assistant took down put back', { posts: out.back.slice(0, 200), stillHidden: out.stillHidden.length, gone: out.gone, role: (ctx.state as any)?.adminRole ?? null, by: actor(ctx) });
        ctx.body = { back: out.back, stillHidden: out.stillHidden, gone: out.gone };
    });

    router.post('/api/local/admin/agent/takedowns/:id/remove-now', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await personOnly(ctx, deps))) return;
        if (!requireAdminRole(ctx, ['owner'], OWNER_ERROR)) return;
        const id = String(ctx.params.id || '');
        if (!listTakedowns().some((t) => t.id === id)) {
            ctx.status = 404;
            ctx.body = { error: 'No takedown here has that id' };
            return;
        }
        if (!(await requireFreshProof(ctx, body(ctx).code, 'remove for good what an assistant took down'))) return;
        const out = removeTakedownNow(id);
        logger.info('ADMIN', 'Posts an AI assistant took down removed now', { takedown: id, posts: out.removed.slice(0, 200), left: out.left.length, by: actor(ctx) });
        ctx.body = out;
    });

    return router;
}
