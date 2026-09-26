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
import type { AddressInfo } from 'node:net';
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
    getGatewayConfig, isBreakGlassMode,
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
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { checkAdminAuth, isValidWsTicket } from './admin-auth.js';
import os from 'node:os';
import { logger, addLogClient, removeLogClient, logClients } from './logger.js';
import {
    registerMember, getMembers, getAllMembers, isNodeMember, isLiveMemberKey, isInvalidatedKey,
    getBalance, transfer, getTransactions,
    createPost, getPosts, removePost, updatePost,
    acceptPost, completePostTransaction, cancelPostTransaction,
    pausePost, resumePost, getMarketplaceTransactions,
    requestPost, approvePostRequest, rejectPostRequest, cancelPostRequest,
    getCommunityInfo, addWsClient, removeWsClient, broadcast,
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
    getFriends, addFriend, removeFriend,
    adminSetUserStatus, adminSetCreditFrozen, adminSetElder, adminSetVoucher, adminSetTier, adminDeletePost, adminPruneUser, adminBulkDeletePosts,
    adminPruneBranch, adminBroadcastAnnouncement, adminSendMessage,
    recordActivity,
    markConversationRead, getUnreadCounts,
    createProject, updateProject, deleteProject,
    getProjects, getAllProjects, getCommonsBalance,
    adminRejectProject,
    getNodeConfig, updateNodeConfig, getDirectoryInfo, exportLedgerAudit,
    exportSyncState, getNodeRole,
    recordReplicationAccess, getReplicationAccessLog,
    registerPushToken, removePushToken,
    getMemberPreferences, setMemberPreferences, setHolidayMode,
    getMemberStats,
    dispatchPushNotification
} from './state-engine.js';
import { getCrowdfundProjects, getCrowdfundProject, createCrowdfundProject, updateCrowdfundProject, pledgeToProject, deleteCrowdfundProject, db, getDbDataVersion } from './db/db.js';
import { initDirectoryPublisher, pushDirectoryNow } from './services/directory-publisher.js';
import { getBackupStatus, requestResync } from './services/backup-puller.js';
import {
    writeDbSnapshot, createSnapshot, listSnapshots, resolveSnapshotPath,
    getAutoSnapshotConfig, updateAutoSnapshotConfig,
} from './services/snapshot-scheduler.js';

import { PROTOCOL_CONSTANTS } from '@beanpool/core';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = fs.existsSync(path.resolve('public')) ? path.resolve('public') : path.join(SERVER_ROOT, 'public');

// Route modules
import { createSettingsRoutes } from './routes/settings.js';
import { createCommunityRoutes } from './routes/community.js';
import { createAdminRoutes } from './routes/admin.js';
import { createBackupRoutes } from './routes/backup.js';
import { createTakeoverEnvelopeRoutes } from './routes/takeover-envelope.js';
import { identityReadOnlyGuard } from './services/identity-epoch.js';
import { createOwnerWordsCheckRoutes } from './routes/owner-words-check.js';
import { createOwnerUnlockRoutes } from './routes/owner-unlock.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { createEventsRoutes } from './routes/events.js';
import { createGroupRoutes } from './routes/groups.js';
import { createFederationPurchaseRoutes } from './routes/federation-purchase.js';
import { createFederationCommissionRoutes } from './routes/federation-commission.js';
import { createMessagingRoutes } from './routes/messaging.js';
import { createCommonsRoutes } from './routes/commons.js';
import { createTreasuryRoutes } from './routes/treasury.js';
import { profileFeatureGate, featureOffFor } from './routes/profile-feature-gate.js';
import { getProfileSwitches } from './config/node-profile.js';
import { createPublicAddressRoutes } from './routes/public-address.js';
import { createManagerBackupsRoutes } from './routes/manager-backups.js';
import { createAppleProbeRoutes } from './routes/apple-probe.js';
import { createAppleReturnRoutes } from './routes/apple-return.js';
import { isDocumentPolicyFile, isNonCanonicalSpelling, useAppDocumentPolicy, useDocumentPolicy } from './app-document-csp.js';
import { createKeeperRoutes } from './routes/keepers.js';
import { createOpenJoinRoutes } from './routes/open-join.js';
import { createGlobalDirectoryRoutes } from './routes/global-directory.js';
import { createKnockRoutes } from './routes/knocks.js';
import { startTidyingKnocks } from './engine/knocks.js';
import { startForgettingJoinAddresses } from './engine/open-join.js';
import { createChannelRoutes } from './routes/channels.js';
import { createNodeAdminRoutes } from './routes/node-admin.js';
import { createSettingsSigninRoutes } from './routes/settings-signin.js';
import { createRecoveryCollectRoutes } from './routes/recovery-collect.js';
import { createPairingRoutes } from './routes/pairing.js';
import { createPricingGuideRoutes } from './routes/pricing-guide.js';
import { createActivityRouter } from './routes/activity.js';
import { createPulseRoutes } from './routes/pulse.js';
import { createPulseSubmitRoutes } from './routes/pulse-submit.js';
import { createAvatarRoutes } from './routes/avatar.js';
import { startPulseScheduler } from './engine/pulse-resolver.js';
import { startPricingAggregatorWorker } from './pricing-aggregator.js';
import type { RouteDeps } from './routes/types.js';
import { authRateLimit as rateLimit, pruneAuthAttempts } from './auth-rate-limit.js';
import { pruneGithubPolls } from './github-poll-rate-limit.js';
import { pruneChatLines } from './chat-rate-limit.js';
import { clientIp, clientLimiterKey, limiterKeyForIp, resolveClientIp } from './client-ip.js';
import { acquirePasswordAttempt, settlePasswordAttempt, twoFactorOn } from './password-brake.js';
import { gatewayAdmit, gatewayAdmitMember, gatewaySettle, pruneGatewayBuckets } from './gateway-rate-limit.js';


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
// member. ON by default, so a freshly downloaded node refuses private reads to
// strangers with no configuration; an operator opts out only with the exact
// value ENFORCE_READ_AUTH=false (unset, empty or anything else means ON). Apps
// that predate signed reads get 401 on gated reads until they update.
const ENFORCE_READ_AUTH = process.env.ENFORCE_READ_AUTH !== 'false';

// SRV-4 (WebSocket feed): the /ws live-state feed used to stream every state change — message
// notices, trades and amounts, private threads — to anyone who could reach the node. A connect
// token is a fresh, single-use member signature (the replay-proof scheme of HTTP, with method=WS
// and an empty body), and every app version ever shipped sends one whenever it has an identity
// (native since v1.1.56, the PWA since the first public release). Three modes:
//   - default (unset, empty or any other value): a member-signed socket gets the full feed, as
//     before. An unsigned socket, or one signed by a key that is not (yet) a member, is accepted
//     but gets only a bare doorbell for public changes (PUBLIC_WS_EVENTS in state-engine.ts) — the
//     same things anyone can already read without signing. A signature that is forged, stale or
//     replayed is refused with 401.
//   - ENFORCE_WS_AUTH=true: only member-signed sockets are accepted; everything else gets 401.
//   - ENFORCE_WS_AUTH=false: the old open feed — every socket gets every community-wide event.
//     An escape hatch, not a recommendation.
// Safe by default, so a freshly downloaded node never streams member activity to strangers.
export type WsAuthMode = 'members' | 'strict' | 'open';
const WS_AUTH_MODE: WsAuthMode =
    process.env.ENFORCE_WS_AUTH === 'true' ? 'strict'
        : process.env.ENFORCE_WS_AUTH === 'false' ? 'open'
            : 'members';

type WsConnectResult =
    | { kind: 'unsigned' }
    | { kind: 'invalid' }
    | { kind: 'member'; pubkey: string }
    | { kind: 'non_member'; pubkey: string };

/**
 * SRV-4: verify the signed connect token on a /ws upgrade. The client signs
 * `WS\n<path>\n<ts>\n<nonce>\n` (replay-proof scheme, method=WS, empty body) and
 * passes pubkey/ts/nonce/sig as query params. `unsigned` when none of them is
 * present; `invalid` for a partial, stale, replayed or forged token; otherwise
 * whether the proven key belongs to a known member.
 */
function verifyWsConnect(pathname: string, params: URLSearchParams): WsConnectResult {
    const pubKeyHex = params.get('pubkey');
    const sigB64 = params.get('sig');
    const ts = params.get('ts');
    const nonce = params.get('nonce');
    if (!pubKeyHex && !sigB64 && !ts && !nonce) return { kind: 'unsigned' };
    if (!pubKeyHex || !sigB64 || !ts || !nonce) return { kind: 'invalid' };
    try {
        const tsNum = Number(ts);
        const now = Date.now();
        if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > SIGNATURE_FRESHNESS_MS) return { kind: 'invalid' };

        const signedMessage = `WS\n${pathname}\n${ts}\n${nonce}\n`;
        const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
        const spki = Buffer.concat([spkiHeader, Buffer.from(pubKeyHex, 'hex')]);
        const publicKeyObject = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
        const isValid = crypto.verify(
            undefined, Buffer.from(signedMessage), publicKeyObject, Buffer.from(sigB64, 'base64'),
        );
        if (!isValid) return { kind: 'invalid' };
        // Atomic check-and-consume — a replayed connect nonce is rejected. Only after the signature
        // checks out, so a forged token cannot burn (or fill the cache with) nonces it does not own.
        if (!consumeNonce(nonce, now)) return { kind: 'invalid' };

        // A valid signature only proves key possession — only a member (isNodeMember, the test every
        // member-only read applies) gets the member feed, so an anonymous keypair can't subscribe to it.
        // A pruned account, and the old key of a member being re-keyed, keep their row and can still
        // sign, but neither is a member: its socket gets what a stranger's gets, as an open one does once
        // that happens (state-engine deliverBroadcast).
        return isNodeMember(pubKeyHex)
            ? { kind: 'member', pubkey: pubKeyHex }
            : { kind: 'non_member', pubkey: pubKeyHex.toLowerCase() };
    } catch {
        return { kind: 'invalid' };
    }
}

// Reads that stay public even under enforcement. Deny-by-default: anything NOT
// listed here is gated, so a newly-added sensitive endpoint fails safe.
// Deliberately NOT here: /api/activity/feed. It names both members of every completed trade, the
// listing and the Beans, plus each member who joins, so it is readable by members only (2026-09-18).
//   - discovery / federation: a peer or prospective member must read these
//     before it has (or to decide whether to join with) an identity.
//   - onboarding / recovery: a not-yet-joined or recovering user has no member
//     identity to sign as.
//   - binary assets fetched by <img>/streamed: a browser image/attachment
//     request cannot carry signature headers. Message attachments are E2E
//     ciphertext (NAT-1), so serving them unauthenticated leaks no plaintext.
//     (A token-in-URL scheme for these is tracked as follow-up.)
export const PUBLIC_READ_EXACT: ReadonlySet<string> = new Set<string>([
    '/api/version',
    '/api/community/info',
    '/api/community/health',
    '/api/node/config',
    '/api/directory/info',
    '/api/commons/balance',          // community transparency (single aggregate)
    '/api/commons/projects',         // community transparency
    '/api/crowdfund/projects',       // public crowdfund list
    '/api/treasuries',               // community transparency: list of treasuries
    '/api/enterprises',              // community transparency: list of enterprises
    '/api/enterprises/map',          // map pins: enterprises with a location
    '/api/map/enterprises',          // map pins: alias
    '/api/treasuries/map',           // map pins: alias
    '/api/commons/decisions',        // governance transparency: list of decisions
    '/api/invite/check',             // onboarding: pre-membership invite pre-flight (rate-limited)
    '/api/attest',                   // registrar attestation: signed proof this node holds its identity
    '/api/marketplace/posts',        // marketplace board (reach is a discovery filter, not access control)
    '/api/federation/reachable-peers', // compose-time list of neighbouring communities to reach out to
    '/api/pricing-guide',            // community pricing catalog and public multiplier
    '/api/pair/poll',                // ephemeral QR device pairing poll (pre-auth)
    '/api/channels/options',         // the platform/category vocabulary the channel form renders
    '/api/pulse/feed',               // public syndicated creator activity feed (The Pulse, Phase 2)
    '/api/pulse/oauth/config',       // public platform OAuth availability configuration (The Pulse, Phase 5)
    '/api/node/info',                // federation discovery: name + counts + peer URLs, read cross-origin by peers' PWAs, which cannot sign there
    '/api/federation/links',         // link cards (energy balance per peer), public by design — see its handler in routes/community.ts
    '/api/node/identity-epoch',      // split-brain guard: the signed take-over count an old main server reads at its own address (services/identity-epoch.ts)
    '/api/global/communities',       // global node (G5): the mirrored communities directory, for anyone deciding where to join
    '/api/global/home',              // global node (G5): the landing card; a signed read adds the caller's own watches
    '/api/join/knock/status',        // ask to join (G6): the applicant, not a member here, reads their own knock; answers only a signed request, for the signer
]);
// Precise patterns for the parameterized public routes. Kept deliberately tight
// (anchored, single path segment per `[^/]+`) so a broad prefix can't
// accidentally expose a sensitive neighbour — e.g. the DM-content reads
// (/api/messages/conversations/:pk, /api/messages/:conversationId) must stay
// GATED; only the E2E-ciphertext attachment binary is public.
export const PUBLIC_READ_PATTERNS: readonly RegExp[] = [
    /^\/api\/community\/membership\/[^/]+$/,                // onboarding: is this pubkey a member?
    /^\/api\/members\/callsign-available\/[^/]+$/,          // onboarding/wizard: check callsign availability
    /^\/api\/crowdfund\/projects\/[^/]+$/,                  // public crowdfund detail
    /^\/api\/treasury\/[^/]+$/,                             // community transparency: one treasury's detail
    /^\/api\/enterprise\/[^/]+$/,                           // community transparency: enterprise detail
    /^\/api\/commons\/decisions\/[^/]+$/,                   // governance transparency: single decision detail
    /^\/api\/recovery\/lookup\/[^/]+$/,                     // pre-membership: look up SSO recovery candidates by callsign
    /^\/api\/marketplace\/posts\/[^/]+\/photos\/[^/]+$/,    // <img> binary (cannot send signature headers)
    /^\/api\/messages\/[^/]+\/attachment$/,                 // E2E-ciphertext attachment binary for <img>
    /^\/api\/pulse\/items\/[^/]+\/thumbnail$/,              // <img> Pulse feed item thumbnail proxy binary
    /^\/api\/avatar\/[^/]+$/,                               // <img> member avatar binary
];

// Public reads that name members, on a node that shows visitors the listings and not the people (`guestListingsOnly`,
// on the global profile by default and overridable anywhere, G9a): off the allowlist there, so the ordinary gate
// answers them for members only, whatever else is switched on. Each names people: a decision carries its author's key
// and can name a member in its params (a suspension), the pool balance belongs to a ledger a visitor has no part in,
// and the Pulse feed carries each member's key, name, face and their own pages elsewhere. The lobby has nothing of
// them to be transparent about. Everywhere else they stay public.
export const MEMBERS_ONLY_ON_GUEST_LISTINGS_EXACT: ReadonlySet<string> = new Set<string>([
    '/api/commons/decisions',
    '/api/commons/balance',
    '/api/pulse/feed',
]);
// And every public read of the Beans constructs, the enterprises and treasuries (one construct), crowdfunds and Commons
// projects, wherever those are switched on with the visitors' view (a global node with Beans back on, a local node
// with the view overridden on). Members only rather than stripped for a visitor, as a post is: each is people and
// money through and through. An enterprise names its keepers and their backing pledges (key, name, face), who paused
// it, who is winding it up and who placed it, and its flow carries members' memos; a crowdfund names its creator, a
// project its proposer; each carries balances from a ledger a visitor has no part in, and an enterprise its own face
// and exact place. A visitor's copy would be a second guestPost over some fifty fields, every new one a leak until
// someone decides; off the allowlist, a new field or a new public read under these prefixes is members-only already.
// The apps read a refused one as "none", as they do on a node with them off. (The phone reads the treasuries list and
// its crowdfund sync unsigned, native db.ts getTreasuries and pillar-sync, so on such a node a member's phone lists
// none of them until those two reads are signed.)
export const MEMBERS_ONLY_ON_GUEST_LISTINGS_PATTERNS: readonly RegExp[] = [
    /^\/api\/commons\/decisions\/[^/]+$/,
    /^\/api\/(treasury|treasuries|enterprise|enterprises)(\/|$)/,
    /^\/api\/map\/enterprises$/,
    /^\/api\/crowdfund(\/|$)/,
    /^\/api\/commons\/projects(\/|$)/,
];

function isAllowlisted(path: string): boolean {
    return PUBLIC_READ_EXACT.has(path) || PUBLIC_READ_PATTERNS.some(re => re.test(path));
}

// The router answers a path with one trailing slash as the path itself (@koa/router's default, strict: false), so this
// test does too. Otherwise `/api/pulse/feed/` would miss it, be held only to the gate's usual live-member test, and
// reach the feed as a pruned account. Only a public read: the gated reads under the same prefixes (an enterprise's
// ledger, its thread) keep the gate's usual test.
function namesMembers(path: string): boolean {
    const routed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    return isAllowlisted(routed)
        && (MEMBERS_ONLY_ON_GUEST_LISTINGS_EXACT.has(routed) || MEMBERS_ONLY_ON_GUEST_LISTINGS_PATTERNS.some(re => re.test(routed)));
}

/**
 * Who may make a gated read, once signed. A member of this node always (isNodeMember). A pruned account keeps its row and
 * can still sign: it passes on a node without the visitors' view (isLiveMemberKey, #1156's separate call), except the
 * reads gated only because of that view (namesMembers). On a node with the view (`guestListingsOnly`) it reads as a
 * visitor would, everywhere: nothing a gated read holds is for a visitor (G9a round 3). The switch is read only for a key
 * that is live but no member, so a member's read pays nothing for it.
 */
function mayMakeGatedRead(pubKeyHex: string, path: string): boolean {
    if (isNodeMember(pubKeyHex)) return true;
    return !namesMembers(path) && isLiveMemberKey(pubKeyHex) && !getProfileSwitches().guestListingsOnly;
}

function isPublicRead(path: string): boolean {
    if (!isAllowlisted(path)) return false;
    // The switches are read only for these few paths, so no other request pays for them.
    if (!namesMembers(path)) return true;
    const switches = getProfileSwitches();
    // A Beans read that is switched off names nobody: it answers 404 feature_off to everyone (profileFeatureGate), a
    // visitor as a member, as it did before this switch existed.
    return !switches.guestListingsOnly || featureOffFor(path, switches) !== null;
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
    // Capped at MAX_SAFE_INTEGER: a finite but huge offset (?offset=1e300) cannot bind as a SQLite integer and
    // was a 500. Past the cap the page is simply empty.
    return Number.isFinite(n) && n > 0 ? Math.min(n, Number.MAX_SAFE_INTEGER) : 0;
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

/** The connection label on the admin dashboard: the real client (client-ip.ts), so a direct-mode client
 *  cannot write its own label. A label, not an auth decision. */
function getIpAddress(req: import('node:http').IncomingMessage): string {
    return resolveClientIp(req.socket.remoteAddress, req.headers);
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

const PONG_PAYLOAD = JSON.stringify({ type: 'pong' });

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

            // Reply to opt-in application-level ping on the sync WebSocket.
            // Tiny & fast: skips JSON parsing unless an opt-in key is present in dataStr.
            // Old clients send {"type":"ping"} and receive no reply, preventing
            // unexpected doorbell-driven sync loops on un-upgraded clients.
            // One opt-in key, and the cheap substring check is for that key only. Prefiltering on
            // a bare 'pong' matched any message that merely CONTAINED the word and forced a
            // JSON.parse of it — on a 1-CPU node shared with four other containers, per client,
            // per message. Accepting a second alias bought nothing but another way to be wrong.
            // Length-bounded before the substring scan, let alone the parse. Without it a
            // client could stream multi-megabyte frames containing "wantPong" and force a
            // synchronous JSON.parse of each on the main thread of a 1-CPU container shared with
            // four other nodes. A legitimate opt-in ping is well under 256 bytes.
            if (type === 'sync' && dataStr.length < 256 && dataStr.includes('wantPong')) {
                try {
                    const msg = JSON.parse(dataStr);
                    if (msg && msg.type === 'ping' && msg.wantPong === true) {
                        if (ws.readyState === 1) { // OPEN
                            try { ws.send(PONG_PAYLOAD); } catch {}
                        }
                    }
                } catch { /* ignore malformed messages */ }
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

/**
 * The methods that carry a request body and change state. The body parser, the signature requirement and
 * activity recording all key off this one list. They used to spell out POST/PUT/DELETE separately and all
 * three left out PATCH, so the group member-role and group-update routes (both PATCH) never received their
 * body, and every correctly signed PATCH failed signature verification against an empty body.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** /api and /ws, ignoring case: answers that are never documents, so they carry no document headers. */
function isApiOrWsPath(requestPath: string): boolean {
    const lower = requestPath.toLowerCase();
    return lower === '/api' || lower.startsWith('/api/') || lower === '/ws' || lower.startsWith('/ws/');
}

/**
 * @koa/router matches routes ignoring letter case, but every path-based security decision in this file
 * (signature enforcement, its bypass list, the public-read allowlist, the admin IP allowlist, feature
 * toggles) compares the path as sent. Those two views must never disagree about what a request is, so a
 * path that is canonical only once case is ignored is refused before any of them run:
 *   - the `/api` or `/ws` prefix itself is not lowercase; or
 *   - the path reaches a route only by ignoring case.
 * Route PARAMETERS keep their case — a mixed-case callsign or id still matches, because only the literal
 * part of a route differs between the two regexps.
 */
const caseSensitiveRouteRegexps = new WeakMap<Router.Layer, RegExp>();
function isNonCanonicalPath(router: Router, requestPath: string): boolean {
    const lower = requestPath.toLowerCase();
    if (lower === requestPath) return false;
    for (const prefix of ['/api', '/ws']) {
        if ((lower === prefix || lower.startsWith(prefix + '/')) && !requestPath.startsWith(prefix)) return true;
    }
    for (const layer of router.stack) {
        if (layer.methods.length === 0 || !layer.match(requestPath)) continue;
        let exact = caseSensitiveRouteRegexps.get(layer);
        if (!exact) {
            exact = new RegExp(layer.regexp.source, layer.regexp.flags.replace('i', ''));
            caseSensitiveRouteRegexps.set(layer, exact);
        }
        if (!exact.test(requestPath)) return true;
    }
    return false;
}

// Both listeners take upgrades: the HTTPS server for direct and LAN clients, and the plain HTTP
// server because the Cloudflare tunnel's origin is http://beanpool-node:8080. Before this was shared,
// upgrades on 8080 fell through to Koa and got a 404, so tunnel-mode nodes had no live updates.
// One handler and one WebSocketServer pair means /ws and /ws/logs get the same auth, client
// tracking and heartbeat whichever port the socket arrived on.
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

function createUpgradeHandler(wss: WebSocketServer, logsWss: WebSocketServer): UpgradeHandler {
    return async (req, socket, head) => {
        const reqUrl = req.url || '';
        const parsedUrl = new URL(reqUrl, 'https://localhost');
        const pathname = parsedUrl.pathname;

        if (pathname === '/ws') {
            // SRV-4: see WS_AUTH_MODE for what each kind of connect gets.
            const connect = verifyWsConnect(pathname, parsedUrl.searchParams);
            const refuse = WS_AUTH_MODE === 'strict'
                ? connect.kind !== 'member'
                : WS_AUTH_MODE === 'members' && connect.kind === 'invalid';
            if (refuse) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
            wss.handleUpgrade(req, socket, head, (ws: any) => {
                ws.isAlive = true;
                ws.on('pong', () => { ws.isAlive = true; });
                // A2-20: tag the socket with its verified member so broadcast() can scope
                // sensitive events to the parties. A socket without one gets only the public
                // doorbell, unless the operator chose the open feed. A valid signature from a
                // key that is not a member yet (someone mid-join) is remembered, so the socket
                // is promoted when that key's member_joined goes out.
                ws._memberPubkey = connect.kind === 'member' ? connect.pubkey : null;
                ws._pendingMemberPubkey = connect.kind === 'non_member' ? connect.pubkey : null;
                ws._openFeed = WS_AUTH_MODE === 'open';

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
            const ticket = parsedUrl.searchParams.get('ticket');
            const config = getLocalConfig();
            let authorized = false;

            if (ticket && isValidWsTicket(ticket)) {
                authorized = true;
            } else if (auth && config.adminHash && config.salt && !twoFactorOn() && !isBreakGlassMode()) {
                // The admin password, so under the same per-source brake as every other password check. Never under
                // 2FA or in break-glass mode: this path takes the password alone, and every client asks for a ticket
                // (checkAdminAuth) now.
                const brakeKey = limiterKeyForIp(resolveClientIp(req.socket.remoteAddress, req.headers));
                const admission = await acquirePasswordAttempt(brakeKey);
                if (!admission.admitted) {
                    socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${admission.retryAfter}\r\n\r\n`);
                    socket.destroy();
                    return;
                }
                let pwOk = false;
                try {
                    pwOk = await verifyPasswordAsync(auth, config.adminHash, config.salt);
                } finally {
                    // Under 2FA a right password alone clears nothing (password-brake.ts, checkAdminPassword).
                    settlePasswordAttempt(brakeKey, pwOk, !twoFactorOn());
                }
                if (pwOk) {
                    logger.warn('AUTH', '[SECURITY] WebSocket auth via ?auth= query string is deprecated. Migrate to POST /api/local/admin/ws-ticket.');
                    authorized = true;
                }
            }

            if (!authorized) {
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
    };
}

/** Paths the signature middleware never verifies (they carry their own auth, or none). */
function isSignatureBypassed(p: string): boolean {
    return p.startsWith('/api/local/') ||
        p.startsWith('/api/admin/') ||
        p.startsWith('/api/manager/') ||
        p.startsWith('/api/pair/') ||
        p.startsWith('/api/pricing-guide/admin/') ||
        p.startsWith('/api/pricing-guide/reports') ||
        p === '/api/invite/redeem' ||
        p === '/api/invite/redeem-offline';
}

/**
 * The answer to every signed request from a key a re-key replaced (`invalidated_keys`: a lost or stolen phone's, from the
 * moment the operator starts the re-key, and for good once it completes). The same sentence and code as the join doors'
 * (routes/open-join.ts, routes/knocks.ts), whose own refusals now answer only a direct caller; the phone's door already
 * shows it word for word (native utils/global-join.ts).
 *
 * One place, for every route, rather than a check in each (the lesson of #1154): until the re-key completes, that key's
 * "own data" is the member's whole account (its Beans, its profile, its posts and messages), which the re-key then hands
 * to the new phone. Refused whatever the row's status says: a suspension is a separate rule, left to the routes.
 *
 * No flow needs a replaced key to sign, so there is no exception. The re-key is completed by the NEW key
 * (`/api/member/re-enroll` is signed by the key it binds, which the identity check below holds to `newPublicKey`) or by
 * an operator on the admin surface. A recovering device signs with a fresh ephemeral key (routes/recovery-collect.ts).
 * The routes this middleware never sees (isSignatureBypassed: the admin surface, which a replaced key can't sign in to,
 * and invite redemption, which refuses it itself) keep their own checks. A flow that ever must take a replaced key is
 * named here, with its reason.
 */
const REPLACED_KEY_REFUSAL = 'This key was replaced by a new one, so this community no longer accepts it. Use the device or the 12 words that hold the new key.';

// The administrative rate limiter's buckets (its middleware is in startHttpsServer): each client's requests in the last minute.
const adminRateLimits = new Map<string, number[]>();
/** Tests only: forget every administrative bucket. */
export function resetAdminRateLimit(): void {
    adminRateLimits.clear();
}

// Module-level reference so the HTTP server can reuse the same Koa app for
// plain-HTTP tunnel ingress (avoids TLS handshake overhead from cloudflared).
let _koaApp: Koa | null = null;
export function getKoaApp(): Koa | null { return _koaApp; }
// Same for WebSocket upgrades. Null until startHttpsServer runs (index.ts starts HTTP first).
let _upgradeHandler: UpgradeHandler | null = null;
export function getUpgradeHandler(): UpgradeHandler | null { return _upgradeHandler; }

/**
 * Starts the HTTPS listener and resolves with the port it actually bound.
 *
 * Pass 0 to let the OS pick a free one and read it back from the resolved value. Tests used to pick
 * ports for themselves with a probe that binds port 0, closes, and hands the number on — two probes in
 * a row could be handed the same port, and the second server then died with EADDRINUSE. Binding once
 * and reporting the result has no such gap.
 */
export async function startHttpsServer(port: number): Promise<number> {
    const app = new Koa();
    app.proxy = true;
    _koaApp = app;
    const router = new Router();

    // With app.proxy on, Koa's ctx.ip is the leftmost X-Forwarded-For from ANY peer — the client's own claim.
    // Replace it with the real client (forwarding headers believed only from our own tunnel/proxy, see
    // client-ip.ts) before anything reads it.
    app.use(async (ctx, next) => {
        ctx.request.ip = clientIp(ctx);
        await next();
    });

    // Federation CORS middleware (must be before body parser for fast OPTIONS handling)
    app.use(federationCors());

    // Standard Modern Security Headers Middleware
    app.use(async (ctx, next) => {
        // Global security headers applied to all responses (API and static):
        // nosniff protects against stored-XSS MIME confusion (e.g. /api/avatar/:pubkey)
        // HSTS enforces encrypted transport globally.
        ctx.set('X-Content-Type-Options', 'nosniff');
        ctx.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

        // Document-only security headers (CSP, X-Frame-Options, X-XSS-Protection) are only
        // evaluated by browsers during HTML document navigation or iframe embedding.
        // They are omitted on API routes and WebSocket paths to eliminate protocol overhead (~450 bytes)
        // on JSON fetch and 304 responses, while ensuring HTML documents and static assets retain them.
        if (!isApiOrWsPath(ctx.path)) {
            ctx.set('X-Frame-Options', 'DENY');
            ctx.set('X-XSS-Protection', '1; mode=block');
            // The web app's policy, under which it runs its own scripts and nothing else, is every document's
            // (app-document-csp.ts). The few pages that need the older one ask for it where they are rendered.
            useAppDocumentPolicy(ctx);
        }
        await next();
    });

    // A path outside /api and /ws that the static server would read as another path (`/a/..%2findex.html` is the web
    // app's index.html to it) is refused before any page or file handler sees it: nothing lives at such a spelling.
    // See isNonCanonicalSpelling.
    app.use(async (ctx, next) => {
        if (!isApiOrWsPath(ctx.path) && isNonCanonicalSpelling(ctx.path)) {
            ctx.status = 404;
            ctx.body = { error: 'Not found' };
            return;
        }
        await next();
    });

    // Fail closed on a path that only matches once case is ignored — see isNonCanonicalPath. 404 rather
    // than 401: nothing lives at that spelling, and a signature would not change that, so 401 would
    // misdirect a client into signing a request that can never succeed.
    app.use(async (ctx, next) => {
        if (isNonCanonicalPath(router, ctx.path)) {
            ctx.status = 404;
            ctx.body = { error: 'Not found' };
            return;
        }
        await next();
    });

    // Gateway Configuration Middlewares (CORS Allowed Origins, Admin IP Allowlist, Feature Toggles, Rate Limiting)

    app.use(async (ctx, next) => {
        const gwConfig = getGatewayConfig();
        // The real client (client-ip.ts): the socket peer, unless that peer is our own tunnel/proxy, in which case
        // the address it forwards. In tunnel mode the socket peer is the cloudflared container for everyone, so
        // an allowlist or limiter keyed on it cannot tell one person from another.
        const realIp = clientIp(ctx);

        // 1. Dynamic CORS Allowed Origins Handling (#131)
        const requestOrigin = ctx.get('Origin');
        const allowedOrigins = gwConfig.corsAllowedOrigins || [];

        if (requestOrigin) {
            // Normalize trailing slashes to match browser Origin header format (mirrors federation-api.ts)
            const normalizedReq = requestOrigin.replace(/\/+$/, '');
            const isExplicitlyAllowed = allowedOrigins.some(o => o.replace(/\/+$/, '') === normalizedReq);
            const isWildcardAllowed = allowedOrigins.includes('*');

            if (isExplicitlyAllowed) {
                // Explicitly allowed origin: set origin & credentials
                ctx.set('Access-Control-Allow-Origin', requestOrigin);
                ctx.set('Access-Control-Allow-Credentials', 'true');
                ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Admin-Password, x-admin-password, X-CSRF-Token, x-csrf-token, x-signature, x-public-key, x-timestamp, x-nonce');
                ctx.set('Access-Control-Expose-Headers', 'X-CSRF-Token');
                ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
            } else if (isWildcardAllowed) {
                // Wildcard allowed: set '*' origin, DO NOT set Access-Control-Allow-Credentials to true
                ctx.set('Access-Control-Allow-Origin', '*');
                ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Admin-Password, x-admin-password, X-CSRF-Token, x-csrf-token, x-signature, x-public-key, x-timestamp, x-nonce');
                ctx.set('Access-Control-Expose-Headers', 'X-CSRF-Token');
                ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
            } else if (/^\/api\/local\/admin\/unlock\/[0-9a-f]{64}$/.test(ctx.path)) {
                // An owner's web app unlocking a standby or a restore with its key (slice 6, routes/owner-unlock.ts):
                // it runs on the community's own address, never this server's. These two calls carry no cookie and
                // no credential — the owner's signature is inside the body — so any origin may make them.
                ctx.set('Access-Control-Allow-Origin', '*');
                ctx.set('Access-Control-Allow-Headers', 'Content-Type');
                ctx.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            }
        }

        if (ctx.method === 'OPTIONS') {
            ctx.status = 204;
            return;
        }

        // 2. Admin IP Allowlist Enforcement (/settings, /settings-legacy, /settings.js, /api/local/admin/*, /api/admin/*, and local administrative routes)
        if (gwConfig.adminIpAllowlist && gwConfig.adminIpAllowlist.length > 0) {
            const normalizedPath = path.posix.normalize(ctx.path.toLowerCase()).replace(/\/+$/, '') || '/';
            if (
                normalizedPath === '/settings' ||
                normalizedPath.startsWith('/settings/') ||
                normalizedPath === '/settings-legacy' ||
                normalizedPath === '/settings.js' ||
                normalizedPath === '/api/local/admin' ||
                normalizedPath.startsWith('/api/local/admin/') ||
                normalizedPath === '/api/admin' ||
                normalizedPath.startsWith('/api/admin/') ||
                normalizedPath === '/api/local/verify-password' ||
                normalizedPath === '/api/local/dashboard' ||
                normalizedPath === '/api/local/update-identity' ||
                normalizedPath === '/api/local/change-password' ||
                normalizedPath === '/api/local/reset' ||
                normalizedPath === '/api/local/connectors' ||
                normalizedPath.startsWith('/api/local/connectors/') ||
                normalizedPath.startsWith('/api/local/federation/') ||
                normalizedPath === '/api/manager' ||
                normalizedPath.startsWith('/api/manager/') ||
                normalizedPath === '/api/pricing-guide/admin' ||
                normalizedPath.startsWith('/api/pricing-guide/admin/')
            ) {
                const isAllowed = gwConfig.adminIpAllowlist.some(allowedIp => {
                    const norm = allowedIp.trim();
                    if (realIp === norm || norm === '*') return true;
                    if ((norm === '127.0.0.1' || norm === 'localhost') && (realIp === '127.0.0.1' || realIp === '::1')) return true;
                    if (norm.endsWith('*') && realIp.startsWith(norm.slice(0, -1))) return true;
                    return false;
                });
                if (!isAllowed) {
                    ctx.status = 403;
                    ctx.body = { error: 'Access denied by Gateway Admin IP allowlist' };
                    return;
                }
            }
        }

        // 3. Subsystem Feature Toggles Interceptors
        // What a check PROTECTS is matched ignoring case; what it EXEMPTS is matched as sent, so a
        // differently-cased spelling can only ever be treated more strictly.
        const lowerPath = ctx.path.toLowerCase();
        if (!gwConfig.features?.marketplace && lowerPath.startsWith('/api/marketplace')) {
            ctx.status = 503;
            ctx.body = { error: 'Marketplace feature is currently disabled by node gateway' };
            return;
        }
        if (!gwConfig.features?.messaging && lowerPath.startsWith('/api/messaging')) {
            ctx.status = 503;
            ctx.body = { error: 'Messaging feature is currently disabled by node gateway' };
            return;
        }
        if (!gwConfig.features?.federation && lowerPath.startsWith('/api/federation')) {
            ctx.status = 503;
            ctx.body = { error: 'Federation feature is currently disabled by node gateway' };
            return;
        }
        // A knock (G6) is answered with an invite, so a node that takes no invites takes no knocks either.
        if (!gwConfig.features?.invites && (lowerPath.startsWith('/api/invite') || lowerPath.startsWith('/api/community/invite') || lowerPath.startsWith('/api/join/knock'))) {
            ctx.status = 503;
            ctx.body = { error: 'Invites feature is currently disabled by node gateway' };
            return;
        }
        if (!gwConfig.features?.servePwa && (ctx.path === '/' || lowerPath.startsWith('/app') || lowerPath.endsWith('.html'))) {
            // The invite trampoline (`/?invite=`) is plain HTML served by this
            // server (NOT the PWA), and invites must work even on headless nodes
            // — so exempt it. It renders native-app-only there (no web escape
            // hatch), since servePwa is off.
            const isInviteTrampoline = ctx.path === '/' && !!ctx.query.invite;
            if (ctx.path !== '/settings' && !ctx.path.startsWith('/settings/') && ctx.path !== '/settings-legacy' && !ctx.path.startsWith('/api/') && !isInviteTrampoline) {
                ctx.status = 530;
                ctx.body = { error: 'Headless Mode: PWA hosting is disabled on this node gateway' };
                return;
            }
        }

        // 4. Rate Limiting (gateway-rate-limit.ts): per real client address for unsigned requests, per member
        //    for signed ones (charged after verification, below requireSignature). Exempts the admin control
        //    plane and federation/community paths (inter-node synchronisation bursts).
        const isFederationPath = ctx.path.startsWith('/api/federation/') || ctx.path.startsWith('/api/community/');
        const limited = !!gwConfig.rateLimiting?.enabled && !ctx.path.startsWith('/api/local/admin/') && !isFederationPath;
        if (limited) {
            // #132: Use nullish coalescing so a falsy (0) value doesn't silently fall back to the default
            const maxReqs = gwConfig.rateLimiting.maxRequestsPerMinute ?? 120;
            const claimsSignature = !!ctx.get('X-Public-Key') && !!ctx.get('X-Signature') && !isSignatureBypassed(ctx.path);
            if (!gatewayAdmit(ctx, maxReqs, claimsSignature)) return;
        }

        await next();
        if (limited) gatewaySettle(ctx);
    });

    // Administrative In-Memory Rate Limiter Middleware
    app.use(async (ctx, next) => {
        const lowerPath = ctx.path.toLowerCase();
        if (lowerPath.startsWith('/api/local/') || lowerPath.startsWith('/api/admin/')) {
            // Exempt read-only telemetry / polling endpoints so dashboard polling doesn't burn administrative mutation rate limits
            const isPollingEndpoint = ctx.path.endsWith('/diagnostics') || ctx.path.endsWith('/ws-connections') || ctx.path.endsWith('/system-stats');
            if (!isPollingEndpoint) {
                const ip = clientLimiterKey(ctx); // IPv6: the /64 (client-ip.ts)
                const now = Date.now();
                const windowMs = 60 * 1000; // 1 minute
                const limit = 300; // max 300 administrative requests per minute

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
        }
        await next();
    });

    // Periodic unref'd garbage collection for rate-limiting maps to prevent memory leaks
    const rateLimitCleaner = setInterval(() => {
        const now = Date.now();
        const windowMs = 60 * 1000;
        pruneGatewayBuckets(now);
        for (const [ip, timestamps] of adminRateLimits) {
            const valid = timestamps.filter(t => now - t < windowMs);
            if (valid.length === 0) adminRateLimits.delete(ip);
            else adminRateLimits.set(ip, valid);
        }
        pruneAuthAttempts(now);
        pruneGithubPolls(now);
        pruneChatLines(now);
        for (const [nonce, exp] of seenNonces) {
            if (exp <= now) seenNonces.delete(nonce);
        }
    }, 60 * 1000);
    if (rateLimitCleaner.unref) rateLimitCleaner.unref();
    // The open door's sign-up limiter keeps hashed addresses in the database, not in memory: they are cleared once
    // a day old on this timer too, not only when somebody joins (engine/open-join.ts).
    startForgettingJoinAddresses();
    // Requests to join (G6): on the main server, what no member will read again is cleared from them, and a row past
    // its windows is deleted, on the same kind of timer (engine/knocks.ts, "What is kept").
    startTidyingKnocks();

    // The split-brain guard (services/identity-epoch.ts): once this server has seen that another took over its
    // identity, members' writes are refused here, before a body is read. The admin control plane stays open.
    app.use(identityReadOnlyGuard);

    // JSON body parser middleware
    app.use(async (ctx, next) => {
        if (MUTATING_METHODS.has(ctx.method)) {
            if (ctx.request.type === 'application/json' || ctx.get('content-type')?.includes('json')) {
                // A2-10: reject an over-limit body up-front by Content-Length so a
                // well-behaved client gets a clean 413 before we read a byte. The
                // streaming cap in readBody is the backstop for chunked / lying-length
                // requests.
                // Some routes are far tighter than the global cap. Applying their limit
                // here rather than in the handler is the difference between refusing a
                // request and buffering, Ed25519-verifying and JSON.parsing 2 MB on the
                // one event loop first — which on a 1 vCPU node is most of the attack.
                const routeLimit = routeBodyLimit(ctx.path.toLowerCase());
                const declaredLen = Number(ctx.get('content-length'));
                if (Number.isFinite(declaredLen) && declaredLen > routeLimit) {
                    ctx.status = 413;
                    ctx.body = { error: 'Request body too large' };
                    return;
                }
                try {
                    const body = await readBody(ctx.req, routeLimit);
                    (ctx as any).rawBody = body;  // X-1: exact bytes the client signed
                    const parsed = JSON.parse(body);
                    (ctx as any).requestBody = parsed;
                    // Koa core does NOT parse request bodies, and this server mounts no bodyparser
                    // middleware, so `ctx.request.body` is undefined unless it is set right here.
                    // Fourteen handlers across routes/pairing.ts, routes/pricing-guide.ts and
                    // routes/manager-backups.ts read the `ctx.request.body` spelling — every one of
                    // them was silently receiving `{}`. Pairing 400'd on every attempt, and a
                    // single-node harvest fell through its `!nodeId` guard and ran the whole fleet.
                    // Both spellings now name the same parsed object.
                    //
                    // The handler-level suites (test-pairing-relay, test-pricing-guide) call the
                    // service layer directly and stayed green throughout, which is exactly how this
                    // survived. test-request-body.ts asserts it over real HTTP instead — same
                    // reasoning as test-keeper-http.ts, and the same trap as #143.
                    (ctx.request as any).body = parsed;
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
                    (ctx.request as any).body = {};
                }
            } else {
                (ctx as any).requestBody = {};
                (ctx.request as any).body = {};
            }
        }
        await next();
    });

    // Body identity fields that name someone other than the signer on purpose (targetPubkey, to_pubkey,
    // memberPubkey, sellerPublicKey, oldPubkey, friend_pubkey, targetPeerPubkey, ...). Lower-cased key.
    // `candidate` is the keeper proposed as lead in POST /api/enterprise/:treasury/succession/propose, who is
    // never the proposer; without it every succession proposal over HTTP was refused as a spoof.
    const OTHER_ENTITY_IDENTITY_FIELD = /^(target|old|to|invited|friend|seller|member|candidate)(peer)?_?(pubkey|publickey|public_key)$/;

    // Cryptographic Signature Verification Middleware
    async function requireSignature(ctx: Koa.Context, next: Koa.Next) {
        // Whether a request NEEDS a signature is decided ignoring case, matching how the router dispatches
        // it. The exemptions below (bypass list, public reads) stay exact-match, so a differently-cased
        // spelling can only ever be held to the stricter rule. isNonCanonicalPath refuses such spellings
        // earlier; this keeps the middleware correct on its own.
        const isApiPath = ctx.path.toLowerCase().startsWith('/api/');
        const isMutatingApi = MUTATING_METHODS.has(ctx.method) && isApiPath;
        // SRV-2/SRV-4: gated reads require the same signature as writes when
        // ENFORCE_READ_AUTH is on. Deny-by-default — every GET /api/* is gated
        // unless it is on the public allowlist. A HEAD too: the router answers it with the GET handler, so an ungated
        // HEAD ran any gated read for anyone and its Content-Length told them what the GET would not (4108354205).
        const isGatedRead = ENFORCE_READ_AUTH && (ctx.method === 'GET' || ctx.method === 'HEAD') && isApiPath && !isPublicRead(ctx.path);
        if (isSignatureBypassed(ctx.path)) {
            return await next();
        }
        // Writes that may be anonymous: an unsigned request passes through with no actor, but signature
        // headers, when sent, are verified like any other write so the route can trust ctx.state.actor.
        const isOptionallySignedWrite = ctx.path === '/api/pricing-guide/report';

        const pubKeyHex = ctx.get('X-Public-Key');
        const signatureBase64 = ctx.get('X-Signature');

        if ((!isMutatingApi && !isGatedRead) || isOptionallySignedWrite) {
            // Optional read auth: if signature headers are provided, verify them to populate ctx.state.actor
            if (!pubKeyHex || !signatureBase64) {
                return await next();
            }
        } else {
            if (!pubKeyHex || !signatureBase64) {
                ctx.status = 401;
                ctx.body = { error: 'Missing cryptographic signature headers' };
                return;
            }
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

            // A key a re-key replaced signs nothing here, write or read (REPLACED_KEY_REFUSAL). Only once the signature
            // checks out, so a forged request learns nothing about which keys are replaced.
            if (isInvalidatedKey(pubKeyHex)) {
                ctx.status = 403;
                ctx.body = { error: REPLACED_KEY_REFUSAL, code: 'key_invalidated' };
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
            // social graph aren't readable by an anonymous key. (The old key of a
            // member being re-keyed, a lost or stolen phone, was refused above, for
            // every request. Writes otherwise keep their own per-route authorization;
            // membership isn't required there — e.g. first-time registration.)
            // Where this node shows visitors the listings and not the
            // people (G9a), every gated read takes the member test itself
            // (mayMakeGatedRead): a pruned account reads as a visitor would.
            if (isGatedRead && !mayMakeGatedRead(pubKeyHex, ctx.path)) {
                ctx.status = 403;
                ctx.body = { error: 'Read access requires a member identity' };
                return;
            }

            // Generic spoof check: any body field representing the request initiator
            // (ending in 'pubkey', 'publickey', or is 'from' or 'createdby') must match the verified public key.
            // We exclude other non-sender fields like targetPubkey, oldPubkey, to_pubkey, invited_by to prevent false positives.
            //
            // `seller` joins that list for the cross-node purchase route (#143), where the seller is a member of
            // ANOTHER community by definition and can never be the signer. Without it, this check rejected every
            // valid cross-node purchase with an identity mismatch — the route was unusable over HTTP while its
            // own suite passed, because that suite drives the router handler directly and never crosses this
            // middleware. The allowlist is for fields that name someone else on purpose, and a seller is the
            // clearest possible case of one.
            const body = (ctx as any).requestBody || {};
            for (const [key, value] of Object.entries(body)) {
                const k = key.toLowerCase();
                const isIdentityField = k.endsWith('pubkey') || k.endsWith('publickey') || k === 'from' || k === 'createdby';
                // Whole-name match, not a prefix: `startsWith('to')` also exempted e.g. `tokenPubkey`, and
                // `startsWith('member')` any `member…Pubkey`, so a future route reading such a field as the actor
                // would have been spoofable (#841 review).
                const isOtherEntity = OTHER_ENTITY_IDENTITY_FIELD.test(k);
                
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

        // Activity (the lead-succession "gone quiet" signal) is recorded from the VERIFIED signer only, never
        // from a body field — an unsigned request naming the lead must not stamp them active (PR #838 B2).
        if (ctx.state.actor && MUTATING_METHODS.has(ctx.method)) {
            try { recordActivity(ctx.state.actor); } catch (e: any) { console.warn('[Activity] could not record:', e?.message || e); }
        }

        await next();
    }
    app.use(requireSignature);

    // The gateway limiter's member bucket: charged only once the signature above has been verified.
    app.use(async (ctx, next) => {
        const gwConfig = getGatewayConfig();
        if (!gatewayAdmitMember(ctx, gwConfig.rateLimiting?.maxRequestsPerMinute ?? 120)) return;
        await next();
    });

    // The routes a node profile switch has turned off (Beans, escrow, enterprises and treasuries, crowdfunds)
    // answer 404 feature_off before any handler runs (routes/profile-feature-gate.ts).
    app.use(profileFeatureGate);

    // Trust endpoint — only for self-signed mode
    if (!isUsingLetsEncrypt()) {
        router.get('/trust', async (ctx) => {
            ctx.type = 'application/x-pem-file';
            ctx.set('Content-Disposition', 'attachment; filename="beanpool-ca.pem"');
            ctx.body = getCaCertPem();
        });
    }


    // ===================== ADMIN AUTH =====================
    // Delegates to checkAdminAuth in admin-auth.ts

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
        broadcast,
    };

    // Mount all route modules
    const routeModules = [
        createSettingsRoutes(deps),
        createCommunityRoutes(deps),
        createAdminRoutes(deps),
        createBackupRoutes(deps),
        createTakeoverEnvelopeRoutes(deps),
        createOwnerWordsCheckRoutes(deps),
        createOwnerUnlockRoutes(deps),
        createMarketplaceRoutes(deps),
        createEventsRoutes(deps),
        createGroupRoutes(deps),
        createFederationPurchaseRoutes(deps),
        createFederationCommissionRoutes(deps),
        createMessagingRoutes(deps),
        createCommonsRoutes(deps),
        createTreasuryRoutes(deps),
        createPublicAddressRoutes(deps),
        createManagerBackupsRoutes(deps),
        createKeeperRoutes(deps),
        createOpenJoinRoutes(deps),
        createGlobalDirectoryRoutes(deps),
        createKnockRoutes(deps),
        createAppleReturnRoutes(),
        createChannelRoutes(deps),
        createNodeAdminRoutes(deps),
        createSettingsSigninRoutes(deps),
        createRecoveryCollectRoutes(deps),
        createPairingRoutes(deps),
        createPricingGuideRoutes(deps),
        createActivityRouter(deps),
        createPulseRoutes(deps),
        createPulseSubmitRoutes(deps),
        createAvatarRoutes(deps),
        // Temporary Apple `sub` parity probe. Registers nothing unless APPLE_PROBE=1
        // (the domain-association file aside) — see routes/apple-probe.ts.
        createAppleProbeRoutes(),
    ];

    // Start auto-pricing background aggregator
    startPricingAggregatorWorker();

    // The Pulse: poll syndicated creator feeds and prune each channel to its newest
    // PULSE_KEEP_PER_CHANNEL (20) items.
    // On by default — an unstarted scheduler means channels resolve never and the
    // feed stays permanently empty, which is exactly the built-but-unreachable
    // trap. PULSE_SCHEDULER=0 disables it per node for a quiet rollout.
    if (process.env.PULSE_SCHEDULER !== '0') {
        startPulseScheduler();
    } else {
        logger.info('SYS', '[Pulse] Scheduler disabled by PULSE_SCHEDULER=0 — feeds will not refresh');
    }
    for (const mod of routeModules) {
        router.use(mod.routes());
        router.use(mod.allowedMethods());
    }

    // Mount federation routes
    mountFederationRoutes(router);

    // 2FA session token injection middleware
    // When checkAdminAuth validates a TOTP code, it issues a session token on
    // ctx.state.tfaSessionToken. This middleware picks it up and delivers it
    // via an X-Admin-2FA-Session response header, keeping the JSON body clean
    // and avoiding accidental persistence into client state/configs.
    app.use(async (ctx, next) => {
        await next();
        if (ctx.state?.tfaSessionToken) {
            ctx.set('X-Admin-2FA-Session', ctx.state.tfaSessionToken);
        }
    });

    app.use(router.routes());
    app.use(router.allowedMethods());

    // Serve the PWA static files (assets, JS, CSS — but not index.html at root). Never for /api or /ws, where no file
    // lives and no document policy is set. A file's policy follows the file koa-send resolved, not the path's spelling.
    const servePublic = serve(PUBLIC_DIR, {
        index: false,
        gzip: true,
        setHeaders: (res, filePath) => {
            const headers = { set: (f: string, v: string) => res.setHeader(f, v), remove: (f: string) => res.removeHeader(f) };
            if (isDocumentPolicyFile(path.relative(PUBLIC_DIR, filePath))) useDocumentPolicy(headers);
            else useAppDocumentPolicy(headers);
        },
    });
    app.use(async (ctx, next) => (isApiOrWsPath(ctx.path) ? next() : servePublic(ctx, next)));

    // SPA fallback — return index.html for /settings/*, /manager/* and /app/* routes
    app.use(async (ctx) => {
        if (ctx.method === 'GET') {
            if (ctx.path === '/settings' || ctx.path.startsWith('/settings/')) {
                const settingsIndexPath = path.join(PUBLIC_DIR, 'settings', 'index.html');
                if (fs.existsSync(settingsIndexPath)) {
                    useDocumentPolicy(ctx);
                    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
                    ctx.set('Pragma', 'no-cache');
                    ctx.set('Expires', '0');
                    ctx.type = 'html';
                    ctx.body = fs.createReadStream(settingsIndexPath);
                    return;
                }
            }
            if (ctx.path.startsWith('/manager')) {
                const managerIndexPath = path.join(PUBLIC_DIR, 'manager', 'index.html');
                if (fs.existsSync(managerIndexPath)) {
                    useDocumentPolicy(ctx);
                    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
                    ctx.set('Pragma', 'no-cache');
                    ctx.set('Expires', '0');
                    ctx.type = 'html';
                    ctx.body = fs.createReadStream(managerIndexPath);
                    return;
                }
            }
            if (ctx.path.startsWith('/app') || ctx.path === '/') {
                const indexPath = path.join(PUBLIC_DIR, 'index.html');
                if (fs.existsSync(indexPath)) {
                    useAppDocumentPolicy(ctx);
                    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
                    ctx.set('Pragma', 'no-cache');
                    ctx.set('Expires', '0');
                    ctx.type = 'html';
                    ctx.body = fs.createReadStream(indexPath);
                    return;
                }
            }
        }
    });

    const serverOptions: https.ServerOptions = {
        cert: getServerCertPem(),
        key: getServerKeyPem(),
    };

    return new Promise<number>((resolve) => {
        const server = https.createServer(serverOptions, app.callback());

        // WebSocket upgrade handler (shared with the plain HTTP server — see createUpgradeHandler)
        const wss = new WebSocketServer({ noServer: true });
        const logsWss = new WebSocketServer({ noServer: true });
        const handleUpgrade = createUpgradeHandler(wss, logsWss);
        _upgradeHandler = handleUpgrade;
        server.on('upgrade', handleUpgrade);

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
            const bound = (server.address() as AddressInfo).port;
            console.log(`🔒 PWA + Settings + API (HTTPS) listening on https://0.0.0.0:${bound}`);
            resolve(bound);
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

/** Routes whose legitimate bodies are much smaller than the global cap, enforced before
 *  a byte is buffered. Pulse OAuth ingest is at most 50 items of link metadata. */
const ROUTE_BODY_LIMITS: Array<[RegExp, number]> = [
    [/^\/api\/member\/pulse\/oauth-ingest$/, 512 * 1024],
    // A knock (G6) is a 280-character message, a name, and at most a 150,000-character avatar; its answers carry nothing.
    [/^\/api\/join\/knock$/, 192 * 1024],
    [/^\/api\/join\/knocks\//, 4 * 1024],
];

function routeBodyLimit(path: string): number {
    for (const [pattern, limit] of ROUTE_BODY_LIMITS) {
        if (pattern.test(path)) return limit;
    }
    return MAX_JSON_BODY_BYTES;
}

class BodyTooLargeError extends Error { constructor() { super('Request body too large'); this.name = 'BodyTooLargeError'; } }

function readBody(req: import('node:http').IncomingMessage, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        req.on('data', (chunk: Buffer) => {
            if (aborted) return; // already over limit — discard without buffering
            total += chunk.length;
            if (total > maxBytes) {
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

