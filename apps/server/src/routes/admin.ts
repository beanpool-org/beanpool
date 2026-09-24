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
    adminSetCreditFrozen, adminSetElder, adminSetVoucher, adminSetTier,
    adminDeletePost, adminPruneUser, adminBulkDeletePosts,
    type EscrowRefundShortfall,
    adminPruneBranch, adminBroadcastAnnouncement, adminSendMessage,
    dismissReport, actionReport,
    getFirstNodeAdminPubkey, getAdminPubkey, isAdminPubkey, listNodeRoles, grantNodeRole, revokeNodeRole, isNodeOwner, isNodeAdmin, nodeRoleOf, type MemberNodeRole,
    canVouch, getMemberTrustProfile,
    getMemberStats,
    getConversationsByMember, getConversationMessages, getUnreadCounts,
    getNodeConfig, updateNodeConfig,
    adminRejectProject,
    adminHaltDecision, adminAccelerateDecision,
    adminEmergencySuspend, adminLiftSuspension,
    getAllDecisions, tallyDecision,
    getCommonsBalance,
    runLedgerAudit,
    getEscrowDisputes, countEscrowDisputes, getEscrowDispute, resolveEscrowDispute, type EscrowDisputeAction,
    lastActiveForViewer,
} from '../state-engine.js';
import {
    getLocalConfig, verifyPasswordAsync, verifyReplicationToken,
    getGatewayConfig, updateGatewayConfig,
} from '../config/local-config.js';
import { getConnectors } from '../connector-manager.js';
import { logger } from '../logger.js';
import { db, getCrowdfundProjects } from '../db/db.js';
import { getFunnel, clampDays } from '../engine/funnel.js';
import { issueCsrfToken, issueWsTicket, requireAdminRole } from '../admin-auth.js';
import { listStrandedEscrows, writeOffStrandedEscrow } from '../engine/escrow-write-off.js';
import type { RouteDeps } from './types.js';
import { ensureBeanPoolIdentity, BEANPOOL_LEARN_CHANNEL_ID } from '../engine/pulse-seed.js';
import { addChannel, deleteChannel, getChannel, ChannelError, type ChannelPlatform } from '../engine/creator-channels.js';
import { resolveChannel } from '../engine/pulse-resolver.js';
import { getPulseThumbnailService } from '../engine/pulse-thumbnail.js';
import {
    createAdminChallenge,
    getAdminChallenge,
    verifyAndSolveChallenge,
    consumeHandshakeToken,
    validateAdminSession,
    revokeAllMemberSessions,
    revokeAdminSession,
    enrolAdminOwnerKey,
    verifyEd25519Signature,
} from '../admin-key-auth.js';
import { isBreakGlassMode, setBreakGlassMode } from '../config/local-config.js';
import {
    issueRekeyCode,
    completeRekey,
    getRekeyStatus,
    getOffboardPreview,
    executeOffboard,
    type OffboardOptions,
} from '../engine/member-wizards.js';
import { getShutdownStatus, acknowledgeShutdownRecovery } from '../engine/shutdown-recovery.js';
import { getUnhandledRejectionSummary } from '../process-handlers.js';
import { getDiskHealth, getStorageCleanPreview, cleanStorageAndCompressLogs, type DiskHealth } from '../engine/storage-health.js';

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

// ===================== KEY-BASED ADMIN AUTH & BREAK-GLASS ENDPOINTS =====================
// Implements docs/admin-surface.md §2 (all):
// Signed challenge auth for phone & desktop QR flow, single-use 60s handshake tokens,
// browser sessions (2h idle / 12h hard), instant revocation via session_epoch,
// break-glass mode gating, and per-owner break-glass enrolment.

/**
 * POST /api/local/admin/auth/challenge
 * Requests a fresh 60-second challenge for signed authentication (desktop QR or phone).
 */
router.post('/api/local/admin/auth/challenge', async (ctx) => {
    const c = createAdminChallenge();
    ctx.body = {
        success: true,
        challengeId: c.challengeId,
        challenge: c.challenge,
        expiresAt: c.expiresAt,
    };
});

/**
 * POST /api/local/admin/auth/verify-challenge
 * Mobile app submits the signed challenge to mint a 60-second single-use handshake token.
 */
router.post('/api/local/admin/auth/verify-challenge', async (ctx) => {
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    const { challengeId, memberPubkey, signature, totpCode } = body;
    if (!challengeId || !memberPubkey || !signature) {
        ctx.status = 400;
        ctx.body = { error: 'challengeId, memberPubkey, and signature are required' };
        return;
    }

    const res = verifyAndSolveChallenge({ challengeId, memberPubkey, signature, totpCode });
    if (!res.ok) {
        let status = 400;
        if (res.totpRequired) {
            status = 401;
        } else if (res.error?.includes('Challenge not found')) {
            status = 404;
        } else if (res.error?.includes('signature') || res.error?.includes('Signature') || res.error?.includes('role') || res.error?.includes('inactive') || res.error?.includes('Member not found')) {
            status = 403;
        }
        ctx.status = status;
        ctx.body = { error: res.error, totpRequired: res.totpRequired };
        return;
    }

    ctx.body = {
        success: true,
        handshakeToken: res.handshakeToken,
        expiresAt: res.expiresAt,
        memberPubkey: res.memberPubkey,
        role: res.role,
    };
});

/**
 * GET /api/local/admin/auth/challenge/:challengeId
 * Status only: pending, resolved or expired. It never returns the handshake token, the signer or the role.
 * The id is not a secret worth a sign-in (it travels in a QR or a log line), and the token already goes to the
 * one party that proved the key, in the verify-challenge response. A browser waiting on a phone uses the
 * browser-bound pairing instead (settings-signin-pairing).
 */
router.get('/api/local/admin/auth/challenge/:challengeId', async (ctx) => {
    const c = getAdminChallenge(ctx.params.challengeId);
    if (!c || c.status === 'expired') {
        ctx.status = 404;
        ctx.body = { error: 'Challenge not found or expired', status: 'expired' };
        return;
    }
    ctx.body = { status: c.status, expiresAt: c.expiresAt };
});

/**
 * POST /api/local/admin/auth/exchange
 * Exchanges single-use 60s handshake token for a browser session (2h idle / 12h hard).
 * Single-use: burned immediately, replays rejected.
 */
router.post('/api/local/admin/auth/exchange', async (ctx) => {
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    const token = body.token || (ctx.query?.token as string);
    if (!token) {
        ctx.status = 400;
        ctx.body = { error: 'token is required' };
        return;
    }

    const res = consumeHandshakeToken(token);
    if (!res.ok) {
        ctx.status = 401;
        ctx.body = {
            error: res.error,
            replay: res.replay,
            expired: res.expired,
            revoked: res.revoked,
        };
        return;
    }

    ctx.cookies.set('admin_session', res.sessionId, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 12 * 3600 * 1000,
        path: '/',
    });
    if (res.csrfToken) {
        ctx.set('X-CSRF-Token', res.csrfToken);
    }
    ctx.body = {
        success: true,
        sessionId: res.sessionId,
        csrfToken: res.csrfToken,
        memberPubkey: res.memberPubkey,
        role: res.role,
        hardExpiresAt: res.hardExpiresAt,
        idleExpiresAt: res.idleExpiresAt,
    };
});

const seenRevocationNonces = new Map<string, number>();
function consumeRevocationNonce(nonce: string, now: number): boolean {
    if (seenRevocationNonces.size > 10_000) {
        for (const [n, exp] of seenRevocationNonces) if (exp <= now) seenRevocationNonces.delete(n);
    }
    const exp = seenRevocationNonces.get(nonce);
    if (exp !== undefined && exp > now) return false;
    seenRevocationNonces.set(nonce, now + 60_000);
    return true;
}

/**
 * POST /api/local/admin/auth/revoke-all
 * Revoke all web sessions for a member by bumping session_epoch in SQLite.
 * Gated by checkAdminAuth or signature header.
 */
router.post('/api/local/admin/auth/revoke-all', async (ctx) => {
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    let targetPubkey = body.memberPubkey || body.pubkey;

    // Check if called with an active admin session or password auth
    const isAuthed = await checkAdminAuth(ctx as any);
    if (isAuthed) {
        const callerPubkey = (ctx.state as any)?.actor;
        const callerRole = (ctx.state as any)?.adminRole;
        if (callerRole !== 'owner' && callerPubkey && targetPubkey && targetPubkey !== callerPubkey) {
            ctx.status = 403;
            ctx.body = { error: 'Non-owner administrators can only revoke their own sessions' };
            return;
        }
        targetPubkey = targetPubkey || callerPubkey || getFirstNodeAdminPubkey();
    } else {
        // Allow mobile app with signed headers (X-Public-Key, X-Signature)
        const pubKeyHex = ctx.get('X-Public-Key');
        const signatureBase64 = ctx.get('X-Signature');
        if (pubKeyHex && signatureBase64 && nodeRoleOf(pubKeyHex)) {
            const timestampHeader = ctx.get('X-Timestamp');
            const nonce = ctx.get('X-Nonce');
            const ts = Number(timestampHeader);
            const now = Date.now();
            if (!Number.isFinite(ts) || Math.abs(now - ts) > 60_000 || !nonce) {
                ctx.status = 401;
                ctx.body = { error: 'Missing or stale timestamp / nonce headers' };
                return;
            }
            if (!consumeRevocationNonce(nonce, now)) {
                ctx.status = 401;
                ctx.body = { error: 'Replay detected: nonce already used' };
                return;
            }
            const rawBody = (ctx as any).rawBody ?? '';
            const msg = `${ctx.method}\n${ctx.path}\n${timestampHeader}\n${nonce}\n${rawBody}`;
            if (verifyEd25519Signature(msg, signatureBase64, pubKeyHex)) {
                targetPubkey = pubKeyHex;
            } else {
                ctx.status = 401;
                ctx.body = { error: 'Invalid cryptographic signature' };
                return;
            }
        } else {
            ctx.status = 401;
            ctx.body = { error: 'Unauthorized: valid admin session or signature required' };
            return;
        }
    }

    // Anyone who can hold a key session (owner, admin, moderator) can end their own.
    if (!targetPubkey || !nodeRoleOf(targetPubkey)) {
        ctx.status = 401;
        ctx.body = { error: 'Unauthorized or target member holds no node role' };
        return;
    }

    const newEpoch = revokeAllMemberSessions(targetPubkey);
    ctx.cookies.set('admin_session', '', { maxAge: 0, path: '/' });
    ctx.status = 200;
    ctx.body = {
        success: true,
        memberPubkey: targetPubkey,
        sessionEpoch: newEpoch,
    };
});

/**
 * GET /api/local/admin/auth/session
 * Returns authentication status and active member details.
 */
router.get('/api/local/admin/auth/session', async (ctx) => {
    const rawToken =
        (ctx.cookies && typeof ctx.cookies.get === 'function' ? ctx.cookies.get('admin_session') : null) ||
        (typeof ctx.get === 'function' ? ctx.get('x-admin-session') : null) ||
        ctx.request?.headers?.['x-admin-session'] ||
        ctx.headers?.['x-admin-session'];
    const sessionToken = Array.isArray(rawToken) ? rawToken[0] : (rawToken ? String(rawToken) : null);

    if (sessionToken) {
        const res = validateAdminSession(sessionToken);
        if (res.valid && res.session) {
            ctx.body = {
                authenticated: true,
                isKeySession: true,
                memberPubkey: res.session.memberPubkey,
                role: res.session.role,
                sessionEpoch: res.session.sessionEpoch,
                hardExpiresAt: res.session.hardExpiresAt,
                idleExpiresAt: res.session.idleExpiresAt,
            };
            return;
        }
    }

    // Check if authenticated via password
    const hasPasswordCreds =
        (typeof ctx.get === 'function' && (ctx.get('x-admin-password') || ctx.get('x-break-glass-code'))) ||
        ctx.request?.headers?.['x-admin-password'] ||
        ctx.headers?.['x-admin-password'] ||
        ctx.request?.headers?.['x-break-glass-code'] ||
        ctx.headers?.['x-break-glass-code'];

    if (hasPasswordCreds) {
        const ok = await checkAdminAuth(ctx as any);
        if (ok) {
            ctx.body = {
                authenticated: true,
                isKeySession: !!(ctx.state as any)?.isKeySession,
                memberPubkey: (ctx.state as any)?.actor || null,
                role: (ctx.state as any)?.adminRole || 'owner',
            };
            return;
        }
    }

    ctx.status = 200;
    ctx.body = { authenticated: false };
});

/**
 * POST /api/local/admin/auth/logout
 * Destroys current session and clears cookie.
 */
router.post('/api/local/admin/auth/logout', async (ctx) => {
    const rawToken =
        (ctx.cookies && typeof ctx.cookies.get === 'function' ? ctx.cookies.get('admin_session') : null) ||
        (typeof ctx.get === 'function' ? ctx.get('x-admin-session') : null) ||
        ctx.request?.headers?.['x-admin-session'] ||
        ctx.headers?.['x-admin-session'];
    const sessionToken = Array.isArray(rawToken) ? rawToken[0] : (rawToken ? String(rawToken) : null);
    if (sessionToken) {
        revokeAdminSession(sessionToken);
    }
    ctx.cookies.set('admin_session', '', { maxAge: 0, path: '/' });
    ctx.body = { success: true };
});

/**
 * POST /api/local/admin/auth/enrol
 * POST /api/local/admin/auth/break-glass/enrol
 * Enrols a member key and generates a unique per-owner break-glass code.
 * In break-glass mode, this is the ONLY route password/break-glass credentials can access.
 */
const handleEnrol = async (ctx: any) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    const targetPubkey = body.memberPubkey || body.publicKey || body.pubkey || (ctx.state as any)?.actor;
    if (!targetPubkey) {
        ctx.status = 400;
        ctx.body = { error: 'memberPubkey is required' };
        return;
    }

    const callerRole = (ctx.state as any)?.adminRole;
    const isBreakGlass = !!(ctx.state as any)?.isBreakGlassAuth || (isBreakGlassMode() && !(ctx.state as any)?.isKeySession);
    const requestedRole = body.role || 'owner';

    // Enrol never bootstraps an owner: an owner key comes from an owner, the password, or break-glass,
    // full stop. The node-roles route DOES bootstrap, and #1006 was the two disagreeing about whether a
    // node whose sole owner is suspended has an owner. They cannot disagree again: both reach
    // `grantNodeRole`, and `nodeHasOwner()` answers that question once, inside it.
    if (requestedRole === 'owner' && !isBreakGlass && callerRole !== 'owner') {
        ctx.status = 403;
        ctx.body = { error: 'Only a node owner can enrol an owner key or generate break-glass credentials' };
        return;
    }

    try {
        const res = enrolAdminOwnerKey({
            targetPubkey,
            actorPubkey: (ctx.state as any)?.actor || (isBreakGlass ? 'break-glass:enrolment' : 'owner:password'),
            isBreakGlass,
            role: requestedRole,
        });
        ctx.body = {
            success: true,
            memberPubkey: res.memberPubkey,
            role: res.role,
            ...(res.breakGlassCode ? {
                breakGlassCode: res.breakGlassCode,
                message: 'Store this break-glass code securely. It will only be shown once.',
            } : {}),
            alertEmitted: res.alertEmitted,
        };
    } catch (e: any) {
        ctx.status = Number(e?.status) || 400;
        ctx.body = { error: e?.message || 'Failed to enrol admin key' };
    }
};

router.post('/api/local/admin/auth/enrol', handleEnrol);
router.post('/api/local/admin/auth/break-glass/enrol', handleEnrol);

/**
 * POST /api/local/admin/auth/break-glass-mode
 * Toggles break-glass mode on or off.
 */
router.post('/api/local/admin/auth/break-glass-mode', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if ((ctx.state as any)?.adminRole !== 'owner') {
        ctx.status = 403;
        ctx.body = { error: 'Only node owners can toggle break-glass mode' };
        return;
    }
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    if (typeof body.enabled !== 'boolean') {
        ctx.status = 400;
        ctx.body = { error: 'enabled (boolean) is required' };
        return;
    }
    setBreakGlassMode(body.enabled);
    ctx.body = { success: true, breakGlassMode: isBreakGlassMode() };
});

/**
 * GET /api/local/admin/auth/break-glass-status
 */
router.get('/api/local/admin/auth/break-glass-status', async (ctx) => {
    ctx.body = { breakGlassMode: isBreakGlassMode() };
});
router.get('/api/local/admin/auth/break-glass/status', async (ctx) => {
    ctx.body = { breakGlassMode: isBreakGlassMode() };
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

// ===================== STRANDED ESCROW WRITE-OFF =====================
// A negative escrow left by the pre-#1099 removal refunds is written off from the Commons, recorded
// (engine/escrow-write-off.ts). Listing is open to any admin, like the audit itself; writing off is owner level.

router.get('/api/local/admin/stranded-escrows', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        ctx.body = { success: true, ...listStrandedEscrows() };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, error: e?.message || 'Failed to list stranded escrows' };
    }
});

router.post('/api/local/admin/stranded-escrows/:escrowId/write-off', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner'], 'Only an owner of this node can write off an escrow from the Commons')) return;
    // Never read the actor from the body: a key session's member, or 'owner:password' under the password.
    const actor = resolveAdminActor(ctx);
    if (!actor) return;
    const body = (ctx as any).requestBody || {};
    const result = writeOffStrandedEscrow(ctx.params.escrowId, actor, body.reason, { confirmDeficit: body.confirmDeficit === true });
    if (!result.ok) {
        const { ok: _ok, status, ...refusal } = result;
        ctx.status = status;
        ctx.body = { success: false, ...refusal };
        return;
    }
    // The log redacts anything shaped like a 64-hex key, so a key session's actor goes in short, as on the other
    // admin lines here. The full signer is on the ledger row's auth_signer, which `transactionId` points to.
    logger.info('ADMIN', `Wrote off stranded ${result.escrowId} from the Commons: ${result.amount} Beans (Commons ${result.commonsBefore} → ${result.commonsAfter})`, {
        escrowId: result.escrowId,
        tradeId: result.tradeId,
        amount: result.amount,
        transactionId: result.transactionId,
        commonsBefore: result.commonsBefore,
        commonsAfter: result.commonsAfter,
        actor: /^[0-9a-f]{64}$/i.test(actor) ? actor.substring(0, 12) : actor,
        memo: result.memo,
    });
    const { ok: _ok, ...written } = result;
    ctx.body = { success: true, ...written };
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

/**
 * Full community health, including `flags`.
 *
 * The public GET /api/community/health deliberately omits `flags` — it answers
 * unauthenticated and the flags carry fraud analysis and member public keys. The node's
 * own settings dashboard is an admin surface and still needs them, so it asks here.
 * checkAdminAuth tarpits wrong passwords; the public route must never be given an
 * auth check of its own, or it becomes an unthrottled password oracle.
 */
router.post('/api/local/admin/health', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = getCommunityHealth();
});

router.post('/api/local/admin/data', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    
    const pushTokenRows = (db.prepare(`SELECT public_key, platform FROM push_tokens`).all() as any[]) || [];
    const platformMap = new Map<string, string>();
    for (const row of pushTokenRows) {
        if (row.public_key && row.platform) {
            platformMap.set(row.public_key, row.platform.toLowerCase());
        }
    }

    const rolesList = listNodeRoles();
    const rolesByPubkey = new Map<string, MemberNodeRole>();
    for (const r of rolesList) {
        rolesByPubkey.set(r.member_pubkey, r.role);
    }

    ctx.body = {
        members: getAllMembers().filter(m => m.status !== 'pruned').map(m => {
            const isVoucher = canVouch(m.publicKey);
            // The member's real tier, from the same profile their own app shows. `m.earnedCredit` is only
            // the granted lane (it leaves out earned trade and vouches), and vouching is a capability
            // shown by canVouch, not a tier.
            const tier = getMemberTrustProfile(m.publicKey).tier.name;
            return {
                ...m,
                // Admins see the day too: a node admin could otherwise match secret-ballot votes to voters.
                lastActiveAt: lastActiveForViewer(m.lastActiveAt, m.publicKey),
                tier,
                standing: tier,
                canVouch: isVoucher,
                nodeRole: rolesByPubkey.get(m.publicKey) ?? null,
                platform: platformMap.get(m.publicKey) || (m as any).platform || 'unknown',
            };
        }),
        profiles: getAllProfiles(),
        posts: getPosts().filter(p => p.status !== 'cancelled'),
        health: getCommunityHealth(),
        reports: getReports().reports,
        reportCount: getReportCount(),
        escrowDisputesCount: (db.prepare(`
            SELECT COUNT(*)
            FROM marketplace_transactions
            WHERE status = 'pending'
              AND (julianday('now') - julianday(created_at)) >= 7
        `).pluck().get() as number) || 0,
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

let cachedDiskHealth: DiskHealth | null = null;
let lastDiskHealthCheck = 0;
const DISK_HEALTH_CACHE_TTL_MS = 60_000;

function getCachedDiskHealth(): DiskHealth {
    const now = Date.now();
    if (!cachedDiskHealth || now - lastDiskHealthCheck > DISK_HEALTH_CACHE_TTL_MS) {
        cachedDiskHealth = getDiskHealth();
        lastDiskHealthCheck = now;
    }
    return cachedDiskHealth;
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
            shutdownStatus: getShutdownStatus(),
            diskHealth: getCachedDiskHealth(),
            // Stray rejected promises the process-level net caught and kept serving through. The error
            // text only — no request body, no parameter, no key — and already redacted on the way in.
            // Zeroes on a node that has had none, which is every healthy node.
            unhandledRejections: getUnhandledRejectionSummary(),
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

// ===================== UNCLEAN SHUTDOWN DIAGNOSTICS =====================
const getShutdownStatusHandler = async (ctx: any) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = { success: true, shutdownStatus: getShutdownStatus() };
};

const acknowledgeShutdownHandler = async (ctx: any) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const updated = acknowledgeShutdownRecovery();
    ctx.body = { success: true, shutdownStatus: updated };
};

router.get('/api/local/admin/shutdown-status', getShutdownStatusHandler);
router.post('/api/local/admin/shutdown-status', getShutdownStatusHandler);
router.post('/api/local/admin/shutdown-status/acknowledge', acknowledgeShutdownHandler);

// ===================== STORAGE & DISK HEALTH =====================
router.get('/api/local/admin/storage/disk-health', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = { success: true, diskHealth: getDiskHealth() };
});

router.post('/api/local/admin/storage/disk-health', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = { success: true, diskHealth: getDiskHealth() };
});

router.get('/api/local/admin/storage/clean-preview', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = { success: true, preview: await getStorageCleanPreview() };
});

router.post('/api/local/admin/storage/clean-preview', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = { success: true, preview: await getStorageCleanPreview() };
});

router.post('/api/local/admin/storage/clean', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const result = await cleanStorageAndCompressLogs();
    cachedDiskHealth = null;
    ctx.body = result;
});


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
    // A moderator takes down reported posts only (admin-auth.ts, MODERATOR_ROUTES): the post needs an open
    // report. A dismissed ('reviewed') or actioned one no longer counts.
    if ((ctx.state as any)?.adminRole === 'moderator'
        && !db.prepare("SELECT 1 FROM abuse_reports WHERE target_post_id = ? AND (status = 'pending' OR status IS NULL) LIMIT 1").get(ctx.params.id)) {
        ctx.status = 403;
        ctx.body = { success: false, error: 'Moderators can remove a post only while a report on it is open' };
        return;
    }
    try {
        // Optional: why, as one of the removal reason categories; the author reads it. Anything else is ignored.
        const { reasonCategory } = (ctx as any).requestBody || {};
        // A removal refunds each pending trade's escrow to its buyer, but only ever what the escrow
        // actually holds. If a trade row claimed more than was ever held, the buyer gets what is there and
        // the moderator is TOLD — a silent short refund is how a discrepancy between the deal rows and the
        // ledger stays invisible until it is old data nobody can explain.
        const refundShortfalls: EscrowRefundShortfall[] = [];
        const ok = adminDeletePost(ctx.params.id, { reasonCategory, onRefundShortfall: s => refundShortfalls.push(s) });
        if (!ok) {
            ctx.status = 404;
            ctx.body = { success: false, error: 'Post not found' };
            return;
        }
        ctx.body = refundShortfalls.length > 0
            ? {
                success: true,
                refundShortfalls,
                warning: `Removed, but ${refundShortfalls.length} escrow refund(s) were short: `
                    + refundShortfalls.map(s => `trade ${s.transactionId} owed ${s.owed}, refunded ${s.refunded}`).join('; '),
            }
            : { success: true };
    } catch (e: any) {
        console.error('Error deleting post:', e);
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

/**
 * The admin acting on a Decision or a suspension. A key session carries its member's pubkey, which must
 * still hold an admin or owner node role; a password session is owner-level ('owner:password' — only owners
 * hold the password). Never read from the request body.
 */
function resolveAdminActor(ctx: any): string | null {
    const signedActor = (ctx.state as any)?.actor as string | undefined;
    if (signedActor) {
        if (!isNodeAdmin(signedActor)) {
            ctx.status = 403;
            ctx.body = { error: 'Explicit authenticated node admin required' };
            return null;
        }
        return signedActor;
    }
    return 'owner:password';
}

// Emergency suspension (§3.8, answer L): suspends at once and opens a 7-day "Keep this suspension?"
// Decision in the same transaction. The reason is shown to members on that Decision.
router.post('/api/local/admin/users/:pubkey/suspend', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const actor = resolveAdminActor(ctx);
    if (!actor) return;
    const { reason } = (ctx as any).requestBody || {};
    const result = adminEmergencySuspend(ctx.params.pubkey, actor, typeof reason === 'string' ? reason : '');
    if (!result.success) {
        ctx.status = result.status || 400;
        ctx.body = { error: result.error };
        return;
    }
    logger.info('ADMIN', `Emergency-suspended ${ctx.params.pubkey.substring(0, 12)}; ratifying Decision ${result.decision!.id}`);
    ctx.body = { success: true, decision: result.decision };
});

// Status: 'active' lifts a suspension (and closes an open "Keep this suspension?" vote about it). Suspending
// is only ever the emergency route above — an admin cannot suspend someone with no community review.
router.post('/api/local/admin/users/:pubkey/status', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { status } = (ctx as any).requestBody || {};
    if (status === 'disabled') {
        ctx.status = 400;
        ctx.body = { error: 'Suspend with POST /api/local/admin/users/:pubkey/suspend and a reason; it opens a community vote' };
        return;
    }
    if (status !== 'active') {
        ctx.status = 400;
        ctx.body = { error: 'status must be "active"' };
        return;
    }
    const actor = resolveAdminActor(ctx);
    if (!actor) return;
    const result = adminLiftSuspension(ctx.params.pubkey, actor);
    if (!result.success) {
        ctx.status = result.status || 400;
        ctx.body = { error: result.error };
        return;
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
    const actor = resolveAdminActor(ctx);
    if (!actor) return;
    try {
        adminPruneUser(ctx.params.pubkey, actor);
        ctx.body = { success: true };
    } catch (e: any) {
        ctx.status = e?.status || 400;
        ctx.body = { error: e?.message || 'Failed to prune user' };
    }
});

router.post('/api/local/admin/branches/:pubkey/prune', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const actor = resolveAdminActor(ctx);
    if (!actor) return;
    try {
        adminPruneBranch(ctx.params.pubkey, actor);
        ctx.body = { success: true };
    } catch (e: any) {
        ctx.status = e?.status || 400;
        ctx.body = { error: e?.message || 'Failed to prune branch' };
    }
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
 *   - status: 'open' | 'dismissed' | 'actioned' | 'all' (default: 'all'). The older names still work:
 *     'pending' is 'open', 'reviewed' is 'dismissed'.
 *   - limit: max items (clamped [1, 500], default 50)
 *   - offset: item offset for pagination (default 0)
 * pendingCount is always the number of open reports, whatever the filter.
 */
const REPORT_STATUS_FILTERS: Record<string, string> = {
    all: 'all', open: 'pending', pending: 'pending', dismissed: 'reviewed', reviewed: 'reviewed', actioned: 'actioned',
};
router.get('/api/local/admin/reports', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const rawStatus = String(ctx.query.status || 'all').toLowerCase();
        const statusFilter = REPORT_STATUS_FILTERS[rawStatus] ?? 'all';
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
        const { deletePost, suspendUser, removePulseItem, reasonCategory } = (ctx as any).requestBody || {};
        // Moderators remove what was reported; suspending a member stays with owners and admins.
        if (suspendUser && (ctx.state as any)?.adminRole === 'moderator') {
            ctx.status = 403;
            ctx.body = { success: false, error: 'Moderators cannot suspend members' };
            return;
        }
        // A moderator removes a post or Pulse item only through a report that is still open, as on
        // posts/:id/delete: once dismissed ('reviewed') or actioned, only an owner or admin can take it down.
        // Marking a report handled with no removal is not gated.
        if ((deletePost || removePulseItem) && (ctx.state as any)?.adminRole === 'moderator') {
            const report = db.prepare('SELECT status FROM abuse_reports WHERE id = ?').get(ctx.params.id) as any;
            if (report && report.status !== 'pending' && report.status != null) {
                ctx.status = 403;
                ctx.body = { success: false, error: 'Moderators can remove a post only while a report on it is open' };
                return;
            }
        }
        // Same as posts/:id/delete: a removal refunds each pending trade's escrow to its buyer, but only
        // ever what the escrow actually holds, and a short refund is told to the moderator rather than
        // left in the log. This is the flow moderators work through, so it must not be the quiet one.
        const refundShortfalls: EscrowRefundShortfall[] = [];
        const ok = actionReport(ctx.params.id, !!deletePost, !!suspendUser, !!removePulseItem, {
            reasonCategory,
            onRefundShortfall: s => refundShortfalls.push(s),
        });
        if (!ok) {
            ctx.status = 404;
            ctx.body = { success: false, error: 'Abuse report not found' };
            return;
        }
        const pulseItemId = removePulseItem
            ? (db.prepare('SELECT target_pulse_item_id FROM abuse_reports WHERE id = ?').get(ctx.params.id) as any)?.target_pulse_item_id
            : null;
        if (pulseItemId) {
            getPulseThumbnailService().delete(pulseItemId);
            const by = ctx.state?.auth_signer ? String(ctx.state.auth_signer).substring(0, 12) : 'owner:password';
            logger.info('ADMIN', `Removed Pulse item ${pulseItemId} (report ${ctx.params.id}) by ${by}${suspendUser ? ', owner suspended' : ''}`);
        }
        ctx.body = refundShortfalls.length > 0
            ? {
                success: true,
                message: 'Report actioned successfully',
                refundShortfalls,
                warning: `Removed, but ${refundShortfalls.length} escrow refund(s) were short: `
                    + refundShortfalls.map(s => `trade ${s.transactionId} owed ${s.owed}, refunded ${s.refunded}`).join('; '),
            }
            : { success: true, message: 'Report actioned successfully' };
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
    const refundShortfalls: EscrowRefundShortfall[] = [];
    const deleted = adminBulkDeletePosts(postIds, { onRefundShortfall: s => refundShortfalls.push(s) });
    ctx.body = refundShortfalls.length > 0
        ? { success: true, deleted, deletedCount: deleted, refundShortfalls }
        : { success: true, deleted, deletedCount: deleted };
});


router.post('/api/local/admin/inbox', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const adminPubkey = getFirstNodeAdminPubkey() || getAdminPubkey();
    if (!adminPubkey) {
        ctx.body = { conversations: [], adminPubkey: '' };
        return;
    }
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
    if (!targetPubkey || !message) {
        ctx.status = 400;
        ctx.body = { error: 'targetPubkey and message are required' };
        return;
    }
    try {
        adminSendMessage(targetPubkey, message);
        ctx.body = { success: true };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e?.message || 'Failed to send admin message' };
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
    try {
        const ok = adminRejectProject(projectId);
        if (!ok) {
            ctx.status = 404;
            ctx.body = { error: 'Project not found' };
            return;
        }
        ctx.body = { success: true };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e?.message || 'Failed to reject project' };
    }
});

// Admin: the Decisions an admin can still act on — open votes and removals in their grace window — with
// totals only. Like every other Decision response, never who voted how.
router.post('/api/local/admin/decisions', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const actionable = [...getAllDecisions('open'), ...getAllDecisions('execution_pending_grace')];
    ctx.body = {
        decisions: actionable.map(d => {
            const subject = d.subject ? getMember(d.subject) : null;
            return { ...d, subjectName: subject?.callsign ?? null, tally: tallyDecision(d.id) };
        }),
    };
});

// Admin: halt a community decision (§3.7). The written reason is public on the Decision.
router.post('/api/local/admin/decisions/:id/halt', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { reason } = (ctx as any).requestBody || {};
    const signedActor = resolveAdminActor(ctx);
    if (!signedActor) return;
    if (!reason) {
        ctx.status = 400;
        ctx.body = { error: 'reason (signed justification) required to halt decision' };
        return;
    }
    const result = adminHaltDecision(ctx.params.id, signedActor, reason);
    if (!result.success) {
        ctx.status = result.status || 400;
        ctx.body = { error: result.error || 'Failed to halt decision' };
        return;
    }
    ctx.body = { success: true };
});

// Admin: accelerate a pending grace removal decision (§3.7)
router.post('/api/local/admin/decisions/:id/accelerate', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const signedActor = resolveAdminActor(ctx);
    if (!signedActor) return;
    const result = adminAccelerateDecision(ctx.params.id, signedActor);
    if (!result.success) {
        ctx.status = result.status || 400;
        ctx.body = { error: result.error };
        return;
    }
    ctx.body = { success: true };
});

// Admin: get all projects (unified — reads from crowdfund SQL table)
router.post('/api/local/admin/commons/projects', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const crowdfundProjects = getCrowdfundProjects();
    // ⚡ Bolt: Pre-fetch members Map for O(1) proposer lookup instead of N+1 getMember queries
    const membersMap = new Map(getAllMembers().map(m => [m.publicKey, m]));
    // Map crowdfund schema to commons admin UI shape
    const projects = crowdfundProjects.map(p => {
        const member = membersMap.get(p.creator_pubkey);
        return {
            id: p.id,
            title: p.title,
            description: p.description,
            proposerPubkey: p.creator_pubkey,
            proposerCallsign: member?.callsign || 'Unknown',
            requestedAmount: p.goal_amount,
            currentAmount: p.current_amount,
            status: (p.status || 'ACTIVE').toLowerCase(),
            createdAt: p.created_at,
            photos: p.photos,
        };
    });
    ctx.body = { projects, balance: getCommonsBalance() };
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


function inferPulsePlatform(url: string): ChannelPlatform {
    const raw = (url || '').toLowerCase();
    if (raw.includes('youtube.com') || raw.includes('youtu.be')) return 'youtube';
    if (raw.includes('soundcloud.com') || raw.includes('snd.sc')) return 'soundcloud';
    if (raw.includes('instagram.com') || raw.includes('instagr.am')) return 'instagram';
    if (raw.includes('tiktok.com')) return 'tiktok';
    if (raw.includes('facebook.com') || raw.includes('fb.com') || raw.includes('fb.me')) return 'facebook';
    if (/(\/feed\b|\/rss\b|\/atom\b|\.xml(\?|$)|\.rss(\?|$)|\/feeds?\/)/i.test(raw)) return 'rss';
    return 'website';
}

// ===================== CURATED PULSE CHANNELS =====================
// #pulse: Node operator curated channels for the Pulse feed.
// Channels added here belong to the BeanPool system identity, not the admin's personal account.

router.get('/api/local/admin/pulse/channels', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const owner = ensureBeanPoolIdentity();
        const rows = db.prepare(
            `SELECT c.id, c.owner_pubkey, c.platform, c.url, c.handle, c.category,
                    c.supports_autolist, c.fail_count, c.last_error, c.is_stale,
                    c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM pulse_items p WHERE p.channel_id = c.id AND p.deleted_at IS NULL) as item_count
               FROM creator_channels c
              WHERE c.owner_pubkey = ? AND c.deleted_at IS NULL
              ORDER BY c.created_at ASC`
        ).all(owner) as any[];

        const channels = rows.map(r => ({
            id: r.id,
            ownerPubkey: r.owner_pubkey,
            platform: r.platform,
            url: r.url,
            handle: r.handle,
            category: r.category,
            supportsAutolist: r.supports_autolist === 1,
            supports_autolist: r.supports_autolist,
            failCount: r.fail_count || 0,
            lastError: r.last_error || null,
            isStale: r.is_stale === 1,
            itemCount: r.item_count || 0,
            item_count: r.item_count || 0,
            isSeeded: r.id === BEANPOOL_LEARN_CHANNEL_ID,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }));

        ctx.body = { success: true, channels };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, error: e?.message || 'Failed to list curated channels' };
    }
});

router.post('/api/local/admin/pulse/channels', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { url, feedUrl, category, platform } = (ctx as any).requestBody || {};
    const rawUrl = url || feedUrl;
    if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
        ctx.status = 400;
        ctx.body = { error: 'url is required' };
        return;
    }

    const trimmedUrl = rawUrl.trim();
    const cat = (category && typeof category === 'string' && category.trim()) ? category.trim() : 'learn';
    const plat = (platform && typeof platform === 'string' && platform.trim())
        ? platform.trim()
        : inferPulsePlatform(trimmedUrl);

    try {
        const owner = ensureBeanPoolIdentity();
        const channel = addChannel({
            ownerPubkey: owner,
            platform: plat,
            raw: trimmedUrl,
            category: cat,
            syndicateToNode: true,
        });

        let resolve: { count: number; error?: string } | null = null;
        if (channel.supportsAutolist) {
            try {
                resolve = await resolveChannel(channel.id);
            } catch (err: any) {
                resolve = { count: 0, error: err?.message || String(err) };
            }
        } else {
            resolve = { count: 0, error: 'URL does not support automatic updates' };
        }

        const fresh = getChannel(channel.id) || channel;
        const msg = fresh.supportsAutolist
            ? (resolve && resolve.count > 0 ? `Channel added and imported ${resolve.count} items.` : 'Channel added (updates automatically).')
            : 'Channel added, but this URL does not support automatic updates (not a channel/feed URL).';

        ctx.body = {
            success: true,
            channel: fresh,
            supportsAutolist: fresh.supportsAutolist,
            supports_autolist: fresh.supportsAutolist ? 1 : 0,
            resolve,
            message: msg,
        };
    } catch (e: any) {
        if (e instanceof ChannelError) {
            ctx.status = 400;
            ctx.body = { error: e.message, code: e.code };
            return;
        }
        ctx.status = 500;
        ctx.body = { error: e?.message || 'Failed to add curated channel' };
    }
});

router.post('/api/local/admin/pulse/channels/remove', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { id, channelId } = (ctx as any).requestBody || {};
    const targetId = id || channelId;
    if (!targetId || typeof targetId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'id is required' };
        return;
    }

    if (targetId === BEANPOOL_LEARN_CHANNEL_ID) {
        ctx.status = 400;
        ctx.body = { error: 'The seeded BeanPool learn channel cannot be removed (it is recreated on boot).' };
        return;
    }

    const owner = ensureBeanPoolIdentity();
    try {
        const deleted = deleteChannel(owner, targetId);
        if (!deleted) {
            ctx.status = 404;
            ctx.body = { error: 'Channel not found or already removed' };
            return;
        }
        ctx.body = { success: true, message: 'Channel removed' };
    } catch (e: any) {
        if (e instanceof ChannelError) {
            ctx.status = 400;
            ctx.body = { error: e.message };
            return;
        }
        ctx.status = 500;
        ctx.body = { error: e?.message || 'Failed to remove channel' };
    }
});

// ===================== NODE ROLES MANAGEMENT =====================
// docs/admin-surface.md §1, §5; docs/the-commons.md §9.2
// Manage explicit node owner and admin role assignments.
// Gated by checkAdminAuth.

router.get('/api/local/admin/node-roles', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const roles = listNodeRoles();
    ctx.body = { success: true, roles };
});

router.post('/api/local/admin/node-roles', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || {};
    const targetPubkey = body.pubkey || body.publicKey || body.member_pubkey;
    const role = body.role;

    // Never read actor from request body or headers (interim rule: docs/admin-surface.md §2).
    // If ctx.state.actor is absent under password auth, treat caller as owner ('owner:password').
    const signedActor = (ctx.state as any)?.actor;
    const effectiveActor = signedActor || 'owner:password';

    if (!targetPubkey || !role) {
        ctx.status = 400;
        ctx.body = { error: 'pubkey and role are required' };
        return;
    }
    if (role !== 'owner' && role !== 'admin' && role !== 'moderator') {
        ctx.status = 400;
        ctx.body = { error: "role must be 'owner', 'admin', or 'moderator'" };
        return;
    }

    try {
        grantNodeRole(targetPubkey, role, effectiveActor);
        ctx.body = { success: true, message: `Granted ${role} role to ${targetPubkey}` };
    } catch (e: any) {
        const msg = e?.message || 'Failed to grant node role';
        // A guard that carries its own status says so (the suspended-owner refusal, #1006, is a 403
        // whose wording is for the person reading it, not a string for this line to match on).
        ctx.status = Number(e?.status) || (msg.includes('Only an owner') ? 403 : (msg === 'Member not found' ? 404 : 400));
        ctx.body = { error: msg };
    }
});

router.delete('/api/local/admin/node-roles/:pubkey/:role', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { pubkey, role } = ctx.params;
    const signedActor = (ctx.state as any)?.actor;
    const effectiveActor = signedActor || 'owner:password';

    if (role !== 'owner' && role !== 'admin' && role !== 'moderator') {
        ctx.status = 400;
        ctx.body = { error: "role must be 'owner', 'admin', or 'moderator'" };
        return;
    }

    try {
        const currentRole = nodeRoleOf(pubkey);
        if (currentRole !== role) {
            ctx.status = 404;
            ctx.body = { error: `Member ${pubkey} does not hold role '${role}'` };
            return;
        }
        revokeNodeRole(pubkey, role as MemberNodeRole, effectiveActor);
        ctx.body = { success: true, message: `Revoked ${role} role from ${pubkey}` };
    } catch (e: any) {
        const msg = e?.message || 'Failed to revoke node role';
        ctx.status = msg.includes('Only an owner') ? 403 : 400;
        ctx.body = { error: msg };
    }
});

// ===================== ESCROW DISPUTE RESOLUTION =====================
// docs/settings-ia.md §5 item 2 & §6 correction 2

router.get('/api/local/admin/disputes', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const minDays = !isNaN(Number(ctx.query.minDays)) ? Number(ctx.query.minDays) : 7;
    const limit = !isNaN(Number(ctx.query.limit)) ? Math.max(1, Math.min(200, Number(ctx.query.limit))) : 50;
    const offset = !isNaN(Number(ctx.query.offset)) ? Math.max(0, Number(ctx.query.offset)) : 0;
    const status = (typeof ctx.query.status === 'string' && ['all', 'pending', 'resolved'].includes(ctx.query.status))
        ? (ctx.query.status as 'all' | 'pending' | 'resolved')
        : 'all';

    // Counts for every tab, so the Manager's tab labels agree whichever tab is open.
    const counts = countEscrowDisputes(minDays);
    const total = counts[status];

    const disputes = getEscrowDisputes(minDays, limit, offset, status);
    ctx.body = {
        disputes,
        total,
        counts,
        count: disputes.length,
        minDays,
        limit,
        offset
    };
});

router.get('/api/local/admin/disputes/:id', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { id } = ctx.params;
    const dispute = getEscrowDispute(id);
    if (!dispute) {
        ctx.status = 404;
        ctx.body = { error: 'Dispute not found' };
        return;
    }
    ctx.body = { dispute };
});

router.post('/api/local/admin/disputes/:id/resolve', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { id } = ctx.params;
    const body = (ctx as any).requestBody || (ctx as any).request?.body || {};
    const action = body.action as EscrowDisputeAction;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : undefined;

    if (!action || !['release_to_seller', 'refund_to_buyer', 'split'].includes(action)) {
        ctx.status = 400;
        ctx.body = { error: "action must be 'release_to_seller', 'refund_to_buyer', or 'split'" };
        return;
    }

    // Never read actor from request body or headers (interim rule: docs/admin-surface.md §2).
    // If ctx.state.actor is absent under password auth, treat caller as owner ('owner:password').
    const effectiveActor = resolveAdminActor(ctx);
    if (!effectiveActor) return;

    try {
        const tx = resolveEscrowDispute(id, action, effectiveActor, { reason });
        ctx.body = {
            success: true,
            transactionId: id,
            resolution: action,
            authSigner: effectiveActor,
            transaction: tx
        };
    } catch (e: any) {
        const msg = e?.message || 'Failed to resolve escrow dispute';
        ctx.status = e?.status || (msg.includes('not found') ? 404 : 400);
        ctx.body = { error: msg };
    }
});

// ===================== MEMBER WIZARDS (docs/settings-ia.md §5 items 1 & 4, Item 9b) =====================

router.get('/api/local/admin/members/:pubkey/rekey/status', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const { pubkey } = ctx.params;
        const status = getRekeyStatus(pubkey);
        ctx.body = status;
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e?.message || 'Failed to fetch re-key status' };
    }
});

router.post('/api/local/admin/members/:pubkey/rekey/issue-code', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { pubkey } = ctx.params;
    const effectiveActor = resolveAdminActor(ctx);
    if (!effectiveActor) return;

    try {
        const result = issueRekeyCode(pubkey, effectiveActor);
        ctx.body = {
            success: true,
            ...result,
            operator: effectiveActor,
        };
    } catch (e: any) {
        ctx.status = e?.status || (e?.message?.includes('not found') ? 404 : 400);
        ctx.body = { error: e?.message || 'Failed to issue re-enrolment code' };
    }
});

router.post('/api/local/admin/members/:pubkey/rekey/complete', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { pubkey } = ctx.params;
    const body = (ctx as any).requestBody || (ctx as any).request?.body || {};
    const { code, newPubkey } = body;

    if (!code || typeof code !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'Re-enrolment code is required' };
        return;
    }
    if (!newPubkey || typeof newPubkey !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'New public key is required' };
        return;
    }

    const effectiveActor = resolveAdminActor(ctx);
    if (!effectiveActor) return;

    try {
        const result = completeRekey(pubkey, newPubkey, code, effectiveActor);
        ctx.body = result;
    } catch (e: any) {
        ctx.status = e?.status || (e?.message?.includes('not found') || e?.message?.includes('unrecognised') ? 404 : 400);
        ctx.body = { error: e?.message || 'Failed to complete re-keying' };
    }
});

router.get('/api/local/admin/members/:pubkey/offboard/preview', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const { pubkey } = ctx.params;
        const preview = getOffboardPreview(pubkey);

        // Security / Privacy: Only return active members roster to key-authenticated sessions.
        // Password-only sessions cannot execute gift_to_member, so withholding the list
        // prevents leaking the member roster.
        const actor = resolveAdminActor(ctx);
        if (!actor) return;
        if (actor === 'owner:password') {
            preview.activeMembers = [];
        }

        ctx.body = preview;
    } catch (e: any) {
        const msg = e?.message || 'Failed to get offboard preview';
        ctx.status = msg.includes('not found') ? 404 : 400;
        ctx.body = { error: msg };
    }
});

router.post('/api/local/admin/members/:pubkey/offboard', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { pubkey } = ctx.params;
    const body = (ctx as any).requestBody || (ctx as any).request?.body || {};
    const { resolution, giftRecipientPubkey } = body;

    if (!resolution || !['donate_to_commons', 'gift_to_member', 'write_off_commons', 'prune_zero_balance'].includes(resolution)) {
        ctx.status = 400;
        ctx.body = { error: "resolution must be 'donate_to_commons', 'gift_to_member', 'write_off_commons', or 'prune_zero_balance'" };
        return;
    }

    const effectiveActor = resolveAdminActor(ctx);
    if (!effectiveActor) return;
    if (resolution === 'gift_to_member' && effectiveActor === 'owner:password') {
        ctx.status = 403;
        ctx.body = {
            error: 'Two-person rule requires signed key-based admin authentication to gift offboarding funds to a member.',
            code: 'KEY_AUTH_REQUIRED',
        };
        return;
    }

    try {
        const result = executeOffboard(
            pubkey,
            { resolution: resolution as OffboardOptions['resolution'], giftRecipientPubkey },
            effectiveActor
        );
        ctx.body = result;
    } catch (e: any) {
        ctx.status = e?.statusCode || e?.status || 400;
        ctx.body = { error: e?.message || 'Failed to offboard member', code: e?.code };
    }
});

    return router;
}
