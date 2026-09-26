/**
 * Community Commons, Crowdfund Projects, and Community Decision routes.
 */

import Router from '@koa/router';
import {
    createProject, updateProject, deleteProject,
    getProjects, getAllProjects,
    getCommonsBalance,
    adminRejectProject,
    createDecision, getDecision, publicDecision, getAllDecisions, getOpenDecisions,
    castDecisionVote, tallyDecision,
    getDecisionVoiceCredits, getOwnDecisionVotes, getVoiceCredits, hasCompletedTrade,
    checkProposalStanding, isNodeMember,
} from '../state-engine.js';
import { NOT_A_MEMBER_ERROR, NOT_A_MEMBER_CODE } from '../engine/members.js';
import {
    getCrowdfundProjects, getCrowdfundProject,
    createCrowdfundProject, updateCrowdfundProject,
    pledgeToProject, deleteCrowdfundProject, db,
    isOperatorSwitchedOff, OPERATOR_SWITCHED_OFF_CREATE_ERROR, isMemberActive, INACTIVE_MEMBER_CREATE_ERROR,
} from '../db/db.js';
import { getThresholds } from '../config/local-config.js';
import { assertNotMuted } from '../engine/auto-moderation.js';
import { blockCrossNodeSettlement } from '../federation-settlement.js';
import { isAcceptablePhotoValue, AVATAR_FORMAT_ERROR } from '../engine/avatar.js';
import { respondProfileRefusal, respondIfMuted, isNote } from './profile-feature-gate.js';
import type { RouteDeps } from './types.js';

export function createCommonsRoutes(deps: RouteDeps): Router {
    const router = new Router();

// ===================== COMMUNITY COMMONS =====================

router.get('/api/commons/balance', async (ctx) => {
    ctx.body = { balance: getCommonsBalance() };
});

router.get('/api/commons/projects', async (ctx) => {
    ctx.body = { projects: getProjects() };
});

router.post('/api/commons/projects', async (ctx) => {
    const { proposerPubkey, title, description, requestedAmount } = (ctx as any).requestBody || {};
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    if (!title || !requestedAmount) {
        ctx.status = 400;
        ctx.body = { error: 'proposerPubkey, title, and requestedAmount are required' };
        return;
    }
    if (!isMemberActive(actor)) {
        ctx.status = 403;
        ctx.body = { error: INACTIVE_MEMBER_CREATE_ERROR };
        return;
    }
    if (isOperatorSwitchedOff(actor)) {
        ctx.status = 403;
        ctx.body = { error: OPERATOR_SWITCHED_OFF_CREATE_ERROR };
        return;
    }
    // A muted member (G3) proposes nothing other members read.
    if (respondIfMuted(ctx, actor)) return;
    const project = createProject(actor, title, description || '', Number(requestedAmount));
    if (!project) {
        ctx.status = 400;
        ctx.body = { error: 'Failed — must be a registered member, title/amount required' };
        return;
    }
    ctx.body = { success: true, project };
});

router.post('/api/commons/projects/update', async (ctx) => {
    const { proposerPubkey, projectId, title, description, requestedAmount } = (ctx as any).requestBody || {};
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    if (!projectId || !title || !requestedAmount) return ctx.throw(400, 'Missing fields');
    if (respondIfMuted(ctx, actor)) return;

    const success = updateProject(actor, projectId, title, description || '', Number(requestedAmount));
    if (!success) {
        return ctx.throw(400, 'Failed to update project. It might not exist, you might not own it, or it is no longer in a proposed state.');
    }
    ctx.body = { success: true };
});

router.post('/api/commons/projects/delete', async (ctx) => {
    const { proposerPubkey, projectId } = (ctx as any).requestBody || {};
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    if (!projectId) return ctx.throw(400, 'Missing projectId');
    
    const success = deleteProject(actor, projectId);
    if (!success) {
        return ctx.throw(400, 'Failed to delete project. It might not exist, you might not own it, or it is no longer in a proposed state.');
    }
    ctx.body = { success: true };
});

// ===================== COMMUNITY DECISIONS (§3.2–§3.8) =====================

// Ballots are secret (answer I): every response carries totals and the SIGNER's own vote only. Who voted
// how is never served — not in the list, the detail, or the decision_vote_cast broadcast.

/**
 * The signer's standing for pool (quadratic) votes: the number the server checks a vote's cost against
 * (qualifiedTradeValue), and whether they have ever completed a trade. Null for an unsigned caller.
 */
function myPoolVoting(actor: string | undefined): { voiceCredits: number; hasCompletedTrade: boolean } | null {
    if (!actor) return null;
    return { voiceCredits: getVoiceCredits(actor), hasCompletedTrade: hasCompletedTrade(actor) };
}

router.get('/api/commons/decisions', async (ctx) => {
    const status = ctx.query.status as any;
    const decisions = getAllDecisions(status);
    // Each card carries the signer's own vote (null if they haven't voted) — taken from authentication
    // only, never from a parameter, so the list never reveals how anyone else voted.
    const actor = (ctx.state as any)?.actor as string | undefined;
    const ownVotes = actor ? getOwnDecisionVotes(actor) : null;
    ctx.body = {
        decisions: decisions.map(d => ({
            ...publicDecision(d),
            tally: tallyDecision(d.id),
            myVote: ownVotes ? ownVotes.get(d.id) ?? null : null,
        })),
        myPoolVoting: myPoolVoting(actor),
        // Whether the signer may propose (earned standing, or a node admin). The one-open-Decision limit is
        // left to the apps, which already know the signer's open Decisions.
        canPropose: actor ? checkProposalStanding(actor).ok : false,
    };
});

router.get('/api/commons/decisions/:id', async (ctx) => {
    const decision = getDecision(ctx.params.id);
    if (!decision) return ctx.throw(404, 'Decision not found');
    const tally = tallyDecision(decision.id);
    // Voice credits are the signer's own: taken from authentication only, never from a query parameter.
    const actor = (ctx.state as any)?.actor as string | undefined;
    const voiceCredits = actor ? getDecisionVoiceCredits(decision.id, actor) : undefined;
    const myVote = actor ? getOwnDecisionVotes(actor, [decision.id]).get(decision.id) ?? null : null;
    ctx.body = { decision: publicDecision(decision), tally, voiceCredits, myVote };
});

router.post('/api/commons/decisions', async (ctx) => {
    const { title, description, touches, effect, subject, params, closesAt } = (ctx as any).requestBody || {};
    const actor = (ctx.state as any)?.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'Authentication required to propose a decision' };
        return;
    }
    if (!title || !touches || !effect) {
        ctx.status = 400;
        ctx.body = { error: 'title, touches, and effect are required' };
        return;
    }
    if (!description || description.trim().length < 10) {
        ctx.status = 400;
        ctx.body = { error: 'description must be at least 10 characters for governance accountability' };
        return;
    }
    const closesAtOverride = process.env.NODE_ENV === 'test' ? closesAt : undefined;
    try {
        // A muted member (G3) proposes nothing other members read; a vote carries no words and stays open.
        assertNotMuted(actor);
        const decision = createDecision({
            authorPubkey: actor,
            title,
            description: description.trim(),
            touches,
            effect,
            subject,
            params,
            closesAt: closesAtOverride,
        });
        ctx.body = { success: true, decision: publicDecision(decision) };
    } catch (err: any) {
        // A pool-money Decision with Beans off: 403 profile_no_beans (decisions-engine switchOffFor).
        if (respondProfileRefusal(ctx, err)) return;
        ctx.status = 400;
        ctx.body = { error: err.message };
    }
});

router.post('/api/commons/decisions/:id/vote', async (ctx) => {
    const { support, voteCount, signature } = (ctx as any).requestBody || {};
    const actor = (ctx.state as any)?.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'Authentication required to vote' };
        return;
    }
    if (support === undefined) {
        ctx.status = 400;
        ctx.body = { error: 'support (boolean) is required' };
        return;
    }
    const result = castDecisionVote(ctx.params.id, actor, Boolean(support), Number(voteCount || 1), signature);
    if (!result.success) {
        ctx.status = 400;
        ctx.body = { error: result.error };
        return;
    }
    ctx.body = { success: true, creditsUsed: result.creditsUsed };
});

// Decisions close and execute on the periodic tickDecisions() in state-engine.ts, every 60 seconds. There is
// no route for it: the one that used to be here needed a signature AND node admin credentials at once, which
// no client ever sent, so it only ever duplicated the timer. A POST to /api/commons/decisions/tick now gets
// 405 from allowedMethods() — the GET :id route above still matches that path — and runs nothing;
// test-decisions-tick-route-gone.ts pins it over real HTTPS.

// ==========================================
// CROWDFUNDING API
// ==========================================

router.get('/api/crowdfund/projects', async (ctx) => {
    ctx.body = { 
        projects: getCrowdfundProjects(),
        maxProjectExpiryDays: getThresholds().maxProjectExpiryDays 
    };
});

router.get('/api/crowdfund/projects/:id', async (ctx) => {
    const project = getCrowdfundProject(ctx.params.id);
    if (!project) return ctx.throw(404, 'Project not found');
    ctx.body = { project };
});

router.post('/api/crowdfund/projects', async (ctx) => {
    const { id, creatorPubkey, title, description, photos, goalAmount, deadlineAt } = (ctx as any).requestBody || {};
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    if (!title || !goalAmount) {
        ctx.status = 400;
        ctx.body = { error: 'creatorPubkey, title, and goalAmount are required' };
        return;
    }

    if (deadlineAt) {
        const maxDays = getThresholds().maxProjectExpiryDays;
        const diffDays = (new Date(deadlineAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        if (diffDays > maxDays) {
            ctx.status = 400;
            ctx.body = { error: `Project deadline cannot exceed ${maxDays} days` };
            return;
        }
    }

    if (photos !== undefined && photos !== null) {
        if (!Array.isArray(photos)) {
            ctx.status = 400;
            ctx.body = { error: 'photos must be an array' };
            return;
        }
        if (photos.length > 10) {
            ctx.status = 400;
            ctx.body = { error: 'A project can have at most 10 photos' };
            return;
        }
        // photos[0] becomes the enterprise's members.avatar_url, served by /api/avatar/:pubkey. Every one is served,
        // and one the node cannot strip (G9a-3: a HEIC, a TIFF) would keep its GPS, so all are held to the photo rule,
        // bare base64 included: the project's JSON hands each one out as stored.
        if (!photos.every((p: unknown) => isAcceptablePhotoValue(p))) {
            ctx.status = 400;
            ctx.body = { error: AVATAR_FORMAT_ERROR };
            return;
        }
    }

    const projectId = id || crypto.randomUUID();
    if (!isMemberActive(actor)) {
        ctx.status = 403;
        ctx.body = { error: INACTIVE_MEMBER_CREATE_ERROR };
        return;
    }
    if (isOperatorSwitchedOff(actor)) {
        ctx.status = 403;
        ctx.body = { error: OPERATOR_SWITCHED_OFF_CREATE_ERROR };
        return;
    }
    if (respondIfMuted(ctx, actor)) return;
    createCrowdfundProject(projectId, actor, title, description || '', photos || [], Number(goalAmount), deadlineAt || null);
    const project = getCrowdfundProject(projectId);
    deps.broadcast?.({ type: 'project_created', project });
    
    ctx.body = { success: true, project };
});

router.post('/api/crowdfund/projects/update', async (ctx) => {
    const { id, creatorPubkey, title, description, photos, goalAmount, deadlineAt } = (ctx as any).requestBody || {};
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    if (!id || !title || !goalAmount) {
        ctx.status = 400;
        ctx.body = { error: 'id, creatorPubkey, title, and goalAmount are required' };
        return;
    }

    if (deadlineAt) {
        const maxDays = getThresholds().maxProjectExpiryDays;
        const diffDays = (new Date(deadlineAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        if (diffDays > maxDays) {
            ctx.status = 400;
            ctx.body = { error: `Project deadline cannot exceed ${maxDays} days` };
            return;
        }
    }

    if (photos !== undefined && photos !== null) {
        if (!Array.isArray(photos)) {
            ctx.status = 400;
            ctx.body = { error: 'photos must be an array' };
            return;
        }
        if (photos.length > 10) {
            ctx.status = 400;
            ctx.body = { error: 'A project can have at most 10 photos' };
            return;
        }
        // photos[0] becomes the enterprise's members.avatar_url, served by /api/avatar/:pubkey. Every one is served,
        // and one the node cannot strip (G9a-3: a HEIC, a TIFF) would keep its GPS, so all are held to the photo rule,
        // bare base64 included: the project's JSON hands each one out as stored.
        if (!photos.every((p: unknown) => isAcceptablePhotoValue(p))) {
            ctx.status = 400;
            ctx.body = { error: AVATAR_FORMAT_ERROR };
            return;
        }
    }

    if (respondIfMuted(ctx, actor)) return;
    try {
        updateCrowdfundProject(id, actor, title, description || '', photos || [], Number(goalAmount), deadlineAt);
        const project = getCrowdfundProject(id);
        deps.broadcast?.({ type: 'project_updated', project });
        ctx.body = { success: true, project };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to update project' };
    }
});

router.post('/api/crowdfund/projects/delete', async (ctx) => {
    const { id, creatorPubkey } = (ctx as any).requestBody || {};
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    if (!id) {
        ctx.status = 400;
        ctx.body = { error: 'id and creatorPubkey are required' };
        return;
    }

    try {
        deleteCrowdfundProject(id, actor);
        deps.broadcast?.({ type: 'project_deleted', projectId: id });
        ctx.body = { success: true };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to delete project' };
    }
});

router.post('/api/crowdfund/projects/:id/pledge', async (ctx) => {
    const projectId = ctx.params.id;
    const { fromPubkey, amount, memo } = (ctx as any).requestBody || {};
    const actor = ctx.state.actor as string | undefined;
    if (!actor) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    const parsedAmount = Number(amount);
    
    // SECURITY (SRV-8): require a positive, finite amount. A negative parsedAmount
    // is truthy and previously slipped past `!parsedAmount`, relying on the
    // transactions CHECK(amount > 0) to abort mid-transaction.
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        ctx.status = 400;
        ctx.body = { error: 'fromPubkey and a positive amount are required' };
        return;
    }

    // Same defect as the ledger transfer route (#102): the guard here verified the
    // pledger's home balance and then pledged locally, so a visitor's pledge was minted
    // on this node. Refuse until charge-home settlement exists (#104).
    if (blockCrossNodeSettlement(ctx, actor)) return;
    // pledgeToProject moves the Beans itself, not through transfer(), so nothing below asks who the pledger is: a
    // pruned account, or the old key of a member being re-keyed (a lost or stolen phone), still holds its balance.
    if (!isNodeMember(actor)) {
        ctx.status = 403;
        ctx.body = { error: NOT_A_MEMBER_ERROR, code: NOT_A_MEMBER_CODE };
        return;
    }
    // A note with a pledge is words the project's creator reads: a muted member (G3) pledges without one.
    if (isNote(memo) && respondIfMuted(ctx, actor)) return;

    try {
        const txId = crypto.randomUUID();
        pledgeToProject(txId, projectId, actor, parsedAmount, memo || 'Project Pledge', (ctx.state as any).authSig);
        const updatedProject = getCrowdfundProject(projectId);
        deps.broadcast?.({ type: 'project_updated', project: updatedProject });
        ctx.body = { success: true, txId };
    } catch (err: any) {
        ctx.status = 400;
        ctx.body = { error: err.message };
    }
});

    return router;
}
