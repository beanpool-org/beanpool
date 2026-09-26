/**
 * A member's own moderation notices, kept for the web app (engine/kept-notices.ts), which has no push: it reads the ones
 * its member has not seen when it opens and when its socket reconnects, shows each as the live alert does, and marks
 * them seen.
 *
 *   GET  /api/notices[?unseen=1]   → { notices: [{ id, title, body, severity, data, createdAt, seenAt }] }, oldest first
 *   POST /api/notices/seen  { ids } → { success: true, marked }
 *
 * ## Only ever the signer's own
 *
 * Neither route takes a key from the query or the body: the member is `ctx.state.actor`, verified by the real
 * `requireSignature` middleware. The read is a gated read (not on the public allowlist), so an unsigned caller gets 401
 * and a signed key that is no member here 403 from the middleware; a closed account and a replaced key get its 403 on
 * both routes. The checks here answer the same way where the middleware lets a request through (a node with
 * ENFORCE_READ_AUTH=false, and a write, which the middleware does not hold to membership). An id that is not the
 * signer's marks nothing.
 *
 * ## The main server only, for the mark
 *
 * A standby answers the read from its copy, but refuses the mark, 503 `standby`, and writes nothing: its copy follows
 * the main server's, which would not have the mark. The community's address reaches the main server.
 */
import Router from '@koa/router';
import { isNodeMember, getNodeRole } from '../state-engine.js';
import { listKeptNotices, markKeptNoticesSeen, MARK_SEEN_MAX_IDS } from '../engine/kept-notices.js';
import type { RouteDeps } from './types.js';

/** The verified member signing this request, or undefined once the refusal is written. */
function member(ctx: any): string | undefined {
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return undefined;
    }
    if (!isNodeMember(actor)) {
        ctx.status = 403;
        ctx.body = { error: 'Read access requires a member identity' };
        return undefined;
    }
    return actor;
}

export function createNoticeRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/notices', async (ctx) => {
        const actor = member(ctx);
        if (!actor) return;
        const unseen = ctx.query.unseen === '1' || ctx.query.unseen === 'true';
        ctx.set('Cache-Control', 'private, no-store');
        ctx.body = { notices: listKeptNotices(actor, { unseenOnly: unseen }) };
    });

    router.post('/api/notices/seen', async (ctx) => {
        const actor = member(ctx);
        if (!actor) return;
        if (getNodeRole() !== 'primary') {
            ctx.status = 503;
            ctx.body = { error: 'This server is a standby copy of the community, not its main server. Notices are marked seen on the main server.', code: 'standby' };
            return;
        }
        const ids = ((ctx as any).requestBody || {}).ids;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > MARK_SEEN_MAX_IDS
            || !ids.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
            ctx.status = 400;
            ctx.body = { error: `Send ids: a list of 1 to ${MARK_SEEN_MAX_IDS} of your notices' ids.` };
            return;
        }
        ctx.set('Cache-Control', 'private, no-store');
        ctx.body = { success: true, marked: markKeptNoticesSeen(actor, ids) };
    });

    return router;
}
