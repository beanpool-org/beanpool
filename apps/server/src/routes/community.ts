/**
 * Community, Auth, Members, Invites, Profiles, Ledger, Trust, Vouch,
 * Friends, Recovery, Push Notifications, Preferences, Ratings routes.
 */

import Router from '@koa/router';
import {
    registerMember, getMembers, getAllMembers, getMember,
    getBalance, transfer, getTransactions,
    createPost, getPosts, removePost, updatePost,
    getCommunityInfo,
    generateInvite, redeemInvite, redeemOfflineTicket, checkInvite, getInviteTree, getInvitesByMember,
    adminGenerateInvite, getMemberTrustProfile, getTrustProfileForViewer,
    vouchMember, unvouchMember, canVouch, hasListedOffer, hasLiveOffer,
    updateProfile, getProfile, getAllProfiles,
    getCommunityHealth,
    seedGenesisMember,
    addRating, getRatings, getAverageRating, getRatingsGiven,
    submitReport, getReports, getReportCount,
    getFriends, addFriend, removeFriend, setGuardian,
    recordActivity,
    markConversationRead, getUnreadCounts,
    exportLedgerAudit,
    registerPushToken, removePushToken,
    getMemberPreferences, setMemberPreferences, setHolidayMode,
    getMemberStats,
    getGuardiansOf, createRecoveryRequest, dispatchPushNotification, getPendingRecoveryRequests, approveRecovery, rejectRecovery, getRecoveryStatus, cancelRecovery,
    getNodeRole, exportSyncState,
} from '../state-engine.js';
import {
    getLocalConfig, saveLocalConfig, hashPassword, verifyPassword,
    validatePasswordStrength,
} from '../local-config.js';
import {
    getConnectors, addConnector, removeConnector,
    connectToAddress, disconnectFromAddress,
    getConnectorByPublicUrl,
    type TrustLevel,
} from '../connector-manager.js';
import { federatedVerifyMember } from '../federation-protocol.js';
import { getP2PNode } from '../p2p.js';
import { logger } from '../logger.js';
import { PROTOCOL_CONSTANTS } from '@beanpool/core';
import { db } from '../db/db.js';
import type { RouteDeps } from './types.js';

export function createCommunityRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { rateLimit, clampLimit, clampOffset, checkAdminAuth, enforceReadAuth: ENFORCE_READ_AUTH } = deps;

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
    const pubkey = (ctx.headers['x-public-key'] as string) || (ctx.query.publicKey as string);
    ctx.body = getCommunityInfo(pubkey);
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

// Read-only pre-flight: lets onboarding reject a dud invite at Step 1 (before
// the name/photo/seed ceremony) and greet the invitee with who invited them.
// Never consumes the invite; inviter callsign only returned for valid codes.
// Own rate bucket: this is a public pre-membership endpoint, and behind a
// shared tunnel/proxy IP it must never drain the admin-auth limiter's pool.
const inviteCheckAttempts = new Map<string, { count: number; resetAt: number }>();
router.get('/api/invite/check', async (ctx) => {
    const ip = ctx.ip || 'unknown';
    const now = Date.now();
    const entry = inviteCheckAttempts.get(ip);
    if (entry && now < entry.resetAt) {
        if (entry.count >= 30) {
            ctx.status = 429;
            ctx.body = { error: 'Too many attempts. Try again shortly.' };
            return;
        }
        entry.count++;
    } else {
        if (inviteCheckAttempts.size > 10_000) inviteCheckAttempts.clear();
        inviteCheckAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    }
    const code = ((ctx.query.code as string) || '').trim();
    if (!code) {
        ctx.status = 400;
        ctx.body = { error: 'code is required' };
        return;
    }
    const config = getLocalConfig();
    ctx.body = {
        ...checkInvite(code),
        communityName: config.communityName || config.callsign || null,
    };
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
        // Gate 2 (offer covenant): must keep a LIVE Offer to spend into a negative balance.
        hasLiveOffer: hasLiveOffer(publicKey),
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

// Vouch: the (signed) viewer vouches for targetPubkey, handing them the -20 credit floor.
// Server-authoritative — vouchMember() verifies the actor holds the vouch capability
// (members.can_vouch, admin-granted) and rejects self-vouch. This lifts the target's
// no-overdraft activation gate, unlocking the welcome voucher + any earned trust banked.
router.post('/api/profile/vouch', async (ctx) => {
    const voucher = ctx.state.actor as string | undefined;
    const { targetPubkey, level } = (ctx as any).requestBody || {};
    if (!voucher) {
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
        // Level 1 = -25, 2 = -50, 3 = -100 credit floor. Default to 1 if omitted/invalid.
        const lvl = level === 2 || level === 3 ? level : 1;
        vouchMember(voucher, targetPubkey, lvl);
        ctx.body = { success: true, level: lvl };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e?.message || 'Vouch failed' };
    }
});

// Withdraw a vouch. The original voucher may withdraw their own; the admin may force-revoke.
// unvouchMember() blocks a non-admin withdrawal while the target is still carrying a negative
// balance (they'd be stranded below the new floor of 0).
router.post('/api/profile/unvouch', async (ctx) => {
    const actor = ctx.state.actor as string | undefined;
    const { targetPubkey } = (ctx as any).requestBody || {};
    if (!actor) {
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
        unvouchMember(actor, targetPubkey);
        ctx.body = { success: true };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e?.message || 'Withdraw failed' };
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

// Holiday mode: switch on/off (signed). Turning it ON is gated on having zero open trades —
// setHolidayMode throws with `.openTrades` set when blocked so the client can name the count.
router.post('/api/members/holiday', async (ctx) => {
    const publicKey = ctx.state.actor as string | undefined;
    const { enabled } = (ctx as any).requestBody || {};
    if (!publicKey) {
        ctx.status = 401;
        ctx.body = { error: 'A signed request is required' };
        return;
    }
    try {
        const result = setHolidayMode(publicKey, !!enabled);
        ctx.body = { success: true, enabled: !!enabled, openTrades: result.openTrades };
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e?.message || 'Failed to update holiday mode', openTrades: e?.openTrades };
    }
});

// ===================== MARKETPLACE API (PUBLIC) =====================

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


    return router;
}
