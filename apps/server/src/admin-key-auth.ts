/**
 * Key-Based Admin Authentication & Break-Glass Protocol
 *
 * Implements docs/admin-surface.md §2 (all), the interim rule ("password = owner-level"),
 * and node_roles integration:
 *
 * (a) Signed challenge auth for /settings and /api/local/admin/*:
 *     - 60-second single-use handshake token minted for an active member holding a node role
 *     - Handshake token exchanged for a browser session (2h idle / 12h hard limit); a session the phone app's
 *       "Manage" hand-off opens in the phone's own browser locks after 15 min idle (PHONE_HANDOFF_IDLE_TTL_MS)
 *     - session_epoch per member for instant revoke-all
 *     - Phone-button deep link and desktop QR flow use the exact same token; the token is only ever
 *       returned to the party that proved the key (verify-challenge) or held inside a browser-bound
 *       pairing — never to someone who only knows a challenge id
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
 *     - Stored as a salted scrypt hash in node_roles.break_glass_hash (break-glass-code.ts)
 *     - Accepted on the enrol routes only, whatever the mode (admin-auth.ts checkAdminAuth)
 */

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { getMember, isVisitorKey } from '@beanpool/engine';
import {
    isNodeOwner,
    nodeRoleOf,
    getNodeRoleSessionEpoch,
    bumpNodeRoleSessionEpoch,
    setNodeRoleBreakGlassHash,
    getNodeRoleBreakGlassHash,
    grantNodeRole,
    NODE_ROLE_ACTS,
    type MemberNodeRole,
} from './engine/node-roles.js';
import { getLocalConfig, isBreakGlassMode, updateLocalConfig } from './config/local-config.js';
import { verifyTotpCode, verifyAndFindBackupCodeHash } from './totp.js';
import { issueCsrfToken } from './admin-auth.js';
import { adminBroadcastAnnouncement } from './state-engine.js';
import { logger } from './logger.js';
import { isMemberKeySpelling } from './engine/member-key.js';
import { adminSigninText, verifyStatementSignature } from './engine/member-signature.js';
import { breakGlassCodeMatches, generateBreakGlassCode, hashBreakGlassCode, isBreakGlassCodeShape } from './break-glass-code.js';
import { CHALLENGE_MAX_WRONG_CODES, keySigninBraked, noteKeySigninFailure, noteKeySigninSuccess } from './key-signin-brake.js';

// ===================== CONSTANTS & TTLs =====================
export const CHALLENGE_TTL_MS = 60_000;          // 60 seconds challenge freshness
export const HANDSHAKE_TOKEN_TTL_MS = 60_000;    // 60 seconds single-use token freshness
export const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;   // 2 hours idle timeout
export const SESSION_HARD_TTL_MS = 12 * 60 * 60 * 1000;  // 12 hours hard maximum
/**
 * Idle limit for a session opened by the phone app's "Manage <community>" hand-off (/settings#handoff=…, redeemed
 * through POST /api/local/admin/auth/exchange, or an older app's GET /settings?token=). That page lives in the phone's
 * in-app browser, which App Lock can't cover on Android (a Custom Tab is a task of its own) and only closes on an iPhone
 * as the lock screen goes up (deciding review of #1413, 2026-10-01). So the node locks it itself: 15 minutes with no
 * request from it. While Settings is on screen and in use it polls every few seconds, which keeps the session; its
 * polls stop when the tab is hidden or untouched for ten minutes (apps/manager/src/lib/activity-pause.tsx), so a phone
 * put down with Settings open is signed out within ~15 minutes. Opening Manage again signs straight back in.
 * The desktop "Sign in with your phone" pairing keeps SESSION_IDLE_TTL_MS: that browser is on a computer.
 */
export const PHONE_HANDOFF_IDLE_TTL_MS = 15 * 60 * 1000;

// ===================== TYPES =====================
export interface AdminChallenge {
    challengeId: string;
    challenge: string;
    createdAt: number;
    expiresAt: number;
    status: 'pending' | 'resolved' | 'expired';
    /** Wrong 2FA codes sent against this challenge; at CHALLENGE_MAX_WRONG_CODES it is burned (key-signin-brake.ts). */
    wrongCodes?: number;
    // Deliberately no token, signer or role here: the token goes back only to the signer, in the
    // verify-challenge response. Anything kept on the challenge is one id away from anyone who saw it.
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
    /** How long it may sit unused: SESSION_IDLE_TTL_MS, or PHONE_HANDOFF_IDLE_TTL_MS for the phone's hand-off. */
    idleTtlMs: number;
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
 * - Signer is an active member with a node role (owner, admin or moderator)
 * - Cryptographic Ed25519 signature is valid
 * - TOTP code is verified if node has TOTP enabled
 */
export function verifyAndSolveChallenge(params: {
    challengeId: string;
    memberPubkey: string;
    signature: string;
    totpCode?: string;
    /** The host the app signed for (request binding): with it, only the format-2 sign-in text is accepted. */
    signedFor?: unknown;
    /** The caller's address (client-ip.ts clientLimiterKey), which the 2FA brake counts beside the key. */
    source?: string;
}): {
    ok: boolean;
    error?: string;
    /**
     * 421 wrong_community or 426 app_too_old (engine/member-signature.ts), 429 while the 2FA brake holds this key or
     * address, 410 for a challenge burned by wrong codes: when that is why it was refused.
     */
    status?: number;
    code?: string;
    totpRequired?: boolean;
    /** With 429: seconds until a code is checked again. */
    retryAfter?: number;
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
    if ((challenge.wrongCodes ?? 0) >= CHALLENGE_MAX_WRONG_CODES) {
        return { ok: false, error: BURNED_CHALLENGE_ERROR, status: 410 };
    }
    if (challenge.status === 'expired' || Date.now() > challenge.expiresAt) {
        challenge.status = 'expired';
        return { ok: false, error: 'Challenge expired' };
    }
    if (challenge.status !== 'pending') {
        return { ok: false, error: 'Challenge already resolved' };
    }

    // Request binding (decision 4a, 2026-09-27): the app builds `0xFF ‖ beanpool-admin-signin/2\n<host>\n<challengeId>`
    // from the challenge id alone and says which host (`signedFor`); it never signs the node's text. Before this the app
    // signed whatever `challenge` text the node sent, so a hostile community could make its Manage button sign a
    // complete request for another. The old forms (the challenge text, or the bare id) are accepted only until the
    // switch (engine/member-signature.ts), and a format-2 sign-in for another community's host never.
    let statement: ReturnType<typeof verifyStatementSignature> | null = null;
    const signer = authorizeKeySigner({
        memberPubkey,
        totpCode,
        source: params.source,
        signatureValid: () => {
            statement = verifyStatementSignature({
                signature,
                pubKeyHex: memberPubkey,
                boundText: (host) => adminSigninText(host, challenge.challengeId),
                signedFor: params.signedFor,
                oldTexts: [challenge.challenge, challenge.challengeId],
            });
            return statement.ok;
        },
    });
    if (!signer.ok) {
        const refused = statement as ReturnType<typeof verifyStatementSignature> | null;
        if (signer.badSignature && refused && !refused.ok && (refused.status === 421 || refused.status === 426)) {
            return { ok: false, error: refused.error, status: refused.status, code: refused.code };
        }
        if (signer.braked) return { ok: false, error: signer.error, status: 429, retryAfter: signer.retryAfter };
        if (signer.wrongTotp) {
            // A wrong code leaves the challenge pending, for a mistyped code, but only a few times: then it is burned.
            challenge.wrongCodes = (challenge.wrongCodes ?? 0) + 1;
            if (challenge.wrongCodes >= CHALLENGE_MAX_WRONG_CODES) {
                challenge.status = 'expired';
                logger.security('AUTH', `Key sign-in challenge ${challenge.challengeId.slice(0, 8)} burned after ${challenge.wrongCodes} wrong 2FA codes (key ${memberPubkey.slice(0, 12)}…)`);
            }
        }
        return { ok: false, error: signer.error, ...(signer.totpRequired ? { totpRequired: true } : {}) };
    }
    const role = signer.role;
    const { handshakeToken, expiresAt } = mintHandshakeToken(memberPubkey, role);

    // Resolve challenge (single use). The token is not stored on it: see AdminChallenge (#976).
    challenge.status = 'resolved';

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
    | { ok: false; error: string; totpRequired?: boolean; notAdmin?: boolean; badSignature?: boolean; wrongTotp?: boolean; braked?: boolean; retryAfter?: number };

/** A key sign-in's challenge after CHALLENGE_MAX_WRONG_CODES wrong codes. */
export const BURNED_CHALLENGE_ERROR = 'Too many wrong 2FA codes for this sign-in. Start again.';

/**
 * Everything a key sign-in checks about the signer, shared by the app's one-time link (verifyAndSolveChallenge)
 * and the browser's sign-in by QR (settings-signin-pairing.ts) so the two cannot drift apart: an active member,
 * holding a role in node_roles (owner, admin or moderator; a moderator's session reaches only MODERATOR_ROUTES in
 * admin-auth.ts), whose signature over the flow's own message
 * verifies, and — when the owner turned it on — the node's 2FA code (a used backup code is spent), under the 2FA
 * brake (key-signin-brake.ts), per key and per `source` address: a held key or address is answered `braked` without
 * the code being looked at.
 */
export function authorizeKeySigner(params: {
    memberPubkey: string;
    signatureValid: () => boolean;
    totpCode?: string;
    /** The caller's address (client-ip.ts clientLimiterKey), counted by the 2FA brake beside the key. */
    source?: string;
}): KeySignerCheck {
    const { memberPubkey, signatureValid, totpCode, source } = params;

    // One key, one spelling (engine/member-key.ts): the signature check decodes the key's hex, which forgives case, so a
    // row a door stored under a member's key in capitals, before that rule, would open a session for that key's holder
    // as a second person. Answered as a key with no row is. Both apps send the key in lower case.
    if (!isMemberKeySpelling(memberPubkey)) {
        return { ok: false, error: 'Member not found or inactive' };
    }

    // Member existence and active status check. A visitor's row is answered as a key with no row is: a role it holds from
    // before the visitors' rule acts for nothing (engine/node-roles.ts NODE_ROLE_ACTS), so it opens no session (4111202677).
    const member = getMember(db, memberPubkey);
    if (!member || member.status !== 'active' || isVisitorKey(db, memberPubkey)) {
        return { ok: false, error: 'Member not found or inactive' };
    }

    // Role check: must hold a node role (owner, admin or moderator). What a moderator's session may then do is
    // narrowed in checkAdminAuth (admin-auth.ts, MODERATOR_ROUTES).
    const role = nodeRoleOf(memberPubkey);
    if (!role) {
        return { ok: false, error: 'Signer does not hold a node role', notAdmin: true };
    }

    if (!signatureValid()) {
        return { ok: false, error: 'Invalid cryptographic signature', badSignature: true };
    }

    // TOTP verification if enabled, under the brake (key-signin-brake.ts). Everything above needs the key, so nothing a
    // stranger sends reaches here to be counted.
    const config = getLocalConfig();
    if (config.totpEnabled && config.totpSecret) {
        const brake = keySigninBraked(memberPubkey, source);
        if (brake.braked) {
            return {
                ok: false, braked: true, retryAfter: brake.retryAfter,
                error: `Too many wrong 2FA codes. Try again in ${brake.retryAfter}s.`,
            };
        }
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
            noteKeySigninFailure(memberPubkey, source, `${member.callsign ? `@${member.callsign} ` : ''}(key ${memberPubkey.slice(0, 12)}…)`);
            return { ok: false, error: 'Invalid 2FA code', totpRequired: true, wrongTotp: true };
        }
        noteKeySigninSuccess(memberPubkey, source);
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
 * Exchanges a single-use 60-second handshake token for a browser session (2h idle / 12h hard). `idleTtlMs` shortens
 * the idle limit: the phone app's hand-off passes PHONE_HANDOFF_IDLE_TTL_MS.
 *
 * Enforces:
 * - Single-use token: token is burned on exchange, replays are rejected
 * - 60-second expiry: expired tokens are rejected
 * - session_epoch verification: if epoch bumped since minting, token is rejected
 * - Node role verification: member must still hold a node role
 */
export function consumeHandshakeToken(token: string, now = Date.now(), opts: { idleTtlMs?: number } = {}): {
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
    if (!liveRole) {
        return { ok: false, error: 'Member no longer holds a node role' };
    }

    // Mint browser session (2h idle, or the phone hand-off's 15 min / 12h hard). Never longer than the default.
    const idleTtlMs = Math.min(opts.idleTtlMs ?? SESSION_IDLE_TTL_MS, SESSION_IDLE_TTL_MS);
    const sessionId = crypto.randomBytes(32).toString('hex');
    const session: AdminSession = {
        sessionId,
        memberPubkey: entry.memberPubkey,
        role: liveRole,
        sessionEpoch: entry.sessionEpoch,
        createdAt: now,
        lastActiveAt: now,
        hardExpiresAt: now + SESSION_HARD_TTL_MS,
        idleExpiresAt: now + idleTtlMs,
        idleTtlMs,
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
 * - Idle limit: 2 hours idle timeout (15 minutes for the phone app's hand-off)
 * - session_epoch: matching current member session_epoch in node_roles
 * - Node role: member still holds a node role (the session's role follows it)
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

    // Idle Limit check (2h, or 15 min for the phone app's hand-off)
    if (now > session.idleExpiresAt) {
        adminSessions.delete(sessionId);
        const idleFor = session.idleTtlMs < 60 * 60 * 1000 ? `${Math.round(session.idleTtlMs / 60_000)} min` : `${Math.round(session.idleTtlMs / 3_600_000)}h`;
        return { valid: false, error: `Session expired (${idleFor} idle timeout)`, idle: true, idleTimeout: true };
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
    // A moderator whose role is taken away loses the session on the next request the same way.
    const liveRole = nodeRoleOf(session.memberPubkey);
    if (!liveRole) {
        adminSessions.delete(sessionId);
        return { valid: false, error: 'Member no longer holds a node role' };
    }
    session.role = liveRole;

    // Sliding window for idle timeout
    session.lastActiveAt = now;
    session.idleExpiresAt = now + session.idleTtlMs;

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

export { generateBreakGlassCode, hashBreakGlassCode };

/**
 * Checks a break-glass code candidate against the stored owner hashes (break-glass-code.ts: salted scrypt, one per
 * owner). If ownerPubkey is provided, checks that owner only; otherwise every owner whose role acts. A row still in the
 * old unsalted form that matches is rewritten in the new form here (it can arrive after the boot upgrade, in a take-over
 * bundle or a restore from an older server). Anything not shaped like a code is refused without an scrypt.
 */
export async function verifyBreakGlassCode(code: string, ownerPubkey?: string): Promise<{ member_pubkey: string; role: string } | null> {
    if (!isBreakGlassCodeShape(code)) return null;
    const ownerSql = `SELECT nr.member_pubkey, nr.role, nr.break_glass_hash
             FROM node_roles nr
             JOIN members m ON nr.member_pubkey = m.public_key
             WHERE nr.role = 'owner' AND nr.break_glass_hash IS NOT NULL AND ${NODE_ROLE_ACTS}`;
    const rows = (ownerPubkey
        ? db.prepare(`${ownerSql} AND nr.member_pubkey = ?`).all(ownerPubkey)
        : db.prepare(ownerSql).all()) as { member_pubkey: string; role: string; break_glass_hash: string }[];

    for (const r of rows) {
        const verdict = await breakGlassCodeMatches(code, r.break_glass_hash);
        if (verdict === 'no') continue;
        // Read again after the wait: a demotion or a new enrolment meanwhile replaced or cleared this hash.
        const still = db.prepare(`${ownerSql} AND nr.member_pubkey = ?`).get(r.member_pubkey) as { break_glass_hash: string } | undefined;
        if (still?.break_glass_hash !== r.break_glass_hash) return null;
        if (verdict === 'legacy') {
            db.prepare('UPDATE node_roles SET break_glass_hash = ? WHERE member_pubkey = ? AND break_glass_hash = ?')
                .run(hashBreakGlassCode(code), r.member_pubkey, r.break_glass_hash);
            logger.info('AUTH', `Break-glass code of ${r.member_pubkey.slice(0, 12)}… rewritten from the old unsalted hash to scrypt on its use`);
        }
        return { member_pubkey: r.member_pubkey, role: r.role };
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

    // A visitor's row is answered as a key with no row is (grantNodeRole gives it no role either).
    const member = getMember(db, targetPubkey);
    if (!member || member.status !== 'active' || isVisitorKey(db, targetPubkey)) {
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
