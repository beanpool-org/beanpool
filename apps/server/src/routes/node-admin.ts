/**
 * Member-facing node-admin routes: what the app needs to offer "Manage <community>" to owners and admins
 * (and "Moderate <community>" to moderators).
 *
 *   GET /api/node-admin/me     — the SIGNED-IN member's own node role (owner | admin | moderator | null). Nobody else's.
 *   GET /api/node-admin/queue  — for an owner/admin: counts of pending admin work, each with its /settings section;
 *                                for a moderator: the reports waiting, and nothing else.
 *
 * Both answer only for the key that signed the request (ctx.state.actor, set by the signature middleware),
 * never for a pubkey named in the query or body. The role comes from node_roles at request time, so the
 * app never has to trust a cached role — and the node re-checks it again when the sign-in link is issued
 * and again when the browser exchanges it (admin-key-auth.ts).
 *
 * Opening /settings itself goes through the existing key hand-off:
 *   POST /api/local/admin/auth/challenge → sign → POST /api/local/admin/auth/verify-challenge
 *   → 60 s single-use token → /settings#handoff=<token> → the page POSTs it to /api/local/admin/auth/exchange.
 */

import Router from '@koa/router';
import { getMember, isVisitorKey, nodeRoleOf } from '../state-engine.js';
import { getAdminQueue } from '../engine/admin-queue.js';
import { getLocalConfig } from '../config/local-config.js';
import { issueBreakGlassCode } from '../admin-key-auth.js';
import type { RouteDeps } from './types.js';

export function createNodeAdminRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    /** The verified signer, or null after answering 401. Read auth may be off on a node; this route is not. */
    function signedMember(ctx: any): string | null {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Sign this request with your member key' };
            return null;
        }
        // A visitor's row is answered as a key with no row is: a role it holds from before the visitors' rule acts for nothing.
        const member = getMember(actor);
        if (!member || member.status !== 'active' || isVisitorKey(actor)) {
            ctx.status = 403;
            ctx.body = { error: 'Not an active member of this community' };
            return null;
        }
        return actor;
    }

    router.get('/api/node-admin/me', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const actor = signedMember(ctx);
        if (!actor) return;
        const config = getLocalConfig();
        ctx.body = {
            role: nodeRoleOf(actor) ?? null,
            communityName: config.communityName || config.callsign || null,
        };
    });

    /**
     * The app's break-glass code: a new one for the signing owner's own key, shown once on the phone, which keeps no
     * copy (#1531). The owner's earlier code stops working. An admin, a moderator or a member gets 403
     * and nothing is stored; there is no way to name another key. Logged without the code (issueBreakGlassCode).
     */
    router.post('/api/node-admin/break-glass', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const actor = signedMember(ctx);
        if (!actor) return;
        if (nodeRoleOf(actor) !== 'owner') {
            ctx.status = 403;
            ctx.body = { error: 'Only an owner of this community has a break-glass code' };
            return;
        }
        const code = issueBreakGlassCode(actor, 'their own key, from the app', 'app');
        ctx.body = { success: true, memberPubkey: actor, breakGlassCode: code };
    });

    router.get('/api/node-admin/queue', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const actor = signedMember(ctx);
        if (!actor) return;
        const role = nodeRoleOf(actor);
        if (!role) {
            ctx.status = 403;
            ctx.body = { error: 'Only the node owner, an admin or a moderator can see the admin queue' };
            return;
        }
        // A moderator sees only the reports waiting: the rest is work their session cannot open. Only an owner is told
        // the standby needs them (services/standby-health.ts).
        ctx.body = getAdminQueue({ forModerator: role === 'moderator', forOwner: role === 'owner' });
    });

    return router;
}
