/**
 * Community Commons, Crowdfund Projects, and Voting Round routes.
 */

import Router from '@koa/router';
import {
    createProject, updateProject, deleteProject, voteForProject,
    createVotingRound, closeVotingRound,
    getProjects, getAllProjects, getVotingRounds, getActiveRound,
    getCommonsBalance, getGovernanceCredits,
    adminRejectProject,
} from '../state-engine.js';
import {
    getCrowdfundProjects, getCrowdfundProject,
    createCrowdfundProject, updateCrowdfundProject,
    pledgeToProject, deleteCrowdfundProject, db,
} from '../db/db.js';
import { getThresholds } from '../config/local-config.js';
import { blockCrossNodeSettlement } from '../federation-settlement.js';
import type { RouteDeps } from './types.js';

export function createCommonsRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

// ===================== COMMUNITY COMMONS =====================

router.get('/api/commons/balance', async (ctx) => {
    ctx.body = { balance: getCommonsBalance() };
});

router.get('/api/commons/projects', async (ctx) => {
    ctx.body = { projects: getProjects(), activeRound: getActiveRound() };
});

router.post('/api/commons/projects', async (ctx) => {
    const { proposerPubkey, title, description, requestedAmount } = (ctx as any).requestBody || {};
    const actor = (ctx.state.actor as string) || proposerPubkey;
    if (!actor || !title || !requestedAmount) {
        ctx.status = 400;
        ctx.body = { error: 'proposerPubkey, title, and requestedAmount are required' };
        return;
    }
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
    const actor = (ctx.state.actor as string) || proposerPubkey;
    if (!actor || typeof actor !== 'string') return ctx.throw(400, 'Invalid pubkey');
    if (!projectId || !title || !requestedAmount) return ctx.throw(400, 'Missing fields');
    
    const success = updateProject(actor, projectId, title, description || '', Number(requestedAmount));
    if (!success) {
        return ctx.throw(400, 'Failed to update project. It might not exist, you might not own it, or it is no longer in a proposed state.');
    }
    ctx.body = { success: true };
});

router.post('/api/commons/projects/delete', async (ctx) => {
    const { proposerPubkey, projectId } = (ctx as any).requestBody || {};
    const actor = (ctx.state.actor as string) || proposerPubkey;
    if (!actor || typeof actor !== 'string') return ctx.throw(400, 'Invalid pubkey');
    if (!projectId) return ctx.throw(400, 'Missing projectId');
    
    const success = deleteProject(actor, projectId);
    if (!success) {
        return ctx.throw(400, 'Failed to delete project. It might not exist, you might not own it, or it is no longer in a proposed state.');
    }
    ctx.body = { success: true };
});

router.post('/api/commons/vote', async (ctx) => {
    const { voterPubkey, projectId, voteCount } = (ctx as any).requestBody || {};
    const actor = (ctx.state.actor as string) || voterPubkey;
    if (!actor || !projectId) {
        ctx.status = 400;
        ctx.body = { error: 'voterPubkey and projectId are required' };
        return;
    }
    const result = voteForProject(actor, projectId, voteCount ? Number(voteCount) : 1);
    if (!result.success) {
        ctx.status = 400;
        ctx.body = { error: result.error };
        return;
    }
    ctx.body = { success: true, creditsUsed: result.creditsUsed };
});

router.get('/api/commons/my-credits/:pubkey', async (ctx) => {
    const { pubkey } = ctx.params;
    if (!pubkey) {
        ctx.status = 400;
        ctx.body = { error: 'pubkey is required' };
        return;
    }
    ctx.body = getGovernanceCredits(pubkey);
});

router.get('/api/commons/rounds', async (ctx) => {
    ctx.body = { rounds: getVotingRounds(), activeRound: getActiveRound() };
});

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
    const actor = (ctx.state.actor as string) || creatorPubkey;
    if (!actor || !title || !goalAmount) {
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

    const projectId = id || crypto.randomUUID();
    createCrowdfundProject(projectId, actor, title, description || '', photos || [], Number(goalAmount), deadlineAt || null);
    const project = getCrowdfundProject(projectId);
    deps.broadcast?.({ type: 'project_created', project });
    
    ctx.body = { success: true, project };
});

router.post('/api/crowdfund/projects/update', async (ctx) => {
    const { id, creatorPubkey, title, description, photos, goalAmount, deadlineAt } = (ctx as any).requestBody || {};
    const actor = (ctx.state.actor as string) || creatorPubkey;
    if (!id || !actor || !title || !goalAmount) {
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
    const actor = (ctx.state.actor as string) || creatorPubkey;
    if (!id || !actor) {
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
    const actor = (ctx.state.actor as string) || fromPubkey;
    const parsedAmount = Number(amount);
    
    // SECURITY (SRV-8): require a positive, finite amount. A negative parsedAmount
    // is truthy and previously slipped past `!parsedAmount`, relying on the
    // transactions CHECK(amount > 0) to abort mid-transaction.
    if (!actor || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        ctx.status = 400;
        ctx.body = { error: 'fromPubkey and a positive amount are required' };
        return;
    }

    // Same defect as the ledger transfer route (#102): the guard here verified the
    // pledger's home balance and then pledged locally, so a visitor's pledge was minted
    // on this node. Refuse until charge-home settlement exists (#104).
    if (blockCrossNodeSettlement(ctx, actor)) return;

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

// Admin: create/close voting rounds

    return router;
}
