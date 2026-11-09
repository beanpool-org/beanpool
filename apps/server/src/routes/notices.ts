/**
 * A member's own moderation notices, kept for the web app (engine/kept-notices.ts), which has no push: it reads the ones
 * its member has not seen when it opens and when its socket reconnects, shows each as the live alert does, and marks
 * them seen.
 *
 *   GET  /api/notices[?unseen=1]   → { notices: [{ id, title, body, severity, data, createdAt, seenAt }] }, oldest first
 *   POST /api/notices/seen  { ids } → { success: true, marked }
 *   GET  /api/notices/push/:id     → { id, kind, title, body, data, sentAt }: one push's details (engine/push-notices.ts),
 *                                    read by a tap on it: off the bell
 *   GET  /api/notices/push[?unseen=1] → { notices: [{ id, kind, title, body, data, sentAt, seenAt }] }, newest first: the bell
 *   POST /api/notices/push/seen  { ids } → { success: true, marked }: rows off the bell (a tap on one)
 *
 * ## The bell (DESIGN-web-notifications-fable.md §2.1)
 *
 * Both apps' bell reads the push notices this server kept for its member, a phone or not: at most 100, 7 days, newest
 * first. A row leaves only when the member taps it (the mark here), taps its notification on their phone (which reads its
 * details, `GET /api/notices/push/:id`: only that tap does), or opens its thing (a chat they read; an alert they
 * acknowledge, which `POST /api/notices/seen` passes on: every kept notice that is pushed names its kept copy,
 * engine/kept-notices.ts keptNoticeDetails); reading the list marks nothing. Under the same gate as every route here, the
 * signer's own only; a standby answers the read (it keeps no push notices: an empty list) and refuses the mark.
 *
 * ## Only ever the signer's own
 *
 * Neither route takes a key from the query or the body: the member is `ctx.state.actor`, verified by the real
 * `requireSignature` middleware. The read is a gated read (not on the public allowlist), so an unsigned caller gets 401
 * and a signed key that is no member here 403 from the middleware; a closed account and a replaced key get its 403 on
 * both routes. The checks here answer the same way where the middleware lets a request through (a node with
 * ENFORCE_READ_AUTH=false, and a write, which the middleware does not hold to membership), with the gate's own test
 * (passesReadGate), as /api/community/me does: a suspended member reads and marks their own, a visitor's row has none.
 * An id that is not the signer's marks nothing.
 *
 * ## A push's details
 *
 * A push carries only its kind's fixed words and a signed notice id (@beanpool/core push-notice.ts); the app asks here,
 * after a tap, for what the sender wrote and where the tap lands. The same gate as the read above: the signer only, so a
 * notice id is answered to its recipient and to nobody else, who gets the same 404 as for an id that never existed or
 * that this server has forgotten (after 7 days, or a member's newest 100). A standby holds none (they are not copied).
 *
 * ## The main server only, for the mark
 *
 * A standby answers the read from its copy, but refuses the mark, 503 `standby`, and writes nothing: its copy follows
 * the main server's, which would not have the mark. The community's address reaches the main server.
 */
import Router from '@koa/router';
import { passesReadGate, getNodeRole, markBellNoticesSeen, markBellNoticesSeenWhere } from '../state-engine.js';
import { listKeptNotices, markKeptNoticesSeen, MARK_SEEN_MAX_IDS } from '../engine/kept-notices.js';
import { readPushNotice, listPushNotices, BELL_MARK_MAX_IDS } from '../engine/push-notices.js';
import { isPushNoticeId, word } from '@beanpool/core';
import type { RouteDeps } from './types.js';

/** The verified member signing this request, or undefined once the refusal is written. */
function member(ctx: any): string | undefined {
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: word('A signed request is required') };
        return undefined;
    }
    if (!passesReadGate(actor)) {
        ctx.status = 403;
        ctx.body = { error: word('Read access requires a member identity') };
        return undefined;
    }
    return actor;
}

/** The mark's ids, or undefined once the refusal is written: a standby's 503, a bad body's 400. */
function idsToMark(ctx: any, max: number): string[] | undefined {
    if (getNodeRole() !== 'primary') {
        ctx.status = 503;
        ctx.body = { error: word('This server is a standby copy of the community, not its main server. Notices are marked seen on the main server.'), code: 'standby' };
        return undefined;
    }
    const ids = (ctx.requestBody || {}).ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > max
        || !ids.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
        ctx.status = 400;
        ctx.body = { error: `Send ids: a list of 1 to ${max} of your notices' ids.` };
        return undefined;
    }
    return ids;
}

export function createNoticeRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/notices/push', async (ctx) => {
        const actor = member(ctx);
        if (!actor) return;
        const unseen = ctx.query.unseen === '1' || ctx.query.unseen === 'true';
        ctx.set('Cache-Control', 'private, no-store');
        ctx.body = { notices: listPushNotices(actor, { unseenOnly: unseen }) };
    });

    router.post('/api/notices/push/seen', async (ctx) => {
        const actor = member(ctx);
        if (!actor) return;
        const ids = idsToMark(ctx, BELL_MARK_MAX_IDS);
        if (!ids) return;
        ctx.set('Cache-Control', 'private, no-store');
        ctx.body = { success: true, marked: markBellNoticesSeen(actor, ids).length };
    });

    router.get('/api/notices', async (ctx) => {
        const actor = member(ctx);
        if (!actor) return;
        const unseen = ctx.query.unseen === '1' || ctx.query.unseen === 'true';
        ctx.set('Cache-Control', 'private, no-store');
        ctx.body = { notices: listKeptNotices(actor, { unseenOnly: unseen }) };
    });

    router.get('/api/notices/push/:id', async (ctx) => {
        const actor = member(ctx);
        if (!actor) return;
        ctx.set('Cache-Control', 'private, no-store');
        const notice = isPushNoticeId(ctx.params.id) ? readPushNotice(ctx.params.id, actor) : null;
        if (!notice) {
            ctx.status = 404;
            ctx.body = { error: word('This server has no such notice for you. Notices are kept for 7 days.'), code: 'no_notice' };
            return;
        }
        // Only a tap on its notification reads one notice's details (the phone's followTap): it is opened, so off the bell,
        // and its alert's kept copy marked, as a tap on the bell's row does. On the main server only: a standby holds none.
        if (getNodeRole() === 'primary') markBellNoticesSeen(actor, [notice.id]);
        ctx.body = notice;
    });

    router.post('/api/notices/seen', async (ctx) => {
        const actor = member(ctx);
        if (!actor) return;
        const ids = idsToMark(ctx, MARK_SEEN_MAX_IDS);
        if (!ids) return;
        ctx.set('Cache-Control', 'private, no-store');
        const marked = markKeptNoticesSeen(actor, ids);
        // The alert acknowledged: its row leaves the bell too.
        markBellNoticesSeenWhere(actor, 'noticeId', ids);
        ctx.body = { success: true, marked };
    });

    return router;
}
