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
    runLedgerAudit,
} from '../state-engine.js';
import {
    getLocalConfig, verifyPasswordAsync, verifyReplicationToken,
    getGatewayConfig, updateGatewayConfig,
} from '../config/local-config.js';
import { getConnectors } from '../connector-manager.js';
import { logger } from '../logger.js';
import { db, getCrowdfundProjects } from '../db/db.js';
import { getFunnel, clampDays } from '../engine/funnel.js';
import { issueCsrfToken, issueWsTicket } from '../admin-auth.js';
import type { RouteDeps } from './types.js';

export function createAdminRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth, activeConnections, calculateAnalytics } = deps;

// ===================== WS TICKET ENDPOINT =====================
// Issues short-lived single-use ticket for WebSocket authentication to avoid exposing
// admin passwords in URL query strings (which browser console & proxy logs capture).
router.post('/api/local/admin/ws-ticket', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const ticket = issueWsTicket();
    ctx.body = { ticket };
});

// ===================== CSRF TOKEN ENDPOINT =====================
// #133: Clients call this with their password to receive a short-lived CSRF token.
// The token must be sent as X-CSRF-Token on subsequent admin state-mutation requests.
// This provides defence-in-depth beyond the X-Admin-Password header.

router.post('/api/local/admin/csrf-token', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const token = issueCsrfToken();
    ctx.set('X-CSRF-Token', token);
    ctx.body = { csrfToken: token };
});

// ===================== LEDGER AUDIT ENDPOINTS =====================
// #129: On-demand audit + drift acknowledgment endpoints.
// Operators can call ledger-audit to inspect the current conservation state,
// and ledger-rebaseline to acknowledge known pre-existing drift with a written note.

router.post('/api/local/admin/ledger-audit', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const result = runLedgerAudit();
        ctx.body = {
            success: true,
            sumBalances: result.sumBalances,
            baseline: result.baseline,
            drift: result.drift,
            strandedEscrows: result.strandedEscrows,
            ok: result.ok,
        };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, error: e?.message || 'Ledger audit failed' };
    }
});

router.post('/api/local/admin/ledger-rebaseline', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    // #129: Rebaseline MUST include a written explanation so drift is documented,
    // not silently accepted. "I rebaselined" with no context is not acceptable.
    const { reason } = (ctx as any).requestBody || {};
    if (!reason || String(reason).trim().length < 10) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'reason is required (minimum 10 characters) — document why the drift is acceptable' };
        return;
    }
    // Sanitize reason: strip control characters and cap at 500 chars to prevent log injection.
    // The control characters ARE the target here. This strips them out of an admin-supplied reason
    // before it reaches the logs, so a crafted string cannot forge log lines or smuggle terminal
    // escapes into an operator's console. Matching them is the whole point of the expression; the
    // rule exists to catch them appearing by accident, which is not this.
    // eslint-disable-next-line no-control-regex
    const sanitizedReason = String(reason).replace(/[\r\n\t\x00-\x1F\x7F]/g, ' ').trim().slice(0, 500);
    try {
        const result = runLedgerAudit();
        const normalizedBaseline = (Math.round(result.sumBalances * 10000) / 10000).toString();
        const note = `[${new Date().toISOString()}] rebaselined at ${result.sumBalances.toFixed(4)} (drift was ${result.drift.toFixed(4)}): ${sanitizedReason}`;
        // Wrap both writes in a transaction so baseline and note are always consistent.
        db.transaction(() => {
            db.prepare(`INSERT INTO node_config (key, value) VALUES ('ledger_audit_baseline', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(normalizedBaseline);
            db.prepare(`INSERT INTO node_config (key, value) VALUES ('ledger_audit_rebaseline_note', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(note);
        })();
        console.log(`📐 [LedgerAudit] Rebaselined by admin: ${note}`);
        ctx.body = { success: true, ok: true, newBaseline: result.sumBalances, note };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, error: e?.message || 'Rebaseline failed' };
    }
});

// ===================== SYNC AUDIT LOG ENDPOINT =====================
// #134: Read-only view of the mirror sync audit trail.
// Returns the most recent sync imports ordered by time, optionally filtered by peer.

router.get('/api/local/admin/sync-audit-log', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        // parseInt + clamp to [1, 500]: prevents negative-limit DoS (LIMIT -1 disables the cap in SQLite).
        const parsedLimit = parseInt(String(ctx.query.limit), 10);
        const limit = Math.max(1, Math.min(isNaN(parsedLimit) ? 50 : parsedLimit, 500));
        const peerFilter = ctx.query.peer ? String(ctx.query.peer) : null;

        // Real COUNT(*) of all matching rows, not just the returned page slice.
        const countRow = peerFilter
            ? db.prepare(`SELECT COUNT(*) as c FROM sync_audit_log WHERE origin_peer_id = ?`).get(peerFilter)
            : db.prepare(`SELECT COUNT(*) as c FROM sync_audit_log`).get();
        const total = (countRow as { c: number })?.c || 0;

        const rows = peerFilter
            ? db.prepare(`SELECT * FROM sync_audit_log WHERE origin_peer_id = ? ORDER BY synced_at DESC LIMIT ?`).all(peerFilter, limit)
            : db.prepare(`SELECT * FROM sync_audit_log ORDER BY synced_at DESC LIMIT ?`).all(limit);
        ctx.body = { success: true, entries: rows, total };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, error: e?.message || 'Failed to query sync audit log' };
    }
});

// ===================== ADMIN ACTIONS (Requires Password) =====================

router.post('/api/local/admin/data', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    
    const pushTokenRows = (db.prepare(`SELECT public_key, platform FROM push_tokens`).all() as any[]) || [];
    const platformMap = new Map<string, string>();
    for (const row of pushTokenRows) {
        if (row.public_key && row.platform) {
            platformMap.set(row.public_key, row.platform.toLowerCase());
        }
    }

    ctx.body = {
        members: getAllMembers().filter(m => m.status !== 'pruned').map(m => {
            const isVoucher = canVouch(m.publicKey);
            const earned = m.earnedCredit || 0;
            let tier = earned >= 1400 ? 'Elder' : earned >= 600 ? 'Steward' : earned >= 200 ? 'Resident' : 'Newcomer';
            if (isVoucher && tier === 'Newcomer') {
                tier = 'Elder';
            }
            return {
                ...m,
                tier,
                standing: tier,
                canVouch: isVoucher,
                platform: platformMap.get(m.publicKey) || (m as any).platform || 'unknown',
            };
        }),
        profiles: getAllProfiles(),
        posts: getPosts().filter(p => p.status !== 'cancelled'),
        health: getCommunityHealth(),
        reports: getReports().reports,
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
    const body = (ctx as any).requestBody || {};
    const { level, category, searchQuery } = body;
    const parsedLimit = parseInt(String(body.limit), 10);
    const limit = Math.max(1, Math.min(isNaN(parsedLimit) ? 100 : parsedLimit, 500));
    const parsedOffset = parseInt(String(body.offset), 10);
    const offset = Math.max(0, isNaN(parsedOffset) ? 0 : parsedOffset);

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

let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();

function getProcessCpuLoad(): number {
    const now = Date.now();
    const timeDeltaMs = (now - lastCpuTime) || 1;
    const usageDelta = process.cpuUsage(lastCpuUsage);

    lastCpuUsage = process.cpuUsage();
    lastCpuTime = now;

    // Total CPU time spent by this process in milliseconds
    const totalMs = (usageDelta.user + usageDelta.system) / 1000;
    const cpusCount = os.cpus().length || 1;
    const pct = Math.round((totalMs / (timeDeltaMs * cpusCount)) * 100);
    return Math.min(100, Math.max(0, pct));
}

const getDiagnosticsHandler = async (ctx: any) => {
    if (!(await checkAdminAuth(ctx as any))) return;

    try {
        const cpusCount = os.cpus().length;
        const cpuLoad = getProcessCpuLoad();

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

        const config = getLocalConfig();
        let userCount = 0;
        try {
            const row = db.prepare("SELECT COUNT(*) as c FROM members WHERE status != 'pruned'").get() as any;
            userCount = row?.c || 0;
        } catch (err) {}

        const procMem = process.memoryUsage();
        const nodeRssMb = Math.round(procMem.rss / (1024 * 1024));

        ctx.body = {
            success: true,
            status: 'online',
            uptimeSeconds: Math.round(process.uptime()),
            cpuLoadPercent: cpuLoad,
            memoryUsageMb: nodeRssMb,
            totalMemoryMb: Math.round(totalMem / (1024 * 1024)),
            dbSizeBytes: dbSize,
            walSizeBytes: walSize,
            activeWsConnections: activeConnections ? activeConnections.size : 0,
            p2pActivePeers: activePeers,
            userCount,
            communityName: config.communityName || 'BeanPool Community Node',
            callsign: config.callsign || 'admin',
            diagnostics: {
                cpuLoad,
                cpusCount,
                totalMem,
                freeMem,
                usedMem,
                ramUsage,
                dbSize,
                walSize,
                userCount,
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
};

router.get('/api/local/admin/diagnostics', getDiagnosticsHandler);
router.post('/api/local/admin/diagnostics', getDiagnosticsHandler);

/**
 * Onboarding funnel: how many people tried to join, and where they stopped.
 *
 * Deliberately NOT folded into /diagnostics. That endpoint is polled on a timer — it is
 * in the polling-endpoint list in https-server.ts — whereas two of these numbers are
 * derived by grouping over the whole of `posts` and `members`. Riding along would run
 * those aggregations every few seconds to answer a question nobody asked; here they run
 * when an operator actually opens the panel.
 *
 * Aggregate rows only: (day, event, variant, count). There is no per-member data to
 * return because none is stored — see M2 in docs/ONBOARDING.md.
 */
const getOnboardingFunnelHandler = async (ctx: any) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        // Registered for POST as well as GET, so read the body too — otherwise a POST
        // carrying {"days": 90} silently answers with 30 and looks like the window
        // control is broken. Clamped rather than trusted; see clampDays.
        const days = clampDays(ctx.query?.days ?? ctx.requestBody?.days ?? 30);
        ctx.body = { days, rows: getFunnel(days) };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
};

router.get('/api/local/admin/onboarding-funnel', getOnboardingFunnelHandler);
router.post('/api/local/admin/onboarding-funnel', getOnboardingFunnelHandler);


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

/**
 * GET /api/local/admin/reports — List abuse reports with optional status filtering and pagination (#172).
 * Query params:
 *   - status: 'pending' | 'reviewed' | 'actioned' | 'all' (default: 'all')
 *   - limit: max items (clamped [1, 500], default 50)
 *   - offset: item offset for pagination (default 0)
 */
const ALLOWED_STATUSES = new Set(['pending', 'reviewed', 'actioned', 'all']);
router.get('/api/local/admin/reports', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const rawStatus = String(ctx.query.status || 'all').toLowerCase();
        const statusFilter = ALLOWED_STATUSES.has(rawStatus) ? rawStatus : 'all';
        const parsedLimit = parseInt(String(ctx.query.limit), 10);
        const limit = Math.max(1, Math.min(isNaN(parsedLimit) ? 50 : parsedLimit, 500));
        const parsedOffset = parseInt(String(ctx.query.offset), 10);
        const offset = Math.max(0, isNaN(parsedOffset) ? 0 : parsedOffset);

        const result = getReports(statusFilter, limit, offset);
        ctx.body = {
            success: true,
            reports: result.reports,
            total: result.total,
            pendingCount: result.pendingCount,
            limit,
            offset,
        };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, error: e?.message || 'Failed to fetch abuse reports' };
    }
});

router.post('/api/local/admin/reports/:id/dismiss', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const ok = dismissReport(ctx.params.id);
        if (!ok) {
            ctx.status = 404;
            ctx.body = { success: false, error: 'Abuse report not found' };
            return;
        }
        ctx.body = { success: true, message: 'Report dismissed' };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, error: e?.message || 'Failed to dismiss report' };
    }
});

router.post('/api/local/admin/reports/:id/action', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const { deletePost, suspendUser } = (ctx as any).requestBody || {};
        const ok = actionReport(ctx.params.id, !!deletePost, !!suspendUser);
        if (!ok) {
            ctx.status = 404;
            ctx.body = { success: false, error: 'Abuse report not found' };
            return;
        }
        ctx.body = { success: true, message: 'Report actioned successfully' };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, error: e?.message || 'Failed to action report' };
    }
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
