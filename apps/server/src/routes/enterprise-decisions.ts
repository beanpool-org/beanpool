/**
 * An enterprise's keepers' votes (DESIGN-group-decisions §2.1, slice S1): the community Decision engine, scoped to one
 * enterprise. The enterprise is the PATH's, never a body field; the actor is the signer the middleware verified, never a
 * body field. Each route is a signed member's (off the public allowlist, so the ordinary read gate answers anyone else),
 * and inside it only the enterprise's keepers, and those on a vote's roll, may see or do anything: everyone else is
 * answered as if it were missing (404), as a group post is.
 *
 * While a vote is open its card shows turnout only (how many of the roll have voted); Yes and No once it has closed
 * (Marty's pick 3, 2026-10-10). Ballots are secret: totals and the signer's own vote, never who voted how.
 */
import Router from '@koa/router';
import {
    createScopedDecision, getScopedDecisions, getScopedDecision, castDecisionVote, getOwnDecisionVotes, publicDecision,
    scopedTallyForReader, enterpriseRollNow, decisionsOn, ScopedNotFoundError, type Decision,
} from '../decisions-engine.js';
import { assertNotMuted } from '../engine/auto-moderation.js';
import { FEATURE_OFF } from '../config/node-profile.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import { memberErrorText, SERVER_FAULT_TEXT } from './member-error-text.js';
import type { RouteDeps } from './types.js';

function notFound(ctx: any): void {
    ctx.status = 404;
    ctx.body = { error: 'Not found' };
}

function card(d: Decision, actor: string) {
    const mine = getOwnDecisionVotes(actor, [d.id]).get(d.id);
    return {
        ...publicDecision(d),
        tally: scopedTallyForReader(d),
        myVote: mine ? { support: mine.support, updatedAt: mine.updatedAt } : null,
    };
}

export function createEnterpriseDecisionRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/enterprise/:treasury/decisions', async (ctx) => {
        const actor = (ctx.state as any)?.actor as string | undefined;
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required' }; return; }
        try {
            const decisions = getScopedDecisions(ctx.params.treasury, actor);
            const roll = enterpriseRollNow(ctx.params.treasury);
            ctx.body = {
                decisions: decisions.map(d => card(d, actor)),
                // A roll of one holds no vote (§2.2): the apps show no propose button then.
                canPropose: decisionsOn() && roll.length >= 2 && roll.some(k => k.pubkey === actor),
                rollSize: roll.length,
            };
        } catch (err) {
            if (err instanceof ScopedNotFoundError) return notFound(ctx);
            throw err;
        }
    });

    router.get('/api/enterprise/:treasury/decisions/:id', async (ctx) => {
        const actor = (ctx.state as any)?.actor as string | undefined;
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required' }; return; }
        try {
            const d = getScopedDecision(ctx.params.treasury, ctx.params.id, actor);
            ctx.body = { decision: card(d, actor) };
        } catch (err) {
            if (err instanceof ScopedNotFoundError) return notFound(ctx);
            throw err;
        }
    });

    router.post('/api/enterprise/:treasury/decisions', async (ctx) => {
        const actor = (ctx.state as any)?.actor as string | undefined;
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required to propose a vote' }; return; }
        const { title, description, effect, subject, params } = (ctx as any).requestBody || {};
        try {
            // A muted member (G3) proposes nothing other members read.
            assertNotMuted(actor);
            const decision = createScopedDecision({
                scopeKind: 'enterprise',
                scopeId: ctx.params.treasury,
                authorPubkey: actor,
                title,
                description,
                effect,
                subject,
                params,
            });
            ctx.body = { success: true, decision: card(decision, actor) };
        } catch (err: any) {
            if (err instanceof ScopedNotFoundError) return notFound(ctx);
            if (respondProfileRefusal(ctx, err)) return;
            ctx.status = 400;
            ctx.body = { error: memberErrorText(err, SERVER_FAULT_TEXT) };
        }
    });

    router.post('/api/enterprise/:treasury/decisions/:id/vote', async (ctx) => {
        const actor = (ctx.state as any)?.actor as string | undefined;
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required to vote' }; return; }
        const { support, signature } = (ctx as any).requestBody || {};
        if (typeof support !== 'boolean') { ctx.status = 400; ctx.body = { error: 'support (true or false) is required' }; return; }
        try {
            getScopedDecision(ctx.params.treasury, ctx.params.id, actor);
        } catch (err) {
            if (err instanceof ScopedNotFoundError) return notFound(ctx);
            throw err;
        }
        const result = castDecisionVote(ctx.params.id, actor, support, 1, typeof signature === 'string' ? signature : undefined);
        if (!result.success) {
            if (result.code === FEATURE_OFF) {
                ctx.status = 404;
                ctx.body = { error: result.error, code: result.code, feature: 'decisions' };
                return;
            }
            ctx.status = 400;
            ctx.body = { error: result.error };
            return;
        }
        ctx.body = { success: true };
    });

    return router;
}
