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
import { getCaCertPem, getServerCertPem, getServerKeyPem, isUsingLetsEncrypt } from './tls.js';
import {
    getLocalConfig, saveLocalConfig, hashPassword, verifyPassword, verifyPasswordAsync,
    getThresholds, updateThresholds, DEFAULT_THRESHOLDS,
    validatePasswordStrength,
    generateReplicationToken, setReplicationToken, clearReplicationToken, hasReplicationToken, verifyReplicationToken,
} from './local-config.js';
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
    generateInvite, redeemInvite, redeemOfflineTicket, getInviteTree, getInvitesByMember,
    adminGenerateInvite, getMemberTrustProfile, getTrustProfileForViewer,
    vouchMember, hasListedOffer,
    updateProfile, getProfile, getAllProfiles,
    createConversation, sendMessage, editMessage, getConversationsByMember, toggleMessageReaction,
    getConversationMessages, getConversation,
    getCommunityHealth,
    seedGenesisMember,
    addRating, getRatings, getAverageRating, getRatingsGiven,
    submitReport, getReports, dismissReport, actionReport, getReportCount,
    getFriends, addFriend, removeFriend, setGuardian,
    adminSetUserStatus, adminSetElder, adminDeletePost, adminPruneUser, adminBulkDeletePosts,
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
    getMemberPreferences, setMemberPreferences,
    getMemberStats,
    getGuardiansOf, createRecoveryRequest, dispatchPushNotification, getPendingRecoveryRequests, approveRecovery, rejectRecovery, getRecoveryStatus, cancelRecovery
} from './state-engine.js';
import { getCrowdfundProjects, getCrowdfundProject, createCrowdfundProject, updateCrowdfundProject, pledgeToProject, deleteCrowdfundProject, db } from './db/db.js';
import { initDirectoryPublisher, pushDirectoryNow } from './directory-publisher.js';
import { getBackupStatus, requestResync } from './backup-puller.js';
import {
    writeDbSnapshot, createSnapshot, listSnapshots, resolveSnapshotPath,
    getAutoSnapshotConfig, updateAutoSnapshotConfig,
} from './snapshot-scheduler.js';

const PUBLIC_DIR = path.resolve('public');
import { PROTOCOL_CONSTANTS } from '@beanpool/core';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


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

    // ===================== UNIVERSAL DEEP LINKS (AASA / ASSETLINKS) =====================
    // Apple App Site Association
    router.get('/.well-known/apple-app-site-association', async (ctx) => {
        // IMPORTANT: Set APPLE_TEAM_ID in your .env to the 10-character Team ID of the new Apple Developer Account.
        // Failing to do so will break Universal Links (deep linking) for the iOS app.
        const teamId = process.env.APPLE_TEAM_ID || '485XM2R33S'; // Fallback to original Assignor Team ID
        const bundleId = 'org.beanpool.pillar';

        ctx.type = 'application/json';
        ctx.body = {
            applinks: {
                details: [
                    {
                        appIDs: [`${teamId}.${bundleId}`],
                        components: [
                            {
                                "/": "/",
                                "?": { "invite": "*" },
                                "comment": "Match invite links with query parameters"
                            },
                            {
                                "/": "/app*",
                                "comment": "Match legacy app paths"
                            }
                        ]
                    }
                ]
            }
        };
    });

    // Android App Links
    router.get('/.well-known/assetlinks.json', async (ctx) => {
        // Fallback to the known SHA256 of org.beanpool.pillar if env is missing
        const sha256 = process.env.ANDROID_CERT_SHA256 || 'FA:55:52:D6:8C:4A:D6:19:2F:AD:A6:A7:78:39:B4:E8:4D:50:FE:E9:FD:6C:C5:DF:6B:0F:51:E7:CB:DC:03:2B';
        const packageName = 'org.beanpool.pillar';

        ctx.type = 'application/json';
        ctx.body = [
            {
                relation: ["delegate_permission/common.handle_all_urls"],
                target: {
                    namespace: "android_app",
                    package_name: packageName,
                    sha256_cert_fingerprints: [sha256]
                }
            }
        ];
    });

    // ===================== SETTINGS PAGE =====================

    router.get('/settings', async (ctx) => {
        const publicPath = path.join(__dirname, '../public/settings.html');
        const staticPath = path.join(__dirname, '../static/settings.html');
        const resolvedPath = fs.existsSync(publicPath) ? publicPath : staticPath;

        if (fs.existsSync(resolvedPath)) {
            ctx.type = 'html';
            ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
            ctx.body = fs.createReadStream(resolvedPath);
        } else {
            ctx.status = 404;
            ctx.body = 'Settings page not found. Ensure settings.html is in the public directory.';
        }
    });

    router.get('/settings.js', async (ctx) => {
        const publicPath = path.join(__dirname, '../public/settings.js');
        const staticPath = path.join(__dirname, '../static/settings.js');
        const resolvedPath = fs.existsSync(publicPath) ? publicPath : staticPath;

        if (fs.existsSync(resolvedPath)) {
            ctx.type = 'application/javascript';
            ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
            ctx.body = fs.createReadStream(resolvedPath);
        } else {
            ctx.status = 404;
            ctx.body = '// settings.js not found';
        }
    });


    // ===================== ROOT REDIRECT =====================
    // Redirect root to the PWA app — existing users auto-login via IndexedDB identity
    // Preserve query params (e.g. ?invite=BP-XXXX-XXXX) for invite URL flow
    router.get('/', async (ctx) => {
        const query = ctx.querystring ? `?${ctx.querystring}` : '';
        ctx.redirect(`/app${query}`);
    });

    // ===================== LOCAL STATUS API =====================

    router.get('/api/local/status', async (ctx) => {
        const config = getLocalConfig();
        
        // Allow cross-origin requests so other nodes' settings UI can fetch status
        ctx.set('Access-Control-Allow-Origin', '*');
        
        ctx.body = {
            isLocked: config.isLocked,
            callsign: config.callsign || null,
            location: config.location || null,
        };
    });

    // ===================== AUTH API =====================

    router.post('/api/local/verify-password', async (ctx) => {
        if (!rateLimit(ctx)) return;
        const config = getLocalConfig();
        const { password } = (ctx as any).requestBody || {};

        if (!password) {
            ctx.status = 400;
            ctx.body = { error: 'Password required' };
            return;
        }

        if (!config.adminHash || !config.salt ||
            !verifyPassword(password, config.adminHash, config.salt)) {
            logger.security('AUTH', 'Failed administrative login attempt.');
            ctx.status = 401;
            ctx.body = { error: 'Invalid password' };
            return;
        }

        logger.security('AUTH', 'Successful administrative login.');
        ctx.body = { success: true };
    });

    // Admin: Generate invite codes — supports tiered genesis invites
    router.post('/api/admin/seed-invite', async (ctx) => {
        if (!rateLimit(ctx)) return;
        const config = getLocalConfig();
        const { password, type: inviteType } = (ctx as any).requestBody || {};

        if (!password || !config.adminHash || !config.salt ||
            !verifyPassword(password, config.adminHash, config.salt)) {
            logger.security('AUTH', 'Unauthorized attempt to generate invite code.');
            ctx.status = 401;
            ctx.body = { error: 'Invalid password' };
            return;
        }

        // Validate invite type
        const genesisType = (['standard', 'trusted', 'ambassador', 'elder'].includes(inviteType) ? inviteType : 'standard') as 'standard' | 'trusted' | 'ambassador' | 'elder';

        // Check if there are already members
        const info = getCommunityInfo();
        if (info.memberCount > 0) {
            // Already have members — generate a tiered invite from the genesis member
            const members = getAllMembers();
            let genesisMember = members.find(m => m.invitedBy === 'genesis');
            if (!genesisMember) {
                // Restored DB fallback: find the 'Admin' or first non-system member to act as genesis
                genesisMember = members.find(m => m.callsign === 'Admin')
                    || members.find(m => m.publicKey !== 'SYSTEM' && !m.publicKey.startsWith('escrow_'))
                    || members[0];
            }
            if (genesisMember) {
                const invite = adminGenerateInvite(genesisMember.publicKey, genesisType);
                if (invite) {
                    logger.info('ADMIN', `Seed invite generated: ${invite.code} [${genesisType}]`);
                    const tierLabels: Record<string, string> = { standard: '🥚 Newcomer', trusted: '🏠 Resident', ambassador: '🏛️ Steward', elder: '⛰️ Elder' };
                    ctx.body = { success: true, code: invite.code, type: genesisType, tierLabel: tierLabels[genesisType], message: `${tierLabels[genesisType]} invite generated` };
                    return;
                }
            }
            ctx.status = 400;
            ctx.body = { error: 'Could not generate invite — try from the Invite tab' };
            return;
        }

        // Fresh node — seed a genesis admin account
        const crypto = await import('node:crypto');
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        // Use raw public key bytes as hex for the publicKey identifier
        const pubKeyDer = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
        const pubKeyHex = pubKeyDer.subarray(-32).toString('hex');

        seedGenesisMember(pubKeyHex, 'Admin');
        const invite = adminGenerateInvite(pubKeyHex, genesisType);
        if (!invite) {
            ctx.status = 500;
            ctx.body = { error: 'Failed to generate seed invite' };
            return;
        }

        logger.info('ADMIN', `Seed invite generated: ${invite.code} [${genesisType}]`);
        ctx.body = { success: true, code: invite.code, type: genesisType, message: 'Genesis member created + seed invite generated' };
    });

    // ===================== IDENTITY API =====================

    router.post('/api/local/update-identity', async (ctx) => {
        if (!rateLimit(ctx)) return;
        const config = getLocalConfig();
        const { password, callsign, lat, lng, communityName, contactEmail, contactPhone } = (ctx as any).requestBody || {};

        if (!password || !config.adminHash || !config.salt ||
            !verifyPassword(password, config.adminHash, config.salt)) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid password' };
            return;
        }

        if (callsign !== undefined) config.callsign = (callsign || '').slice(0, 20);
        if (lat !== undefined && lng !== undefined) {
            config.location = { lat: parseFloat(lat), lng: parseFloat(lng) };
        }
        if (communityName !== undefined) config.communityName = (communityName || '').slice(0, 60) || null;
        if (contactEmail !== undefined) config.contactEmail = (contactEmail || '').slice(0, 100) || null;
        if (contactPhone !== undefined) config.contactPhone = (contactPhone || '').slice(0, 30) || null;
        saveLocalConfig(config);
        ctx.body = { success: true };
    });

    // Public community info — no auth required (landing page)
    router.get('/api/local/community-info', async (ctx) => {
        const config = getLocalConfig();
        ctx.body = {
            communityName: config.communityName || config.callsign || 'BeanPool Community',
            contactEmail: config.contactEmail || null,
            contactPhone: config.contactPhone || null,
            callsign: config.callsign || null,
        };
    });

    // ===================== ADMIN ACTIONS (Requires Password) =====================

    // Middleware-like function for inline password check
    // A2-4 / A2-21: admin auth verifies the password with ASYNC scrypt (off the
    // event loop — concurrent dashboard admin POSTs no longer serialize on a
    // synchronous KDF and stall the loop into a 502) and applies a GLOBAL
    // failure tarpit: a growing delay on FAILED attempts that throttles a
    // distributed / rotating-IP brute-force (the per-IP 60/min limit alone didn't).
    // The counter is global (one admin password = one "account") and decays on
    // success, so a real admin — who authenticates SUCCESSFULLY and is never
    // delayed — is unaffected, avoiding the lockout-as-DoS that a hard lock invites.
    let adminAuthFailures = 0;
    let adminFailWindowStart = Date.now();
    const ADMIN_FAIL_WINDOW_MS = 60_000;
    async function checkAdminAuth(ctx: any): Promise<boolean> {
        const config = getLocalConfig();
        const { password } = ctx.requestBody || {};
        const ok = !!password && !!config.adminHash && !!config.salt
            && await verifyPasswordAsync(password, config.adminHash, config.salt);
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

    router.post('/api/local/admin/data', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        ctx.body = {
            members: getAllMembers(),
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
        if (!(await checkAdminAuth(ctx as any))) return;
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

    // Promote a member to (or demote from) the Elder tier so they can help verify
    // (vouch for) other members. Grants the Elder vouch capability + Elder standing,
    // but NOT password-admin powers. Body: { password, grant?: boolean } (defaults to grant).
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

    // ======================== DATABASE BACKUP ========================

    router.post('/api/local/admin/backup', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const { execFileSync } = await import('node:child_process');
        const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
        const tmpDir = path.join(DATA_DIR, '.backup-tmp');
        const tarPath = path.join(DATA_DIR, '.backup-tmp.tar.gz');

        try {
            // Clean up any previous temp files
            if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
            if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
            fs.mkdirSync(tmpDir, { recursive: true });

            // Use SQLite VACUUM INTO for a consistent snapshot (no WAL corruption
            // risk) via the shared helper. NOTE: this tar is built ONLY from
            // `tmpDir` (state.db + node_config.json below), so it deliberately
            // does NOT recurse into data/snapshots/ — auto-snapshots never get
            // swallowed into the manual backup archive.
            const snapshotPath = path.join(tmpDir, 'state.db');
            writeDbSnapshot(snapshotPath);

            // Copy node_config.json if it exists
            const configPath = path.join(DATA_DIR, 'node_config.json');
            if (fs.existsSync(configPath)) {
                fs.copyFileSync(configPath, path.join(tmpDir, 'node_config.json'));
            } else {
                // Export config from DB
                const config = getLocalConfig();
                fs.writeFileSync(path.join(tmpDir, 'node_config.json'), JSON.stringify(config, null, 2));
            }

            // Create tar.gz
            execFileSync('tar', ['-czf', tarPath, '-C', tmpDir, '.']);

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            ctx.set('Content-Type', 'application/gzip');
            ctx.set('Content-Disposition', `attachment; filename="beanpool-backup-${timestamp}.tar.gz"`);
            ctx.body = fs.createReadStream(tarPath);

            // Clean up after stream finishes
            ctx.res.on('finish', () => {
                try {
                    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
                    if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
                } catch { /* ignore cleanup errors */ }
            });
        } catch (e: any) {
            console.error('Backup failed:', e);
            // Clean up on error
            try {
                if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
                if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
            } catch { /* ignore */ }
            ctx.status = 500;
            ctx.body = { error: 'Backup failed: ' + e.message };
        }
    });

    // ======================== BACKUP TAB ========================
    // Read-only enrollment bundle for standing up a NEW backup server that joins
    // THIS node's community. The operator runs `scripts/setup-backup.mjs` on the
    // would-be backup machine; it GETs this with the X-Admin-Password header,
    // writes genesis.json + community.key into the backup's data dir, and configures
    // the backup to pull from this primary. Returns ONLY material the backup needs
    // to recognize this primary's identity — it mutates nothing.
    function resolvePrimaryUrl(ctx: any): string {
        // Prefer the public Let's Encrypt hostname; else reconstruct from the request.
        if (process.env.CF_RECORD_NAME) return `https://${process.env.CF_RECORD_NAME}`;
        const host = ctx.request.header['x-forwarded-host'] || ctx.request.header['host'] || ctx.host;
        const proto = (ctx.request.header['x-forwarded-proto'] as string) || ctx.protocol || 'https';
        return `${proto}://${host}`;
    }

    router.get('/api/local/admin/backup-enroll', async (ctx) => {
        const headerPassword = ctx.request.header['x-admin-password'];
        if (headerPassword) (ctx as any).requestBody = { password: headerPassword };
        if (!(await checkAdminAuth(ctx as any))) return;
        try {
            const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
            const genesisPath = path.join(DATA_DIR, 'genesis.json');
            const communityKeyPath = path.join(DATA_DIR, 'community.key');
            if (!fs.existsSync(genesisPath)) {
                ctx.status = 503;
                ctx.body = { error: 'Genesis not initialized yet' };
                return;
            }
            const genesis = JSON.parse(fs.readFileSync(genesisPath, 'utf-8'));
            const communityKey = fs.existsSync(communityKeyPath)
                ? fs.readFileSync(communityKeyPath).toString('base64')
                : null;
            const node = getP2PNode();
            const primaryPeerId = node?.peerId?.toString() ?? null;
            if (!primaryPeerId) {
                ctx.status = 503;
                ctx.body = { error: 'Node signing identity not ready yet — try again shortly' };
                return;
            }
            ctx.set('Cache-Control', 'no-store');
            ctx.body = {
                communityId: genesis.communityId,
                genesis,
                communityKey,
                primaryPeerId,
                primaryUrl: resolvePrimaryUrl(ctx),
            };
        } catch (e: any) {
            console.error('[Backup] backup-enroll failed:', e);
            ctx.status = 500;
            ctx.body = { error: 'Failed to build enrollment bundle' };
        }
    });

    // Live health tile for the Backup tab: this node's role + (if a backup) the
    // primary it's pulling, plus the puller's last-success / failure-streak state.
    router.post('/api/local/admin/backup-status', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const config = getLocalConfig();
        ctx.body = {
            role: getNodeRole(),
            primaryUrl: config.backupPrimaryUrl || process.env.BACKUP_PRIMARY_URL || null,
            intervalMs: Number(process.env.BACKUP_PULL_INTERVAL_MS) || 60000,
            ...getBackupStatus(),
        };
    });

    router.post('/api/local/admin/replication-config/get', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const config = getLocalConfig();
        ctx.body = {
            primaryUrl: config.backupPrimaryUrl || process.env.BACKUP_PRIMARY_URL || '',
            hasPassword: !!(config.backupAdminPassword || process.env.BACKUP_ADMIN_PASSWORD),
            hasToken: !!(config.backupReplicationToken || process.env.BACKUP_REPLICATION_TOKEN),
        };
    });

    router.post('/api/local/admin/replication-config/save', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const { primaryUrl, primaryPassword, primaryToken } = (ctx as any).requestBody || {};
        if (primaryUrl === undefined) {
            ctx.status = 400;
            ctx.body = { error: 'primaryUrl is required' };
            return;
        }

        const config = getLocalConfig();
        config.backupPrimaryUrl = primaryUrl.trim() || null;
        if (primaryPassword) {
            config.backupAdminPassword = primaryPassword;
        }
        // Replication token this backup presents to its primary. Empty string clears it
        // (revert to admin-password auth); undefined leaves it unchanged.
        if (primaryToken !== undefined) {
            config.backupReplicationToken = (typeof primaryToken === 'string' && primaryToken.trim()) ? primaryToken.trim() : null;
        }
        saveLocalConfig(config);
        ctx.body = { success: true };
    });

    // ---------- Replication token (primary side) ----------
    // A dedicated, scoped credential for the snapshot-pull endpoint, distinct from the
    // admin password: least-privilege (read-only replication only) and independently
    // rotatable. Stored hashed; the plaintext is shown to the operator exactly once.
    router.post('/api/local/admin/replication-token/status', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const config = getLocalConfig();
        ctx.body = {
            hasToken: hasReplicationToken(),
            tokenOnly: !!config.replicationTokenOnly,
            createdAt: config.replicationTokenCreatedAt || null,
        };
    });

    router.post('/api/local/admin/replication-token/generate', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const token = generateReplicationToken();
        setReplicationToken(token);
        // Returned ONCE — only the hash is persisted, so it can never be shown again.
        ctx.body = { success: true, token };
    });

    router.post('/api/local/admin/replication-token/mode', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const { tokenOnly } = (ctx as any).requestBody || {};
        const config = getLocalConfig();
        if (tokenOnly && !hasReplicationToken()) {
            ctx.status = 400;
            ctx.body = { error: 'Generate a replication token before enabling token-only mode.' };
            return;
        }
        config.replicationTokenOnly = !!tokenOnly;
        saveLocalConfig(config);
        ctx.body = { success: true, tokenOnly: config.replicationTokenOnly };
    });

    router.post('/api/local/admin/replication-token/clear', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        clearReplicationToken();
        ctx.body = { success: true };
    });

    // ---------- Replication access log (primary side) ----------
    router.post('/api/local/admin/replication-access', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        ctx.body = {
            ...getReplicationAccessLog(),
            tokenOnly: !!getLocalConfig().replicationTokenOnly,
            hasToken: hasReplicationToken(),
        };
    });

    // ---------- Force resync (backup side) ----------
    router.post('/api/local/admin/replication-resync', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const result = await requestResync();
        if (!result.ok) {
            ctx.status = 400;
            ctx.body = { error: result.error || 'Resync failed' };
            return;
        }
        ctx.body = { success: true };
    });

    // ---------- Auto-snapshots (local point-in-time archive) ----------
    // All snapshot file ops are path-traversal-safe: a caller-supplied `name` is
    // resolved via resolveSnapshotPath(), which accepts only a bare basename that
    // resolves directly inside data/snapshots/.
    router.post('/api/local/admin/snapshots/list', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        ctx.body = { success: true, snapshots: listSnapshots(), config: getAutoSnapshotConfig() };
    });

    router.post('/api/local/admin/snapshots/create', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        try {
            const info = createSnapshot();
            ctx.body = { success: true, snapshot: info };
        } catch (e: any) {
            ctx.status = 500;
            ctx.body = { error: e?.message || 'Snapshot failed' };
        }
    });

    router.post('/api/local/admin/snapshots/delete', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const { name } = (ctx as any).requestBody || {};
        const target = resolveSnapshotPath(name);
        if (!target) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid snapshot name' };
            return;
        }
        try {
            if (fs.existsSync(target)) fs.unlinkSync(target);
            ctx.body = { success: true };
        } catch (e: any) {
            ctx.status = 500;
            ctx.body = { error: e?.message || 'Delete failed' };
        }
    });

    // Download via GET so the browser can stream it; auth via the X-Admin-Password
    // header (the name is in the query string, never the password).
    router.get('/api/local/admin/snapshots/download', async (ctx) => {
        const headerPassword = ctx.request.header['x-admin-password'];
        if (headerPassword) (ctx as any).requestBody = { password: headerPassword };
        if (!(await checkAdminAuth(ctx as any))) return;
        const name = ctx.query.name as string;
        const target = resolveSnapshotPath(name);
        if (!target || !fs.existsSync(target)) {
            ctx.status = 404;
            ctx.body = { error: 'Snapshot not found' };
            return;
        }
        ctx.set('Content-Type', 'application/octet-stream');
        ctx.set('Content-Disposition', `attachment; filename="${path.basename(target)}"`);
        ctx.body = fs.createReadStream(target);
    });

    // Get (no body) or set (with {enabled,intervalHours,keep}) the auto-snapshot config.
    router.post('/api/local/admin/snapshots/config', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const body = (ctx as any).requestBody || {};
        const hasUpdate = body.enabled !== undefined || body.intervalHours !== undefined || body.keep !== undefined;
        const config = hasUpdate
            ? updateAutoSnapshotConfig({ enabled: body.enabled, intervalHours: body.intervalHours, keep: body.keep })
            : getAutoSnapshotConfig();
        ctx.body = { success: true, config };
    });

    // Phase 1 (one-directional live backup): the read-only snapshot the BACKUP
    // pulls over HTTPS. This is the entire inbound channel of the new topology —
    // state flows primary → backup ONLY, so the primary never imports peer data
    // and the SRV-20/21 ledger-forgery vector has no trusted writer.
    //
    // It is a pure EXPORT: it returns the same signed `SyncPayload` the P2P sync
    // path produces (exportSyncState already signs with the node's libp2p key),
    // and calls NOTHING that mutates state — serving it adds zero inbound trust.
    // Gated by the admin password (shared operator secret, sent in the
    // X-Admin-Password header like /restore, never in the URL); routes under
    // /api/local/* bypass the member-signature middleware. The backup verifies
    // the signature against its single configured `mirror` connector (the
    // primary) inside importRemoteState, so a forged snapshot is rejected there.
    router.get('/api/local/admin/sync-snapshot', async (ctx) => {
        // This endpoint emits the ENTIRE ledger (incl. DMs + recovery data). It is
        // authenticated with a dedicated, scoped replication TOKEN (least privilege,
        // independently rotatable). The all-powerful admin password is still accepted
        // during rollout — until the operator enables token-only — so existing backups
        // keep working. Every pull (and every rejected attempt) is logged for the
        // primary's Replication Access panel.
        const ip = replicationClientIp(ctx);
        const token = ctx.request.header['x-replication-token'];
        const headerPassword = ctx.request.header['x-admin-password'];
        const cfg = getLocalConfig();
        let authMode: 'token' | 'admin-pw' | null = null;

        if (token) {
            if (await verifyReplicationToken(String(token))) {
                authMode = 'token';
            } else {
                recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: 'invalid replication token' });
                ctx.status = 401;
                ctx.body = { error: 'Invalid replication token' };
                return;
            }
        } else if (headerPassword && !cfg.replicationTokenOnly) {
            (ctx as any).requestBody = { password: headerPassword };
            if (await checkAdminAuth(ctx as any)) {
                authMode = 'admin-pw';
            } else {
                // checkAdminAuth already set 401 + applied the brute-force tarpit delay.
                recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: 'invalid admin password' });
                return;
            }
        } else {
            recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: cfg.replicationTokenOnly ? 'replication token required' : 'no credentials' });
            ctx.status = 401;
            ctx.body = { error: cfg.replicationTokenOnly ? 'Replication token required' : 'Authentication required' };
            return;
        }

        try {
            const node = getP2PNode();
            const nodeId = node?.peerId?.toString() ?? 'unknown';
            const payload = await exportSyncState(nodeId);
            if (!payload.signature || !payload.publicKey) {
                // No libp2p identity loaded → the backup couldn't verify authorship.
                ctx.status = 503;
                ctx.body = { error: 'Snapshot unavailable: node signing identity not ready' };
                return;
            }
            ctx.set('Cache-Control', 'no-store');
            // Advertise our role so a puller can warn if it is replicating from
            // another backup (chained replication is a misconfiguration).
            ctx.set('X-Node-Role', getNodeRole());
            ctx.body = payload;
            recordReplicationAccess({ at: Date.now(), ip, auth: authMode });
        } catch (e: any) {
            console.error('[Backup] Snapshot export failed:', e);
            ctx.status = 500;
            ctx.body = { error: 'Snapshot export failed' };
        }
    });

    router.post('/api/local/admin/restore', async (ctx) => {
        // Handle auth via custom header for binary uploads to prevent password exposure in query string
        const headerPassword = ctx.request.header['x-admin-password'];
        if (headerPassword) {
            (ctx as any).requestBody = { password: headerPassword };
        }
        if (!(await checkAdminAuth(ctx as any))) return;

        const { execFileSync } = await import('node:child_process');
        const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
        const tmpDir = path.join(DATA_DIR, '.restore-tmp');
        const tarPath = path.join(DATA_DIR, 'uploaded-backup.tar.gz');

        try {
            // SECURITY (SRV-11): cap the restore upload so an oversized archive can't
            // exhaust disk. Reject an over-limit Content-Length up front, then enforce
            // the cap on the bytes actually streamed (a lying/absent length is the real
            // attack vector), aborting on overflow. The catch below already removes the
            // partial tarball + tmpDir.
            const MAX_RESTORE_BYTES = 500 * 1024 * 1024; // 500 MB
            const declaredLen = Number(ctx.request.header['content-length']);
            if (Number.isFinite(declaredLen) && declaredLen > MAX_RESTORE_BYTES) {
                ctx.status = 413;
                ctx.body = { error: 'Backup archive too large (max 500 MB)' };
                return;
            }
            // Read binary body to file
            const bodyStream = ctx.req;
            const writeStream = fs.createWriteStream(tarPath);
            let received = 0;
            await new Promise<void>((resolve, reject) => {
                bodyStream.on('data', (chunk: Buffer) => {
                    received += chunk.length;
                    if (received > MAX_RESTORE_BYTES) {
                        bodyStream.destroy();
                        writeStream.destroy();
                        reject(Object.assign(new Error('Backup archive too large (max 500 MB)'), { httpStatus: 413 }));
                    }
                });
                bodyStream.pipe(writeStream);
                writeStream.on('finish', () => resolve());
                bodyStream.on('error', reject);
                writeStream.on('error', reject);
            });

            // Extract the tar
            if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
            fs.mkdirSync(tmpDir, { recursive: true });

            // SECURITY (SRV-9a): a restore archive is fully attacker-controlled
            // input. `tar -x` does NOT sanitize member paths — GNU tar (the prod
            // image) follows `../` and absolute names and will materialise
            // symlinks/hardlinks — so a crafted archive could write or redirect
            // files anywhere the node process can reach (cron dirs,
            // authorized_keys, the app's own JS) → RCE / node takeover. Inspect
            // the listing and refuse the WHOLE archive if any member would escape
            // the extraction dir or is a link, BEFORE extracting a single byte.
            // Legitimate backups are written with `tar -C tmpDir .` (see the
            // backup route above), so members are plain `./`-prefixed relative
            // paths and pass cleanly.
            const listing = execFileSync('tar', ['-tzf', tarPath], {
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
            }).split('\n').map((s: string) => s.trim()).filter(Boolean);
            for (const entry of listing) {
                // Reject POSIX/Windows-absolute paths and any `..` traversal segment.
                if (path.isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || entry.split('/').some(seg => seg === '..')) {
                    throw new Error('Invalid backup archive: unsafe member path');
                }
            }
            // Reject symlink/hardlink members (type char 'l'/'h' in the verbose
            // listing) so a link can't redirect a later write outside tmpDir.
            const verboseListing = execFileSync('tar', ['-tvzf', tarPath], {
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
            }).split('\n').map((s: string) => s.trim()).filter(Boolean);
            for (const line of verboseListing) {
                if (line[0] === 'l' || line[0] === 'h') {
                    throw new Error('Invalid backup archive: links are not permitted');
                }
            }

            execFileSync('tar', ['-xzf', tarPath, '-C', tmpDir]);

            // Validate that state.db exists and is a regular file
            const restoredDb = path.join(tmpDir, 'state.db');
            if (!fs.existsSync(restoredDb) || !fs.lstatSync(restoredDb).isFile()) {
                throw new Error('Invalid backup archive: state.db missing');
            }

            // Close current DB connection safely before overwriting
            const { db } = await import('./db/db.js');
            try { db.close(); } catch (e) { console.error('Error closing DB:', e); }

            // Replace files
            fs.copyFileSync(path.join(tmpDir, 'state.db'), path.join(DATA_DIR, 'state.db'));
            if (fs.existsSync(path.join(tmpDir, 'node_config.json'))) {
                fs.copyFileSync(path.join(tmpDir, 'node_config.json'), path.join(DATA_DIR, 'node_config.json'));
            }

            // Clean up
            fs.rmSync(tmpDir, { recursive: true });
            fs.unlinkSync(tarPath);

            ctx.body = { success: true };
            
            // Wait 1 second then exit
            setTimeout(() => {
                console.log('Restore successful, rebooting node...');
                process.exit(0);
            }, 1000);

        } catch (e: any) {
            console.error('Restore failed:', e);
            try {
                if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
                if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
            } catch { /* ignore */ }
            ctx.status = e?.httpStatus || 500;
            ctx.body = { error: e?.httpStatus === 413 ? e.message : ('Restore failed: ' + e.message) };
        }
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

    router.post('/api/local/change-password', async (ctx) => {
        if (!rateLimit(ctx)) return;
        const config = getLocalConfig();
        const { currentPassword, newPassword } = (ctx as any).requestBody || {};

        if (!currentPassword || !config.adminHash || !config.salt ||
            !verifyPassword(currentPassword, config.adminHash, config.salt)) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid current password' };
            return;
        }

        const validation = validatePasswordStrength(newPassword || '');
        if (!validation.valid) {
            ctx.status = 400;
            ctx.body = { error: validation.error };
            return;
        }

        const { hash, salt } = hashPassword(newPassword);
        config.adminHash = hash;
        config.salt = salt;
        saveLocalConfig(config);
        ctx.body = { success: true };
    });

    // ===================== DASHBOARD API =====================

    router.get('/api/local/dashboard', async (ctx) => {
        const config = getLocalConfig();
        const node = getP2PNode();

        ctx.body = {
            identity: {
                peerId: node?.peerId?.toString() || 'unknown',
                callsign: config.callsign,
                location: config.location,
                joinedAt: config.joinedAt,
            },
            connectors: getConnectors(),
        };
    });

    // ===================== CONNECTOR API =====================

    router.get('/api/local/connectors', async (ctx) => {
        ctx.body = getConnectors();
    });

    router.post('/api/local/connectors', async (ctx) => {
        if (!rateLimit(ctx)) return;
        const config = getLocalConfig();
        const { password, address, trustLevel, callsign, enabled } = (ctx as any).requestBody || {};

        if (!password || !config.adminHash || !config.salt ||
            !verifyPassword(password, config.adminHash, config.salt)) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid password' };
            return;
        }

        if (!address) {
            ctx.status = 400;
            ctx.body = { error: 'Address is required' };
            return;
        }

        const validTrustLevels: TrustLevel[] = ['mirror', 'peer', 'blocked'];
        const level: TrustLevel = validTrustLevels.includes(trustLevel) ? trustLevel : 'peer';

        const isEnabled = enabled !== undefined ? Boolean(enabled) : undefined;
        const connector = addConnector(address, level, callsign, undefined, isEnabled);
        ctx.body = { success: true, connector };
    });

    router.post('/api/local/connectors/connect', async (ctx) => {
        if (!rateLimit(ctx)) return;
        const config = getLocalConfig();
        const { password, address } = (ctx as any).requestBody || {};

        if (!password || !config.adminHash || !config.salt ||
            !verifyPassword(password, config.adminHash, config.salt)) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid password' };
            return;
        }

        if (!address) {
            ctx.status = 400;
            ctx.body = { error: 'Address is required' };
            return;
        }

        const success = await connectToAddress(address);
        ctx.body = { success };
    });

    router.post('/api/local/connectors/disconnect', async (ctx) => {
        if (!rateLimit(ctx)) return;
        const config = getLocalConfig();
        const { password, address } = (ctx as any).requestBody || {};

        if (!password || !config.adminHash || !config.salt ||
            !verifyPassword(password, config.adminHash, config.salt)) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid password' };
            return;
        }

        if (!address) {
            ctx.status = 400;
            ctx.body = { error: 'Address is required' };
            return;
        }

        await disconnectFromAddress(address);
        ctx.body = { success: true };
    });

    router.post('/api/local/connectors/remove', async (ctx) => {
        if (!rateLimit(ctx)) return;
        const config = getLocalConfig();
        const { password, address } = (ctx as any).requestBody || {};

        if (!password || !config.adminHash || !config.salt ||
            !verifyPassword(password, config.adminHash, config.salt)) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid password' };
            return;
        }

        if (!address) {
            ctx.status = 400;
            ctx.body = { error: 'Address is required' };
            return;
        }

        await disconnectFromAddress(address);
        const removed = removeConnector(address);
        ctx.body = { success: removed };
    });

    // ===================== RESET =====================

    router.post('/api/local/reset', async (ctx) => {
        if (!rateLimit(ctx)) return;
        const config = getLocalConfig();
        const { password } = (ctx as any).requestBody || {};

        if (!password || !config.adminHash || !config.salt ||
            !verifyPassword(password, config.adminHash, config.salt)) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid password' };
            return;
        }

        saveLocalConfig({
            isLocked: false,
            callsign: null,
            location: null,
            adminHash: null,
            salt: null,
            joinedAt: null,
            communityName: null,
            contactEmail: null,
            contactPhone: null,
        });

        ctx.body = { success: true, message: 'Node reset. Restart to reconfigure.' };
    });

    // ===================== COMMUNITY API (PUBLIC) =====================

    router.get('/api/community/info', async (ctx) => {
        ctx.body = getCommunityInfo();
    });

    router.get('/api/community/health', async (ctx) => {
        ctx.body = getCommunityHealth();
    });

    // Lightweight membership probe — returns whether a public key is a registered member or recovering
    router.get('/api/community/membership/:publicKey', async (ctx) => {
        const member = getMember(ctx.params.publicKey);
        if (member) {
            ctx.body = { isMember: true, callsign: member.callsign };
        } else {
            const recovery = getRecoveryStatus(ctx.params.publicKey);
            const isRecovering = recovery && (recovery.status === 'pending' || recovery.status === 'approved');
            ctx.body = {
                isMember: false,
                callsign: null,
                isRecovering: !!isRecovering,
                recoveryStatus: recovery?.status || null
            };
        }
    });

    router.get('/api/community/members', async (ctx) => {
        ctx.body = getMembers();
    });

    router.post('/api/community/register', async (ctx) => {
        const { publicKey, callsign } = (ctx as any).requestBody || {};
        if (!publicKey || !callsign) {
            ctx.status = 400;
            ctx.body = { error: 'publicKey and callsign are required' };
            return;
        }
        const member = registerMember(publicKey, callsign.slice(0, 20));
        ctx.body = { success: true, member };
    });

    // ===================== INVITE API (PUBLIC) =====================

    router.post('/api/invite/generate', async (ctx) => {
        const { publicKey, intendedFor } = (ctx as any).requestBody || {};
        if (!publicKey) {
            ctx.status = 400;
            ctx.body = { error: 'publicKey is required' };
            return;
        }
        const invite = generateInvite(publicKey, intendedFor);
        if (!invite) {
            ctx.status = 403;
            ctx.body = { error: 'Only registered members can generate invites' };
            return;
        }
        ctx.body = { success: true, invite };
    });

    router.post('/api/invite/redeem', async (ctx) => {
        const { code, publicKey, callsign } = (ctx as any).requestBody || {};
        if (!code || !publicKey || !callsign) {
            ctx.status = 400;
            ctx.body = { error: 'code, publicKey, and callsign are required' };
            return;
        }

        const result = redeemInvite(code, publicKey, callsign.slice(0, 20));
        if (!result.success) {
            ctx.status = 400;
            ctx.body = { error: result.error };
            return;
        }
        ctx.body = { success: true, member: result.member };
    });

    router.post('/api/invite/redeem-offline', async (ctx) => {
        const { ticketB64, publicKey, callsign } = (ctx as any).requestBody || {};
        if (!ticketB64 || !publicKey || !callsign) {
            ctx.status = 400;
            ctx.body = { error: 'ticketB64, publicKey, and callsign are required' };
            return;
        }
        const result = redeemOfflineTicket(ticketB64, publicKey, callsign.slice(0, 20));
        if (!result.success) {
            ctx.status = 400;
            ctx.body = { error: result.error };
            return;
        }
        ctx.body = { success: true, member: result.member };
    });

    router.get('/api/invite/tree', async (ctx) => {
        const root = ctx.query.root as string | undefined;
        ctx.body = getInviteTree(root);
    });

    router.get('/api/invite/mine/:publicKey', async (ctx) => {
        const { publicKey } = ctx.params;
        const invites = getInvitesByMember(publicKey);
        ctx.body = { invites };
    });

    // ===================== PROFILE API (PUBLIC) =====================

    router.post('/api/profile/update', async (ctx) => {
        const { avatar, bio, contact, callsign } = (ctx as any).requestBody || {};
        const activeKey = ctx.state.actor || (ctx as any).requestBody?.publicKey;
        if (!activeKey) {
            ctx.status = 400;
            ctx.body = { error: 'publicKey is required' };
            return;
        }
        const profile = updateProfile(activeKey, { avatar, bio, contact, callsign });
        if (!profile) {
            ctx.status = 404;
            ctx.body = { error: 'Member not found' };
            return;
        }
        ctx.body = { success: true, profile };
    });

    router.get('/api/profile/:publicKey', async (ctx) => {
        const { publicKey } = ctx.params;
        // SRV-3: friends-only contact visibility must key off the CRYPTOGRAPHICALLY
        // VERIFIED requester (ctx.state.actor, set once the read is signed), not a
        // spoofable `?requester=` query param — otherwise anyone could pass a known
        // friend's pubkey to reveal hidden contact details. The query param remains
        // only as a pre-enforcement fallback; once ENFORCE_READ_AUTH is on, gated
        // profile reads are signed and the verified actor always wins.
        const requester = (ctx.state.actor as string | undefined) || (ctx.query.requester as string | undefined);
        const profile = getProfile(publicKey, requester);
        if (!profile) {
            ctx.status = 404;
            ctx.body = { error: 'Member not found' };
            return;
        }
        ctx.body = profile;
    });

    // ===================== LEDGER API (PUBLIC) =====================

    router.get('/api/ledger/balance/:publicKey', async (ctx) => {
        const { publicKey } = ctx.params;
        const member = getMember(publicKey);
        if (!member) {
            ctx.status = 404;
            ctx.body = { error: 'Member not found' };
            return;
        }
        const trust = getMemberTrustProfile(publicKey);
        const listedOffer = hasListedOffer(publicKey);
        ctx.body = {
            ...getBalance(publicKey),
            callsign: member.callsign,
            trustStats: trust.stats, // tradeCount, uniquePartners, ageDays
            grantedCredit: trust.grantedCredit,   // vouch/genesis/admin grants (separate lane, no vote weight)
            qualifiedValue: trust.qualifiedValue, // diversity-capped trade value behind the earned score
            avgRating: trust.avgRating,           // reputation multiplier inputs
            reviewCount: trust.reviewCount,
            elderVouchedBy: member.elderVouchedBy || null,
            hasListedOffer: listedOffer,
            // Gate 1: blocked from posting Needs / accepting Offers until an Offer is listed.
            isBlockedFromTrading: !listedOffer,
        };
    });

    // Viewer-aware Trust Profile: aggregate safety signals + mutual connections
    // computed relative to the (signed) viewer. POST so the viewer is the
    // cryptographically-verified actor — mutual connections leak who the viewer
    // knows, so the viewer must not be spoofable. See docs/trust-profile-and-trade-safety.md
    router.post('/api/trust/profile', async (ctx) => {
        const viewer = ctx.state.actor as string | undefined;
        const { targetPubkey } = (ctx as any).requestBody || {};
        if (!viewer) {
            ctx.status = 401;
            ctx.body = { error: 'A signed request is required' };
            return;
        }
        if (!targetPubkey) {
            ctx.status = 400;
            ctx.body = { error: 'targetPubkey is required' };
            return;
        }
        const profile = getTrustProfileForViewer(viewer, targetPubkey);
        if (!profile) {
            ctx.status = 404;
            ctx.body = { error: 'Member not found' };
            return;
        }
        ctx.body = profile;
    });

    // Elder vouch: the (signed) viewer endorses targetPubkey. Server-authoritative —
    // vouchMember() verifies the actor is an Elder and rejects self-vouch. For a
    // founding member this also lifts their floor-gate; for everyone else it's a badge.
    router.post('/api/profile/vouch', async (ctx) => {
        const elder = ctx.state.actor as string | undefined;
        const { targetPubkey } = (ctx as any).requestBody || {};
        if (!elder) {
            ctx.status = 401;
            ctx.body = { error: 'A signed request is required' };
            return;
        }
        if (!targetPubkey) {
            ctx.status = 400;
            ctx.body = { error: 'targetPubkey is required' };
            return;
        }
        try {
            vouchMember(elder, targetPubkey);
            ctx.body = { success: true };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e?.message || 'Vouch failed' };
        }
    });

    router.post('/api/ledger/transfer', async (ctx) => {
        const { to, amount, memo } = (ctx as any).requestBody || {};
        const from = ctx.state.actor || (ctx as any).requestBody?.from;
        const parsedAmount = Number(amount);
        // SECURITY (SRV-8): require a positive, finite amount at the route. Don't
        // rely solely on transfer()'s internal guard / the transactions CHECK.
        if (!from || !to || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            ctx.status = 400;
            ctx.body = { error: 'from, to, and a positive amount are required' };
            return;
        }

        // A2-18: this public route is member→member only. Reject SYNTHETIC recipients
        // (escrow_/project_/COMMONS_POOL/SYSTEM/genesis). Sending to an escrow_* key
        // here bypassed the Ghost-gift tier gate — transfer() infers isEscrow from a
        // to-prefix — and stranded funds. Real escrow/crowdfund funding is internal
        // (marketplace / pledge routes call transfer with method='escrow'), never here.
        const toStr = String(to);
        if (toStr.startsWith('escrow_') || toStr.startsWith('project_') ||
            toStr === 'COMMONS_POOL' || toStr === 'SYSTEM' || toStr === 'genesis') {
            ctx.status = 400;
            ctx.body = { error: 'Invalid recipient' };
            return;
        }

        // --- FEDERATION VERIFY ---
        try {
            const fromMember = getMember(from);
            if (fromMember && fromMember.homeNodeUrl) {
                const p2pNode = getP2PNode();
                if (p2pNode) {
                    const targetConnector = getConnectorByPublicUrl(fromMember.homeNodeUrl);
                    if (targetConnector && targetConnector.peerId) {
                        const verifyResult = await federatedVerifyMember(p2pNode, targetConnector.peerId, from);
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

        // Peer member→member transfers are fee-exempt — the recipient receives the
        // full amount. (The 1.5% transaction fee still applies to marketplace trade
        // settlements, which are funded via the internal method='escrow' transfers.)
        const txn = transfer(from, to, parsedAmount, memo || '', undefined, true, (ctx.state as any).authSig);
        if (!txn) {
            ctx.status = 400;
            // Direct sends are positive-balance-only and require a first completed trade.
            ctx.body = { error: 'Send failed — you can only send beans you currently hold, and only after your first completed trade.' };
            return;
        }
        ctx.body = { success: true, transaction: txn };
    });

    router.get('/api/ledger/transactions', async (ctx) => {
        const publicKey = ctx.query.publicKey as string | undefined;
        const limit = clampLimit(ctx.query.limit);
        const offset = clampOffset(ctx.query.offset);
        ctx.body = getTransactions(publicKey, limit, offset);
    });

    router.get('/api/ledger/export', async (ctx) => {
        ctx.body = exportLedgerAudit();
    });

    // ===================== MESSAGING API (PUBLIC) =====================

    router.post('/api/messages/conversation', async (ctx) => {
        const { type, participants, createdBy, name, postId } = (ctx as any).requestBody || {};
        if (!type || !participants || !createdBy) {
            ctx.status = 400;
            ctx.body = { error: 'type, participants, and createdBy are required' };
            return;
        }
        if (type === 'dm' && participants.length !== 2) {
            ctx.status = 400;
            ctx.body = { error: 'DM conversations must have exactly 2 participants' };
            return;
        }
        // A2-15: the creator (bound to the verified signer by the spoof check) must
        // be one of the participants. Otherwise a member could fabricate a thread
        // between OTHER people (a DM "between B and C", or a group they aren't in)
        // and inject it into victims' inboxes with an arbitrary name. Enforced at
        // this public route only — internal/system conversation creation
        // (ensureTransactionConversation, injectSystemMessage) calls
        // createConversation directly with a system actor and is unaffected.
        if (!Array.isArray(participants) || !participants.includes(createdBy)) {
            ctx.status = 403;
            ctx.body = { error: 'Creator must be a participant of the conversation' };
            return;
        }
        const conv = createConversation(type, participants, createdBy, name, postId);
        if (!conv) {
            ctx.status = 400;
            ctx.body = { error: 'Failed to create conversation — check all participants are registered' };
            return;
        }
        ctx.body = { success: true, conversation: conv };
    });

    router.post('/api/messages/send', async (ctx) => {
        const { conversationId, authorPubkey, ciphertext, nonce, type, attachment, metadata } = (ctx as any).requestBody || {};
        if (!conversationId || !authorPubkey || !ciphertext || !nonce) {
            ctx.status = 400;
            ctx.body = { error: 'conversationId, authorPubkey, ciphertext, and nonce are required' };
            return;
        }
        const msg = sendMessage(conversationId, authorPubkey, ciphertext, nonce, type === 'image' ? 'image' : 'text', attachment, metadata);
        if (!msg) {
            ctx.status = 400;
            ctx.body = { error: 'Failed to send — conversation not found or not a participant' };
            return;
        }

        // --- FEDERATION RELAY ---
        try {
            const conv = getConversation(conversationId);
            if (conv && conv.type === 'dm') {
                const otherPubkey = conv.participants.find(p => p !== authorPubkey);
                if (otherPubkey) {
                    const otherMember = getMember(otherPubkey);

                    // If the other member has a homeNodeUrl, they are a visitor from a remote node
                    if (otherMember && otherMember.homeNodeUrl) {
                        const p2pNode = getP2PNode();
                        if (p2pNode) {
                            const targetConnector = getConnectorByPublicUrl(otherMember.homeNodeUrl);
                            if (targetConnector && targetConnector.peerId) {
                                const localMember = getMember(authorPubkey);
                                const localConfig = getLocalConfig();
                                const hostname = process.env.CF_RECORD_NAME || (localConfig.communityName ? localConfig.communityName.toLowerCase().replace(/\s+/g, '') + '.beanpool.org' : undefined);
                                const localUrl = hostname ? `https://${hostname}` : undefined;

                                // Fire-and-forget over secure Libp2p mesh
                                federatedRelayMessage(p2pNode, targetConnector.peerId, {
                                    senderPublicKey: authorPubkey,
                                    senderCallsign: localMember?.callsign,
                                    senderNodeUrl: localUrl,
                                    recipientPublicKey: otherPubkey,
                                    ciphertext,
                                    nonce,
                                    metadata
                                }).catch(e => console.warn('[Federation] Failed to relay message to remote peer:', e.message));
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[Federation] Error during message relay:', e);
        }
        // -----------------------

        ctx.body = { success: true, message: msg };
    });

    router.post('/api/messages/edit', async (ctx) => {
        const { messageId, ciphertext, nonce } = (ctx as any).requestBody || {};
        // The author is the verified request signer (ctx.state.actor) — not a client-supplied
        // field — so nobody can edit someone else's message.
        const actor = ctx.state.actor || (ctx as any).requestBody?.authorPubkey;
        if (!messageId || !ciphertext || !nonce || !actor) {
            ctx.status = 400;
            ctx.body = { error: 'messageId, ciphertext, and nonce are required' };
            return;
        }
        try {
            const msg = editMessage(messageId, actor as string, ciphertext, nonce);
            ctx.body = { success: true, message: msg };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to edit message' };
        }
    });

    router.get('/api/messages/conversations/:publicKey', async (ctx) => {
        const { publicKey } = ctx.params;
        // A2-3: this returns the subject's entire conversation graph + unread
        // counts + read cursors. Under read-auth, only the subject may read their
        // own — the verified signer must equal the :publicKey path param (which is
        // otherwise an unchecked IDOR: any member could read anyone's social graph).
        if (ENFORCE_READ_AUTH && ctx.state.actor !== publicKey) {
            ctx.status = 403;
            ctx.body = { error: 'You may only read your own conversations' };
            return;
        }
        const convs = getConversationsByMember(publicKey);
        const unreadCounts = getUnreadCounts(publicKey);
        ctx.body = {
            conversations: convs.map(c => ({ ...c, unreadCount: unreadCounts[c.id] || 0 })),
            totalUnread: Object.values(unreadCounts).reduce((a, b) => a + b, 0),
        };
    });

    router.post('/api/messages/mark-read', async (ctx) => {
        const { pubkey, conversationId } = (ctx as any).requestBody || {};
        if (!pubkey || !conversationId) {
            ctx.status = 400;
            ctx.body = { error: 'Missing pubkey or conversationId' };
            return;
        }
        markConversationRead(pubkey, conversationId);
        ctx.body = { success: true };
    });

    router.get('/api/messages/:conversationId', async (ctx) => {
        const { conversationId } = ctx.params;
        const conv = getConversation(conversationId);
        if (!conv) {
            ctx.status = 404;
            ctx.body = { error: 'Conversation not found' };
            return;
        }
        // A2-2: only a participant may read a conversation's messages + metadata.
        // Under read-auth the signer is a verified member (ctx.state.actor); require
        // it to be in this conversation. Without this, any member could read any
        // thread by id (group/system messages are still plaintext-v1, and
        // participants/reactions/post-linkage/read-cursors leak for every thread).
        if (ENFORCE_READ_AUTH && !conv.participants.includes(ctx.state.actor as string)) {
            ctx.status = 403;
            ctx.body = { error: 'You are not a participant in this conversation' };
            return;
        }
        const limit = clampLimit(ctx.query.limit);
        const offset = clampOffset(ctx.query.offset);
        ctx.body = {
            conversation: conv,
            messages: getConversationMessages(conversationId, limit, offset),
        };
    });

    router.post('/api/messages/react', async (ctx) => {
        const { messageId, authorPubkey, emoji } = (ctx as any).requestBody || {};
        if (!messageId || !authorPubkey || !emoji) {
            ctx.status = 400;
            ctx.body = { error: 'messageId, authorPubkey, and emoji are required' };
            return;
        }
        try {
            const result = toggleMessageReaction(messageId, authorPubkey, emoji);
            if (!result) {
                ctx.status = 404;
                ctx.body = { error: 'Message not found' };
                return;
            }
            ctx.body = { success: true, metadata: result.metadata };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to toggle reaction' };
        }
    });

    // ===================== PUSH NOTIFICATION TOKENS =====================

    router.post('/api/push-tokens', async (ctx) => {
        const { publicKey, token, platform } = (ctx as any).requestBody || {};
        if (!publicKey || !token) {
            ctx.status = 400;
            ctx.body = { error: 'Missing publicKey or token' };
            return;
        }
        const success = registerPushToken(publicKey, token, platform || 'ios');
        ctx.body = { success };
    });

    router.delete('/api/push-tokens', async (ctx) => {
        const { publicKey, token } = (ctx as any).requestBody || {};
        if (!publicKey) {
            ctx.status = 400;
            ctx.body = { error: 'Missing publicKey' };
            return;
        }
        const success = removePushToken(publicKey, token);
        ctx.body = { success };
    });

    // ===================== MEMBER NOTIFICATION PREFERENCES =====================

    router.get('/api/members/preferences', async (ctx) => {
        const publicKey = ctx.query.publicKey as string;
        if (!publicKey) {
            ctx.status = 400;
            ctx.body = { error: 'Missing publicKey' };
            return;
        }
        ctx.body = getMemberPreferences(publicKey);
    });

    router.post('/api/members/preferences', async (ctx) => {
        const { publicKey, preferences } = (ctx as any).requestBody || {};
        if (!publicKey || !preferences) {
            ctx.status = 400;
            ctx.body = { error: 'Missing publicKey or preferences' };
            return;
        }
        const success = setMemberPreferences(publicKey, preferences);
        ctx.body = { success };
    });

    // ===================== MARKETPLACE API (PUBLIC) =====================

    router.get('/api/marketplace/posts/:id/photos/:orderNum', async (ctx) => {
        const { id, orderNum } = ctx.params;
        const photo = db.prepare(`SELECT photo_data FROM post_photos WHERE post_id = ? AND order_num = ?`).get(id, Number(orderNum)) as { photo_data: string } | undefined;
        
        if (!photo) {
            ctx.status = 404;
            ctx.body = { error: 'Photo not found' };
            return;
        }

        // Post photos are immutable per (id, order_num): getPosts versions the URL with the photo's
        // updated_at (?v=…), so an edited photo is served under a NEW url. That lets clients cache
        // the bytes forever — killing the cold-start re-download of every photo — with no staleness.
        ctx.set('Cache-Control', 'public, max-age=31536000, immutable');

        // Parse out data URL if present
        const match = photo.photo_data.match(/^data:([^;]+);base64,(.*)$/);
        if (match) {
            ctx.type = match[1];
            ctx.body = Buffer.from(match[2], 'base64');
        } else {
            ctx.type = 'image/jpeg';
            ctx.body = Buffer.from(photo.photo_data, 'base64');
        }
    });

    // Lazy-load an encrypted message attachment (image). Returns ciphertext only —
    // the node can't read it; the recipient decrypts with the DM key + nonce.
    router.get('/api/messages/:id/attachment', async (ctx) => {
        const { id } = ctx.params;
        const row = db.prepare(`SELECT data, nonce, mime FROM message_attachments WHERE message_id = ?`).get(id) as { data: string; nonce: string; mime: string } | undefined;
        if (!row) {
            ctx.status = 404;
            ctx.body = { error: 'Attachment not found' };
            return;
        }
        ctx.body = { data: row.data, nonce: row.nonce, mime: row.mime || 'image/jpeg' };
    });

    router.get('/api/marketplace/posts', async (ctx) => {
        const type = ctx.query.type as string | undefined;
        const category = ctx.query.category as string | undefined;
        const author = ctx.query.author as string | undefined;
        const q = ctx.query.q as string | undefined;
        const limit = clampLimit(ctx.query.limit);
        const offset = clampOffset(ctx.query.offset);
        const updatedAfter = ctx.query.updatedAfter as string | undefined;
        ctx.body = getPosts({ type, category, query: q, limit, offset, updatedAfter, authorPubkey: author });
    });

    router.post('/api/marketplace/posts', async (ctx) => {
        const { id, type, category, title, description, credits, priceType, authorPublicKey, lat, lng, photos, repeatable } =
            (ctx as any).requestBody || {};
        if (!type || !title || !authorPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'type, title, and authorPublicKey are required' };
            return;
        }
        try {
            const post = createPost(
                type, category || 'other', title, description || '',
                Number(credits) || 0, priceType === 'hourly' ? 'hourly' : 'fixed', (ctx.state.actor as string) || authorPublicKey,
                lat != null ? Number(lat) : undefined,
                lng != null ? Number(lng) : undefined,
                photos,
                repeatable === true || repeatable === 'true',
                id
            );
            if (!post) {
                ctx.status = 400;
                ctx.body = { error: 'Failed — author must be a registered member' };
                return;
            }
            ctx.body = { success: true, post };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to create post' };
        }
    });

    router.post('/api/marketplace/posts/remove', async (ctx) => {
        try {
            const { id, authorPublicKey } = (ctx as any).requestBody || {};
            if (!id || !authorPublicKey) {
                ctx.status = 400;
                ctx.body = { error: 'id and authorPublicKey are required' };
                return;
            }
            const removed = removePost(id, (ctx.state.actor as string) || authorPublicKey);
            ctx.body = { success: removed };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to remove post' };
        }
    });

    router.post('/api/marketplace/posts/update', async (ctx) => {
        try {
            const { id, authorPublicKey, ...updates } = (ctx as any).requestBody || {};
            if (!id || !authorPublicKey) {
                ctx.status = 400;
                ctx.body = { error: 'id and authorPublicKey are required' };
                return;
            }
            const post = updatePost(id, (ctx.state.actor as string) || authorPublicKey, updates);
            if (!post) {
                ctx.status = 404;
                ctx.body = { error: 'Post not found or not owned by you' };
                return;
            }
            ctx.body = { success: true, post };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to update post' };
        }
    });

    // ===================== MARKETPLACE TRANSACTIONS =====================

    router.post('/api/marketplace/posts/accept', async (ctx) => {
        try {
            const { postId, buyerPublicKey, hours } = (ctx as any).requestBody || {};
            if (!postId || !buyerPublicKey) {
                ctx.status = 400;
                ctx.body = { error: 'postId and buyerPublicKey are required' };
                return;
            }
            const parsedHours = hours != null ? Number(hours) : undefined;
            const tx = acceptPost(postId, (ctx.state.actor as string) || buyerPublicKey, parsedHours);
            ctx.body = { success: true, transaction: tx };
        } catch (err: any) {
            ctx.status = 400;
            ctx.body = { error: err.message };
        }
    });

    router.post('/api/marketplace/posts/request', async (ctx) => {
        try {
            const { postId, buyerPublicKey, hours } = (ctx as any).requestBody || {};
            if (!postId || !buyerPublicKey) {
                ctx.status = 400;
                ctx.body = { error: 'postId and buyerPublicKey are required' };
                return;
            }
            const parsedHours = hours != null ? Number(hours) : undefined;
            const tx = requestPost(postId, (ctx.state.actor as string) || buyerPublicKey, parsedHours);
            if (!tx) throw new Error('Cannot request — post not found or unauthorized');
            ctx.body = { success: true, transaction: tx };
        } catch (err: any) {
            ctx.status = 400;
            ctx.body = { error: err.message };
        }
    });

    router.post('/api/marketplace/transactions/approve', async (ctx) => {
        try {
            const { transactionId, authorPublicKey } = (ctx as any).requestBody || {};
            if (!transactionId || !authorPublicKey) {
                ctx.status = 400;
                ctx.body = { error: 'transactionId and authorPublicKey are required' };
                return;
            }
            const tx = approvePostRequest(transactionId, (ctx.state.actor as string) || authorPublicKey);
            ctx.body = { success: true, transaction: tx };
        } catch (err: any) {
            ctx.status = 400;
            ctx.body = { error: err.message };
        }
    });

    router.post('/api/marketplace/transactions/reject', async (ctx) => {
        const { transactionId, authorPublicKey } = (ctx as any).requestBody || {};
        if (!transactionId || !authorPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'transactionId and authorPublicKey are required' };
            return;
        }
        const tx = rejectPostRequest(transactionId, (ctx.state.actor as string) || authorPublicKey);
        if (!tx) {
            ctx.status = 400;
            ctx.body = { error: 'Cannot reject — request not found or unauthorized' };
            return;
        }
        ctx.body = { success: true, transaction: tx };
    });

    router.post('/api/marketplace/transactions/cancel-request', async (ctx) => {
        const { transactionId, buyerPublicKey } = (ctx as any).requestBody || {};
        if (!transactionId || !buyerPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'transactionId and buyerPublicKey are required' };
            return;
        }
        const tx = cancelPostRequest(transactionId, (ctx.state.actor as string) || buyerPublicKey);
        if (!tx) {
            ctx.status = 400;
            ctx.body = { error: 'Cannot cancel — request not found or unauthorized' };
            return;
        }
        ctx.body = { success: true, transaction: tx };
    });

    router.post('/api/marketplace/transactions/complete', async (ctx) => {
        const { transactionId, confirmerPublicKey, finalHours } = (ctx as any).requestBody || {};
        if (!transactionId || !confirmerPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'transactionId and confirmerPublicKey are required' };
            return;
        }
        const parsedFinalHours = finalHours != null ? Number(finalHours) : undefined;
        try {
            const tx = completePostTransaction(transactionId, (ctx.state.actor as string) || confirmerPublicKey, parsedFinalHours);
            if (!tx) {
                ctx.status = 400;
                ctx.body = { error: 'Cannot complete — transaction not found or not authorized' };
                return;
            }
            ctx.body = { success: true, transaction: tx, alreadyCompleted: !!(tx as any).alreadyCompleted };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Escrow release failed' };
        }
    });

    router.post('/api/marketplace/transactions/cancel', async (ctx) => {
        const { transactionId, cancellerPublicKey } = (ctx as any).requestBody || {};
        if (!transactionId || !cancellerPublicKey) {
            ctx.status = 400;
            ctx.body = { error: 'transactionId and cancellerPublicKey are required' };
            return;
        }
        const tx = cancelPostTransaction(transactionId, (ctx.state.actor as string) || cancellerPublicKey);
        if (!tx) {
            ctx.status = 400;
            ctx.body = { error: 'Cannot cancel — transaction not found or not authorized' };
            return;
        }
        ctx.body = { success: true, transaction: tx };
    });

    router.post('/api/marketplace/posts/pause', async (ctx) => {
        try {
            const { postId, authorPublicKey } = (ctx as any).requestBody || {};
            if (!postId || !authorPublicKey) {
                ctx.status = 400;
                ctx.body = { error: 'postId and authorPublicKey are required' };
                return;
            }
            const success = pausePost(postId, (ctx.state.actor as string) || authorPublicKey);
            ctx.body = { success };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to pause post' };
        }
    });

    router.post('/api/marketplace/posts/resume', async (ctx) => {
        try {
            const { postId, authorPublicKey } = (ctx as any).requestBody || {};
            if (!postId || !authorPublicKey) {
                ctx.status = 400;
                ctx.body = { error: 'postId and authorPublicKey are required' };
                return;
            }
            const success = resumePost(postId, (ctx.state.actor as string) || authorPublicKey);
            ctx.body = { success };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to resume post' };
        }
    });

    router.get('/api/marketplace/transactions', async (ctx) => {
        const publicKey = ctx.query.publicKey as string;
        const status = ctx.query.status as string | undefined;
        if (!publicKey) {
            ctx.status = 400;
            ctx.body = { error: 'publicKey query parameter is required' };
            return;
        }
        const limit = clampLimit(ctx.query.limit);
        const offset = clampOffset(ctx.query.offset);
        ctx.body = getMarketplaceTransactions(publicKey, status ? { status } : undefined, limit, offset);
    });

    // ===================== RATINGS =====================

    router.post('/api/ratings', async (ctx) => {
        try {
        const { raterPubkey, targetPubkey, stars, comment, transactionId } = (ctx as any).requestBody || {};
        if (!raterPubkey || !targetPubkey || !stars || !transactionId) {
            ctx.status = 400;
            ctx.body = { error: 'raterPubkey, targetPubkey, stars, and transactionId are required' };
            return;
        }
        const rating = addRating(raterPubkey, targetPubkey, Number(stars), comment || '', transactionId);
        if (!rating) {
            ctx.status = 400;
            ctx.body = { error: 'Failed — transaction must be completed, both users must be participants' };
            return;
        }
        ctx.body = { success: true, rating };
        } catch (err: any) {
            console.error('❌ Server Error adding rating:', err);
            ctx.status = 500;
            ctx.body = { error: err.message };
        }
    });

    router.get('/api/ratings/:publicKey', async (ctx) => {
        const { publicKey } = ctx.params;
        const { direction } = ctx.query;
        if (direction === 'given') {
            const memberRatings = getRatingsGiven(publicKey);
            ctx.body = { ratings: memberRatings };
        } else {
            const memberRatings = getRatings(publicKey);
            const average = getAverageRating(publicKey);
            ctx.body = { ratings: memberRatings, ...average };
        }
    });

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

    // ===================== NODE CONFIG =====================

    router.get('/api/node/config', async (ctx) => {
        ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        ctx.body = getNodeConfig();
    });

    router.post('/api/local/admin/node/config', async (ctx) => {
        console.log("updateNodeConfig hit!", (ctx as any).requestBody);
        if (!(await checkAdminAuth(ctx as any))) {
            console.log("Auth failed for updateNodeConfig");
            return;
        }
        const { publishLocation, publishMembers, publishContacts, publishHealth, serviceRadius, directoryPushIntervalHours } = (ctx as any).requestBody || {};
        console.log("Updating node config:", { publishLocation, publishMembers, publishContacts, publishHealth, serviceRadius, directoryPushIntervalHours });
        ctx.body = updateNodeConfig({ publishLocation, publishMembers, publishContacts, publishHealth, serviceRadius, directoryPushIntervalHours });
        
        // Re-initialize the publisher with the new interval
        if (directoryPushIntervalHours !== undefined) {
            initDirectoryPublisher();
        }
    });

    router.post('/api/local/admin/directory/push', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) {
            ctx.status = 401;
            return;
        }
        ctx.body = await pushDirectoryNow();
    });

    // Local directory info endpoint (used by settings preview)
    // No CORS headers - should only be called from same origin (admin PWA)
    router.get('/api/directory/info', async (ctx) => {
        const info = getDirectoryInfo();
        if (!info) {
            ctx.status = 403;
            ctx.body = { error: 'This node has opted out of the directory' };
            return;
        }
        ctx.body = info;
    });

    // ===================== ABUSE REPORTS =====================

    router.post('/api/reports', async (ctx) => {
        const { reporterPubkey, targetPubkey, reason, targetPostId } = (ctx as any).requestBody || {};
        if (!reporterPubkey || !targetPubkey || !reason) {
            ctx.status = 400;
            ctx.body = { error: 'reporterPubkey, targetPubkey, and reason are required' };
            return;
        }
        const report = submitReport(reporterPubkey, targetPubkey, reason, targetPostId);
        if (!report) {
            ctx.status = 400;
            ctx.body = { error: 'Failed — must be a registered member, cannot report yourself' };
            return;
        }
        ctx.body = { success: true, report };
    });

    // ======================== FRIENDS ========================

    router.get('/api/friends/:publicKey', async (ctx) => {
        const pubkey = ctx.params.publicKey;
        ctx.body = getFriends(pubkey);
    });

    router.post('/api/friends/add', async (ctx) => {
        const { ownerPubkey, friendPubkey } = (ctx as any).requestBody || {};
        if (!ownerPubkey || !friendPubkey) {
            ctx.status = 400;
            ctx.body = { error: 'ownerPubkey and friendPubkey are required' };
            return;
        }
        const entry = addFriend(ownerPubkey, friendPubkey);
        if (!entry) {
            ctx.status = 400;
            ctx.body = { error: 'Failed — both must be registered members' };
            return;
        }
        ctx.body = { success: true, friend: entry };
    });

    router.post('/api/friends/remove', async (ctx) => {
        const { ownerPubkey, friendPubkey } = (ctx as any).requestBody || {};
        if (!ownerPubkey || !friendPubkey) {
            ctx.status = 400;
            ctx.body = { error: 'ownerPubkey and friendPubkey are required' };
            return;
        }
        const ok = removeFriend(ownerPubkey, friendPubkey);
        ctx.body = { success: ok };
    });

    router.post('/api/friends/guardian', async (ctx) => {
        const ownerPubkey = ctx.request.header['x-public-key'] as string;
        const body = (ctx as any).requestBody;
        if (!body || !body.friendPubkey || typeof body.isGuardian !== 'boolean') {
            ctx.status = 400; ctx.body = { error: 'Invalid payload' }; return;
        }

        const success = setGuardian(ownerPubkey, body.friendPubkey, body.isGuardian);
        if (success) {
            ctx.status = 200; ctx.body = { success: true };
        } else {
            ctx.status = 400; ctx.body = { error: 'Could not set guardian status' };
        }
    });

    // ======================== SOCIAL RECOVERY ========================

    // 1. Lookup identities by callsign (Public, but we rate limit it in practice, handled loosely here)
    router.get('/api/recovery/lookup/:callsign', async (ctx) => {
        if (!rateLimit(ctx)) return; // SRV-4: throttle callsign enumeration
        const callsign = ctx.params.callsign.trim().toLowerCase();
        if (!callsign) { ctx.status = 400; ctx.body = { error: 'Missing callsign' }; return; }

        // ⚡ Push the "≥3 guardians" filter into SQL instead of calling getGuardiansOf()
        // once per matched row (N+1 queries on a public, rate-limited lookup endpoint).
        const eligible = db.prepare(`
            SELECT public_key, callsign, joined_at, avatar_url
            FROM members
            WHERE LOWER(callsign) = ? AND status != 'migrated'
              AND (SELECT COUNT(*) FROM friends WHERE owner_pubkey = members.public_key AND is_guardian = 1) >= 3
        `).all(callsign) as any[];
        
        ctx.status = 200;
        ctx.body = eligible.map(r => ({
            publicKey: r.public_key,
            callsign: r.callsign,
            joinedAt: r.joined_at,
            avatarUrl: r.avatar_url
        }));
    });

    // 2. Submit a recovery request (Signed by NEW pubkey)
    router.post('/api/recovery/request', async (ctx) => {
        if (!rateLimit(ctx)) return; // SRV-4: throttle recovery-request spam / guardian-guessing
        const newPubkey = ctx.request.header['x-public-key'] as string;
        const body = (ctx as any).requestBody;
        
        if (!body || !body.oldPubkey || !body.guardianGuess) {
            ctx.status = 400; ctx.body = { error: 'Missing oldPubkey or guardianGuess' }; return;
        }

        try {
            const req = createRecoveryRequest(body.oldPubkey, newPubkey, body.guardianGuess);
            
            // Push notification to guardians
            // Disabled push notifications to prevent complacent approvals without offline verification.
            // Guardians must be actively contacted by the recovering user.
            /*
            const guardians = getGuardiansOf(body.oldPubkey);
            const targetMember = getMember(body.oldPubkey);
            if (targetMember) {
                dispatchPushNotification(
                    guardians,
                    body.oldPubkey, // actor
                    '🛡️ Recovery Request',
                    `${targetMember.callsign} is requesting identity recovery. Open BeanPool to review.`,
                    { screen: 'settings' }, // data payload
                    'escrow' // closest matching notification category
                );
            }
            */

            ctx.status = 200;
            ctx.body = req;
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message };
        }
    });

    // 3. Get pending requests for a guardian
    router.get('/api/recovery/pending/:guardianPubkey', async (ctx) => {
        if (!rateLimit(ctx)) return;
        const guardianPubkey = ctx.params.guardianPubkey;
        // A2-16: under ENFORCE_READ_AUTH this route is gated, so ctx.state.actor is the
        // CRYPTOGRAPHICALLY VERIFIED signer — require it to be the guardian. The
        // x-public-key header check below is non-authenticating (a caller just sets it
        // to the value being queried); it remains only as the flag-off fallback. Full
        // fix is a guardian-signed-proof recovery flow (tracked).
        if (ENFORCE_READ_AUTH) {
            if (ctx.state.actor !== guardianPubkey) {
                ctx.status = 403; ctx.body = { error: 'Unauthorized' }; return;
            }
        } else if (ctx.request.header['x-public-key'] !== guardianPubkey) {
            ctx.status = 403; ctx.body = { error: 'Unauthorized' }; return;
        }
        try {
            const reqs = getPendingRecoveryRequests(guardianPubkey);
            ctx.status = 200;
            ctx.body = reqs;
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message };
        }
    });

    // 4. Approve recovery
    router.post('/api/recovery/approve', async (ctx) => {
        const guardianPubkey = ctx.request.header['x-public-key'] as string;
        const body = (ctx as any).requestBody;
        if (!body || !body.requestId) { ctx.status = 400; ctx.body = { error: 'Missing requestId' }; return; }

        try {
            approveRecovery(body.requestId, guardianPubkey);
            ctx.status = 200; ctx.body = { success: true };
        } catch (e: any) {
            ctx.status = 400; ctx.body = { error: e.message };
        }
    });

    // 5. Reject recovery
    router.post('/api/recovery/reject', async (ctx) => {
        const guardianPubkey = ctx.request.header['x-public-key'] as string;
        const body = (ctx as any).requestBody;
        if (!body || !body.requestId) { ctx.status = 400; ctx.body = { error: 'Missing requestId' }; return; }

        try {
            rejectRecovery(body.requestId, guardianPubkey);
            ctx.status = 200; ctx.body = { success: true };
        } catch (e: any) {
            ctx.status = 400; ctx.body = { error: e.message };
        }
    });

    // 6. Check recovery status
    router.get('/api/recovery/status/:pubkey', async (ctx) => {
        if (!rateLimit(ctx)) return;
        const pubkey = ctx.params.pubkey;
        const status = getRecoveryStatus(pubkey);
        ctx.status = 200;
        ctx.body = status || { status: 'none' };
    });

    // 7. Cancel recovery
    router.post('/api/recovery/cancel', async (ctx) => {
        const cancellerPubkey = ctx.request.header['x-public-key'] as string;
        const body = (ctx as any).requestBody;
        if (!body || !body.requestId) { ctx.status = 400; ctx.body = { error: 'Missing requestId' }; return; }

        try {
            cancelRecovery(body.requestId, cancellerPubkey);
            ctx.status = 200; ctx.body = { success: true };
        } catch (e: any) {
            ctx.status = 400; ctx.body = { error: e.message };
        }
    });

    // ======================== MEMBERS LIST ========================

    router.get('/api/members', async (ctx) => {
        // Use getMembers() (excludes pruned) so the directory matches the count reported by
        // /api/community/info — otherwise clients keep pruned members locally and read as
        // permanently "out of sync" against the node's pruned-excluding member count.
        let allMembers = getMembers()
            .filter(m => !m.publicKey.startsWith('escrow_') && !m.publicKey.startsWith('project_'));

        // Incremental delta: when the client passes ?updatedAfter=<ISO>, return only members
        // who joined or changed their profile (avatar/callsign/bio) since that cursor. This lets
        // the client pick up new members and avatar changes every sync cycle instead of waiting
        // for the hourly full-directory snapshot. No param => full directory (unchanged behaviour).
        const updatedAfter = ctx.query.updatedAfter as string | undefined;
        if (updatedAfter) {
            allMembers = allMembers.filter(m =>
                (m.joinedAt && m.joinedAt > updatedAfter) ||
                (m.profileUpdatedAt != null && String(m.profileUpdatedAt) > updatedAfter)
            );
        }

        ctx.body = allMembers.map(m => ({
            publicKey: m.publicKey,
            callsign: m.callsign,
            joinedAt: m.joinedAt,
            avatarUrl: m.avatarUrl,
            profileUpdatedAt: m.profileUpdatedAt,
            earnedCredit: m.earnedCredit ?? 0,
            elderVouchedBy: m.elderVouchedBy || null,
        }));
    });

    router.post('/api/admin/reports', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        ctx.body = { reports: getReports() };
    });

    // ===================== VERSION & UPDATES =====================

    // Read version from root package.json
    function getVersion(): string {
        // Priority: APP_VERSION env (from Docker build arg) > .version file > package.json
        if (process.env.APP_VERSION) return process.env.APP_VERSION;
        try {
            const versionFile = path.resolve('/app/.version');
            if (fs.existsSync(versionFile)) {
                return fs.readFileSync(versionFile, 'utf-8').trim();
            }
        } catch { /* fall through */ }
        try {
            let pkgPath = path.resolve('package.json');
            if (!fs.existsSync(pkgPath)) {
                pkgPath = path.resolve('../../package.json');
            }
            const rootPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            return rootPkg.version || '0.0.0';
        } catch { return '0.0.0'; }
    }

    // Get git commit hash
    function getCommitHash(): string {
        try {
            return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        } catch { return 'unknown'; }
    }

    // ===================== BACKGROUND UPDATE CHECKER =====================
    let cachedUpdateInfo: {
        updateAvailable: boolean;
        latestVersion: string;
        releaseNotes: string;
        releaseUrl: string;
        publishedAt: string;
        lastChecked: string;
    } | null = null;

    async function backgroundUpdateCheck() {
        try {
            const response = await fetch(
                'https://api.github.com/repos/beanpool-org/beanpool/releases/latest',
                { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
            );
            if (response.ok) {
                const release = await response.json() as any;
                const latestVersion = (release.tag_name || '').replace(/^v/, '');
                const currentVersion = getVersion();
                cachedUpdateInfo = {
                    updateAvailable: semverGreater(latestVersion, currentVersion),
                    latestVersion,
                    releaseNotes: release.body || '',
                    releaseUrl: release.html_url || '',
                    publishedAt: release.published_at || '',
                    lastChecked: new Date().toISOString(),
                };
            } else {
                // Fallback to tags
                const tagsResponse = await fetch(
                    'https://api.github.com/repos/beanpool-org/beanpool/tags?per_page=1',
                    { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
                );
                if (tagsResponse.ok) {
                    const tags = await tagsResponse.json() as any[];
                    const latestTag = tags[0]?.name?.replace(/^v/, '') || '';
                    const currentVersion = getVersion();
                    cachedUpdateInfo = {
                        updateAvailable: semverGreater(latestTag, currentVersion),
                        latestVersion: latestTag,
                        releaseNotes: '',
                        releaseUrl: '',
                        publishedAt: '',
                        lastChecked: new Date().toISOString(),
                    };
                }
            }
            if (cachedUpdateInfo?.updateAvailable) {
                console.log(`[Update] New version available: v${cachedUpdateInfo.latestVersion} (current: v${getVersion()})`);
            }
        } catch (e: any) {
            console.log(`[Update] Background check failed: ${e.message || 'unknown error'}`);
        }
    }

    // Run initial check after 30s startup delay, then every 6 hours
    setTimeout(() => backgroundUpdateCheck(), 30000);
    setInterval(() => backgroundUpdateCheck(), 6 * 60 * 60 * 1000);

    router.get('/api/version', (ctx) => {
        ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        ctx.body = {
            version: getVersion(),
            commit: getCommitHash(),
            buildTime: new Date().toISOString(),
            node: process.env.CF_RECORD_NAME || 'local',
            // Include cached update info if available
            ...(cachedUpdateInfo ? {
                updateAvailable: cachedUpdateInfo.updateAvailable,
                latestVersion: cachedUpdateInfo.latestVersion,
                lastUpdateCheck: cachedUpdateInfo.lastChecked,
            } : {}),
        };
    });

    // ===================== THRESHOLDS API =====================

    router.post('/api/admin/thresholds', async (ctx) => {
        const config = getLocalConfig();
        const { password, ...updates } = (ctx as any).requestBody || {};
        if (!password || !config.adminHash || !config.salt ||
            !verifyPassword(password, config.adminHash, config.salt)) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid password' };
            return;
        }
        // Only allow known threshold keys
        const allowed = Object.keys(DEFAULT_THRESHOLDS);
        const filtered: Record<string, number> = {};
        for (const [k, v] of Object.entries(updates)) {
            if (allowed.includes(k) && typeof v === 'number') {
                filtered[k] = v;
            }
        }
        const result = updateThresholds(filtered);
        ctx.body = { thresholds: result };
    });

    router.post('/api/admin/thresholds/get', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        ctx.body = { thresholds: getThresholds(), defaults: DEFAULT_THRESHOLDS };
    });

    function semverGreater(a: string, b: string): boolean {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) > (pb[i] || 0)) return true;
            if ((pa[i] || 0) < (pb[i] || 0)) return false;
        }
        return false;
    }

    router.post('/api/admin/check-update', async (ctx) => {
        const config = getLocalConfig();
        const { password } = (ctx as any).requestBody || {};
        if (!password || !config.adminHash || !config.salt ||
            !verifyPassword(password, config.adminHash, config.salt)) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid password' };
            return;
        }
        try {
            const response = await fetch(
                'https://api.github.com/repos/beanpool-org/beanpool/releases/latest',
                { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
            );
            if (response.ok) {
                const release = await response.json() as any;
                const latestVersion = (release.tag_name || '').replace(/^v/, '');
                const currentVersion = getVersion();
                const isNewer = semverGreater(latestVersion, currentVersion);
                ctx.body = {
                    currentVersion,
                    latestVersion,
                    updateAvailable: isNewer,
                    releaseUrl: release.html_url || '',
                    releaseNotes: release.body || '',
                    publishedAt: release.published_at || '',
                };
            } else {
                // No releases yet — check tags instead
                const tagsResponse = await fetch(
                    'https://api.github.com/repos/beanpool-org/beanpool/tags?per_page=1',
                    { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
                );
                if (tagsResponse.ok) {
                    const tags = await tagsResponse.json() as any[];
                    const latestTag = tags[0]?.name?.replace(/^v/, '') || '';
                    const currentVersion = getVersion();
                    ctx.body = {
                        currentVersion,
                        latestVersion: latestTag,
                        updateAvailable: semverGreater(latestTag, currentVersion),
                        releaseUrl: '',
                        releaseNotes: '',
                        publishedAt: '',
                    };
                } else {
                    ctx.body = {
                        currentVersion: getVersion(),
                        latestVersion: '',
                        updateAvailable: false,
                        error: 'Could not reach GitHub',
                    };
                }
            }
        } catch (e: any) {
            ctx.body = {
                currentVersion: getVersion(),
                latestVersion: '',
                updateAvailable: false,
                error: e.message || 'Failed to check',
            };
        }
    });

    // NOTE: /api/admin/update (signal-file approach) has been removed.
    // Updates are notification-only — admin runs `docker compose pull && docker compose up -d` manually.

    // ===================== MIDDLEWARE =====================

    // Serve PWA at /app
    router.get('/app', async (ctx) => {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        if (fs.existsSync(indexPath)) {
            ctx.type = 'html';
            ctx.body = fs.createReadStream(indexPath);
        }
    });

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
