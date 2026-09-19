/**
 * Key-Based Admin Authentication & Break-Glass Protocol
 *
 * Implements docs/admin-surface.md §2 (all), the interim rule ("password = owner-level"),
 * and node_roles integration:
 *
 * (a) Signed challenge auth for /settings and /api/local/admin/*:
 *     - 60-second single-use handshake token minted for an active member holding a node role
 *     - Handshake token exchanged for a browser session (2h idle / 12h hard limit)
 *     - session_epoch per member for instant revoke-all
 *     - Phone-button deep link and desktop QR flow use the exact same token
 *
 * (b) Attribution:
 *     - Every admin action under a key session is attributed to that member
 *       (auth_signer = their pubkey), replacing 'owner:password'
 *
 * (c) Password path & Break-glass mode:
 *     - Password path keeps working unchanged when breakGlassMode is false (default)
 *     - When breakGlassMode is true, password/break-glass credentials can ONLY reach key enrolment
 *     - Public alert raised on break-glass use:
 *       "Break-glass recovery used to authorise a new admin key for @callsign"
 *
 * (d) Per-owner break-glass code:
 *     - Distinct per-owner break-glass code generated on enrolment (not one shared password)
 *     - Stored as SHA-256 hash in node_roles.break_glass_hash
 */

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { getMember } from '@beanpool/engine';
import {
    isNodeAdmin,
    isNodeOwner,
    nodeRoleOf,
    getNodeRoleSessionEpoch,
    bumpNodeRoleSessionEpoch,
    setNodeRoleBreakGlassHash,
    getNodeRoleBreakGlassHash,
    grantNodeRole,
    type MemberNodeRole,
} from './engine/node-roles.js';
import { getLocalConfig, isBreakGlassMode, updateLocalConfig } from './config/local-config.js';
import { verifyTotpCode, verifyAndFindBackupCodeHash } from './totp.js';
import { issueCsrfToken } from './admin-auth.js';
import { adminBroadcastAnnouncement } from './state-engine.js';
import { logger } from './logger.js';

// ===================== CONSTANTS & TTLs =====================
export const CHALLENGE_TTL_MS = 60_000;          // 60 seconds challenge freshness
export const HANDSHAKE_TOKEN_TTL_MS = 60_000;    // 60 seconds single-use token freshness
export const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;   // 2 hours idle timeout
export const SESSION_HARD_TTL_MS = 12 * 60 * 60 * 1000;  // 12 hours hard maximum

// ===================== TYPES =====================
export interface AdminChallenge {
    challengeId: string;
    challenge: string;
    createdAt: number;
    expiresAt: number;
    status: 'pending' | 'resolved' | 'expired';
    handshakeToken?: string;
    memberPubkey?: string;
    role?: MemberNodeRole;
}

export interface HandshakeTokenEntry {
    token: string;
    memberPubkey: string;
    role: MemberNodeRole;
    sessionEpoch: number;
    createdAt: number;
    expiresAt: number;
    used: boolean;
    usedAt?: number;
}

export interface AdminSession {
    sessionId: string;
    memberPubkey: string;
    role: MemberNodeRole;
    sessionEpoch: number;
    createdAt: number;
    lastActiveAt: number;
    hardExpiresAt: number;
    idleExpiresAt: number;
}

// In-memory stores for ephemeral challenges, handshake tokens, and active sessions
const adminChallenges = new Map<string, AdminChallenge>();
const handshakeTokens = new Map<string, HandshakeTokenEntry>();
const adminSessions = new Map<string, AdminSession>();

// Periodic memory pruning timer (unref'd so node exits cleanly in tests)
if (typeof setInterval !== 'undefined') {
    const cleanupTimer = setInterval(() => {
        pruneExpiredAuthEntries();
    }, 30_000);
    if (cleanupTimer.unref) cleanupTimer.unref();
}

export function pruneExpiredAuthEntries(now = Date.now()): void {
    // Prune challenges
    for (const [id, c] of adminChallenges) {
        if (now > c.expiresAt + 60_000) adminChallenges.delete(id);
    }
    // Prune handshake tokens
    for (const [tok, entry] of handshakeTokens) {
        if (now > entry.expiresAt + 60_000) handshakeTokens.delete(tok);
    }
    // Prune sessions that exceeded hard limit or idle limit
    for (const [sid, sess] of adminSessions) {
        if (now > sess.hardExpiresAt || now > sess.idleExpiresAt) {
            adminSessions.delete(sid);
        }
    }
}

// ===================== ED25519 CRYPTO HELPERS =====================

/**
 * Verifies an Ed25519 signature over a message using the given hex public key.
 * Accepts signature in base64 or hex format.
 */
export function verifyEd25519Signature(message: string | Buffer, signature: string, publicKeyHex: string): boolean {
    if (!signature || !publicKeyHex || !message) return false;
    try {
        const cleanPub = publicKeyHex.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(cleanPub)) return false;

        const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
        const spki = Buffer.concat([spkiHeader, Buffer.from(cleanPub, 'hex')]);
        const publicKeyObject = crypto.createPublicKey({
            key: spki,
            format: 'der',
            type: 'spki',
        });

        const cleanSig = signature.trim();
        const isHex = /^[0-9a-fA-F]{128}$/.test(cleanSig);
        const sigBuf = Buffer.from(cleanSig, isHex ? 'hex' : 'base64');

        const msgBuf = Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf-8');

        return crypto.verify(undefined, msgBuf, publicKeyObject, sigBuf);
    } catch {
        return false;
    }
}

// ===================== CHALLENGE CREATION & RESOLUTION =====================

/**
 * Creates a fresh 60-second authentication challenge for phone or desktop QR flow.
 */
export function createAdminChallenge(): AdminChallenge {
    const challengeId = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const challengeString = `beanpool-admin-auth:${challengeId}:${now}`;
    const challenge: AdminChallenge = {
        challengeId,
        challenge: challengeString,
        createdAt: now,
        expiresAt: now + CHALLENGE_TTL_MS,
        status: 'pending',
    };
    adminChallenges.set(challengeId, challenge);
    return challenge;
}

/**
 * Retrieves an active challenge by challengeId, marking expired if past TTL.
 */
export function getAdminChallenge(challengeId: string): AdminChallenge | null {
    if (!challengeId) return null;
    const c = adminChallenges.get(challengeId);
    if (!c) return null;
    if (Date.now() > c.expiresAt) {
        c.status = 'expired';
        return c;
    }
    return c;
}

/**
 * Verifies the signature on a challenge and mints a 60-second single-use handshake token.
 *
 * Enforces:
 * - Challenge exists, is pending, and has not expired
 * - Signer is an active member with a node role (owner or admin)
 * - Cryptographic Ed25519 signature is valid
 * - TOTP code is verified if node has TOTP enabled
 */
export function verifyAndSolveChallenge(params: {
    challengeId: string;
    memberPubkey: string;
    signature: string;
    totpCode?: string;
}): {
    ok: boolean;
    error?: string;
    totpRequired?: boolean;
    handshakeToken?: string;
    expiresAt?: number;
    memberPubkey?: string;
    role?: MemberNodeRole;
} {
    const { challengeId, memberPubkey, signature, totpCode } = params;
    const challenge = getAdminChallenge(challengeId);

    if (!challenge) {
        return { ok: false, error: 'Challenge not found' };
    }
    if (challenge.status === 'expired' || Date.now() > challenge.expiresAt) {
        challenge.status = 'expired';
        return { ok: false, error: 'Challenge expired' };
    }
    if (challenge.status !== 'pending') {
        return { ok: false, error: 'Challenge already resolved' };
    }

    const signer = authorizeKeySigner({
        memberPubkey,
        totpCode,
        // Signature over challenge.challenge, falling back to the bare challengeId.
        signatureValid: () =>
            verifyEd25519Signature(challenge.challenge, signature, memberPubkey) ||
            verifyEd25519Signature(challenge.challengeId, signature, memberPubkey),
    });
    if (!signer.ok) {
        return { ok: false, error: signer.error, ...(signer.totpRequired ? { totpRequired: true } : {}) };
    }
    const role = signer.role;
    const { handshakeToken, expiresAt } = mintHandshakeToken(memberPubkey, role);

    // Resolve challenge
    challenge.status = 'resolved';
    challenge.handshakeToken = handshakeToken;
    challenge.memberPubkey = memberPubkey;
    challenge.role = role;

    return {
        ok: true,
        handshakeToken,
        expiresAt,
        memberPubkey,
        role,
    };
}

// ===================== SHARED SIGNER CHECKS =====================

export type KeySignerCheck =
    | { ok: true; role: MemberNodeRole }
    | { ok: false; error: string; totpRequired?: boolean; notAdmin?: boolean; badSignature?: boolean; wrongTotp?: boolean };

/**
 * Everything a key sign-in checks about the signer, shared by the app's one-time link (verifyAndSolveChallenge)
 * and the browser's sign-in by QR (settings-signin-pairing.ts) so the two cannot drift apart: an active member,
 * holding owner or admin in node_roles (moderators are not let in), whose signature over the flow's own message
 * verifies, and — when the owner turned it on — the node's 2FA code (a used backup code is spent).
 */
export function authorizeKeySigner(params: {
    memberPubkey: string;
    signatureValid: () => boolean;
    totpCode?: string;
}): KeySignerCheck {
    const { memberPubkey, signatureValid, totpCode } = params;

    // Member existence and active status check
    const member = getMember(db, memberPubkey);
    if (!member || member.status !== 'active') {
        return { ok: false, error: 'Member not found or inactive' };
    }

    // Role check: must hold 'owner' or 'admin' in node_roles
    const role = nodeRoleOf(memberPubkey);
    if (!role || !isNodeAdmin(memberPubkey)) {
        return { ok: false, error: 'Signer does not hold a node role', notAdmin: true };
    }

    if (!signatureValid()) {
        return { ok: false, error: 'Invalid cryptographic signature', badSignature: true };
    }

    // TOTP verification if enabled
    const config = getLocalConfig();
    if (config.totpEnabled && config.totpSecret) {
        if (!totpCode) {
            return { ok: false, error: '2FA code required', totpRequired: true };
        }
        const cleanCode = String(totpCode).trim();
        let totpOk = verifyTotpCode(cleanCode, config.totpSecret);
        const backupHashes = config.totpBackupCodesHashes || [];
        if (!totpOk && backupHashes.length > 0) {
            const idx = verifyAndFindBackupCodeHash(cleanCode, backupHashes);
            if (idx !== -1) {
                totpOk = true;
                const updatedHashes = [...backupHashes];
                updatedHashes.splice(idx, 1);
                updateLocalConfig({ totpBackupCodesHashes: updatedHashes });
                logger.info('AUTH', `Admin authenticated with 2FA backup code (${updatedHashes.length} remaining)`);
            }
        }
        if (!totpOk) {
            return { ok: false, error: 'Invalid 2FA code', totpRequired: true, wrongTotp: true };
        }
    }

    return { ok: true, role };
}

/** Mint a 60-second, single-use handshake token for this member; consumeHandshakeToken redeems it. */
export function mintHandshakeToken(memberPubkey: string, role: MemberNodeRole, now = Date.now()): { handshakeToken: string; expiresAt: number } {
    const handshakeToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = now + HANDSHAKE_TOKEN_TTL_MS;
    const entry: HandshakeTokenEntry = {
        token: handshakeToken,
        memberPubkey,
        role,
        sessionEpoch: getNodeRoleSessionEpoch(memberPubkey),
        createdAt: now,
        expiresAt,
        used: false,
    };
    handshakeTokens.set(handshakeToken, entry);
    return { handshakeToken, expiresAt };
}

// ===================== HANDSHAKE TOKEN EXCHANGE =====================

/**
 * Exchanges a single-use 60-second handshake token for a browser session (2h idle / 12h hard).
 *
 * Enforces:
 * - Single-use token: token is burned on exchange, replays are rejected
 * - 60-second expiry: expired tokens are rejected
 * - session_epoch verification: if epoch bumped since minting, token is rejected
 * - Node role verification: member must still be an active owner/admin
 */
export function consumeHandshakeToken(token: string, now = Date.now()): {
    ok: boolean;
    error?: string;
    replay?: boolean;
    expired?: boolean;
    revoked?: boolean;
    session?: AdminSession;
    sessionId?: string;
    csrfToken?: string;
    memberPubkey?: string;
    role?: MemberNodeRole;
    hardExpiresAt?: number;
    idleExpiresAt?: number;
} {
    if (!token) {
        return { ok: false, error: 'Token is required' };
    }

    const entry = handshakeTokens.get(token);
    if (!entry) {
        return { ok: false, error: 'Invalid handshake token' };
    }

    // Replay check: single use!
    if (entry.used) {
        return { ok: false, error: 'Handshake token already used (replay detected)', replay: true };
    }

    // Expiry check: 60-second window
    if (now > entry.expiresAt) {
        return { ok: false, error: 'Handshake token has expired', expired: true };
    }

    // Single-use: burn token immediately
    entry.used = true;
    entry.usedAt = now;

    // session_epoch check
    const currentEpoch = getNodeRoleSessionEpoch(entry.memberPubkey);
    if (currentEpoch !== entry.sessionEpoch) {
        return { ok: false, error: 'Session epoch revoked', revoked: true };
    }

    // Node role check, against the role held NOW rather than the one recorded when the token was minted:
    // an owner demoted to admin in the seconds between must not open an owner-level session.
    const liveRole = nodeRoleOf(entry.memberPubkey);
    if (!liveRole || !isNodeAdmin(entry.memberPubkey)) {
        return { ok: false, error: 'Member no longer holds an admin role' };
    }

    // Mint browser session (2h idle / 12h hard)
    const sessionId = crypto.randomBytes(32).toString('hex');
    const session: AdminSession = {
        sessionId,
        memberPubkey: entry.memberPubkey,
        role: liveRole,
        sessionEpoch: entry.sessionEpoch,
        createdAt: now,
        lastActiveAt: now,
        hardExpiresAt: now + SESSION_HARD_TTL_MS,
        idleExpiresAt: now + SESSION_IDLE_TTL_MS,
    };
    adminSessions.set(sessionId, session);

    const csrfToken = issueCsrfToken();

    logger.info('AUTH', `Minted admin browser session for ${entry.memberPubkey} (role: ${liveRole})`);

    return {
        ok: true,
        sessionId,
        session,
        csrfToken,
        memberPubkey: entry.memberPubkey,
        role: liveRole,
        hardExpiresAt: session.hardExpiresAt,
        idleExpiresAt: session.idleExpiresAt,
    };
}

// ===================== BROWSER SESSION VALIDATION =====================

/**
 * Validates a browser session token.
 *
 * Enforces:
 * - Session existence
 * - Hard limit: 12 hours hard maximum
 * - Idle limit: 2 hours idle timeout
 * - session_epoch: matching current member session_epoch in node_roles
 * - Node role: member still holds an active admin role
 * - Sliding window: refreshes idle timeout on valid use
 */
export function validateAdminSession(sessionId: string, now = Date.now()): {
    valid: boolean;
    error?: string;
    session?: AdminSession;
    expired?: boolean;
    idle?: boolean;
    idleTimeout?: boolean;
    hardLimit?: boolean;
    revoked?: boolean;
} {
    if (!sessionId) {
        return { valid: false, error: 'No session provided' };
    }

    const session = adminSessions.get(sessionId);
    if (!session) {
        return { valid: false, error: 'Session not found' };
    }

    // 12h Hard Limit check
    if (now > session.hardExpiresAt) {
        adminSessions.delete(sessionId);
        return { valid: false, error: 'Session expired (12h hard limit reached)', expired: true, hardLimit: true };
    }

    // 2h Idle Limit check
    if (now > session.idleExpiresAt) {
        adminSessions.delete(sessionId);
        return { valid: false, error: 'Session expired (2h idle timeout)', idle: true, idleTimeout: true };
    }

    // session_epoch check
    const currentEpoch = getNodeRoleSessionEpoch(session.memberPubkey);
    if (currentEpoch !== session.sessionEpoch) {
        adminSessions.delete(sessionId);
        return { valid: false, error: 'Session revoked via epoch bump', revoked: true };
    }

    // Role check. The session's role follows node_roles on every request: checkAdminAuth hands it to the
    // routes as ctx.state.adminRole, so an owner demoted to admin mid-session would otherwise keep
    // owner-only powers (enrol an owner, toggle break-glass) until the session ran out.
    const liveRole = nodeRoleOf(session.memberPubkey);
    if (!liveRole || !isNodeAdmin(session.memberPubkey)) {
        adminSessions.delete(sessionId);
        return { valid: false, error: 'Member no longer holds an admin role' };
    }
    session.role = liveRole;

    // Sliding window for idle timeout
    session.lastActiveAt = now;
    session.idleExpiresAt = now + SESSION_IDLE_TTL_MS;

    return { valid: true, session };
}

/**
 * Revokes all web sessions for a member by bumping their session_epoch in SQLite.
 * Existing sessions are invalidated on their next request via the epoch check.
 */
export function revokeAllMemberSessions(memberPubkey: string): number {
    if (!memberPubkey) return 0;
    const newEpoch = bumpNodeRoleSessionEpoch(memberPubkey);
    logger.info('AUTH', `Revoked all web sessions for ${memberPubkey} (new session_epoch: ${newEpoch})`);
    return newEpoch;
}

/**
 * Revokes a single browser session (e.g. logout).
 */
export function revokeAdminSession(sessionId: string): void {
    if (!sessionId) return;
    adminSessions.delete(sessionId);
}

/**
 * Purges all active in-memory admin sessions for a specific member public key.
 */
export function purgeMemberSessions(memberPubkey: string): void {
    if (!memberPubkey) return;
    for (const [sid, sess] of adminSessions.entries()) {
        if (sess.memberPubkey === memberPubkey) {
            adminSessions.delete(sid);
        }
    }
}

// ===================== PER-OWNER BREAK-GLASS PROTOCOL =====================

/**
 * Generates a per-owner break-glass code (e.g. bg-a1b2-c3d4-e5f6-7890).
 */
export function generateBreakGlassCode(): string {
    const raw = crypto.randomBytes(8).toString('hex');
    const groups = raw.match(/.{1,4}/g)?.join('-') || raw;
    return `bg-${groups}`;
}

/**
 * Hashes a break-glass code using SHA-256 for persistent storage in node_roles.
 */
export function hashBreakGlassCode(code: string): string {
    return crypto.createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

/**
 * Verifies a break-glass code candidate against stored owner hashes using constant-time comparison.
 * If ownerPubkey is provided, checks that owner specifically. Otherwise checks all owners.
 */
export function verifyBreakGlassCode(code: string, ownerPubkey?: string): { member_pubkey: string; role: string } | null {
    if (!code) return null;
    const candidateHash = Buffer.from(hashBreakGlassCode(code));

    if (ownerPubkey) {
        const row = db.prepare(
            `SELECT nr.member_pubkey, nr.role, nr.break_glass_hash
             FROM node_roles nr
             JOIN members m ON nr.member_pubkey = m.public_key
             WHERE nr.member_pubkey = ? AND nr.role = 'owner' AND nr.break_glass_hash IS NOT NULL AND m.status = 'active'`
        ).get(ownerPubkey) as { member_pubkey: string; role: string; break_glass_hash: string } | undefined;
        if (!row?.break_glass_hash) return null;
        const storedBuf = Buffer.from(row.break_glass_hash);
        if (candidateHash.length === storedBuf.length && crypto.timingSafeEqual(candidateHash, storedBuf)) {
            return { member_pubkey: row.member_pubkey, role: row.role };
        }
        return null;
    }

    const rows = db.prepare(
        `SELECT nr.member_pubkey, nr.role, nr.break_glass_hash
         FROM node_roles nr
         JOIN members m ON nr.member_pubkey = m.public_key
         WHERE nr.role = 'owner' AND nr.break_glass_hash IS NOT NULL AND m.status = 'active'`
    ).all() as { member_pubkey: string; role: string; break_glass_hash: string }[];

    for (const r of rows) {
        const storedBuf = Buffer.from(r.break_glass_hash);
        if (candidateHash.length === storedBuf.length && crypto.timingSafeEqual(candidateHash, storedBuf)) {
            return { member_pubkey: r.member_pubkey, role: r.role };
        }
    }
    return null;
}

/**
 * Enrols an admin key and generates a per-owner break-glass code.
 *
 * If isBreakGlass is true, emits a loud public alert to the community:
 * "Break-glass recovery used to authorise a new admin key for @callsign"
 */
export function enrolAdminOwnerKey(params: {
    targetPubkey: string;
    actorPubkey?: string;
    isBreakGlass?: boolean;
    role?: MemberNodeRole;
}): {
    success: boolean;
    memberPubkey: string;
    role: MemberNodeRole;
    breakGlassCode?: string;
    alertEmitted?: boolean;
} {
    const { targetPubkey, actorPubkey, isBreakGlass = false, role = 'owner' } = params;

    const member = getMember(db, targetPubkey);
    if (!member || member.status !== 'active') {
        throw new Error('Target member not found or inactive');
    }

    // Grant role in node_roles if not already held
    const currentRole = nodeRoleOf(targetPubkey);
    if (currentRole !== role) {
        grantNodeRole(targetPubkey, role, actorPubkey || (isBreakGlass ? 'break-glass:enrolment' : 'owner:password'));
    }

    // Generate per-owner break-glass code only for owners
    let breakGlassCode: string | undefined;
    if (role === 'owner') {
        breakGlassCode = generateBreakGlassCode();
        const hash = hashBreakGlassCode(breakGlassCode);
        setNodeRoleBreakGlassHash(targetPubkey, hash);
    } else {
        setNodeRoleBreakGlassHash(targetPubkey, null);
    }

    let alertEmitted = false;
    if (isBreakGlass) {
        const callsign = member.callsign || targetPubkey.slice(0, 8);
        const alertBody = `Break-glass recovery used to authorise a new admin key for @${callsign}.`;
        adminBroadcastAnnouncement('Break-Glass Recovery Used', alertBody, 'critical');
        logger.warn('AUTH', `[BREAK-GLASS] ${alertBody} (pubkey: ${targetPubkey})`);
        alertEmitted = true;
    }

    return {
        success: true,
        memberPubkey: targetPubkey,
        role,
        ...(breakGlassCode ? { breakGlassCode } : {}),
        alertEmitted,
    };
}
