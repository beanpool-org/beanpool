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
    getMember,
} from '../state-engine.js';
import {
    getCrowdfundProjects, getCrowdfundProject,
    createCrowdfundProject, updateCrowdfundProject,
    pledgeToProject, deleteCrowdfundProject, db,
} from '../db/db.js';
import { getThresholds } from '../config/local-config.js';
import { getConnectorByPublicUrl } from '../connector-manager.js';
import { federatedVerifyMember } from '../federation-protocol.js';
import { getP2PNode } from '../p2p.js';
import { PROTOCOL_CONSTANTS } from '@beanpool/core';
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
    if (!proposerPubkey || !title || !requestedAmount) {
        ctx.status = 400;
        ctx.body = { error: 'proposerPubkey, title, and requestedAmount are required' };
        return;
    }
    const project = createProject(proposerPubkey, title, description || '', Number(requestedAmount));
    if (!project) {
        ctx.status = 400;
        ctx.body = { error: 'Failed — must be a registered member, title/amount required' };
        return;
    }
    ctx.body = { success: true, project };
});

router.post('/api/commons/projects/update', async (ctx) => {
    const { proposerPubkey, projectId, title, description, requestedAmount } = (ctx as any).requestBody || {};
    if (!proposerPubkey || typeof proposerPubkey !== 'string') return ctx.throw(400, 'Invalid pubkey');
    if (!projectId || !title || !requestedAmount) return ctx.throw(400, 'Missing fields');
    
    const success = updateProject(proposerPubkey, projectId, title, description || '', Number(requestedAmount));
    if (!success) {
        return ctx.throw(400, 'Failed to update project. It might not exist, you might not own it, or it is no longer in a proposed state.');
    }
    ctx.body = { success: true };
});

router.post('/api/commons/projects/delete', async (ctx) => {
    const { proposerPubkey, projectId } = (ctx as any).requestBody || {};
    if (!proposerPubkey || typeof proposerPubkey !== 'string') return ctx.throw(400, 'Invalid pubkey');
    if (!projectId) return ctx.throw(400, 'Missing projectId');
    
    const success = deleteProject(proposerPubkey, projectId);
    if (!success) {
        return ctx.throw(400, 'Failed to delete project. It might not exist, you might not own it, or it is no longer in a proposed state.');
    }
    ctx.body = { success: true };
});

router.post('/api/commons/vote', async (ctx) => {
    const { voterPubkey, projectId, voteCount } = (ctx as any).requestBody || {};
    if (!voterPubkey || !projectId) {
        ctx.status = 400;
        ctx.body = { error: 'voterPubkey and projectId are required' };
        return;
    }
    const result = voteForProject(voterPubkey, projectId, voteCount ? Number(voteCount) : 1);
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
    if (!creatorPubkey || !title || !goalAmount) {
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
    createCrowdfundProject(projectId, creatorPubkey, title, description || '', photos || [], Number(goalAmount), deadlineAt || null);
    const project = getCrowdfundProject(projectId);
    
    ctx.body = { success: true, project };
});

router.post('/api/crowdfund/projects/update', async (ctx) => {
    const { id, creatorPubkey, title, description, photos, goalAmount, deadlineAt } = (ctx as any).requestBody || {};
    if (!id || !creatorPubkey || !title || !goalAmount) {
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
        updateCrowdfundProject(id, creatorPubkey, title, description || '', photos || [], Number(goalAmount), deadlineAt);
        const project = getCrowdfundProject(id);
        ctx.body = { success: true, project };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to update project' };
    }
});

router.post('/api/crowdfund/projects/delete', async (ctx) => {
    const { id, creatorPubkey } = (ctx as any).requestBody || {};
    if (!id || !creatorPubkey) {
        ctx.status = 400;
        ctx.body = { error: 'id and creatorPubkey are required' };
        return;
    }

    try {
        deleteCrowdfundProject(id, creatorPubkey);
        ctx.body = { success: true };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message || 'Failed to delete project' };
    }
});

router.post('/api/crowdfund/projects/:id/pledge', async (ctx) => {
    const projectId = ctx.params.id;
    const { fromPubkey, amount, memo } = (ctx as any).requestBody || {};
    const parsedAmount = Number(amount);
    
    // SECURITY (SRV-8): require a positive, finite amount. A negative parsedAmount
    // is truthy and previously slipped past `!parsedAmount`, relying on the
    // transactions CHECK(amount > 0) to abort mid-transaction.
    if (!fromPubkey || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        ctx.status = 400;
        ctx.body = { error: 'fromPubkey and a positive amount are required' };
        return;
    }

    // --- FEDERATION VERIFY ---
    try {
        const fromMember = getMember(fromPubkey);
        if (fromMember && fromMember.homeNodeUrl) {
            const p2pNode = getP2PNode();
            if (p2pNode) {
                const targetConnector = getConnectorByPublicUrl(fromMember.homeNodeUrl);
                if (targetConnector && targetConnector.peerId) {
                    const verifyResult = await federatedVerifyMember(p2pNode, targetConnector.peerId, fromPubkey);
                    const homeBalance = verifyResult?.homeBalance ?? 0;
                    const floor = PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR; // use base floor for conservative federation check
                    if (!verifyResult || !verifyResult.isMember || (homeBalance - parsedAmount < floor)) {
                        ctx.status = 400;
                        ctx.body = { error: 'Federation check failed: Insufficient funds on home node or member not recognized.' };
                        return;
                    }
                }
            }
        }
    } catch (e) {
        console.error('[Federation] Error verifying remote member:', e);
        ctx.status = 502;
        ctx.body = { error: 'Federation check failed: Could not reach home node.' };
        return;
    }
    // -------------------------

    try {
        const txId = crypto.randomUUID();
        pledgeToProject(txId, projectId, fromPubkey, parsedAmount, memo || 'Project Pledge', (ctx.state as any).authSig);
        ctx.body = { success: true, txId };
    } catch (err: any) {
        ctx.status = 400;
        ctx.body = { error: err.message };
    }
});

// Admin: create/close voting rounds

    return router;
}
