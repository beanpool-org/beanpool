/**
 * Admin Management routes — password-gated actions for user management,
 * moderation, diagnostics, and admin inbox.
 */

import Router from '@koa/router';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    getAllMembers, getAllProfiles, getMember,
    getPosts, getCommunityHealth,
    getReports, getReportCount,
    adminSetUserStatus, adminSetCreditFrozen, adminSetElder, adminSetVoucher, adminSetTier,
    adminDeletePost, adminPruneUser, adminBulkDeletePosts,
    adminPruneBranch, adminBroadcastAnnouncement, adminSendMessage,
    dismissReport, actionReport,
    getAdminPubkey,
    canVouch,
    getMemberStats,
    getConversationsByMember, getConversationMessages, getUnreadCounts,
    getNodeConfig, updateNodeConfig,
    createVotingRound, closeVotingRound, adminRejectProject,
    getActiveRound, getGovernanceCredits,
    getVotingRounds, getCommonsBalance,
} from '../state-engine.js';
import {
    getLocalConfig, verifyPasswordAsync, verifyReplicationToken,
    getGatewayConfig, updateGatewayConfig,
} from '../config/local-config.js';
import { getConnectors } from '../connector-manager.js';
import { logger } from '../logger.js';
import { db, getCrowdfundProjects } from '../db/db.js';
import type { RouteDeps } from './types.js';

export function createAdminRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth, activeConnections, calculateAnalytics } = deps;


// ===================== ADMIN ACTIONS (Requires Password) =====================

router.post('/api/local/admin/data', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = {
        // Enrich each member with canVouch — the admin panel's voucher toggle reflects it.
        // (rowToMember drops the can_vouch column, so surface it explicitly here.)
        members: getAllMembers().map(m => ({ ...m, canVouch: canVouch(m.publicKey) })),
        profiles: getAllProfiles(),
        posts: getPosts().filter(p => p.status !== 'cancelled'),
        health: getCommunityHealth(),
        reports: getReports(),
        reportCount: getReportCount(),
        memberStats: getMemberStats(),
    };
});

router.post('/api/local/admin/ws-connections', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = {
        connections: Array.from(activeConnections.values()),
        analytics: calculateAnalytics()
    };
});

router.post('/api/local/admin/logs', async (ctx) => {
    const token = ctx.request.header['x-replication-token'] || (ctx as any).requestBody?.token;
    const isTokenValid = token && (await verifyReplicationToken(String(token)));
    if (!isTokenValid && !(await checkAdminAuth(ctx as any))) return;
    const { level, category, searchQuery, limit = 100, offset = 0 } = (ctx as any).requestBody || {};

    let sql = 'SELECT * FROM system_logs WHERE 1=1';
    const params: any[] = [];

    if (level && level !== 'ALL') {
        sql += ' AND level = ?';
        params.push(level);
    }
    if (category && category !== 'ALL') {
        sql += ' AND category = ?';
        params.push(category);
    }
    if (searchQuery) {
        sql += ' AND message LIKE ?';
        params.push(`%${searchQuery}%`);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    try {
        const rows = db.prepare(sql).all(...params) as any[];
        ctx.body = { success: true, logs: rows };
    } catch (e: any) {
        console.error('Error fetching logs:', e);
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

router.post('/api/local/admin/diagnostics', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;

    try {
        const cpusCount = os.cpus().length;
        const cpuLoad = Math.min(Math.round((os.loadavg()[0] / cpusCount) * 100), 100);

        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const ramUsage = Math.round((usedMem / totalMem) * 100);

        const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
        const dbPath = path.join(DATA_DIR, 'state.db');
        let dbSize = 0;
        let walSize = 0;
        try {
            if (fs.existsSync(dbPath)) {
                dbSize = fs.statSync(dbPath).size;
            }
            const walPath = `${dbPath}-wal`;
            if (fs.existsSync(walPath)) {
                walSize = fs.statSync(walPath).size;
            }
        } catch (err) {}

        const connectors = getConnectors() || [];
        const activePeers = connectors.filter(c => c.connected).length;
        const totalPeers = connectors.length;

        ctx.body = {
            success: true,
            diagnostics: {
                cpuLoad,
                cpusCount,
                totalMem,
                freeMem,
                usedMem,
                ramUsage,
                dbSize,
                walSize,
                uptime: Math.round(process.uptime()),
                activePeers,
                totalPeers,
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch
            }
        };
    } catch (e: any) {
        console.error('Error fetching diagnostics:', e);
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});


router.post('/api/local/admin/posts/:id/delete', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        adminDeletePost(ctx.params.id);
        ctx.body = { success: true };
    } catch (e: any) {
        console.error('Error deleting post:', e);
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

router.post('/api/local/admin/users/:pubkey/status', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { status } = (ctx as any).requestBody || {};
    if (status === 'active' || status === 'disabled') {
        adminSetUserStatus(ctx.params.pubkey, status);
    }
    ctx.body = { success: true };
});

router.post('/api/local/admin/users/:pubkey/freeze', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || {};
    const freeze = body.freeze === true;
    try {
        adminSetCreditFrozen(ctx.params.pubkey, freeze);
        logger.info('ADMIN', `${freeze ? 'Froze' : 'Unfroze'} credit floor for ${ctx.params.pubkey.substring(0, 12)}`);
        ctx.body = { success: true, frozen: freeze };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e?.message || 'Failed to update credit freeze status' };
    }
});

// Promote a member to (or demote from) the Elder tier — grants Elder *standing* (a deep
// credit floor via granted credit), but NOT password-admin powers. NOTE: Elder standing no
// longer confers the power to vouch; that is the separate, explicit voucher capability below.
// Body: { password, grant?: boolean } (defaults to grant).
router.post('/api/local/admin/users/:pubkey/elder', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || {};
    const grant = body.grant !== false; // default: grant
    try {
        adminSetElder(ctx.params.pubkey, grant);
        logger.info('ADMIN', `${grant ? 'Granted' : 'Revoked'} Elder for ${ctx.params.pubkey.substring(0, 12)}`);
        ctx.body = { success: true, granted: grant };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e?.message || 'Failed to update Elder status' };
    }
});

// Grant or revoke the vouch capability (the "appointed voucher" / super-Elder switch). This
// is the single Sybil-critical power: an appointed voucher can hand out the -20 credit floor
// to newcomers. Admin-only, decoupled from tier so grinding to Elder never confers it.
// Body: { password, grant?: boolean } (defaults to grant).
router.post('/api/local/admin/users/:pubkey/voucher', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || {};
    const grant = body.grant !== false; // default: grant
    try {
        adminSetVoucher(ctx.params.pubkey, grant);
        logger.info('ADMIN', `${grant ? 'Granted' : 'Revoked'} vouch capability for ${ctx.params.pubkey.substring(0, 12)}`);
        ctx.body = { success: true, granted: grant };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e?.message || 'Failed to update voucher capability' };
    }
});

// Assign a TIER BADGE to a member. The badge grants that tier's trust value (granted-credit
// lane), landing the member's floor at the tier entry: Resident -200, Steward -600, Elder
// -1400, Newcomer clears it. Distinct from the vouch capability above. Body: { password, tier }.
router.post('/api/local/admin/users/:pubkey/tier', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || {};
    const tier = body.tier;
    if (!['Newcomer', 'Resident', 'Steward', 'Elder'].includes(tier)) {
        ctx.status = 400;
        ctx.body = { error: 'tier must be one of Newcomer, Resident, Steward, Elder' };
        return;
    }
    try {
        adminSetTier(ctx.params.pubkey, tier);
        logger.info('ADMIN', `Set tier ${tier} for ${ctx.params.pubkey.substring(0, 12)}`);
        ctx.body = { success: true, tier };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e?.message || 'Failed to set tier' };
    }
});

router.post('/api/local/admin/users/:pubkey/prune', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    adminPruneUser(ctx.params.pubkey);
    ctx.body = { success: true };
});

router.post('/api/local/admin/branches/:pubkey/prune', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    adminPruneBranch(ctx.params.pubkey);
    ctx.body = { success: true };
});

router.post('/api/local/admin/announcements', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { title, body, severity } = (ctx as any).requestBody || {};
    adminBroadcastAnnouncement(title || 'System Announcement', body || '', severity || 'info');
    ctx.body = { success: true };
});

// ======================== MODERATION: REPORT MANAGEMENT ========================

router.post('/api/local/admin/reports/:id/dismiss', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const ok = dismissReport(ctx.params.id);
    ctx.body = { success: ok };
});

router.post('/api/local/admin/reports/:id/action', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { deletePost } = (ctx as any).requestBody || {};
    const ok = actionReport(ctx.params.id, !!deletePost);
    ctx.body = { success: ok };
});

router.post('/api/local/admin/posts/bulk-delete', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { postIds } = (ctx as any).requestBody || {};
    if (!Array.isArray(postIds) || postIds.length === 0) {
        ctx.status = 400;
        ctx.body = { error: 'postIds array required' };
        return;
    }
    const deleted = adminBulkDeletePosts(postIds);
    ctx.body = { success: true, deleted };
});


router.post('/api/local/admin/inbox', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const adminPubkey = getAdminPubkey();
    const convs = getConversationsByMember(adminPubkey);
    // Also grab any legacy 'system' conversations.
    // Use a Set for O(N) dedup instead of an O(N^2) nested .find().
    const convIds = new Set(convs.map(c => c.id));
    const legacyConvs = getConversationsByMember('system').filter(c => !convIds.has(c.id));
    const allConvs = [...convs, ...legacyConvs];
    const unreadCounts = getUnreadCounts(adminPubkey);
    const inbox = allConvs.map(c => ({
        ...c,
        messages: getConversationMessages(c.id, 50),
        unreadCount: unreadCounts[c.id] || 0,
    }));
    ctx.body = { conversations: inbox, adminPubkey };
});

router.post('/api/local/admin/inbox/send', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { targetPubkey, message } = (ctx as any).requestBody || {};
    adminSendMessage(targetPubkey, message || '');
    ctx.body = { success: true };
});

router.post('/api/local/admin/commons/round', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { action, projectIds, closesAt, roundId } = (ctx as any).requestBody || {};
    if (action === 'create') {
        if (!projectIds?.length || !closesAt) {
            ctx.status = 400;
            ctx.body = { error: 'projectIds and closesAt required' };
            return;
        }
        const round = createVotingRound(getAdminPubkey(), projectIds, closesAt);
        if (!round) {
            ctx.status = 400;
            ctx.body = { error: 'Failed — another round may be open, or not admin' };
            return;
        }
        ctx.body = { success: true, round };
    } else if (action === 'close') {
        if (!roundId) {
            ctx.status = 400;
            ctx.body = { error: 'roundId required' };
            return;
        }
        const result = closeVotingRound(roundId);
        if (!result.success) {
            ctx.status = 400;
            ctx.body = { error: result.error };
            return;
        }
        ctx.body = { success: true, winner: result.winner || null };
    } else {
        ctx.status = 400;
        ctx.body = { error: 'action must be "create" or "close"' };
    }
});

// Admin: reject a project
router.post('/api/local/admin/commons/reject', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { projectId } = (ctx as any).requestBody || {};
    if (!projectId) {
        ctx.status = 400;
        ctx.body = { error: 'projectId required' };
        return;
    }
    adminRejectProject(projectId);
    ctx.body = { success: true };
});

// Admin: get all projects (unified — reads from crowdfund SQL table)
router.post('/api/local/admin/commons/projects', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const crowdfundProjects = getCrowdfundProjects();
    // Map crowdfund schema to commons admin UI shape
    const projects = crowdfundProjects.map(p => {
        const member = getMember(p.creator_pubkey);
        return {
            id: p.id,
            title: p.title,
            description: p.description,
            proposerPubkey: p.creator_pubkey,
            proposerCallsign: member?.callsign || 'Unknown',
            requestedAmount: p.goal_amount,
            currentAmount: p.current_amount,
            status: (p.status || 'ACTIVE').toLowerCase(),
            votes: [],   // voting rounds still tracked in node_config
            createdAt: p.created_at,
            photos: p.photos,
        };
    });
    ctx.body = { projects, rounds: getVotingRounds(), balance: getCommonsBalance() };
});

// ===================== GATEWAY CONFIGURATION =====================

router.get('/api/local/admin/gateway', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = getGatewayConfig();
});

router.post('/api/local/admin/gateway', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || {};
    const updated = updateGatewayConfig(body);
    ctx.body = { success: true, gateway: updated };
});

    return router;
}
