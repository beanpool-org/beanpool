/**
 * Finding someone in another community by their exact name, when they said yes (slice N1). What each does is
 * engine/find-by-name.ts; the shared rule and words, @beanpool/core find-by-name.ts.
 *
 *   GET  /api/find/me      a member here   → { findable }: whether people in other communities can find them by name
 *   POST /api/find/me      a member here   { on: true, card } | { on: false } → { findable }; 400 bad_card, 403 outside_off
 *   POST /api/find/name    a member here   { home, name } → { found: false } | { found: true, card }; 400 bad_home,
 *                                           own_community, bad_name; 403 outside_off; 429 find_day_used; 502 not_reached
 *   POST /api/relay/find   another community's server's signed request only (engine/node-signature.ts)
 *                          { v: 1, asker, name } → 200 { v: 1, card } or the one "nobody" answer, byte for byte; 400 not a look-up
 *
 * The member routes are for a member who reads as one (engine/members.ts readsAsMember): a visitor's row, a key that is no
 * member here, a suspended member is refused (403 not_a_member). Every answer is `no-store`.
 */
import Router from '@koa/router';
import { isNodeMember, readsAsMember } from '../state-engine.js';
import { NOT_A_MEMBER_CODE, NOT_A_MEMBER_ERROR } from '../engine/members.js';
import type { NodeOrigin } from '../engine/node-signature.js';
import { FindError, answerFind, findByName, isFindable, setFindable } from '../engine/find-by-name.js';

/** The verified signer, when they are a member here who reads as one; else the route has answered 403. */
function memberHere(ctx: any): string | null {
    const actor = ctx.state.actor as string | undefined;
    if (actor && isNodeMember(actor) && readsAsMember(actor)) return actor;
    ctx.status = 403;
    ctx.body = { error: NOT_A_MEMBER_ERROR, code: NOT_A_MEMBER_CODE };
    return null;
}

function refused(ctx: any, e: unknown): boolean {
    if (!(e instanceof FindError)) return false;
    ctx.status = e.status;
    ctx.body = { error: e.message, code: e.code };
    return true;
}

export function createFindByNameRoutes(): Router {
    const router = new Router();

    router.get('/api/find/me', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = memberHere(ctx);
        if (!member) return;
        ctx.body = { findable: isFindable(member) };
    });

    router.post('/api/find/me', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = memberHere(ctx);
        if (!member) return;
        const body = (ctx.request as any).body as { on?: unknown; card?: unknown } | undefined;
        if (typeof body?.on !== 'boolean') {
            ctx.status = 400;
            ctx.body = { error: 'on is true (with your card) or false.', code: 'bad_switch' };
            return;
        }
        try {
            ctx.body = { findable: setFindable(member, body.on, body.card) };
        } catch (e) {
            if (!refused(ctx, e)) throw e;
        }
    });

    router.post('/api/find/name', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = memberHere(ctx);
        if (!member) return;
        try {
            ctx.body = await findByName(member, (ctx.request as any).body);
        } catch (e) {
            if (!refused(ctx, e)) throw e;
        }
    });

    router.post('/api/relay/find', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        // Set only by the node signature door (https-server.ts requireNodeSignature): a request without one never gets here.
        const from = ctx.state.nodeOrigin as NodeOrigin | undefined;
        if (!from) {
            ctx.status = 401;
            ctx.body = { error: 'This path takes only requests signed by a community\'s server.', code: 'node_signature_missing' };
            return;
        }
        const answer = await answerFind(from.origin, (ctx.request as any).body);
        ctx.status = answer.status;
        ctx.type = 'application/json';
        ctx.body = answer.body;
    });

    return router;
}
