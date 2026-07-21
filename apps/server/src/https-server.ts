/**
 * HTTPS Server — PWA Host + Settings API + Community API (Port 8443)
 *
 * Serves:
 * - PWA static files over HTTPS
 * - /settings — Admin settings page (HTML)
 * - /api/local/* — Settings & Connector API endpoints
 * - /api/community/* — Community info, member registration
 * - /api/ledger/* — Balance, transfers, transactions
 * - /api/marketplace/* — Posts (needs & offers)
 * - /ws — WebSocket real-time state feed
 *
 * Public nodes: Let's Encrypt certs
 * LAN nodes: Self-signed certs + /trust for CA download
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import Koa from 'koa';
import Router from '@koa/router';
import serve from 'koa-static';
import { getCaCertPem, getServerCertPem, getServerKeyPem, isUsingLetsEncrypt } from './services/tls.js';
import {
    getLocalConfig, saveLocalConfig, hashPassword, verifyPassword, verifyPasswordAsync,
    getThresholds, updateThresholds, DEFAULT_THRESHOLDS,
    updateBackupCadence,
    validatePasswordStrength,
    generateReplicationToken, setReplicationToken, clearReplicationToken, hasReplicationToken, verifyReplicationToken,
    getGatewayConfig,
} from './config/local-config.js';
import {
    getConnectors, addConnector, removeConnector,
    connectToAddress, disconnectFromAddress,
    getConnectorByPublicUrl,
    type TrustLevel,
} from './connector-manager.js';
import { federationCors, mountFederationRoutes } from './federation-api.js';
import { federatedRelayMessage, federatedVerifyMember } from './federation-protocol.js';
import { getP2PNode } from './p2p.js';
import { WebSocketServer } from 'ws';
import os from 'node:os';
import { logger, addLogClient, removeLogClient, logClients } from './logger.js';
import {
    registerMember, getMembers, getAllMembers, getMember,
    getBalance, transfer, getTransactions,
    createPost, getPosts, removePost, updatePost,
    acceptPost, completePostTransaction, cancelPostTransaction,
    pausePost, resumePost, getMarketplaceTransactions,
    requestPost, approvePostRequest, rejectPostRequest, cancelPostRequest,
    getCommunityInfo, addWsClient, removeWsClient,
    generateInvite, redeemInvite, redeemOfflineTicket, checkInvite, getInviteTree, getInvitesByMember,
    adminGenerateInvite, getMemberTrustProfile, getTrustProfileForViewer,
    vouchMember, unvouchMember, canVouch, hasListedOffer, hasLiveOffer,
    updateProfile, getProfile, getAllProfiles,
    createConversation, sendMessage, editMessage, getConversationsByMember, toggleMessageReaction,
    getConversationMessages, getConversation,
    getCommunityHealth,
    seedGenesisMember,
    addRating, getRatings, getAverageRating, getRatingsGiven,
    submitReport, getReports, dismissReport, actionReport, getReportCount,
    getFriends, addFriend, removeFriend, setGuardian,
    adminSetUserStatus, adminSetCreditFrozen, adminSetElder, adminSetVoucher, adminSetTier, adminDeletePost, adminPruneUser, adminBulkDeletePosts,
    adminPruneBranch, adminBroadcastAnnouncement, adminSendMessage,
    getAdminPubkey, recordActivity,
    markConversationRead, getUnreadCounts,
    createProject, updateProject, deleteProject, voteForProject, createVotingRound, closeVotingRound,
    getProjects, getAllProjects, getVotingRounds, getActiveRound, getCommonsBalance, getGovernanceCredits,
    adminRejectProject,
    getNodeConfig, updateNodeConfig, getDirectoryInfo, exportLedgerAudit,
    exportSyncState, getNodeRole,
    recordReplicationAccess, getReplicationAccessLog,
    registerPushToken, removePushToken,
    getMemberPreferences, setMemberPreferences, setHolidayMode,
    getMemberStats,
    getGuardiansOf, createRecoveryRequest, dispatchPushNotification, getPendingRecoveryRequests, approveRecovery, rejectRecovery, getRecoveryStatus, cancelRecovery
} from './state-engine.js';
import { getCrowdfundProjects, getCrowdfundProject, createCrowdfundProject, updateCrowdfundProject, pledgeToProject, deleteCrowdfundProject, db, getDbDataVersion } from './db/db.js';
import { initDirectoryPublisher, pushDirectoryNow } from './services/directory-publisher.js';
import { getBackupStatus, requestResync } from './services/backup-puller.js';
import {
    writeDbSnapshot, createSnapshot, listSnapshots, resolveSnapshotPath,
    getAutoSnapshotConfig, updateAutoSnapshotConfig,
} from './services/snapshot-scheduler.js';

const PUBLIC_DIR = path.resolve('public');
import { PROTOCOL_CONSTANTS } from '@beanpool/core';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Route modules
import { createSettingsRoutes } from './routes/settings.js';
import { createCommunityRoutes } from './routes/community.js';
import { createAdminRoutes } from './routes/admin.js';
import { createBackupRoutes } from './routes/backup.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { createMessagingRoutes } from './routes/messaging.js';
import { createCommonsRoutes } from './routes/commons.js';
import type { RouteDeps } from './routes/types.js';


// Rate limiter for auth endpoints (15 attempts per minute per IP)
const authAttempts = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ctx: Koa.Context): boolean {
    const ip = ctx.ip || 'unknown';
    const now = Date.now();
    const entry = authAttempts.get(ip);
    if (entry && now < entry.resetAt) {
        if (entry.count >= 15) {
            const waitSec = Math.ceil((entry.resetAt - now) / 1000);
            ctx.status = 429;
            ctx.body = { error: `Too many attempts. Try again in ${waitSec}s` };
            return false;
        }
        entry.count++;
    } else {
        authAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    }
    return true;
}

// X-1: replay protection for signed requests.
// A signed request is valid for SIGNATURE_FRESHNESS_MS around its timestamp, and
// each nonce may be used once within that window. `consumeNonce` is atomic
// (check-and-set) so concurrent duplicates can't both pass.
const SIGNATURE_FRESHNESS_MS = 5 * 60 * 1000;
const seenNonces = new Map<string, number>();  // nonce -> expiry (ms epoch)
function consumeNonce(nonce: string, now: number): boolean {
    // Bounded store: opportunistically evict expired entries when it grows.
    if (seenNonces.size > 10_000) {
        for (const [n, exp] of seenNonces) if (exp <= now) seenNonces.delete(n);
    }
    const exp = seenNonces.get(nonce);
    if (exp !== undefined && exp > now) return false;  // already used → replay
    seenNonces.set(nonce, now + SIGNATURE_FRESHNESS_MS);
    return true;
}

// SRV-2 / SRV-4: read (GET) authorization.
//
// Historically every GET /api/* was unauthenticated, exposing balances, the
// full ledger export, the member directory, the social graph, etc. to anyone.
// When ENFORCE_READ_AUTH is on, gated GETs require a fresh, replay-proof,
// member-signed request (same scheme as writes) and the signer must be a known
// member. Enforcement is OFF by default so the server change can land ahead of
// the client read-signing work (PWA lib/api.ts + native) — flip it on only once
// both clients sign their reads, or every read from an un-updated client 401s.
const ENFORCE_READ_AUTH = process.env.ENFORCE_READ_AUTH === 'true';

// SRV-4 (WebSocket feed): the /ws live-state feed was unauthenticated — anyone
// reaching it could stream every state change. When ENFORCE_WS_AUTH is on, the
// upgrade requires a fresh, single-use, member-signed connect token (the same
// replay-proof scheme as HTTP, with method=WS and an empty body). OFF by default
// so it can land ahead of client adoption; the native app already sends the token.
const ENFORCE_WS_AUTH = process.env.ENFORCE_WS_AUTH === 'true';

/**
 * SRV-4: verify the signed connect token on a /ws upgrade. The client signs
 * `WS\n<path>\n<ts>\n<nonce>\n` (replay-proof scheme, method=WS, empty body) and
 * passes pubkey/ts/nonce/sig as query params. Returns true only for a fresh,
 * single-use, valid signature from a known member.
 */
function verifyWsConnect(pathname: string, params: URLSearchParams): boolean {
    try {
        const pubKeyHex = params.get('pubkey');
        const sigB64 = params.get('sig');
        const ts = params.get('ts');
        const nonce = params.get('nonce');
        if (!pubKeyHex || !sigB64 || !ts || !nonce) return false;

        const tsNum = Number(ts);
        const now = Date.now();
        if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > SIGNATURE_FRESHNESS_MS) return false;
        // Atomic check-and-consume — a replayed connect nonce is rejected.
        if (!consumeNonce(nonce, now)) return false;

        const signedMessage = `WS\n${pathname}\n${ts}\n${nonce}\n`;
        const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
        const spki = Buffer.concat([spkiHeader, Buffer.from(pubKeyHex, 'hex')]);
        const publicKeyObject = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
        const isValid = crypto.verify(
            undefined, Buffer.from(signedMessage), publicKeyObject, Buffer.from(sigB64, 'base64'),
        );
        if (!isValid) return false;

        // A valid signature only proves key possession — require a known member so
        // an anonymous keypair can't subscribe to the live feed.
        return !!getMember(pubKeyHex);
    } catch {
        return false;
    }
}

// Reads that stay public even under enforcement. Deny-by-default: anything NOT
// listed here is gated, so a newly-added sensitive endpoint fails safe.
//   - discovery / federation: a peer or prospective member must read these
//     before it has (or to decide whether to join with) an identity.
//   - onboarding / recovery: a not-yet-joined or recovering user has no member
//     identity to sign as.
//   - binary assets fetched by <img>/streamed: a browser image/attachment
//     request cannot carry signature headers. Message attachments are E2E
//     ciphertext (NAT-1), so serving them unauthenticated leaks no plaintext.
//     (A token-in-URL scheme for these is tracked as follow-up.)
const PUBLIC_READ_EXACT = new Set<string>([
    '/api/version',
    '/api/community/info',
    '/api/community/health',
    '/api/node/config',
    '/api/directory/info',
    '/api/commons/balance',          // community transparency (single aggregate)
    '/api/commons/projects',         // community transparency
    '/api/commons/rounds',           // community transparency
    '/api/crowdfund/projects',       // public crowdfund list
    '/api/invite/check',             // onboarding: pre-membership invite pre-flight (rate-limited)
]);
// Precise patterns for the parameterized public routes. Kept deliberately tight
// (anchored, single path segment per `[^/]+`) so a broad prefix can't
// accidentally expose a sensitive neighbour — e.g. the DM-content reads
// (/api/messages/conversations/:pk, /api/messages/:conversationId) must stay
// GATED; only the E2E-ciphertext attachment binary is public.
const PUBLIC_READ_PATTERNS: RegExp[] = [
    /^\/api\/community\/membership\/[^/]+$/,                // onboarding: is this pubkey a member?
    /^\/api\/crowdfund\/projects\/[^/]+$/,                  // public crowdfund detail
    /^\/api\/recovery\/lookup\/[^/]+$/,                     // pre-membership: look up guardians by callsign
    /^\/api\/recovery\/status\/[^/]+$/,                     // pre-membership: recovering user polls status
    // A2-16: /api/recovery/pending/:guardian is deliberately NOT public — it lists a
    // guardian's wards' recovery requests. It is gated under ENFORCE_READ_AUTH and the
    // route additionally requires the verified signer to BE that guardian.
    /^\/api\/marketplace\/posts\/[^/]+\/photos\/[^/]+$/,    // <img> binary (cannot send signature headers)
    /^\/api\/messages\/[^/]+\/attachment$/,                 // E2E-ciphertext attachment binary for <img>
];

function isPublicRead(path: string): boolean {
    if (PUBLIC_READ_EXACT.has(path)) return true;
    return PUBLIC_READ_PATTERNS.some(re => re.test(path));
}

// A2-22: clamp client-supplied pagination. An unclamped `?limit=` (e.g. limit=-1,
// which SQLite treats as "no limit", or a huge value) turned a paginated read into
// a full-table dump + memory/CPU spike. Bound limit to [1, MAX] and offset to ≥0.
const MAX_PAGE_LIMIT = 200;
function clampLimit(v: unknown, def = 50): number {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PAGE_LIMIT) : def;
}
function clampOffset(v: unknown): number {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

interface ActiveConnectionInfo {
    id: string;
    type: 'sync' | 'admin';
    ip: string;
    userAgent: string;
    connectedAt: number;
    msgSentCount: number;
    msgRecvCount: number;
    lastActivityAt: number;
    callsign?: string;
}

const activeConnections = new Map<string, ActiveConnectionInfo>();

function getIpAddress(req: import('node:http').IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
}

/** Real client IP for replication logging: prefer Cloudflare's CF-Connecting-IP
 *  (nodes sit behind CF tunnels), then X-Forwarded-For, then the socket. */
function replicationClientIp(ctx: any): string {
    const h = ctx?.request?.header || {};
    const cf = h['cf-connecting-ip'];
    if (cf) return String(cf);
    const fwd = h['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return ctx?.ip || 'unknown';
}

function calculateAnalytics() {
    const now = Date.now();
    let totalConnected = 0;
    let syncCount = 0;
    let adminCount = 0;
    let totalDurationMs = 0;
    let totalMsgSent = 0;
    let totalMsgRecv = 0;

    for (const conn of activeConnections.values()) {
        totalConnected++;
        if (conn.type === 'sync') syncCount++;
        else adminCount++;
        totalDurationMs += (now - conn.connectedAt);
        totalMsgSent += conn.msgSentCount;
        totalMsgRecv += conn.msgRecvCount;
    }

    const avgDurationSec = totalConnected > 0 ? Math.round((totalDurationMs / totalConnected) / 1000) : 0;

    return {
        totalConnected,
        syncCount,
        adminCount,
        avgDurationSec,
        totalMsgSent,
        totalMsgRecv
    };
}

function broadcastWsAnalytics() {
    const analytics = calculateAnalytics();
    const payload = JSON.stringify({ type: 'ws_analytics', data: analytics });
    for (const client of logClients) {
        if (client.readyState === 1) { // OPEN
            try { client.send(payload); } catch {}
        }
    }
}

function trackConnection(ws: any, type: 'sync' | 'admin', req: import('node:http').IncomingMessage) {
    const id = 'ws_' + crypto.randomBytes(8).toString('hex');
    const ip = getIpAddress(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const connectedAt = Date.now();

    // Parse callsign from request URL query parameters
    let callsign: string | undefined = undefined;
    try {
        const parsedUrl = new URL(req.url || '', 'https://localhost');
        callsign = parsedUrl.searchParams.get('callsign') || undefined;
    } catch { /* ignore */ }

    const connInfo: ActiveConnectionInfo = {
        id,
        type,
        ip,
        userAgent,
        connectedAt,
        msgSentCount: 0,
        msgRecvCount: 0,
        lastActivityAt: connectedAt,
        callsign
    };

    activeConnections.set(id, connInfo);

    // Decorate ws object
    ws.id = id;
    ws.type = type;

    // Decorate send function
    const originalSend = ws.send.bind(ws);
    ws.send = (data: any, options: any, callback: any) => {
        const conn = activeConnections.get(id);
        if (conn) {
            conn.msgSentCount++;
            conn.lastActivityAt = Date.now();
            
            const dataStr = typeof data === 'string' ? data : data.toString();
            let preview = dataStr.slice(0, 150);
            if (dataStr.length > 150) preview += '...';
            
            const trafficPayload = JSON.stringify({
                type: 'ws_traffic',
                data: {
                    id,
                    direction: 'out',
                    size: dataStr.length,
                    preview
                }
            });

            for (const client of logClients) {
                if (client.readyState === 1 && client !== ws) { // OPEN
                    try { client.send(trafficPayload); } catch {}
                }
            }
        }
        
        if (typeof options === 'function') {
            return originalSend(data, options);
        }
        return originalSend(data, options, callback);
    };

    // Attach message listener
    ws.on('message', (data: any) => {
        const conn = activeConnections.get(id);
        if (conn) {
            conn.msgRecvCount++;
            conn.lastActivityAt = Date.now();

            const dataStr = typeof data === 'string' ? data : data.toString();
            let preview = dataStr.slice(0, 150);
            if (dataStr.length > 150) preview += '...';

            const trafficPayload = JSON.stringify({
                type: 'ws_traffic',
                data: {
                    id,
                    direction: 'in',
                    size: dataStr.length,
                    preview
                }
            });

            for (const client of logClients) {
                if (client.readyState === 1 && client !== ws) { // OPEN
                    try { client.send(trafficPayload); } catch {}
                }
            }
        }
    });

    // Broadcast connect event
    const connectPayload = JSON.stringify({ type: 'ws_connect', data: connInfo });
    for (const client of logClients) {
        if (client.readyState === 1 && client !== ws) { // OPEN
            try { client.send(connectPayload); } catch {}
        }
    }

    broadcastWsAnalytics();
}

function untrackConnection(ws: any) {
    const id = ws.id;
    if (id && activeConnections.has(id)) {
        activeConnections.delete(id);

        const disconnectPayload = JSON.stringify({ type: 'ws_disconnect', data: { id } });
        for (const client of logClients) {
            if (client.readyState === 1) { // OPEN
                try { client.send(disconnectPayload); } catch {}
            }
        }

        broadcastWsAnalytics();
    }
}

export async function startHttpsServer(port: number): Promise<void> {
    const app = new Koa();
    const router = new Router();

    // Federation CORS middleware (must be before body parser for fast OPTIONS handling)
    app.use(federationCors());

    // Standard Modern Security Headers Middleware
    app.use(async (ctx, next) => {
        ctx.set('X-Content-Type-Options', 'nosniff');
        ctx.set('X-Frame-Options', 'DENY');
        ctx.set('X-XSS-Protection', '1; mode=block');
        ctx.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://unpkg.com https://*.tile.openstreetmap.org https://api.qrserver.com; connect-src 'self' https://nominatim.openstreetmap.org *; frame-ancestors 'none'");
        ctx.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        await next();
    });

    // Gateway Configuration Middlewares (CORS Allowed Origins, Admin IP Allowlist, Feature Toggles, Rate Limiting)
    const gatewayRateLimits = new Map<string, number[]>();

    app.use(async (ctx, next) => {
        const gwConfig = getGatewayConfig();
        const clientIp = replicationClientIp(ctx);

        // 1. Dynamic CORS Allowed Origins Handling
        const requestOrigin = ctx.get('Origin');
        const allowedOrigins = (gwConfig.corsAllowedOrigins && gwConfig.corsAllowedOrigins.length > 0)
            ? gwConfig.corsAllowedOrigins
            : ['*'];

        if (requestOrigin && (allowedOrigins.includes('*') || allowedOrigins.includes(requestOrigin))) {
            ctx.set('Access-Control-Allow-Origin', requestOrigin);
            ctx.set('Access-Control-Allow-Credentials', 'true');
            ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Admin-Password, x-signature, x-public-key, x-timestamp, x-nonce');
            ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            if (ctx.method === 'OPTIONS') {
                ctx.status = 204;
                return;
            }
        }

        // 2. Admin IP Allowlist Enforcement (/settings and /api/local/admin/*)
        if (gwConfig.adminIpAllowlist && gwConfig.adminIpAllowlist.length > 0) {
            if (ctx.path === '/settings' || ctx.path.startsWith('/api/local/admin/')) {
                const isAllowed = gwConfig.adminIpAllowlist.some(allowedIp => 
                    clientIp === allowedIp || allowedIp === '*' || (allowedIp.endsWith('*') && clientIp.startsWith(allowedIp.slice(0, -1)))
                );
                if (!isAllowed) {
                    ctx.status = 403;
                    ctx.body = { error: 'Access denied by Gateway Admin IP allowlist' };
                    return;
                }
            }
        }

        // 3. Subsystem Feature Toggles Interceptors
        if (!gwConfig.features?.marketplace && ctx.path.startsWith('/api/marketplace')) {
            ctx.status = 503;
            ctx.body = { error: 'Marketplace feature is currently disabled by node gateway' };
            return;
        }
        if (!gwConfig.features?.messaging && ctx.path.startsWith('/api/messaging')) {
            ctx.status = 503;
            ctx.body = { error: 'Messaging feature is currently disabled by node gateway' };
            return;
        }
        if (!gwConfig.features?.federation && ctx.path.startsWith('/api/federation')) {
            ctx.status = 503;
            ctx.body = { error: 'Federation feature is currently disabled by node gateway' };
            return;
        }
        if (!gwConfig.features?.invites && (ctx.path.startsWith('/api/invite') || ctx.path.startsWith('/api/community/invite'))) {
            ctx.status = 503;
            ctx.body = { error: 'Invites feature is currently disabled by node gateway' };
            return;
        }
        if (!gwConfig.features?.servePwa && (ctx.path === '/' || ctx.path.startsWith('/app') || ctx.path.endsWith('.html'))) {
            if (ctx.path !== '/settings' && !ctx.path.startsWith('/api/')) {
                ctx.status = 530;
                ctx.body = { error: 'Headless Mode: PWA hosting is disabled on this node gateway' };
                return;
            }
        }

        // 4. Rate Limiting Middleware
        if (gwConfig.rateLimiting?.enabled) {
            const now = Date.now();
            const windowMs = 60 * 1000;
            const maxReqs = gwConfig.rateLimiting.maxRequestsPerMinute || 120;

            let timestamps = gatewayRateLimits.get(clientIp) || [];
            timestamps = timestamps.filter(t => now - t < windowMs);

            if (timestamps.length >= maxReqs) {
                ctx.status = 429;
                ctx.body = { error: 'Gateway rate limit exceeded. Please try again in 1 minute.' };
                return;
            }

            timestamps.push(now);
            gatewayRateLimits.set(clientIp, timestamps);
        }

        await next();
    });

    // Administrative In-Memory Rate Limiter Middleware
    const adminRateLimits = new Map<string, number[]>();
    app.use(async (ctx, next) => {
        if (ctx.path.startsWith('/api/local/') || ctx.path.startsWith('/api/admin/')) {
            const ip = ctx.ip;
            const now = Date.now();
            const windowMs = 60 * 1000; // 1 minute
            const limit = 60; // max 60 requests per minute

            let timestamps = adminRateLimits.get(ip) || [];
            timestamps = timestamps.filter(t => now - t < windowMs);

            if (timestamps.length >= limit) {
                ctx.status = 429;
                ctx.body = { error: 'Too many administrative requests. Please try again in 1 minute.' };
                return;
            }

            timestamps.push(now);
            adminRateLimits.set(ip, timestamps);
        }
        await next();
    });

    // JSON body parser middleware
    app.use(async (ctx, next) => {
        if (ctx.method === 'POST' || ctx.method === 'PUT' || ctx.method === 'DELETE') {
            if (ctx.request.type === 'application/json' || ctx.get('content-type')?.includes('json')) {
                // A2-10: reject an over-limit body up-front by Content-Length so a
                // well-behaved client gets a clean 413 before we read a byte. The
                // streaming cap in readBody is the backstop for chunked / lying-length
                // requests.
                const declaredLen = Number(ctx.get('content-length'));
                if (Number.isFinite(declaredLen) && declaredLen > MAX_JSON_BODY_BYTES) {
                    ctx.status = 413;
                    ctx.body = { error: 'Request body too large' };
                    return;
                }
                try {
                    const body = await readBody(ctx.req);
                    (ctx as any).rawBody = body;  // X-1: exact bytes the client signed
                    const parsed = JSON.parse(body);
                    (ctx as any).requestBody = parsed;

                    const sender = parsed.publicKey || parsed.authorPublicKey || parsed.buyerPublicKey || parsed.from || parsed.memberPublicKey || parsed.voterPublicKey;
                    if (sender && typeof sender === 'string' && sender.length >= 32) {
                        recordActivity(sender);
                    }
                } catch (e: any) {
                    // A2-10: an over-limit body is rejected outright (413) instead of
                    // silently continuing with an empty body — and we stop here so no
                    // route runs on a truncated/abandoned request.
                    if (e instanceof BodyTooLargeError) {
                        ctx.status = 413;
                        ctx.body = { error: 'Request body too large' };
                        return;
                    }
                    (ctx as any).requestBody = {};
                }
            } else {
                (ctx as any).requestBody = {};
            }
        }
        await next();
    });

    // Cryptographic Signature Verification Middleware
    async function requireSignature(ctx: Koa.Context, next: Koa.Next) {
        const isMutatingApi = (ctx.method === 'POST' || ctx.method === 'PUT' || ctx.method === 'DELETE') && ctx.path.startsWith('/api/');
        // SRV-2/SRV-4: gated reads require the same signature as writes when
        // ENFORCE_READ_AUTH is on. Deny-by-default — every GET /api/* is gated
        // unless it is on the public allowlist.
        const isGatedRead = ENFORCE_READ_AUTH && ctx.method === 'GET' && ctx.path.startsWith('/api/') && !isPublicRead(ctx.path);
        const isBypassed =
            ctx.path.startsWith('/api/local/') ||
            ctx.path.startsWith('/api/admin/') ||
            ctx.path === '/api/invite/redeem' ||
            ctx.path === '/api/invite/redeem-offline';

        if ((!isMutatingApi && !isGatedRead) || isBypassed) {
            return await next();
        }

        const pubKeyHex = ctx.get('X-Public-Key');
        const signatureBase64 = ctx.get('X-Signature');

        if (!pubKeyHex || !signatureBase64) {
            ctx.status = 401;
            ctx.body = { error: 'Missing cryptographic signature headers' };
            return;
        }

        // X-1 / X-1b: every signed request MUST use the replay-proof scheme —
        // the signature covers method+path+timestamp+nonce+body, with server-side
        // freshness + single-use-nonce enforcement. The legacy body-only
        // signature branch (replayable, not path-bound) was removed pre-launch;
        // both the PWA (lib/api.ts) and native (buildSignedHeaders) clients always
        // send X-Timestamp + X-Nonce.
        const timestampHeader = ctx.get('X-Timestamp');
        const nonce = ctx.get('X-Nonce');

        if (!timestampHeader || !nonce) {
            ctx.status = 401;
            ctx.body = { error: 'Missing replay-proof headers (X-Timestamp / X-Nonce)' };
            return;
        }

        try {
            const ts = Number(timestampHeader);
            const now = Date.now();
            if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_FRESHNESS_MS) {
                ctx.status = 401;
                ctx.body = { error: 'Request timestamp is stale or invalid' };
                return;
            }
            // Atomic check-and-consume: a replayed nonce is rejected here.
            if (!consumeNonce(nonce, now)) {
                ctx.status = 403;
                ctx.body = { error: 'Replay detected: nonce already used' };
                return;
            }
            const rawBody = (ctx as any).rawBody ?? '';
            const signedMessage = `${ctx.method}\n${ctx.path}\n${timestampHeader}\n${nonce}\n${rawBody}`;

            // Convert hex pubkey to SPKI format for Node.js verify
            const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
            const spki = Buffer.concat([spkiHeader, Buffer.from(pubKeyHex, 'hex')]);
            const publicKeyObject = crypto.createPublicKey({
                key: spki,
                format: 'der',
                type: 'spki'
            });

            const isValid = crypto.verify(
                undefined,
                Buffer.from(signedMessage),
                publicKeyObject,
                Buffer.from(signatureBase64, 'base64')
            );

            if (!isValid) {
                ctx.status = 403;
                ctx.body = { error: 'Invalid cryptographic signature' };
                return;
            }

            // Bind cryptographically verified public key to state actor
            ctx.state.actor = pubKeyHex;

            // SRV-20: stash the verified signing material so a route that creates a
            // transaction can persist it on the row (auth_signer/signature/payload),
            // making the transaction's authorship re-verifiable by any importing node.
            ctx.state.authSig = { signer: pubKeyHex, signature: signatureBase64, payload: signedMessage };

            // SRV-2/SRV-4: a valid signature only proves possession of *some*
            // keypair — an attacker can mint one. For gated reads, require the
            // signer to be a known member so the directory, balances, ledger and
            // social graph aren't readable by an anonymous key. (Writes keep
            // their own per-route authorization; membership isn't required there
            // — e.g. first-time registration.)
            if (isGatedRead && !getMember(pubKeyHex)) {
                ctx.status = 403;
                ctx.body = { error: 'Read access requires a member identity' };
                return;
            }

            // Generic spoof check: any body field representing the request initiator
            // (ending in 'pubkey', 'publickey', or is 'from' or 'createdby') must match the verified public key.
            // We exclude other non-sender fields like targetPubkey, oldPubkey, to_pubkey, invited_by to prevent false positives.
            const body = (ctx as any).requestBody || {};
            for (const [key, value] of Object.entries(body)) {
                const k = key.toLowerCase();
                const isIdentityField = k.endsWith('pubkey') || k.endsWith('publickey') || k === 'from' || k === 'createdby';
                const isOtherEntity = k.startsWith('target') || k.startsWith('old') || k.startsWith('to') || k.startsWith('invited') || k.startsWith('friend');
                
                if (isIdentityField && !isOtherEntity && typeof value === 'string' && value !== pubKeyHex) {
                    // A2-13: don't name the field in the client-facing error — leaking
                    // which key is the identity field eases SRV-6 spoof-bypass crafting.
                    throw new Error('Identity mismatch: a request field does not match the signing key.');
                }
            }

        } catch (err: any) {
            // A2-13 (SRV-12): return a generic message; log the detail server-side so
            // exception text / internal paths aren't reflected to clients.
            console.warn('[Auth] signature validation failed:', err?.message || err);
            ctx.status = 403;
            ctx.body = { error: 'Signature validation failed' };
            return;
        }

        await next();
    }
    app.use(requireSignature);

    // Trust endpoint — only for self-signed mode
    if (!isUsingLetsEncrypt()) {
        router.get('/trust', async (ctx) => {
            ctx.type = 'application/x-pem-file';
            ctx.set('Content-Disposition', 'attachment; filename="beanpool-ca.pem"');
            ctx.body = getCaCertPem();
        });
    }


    // ===================== ADMIN AUTH =====================
    // A2-4 / A2-21: admin auth verifies the password with ASYNC scrypt (off the
    // event loop — concurrent dashboard admin POSTs no longer serialize on a
    // synchronous KDF and stall the loop into a 502) and applies a GLOBAL
    // failure tarpit: a growing delay on FAILED attempts that throttles a
    // distributed / rotating-IP brute-force (the per-IP 60/min limit alone didn't).
    let adminAuthFailures = 0;
    let adminFailWindowStart = Date.now();
    const ADMIN_FAIL_WINDOW_MS = 60_000;
    async function checkAdminAuth(ctx: any): Promise<boolean> {
        const config = getLocalConfig();
        const headerPass = ctx.request?.headers?.['x-admin-password'] || ctx.request?.header?.['x-admin-password'];
        const password = ctx.requestBody?.password || headerPass || ctx.query?.password || ctx.request?.query?.password;
        const ok = !!password && !!config.adminHash && !!config.salt
            && await verifyPasswordAsync(password as string, config.adminHash, config.salt);
        if (!ok) {
            const now = Date.now();
            if (now - adminFailWindowStart > ADMIN_FAIL_WINDOW_MS) { adminAuthFailures = 0; adminFailWindowStart = now; }
            adminAuthFailures++;
            // Progressive delay (cap 5s) — tarpits brute-force without hard-locking.
            await new Promise(r => setTimeout(r, Math.min(adminAuthFailures * 250, 5000)));
            ctx.status = 401;
            ctx.body = { error: 'Invalid password' };
            return false;
        }
        if (adminAuthFailures > 0) adminAuthFailures = Math.max(0, adminAuthFailures - 1);
        return true;
    }

    // ===================== ROUTE MODULES =====================
    // Shared dependencies passed to all route modules
    const deps: RouteDeps = {
        checkAdminAuth,
        rateLimit,
        clampLimit,
        clampOffset,
        activeConnections,
        calculateAnalytics,
        enforceReadAuth: ENFORCE_READ_AUTH,
    };

    // Mount all route modules
    const routeModules = [
        createSettingsRoutes(deps),
        createCommunityRoutes(deps),
        createAdminRoutes(deps),
        createBackupRoutes(deps),
        createMarketplaceRoutes(deps),
        createMessagingRoutes(deps),
        createCommonsRoutes(deps),
    ];
    for (const mod of routeModules) {
        router.use(mod.routes());
        router.use(mod.allowedMethods());
    }

    // Mount federation routes
    mountFederationRoutes(router);

    app.use(router.routes());
    app.use(router.allowedMethods());

    // Serve the PWA static files (assets, JS, CSS — but not index.html at root)
    app.use(serve(PUBLIC_DIR, {
        index: false,
        gzip: true,
    }));

    // SPA fallback — return index.html for /app/* routes only
    app.use(async (ctx) => {
        if (ctx.method === 'GET' && ctx.path.startsWith('/app')) {
            const indexPath = path.join(PUBLIC_DIR, 'index.html');
            if (fs.existsSync(indexPath)) {
                ctx.type = 'html';
                ctx.body = fs.createReadStream(indexPath);
            }
        }
    });

    const serverOptions: https.ServerOptions = {
        cert: getServerCertPem(),
        key: getServerKeyPem(),
    };

    return new Promise((resolve) => {
        const server = https.createServer(serverOptions, app.callback());

        // WebSocket upgrade handler
        const wss = new WebSocketServer({ noServer: true });
        const logsWss = new WebSocketServer({ noServer: true });

        server.on('upgrade', (req, socket, head) => {
            const reqUrl = req.url || '';
            const parsedUrl = new URL(reqUrl, 'https://localhost');
            const pathname = parsedUrl.pathname;

            if (pathname === '/ws') {
                // SRV-4: require a member-signed connect token when enforcement is on.
                if (ENFORCE_WS_AUTH && !verifyWsConnect(pathname, parsedUrl.searchParams)) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                wss.handleUpgrade(req, socket, head, (ws: any) => {
                    ws.isAlive = true;
                    ws.on('pong', () => { ws.isAlive = true; });
                    // A2-20: tag the socket with its authenticated member (present only
                    // under ENFORCE_WS_AUTH, where verifyWsConnect validated this pubkey's
                    // signature) so broadcast() can scope sensitive events to the parties.
                    ws._memberPubkey = ENFORCE_WS_AUTH ? (parsedUrl.searchParams.get('pubkey') || null) : null;

                    addWsClient(ws);
                    trackConnection(ws, 'sync', req);
                    ws.on('close', () => {
                        removeWsClient(ws);
                        untrackConnection(ws);
                    });
                    ws.on('error', () => {
                        removeWsClient(ws);
                        untrackConnection(ws);
                    });
                });
            } else if (pathname === '/ws/logs') {
                const auth = parsedUrl.searchParams.get('auth');
                const config = getLocalConfig();
                if (!auth || !config.adminHash || !config.salt || !verifyPassword(auth, config.adminHash, config.salt)) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                logsWss.handleUpgrade(req, socket, head, (ws: any) => {
                    ws.isAlive = true;
                    ws.on('pong', () => { ws.isAlive = true; });

                    addLogClient(ws);
                    trackConnection(ws, 'admin', req);
                    ws.on('close', () => {
                        removeLogClient(ws);
                        untrackConnection(ws);
                    });
                    ws.on('error', () => {
                        removeLogClient(ws);
                        untrackConnection(ws);
                    });
                });
            } else {
                socket.destroy();
            }
        });

        // Setup 60-second ping/pong heartbeat to clean up dead/ghost connections
        const heartbeatInterval = setInterval(() => {
            wss.clients.forEach((ws: any) => {
                if (ws.isAlive === false) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
            logsWss.clients.forEach((ws: any) => {
                if (ws.isAlive === false) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, 60000);

        server.on('close', () => {
            clearInterval(heartbeatInterval);
        });

        server.listen(port, () => {
            console.log(`🔒 PWA + Settings + API (HTTPS) listening on https://0.0.0.0:${port}`);
            resolve();
        });
    });
}
/**
 * Read raw request body as a string
 */
// A2-10 (SRV-11): cap the JSON request body. `readBody` previously accumulated
// the entire body into one string with no limit, so any POST/PUT/DELETE — including
// the UNAUTHENTICATED /api/invite/redeem (signature-bypassed) — could OOM the
// process or stall it in a multi-second JSON.parse with a multi-GB payload. 2 MB
// comfortably covers every legitimate JSON request (avatars/photos/attachments are
// their own binary endpoints); past it we abort with 413.
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
class BodyTooLargeError extends Error { constructor() { super('Request body too large'); this.name = 'BodyTooLargeError'; } }

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        req.on('data', (chunk: Buffer) => {
            if (aborted) return; // already over limit — discard without buffering
            total += chunk.length;
            if (total > MAX_JSON_BODY_BYTES) {
                aborted = true;
                reject(new BodyTooLargeError()); // stop buffering; do NOT destroy the
                // socket abruptly (that races the 413 response into an EPIPE) — just
                // stop accumulating. The Content-Length pre-check handles the common case.
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

