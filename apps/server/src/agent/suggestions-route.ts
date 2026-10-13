/**
 * An AI assistant's suggestions in Settings → Moderation, which the phone's Manage opens (admin MCP design §5, slice S4).
 *
 * - List (`GET …/agent/suggestions`): an owner sees every waiting suggestion, an admin their own assistant's. Each comes
 *   with the ORIGINAL report beside it (what the reporter and the author wrote, as the moderation list shows it, never the
 *   reporter), the assistant's reason marked untrusted (cleaned and with its markers defused: text, never markup), and,
 *   for the member the assistant acts for, `approve`: the existing route's own call (agent/suggestions.ts approveCall).
 * - Approve is that existing route, run by the card under the person's own session: there is no approve route here.
 * - Decline (`POST …/agent/suggestions/:id/decline`): the member it waits for, or an owner. It is deleted.
 * - No token reaches these routes (automation-tokens.ts isRefusedToEveryToken refuses every token on /agent/ paths), and a
 *   moderator's session is refused by checkAdminAuth (not a moderator route).
 */
import Router from '@koa/router';
import type { RouteDeps } from '../routes/types.js';
import { requireAdminRole } from '../admin-auth.js';
import { getMember, getReports, type AbuseReport } from '../state-engine.js';
import { logger } from '../logger.js';
import { cleanMemberText } from './fence.js';
import { approveCall, declineSuggestion, openSuggestions, SUGGESTION_WORDS } from './suggestions.js';

export const AGENT_SUGGESTIONS_PATH = '/api/local/admin/agent/suggestions';

const ROLE_ERROR = "Only an owner or an admin of this node can see an AI assistant's suggestions";

const actorOf = (ctx: any): string | null =>
    (ctx.state?.isKeySession === true && typeof ctx.state?.actor === 'string' && ctx.state.actor ? ctx.state.actor : null);
const same = (a: string | null, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

async function personOnly(ctx: any, deps: RouteDeps): Promise<boolean> {
    if (!(await deps.checkAdminAuth(ctx))) return false;
    if (ctx.state?.automationTokenId) {
        ctx.status = 403;
        ctx.body = { error: "An automation token cannot see or answer an assistant's suggestions" };
        return false;
    }
    return requireAdminRole(ctx, ['owner', 'admin'], ROLE_ERROR);
}

function findReport(id: string): AbuseReport | null {
    const PAGE = 200;
    for (let offset = 0; ; offset += PAGE) {
        const { reports, total } = getReports('all', PAGE, offset);
        const hit = reports.find((r) => r.id === id);
        if (hit) return hit;
        if (!reports.length || offset + PAGE >= total) return null;
    }
}

/** The report as the moderation list shows it: the member-written words as plain text, never the reporter. */
function originalReport(r: AbuseReport | null) {
    if (!r) return null;
    const kind = r.targetPulseItemId ? 'pulse_item' : (r.targetPostId || r.postId) ? 'post' : 'member';
    return {
        id: r.id,
        at: r.createdAt,
        status: r.status === 'actioned' ? 'actioned' : r.status === 'reviewed' ? 'dismissed' : 'open',
        targetKind: kind,
        reason: cleanMemberText(r.reason, 500) || null,
        title: cleanMemberText(kind === 'pulse_item' ? r.pulseItem?.title : r.postTitle, 200) || null,
        description: kind === 'post' ? cleanMemberText(r.postDescription, 500) || null : null,
        author: cleanMemberText(kind === 'member' ? r.targetCallsign : r.postAuthorCallsign, 60) || null,
        postRemoved: r.postRemoved === true || r.pulseItem?.removed === true,
        hiddenByReports: r.postHiddenByReports === true,
    };
}

// Paths written out in full, so the route sweeps (test-automation-tokens.ts, test-guest-view.ts) find them.
export function createAgentSuggestionRoutes(deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/local/admin/agent/suggestions', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await personOnly(ctx, deps))) return;
        const me = actorOf(ctx);
        const owner = ctx.state?.adminRole === 'owner';
        const list = openSuggestions().filter((x) => owner || same(me, x.grant.member));
        ctx.body = {
            suggestions: list.map((x) => {
                const mine = same(me, x.grant.member);
                return {
                    id: x.id,
                    kind: x.kind,
                    asks: SUGGESTION_WORDS[x.kind],
                    at: x.at,
                    expiresAt: x.expiresAt,
                    agent: { id: x.grant.id, name: x.grant.name, member: cleanMemberText(getMember(x.grant.member)?.callsign ?? '', 60) || null },
                    /** The assistant's words: text from outside, shown as text beside the original, never as markup. */
                    reason: { untrusted: true, text: x.reason },
                    report: originalReport(findReport(x.target)),
                    mine,
                    approve: mine ? approveCall(x) : null,
                };
            }),
        };
    });

    router.post('/api/local/admin/agent/suggestions/:id/decline', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await personOnly(ctx, deps))) return;
        const id = String(ctx.params.id || '');
        const me = actorOf(ctx);
        const owner = ctx.state?.adminRole === 'owner';
        const hit = openSuggestions().find((x) => x.id === id && (owner || same(me, x.grant.member)));
        if (!hit || !declineSuggestion(id)) {
            ctx.status = 404;
            ctx.body = { error: 'No such suggestion waiting' };
            return;
        }
        const by = me ? me.substring(0, 12) : 'owner:password';
        logger.info('ADMIN', `Declined a suggestion by agent "${hit.grant.name}" (${hit.kind}, report ${hit.target}) by ${by} (${ctx.state?.adminRole})`);
        ctx.body = { declined: id };
    });

    return router;
}
