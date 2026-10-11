/**
 * A chat group's votes (DESIGN-group-decisions §2.3–§2.6, slice S3): the community Decision engine, scoped to one group
 * (a guild, a working group, a social circle). The group is the PATH's, never a body field; the actor is the signer the
 * middleware verified, never a body field. Inside it the group's members (any role) see its votes and its members and
 * convenors vote; observers watch; anyone else, and anyone who left, sees only the votes they were on the roll of, and
 * everything else is answered as if it were missing (404), as a group post is.
 *
 * While a vote is open its card shows turnout only; Yes and No once it has closed (Marty's pick 3). Ballots are secret.
 */
import Router from '@koa/router';
import {
    createScopedDecision, getGroupDecisions, getGroupDecision, castDecisionVote, getOwnDecisionVotes, publicDecision,
    scopedTallyForReader, groupRollNow, decisionsOn, ScopedNotFoundError, type Decision,
} from '../decisions-engine.js';
import { groupClosedAt } from '../state-engine.js';
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

export function createGroupDecisionRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/groups/:id/decisions', async (ctx) => {
        const actor = (ctx.state as any)?.actor as string | undefined;
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required' }; return; }
        try {
            const decisions = getGroupDecisions(ctx.params.id, actor);
            const roll = groupRollNow(ctx.params.id);
            const closedAt = groupClosedAt(ctx.params.id);
            const onRoll = roll.some(k => k.pubkey === actor);
            ctx.body = {
                decisions: decisions.map(d => card(d, actor)),
                // A roll of one holds no vote (§2.2), an observer proposes nothing, a closed group takes no vote.
                canPropose: decisionsOn() && !closedAt && roll.length >= 2 && onRoll,
                onRoll,
                rollSize: roll.length,
                closedAt,
            };
        } catch (err) {
            if (err instanceof ScopedNotFoundError) return notFound(ctx);
            throw err;
        }
    });

    router.get('/api/groups/:id/decisions/:decisionId', async (ctx) => {
        const actor = (ctx.state as any)?.actor as string | undefined;
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required' }; return; }
        try {
            const d = getGroupDecision(ctx.params.id, ctx.params.decisionId, actor);
            ctx.body = { decision: card(d, actor) };
        } catch (err) {
            if (err instanceof ScopedNotFoundError) return notFound(ctx);
            throw err;
        }
    });

    router.post('/api/groups/:id/decisions', async (ctx) => {
        const actor = (ctx.state as any)?.actor as string | undefined;
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required to propose a vote' }; return; }
        const { title, description, effect, subject, params } = (ctx as any).requestBody || {};
        try {
            // A muted member (G3) proposes nothing other members read.
            assertNotMuted(actor);
            const decision = createScopedDecision({
                scopeKind: 'group',
                scopeId: ctx.params.id,
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

    router.post('/api/groups/:id/decisions/:decisionId/vote', async (ctx) => {
        const actor = (ctx.state as any)?.actor as string | undefined;
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required to vote' }; return; }
        const { support, signature } = (ctx as any).requestBody || {};
        if (typeof support !== 'boolean') { ctx.status = 400; ctx.body = { error: 'support (true or false) is required' }; return; }
        try {
            getGroupDecision(ctx.params.id, ctx.params.decisionId, actor);
        } catch (err) {
            if (err instanceof ScopedNotFoundError) return notFound(ctx);
            throw err;
        }
        const result = castDecisionVote(ctx.params.decisionId, actor, support, 1, typeof signature === 'string' ? signature : undefined, 'group');
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
