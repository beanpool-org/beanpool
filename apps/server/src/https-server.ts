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
import { logger, addLogClient, removeLogClient, logClients, startSystemLogRetention } from './logger.js';
import {
    registerMember, getMembers, getAllMembers, isNodeMember, isInvalidatedKey, isClosedAccountKey,
    readsAsMember, passesReadGate, isLiveVisitor, socketStanding,
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
    getConversationMessages,
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
import { createOffboxBackupRoutes } from './routes/offbox-backups.js';
import { createTakeoverEnvelopeRoutes } from './routes/takeover-envelope.js';
import { identityReadOnlyGuard } from './services/identity-epoch.js';
import { createOwnerWordsCheckRoutes } from './routes/owner-words-check.js';
import { createAppAddressesRoutes } from './routes/app-addresses.js';
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
import { standbyLedgerGate } from './routes/standby-ledger-gate.js';
import { moneyLimitsGate, enterpriseActingFor } from './routes/money-limits-gate.js';
import { getProfileSwitches } from './config/node-profile.js';
import { createPublicAddressRoutes } from './routes/public-address.js';
import { scrubServerFaults } from './routes/member-error-text.js';
import { CommonsPotUnknownError } from './engine/audit.js';
import { createAppleProbeRoutes } from './routes/apple-probe.js';
import { createAppleReturnRoutes } from './routes/apple-return.js';
import { isDocumentPolicyFile, isNonCanonicalSpelling, useAppDocumentPolicy, useDocumentPolicy } from './app-document-csp.js';
import { createKeeperRoutes } from './routes/keepers.js';
import { createOpenJoinRoutes } from './routes/open-join.js';
import { createGlobalDirectoryRoutes } from './routes/global-directory.js';
import { createKnockRoutes } from './routes/knocks.js';
import { createNoticeRoutes } from './routes/notices.js';
import { createBlockRoutes } from './routes/blocks.js';
import { startTidyingKnocks } from './engine/knocks.js';
import { startForgettingJoinAddresses } from './engine/open-join.js';
import { startForgettingOldAddresses } from './services/address-retention.js';
import { createChannelRoutes } from './routes/channels.js';
import { createNodeAdminRoutes } from './routes/node-admin.js';
import { createSettingsSigninRoutes } from './routes/settings-signin.js';
import { createRecoveryCollectRoutes } from './routes/recovery-collect.js';
import { createPairingRoutes } from './routes/pairing.js';
import { createPricingGuideRoutes } from './routes/pricing-guide.js';
import { createActivityRouter } from './routes/activity.js';
import { createHomeRoutes } from './routes/home.js';
import { createPulseRoutes } from './routes/pulse.js';
import { createPulseSubmitRoutes } from './routes/pulse-submit.js';
import { createAvatarRoutes } from './routes/avatar.js';
import { startPulseScheduler } from './engine/pulse-resolver.js';
import { startPricingAggregatorWorker } from './pricing-aggregator.js';
import type { RouteDeps } from './routes/types.js';
import { authRateLimit as rateLimit, pruneAuthAttempts } from './auth-rate-limit.js';
import { pruneChatLines } from './chat-rate-limit.js';
import { clientIp, clientLimiterKey, limiterKeyForIp, resolveClientIp } from './client-ip.js';
import { countWebAppPageLoad } from './engine/web-visits.js';
import { acquirePasswordAttempt, settlePasswordAttempt, twoFactorOn } from './password-brake.js';
import {
    gatewayAdmit, gatewayAdmitMember, gatewayAdmitDayBudget, gatewaySettle, pruneGatewayBuckets, gatewayClaimVerified,
    gatewayAdmitPeerRead, gatewayAdmitUpgrade, gatewaySettleUpgrade, gatewayNoRoomUpgrade, gatewayChargeLargeClaim, CLAIM_SMALL_BODY_BYTES,
    type GatewayCharge,
} from './gateway-rate-limit.js';
import { wsLimits, wsHasRoom, admitWsSocket, admitLogSocket, frameAllowed } from './ws-limits.js';
import { applyServerLimits, serverTimeoutOptions } from './server-limits.js';
import { visitorWriteRefused, visitorsOwnRead, routedPath } from './visitor-allowlist.js';
import { NOT_A_MEMBER_ERROR, NOT_A_MEMBER_CODE } from './engine/members.js';
import { provenKeySpelling, BAD_KEY_CODE, BAD_KEY_ERROR, BAD_SIGNER_KEY_ERROR } from './engine/member-key.js';
import { requestNonces, verifyMemberSignature } from './engine/member-signature.js';
import { checkEnvAddresses } from './engine/own-addresses.js';
import { REQUEST_SIGNING_VERSION, SIGNED_FOR_HEADER, WS_NO_ROOM_CLOSE_CODE, WS_NO_ROOM_RETRY_SEC, wsNoRoomReason } from '@beanpool/core';
import { APP_VERSION_HEADER, noteAppVersion } from './app-version-counts.js';


// X-1: replay protection for signed requests. A signed request is valid for SIGNATURE_FRESHNESS_MS around its
// timestamp, and each nonce may be used once within that window (engine/member-signature.ts `requestNonces`, spent only
// once everything else about the request has checked out). A request also names the community it was signed for
// (request binding): verifyMemberSignature refuses one signed for another community's host (421), and one in the old
// format, bound to none, once the switch has passed (426).

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
//     same things anyone can already read without signing, so on a node that shows visitors only
//     the listings (`guestListingsOnly`), only the listings', and elsewhere every one but the
//     listings', which are members-only there (state-engine keylessSocketMayUse).
//     A signature that is forged, stale or replayed is refused with 401.
//   - ENFORCE_WS_AUTH=true: only member-signed sockets are accepted; everything else gets 401.
//   - ENFORCE_WS_AUTH=false: the old open feed — every socket gets every community-wide event.
//     An escape hatch, not a recommendation.
// Safe by default, so a freshly downloaded node never streams member activity to strangers.
// A member-signed socket of a suspended or disabled member, while that lasts, is accepted in every
// mode and gets what is sent to it (its own messages, trades and Beans) but not the member feed: as
// over HTTP, it sees what a non-member sees (readsAsMember). So is a visitor's row's (isLiveVisitor),
// which of what is sent to it gets only its direct conversations and its Beans (state-engine
// visitorMayReceive), as it reads only those over HTTP.
export type WsAuthMode = 'members' | 'strict' | 'open';
const WS_AUTH_MODE: WsAuthMode =
    process.env.ENFORCE_WS_AUTH === 'true' ? 'strict'
        : process.env.ENFORCE_WS_AUTH === 'false' ? 'open'
            : 'members';

type WsConnectResult =
    | { kind: 'unsigned' }
    | { kind: 'invalid' }
    /**
     * `feed`: the key reads as a member (readsAsMember), so the socket gets the member feed too. `visitor`: a visitor's
     * row (isLiveVisitor), which gets of what is sent to it only its direct conversations and Beans.
     */
    | { kind: 'member'; pubkey: string; visitor: boolean; feed: boolean }
    | { kind: 'non_member'; pubkey: string };

/**
 * SRV-4: verify the signed connect token on a /ws upgrade. The client signs the replay-proof scheme with method=WS and
 * an empty body, and passes pubkey/ts/nonce/sig as query params; a current app also passes `for=<host>&v=2` and signs
 * format 2 (@beanpool/core request-signing.ts). `unsigned` when none of them is present, and for a token signed for
 * another community or, after the switch, one in the old format (engine/member-signature.ts): no member feed, public
 * doorbells in the default mode and 401 under ENFORCE_WS_AUTH=true, and the app still opens. `invalid` for a partial,
 * stale, replayed or forged token; otherwise whether the proven key belongs to a known member.
 */
function verifyWsConnect(pathname: string, params: URLSearchParams): WsConnectResult {
    const pubKeyHex = params.get('pubkey');
    const sigB64 = params.get('sig');
    const ts = params.get('ts');
    const nonce = params.get('nonce');
    if (!pubKeyHex && !sigB64 && !ts && !nonce) return { kind: 'unsigned' };
    if (!pubKeyHex || !sigB64 || !ts || !nonce) return { kind: 'invalid' };
    // Format 2 names its host with `for=` and says `v=2`; either without the other is a damaged token.
    const signedFor = params.get('for');
    const version = params.get('v');
    if ((signedFor === null) !== (version === null)) return { kind: 'invalid' };
    if (version !== null && version !== String(REQUEST_SIGNING_VERSION)) return { kind: 'invalid' };
    try {
        // One key, one spelling (engine/member-key.ts), as the signature middleware takes it; the nonce is spent only
        // after the signature and the community it names check out, so a forged token cannot burn (or fill the cache
        // with) nonces it does not own, and one signed for another community leaves its nonce unspent.
        const verdict = verifyMemberSignature(
            { pubKeyHex, signature: sigB64, timestamp: ts, nonce, method: 'WS', path: pathname, body: '', signedFor },
            { consumeNonce: true },
        );
        if (!verdict.ok) return verdict.status === 421 || verdict.status === 426 ? { kind: 'unsigned' } : { kind: 'invalid' };
        const signerKey = verdict.signer;

        // A valid signature only proves key possession — only a member (isNodeMember), or a visitor's row
        // for its own direct conversations and Beans (`visitor`), gets a member socket, so an anonymous
        // keypair can't subscribe to anything. A pruned account, and the old key of a member being
        // re-keyed, keep their row and can still sign, but neither is a member: its socket gets what a
        // stranger's gets, as an open one does once that happens (state-engine deliverBroadcast). Of the
        // members, only one who reads as a member (readsAsMember, the test every member-only read
        // applies) gets the member feed (`feed`).
        const standing = socketStanding(signerKey);
        return standing.act
            ? { kind: 'member', pubkey: signerKey, visitor: standing.visitor, feed: standing.feed }
            : { kind: 'non_member', pubkey: signerKey };
    } catch {
        return { kind: 'invalid' };
    }
}

// Reads that stay public even under enforcement. Deny-by-default: anything NOT
// listed here is gated, so a newly-added sensitive endpoint fails safe.
// Deliberately NOT here: /api/activity/feed. It names both members of every completed trade, the
// listing and the Beans, plus each member who joins, so it is readable by members only (2026-09-18),
// and only by one who reads as a member (MEMBER_READS_ONLY_EXACT, 2026-09-26).
//   - discovery / federation: a peer or prospective member must read these
//     before it has (or to decide whether to join with) an identity.
//   - onboarding / recovery: a not-yet-joined or recovering user has no member
//     identity to sign as.
//   - binary assets fetched by <img>/streamed: a browser image/attachment
//     request cannot carry signature headers. Message attachments are E2E
//     ciphertext (NAT-1), so serving them unauthenticated leaks no plaintext.
//     (A token-in-URL scheme for these is tracked as follow-up.)
// Some entries are here only so that, switched off by the node's profile, they answer 404 feature_off to everyone:
// otherwise they are members' reads on every node (MEMBERS_ONLY_READS_*), and the listings and the Commons pot are
// public only on some (PUBLIC_ONLY_ON_GUEST_LISTINGS_EXACT, MEMBERS_ONLY_ON_GUEST_LISTINGS_EXACT).
export const PUBLIC_READ_EXACT: ReadonlySet<string> = new Set<string>([
    '/api/version',
    '/api/community/info',
    '/api/community/health',
    '/api/node/config',
    '/api/directory/info',
    '/api/commons/balance',          // the Commons pot, a community total: public on a local community (MEMBERS_ONLY_ON_GUEST_LISTINGS_EXACT)
    '/api/commons/projects',         // members only (MEMBERS_ONLY_READS_PATTERNS); here for its 404 when switched off
    '/api/crowdfund/projects',       // members only; here for its 404 when switched off
    '/api/treasuries',               // members only; here for its 404 when switched off
    '/api/enterprises',              // members only; here for its 404 when switched off
    '/api/enterprises/map',          // members only; here for its 404 when switched off
    '/api/map/enterprises',          // members only; here for its 404 when switched off
    '/api/treasuries/map',           // members only; here for its 404 when switched off
    '/api/commons/decisions',        // members only (MEMBERS_ONLY_READS_EXACT)
    '/api/invite/check',             // onboarding: pre-membership invite pre-flight (rate-limited)
    '/api/attest',                   // registrar attestation: signed proof this node holds its identity
    '/api/marketplace/posts',        // marketplace board: public only with the visitors' view on (PUBLIC_ONLY_ON_GUEST_LISTINGS_EXACT)
    '/api/federation/reachable-peers', // compose-time list of neighbouring communities to reach out to
    '/api/pricing-guide',            // community pricing catalog and public multiplier
    '/api/pair/poll',                // ephemeral QR device pairing poll (pre-auth)
    '/api/channels/options',         // the platform/category vocabulary the channel form renders
    '/api/pulse/feed',               // members only (MEMBERS_ONLY_READS_EXACT)
    '/api/pulse/oauth/config',       // public platform OAuth availability configuration (The Pulse, Phase 5)
    '/api/node/info',                // federation discovery: name + counts + peer URLs, read cross-origin by peers' PWAs, which cannot sign there
    '/api/federation/links',         // link cards (energy balance per peer), public by design — see its handler in routes/community.ts
    '/api/node/identity-epoch',      // split-brain guard: the signed take-over count an old main server reads at its own address (services/identity-epoch.ts)
    '/api/global/communities',       // global node (G5): the mirrored communities directory, for anyone deciding where to join
    '/api/global/home',              // global node (G5): the landing card; a signed read adds the caller's own watches
    '/api/join/knock/status',        // ask to join (G6): the applicant, not a member here, reads their own knock; answers only a signed request, for the signer
    '/api/home',                     // Home in one read: public only with the visitors' view on, and then the visitors' subset (HOME_READ_EXACT)
]);
/**
 * The peer protocol's own paths, which the gateway's usual buckets leave alone: the public reads another community's
 * server makes of this one (a harvester's counts, a take-over's health check), which may come in a burst from one
 * address. They have a generous bucket of their own per address instead (gateway-rate-limit.ts gatewayAdmitPeerRead,
 * five times the usual minute), and answer from cached counts (state-engine communityCountsCached,
 * getPublicCommunityHealth): before, they had no ceiling and ran full-table counts on every hit (DoS review F4). Exact
 * paths, reads only, matched as sent. Everything else under /api/federation/ and /api/community/ is
 * charged like any other request: before W-main the gateway exempted both whole prefixes, so a member's own signed
 * purchase, commission, registration or area there was not limited at all (design scratch/global-node/
 * DESIGN-replica-flood-bounds-opus.md §2, §6.2). The peers' disabled verify and relay routes (federation-api.ts) are
 * deliberately not listed: a peer route that writes is charged when it comes back.
 */
export const GATEWAY_EXEMPT_PEER_READS: ReadonlySet<string> = new Set<string>([
    '/api/community/info',
    '/api/community/health',
]);
export function isPeerProtocolRead(ctx: { method: string; path: string }): boolean {
    return (ctx.method === 'GET' || ctx.method === 'HEAD') && GATEWAY_EXEMPT_PEER_READS.has(ctx.path);
}

// Precise patterns for the parameterized public routes. Kept deliberately tight
// (anchored, single path segment per `[^/]+`) so a broad prefix can't
// accidentally expose a sensitive neighbour — e.g. the DM-content reads
// (/api/messages/conversations/:pk, /api/messages/:conversationId) must stay
// GATED; only the E2E-ciphertext attachment binary is public.
export const PUBLIC_READ_PATTERNS: readonly RegExp[] = [
    /^\/api\/community\/membership\/[^/]+$/,                // onboarding: is this pubkey a member? (answered only to the key's own signer; the route refuses anyone else)
    /^\/api\/members\/callsign-available\/[^/]+$/,          // onboarding/wizard: check callsign availability (rate-limited)
    /^\/api\/crowdfund\/projects\/[^/]+$/,                  // members only (MEMBERS_ONLY_READS_PATTERNS); here for its 404 when switched off
    /^\/api\/treasury\/[^/]+$/,                             // members only; here for its 404 when switched off
    /^\/api\/enterprise\/[^/]+$/,                           // members only; here for its 404 when switched off
    /^\/api\/commons\/decisions\/[^/]+$/,                   // members only (MEMBERS_ONLY_READS_PATTERNS)
    /^\/api\/recovery\/lookup\/[^/]+$/,                     // pre-membership: the exact callsign's SSO recovery candidate, no photo (rate-limited)
    /^\/api\/marketplace\/posts\/[^/]+\/photos\/[^/]+$/,    // <img> binary (cannot send signature headers); keyed for every listing where the listings are members', and for a listing off the board where they are a public read (engine/photo-keys.ts)
    /^\/api\/messages\/[^/]+\/attachment$/,                 // E2E-ciphertext attachment binary for <img>
    /^\/api\/pulse\/items\/[^/]+\/thumbnail$/,              // <img> Pulse feed item thumbnail proxy binary
    /^\/api\/avatar\/[^/]+$/,                               // <img> member avatar binary
];

// Reads on the allowlist that name members, and so are members' reads on every node: off the allowlist, the ordinary
// gate answers them for a member of this node (passesReadGate, a suspended member included) and nobody else, a visitor's
// row and a signed non-member included, as it answers a local community's listings. Marty, 2026-09-28: "nothing on a
// private node should be public now that we have a global node"; on the global node (G9a) they were members' already.
// Each names people: a decision carries its author's key and can name a member in its params (a suspension, a
// removal), and the Pulse feed carries each member's key, name, face and their own pages elsewhere (Instagram, YouTube).
// A local community refuses them with the listings' code and the global community's address (COMMUNITY_MEMBERS_ONLY).
export const MEMBERS_ONLY_READS_EXACT: ReadonlySet<string> = new Set<string>([
    '/api/commons/decisions',
    '/api/pulse/feed',
]);
// And every read of the Beans constructs, the enterprises and treasuries (one construct), crowdfunds and Commons
// projects, where they are switched on (switched off, each answers 404 feature_off to everyone). Members only rather
// than stripped for a stranger, as a post is on the global node: each is people and money through and through. An
// enterprise names its keepers and their backing pledges (key, name, face, amount), who paused it, who is winding it up
// and who placed it, and its flow carries members' memos; a crowdfund names its creator, a project its proposer; each
// carries balances, and an enterprise its own face and exact place. A stranger's copy would be a second guestPost over
// some fifty fields, every new one a leak until someone decides; off the allowlist, a new field or a new public read
// under these prefixes is members-only already. The apps read a refused one as "none", as they do on a node with them
// off; a member's phone signs every read of its own community (native node-request-signing.ts), and the web app every
// read it makes with a key (lib/api.ts request). The node's own Settings list the enterprises with the admin password
// (GET /api/local/admin/treasury).
export const MEMBERS_ONLY_READS_PATTERNS: readonly RegExp[] = [
    /^\/api\/commons\/decisions\/[^/]+$/,
    /^\/api\/(treasury|treasuries|enterprise|enterprises)(\/|$)/,
    /^\/api\/map\/enterprises$/,
    /^\/api\/crowdfund(\/|$)/,
    /^\/api\/commons\/projects(\/|$)/,
];
// The Commons pot: a community total, and public on a local community, as its circulation and its counts are
// (/api/community/info). On a node that shows visitors the listings and not the people (`guestListingsOnly`, the global
// node, G9a) it is members' too: the pool belongs to a ledger a visitor has no part in, and the lobby has nothing of it
// to be transparent about.
export const MEMBERS_ONLY_ON_GUEST_LISTINGS_EXACT: ReadonlySet<string> = new Set<string>([
    '/api/commons/balance',
]);

// Public reads that are the listings, and public only on a node that shows visitors the listings and not the people
// (`guestListingsOnly`, the global node): there anyone looks around, in the visitors' view (rough areas, no people). On
// every other node, a local community's, the listings are its members' (Marty, 2026-09-28: "nothing on a private node
// should be public now that we have a global node"), so these fall to the ordinary gate: a signed read by a member of this
// node (passesReadGate, a suspended member included), and nobody else, a visitor's row and a signed non-member included.
// The refusal names the global community (LISTINGS_MEMBERS_ONLY), where the apps send a stranger to look around. A
// listing's photos keep their public route, because an `<img>` cannot sign, but here each is served only to a URL
// carrying its key, which only a read of the listing hands out (engine/photo-keys.ts). A linked peer's app browsing
// here unsigned (routes/marketplace.ts isPeerRequest) is refused too, until linked communities get signed access of
// their own.
export const PUBLIC_ONLY_ON_GUEST_LISTINGS_EXACT: ReadonlySet<string> = new Set<string>([
    '/api/marketplace/posts',
]);

// Home in one read (routes/home.ts, DESIGN-home-dashboard §5.3): public, like the listings, only on a node that shows
// visitors the listings and not the people (`guestListingsOnly`, the global node), where an unsigned reader or a key that
// is no member here gets the visitors' subset (the landing card, the listings and events in their rough areas, the
// community's counts). Everywhere else it is a member's own read, which the ordinary gate answers for a member of this
// node (passesReadGate) and refuses anyone else with the community's members-only words (COMMUNITY_MEMBERS_ONLY).
export const HOME_READ_EXACT: ReadonlySet<string> = new Set<string>([
    '/api/home',
]);

/** The refusal of a local community's listings to anyone but its members, which the apps turn into their sign-in page. */
export const LISTINGS_MEMBERS_ONLY = {
    error: "This community's listings are for its members. Join with an invite from a member, or look around the global community at global.beanpool.org.",
    code: 'members_only',
    global: 'https://global.beanpool.org',
} as const;

/**
 * The refusal of a local community's other members' reads (MEMBERS_ONLY_READS_*: its enterprises, Decisions, Commons
 * projects, crowdfunds and Pulse) to anyone but its members: the listings' code and the global community's address, in
 * words that fit any of them. The global node refuses them as any gated read, as before.
 */
export const COMMUNITY_MEMBERS_ONLY = {
    error: "This is for this community's members. Join with an invite from a member, or look around the global community at global.beanpool.org.",
    code: 'members_only',
    global: 'https://global.beanpool.org',
} as const;

function isListingsRead(path: string): boolean {
    const routed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    return PUBLIC_ONLY_ON_GUEST_LISTINGS_EXACT.has(routed);
}

function isAllowlisted(path: string): boolean {
    return PUBLIC_READ_EXACT.has(path) || PUBLIC_READ_PATTERNS.some(re => re.test(path));
}

// The router answers a path with one trailing slash as the path itself (@koa/router's default, strict: false), so this
// test does too, and `/api/pulse/feed/` is refused with the same words as `/api/pulse/feed`. Only a read on the
// allowlist: the gated reads under the same prefixes (an enterprise's ledger, its thread) keep the gate's usual answer.
function namesMembers(path: string): boolean {
    const routed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    return isAllowlisted(routed)
        && (MEMBERS_ONLY_READS_EXACT.has(routed) || MEMBERS_ONLY_READS_PATTERNS.some(re => re.test(routed)));
}

function isPublicRead(path: string): boolean {
    if (!isAllowlisted(path)) return false;
    // The switches are read only for these few paths, so no other request pays for them.
    // The listings: public only where visitors get the listings' view.
    if (PUBLIC_ONLY_ON_GUEST_LISTINGS_EXACT.has(path)) return getProfileSwitches().guestListingsOnly;
    // Home: the visitors' subset is public only there too.
    if (HOME_READ_EXACT.has(path)) return getProfileSwitches().guestListingsOnly;
    // The Commons pot: public everywhere but there.
    if (MEMBERS_ONLY_ON_GUEST_LISTINGS_EXACT.has(path)) return !getProfileSwitches().guestListingsOnly;
    if (!namesMembers(path)) return true;
    // A Beans read that is switched off names nobody: it answers 404 feature_off to everyone (profileFeatureGate), a
    // stranger as a member.
    return featureOffFor(path) !== null;
}

/**
 * What the gate answers someone it refuses one of a local community's members' reads, the listings and the rest: their
 * code and the global community's address, which the apps turn into their sign-in page. Null for any other gated read,
 * and for these on a node with the visitors' view, whose refusal says nothing more.
 */
function membersOnlyRefusal(path: string): typeof LISTINGS_MEMBERS_ONLY | typeof COMMUNITY_MEMBERS_ONLY | null {
    if (isListingsRead(path)) return LISTINGS_MEMBERS_ONLY;
    const routed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    if (HOME_READ_EXACT.has(routed) && !getProfileSwitches().guestListingsOnly) return COMMUNITY_MEMBERS_ONLY;
    if (namesMembers(path) && !getProfileSwitches().guestListingsOnly) return COMMUNITY_MEMBERS_ONLY;
    return null;
}

// Gated reads that are nothing but what only members may read, so the gate asks readsAsMember of the signer rather than
// passesReadGate: a suspended or disabled member, who gets past the gate to their own account, is refused these as a
// non-member is. The activity feed names both members of every completed trade, the listing and the Beans, and each
// member who joins, and serves the same body to every reader it lets in.
const MEMBER_READS_ONLY_EXACT: ReadonlySet<string> = new Set<string>([
    '/api/activity/feed',
]);

/**
 * Whether a verified signer may make this gated read (ENFORCE_READ_AUTH). A member who passes the gate (passesReadGate:
 * suspended and disabled members included, for their own account and what suspension leaves them) makes any gated read
 * but the members-only ones, which need readsAsMember. A visitor makes only its own (visitorsOwnRead, beside what it may
 * write in visitor-allowlist.ts). Nobody else makes
 * one: a key with no row, a pruned account's and a replaced key's (refused before this, for every request).
 */
function gatedReadAllowed(path: string, query: Record<string, unknown>, signer: string): boolean {
    if (MEMBER_READS_ONLY_EXACT.has(routedPath(path))) return readsAsMember(signer);
    if (passesReadGate(signer)) return true;
    return isLiveVisitor(signer) && visitorsOwnRead(path, query, signer);
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
        // A socket sending more than the apps' heartbeat ever does is closed (ws-limits.ts). A frame over the cap never
        // gets here: ws refuses it (maxPayload) and closes the socket with 1009.
        if (!frameAllowed(ws)) {
            try { ws.close(1008, 'Too many messages'); } catch { /* already closing */ }
            return;
        }
        const conn = activeConnections.get(id);
        if (conn) {
            conn.msgRecvCount++;
            conn.lastActivityAt = Date.now();

            // Bytes, never a whole-frame string: a frame is decoded only when small (the heartbeat below), and the
            // admin log's preview only from its first bytes, and only while someone is watching the log.
            const bytes: Buffer = Buffer.isBuffer(data) ? data
                : typeof data === 'string' ? Buffer.from(data)
                    : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
            let watching = false;
            for (const client of logClients) if (client.readyState === 1 && client !== ws) { watching = true; break; }
            if (watching) {
                let preview = bytes.subarray(0, 150).toString('utf8');
                if (bytes.length > 150) preview += '...';

                const trafficPayload = JSON.stringify({
                    type: 'ws_traffic',
                    data: {
                        id,
                        direction: 'in',
                        size: bytes.length,
                        preview
                    }
                });

                for (const client of logClients) {
                    if (client.readyState === 1 && client !== ws) { // OPEN
                        try { client.send(trafficPayload); } catch {}
                    }
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
            if (type === 'sync' && bytes.length < 256 && bytes.includes('wantPong')) {
                try {
                    const msg = JSON.parse(bytes.toString('utf8'));
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
 * The admin surface: the Settings pages and every route the admin password or an admin session opens. The admin IP
 * allowlist guards exactly these, and a listed CORS origin gets no credentials on them (Fable's web review, L6).
 * Matched ignoring case and after normalising, so no spelling of a path is treated more loosely than another.
 */
export function isAdminSurfacePath(requestPath: string): boolean {
    const p = path.posix.normalize(requestPath.toLowerCase()).replace(/\/+$/, '') || '/';
    return p === '/settings' ||
        p.startsWith('/settings/') ||
        p === '/settings-legacy' ||
        p === '/settings.js' ||
        p === '/api/local/admin' ||
        p.startsWith('/api/local/admin/') ||
        p === '/api/admin' ||
        p.startsWith('/api/admin/') ||
        p === '/api/local/verify-password' ||
        p === '/api/local/dashboard' ||
        p === '/api/local/update-identity' ||
        p === '/api/local/change-password' ||
        p === '/api/local/reset' ||
        p === '/api/local/connectors' ||
        p.startsWith('/api/local/connectors/') ||
        p.startsWith('/api/local/federation/') ||
        p === '/api/manager' ||
        p.startsWith('/api/manager/') ||
        p === '/api/pricing-guide/admin' ||
        p.startsWith('/api/pricing-guide/admin/') ||
        // The price-report queue (routes/pricing-guide.ts, checkAdminAuth): reporters' keys and comments. Not the
        // singular /api/pricing-guide/report, a member's own report.
        p === '/api/pricing-guide/reports' ||
        p.startsWith('/api/pricing-guide/reports/');
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

const UPGRADE_STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 429: 'Too Many Requests', 503: 'Service Unavailable' };

/** Answer an upgrade with a plain HTTP refusal and close it. */
function refuseUpgrade(socket: Duplex, status: 401 | 429 | 503, retryAfterSec?: number): void {
    const retry = retryAfterSec ? `Retry-After: ${retryAfterSec}\r\n` : '';
    try { socket.write(`HTTP/1.1 ${status} ${UPGRADE_STATUS_TEXT[status]}\r\n${retry}Connection: close\r\n\r\n`); } catch { /* gone already */ }
    socket.destroy();
}

/** How long a socket let in only to be told "no room" may take to answer the close before it is dropped. */
const NO_ROOM_CLOSE_GRACE_MS = 5_000;

/**
 * A /ws socket over a cap (ws-limits.ts). Where the caps say `noRoomClose` (the global node) and its address has room
 * for one more such answer this minute (gateway-rate-limit.ts gatewayNoRoomUpgrade, which gives back what the upgrade
 * was charged), the upgrade completes and closes at once with the "no room" close and its wait, which the apps read
 * (@beanpool/core wsNoRoomRetrySec): it is never added to the feed, holds no place, and is dropped if it doesn't answer
 * the close. Otherwise (a client that did not send `nr=1`, or a node without the close) the old refusal: `status` before the upgrade, as charged.
 */
function refuseSocketForRoom(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, client: string,
    maxReqs: number, charges: ReadonlyArray<GatewayCharge | null>, status: 429 | 503, understandsNoRoom: boolean): void {
    // Only a client that says it reads the close (`nr=1` on its connect URL) gets it: an app built before it resets its
    // backoff and syncs on every socket that opens, so against the close it would retry every few seconds.
    if (!understandsNoRoom || !wsLimits().noRoomClose || !gatewayNoRoomUpgrade(client, maxReqs, charges)) {
        refuseUpgrade(socket, status, 30);
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws: any) => {
        const drop = setTimeout(() => { try { ws.terminate(); } catch { /* gone already */ } }, NO_ROOM_CLOSE_GRACE_MS);
        drop.unref?.();
        ws.on('close', () => clearTimeout(drop));
        ws.on('error', () => { /* a client that vanished: the close above still ends it */ });
        ws.close(WS_NO_ROOM_CLOSE_CODE, wsNoRoomReason(WS_NO_ROOM_RETRY_SEC));
    });
}

/** Hold a socket's place (ws-limits.ts) until its raw socket closes, whichever way: a refused handshake or the end of a
 *  live socket. */
function holdUntilClosed(socket: Duplex, release: () => void): void {
    socket.once('close', release);
    if (socket.destroyed) release();
}

/** Whether a /ws upgrade carries any of the connect token's signature parameters (verifyWsConnect). */
function claimsWsSignature(params: URLSearchParams): boolean {
    return params.has('pubkey') || params.has('sig') || params.has('ts') || params.has('nonce');
}

function createUpgradeHandler(wss: WebSocketServer, logsWss: WebSocketServer): UpgradeHandler {
    return async (req, socket, head) => {
        const reqUrl = req.url || '';
        const parsedUrl = new URL(reqUrl, 'https://localhost');
        const pathname = parsedUrl.pathname;
        // DoS review F1: every upgrade is a request to the gateway limiter (gateway-rate-limit.ts), by the rules an HTTP
        // request is charged by, and a /ws socket is held to the caps in ws-limits.ts.
        const client = limiterKeyForIp(resolveClientIp(req.socket.remoteAddress, req.headers));
        const gw = getGatewayConfig();
        const limited = !!gw.rateLimiting?.enabled;
        const maxReqs = gw.rateLimiting?.maxRequestsPerMinute ?? 120;

        if (pathname === '/ws') {
            // The node's room first, before a token is verified or anything is charged.
            if (!wsHasRoom()) { refuseSocketForRoom(wss, req, socket, head, client, maxReqs, [], 503, parsedUrl.searchParams.get('nr') === '1'); return; }
            const claims = claimsWsSignature(parsedUrl.searchParams);
            const admitted = limited ? gatewayAdmitUpgrade(client, maxReqs, claims) : { wait: 0, claimed: false, charge: null };
            if (admitted.wait) { refuseUpgrade(socket, 429, admitted.wait); return; }
            // SRV-4: see WS_AUTH_MODE for what each kind of connect gets.
            const connect = verifyWsConnect(pathname, parsedUrl.searchParams);
            let settled: GatewayCharge | null = null;
            if (limited) {
                // A verified key is charged as HTTP charges it: its own bucket if it acts here, else the address's.
                const verified = connect.kind === 'member' ? { key: connect.pubkey, acts: true }
                    : connect.kind === 'non_member' ? { key: connect.pubkey, acts: false } : null;
                const { wait, charge } = gatewaySettleUpgrade(client, maxReqs, admitted.claimed, verified);
                if (wait) { refuseUpgrade(socket, 429, wait); return; }
                settled = charge;
            }
            const refuse = WS_AUTH_MODE === 'strict'
                ? connect.kind !== 'member'
                : WS_AUTH_MODE === 'members' && connect.kind === 'invalid';
            if (refuse) {
                refuseUpgrade(socket, 401);
                return;
            }
            // A member's (or a visitor's row's) socket is held to its key's cap; any other, which gets only the public
            // doorbells (or the open feed, where the operator chose it), is a stranger's, under the tighter caps.
            const place = admitWsSocket(client, connect.kind === 'member' ? { kind: 'keyed', key: connect.pubkey } : { kind: 'stranger' });
            if (!place.ok) {
                refuseSocketForRoom(wss, req, socket, head, client, maxReqs, [admitted.charge, settled], place.status, parsedUrl.searchParams.get('nr') === '1');
                return;
            }
            holdUntilClosed(socket, place.release);
            wss.handleUpgrade(req, socket, head, (ws: any) => {
                ws.isAlive = true;
                ws.on('pong', () => { ws.isAlive = true; });
                // A2-20: tag the socket with its verified member so broadcast() can scope
                // sensitive events to the parties. A socket without one gets only the public
                // doorbell, unless the operator chose the open feed. A valid signature from a
                // key that is not a member yet (someone mid-join) is remembered, so the socket
                // is promoted when that key's member_joined goes out, if the key is a member by
                // then. `_memberFeed`: the member feed, for a key that reads as a member.
                ws._memberPubkey = connect.kind === 'member' ? connect.pubkey : null;
                ws._visitor = connect.kind === 'member' && connect.visitor;
                ws._memberFeed = connect.kind === 'member' && connect.feed;
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
            // Charged as an unsigned request: an admin opens one now and then, and a flood of made-up tickets stops here.
            const wait = limited ? gatewayAdmitUpgrade(client, maxReqs, false).wait : 0;
            if (wait) { refuseUpgrade(socket, 429, wait); return; }
            // A single-use ticket from POST /api/local/admin/ws-ticket (checkAdminAuth), and nothing else. The admin
            // password in the query string (`?auth=`) is no longer taken: a URL lands in the tunnel's, proxies' and
            // browsers' logs and history, and no client has sent one since the tickets (Fable's web review, L5).
            const ticket = parsedUrl.searchParams.get('ticket');
            const authorized = !!ticket && isValidWsTicket(ticket);

            if (!authorized) {
                refuseUpgrade(socket, 401);
                return;
            }
            const release = admitLogSocket();
            if (!release) { refuseUpgrade(socket, 503, 30); return; }
            holdUntilClosed(socket, release);
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
        p.startsWith('/api/pair/') ||
        p.startsWith('/api/pricing-guide/admin/') ||
        p.startsWith('/api/pricing-guide/reports') ||
        p === '/api/invite/redeem' ||
        p === '/api/invite/redeem-offline' ||
        // A leave statement carries the leaving key's own signature (routes/community.ts); it is presented unsigned.
        p.startsWith('/api/push-tokens/leave/');
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

/**
 * The answer to every signed request from a key whose account here was closed (isClosedAccountKey: its member row is
 * 'pruned'). Two paths write that, and both keep the row:
 * - removal, `adminPruneUser`: by an admin (prune, prune branch, the offboarding wizard) or by a `remove_member` vote,
 *   including the one its grace period carries out on its own;
 * - self-delete, `purgeMemberSelf` (`/api/member/purge`).
 * The knock door's code and the first half of its sentence (routes/knocks.ts `account_closed`); the rest as the replaced
 * key's sentence above.
 *
 * One place, as for a replaced key (4109713263). Each review round found one more engine function whose author branch
 * never asked whether the author was still a member (updatePost's convenor branch, then its author branch and
 * resumePost): a pruned account brought back its own paused event, moved it, and everyone going was pushed. The prune
 * already assumed this rule ("a pruned account can no longer sign a request": the area clear, the channel scrub, place
 * watches); this makes it true. Writes and reads alike: a closed account's "own data" is posts, a profile and a name
 * other members see.
 *
 * Not refused: a key with no member row (a stranger, a knock, a join; each route allows it what it did) and any other
 * status, 'suspended' and 'disabled' included (suspension is a separate rule, left to the routes).
 *
 * No other flow needs a closed account's key to sign:
 * - the way back from a removal is a `reinstate_member` vote, which live members propose and cast and the engine
 *   carries out (decisions-engine.ts), and after which this key signs again;
 * - the key can't come back by any door: the join doors and knocks refused it already, and invite redemption (which
 *   this middleware never sees) refuses it itself;
 * - its push tokens and place watches went with the prune or the delete.
 * **The one exception: its own Delete account, `POST /api/member/purge`** (isOwnDeleteAccount). A member the community
 * removed keeps their profile here, so a vote could bring them back; tapping Delete account erases it (Marty's card
 * removed-member-delete, 2026-09-27: "Erase their profile"), and after that nothing brings the account back
 * (purgeMemberSelf, state-engine.ts isDeletedByOwner). A retry after a lost reply, or an account its owner already
 * deleted, is answered as before ("Account is already pruned") and changes nothing: both apps wipe the phone only after a
 * 2xx (native purgeAccountOnNode, the PWA's SettingsPage), so a refusal would leave the key and its data on the phone
 * (#1177's 3c, 4109841495). The route acts for the signer alone (ctx.state.actor, never the body), the spoof check below
 * still holds the body to the signer, and no activity is stamped on the closed row. Nothing else it can do changes. A
 * replaced key is still refused first (REPLACED_KEY_REFUSAL).
 * The routes this middleware never sees keep their own checks: the admin surface (a session follows node_roles on
 * every request, and a prune deletes the role), device pairing (a relay that knows no member), invite redemption. A
 * flow that ever must take a closed account's key is named here, with its reason.
 */
const CLOSED_ACCOUNT_REFUSAL = 'This key’s account in this community was closed, so the community no longer accepts it.';

/** The one request a closed account's key may sign (CLOSED_ACCOUNT_REFUSAL): deleting its own account. */
function isOwnDeleteAccount(method: string, path: string): boolean {
    return method === 'POST' && path.replace(/\/+$/, '').toLowerCase() === '/api/member/purge';
}

// The administrative rate limiter's buckets (its middleware is in startHttpsServer): each client's requests in the last minute.
const adminRateLimits = new Map<string, number[]>();
/** The administrative requests one client may make in a window (adminRateWindowMs). */
export const ADMIN_RATE_LIMIT = 300;
/**
 * The administrative limiter's window: a minute. A suite (NODE_ENV=test) may scale it down with ADMIN_RATE_WINDOW_MS, to
 * prove a standby's pace against it in seconds (test-standby-paged-copies-pacing.ts); nothing else can, so no .env loosens it.
 */
export function adminRateWindowMs(): number {
    const scaled = Number(process.env.ADMIN_RATE_WINDOW_MS);
    return process.env.NODE_ENV === 'test' && Number.isFinite(scaled) && scaled > 0 ? scaled : 60 * 1000;
}
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
    checkEnvAddresses();
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

    // A database, network or bug's text in an answer outside the operator's routes is a server fault: replaced by fixed
    // words and answered 500, over every route and gate below (routes/member-error-text.ts).
    app.use(scrubServerFaults());

    // A Commons pot that isn't a number pauses every Bean move (engine/audit.ts CommonsPotUnknownError). A route that lets
    // that refusal through is answered in its plain words with 503, not Koa's "Internal Server Error" (#1465 review).
    app.use(async (ctx, next) => {
        try {
            await next();
        } catch (e) {
            if (!(e instanceof CommonsPotUnknownError)) throw e;
            ctx.status = 503;
            ctx.body = { error: e.message, code: e.code };
        }
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
                // Explicitly allowed origin: its own origin, and credentials (the member's cookie-free API needs none, but
                // a site the operator lists may send them). Never on the admin surface: a listed site (a community page
                // someone else hosts, say) must not be able to read or change the admin API with the operator's signed-in
                // cookie (Fable's web review, L6). It may still call it with a credential it sends itself, the password
                // in a header, as any server can.
                ctx.set('Access-Control-Allow-Origin', requestOrigin);
                ctx.vary('Origin');
                if (!isAdminSurfacePath(ctx.path)) ctx.set('Access-Control-Allow-Credentials', 'true');
                ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Admin-Password, x-admin-password, X-CSRF-Token, x-csrf-token, x-signature, x-public-key, x-timestamp, x-nonce, x-signed-for');
                ctx.set('Access-Control-Expose-Headers', 'X-CSRF-Token');
                ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
            } else if (isWildcardAllowed) {
                // Wildcard allowed: set '*' origin, DO NOT set Access-Control-Allow-Credentials to true
                ctx.set('Access-Control-Allow-Origin', '*');
                ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Admin-Password, x-admin-password, X-CSRF-Token, x-csrf-token, x-signature, x-public-key, x-timestamp, x-nonce, x-signed-for');
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
            if (isAdminSurfacePath(ctx.path)) {
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
        //    plane (its own limiter) and the peer protocol's own reads (GATEWAY_EXEMPT_PEER_READS), and nothing
        //    else under /api/federation/ or /api/community/: a purchase, a commission, a registration or an area
        //    is a member's own request and is charged like any other (W-main).
        //    The peer protocol's reads have a generous bucket of their own per address (gatewayAdmitPeerRead, DoS review
        //    F4): exempt from the others, they had no ceiling at all.
        const peerRead = isPeerProtocolRead(ctx);
        const limited = !!gwConfig.rateLimiting?.enabled && !ctx.path.startsWith('/api/local/admin/') && !peerRead;
        if (limited) {
            // #132: Use nullish coalescing so a falsy (0) value doesn't silently fall back to the default
            const maxReqs = gwConfig.rateLimiting.maxRequestsPerMinute ?? 120;
            const claimsSignature = !!ctx.get('X-Public-Key') && !!ctx.get('X-Signature') && !isSignatureBypassed(ctx.path);
            if (!gatewayAdmit(ctx, maxReqs, claimsSignature)) return;
        } else if (peerRead && gwConfig.rateLimiting?.enabled) {
            if (!gatewayAdmitPeerRead(ctx, gwConfig.rateLimiting.maxRequestsPerMinute ?? 120)) return;
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
                const windowMs = adminRateWindowMs(); // 1 minute
                const limit = ADMIN_RATE_LIMIT; // max 300 administrative requests per minute

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
        const windowMs = adminRateWindowMs();
        pruneGatewayBuckets(now);
        for (const [ip, timestamps] of adminRateLimits) {
            const valid = timestamps.filter(t => now - t < windowMs);
            if (valid.length === 0) adminRateLimits.delete(ip);
            else adminRateLimits.set(ip, valid);
        }
        pruneAuthAttempts(now);
        pruneChatLines(now);
        requestNonces.prune(now);
    }, 60 * 1000);
    if (rateLimitCleaner.unref) rateLimitCleaner.unref();
    // The open door's sign-up limiter keeps hashed addresses in the database, not in memory: they are cleared once
    // a day old on this timer too, not only when somebody joins (engine/open-join.ts).
    startForgettingJoinAddresses();
    // Nobody's internet address is kept longer than 7 days: the copying routes' access list, the standby watch and the
    // take-over keys' holders forget theirs, now (the first boot of a version clears older ones) and hourly after
    // (services/address-retention.ts).
    startForgettingOldAddresses();
    // The log keeps its newest 2,500 lines and none older than 30 days, now and hourly after, on every server: a quiet one
    // writes no hundredth line for weeks (logger.ts startSystemLogRetention).
    startSystemLogRetention();
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
                // A signature claim the gateway let in as small carries a small body at most (gateway-rate-limit.ts
                // CLAIM_SMALL_BODY_BYTES), whatever its length said. One it let in as possibly large is charged to its
                // address's unverified claims once more than that has been read, never for what it only declared.
                const claimLimit = ctx.state.gatewayBodyLimit as number | undefined;
                const routeLimit = Math.min(routeBodyLimit(ctx.path.toLowerCase()), claimLimit ?? Infinity);
                const declaredLen = Number(ctx.get('content-length'));
                if (Number.isFinite(declaredLen) && declaredLen > routeLimit) {
                    ctx.status = 413;
                    ctx.body = { error: 'Request body too large' };
                    return;
                }
                const pastSmall = ctx.state.gatewayLargeClaim ? () => gatewayChargeLargeClaim(ctx) : undefined;
                try {
                    const body = await readBody(ctx.req, routeLimit, pastSmall);
                    (ctx as any).rawBody = body;  // X-1: exact bytes the client signed
                    const parsed = JSON.parse(body);
                    (ctx as any).requestBody = parsed;
                    // Koa core does NOT parse request bodies, and this server mounts no bodyparser
                    // middleware, so `ctx.request.body` is undefined unless it is set right here.
                    // Fourteen handlers across routes/pairing.ts, routes/pricing-guide.ts and the fleet
                    // manager's backup routes (deleted 2026-10-02) read the `ctx.request.body` spelling — every one of
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
                    if (e instanceof BodyRefusedError) return; // gatewayChargeLargeClaim answered 429
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
                const refusal = isGatedRead ? membersOnlyRefusal(ctx.path) : null;
                ctx.body = refusal ? { ...refusal } : { error: 'Missing cryptographic signature headers' };
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

        // One key, one spelling (engine/member-key.ts). The signature is checked by decoding X-Public-Key's hex, which
        // forgives case and stops at the first character that isn't hex, so one keypair signed as `ab12…`, `AB12…` and
        // `ab12…zz`, and each was a different key to every lookup below and in every route: a second member row, a
        // second vote. The signer is taken in the member table's spelling, lower case, for everything from here on (the
        // actor, the replaced-key and closed-account refusals, the visitor gate, the spoof check); anything but 64
        // hexadecimal characters is refused before any lookup, the nonce unspent.
        const signerKey = provenKeySpelling(pubKeyHex);
        if (!signerKey) {
            ctx.status = 400;
            ctx.body = { error: BAD_SIGNER_KEY_ERROR, code: BAD_KEY_CODE };
            return;
        }

        // Request binding (engine/member-signature.ts): freshness, then the signature over the bytes the request's
        // format names (format 2 when it carries X-Signed-For, the old bytes when not), then the community it was
        // signed for (421 wrong_community for another's host; 426 app_too_old for the old format after the
        // switch), and only then the nonce is spent: a forged request can't burn a real one, and a request refused
        // for naming another community leaves its nonce unspent. Outside the try below, so the route that runs after
        // an answer-as-unsigned is never inside it.
        const signedForHeader = ctx.headers[SIGNED_FOR_HEADER.toLowerCase()];
        const signedFor = typeof signedForHeader === 'string' ? signedForHeader : Array.isArray(signedForHeader) ? signedForHeader.join(',') : null;
        const verdict = verifyMemberSignature({
            pubKeyHex: signerKey,
            signature: signatureBase64,
            timestamp: timestampHeader,
            nonce,
            method: ctx.method,
            path: ctx.path,
            body: (ctx as any).rawBody ?? '',
            signedFor,
        }, { consumeNonce: true });
        // An old app's signature on a PUBLIC read after the switch is answered as that read unsigned, which anyone
        // may send: every app before binding signs its GETs to its node (native node-request-signing.ts), and it
        // reads its "update BeanPool" banner's minimum version from /api/community/health. A 426 there would hide
        // the one message that tells the member what to do. Its gated reads and writes are refused (426) below.
        if (!verdict.ok && verdict.status === 426 && !isMutatingApi && !isGatedRead && !isOptionallySignedWrite) {
            return await next();
        }
        if (!verdict.ok) {
            ctx.status = verdict.status;
            ctx.body = verdict.code ? { error: verdict.error, code: verdict.code } : { error: verdict.error };
            return;
        }
        // The signature is good: the address's unverified claim, if it was charged one, is given back (gateway-rate-limit.ts
        // `claim:`). What the key may do, and which bucket it is charged to, is decided from here on.
        gatewayClaimVerified(ctx);

        // A closed account's key (isClosedAccountKey), which reaches a route only to delete its own account.
        let closedAccount = false;
        try {
            const signedMessage = verdict.text;

            // A key a re-key replaced signs nothing here, write or read (REPLACED_KEY_REFUSAL). Only once the signature
            // checks out, so a forged request learns nothing about which keys are replaced.
            if (isInvalidatedKey(signerKey)) {
                ctx.status = 403;
                ctx.body = { error: REPLACED_KEY_REFUSAL, code: 'key_invalidated' };
                return;
            }
            // Nor does a key whose account here was closed, removed or deleted by its owner (CLOSED_ACCOUNT_REFUSAL), but for
            // the one exception: deleting its own account (isOwnDeleteAccount), which reaches the route, stamping no activity.
            closedAccount = isClosedAccountKey(signerKey);
            if (closedAccount && !isOwnDeleteAccount(ctx.method, ctx.path)) {
                ctx.status = 403;
                ctx.body = { error: CLOSED_ACCOUNT_REFUSAL, code: 'account_closed' };
                return;
            }
            // Nor does a visitor's row write anything the rule doesn't give it (visitor-allowlist.ts VISITOR_WRITES): its own
            // direct conversations, its phone's pushes, Beans it holds, taking its own listing down, deleting its own row and
            // the join doors. One place, as for a closed account:
            // three review rounds each found one more function that let such a row act as a member (a pledge, a keeper's
            // row, a node role). Answered as a visitor's refused write was (a key with no row's words where a route has
            // them), before the actor is bound and before any activity is stamped. Reads keep the read gate below.
            if (MUTATING_METHODS.has(ctx.method) && visitorWriteRefused(ctx.method, ctx.path, (ctx as any).requestBody, signerKey)) {
                ctx.status = 403;
                ctx.body = { error: NOT_A_MEMBER_ERROR, code: NOT_A_MEMBER_CODE };
                return;
            }

            // Bind cryptographically verified public key to state actor, in the member table's spelling
            ctx.state.actor = signerKey;

            // SRV-20: stash the verified signing material so a route that creates a
            // transaction can persist it on the row (auth_signer/signature/payload),
            // making the transaction's authorship re-verifiable by any importing node.
            // `payload` is the text signed; in format 2 the signed bytes are 0xFF then that text (engine/sync.ts
            // verifyTransactionAuthorship puts it back); @beanpool/core parseSignedText reads either format.
            ctx.state.authSig = { signer: signerKey, signature: signatureBase64, payload: signedMessage };

            // SRV-2/SRV-4: a valid signature only proves possession of *some*
            // keypair — an attacker can mint one. For gated reads, require the
            // signer to be a member of this node (gatedReadAllowed: passesReadGate,
            // and readsAsMember for the members-only reads) so the directory,
            // balances, ledger and social graph aren't readable by an anonymous key,
            // and a visitor's row reads only its own messages and Beans.
            // (The old key of a member being re-keyed, a lost or stolen phone, and a
            // closed account's key were refused above, for every request, so a
            // pruned account no longer reads as a member would on a node without the
            // visitors' view. Writes otherwise keep their own per-route authorization;
            // membership isn't required there — e.g. first-time registration.)
            if (isGatedRead && !gatedReadAllowed(ctx.path, ctx.query as Record<string, unknown>, signerKey)) {
                ctx.status = 403;
                const refusal = membersOnlyRefusal(ctx.path);
                ctx.body = refusal ? { ...refusal } : { error: 'Read access requires a member identity' };
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
                
                // Held to the signer's one spelling, so a route reading its own identity field never sees another
                // spelling of the actor. The signer's own key in capitals is told so in a plain sentence (400 bad_key);
                // anything else is the mismatch below.
                if (isIdentityField && !isOtherEntity && typeof value === 'string' && value !== signerKey
                    && provenKeySpelling(value) === signerKey) {
                    ctx.status = 400;
                    ctx.body = { error: BAD_KEY_ERROR, code: BAD_KEY_CODE };
                    return;
                }
                if (isIdentityField && !isOtherEntity && typeof value === 'string' && value !== signerKey) {
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
        // from a body field — an unsigned request naming the lead must not stamp them active (PR #838 B2). Never on a
        // closed account, whose one request (its own Delete account) is no sign of a member back.
        if (ctx.state.actor && MUTATING_METHODS.has(ctx.method) && !closedAccount) {
            try { recordActivity(ctx.state.actor); } catch (e: any) { console.warn('[Activity] could not record:', e?.message || e); }
        }

        await next();
    }
    app.use(requireSignature);

    // The app's version (X-BeanPool-App), counted for the verified signer only, a member or a visitor's row, for the
    // manager's counts of who runs what (app-version-counts.ts): in memory, never refusing or slowing anything. An app below
    // the community's floor keeps working with the server; only the app itself stops, at a safe moment.
    app.use(async (ctx, next) => {
        const actor = ctx.state.actor as string | undefined;
        if (actor) noteAppVersion(actor, ctx.get(APP_VERSION_HEADER), k => isNodeMember(k) || isLiveVisitor(k));
        await next();
    });

    // The gateway limiter's member bucket: charged only once the signature above has been verified. Then the key's
    // day budget for writes (W-main), whether or not the minute throttle is on: an enterprise's own and the signer's
    // enterprise work, when the write's path names one the signer keeps (routes/money-limits-gate.ts enterpriseActingFor)
    // and its own day has room, and the signer's own otherwise; a shop's governance and settling always the signer's own
    // (gateway-rate-limit.ts ENTERPRISE_GOVERNANCE_WRITE).
    // A verified key that isn't a member here (nor a visitor's row) is charged to its address as unsigned traffic
    // (gateway-rate-limit.ts, global-abuse review M-4): minting a keypair for each request buys nothing.
    app.use(async (ctx, next) => {
        const gwConfig = getGatewayConfig();
        const actor = ctx.state.actor as string | undefined;
        const acts = !!actor && !!ctx.state.gatewaySignedClaim && (isNodeMember(actor) || isLiveVisitor(actor));
        if (!gatewayAdmitMember(ctx, gwConfig.rateLimiting?.maxRequestsPerMinute ?? 120, acts)) return;
        const enterprise = ctx.state.actor && ctx.method !== 'GET' && ctx.method !== 'HEAD' && ctx.method !== 'OPTIONS'
            ? enterpriseActingFor(ctx.state.actor as string, ctx.path) : null;
        if (!gatewayAdmitDayBudget(ctx, Date.now(), enterprise)) return;
        await next();
    });

    // The routes a node profile switch has turned off (Beans, escrow, enterprises and treasuries, crowdfunds)
    // answer 404 feature_off before any handler runs (routes/profile-feature-gate.ts).
    app.use(profileFeatureGate);
    // On a standby, a write that moves Beans or steps a trade answers 409 standby before any handler runs
    // (routes/standby-ledger-gate.ts): its ledger is its main server's.
    app.use(standbyLedgerGate);
    // The money limits (W-money, engine/money-limits.ts): a payment, a marketplace request or a pledge change past its
    // account's day answers 429 before any handler runs, and one the handler refuses gives its count back.
    app.use(moneyLimitsGate);

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
        createOffboxBackupRoutes(deps),
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
        createAppAddressesRoutes(deps),
        createKeeperRoutes(deps),
        createOpenJoinRoutes(deps),
        createGlobalDirectoryRoutes(deps),
        createKnockRoutes(deps),
        createNoticeRoutes(deps),
        createBlockRoutes(deps),
        createAppleReturnRoutes(),
        createChannelRoutes(deps),
        createNodeAdminRoutes(deps),
        createSettingsSigninRoutes(deps),
        createRecoveryCollectRoutes(deps),
        createPairingRoutes(deps),
        createPricingGuideRoutes(deps),
        createActivityRouter(deps),
        createHomeRoutes(deps),
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
                    useAppDocumentPolicy(ctx); // the manager: no inline script (app-document-csp.ts)
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
                    useAppDocumentPolicy(ctx);
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
                    // A person opening the web app is one visit a day's count holds (engine/web-visits.ts): no address,
                    // browser or cookie is kept. Its files, the API, Settings and the manager never reach this line.
                    countWebAppPageLoad(ctx);
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
        // DoS review F3: the header and request timeouts (server-limits.ts).
        ...serverTimeoutOptions(),
    };

    return new Promise<number>((resolve) => {
        const server = https.createServer(serverOptions, app.callback());
        applyServerLimits(server);

        // WebSocket upgrade handler (shared with the plain HTTP server — see createUpgradeHandler). A frame over
        // ws-limits.ts's cap (4 KiB; ws's own default is 100 MiB) is refused by ws, which closes the socket with 1009.
        const maxPayload = wsLimits().maxPayloadBytes;
        const wss = new WebSocketServer({ noServer: true, maxPayload });
        const logsWss = new WebSocketServer({ noServer: true, maxPayload });
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
/** `pastSmall` refused the body: the response is already set. */
class BodyRefusedError extends Error { constructor() { super('Request body refused'); this.name = 'BodyRefusedError'; } }

/**
 * `pastSmall`, when given, is asked once, as the body read passes CLAIM_SMALL_BODY_BYTES (a signature claim the gateway
 * charges only then, gatewayChargeLargeClaim); false stops the read as BodyRefusedError.
 */
function readBody(req: import('node:http').IncomingMessage, maxBytes: number = MAX_JSON_BODY_BYTES, pastSmall?: () => boolean): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        req.on('data', (chunk: Buffer) => {
            if (aborted) return; // already over limit — discard without buffering
            total += chunk.length;
            if (pastSmall && total > CLAIM_SMALL_BODY_BYTES) {
                const go = pastSmall();
                pastSmall = undefined;
                if (!go) {
                    aborted = true;
                    reject(new BodyRefusedError()); // as for an over-limit body, stop buffering without destroying the socket
                    return;
                }
            }
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

