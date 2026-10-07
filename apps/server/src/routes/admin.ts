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
    getFirstNodeAdminPubkey, getAdminPubkey, isAdminPubkey, listNodeRoles, grantNodeRole, revokeNodeRole, isNodeOwner, isNodeAdmin, isOwnerLevelActor, nodeRoleOf, heldNodeRoleOf, type MemberNodeRole,
    canVouch, getMemberTrustProfile,
    getMemberStats,
    getTradeTotals,
    getConversationsByMember, getConversationMessages, getUnreadCounts,
    getNodeConfig, updateNodeConfig,
    adminRejectProject,
    adminHaltDecision, adminAccelerateDecision,
    adminEmergencySuspend, adminLiftSuspension,
    getAllDecisions, tallyDecision, decisionForAdmin,
    getCommonsBalance,
    runLedgerAudit,
    getEscrowDisputes, countEscrowDisputes, getEscrowDispute, resolveEscrowDispute, type EscrowDisputeAction,
    lastActiveForViewer,
    restoreHiddenPost, liftModerationMute, pushServiceRefusals,
    hideBurst, undoBurst,
} from '../state-engine.js';
import { listMutedMembers } from '../engine/auto-moderation.js';
import { listBrokenBalances, BROKEN_BALANCE_REPAIR, answerPotPaused } from '../engine/audit.js';
import { logAlertsLook, logBalanceLook, logDisputesLook, type TradeLookAction } from '../engine/community-health.js';
import {
    BURST, burstCleanupOn, burstKey, isBurstAccount, moderatorMayOpen, readBurst, checkBurstSelection, removeBurst, burstDigest,
    type BurstActorRole, type BurstRefusal,
} from '../engine/burst-cleanup.js';
import { decisionsOn, adminActionNeedsOwner, type OwnerOnlyAdminAction } from '../decisions-engine.js';
import {
    getLocalConfig, verifyPasswordAsync,
    getGatewayConfig, updateGatewayConfig,
} from '../config/local-config.js';
import { getConnectors } from '../connector-manager.js';
import { logger } from '../logger.js';
import { db, getCrowdfundProjects } from '../db/db.js';
import { getFunnel, clampDays } from '../engine/funnel.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { expoAccessTokenStatus } from '../config/expo-access-token.js';
import { getWebVisits, clampVisitDays, VISIT_RETENTION_DAYS } from '../engine/web-visits.js';
import { getAppVersionCounts } from '../app-version-counts.js';
import { APP_PLATFORMS, getMinAppVersion, getMinAppVersionFrom, getPlatformFloorDetail, getAppStoreVersions } from '../app-store-versions.js';
import { issueCsrfToken, issueWsTicket, requireAdminRole, requirePhoneStepUp, checkAdminPasswordAuth, revoke2faSession, PASSWORD_CSRF_BINDING, passwordSessionNeedsTotpSetup, TOKEN_REFUSED_CODE, refusePasswordRetired, lookTokenOf } from '../admin-auth.js';
import { isMemberKeySpelling, provenKeySpelling, BAD_KEY_CODE, BAD_KEY_ERROR } from '../engine/member-key.js';
import { NonceStore, verifyMemberSignature } from '../engine/member-signature.js';
import { SIGNED_FOR_HEADER, avatarUrlOf } from '@beanpool/core';
import { listStrandedEscrows, writeOffStrandedEscrow } from '../engine/escrow-write-off.js';
import { describeRefundShortfall } from '../engine/posts.js';
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
    PHONE_HANDOFF_IDLE_TTL_MS,
    validateAdminSession,
    revokeAllMemberSessions,
    revokeAdminSession,
    enrolAdminOwnerKey,
    issueBreakGlassCode,
    retireBreakGlassCode,
    createPasswordSession,
    setAdminSessionCookie,
    clearAdminSessionCookie,
    ADMIN_SESSION_COOKIE,
    endPasswordSessions,
} from '../admin-key-auth.js';
import { isBreakGlassMode, setBreakGlassMode, isPasswordRetired, updateLocalConfig, removeFirstPasswordFile } from '../config/local-config.js';
import {
    issueRekeyCode,
    cancelRekeyCode,
    completeRekey,
    getRekeyStatus,
    getOffboardPreview,
    executeOffboard,
    type OffboardOptions,
} from '../engine/member-wizards.js';
import { getShutdownStatus, acknowledgeShutdownRecovery } from '../engine/shutdown-recovery.js';
import { getStandbyHealthBanner, watchesStandbys } from '../services/standby-health.js';
import { getOffboxHealth } from '../services/offbox-backups.js';
import { getUnhandledRejectionSummary } from '../process-handlers.js';
import { getDiskHealth, getStorageCleanPreview, cleanStorageAndCompressLogs, type DiskHealth } from '../engine/storage-health.js';
import { ANNOUNCEMENT_LIMITS } from '../engine/push-notices.js';
import { likeContains } from '@beanpool/engine';

// The most post ids one POST /api/local/admin/posts/bulk-delete takes. The manager (PeopleSafetySection.tsx) and the
// node's own settings page (static/settings.js) send longer lists in batches of this size, one after another.
export const MAX_BULK_DELETE_POSTS = 200;

export function createAdminRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth, activeConnections, calculateAnalytics } = deps;

// ===================== WS TICKET ENDPOINT =====================
// Issues short-lived single-use ticket for WebSocket authentication to avoid exposing
// admin passwords in URL query strings (which browser console & proxy logs capture).
router.post('/api/local/admin/ws-ticket', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    // Bound to the session this request rides (none for the password itself): the log socket ends with it.
    const ticket = issueWsTicket((ctx.state as any)?.adminSessionId);
    if (!ticket) {
        ctx.status = 401;
        ctx.body = { error: 'Your sign-in has ended' };
        return;
    }
    ctx.body = { ticket };
});

// ===================== CSRF TOKEN ENDPOINT =====================
// #133: Clients call this with their password to receive a short-lived CSRF token.
// The token must be sent as X-CSRF-Token on subsequent admin state-mutation requests.
// This provides defence-in-depth beyond the X-Admin-Password header.

router.post('/api/local/admin/csrf-token', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    // For the session this request rides, and no other (admin-auth.ts, CSRF TOKEN STORE); a password caller's token is
    // for password callers.
    const token = issueCsrfToken((ctx.state as any)?.adminSessionId || PASSWORD_CSRF_BINDING);
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
    const { challengeId, memberPubkey, signature, signedFor } = body;
    if (!challengeId || !memberPubkey || !signature) {
        ctx.status = 400;
        ctx.body = { error: 'challengeId, memberPubkey, and signature are required' };
        return;
    }

    const res = verifyAndSolveChallenge({ challengeId, memberPubkey, signature, signedFor });
    if (!res.ok) {
        let status = 400;
        if (res.status) {
            // 421 wrong_community, 426 app_too_old (engine/member-signature.ts)
            status = res.status;
        } else if (res.error?.includes('Challenge not found')) {
            status = 404;
        } else if (res.error?.includes('signature') || res.error?.includes('Signature') || res.error?.includes('role') || res.error?.includes('inactive') || res.error?.includes('Member not found')) {
            status = 403;
        }
        ctx.status = status;
        ctx.body = { error: res.error, ...(res.code ? { code: res.code } : {}) };
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
 * Exchanges single-use 60s handshake token for a browser session (15 min idle / 12h hard).
 * Single-use: burned immediately, replays rejected.
 * Its one caller is /settings redeeming the phone app's "Manage" hand-off (#handoff=…, apps/manager/src/lib/key-session.ts),
 * a page in the phone's in-app browser that App Lock can't always cover: so the short idle (PHONE_HANDOFF_IDLE_TTL_MS).
 */
router.post('/api/local/admin/auth/exchange', async (ctx) => {
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    const token = body.token || (ctx.query?.token as string);
    if (!token) {
        ctx.status = 400;
        ctx.body = { error: 'token is required' };
        return;
    }

    const res = consumeHandshakeToken(token, Date.now(), { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS });
    if (!res.ok) {
        ctx.status = 401;
        ctx.body = {
            error: res.error,
            replay: res.replay,
            expired: res.expired,
            revoked: res.revoked,
            // Whose link it was (only to the holder of the token): /settings compares it with any sign-in still live here.
            mintedFor: res.mintedFor,
        };
        return;
    }

    // The session's id goes in the httpOnly cookie and nowhere else: in the body, a script on the page could read it
    // and use it from anywhere, without the cookie or a CSRF token (Fable's web review, L3).
    setAdminSessionCookie(ctx, res.sessionId!);
    if (res.csrfToken) {
        ctx.set('X-CSRF-Token', res.csrfToken);
    }
    ctx.set('Cache-Control', 'no-store');
    ctx.body = {
        success: true,
        csrfToken: res.csrfToken,
        memberPubkey: res.memberPubkey,
        role: res.role,
        hardExpiresAt: res.hardExpiresAt,
        idleExpiresAt: res.idleExpiresAt,
    };
});

/**
 * POST /api/local/admin/auth/password — Settings' password sign-in. Body: { password, totpCode? }.
 *
 * The password (and, with 2FA on, a code) is checked once, exactly as checkAdminAuth checks it on any route (the brake,
 * the tarpit, break-glass mode, which refuses it here), and exchanged for an admin session: the httpOnly, SameSite
 * strict admin_session cookie and a CSRF token bound to it, as a key sign-in gets. The browser keeps no copy of the
 * password, in web storage or anywhere else (Fable's web review, M1): the members' web app shares this origin, so
 * anything stored there is one script away. A session the browser already held is ended. Answers the role (owner),
 * the CSRF token and the session's limits; never the session's id.
 */
router.post('/api/local/admin/auth/password', async (ctx) => {
    ctx.set('Cache-Control', 'no-store');
    if (isPasswordRetired()) { refusePasswordRetired(ctx); return; }
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    if (typeof body.password !== 'string' || !body.password.trim()) {
        ctx.status = 400;
        ctx.body = { error: 'Enter the admin password' };
        return;
    }
    // opensSession: this session is held to the 2FA setup card while the node's 2FA is off (admin-auth.ts step 7c).
    if (!(await checkAdminPasswordAuth(ctx as any, { opensSession: true }))) return;
    // checkAdminAuth hands a header client a 2FA session for its next requests (X-Admin-2FA-Session); this sign-in's
    // next requests ride the cookie, so it is not handed out.
    const tfa = (ctx.state as any)?.tfaSessionToken;
    if (tfa) {
        revoke2faSession(tfa);
        delete (ctx.state as any).tfaSessionToken;
    }
    const held = ctx.cookies.get(ADMIN_SESSION_COOKIE);
    if (held) revokeAdminSession(held);
    const session = createPasswordSession();
    setAdminSessionCookie(ctx, session.sessionId);
    ctx.set('X-CSRF-Token', session.csrfToken);
    logger.security('AUTH', 'Successful administrative login.');
    ctx.body = {
        success: true,
        role: 'owner',
        // With the node's 2FA off this session opens only the 2FA setup card (admin-auth.ts TOTP_SETUP_ROUTES).
        totpSetupRequired: passwordSessionNeedsTotpSetup(),
        csrfToken: session.csrfToken,
        hardExpiresAt: session.hardExpiresAt,
        idleExpiresAt: session.idleExpiresAt,
    };
});

// "Sign me out everywhere" from the app: its own nonces, within a 60-second window (engine/member-signature.ts).
const revocationNonces = new NonceStore(60_000);

/**
 * POST /api/local/admin/auth/revoke-all — "Sign out everywhere" (Settings' Owners & admins, the app's admin rows).
 * Revoke all web sessions for a member by bumping session_epoch in SQLite. Who can end whose:
 *   - a key session (owner, admin, moderator) or the app's signed request: the caller's own; the signed request always
 *     the signer's, whatever the body names;
 *   - an owner's key session, or the password: another member's too, named in the body (from the phone, after its
 *     unlock again); the password naming nobody is refused (400), as it has no sessions of its own;
 *   - an automation token: nobody's (403 token_not_allowed, as on every sign-in route).
 * test-automation-tokens section 4b measures each over HTTP.
 */
router.post('/api/local/admin/auth/revoke-all', async (ctx) => {
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    let targetPubkey = body.memberPubkey || body.pubkey;
    // The caller's own key, from their authentication alone (a key session, or the app's signature), never the body.
    let selfPubkey = '';

    // Check if called with an active admin session or password auth
    const isAuthed = await checkAdminAuth(ctx as any);
    // An automation token has no sessions of its own, so it signs out nobody: checkAdminAuth refuses it here as on every
    // sign-in route (403 token_not_allowed), and that answer stands rather than falling through to the app's signature.
    if (!isAuthed && ctx.status === 403 && (ctx.body as any)?.code === TOKEN_REFUSED_CODE) return;
    if (isAuthed) {
        const callerPubkey = (ctx.state as any)?.actor;
        const callerRole = (ctx.state as any)?.adminRole;
        if ((ctx.state as any)?.isKeySession && typeof callerPubkey === 'string') selfPubkey = callerPubkey;
        if (callerRole !== 'owner' && callerPubkey && targetPubkey && targetPubkey !== callerPubkey) {
            ctx.status = 403;
            ctx.body = { error: 'Non-owner administrators can only revoke their own sessions' };
            return;
        }
        // Signing someone else out everywhere is owner-only (above): from the phone it asks for its unlock again. Ending
        // your own sessions is not asked.
        if (targetPubkey && targetPubkey !== callerPubkey && !requirePhoneStepUp(ctx)) return;
        // The password is nobody's own session: it signs out only the member it names, never one picked for it.
        if (!targetPubkey && !callerPubkey) {
            ctx.status = 400;
            ctx.body = { error: 'Name the member to sign out everywhere (memberPubkey)' };
            return;
        }
        targetPubkey = targetPubkey || callerPubkey;
    } else {
        // Allow mobile app with signed headers (X-Public-Key, X-Signature). This path skips the signature middleware, so
        // the signer is taken here as the middleware takes it: in the one spelling (engine/member-key.ts
        // provenKeySpelling). The signature check forgives case, so as sent, a key in capitals was the row an old door
        // stored under that spelling, and "sign me out everywhere" ended that row's sessions instead of the member's.
        // Verified as every signed request is (engine/member-signature.ts): signed for this community (421 for
        // another's, 426 for the old format after the switch), and the nonce spent only once all of that holds.
        const pubKeyHex = provenKeySpelling(ctx.get('X-Public-Key'));
        const signatureBase64 = ctx.get('X-Signature');
        if (pubKeyHex && signatureBase64 && nodeRoleOf(pubKeyHex)) {
            const timestampHeader = ctx.get('X-Timestamp');
            const nonce = ctx.get('X-Nonce');
            const ts = Number(timestampHeader);
            if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 60_000 || !nonce) {
                ctx.status = 401;
                ctx.body = { error: 'Missing or stale timestamp / nonce headers' };
                return;
            }
            const signedForHeader = ctx.headers[SIGNED_FOR_HEADER.toLowerCase()];
            const verdict = verifyMemberSignature({
                pubKeyHex, signature: signatureBase64, timestamp: timestampHeader, nonce,
                method: ctx.method, path: ctx.path, body: (ctx as any).rawBody ?? '',
                signedFor: typeof signedForHeader === 'string' ? signedForHeader : null,
            }, { consumeNonce: true, freshnessMs: 60_000, nonces: revocationNonces });
            if (verdict.ok) {
                targetPubkey = verdict.signer;
                selfPubkey = verdict.signer;
            } else {
                ctx.status = verdict.status === 403 || verdict.status === 400 ? 401 : verdict.status;
                ctx.body = verdict.code ? { error: verdict.error, code: verdict.code } : { error: verdict.error };
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
    // An owner signing out their OWN sessions everywhere (a key session naming itself or nobody, or the app's signed
    // request) also retires their break-glass code (#1531), so a code a stolen session made does not outlive it. Signing
    // someone else out leaves their code alone, as does the password, which is nobody's own session.
    const breakGlassCodeRetired = !!selfPubkey && selfPubkey === targetPubkey && nodeRoleOf(targetPubkey) === 'owner'
        && retireBreakGlassCode(targetPubkey);
    clearAdminSessionCookie(ctx);
    ctx.status = 200;
    ctx.body = {
        success: true,
        memberPubkey: targetPubkey,
        sessionEpoch: newEpoch,
        breakGlassCodeRetired,
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
        if (res.valid && res.session?.kind === 'password') {
            ctx.body = {
                authenticated: true,
                isKeySession: false,
                isPasswordSession: true,
                memberPubkey: null,
                role: 'owner',
                totpSetupRequired: passwordSessionNeedsTotpSetup(),
                hardExpiresAt: res.session.hardExpiresAt,
                idleExpiresAt: res.session.idleExpiresAt,
            };
            return;
        }
        if (res.valid && res.session) {
            ctx.body = {
                authenticated: true,
                isKeySession: true,
                memberPubkey: res.session.memberPubkey,
                // Whose session, in words: /settings names it when a link from the phone finds someone else signed in.
                callsign: getMember(res.session.memberPubkey)?.callsign ?? null,
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
    clearAdminSessionCookie(ctx);
    ctx.body = { success: true };
});

/**
 * POST /api/local/admin/auth/enrol
 * POST /api/local/admin/auth/break-glass/enrol
 * Enrols a member key and generates a unique per-owner break-glass code.
 * In break-glass mode, this is the ONLY route password/break-glass credentials can access.
 */
/**
 * Whether a role change needs an owner (engine/node-roles.ts): it names 'owner' or 'admin', or its target holds owner or
 * admin now (a grant replaces the role the target holds, so "grant moderator" to a co-owner removes an owner). Such a
 * change from the phone's Manage hand-off asks for its unlock again (admin-auth.ts requirePhoneStepUp), as every
 * owner-only route does; an admin appointing or removing a moderator is not asked.
 */
function roleChangeNeedsOwner(targetPubkey: string, role: string): boolean {
    if (role === 'owner' || role === 'admin') return true;
    const held = heldNodeRoleOf(targetPubkey);
    return held === 'owner' || held === 'admin';
}

/**
 * The step-up on a suspension or Decision action that only an owner may make on this target (decisions-engine
 * adminActionNeedsOwner, the engine's own owner-only conditions): suspending an owner, lifting or halting what gives back
 * an owner's or admin's role, cutting short an owner's or admin's removal, removing (pruning, offboarding) or re-keying an
 * owner or admin. From the phone's Manage hand-off it asks for its unlock again (requirePhoneStepUp). `actor` is the one the
 * engine is given. Answers 403 and returns false when that is due.
 */
function stepUpIfOwnerOnly(ctx: any, action: OwnerOnlyAdminAction, target: string, actor = ''): boolean {
    // An automation token acts for the owner who made it but never as them: what an owner may do to themselves (prune
    // their own branch) is still an owner's action, so it is refused to the token (requirePhoneStepUp).
    const asActor = ctx.state?.automationTokenId ? '' : actor;
    return !adminActionNeedsOwner(action, target, asActor) || requirePhoneStepUp(ctx);
}

const handleEnrol = async (ctx: any) => {
    // First, so a refusal is never cached either: a new owner's answer carries their break-glass code (#1531).
    ctx.set('Cache-Control', 'no-store');
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    const targetPubkey = body.memberPubkey || body.publicKey || body.pubkey || (ctx.state as any)?.actor;
    if (!targetPubkey) {
        ctx.status = 400;
        ctx.body = { error: 'memberPubkey is required' };
        return;
    }
    // One key, one spelling (engine/member-key.ts): a role is for a member's key as this community keeps it, never a row
    // a door stored under another spelling before that rule (reportMisspeltMemberKeys). Before any lookup or write.
    if (!isMemberKeySpelling(targetPubkey)) {
        ctx.status = 400;
        ctx.body = { error: BAD_KEY_ERROR, code: BAD_KEY_CODE };
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
    if (roleChangeNeedsOwner(targetPubkey, requestedRole) && !requirePhoneStepUp(ctx)) return;

    try {
        const res = enrolAdminOwnerKey({
            targetPubkey,
            actorPubkey: (ctx.state as any)?.actor || (isBreakGlass ? 'break-glass:enrolment' : 'owner:password'),
            isBreakGlass,
            role: requestedRole,
            madeBy: (ctx.state as any)?.isKeySession ? 'key-session' : isBreakGlass ? 'break-glass' : 'password',
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
 * POST /api/local/admin/auth/break-glass/issue
 * Settings' "Make a break-glass code": a new code for an owner, shown once; the owner's earlier code stops working.
 * Owners only. A key session makes one for its own key and nobody else's. The password (an owner with no key behind it)
 * names the owner in `memberPubkey`, which must hold the owner role already: this grants nothing. A break-glass code is
 * a wrong password here (admin-auth.ts opens only the enrol routes to it), and break-glass mode closes it to the
 * password, as it does every route but enrolment.
 */
router.post('/api/local/admin/auth/break-glass/issue', async (ctx) => {
    // First, so a refusal is never cached either (#1531).
    ctx.set('Cache-Control', 'no-store');
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner'], 'Only a node owner can make a break-glass code')) return;
    const state = ctx.state as any;
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    let target: string;
    if (state.isKeySession) {
        target = state.actor;
        if (body.memberPubkey && body.memberPubkey !== target) {
            ctx.status = 403;
            ctx.body = { error: 'A break-glass code is made by its own owner: sign in with that owner\'s key' };
            return;
        }
    } else {
        target = typeof body.memberPubkey === 'string' ? body.memberPubkey : '';
        if (!target) {
            ctx.status = 400;
            ctx.body = { error: 'memberPubkey is required: name the owner the code is for' };
            return;
        }
        if (!isMemberKeySpelling(target)) {
            ctx.status = 400;
            ctx.body = { error: BAD_KEY_ERROR, code: BAD_KEY_CODE };
            return;
        }
    }
    try {
        const code = issueBreakGlassCode(target, state.isKeySession ? `their own key session` : 'the admin password',
            state.isKeySession ? 'key-session' : 'password');
        ctx.body = {
            success: true,
            memberPubkey: target,
            breakGlassCode: code,
            message: 'Store this break-glass code securely. It will only be shown once.',
        };
    } catch (e: any) {
        ctx.status = Number(e?.status) || 400;
        ctx.body = { error: e?.message || 'Could not make a break-glass code' };
    }
});

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
    // Owner-only, checked here rather than by requireAdminRole: from the phone it asks for its unlock again too.
    if (!requirePhoneStepUp(ctx)) return;
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

// ===================== RETIRE THE ADMIN PASSWORD (node sign-in design step 10, D1(c), D6) =====================

/** The owners whose role acts now (a visitor's old row or a suspended owner is not one). */
function actingOwners() {
    return listNodeRoles().filter(r => r.role === 'owner' && nodeRoleOf(r.member_pubkey) === 'owner');
}

/** What Access & Security's "Retire the admin password" card shows. */
function passwordRetirementView(callerPubkey: string | null) {
    const retired = getLocalConfig().passwordRetired || null;
    const owners = actingOwners();
    return {
        passwordRetired: !!retired,
        retiredAt: retired?.at ?? null,
        retiredByCallsign: retired?.byCallsign ?? null,
        owners: owners.length,
        // The caller's own break-glass code: retiring needs one (below). Null for a caller with no key (the password).
        hasBreakGlassCode: callerPubkey ? !!owners.find(o => o.member_pubkey === callerPubkey)?.has_break_glass : null,
    };
}

/**
 * GET /api/local/admin/auth/password-retirement — owners only.
 */
router.get('/api/local/admin/auth/password-retirement', async (ctx) => {
    ctx.set('Cache-Control', 'no-store');
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner'], 'Only a node owner can see whether the admin password is retired')) return;
    const state = ctx.state as any;
    ctx.body = passwordRetirementView(state.isKeySession ? state.actor : null);
});

/**
 * POST /api/local/admin/auth/retire-password { acceptOneOwner?: true } — retires the admin password for good.
 * An owner signed in with their own key only (never the password itself, never a token), with the phone step-up of every
 * owner-only change. Refused while the caller has no break-glass code: with the password gone it is how an owner whose
 * phone is lost gets back in without the server's shell, and Settings makes one in a tap (step 3). Refused with one owner
 * unless the owner ticks "I accept one owner" (D6), which is logged. Then: the hash, the salt and the 2FA that guarded the
 * password are deleted, passwordRetired records when and by whom, every password session ends now (and the log sockets
 * they opened), the first-password file goes, a SECURITY line is logged and the community gets a critical announcement.
 * No route sets a password again; ADMIN_PASSWORD in .env is ignored on every later start (initAdminPassword).
 */
router.post('/api/local/admin/auth/retire-password', async (ctx) => {
    ctx.set('Cache-Control', 'no-store');
    if (!(await checkAdminAuth(ctx as any))) return;
    const state = ctx.state as any;
    if (!state.isKeySession || state.adminRole !== 'owner') {
        ctx.status = 403;
        ctx.body = {
            error: 'Only an owner signed in with their own key (Manage in the app, or "Sign in with your phone" on a computer) can retire the admin password',
            code: 'owner_key_required',
        };
        return;
    }
    if (!requirePhoneStepUp(ctx)) return;
    if (isPasswordRetired()) {
        ctx.status = 409;
        ctx.body = { error: 'The admin password is already retired', code: 'password_retired', ...passwordRetirementView(state.actor) };
        return;
    }
    const owners = actingOwners();
    const me = owners.find(o => o.member_pubkey === state.actor);
    if (!me?.has_break_glass) {
        ctx.status = 409;
        ctx.body = {
            error: 'Make your break-glass code first (Access & Security, Break-glass code) and keep it somewhere safe: once the password is gone, it is how you get back in if your phone is lost.',
            code: 'break_glass_code_needed',
        };
        return;
    }
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    const oneOwner = owners.length < 2;
    if (oneOwner && body.acceptOneOwner !== true) {
        ctx.status = 409;
        ctx.body = {
            error: 'This community has one owner. Add a second owner first, or tick "I accept one owner": if your phone and your 12 words are both lost, only your break-glass code or "beanpool recover" on the server get you back in.',
            code: 'one_owner',
            owners: owners.length,
        };
        return;
    }
    const at = Date.now();
    const callsign = me.callsign || null;
    updateLocalConfig({
        adminHash: null, salt: null,
        totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [],
        passwordRetired: { at, by: state.actor, byCallsign: callsign, acceptedOneOwner: oneOwner },
    });
    removeFirstPasswordFile('The admin password was retired');
    const ended = endPasswordSessions();
    const who = `${callsign || 'an owner'} (${String(state.actor).slice(0, 12)}…)`;
    logger.security('AUTH', `The admin password was retired for good by ${who}${oneOwner ? ', who accepted being the only owner' : ''}; ${ended} password session(s) ended`);
    adminBroadcastAnnouncement('Admin Password Retired',
        `${callsign || 'An owner'} retired this community's admin password. Settings now opens only with an owner's or admin's phone. If you did not expect this, tell your community's owners.`,
        'critical');
    ctx.body = { success: true, ...passwordRetirementView(state.actor), acceptedOneOwner: oneOwner, endedSessions: ended };
});

// ===================== LEDGER AUDIT ENDPOINTS =====================
// #129: On-demand audit + drift acknowledgment endpoints.
// Operators can call ledger-audit to inspect the current conservation state,
// and ledger-rebaseline to acknowledge known pre-existing drift with a written note.

router.post('/api/local/admin/ledger-audit', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const result = runLedgerAudit();
        // Which balances aren't a number, and what to do (#1445 re-review): a count alone left the operator to find them.
        const broken = result.badBalances > 0 ? listBrokenBalances() : null;
        ctx.body = {
            success: true,
            sumBalances: result.sumBalances,
            baseline: result.baseline,
            drift: result.drift,
            strandedEscrows: result.strandedEscrows,
            badBalances: result.badBalances,
            ok: result.ok,
            ...(broken ? { brokenBalances: broken.accounts, ...(broken.total > broken.accounts.length ? { brokenBalancesMore: broken.total - broken.accounts.length } : {}), repair: BROKEN_BALANCE_REPAIR } : {}),
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
        // A ledger holding a balance that isn't a finite number has no sum to set a baseline at: one of 9e999 makes the
        // sum Infinity, which this wrote as the baseline and answered "ok". Those rows are mended first (#1445 review).
        if (result.badBalances > 0 || !Number.isFinite(result.sumBalances)) {
            // Named, with the way to mend them (#1445 re-review): no route or Settings control mends a balance.
            const broken = listBrokenBalances();
            const named = broken.accounts.map((b) => `${b.account}${b.callsign ? ` (${b.callsign})` : ''} holds ${b.holds}`).join('; ');
            const more = broken.total > broken.accounts.length ? `; and ${broken.total - broken.accounts.length} more` : '';
            ctx.status = 409;
            ctx.body = {
                success: false,
                error: `${result.badBalances} account balance(s) are not a number, so the ledger has no total to set a new baseline at. `
                    + `Nothing was changed. ${named ? `They are: ${named}${more}. ` : ''}${BROKEN_BALANCE_REPAIR}`,
                brokenBalances: broken.accounts,
                repair: BROKEN_BALANCE_REPAIR,
            };
            return;
        }
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
        const listed = listStrandedEscrows();
        // A look at the trades these escrows were stuck in, like a look at the disputes (review r4177560417 item 4): a
        // line of its own in the log the owner and admins read, naming each trade (or the escrow, when its trade is
        // gone), first.
        if (!logDisputesOrRefuse(ctx, 'stranded_escrows_read', listed.escrows.map(e => e.tradeId ?? e.escrowId))) return;
        ctx.body = { success: true, ...listed };
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
    ctx.body = healthFor(ctx);
});

/**
 * A background check of the alerts (the manager's five-minute tick, the built-in page's reloads) is no admin's look: it
 * asks with `alerts: 'summary'` and gets each alert's kind and severity, the ones that name members with no member, no
 * description and no Beans, and nothing is logged (review r4177560410).
 */
function wantsAlertsSummary(ctx: any): boolean {
    const body = (ctx as any).requestBody || (ctx as any).request?.body || {};
    return body?.alerts === 'summary' || ctx.query?.alerts === 'summary';
}

function alertsSummary<T extends { flags: Array<{ type: string; severity: string; description: string; members: string[] }> }>(health: T): T {
    return {
        ...health,
        flags: health.flags.map(f => (Array.isArray(f.members) && f.members.length)
            ? { type: f.type, severity: f.severity, description: 'An alert that names members: open the alerts to see it.', members: [], namesHidden: true }
            : f),
    } as T;
}

/**
 * The manager's background check: each alert's kind and severity, names-free, the reports' count, and each report's id
 * (the same reports /admin/data lists, no reporter, member or reason), which is what lights the manager's ALERT dot for a
 * report filed since its last full read and keeps a report it dismissed dark (confirmation 1, r4177719213). Logs nothing.
 */
router.post('/api/local/admin/alerts-summary', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.set('Cache-Control', 'no-store');
    const reportIds = db.prepare('SELECT id FROM abuse_reports ORDER BY created_at DESC').pluck().all() as string[];
    ctx.body = { flags: alertsSummary(getCommunityHealth()).flags, reportCount: getReportCount(), reportIds };
});

function healthFor(ctx: any) {
    const health = getCommunityHealth();
    return wantsAlertsSummary(ctx) ? alertsSummary(health) : withLoggedAlerts(ctx, health);
}

/**
 * The fraud alerts that name members are an admin's look at those members' trades (queue item 29, Marty 4 Oct): a line
 * per member named in the log the owner and admins read, first. Not logged (a standby, which writes no plain table):
 * the alerts that name someone are left out of the answer.
 */
function withLoggedAlerts<T extends { flags: Array<{ members: string[] }> }>(ctx: any, health: T): T {
    try {
        logAlertsLook((ctx.state as any)?.actor || 'owner:password', health.flags, lookTokenOf(ctx));
        return health;
    } catch {
        return { ...health, flags: health.flags.filter(f => !(Array.isArray(f.members) && f.members.length)) };
    }
}

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
            // An admin sees no more of a member's contact details than any member does: the choice reads "Hidden —
            // only you can see it", and the manager never shows them. `profiles` below goes through the same rule as
            // the profile page (contactVisibleTo) with no viewer, and a password proves no member, so it carries no
            // contact details at all. The rest of the row stays: the manager draws the invite tree, pruning and roles
            // from it. Each photo as its URL (avatarUrlOf, from the row's avatar_ref), which the manager, served by this node,
            // shows as it shows a photo: a list of every member never reads every photo (it sent each one twice, here and in
            // `profiles`, which at 30,000 members with photos would be 1.6 GB).
            const { contactValue, contactVisibility, avatarRef, ...row } = m;
            void contactValue; void contactVisibility;
            return {
                ...row,
                avatarUrl: avatarUrlOf(m.publicKey, avatarRef),
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
        // The admins see posts hidden by reports too (G3), marked hiddenByReportsAt. Polls carry their counts and not
        // who voted for what: that is for members (includeVoters), and the manager never shows it.
        posts: getPosts({ includeHidden: true }).filter(p => p.status !== 'cancelled'),
        health: healthFor(ctx),
        reports: getReports().reports,
        reportCount: getReportCount(),
        escrowDisputesCount: (db.prepare(`
            SELECT COUNT(*)
            FROM marketplace_transactions
            WHERE status = 'pending'
              AND (julianday('now') - julianday(created_at)) >= 7
        `).pluck().get() as number) || 0,
        // Each member's posts and messages; of trades, only the community's totals (queue item 29, Marty 4 Oct).
        memberStats: getMemberStats(),
        tradeTotals: getTradeTotals(),
    };
});

router.post('/api/local/admin/ws-connections', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = {
        connections: Array.from(activeConnections.values()),
        analytics: calculateAnalytics()
    };
});

// Not with the replication token: it lets a standby copy this server and does nothing else (routes/backup.ts).
router.post('/api/local/admin/logs', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || {};
    const { level, category, searchQuery } = body;
    const parsedLimit = parseInt(String(body.limit), 10);
    const limit = Math.max(1, Math.min(isNaN(parsedLimit) ? 100 : parsedLimit, 500));
    const parsedOffset = parseInt(String(body.offset), 10);
    const offset = Math.max(0, isNaN(parsedOffset) ? 0 : parsedOffset);

    // A removal's settled balance is a look at another member's balance, which an admin has only while removing them
    // (logged: health_access_log). So this answers none, to any reader: not the metadata's balanceSettled, and not the
    // "(settled balance: N)" a node wrote into the message before; the search reads the message as answered, so it can't
    // find the number either (review r4176631042).
    const message = `CASE WHEN instr(message, ' (settled balance: ') > 0
        THEN substr(message, 1, instr(message, ' (settled balance: ') - 1)
            || substr(substr(message, instr(message, ' (settled balance: ') + 19), instr(substr(message, instr(message, ' (settled balance: ') + 19), ')') + 1)
        ELSE message END`;
    let sql = `SELECT id, timestamp, level, category, ${message} AS message,
        CASE WHEN json_valid(metadata) THEN json_remove(metadata, '$.balanceSettled') ELSE metadata END AS metadata
        FROM system_logs WHERE 1=1`;
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
        sql += ` AND ${message} LIKE ? ESCAPE '\\'`;
        params.push(likeContains(String(searchQuery)));
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
            // The community's contacts as stored, for the owner's Node Identity screens (the manager, static/settings.js):
            // the public /api/local/community-info says each only when it is published. Null for none, so a screen
            // can tell "none stored" from an answer that didn't load.
            contactEmail: config.contactEmail || null,
            contactPhone: config.contactPhone || null,
            shutdownStatus: getShutdownStatus(),
            // The Settings banner when this server's standby needs its owners (services/standby-health.ts): the
            // community's owners only, so null to an admin or a moderator, and on a server that is not the main one (or
            // was, until another took it over).
            standbyHealth: ctx.state?.adminRole === 'owner' && watchesStandbys() ? getStandbyHealthBanner() : null,
            // Off-box backups (services/offbox-backups.ts) when they need the owners: failing, stale, a destination that
            // can't be used, or none sent for want of a recovery code. In words; nothing about any member. Owners only.
            offboxBackups: ctx.state?.adminRole === 'owner' ? getOffboxHealth() : null,
            diskHealth: getCachedDiskHealth(),
            // Stray rejected promises the process-level net caught and kept serving through. The error
            // text only — no request body, no parameter, no key — and already redacted on the way in.
            // Zeroes on a node that has had none, which is every healthy node.
            unhandledRejections: getUnhandledRejectionSummary(),
            // Whether this server's pushes go with an Expo access token (config/expo-access-token.ts): 'set', 'not set',
            // or 'unusable' (set, but nothing a header can carry). Never the token.
            pushAccessToken: expoAccessTokenStatus(),
            // What Expo refused since this server started, by Expo's code (`UNAUTHORIZED`: it wants an access token this
            // server doesn't send), with a count and when: state-engine.ts readExpoAnswer. Empty on a healthy node.
            pushRefusals: pushServiceRefusals(),
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
 * return because none is stored — see M2 in docs/ONBOARDING.md. Beside them, `openDoor`:
 * whether the open door takes joins now (config/node-profile.ts `openJoin`, as
 * /api/community/info says it), so the screen can say why nobody came through it.
 */
const getOnboardingFunnelHandler = async (ctx: any) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        // Registered for POST as well as GET, so read the body too — otherwise a POST
        // carrying {"days": 90} silently answers with 30 and looks like the window
        // control is broken. Clamped rather than trusted; see clampDays.
        const days = clampDays(ctx.query?.days ?? ctx.requestBody?.days ?? 30);
        ctx.body = { days, rows: getFunnel(days), openDoor: getProfileSwitches().openJoin };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
};

router.get('/api/local/admin/onboarding-funnel', getOnboardingFunnelHandler);
router.post('/api/local/admin/onboarding-funnel', getOnboardingFunnelHandler);

/**
 * The web app's visits a day (engine/web-visits.ts), for the manager's Home: the last `days` days (30 unless asked, at
 * most the 400 kept), oldest first and ending today (UTC), a day with none as zeros. Counts only: the table holds nothing
 * else. Read-only, owners and admins (a moderator's session reaches reports only, admin-auth.ts).
 */
router.get('/api/local/admin/web-visits', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const days = clampVisitDays(ctx.query?.days ?? 30);
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { days, retentionDays: VISIT_RETENTION_DAYS, series: getWebVisits(days) };
});

/**
 * The phone app's versions in this community and each platform's floor, for the manager's "App versions" card: whom a
 * raised floor would stop, before it is raised. Counts only (app-version-counts.ts: members seen in the last 30 days, or
 * since the server started), never who. Each platform's floor as set, its store's build, whether the floor is enforced
 * or held for the store, its grace date and whether it stops apps yet (app-store-versions.ts). Read-only, owners and
 * admins (a moderator's session reaches reports only, admin-auth.ts).
 */
router.get('/api/local/admin/app-versions', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const now = new Date();
    const counts = getAppVersionCounts(now.getTime());
    const platforms = Object.fromEntries(APP_PLATFORMS.map(p => [p, { ...getPlatformFloorDetail(p, now), versions: counts.platforms[p] }]));
    ctx.set('Cache-Control', 'no-store');
    ctx.body = {
        since: counts.since,
        windowDays: counts.windowDays,
        minAppVersion: getMinAppVersion(),
        minAppVersionFrom: getMinAppVersionFrom(),
        storeCheckedAt: getAppStoreVersions().checkedAt,
        platforms,
    };
});


router.post('/api/local/admin/posts/:id/delete', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    // A moderator takes down reported posts only (admin-auth.ts, MODERATOR_ROUTES): the post needs an open
    // report. A dismissed ('reviewed') or actioned one no longer counts.
    if ((ctx.state as any)?.adminRole === 'moderator'
        && !db.prepare("SELECT 1 FROM abuse_reports WHERE target_post_id = ? AND target_pulse_item_id IS NULL AND (status = 'pending' OR status IS NULL) LIMIT 1").get(ctx.params.id)) {
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
                warning: `Removed, but ${refundShortfalls.length} escrow refund(s) didn't match their trade: `
                    + refundShortfalls.map(describeRefundShortfall).join('; '),
            }
            : { success: true };
    } catch (e: any) {
        console.error('Error deleting post:', e);
        // A Commons pot that isn't a number pauses every Bean move (engine/audit.ts COMMONS_POT_PAUSED): plain words, 503.
        if (answerPotPaused(ctx, e)) return;
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

/**
 * Is `pubkey` the moderator making this request, or an enterprise they keep? Then what members did about it is
 * theirs, and someone else decides (G3). The moderator's key comes from their signed session; any keeper row counts,
 * whatever it lets them spend, since the stake is the same.
 */
function isModeratorsOwn(ctx: any, pubkey: string | null | undefined): boolean {
    const actor = ctx.state?.actor as string | undefined;
    if (ctx.state?.adminRole !== 'moderator' || !actor || !pubkey) return false;
    if (pubkey.toLowerCase() === actor.toLowerCase()) return true;
    return !!db.prepare('SELECT 1 FROM treasury_operators WHERE member_pubkey = ? AND treasury_pubkey = ?').get(actor, pubkey);
}

/**
 * A moderator can't undo what members did about their own post, or one by an enterprise they keep, by restoring it, by
 * dismissing a report on it (a dismissal un-hides it once the rest no longer add up), or by closing a report on it
 * without taking it down (a closed report no longer counts towards a hide), as they can't lift their own mute: that is
 * for another moderator, an admin or an owner. Refuses 403 and returns true when so.
 */
function refuseModeratorsOwnPost(ctx: any, postId: string | null | undefined, doing: string): boolean {
    if (!postId) return false;
    const post = db.prepare('SELECT author_pubkey FROM posts WHERE id = ?').get(postId) as { author_pubkey: string | null } | undefined;
    if (!isModeratorsOwn(ctx, post?.author_pubkey)) return false;
    ctx.status = 403;
    ctx.body = { success: false, error: `A moderator cannot ${doing} their own post, or one by an enterprise they keep. Ask another moderator, an admin or an owner.` };
    return true;
}

/**
 * Restore a post hidden by reports (G3, engine/auto-moderation.ts). Owners, admins and moderators: every open report
 * on it is dismissed (its reporters hear it was kept, and cannot hide it again), and everyone sees it again. A
 * moderator can't restore their own.
 */
router.post('/api/local/admin/posts/:id/restore', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (refuseModeratorsOwnPost(ctx, ctx.params.id, 'restore')) return;
    try {
        const result = restoreHiddenPost(ctx.params.id);
        if (result === 'not_found') {
            ctx.status = 404;
            ctx.body = { success: false, error: 'Post not found' };
            return;
        }
        if (result === 'not_hidden') {
            ctx.status = 409;
            ctx.body = { success: false, error: 'This post is not hidden, so there is nothing to restore' };
            return;
        }
        const by = ctx.state?.actor ? String(ctx.state.actor).substring(0, 12) : 'owner:password';
        logger.info('ADMIN', `Restored post ${ctx.params.id}, hidden by reports, by ${by} (${(ctx.state as any)?.adminRole})`);
        ctx.body = { success: true };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, error: e?.message || 'Failed to restore post' };
    }
});

/**
 * Members muted after 3 posts were removed in 30 days (G3), for the moderators who lift it.
 */
router.get('/api/local/admin/members/muted', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = { success: true, members: listMutedMembers() };
});

/**
 * Lift a member's mute (G3). Owners, admins and moderators, the actor from their signed session, never the body. A
 * moderator can't lift their own, or one on an enterprise they keep: someone else decides.
 */
router.post('/api/local/admin/members/:pubkey/unmute', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const actor = (ctx.state as any)?.actor as string | undefined;
    const pubkey = ctx.params.pubkey;
    if (isModeratorsOwn(ctx, pubkey)) {
        ctx.status = 403;
        ctx.body = { success: false, error: 'A moderator cannot lift their own mute, or one on an enterprise they keep. Ask another moderator, an admin or an owner.' };
        return;
    }
    if (!getMember(pubkey)) {
        ctx.status = 404;
        ctx.body = { success: false, error: 'Member not found' };
        return;
    }
    if (!liftModerationMute(pubkey)) {
        ctx.status = 409;
        ctx.body = { success: false, error: 'This member is not muted' };
        return;
    }
    logger.info('ADMIN', `Lifted the mute on ${pubkey.substring(0, 12)} by ${actor ? actor.substring(0, 12) : 'owner:password'} (${(ctx.state as any)?.adminRole})`);
    ctx.body = { success: true };
});

// ── Clean-up by burst (engine/burst-cleanup.ts; global two-doors design §4.4, slice S9) ──────────────────────────────
// From one account, the others that joined through the open door from the same connection within a day of it: hide all
// their posts (and undo that), or remove them, in one action. Owners, admins and moderators, except removing, which is
// the owners' and admins' as removing one member is. Where the door labels no joins (every local community) each route
// is 404 once the caller is signed in, as every admin route asks checkAdminAuth first (test-moderator-routes).

function burstsHere(ctx: any): boolean {
    if (burstCleanupOn()) return true;
    ctx.status = 404;
    ctx.body = { error: 'Not Found' };
    return false;
}

/** The role this request acts with: a key session's live role, or 'owner' for the password (admin-auth.ts). */
function burstActorRole(ctx: any): BurstActorRole | null {
    const role = ctx.state?.adminRole;
    return role === 'owner' || role === 'admin' || role === 'moderator' ? role : null;
}

/**
 * The account a burst is opened from, from the path: null after answering 400 (no key), 404 (no member here) or 403 (a
 * moderator, for an account with no open report by someone else and in no burst the digest lists).
 */
function burstAnchor(ctx: any): string | null {
    const key = burstKey(ctx.params.pubkey);
    if (!key) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'That is not a member key', code: 'bad_key' };
        return null;
    }
    if (!isBurstAccount(key)) {
        ctx.status = 404;
        ctx.body = { success: false, error: 'No member here has that key', code: 'not_found' };
        return null;
    }
    // A moderator's own report doesn't count: a moderator is always a key session, so `actor` is their member key.
    const actor = typeof ctx.state?.actor === 'string' ? ctx.state.actor : null;
    if (burstActorRole(ctx) === 'moderator' && !moderatorMayOpen(key, actor)) {
        ctx.status = 403;
        ctx.body = {
            success: false,
            error: 'A moderator sees who joined together from an account with an open report, or from a group listed at the top of Reports.',
            code: 'not_reported',
        };
        return null;
    }
    return key;
}

function answerBurstRefusal(ctx: any, refusal: BurstRefusal): void {
    ctx.status = refusal.status;
    ctx.body = { success: false, error: refusal.error, code: refusal.code, ...(refusal.established ? { established: refusal.established } : {}) };
}

/** The digest: recent bursts of 5 or more, and the burst actions of the last 30 days. */
router.get('/api/local/admin/bursts', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!burstsHere(ctx)) return;
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { success: true, ...burstDigest() };
});

/** One account's burst, each account with its standing, for the moderator to look at before acting. */
router.get('/api/local/admin/members/:pubkey/burst', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!burstsHere(ctx)) return;
    const anchor = burstAnchor(ctx);
    if (!anchor) return;
    const burst = readBurst(anchor)!;
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { success: true, ...burst, count: burst.others.length, establishedStanding: BURST.establishedStanding };
});

/** Hide every post of the named accounts of this burst, in one action that can be undone. Body: { members, count, includeEstablished? }. */
router.post('/api/local/admin/members/:pubkey/burst/hide', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!burstsHere(ctx)) return;
    const role = burstActorRole(ctx);
    const anchor = burstAnchor(ctx);
    if (!anchor || !role) return;
    const selection = checkBurstSelection(anchor, (ctx as any).requestBody || {});
    if (!selection.ok) return answerBurstRefusal(ctx, selection);
    const action = hideBurst(anchor, selection.keys, role);
    const by = ctx.state?.actor ? String(ctx.state.actor).substring(0, 12) : 'owner:password';
    logger.info('ADMIN', `Hid ${action.posts} post(s) of ${action.accounts} account(s) that joined together with ${anchor.substring(0, 12)} (action ${action.id}) by ${by} (${role})`);
    ctx.body = { success: true, action };
});

/** Undo a burst hide: its posts back, but for one reports would hide now. */
router.post('/api/local/admin/bursts/:id/undo', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!burstsHere(ctx)) return;
    const outcome = undoBurst(String(ctx.params.id));
    if (!outcome.ok) {
        ctx.status = outcome.status;
        ctx.body = { success: false, error: outcome.error, code: outcome.code };
        return;
    }
    const by = ctx.state?.actor ? String(ctx.state.actor).substring(0, 12) : 'owner:password';
    logger.info('ADMIN', `Undid burst hide ${ctx.params.id}: ${outcome.restored} post(s) back, ${outcome.keptHidden} kept hidden, by ${by} (${(ctx.state as any)?.adminRole})`);
    ctx.body = { success: true, restored: outcome.restored, keptHidden: outcome.keptHidden };
});

/**
 * Remove the named accounts of this burst, each as one removal removes a member (adminPruneUser, with its rules and the
 * signed actor): owners and admins only. A removed account's sign-in can't join again. Body: { members, count,
 * includeEstablished? }.
 */
router.post('/api/local/admin/members/:pubkey/burst/remove', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!burstsHere(ctx)) return;
    if (!requireAdminRole(ctx, ['owner', 'admin'], 'Removing accounts is for the owners and admins. Hide their posts, and tell them.')) return;
    const actor = resolveAdminActor(ctx);
    const role = burstActorRole(ctx);
    if (!actor || !role) return;
    const anchor = burstAnchor(ctx);
    if (!anchor) return;
    const selection = checkBurstSelection(anchor, (ctx as any).requestBody || {});
    if (!selection.ok) return answerBurstRefusal(ctx, selection);
    const result = removeBurst((pubkey) => adminPruneUser(pubkey, actor), anchor, selection.keys, role);
    logger.info('ADMIN', `Removed ${result.removed} account(s) that joined together with ${anchor.substring(0, 12)} (action ${result.action.id}) by ${actor.substring(0, 12)} (${role})${result.failed.length ? `; ${result.failed.length} refused` : ''}`);
    ctx.body = { success: true, action: result.action, removed: result.removed, failed: result.failed };
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
// Decision in the same transaction. The reason is shown to members on that Decision. With formal Decisions off (the
// global node) it opens no vote: it lasts the 7 days and lifts itself (decisions-engine adminEmergencySuspend).
router.post('/api/local/admin/users/:pubkey/suspend', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const actor = resolveAdminActor(ctx);
    if (!actor) return;
    if (!stepUpIfOwnerOnly(ctx, 'suspend', ctx.params.pubkey)) return;
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
        ctx.body = { error: decisionsOn()
            ? 'Suspend with POST /api/local/admin/users/:pubkey/suspend and a reason; it opens a community vote'
            : 'Suspend with POST /api/local/admin/users/:pubkey/suspend and a reason; it lasts 7 days' };
        return;
    }
    if (status !== 'active') {
        ctx.status = 400;
        ctx.body = { error: 'status must be "active"' };
        return;
    }
    const actor = resolveAdminActor(ctx);
    if (!actor) return;
    if (!stepUpIfOwnerOnly(ctx, 'lift', ctx.params.pubkey)) return;
    const result = adminLiftSuspension(ctx.params.pubkey, actor);
    if (!result.success) {
        ctx.status = result.status || 400;
        ctx.body = { error: result.error };
        return;
    }
    logger.info('ADMIN', `Lifted the suspension of ${ctx.params.pubkey.substring(0, 12)} by ${actor.substring(0, 12)}`);
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
    if (!stepUpIfOwnerOnly(ctx, 'prune', ctx.params.pubkey, actor)) return;
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
    if (!stepUpIfOwnerOnly(ctx, 'prune-branch', ctx.params.pubkey, actor)) return;
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
    // Members whose app was closed read the announcement from the notice's details, which hold this much: refuse a longer
    // one rather than send it cut.
    if (typeof body === 'string' && body.length > ANNOUNCEMENT_LIMITS.body) {
        ctx.status = 400;
        ctx.body = { error: `An announcement can be at most ${ANNOUNCEMENT_LIMITS.body.toLocaleString('en-US')} characters; this one is ${body.length.toLocaleString('en-US')}. Shorten it and send again.` };
        return;
    }
    if (typeof title === 'string' && title.length > ANNOUNCEMENT_LIMITS.title) {
        ctx.status = 400;
        ctx.body = { error: `An announcement's title can be at most ${ANNOUNCEMENT_LIMITS.title} characters; this one is ${title.length}. Shorten it and send again.` };
        return;
    }
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
        // A Pulse report is about its item, whatever post id it carries (state-engine reportSubjectOf).
        const reported = db.prepare('SELECT CASE WHEN target_pulse_item_id IS NULL THEN target_post_id END AS target_post_id FROM abuse_reports WHERE id = ?').get(ctx.params.id) as { target_post_id: string | null } | undefined;
        if (refuseModeratorsOwnPost(ctx, reported?.target_post_id, 'dismiss a report on')) return;
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
        // Suspending through a report takes the member's role away: an owner's or admin's, only an owner may (the engine
        // refuses anyone else, given the actor). Read only to suspend: a moderator, refused that above, is no node admin.
        const actor = suspendUser ? resolveAdminActor(ctx) : null;
        if (suspendUser && !actor) return;
        if (suspendUser && !stepUpIfOwnerOnly(ctx, 'report-suspend', ctx.params.id)) return;
        const report = db.prepare('SELECT status, CASE WHEN target_pulse_item_id IS NULL THEN target_post_id END AS target_post_id FROM abuse_reports WHERE id = ?').get(ctx.params.id) as
            { status: string | null; target_post_id: string | null } | undefined;
        // Closing a report on a moderator's own post, or one by an enterprise they keep, without taking the post down
        // is a dismissal by another name (G3): a closed report no longer counts towards the 3 that hide it, and its
        // reporter hears nothing. Refused as restore and dismiss are. A Pulse removal takes nothing off a post, so only
        // `deletePost` lets it through; taking their own post down stays theirs to do, since it only counts against them.
        if (!deletePost && refuseModeratorsOwnPost(ctx, report?.target_post_id, 'close a report on')) return;
        // A moderator removes a post or Pulse item only through a report that is still open, as on
        // posts/:id/delete: once dismissed ('reviewed') or actioned, only an owner or admin can take it down.
        // Marking a report handled with no removal is not gated otherwise.
        if ((deletePost || removePulseItem) && (ctx.state as any)?.adminRole === 'moderator') {
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
            actor,
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
                warning: `Removed, but ${refundShortfalls.length} escrow refund(s) didn't match their trade: `
                    + refundShortfalls.map(describeRefundShortfall).join('; '),
            }
            : { success: true, message: 'Report actioned successfully' };
    } catch (e: any) {
        if (answerPotPaused(ctx, e)) return;
        ctx.status = e?.status || 500;
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
    if (postIds.length > MAX_BULK_DELETE_POSTS) {
        ctx.status = 400;
        ctx.body = { error: `Bulk delete limit exceeded (maximum ${MAX_BULK_DELETE_POSTS} posts per request)` };
        return;
    }
    try {
        const refundShortfalls: EscrowRefundShortfall[] = [];
        const deleted = adminBulkDeletePosts(postIds, { onRefundShortfall: s => refundShortfalls.push(s) });
        ctx.body = refundShortfalls.length > 0
            ? { success: true, deleted, deletedCount: deleted, refundShortfalls }
            : { success: true, deleted, deletedCount: deleted };
    } catch (e: any) {
        console.error('Error bulk deleting posts:', e);
        if (answerPotPaused(ctx, e)) return;
        ctx.status = 500;
        ctx.body = { success: false, error: e?.message || 'Failed to bulk delete posts' };
    }
});


/**
 * The node's inbox: the conversations of the first owner (getFirstNodeAdminPubkey), whose key the node's notices go out
 * under (adminSendMessage), plus legacy 'system' ones. That list is that owner's own: who they talk to, when, unread
 * counts. An admin needs none of it: the members' replies are encrypted to that owner's key, so an admin could read no
 * reply, and the node's own lines are the notices they sent. So only an owner (the password is one), or that member
 * themselves, reads it; an admin is refused before anything is looked up. Sending a notice (inbox/send) stays an
 * admin's (#1534).
 */
router.post('/api/local/admin/inbox', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const viewer = resolveAdminActor(ctx);
    if (!viewer) return;
    const adminPubkey = getFirstNodeAdminPubkey() || getAdminPubkey();
    // A token acts for its owner but is not them: it never reads the owner's own conversations (#1546 review).
    if ((ctx.state as any)?.viaToken || (!isOwnerLevelActor(viewer) && !(adminPubkey && viewer === adminPubkey))) {
        ctx.status = 403;
        ctx.body = { error: "Only an owner can read the node's inbox" };
        return;
    }
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
// totals only. Like every other Decision response, never who voted how. A vote on removing a member carries their
// balance and debt only to an admin who may vote in it (decisionForAdmin); every other admin gets balanceHidden.
router.post('/api/local/admin/decisions', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const actionable = [...getAllDecisions('open'), ...getAllDecisions('execution_pending_grace')];
    // The subject's name only: getMember read their photo too, once a Decision (#1478).
    const callsignOfKey = db.prepare('SELECT callsign FROM members WHERE public_key = ?');
    // The admin's own key, from their key session only. An automation token carries its maker's key as the actor, but a
    // token is a script, not a voter (#1613's deciding review); a password session has no key at all.
    const reader = (ctx.state as any)?.isKeySession ? (ctx.state as any).actor as string | undefined : undefined;
    ctx.body = {
        decisions: actionable.map(d => {
            const subject = d.subject ? callsignOfKey.get(d.subject) as { callsign: string } | undefined : null;
            return { ...decisionForAdmin(d, reader), subjectName: subject?.callsign ?? null, tally: tallyDecision(d.id) };
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
    if (!stepUpIfOwnerOnly(ctx, 'halt', ctx.params.id)) return;
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
    if (!stepUpIfOwnerOnly(ctx, 'accelerate', ctx.params.id)) return;
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
    // A change that needs an owner, from the phone, asks for its unlock again (roleChangeNeedsOwner).
    if (roleChangeNeedsOwner(targetPubkey, role) && !requirePhoneStepUp(ctx)) return;
    // No spelling rule here, unlike the enrol route above: grantNodeRole grants only to a member row under exactly this
    // key, no door makes a row under any other spelling now (engine/member-key.ts), and a role on one a door made before
    // opens no session (authorizeKeySigner) and signs nothing (the signature middleware). test-node-roles drives this
    // route with made-up keys.
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
    // Taking an owner's or an admin's role, from the phone, asks for its unlock again (roleChangeNeedsOwner).
    if (roleChangeNeedsOwner(pubkey, role) && !requirePhoneStepUp(ctx)) return;

    try {
        // The role the row holds, acting or not: an owner takes away a visitor's row's role too (heldNodeRoleOf).
        const currentRole = heldNodeRoleOf(pubkey);
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
    // Every look at the disputes is a line in the log the owner and admins read, naming the trades shown: first.
    if (!logDisputesOrRefuse(ctx, 'disputes_listed', disputes.map(d => d.id))) return;
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
    if (!logDisputesOrRefuse(ctx, 'dispute_opened', [dispute.id])) return;
    ctx.body = { dispute };
});

/** A look at the disputes that can't be logged (a standby writes no plain table) isn't answered. */
function logDisputesOrRefuse(ctx: any, action: TradeLookAction, tradeIds: string[]): boolean {
    try {
        logDisputesLook((ctx.state as any)?.actor || 'owner:password', action, tradeIds, lookTokenOf(ctx));
        return true;
    } catch {
        ctx.status = 503;
        ctx.body = { error: 'This server cannot log a look at the disputes right now, so it shows none.', code: 'LOOK_NOT_LOGGED' };
        return false;
    }
}

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
    // The reader decides whether a pending owner's or admin's code is in the answer (getRekeyStatus); a phone session
    // past its step-up window reads that code only after Manage again, as completing the re-key asks (#1534).
    const viewer = resolveAdminActor(ctx);
    if (!viewer) return;
    try {
        const { pubkey } = ctx.params;
        // An automation token is never a fresh phone session, so it never reads an owner's or admin's code (#1546 review).
        const status = getRekeyStatus(pubkey, viewer, { viewerStepUpDue: !!(ctx.state as any)?.phoneStepUpDue || !!(ctx.state as any)?.viaToken });
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
    // Spelt as issueRekeyCode spells it (member-wizards cleanOld).
    if (!stepUpIfOwnerOnly(ctx, 'rekey', String(pubkey).trim().toLowerCase())) return;

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

// Undo an unused code (engine/member-wizards cancelRekeyCode): who may make it may cancel it, as issue-code asks.
router.post('/api/local/admin/members/:pubkey/rekey/cancel', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { pubkey } = ctx.params;
    const effectiveActor = resolveAdminActor(ctx);
    if (!effectiveActor) return;
    if (!stepUpIfOwnerOnly(ctx, 'rekey', String(pubkey).trim().toLowerCase())) return;

    try {
        ctx.body = { success: true, ...cancelRekeyCode(pubkey, effectiveActor) };
    } catch (e: any) {
        ctx.status = e?.status || (e?.message?.includes('not found') ? 404 : 400);
        ctx.body = { error: e?.message || 'Failed to cancel the re-key code' };
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
    if (!stepUpIfOwnerOnly(ctx, 'rekey', String(pubkey).trim().toLowerCase())) return;

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
        const actor = resolveAdminActor(ctx);
        if (!actor) return;
        const preview = getOffboardPreview(pubkey);

        // Security / Privacy: Only return active members roster to key-authenticated sessions.
        // Password-only sessions cannot execute gift_to_member, so withholding the list
        // prevents leaking the member roster.
        if (actor === 'owner:password') {
            preview.activeMembers = [];
        }

        // The member's balance, outside their consent: a line in the access log the admins and the owner read, first.
        logBalanceLook(actor, preview.member.publicKey, 'offboard_preview', lookTokenOf(ctx));
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
    // Spelt as executeOffboard spells them (member-wizards cleanPub, cleanOperator).
    if (!stepUpIfOwnerOnly(ctx, 'prune', String(pubkey).trim().toLowerCase(), effectiveActor.trim().toLowerCase())) return;

    try {
        const result = executeOffboard(
            pubkey,
            { resolution: resolution as OffboardOptions['resolution'], giftRecipientPubkey },
            effectiveActor
        );
        // The balance it settled is a look at the member's balance too: logged, or left out of the answer.
        try {
            logBalanceLook(effectiveActor, result.memberPubkey, 'offboard_settled', lookTokenOf(ctx));
            ctx.body = result;
        } catch {
            ctx.body = { ...result, balanceSettled: undefined };
        }
    } catch (e: any) {
        ctx.status = e?.statusCode || e?.status || 400;
        ctx.body = { error: e?.message || 'Failed to offboard member', code: e?.code };
    }
});

    return router;
}
