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
    type BreakGlassMadeBy,
} from './engine/node-roles.js';
import { getLocalConfig, isBreakGlassMode, isPasswordRetired } from './config/local-config.js';
import { issueCsrfToken, revokeCsrfTokensBoundTo, restamp2faSessions } from './admin-auth.js';
import { adminBroadcastAnnouncement } from './state-engine.js';
import { logger } from './logger.js';
import { isMemberKeySpelling } from './engine/member-key.js';
import { adminSigninText, verifyStatementSignature } from './engine/member-signature.js';
import { breakGlassCodeMatches, generateBreakGlassCode, hashBreakGlassCode, isBreakGlassCodeShape } from './break-glass-code.js';

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
/**
 * How long after the phone's unlock a session opened by the phone's Manage hand-off may make owner-only changes (the
 * step-up of decision D2, 2026-10-03). A key sign-in asks for no 2FA code: the phone's lock, asked before every Manage,
 * is the factor. A phone picked up while Settings is open in its browser has that unlock behind it, so changes that
 * decide who owns the community or how it is kept safe (owner-only routes, an owner grant or revoke, an owner key's
 * enrolment) ask for it again once the session is older than this: Manage again, which asks the phone's lock. Reading
 * Settings and an admin's everyday work are not asked. A computer's session (the QR pairing) is not a phone left open.
 */
export const PHONE_STEP_UP_WINDOW_MS = 5 * 60 * 1000;
export const STEP_UP_REQUIRED_CODE = 'step_up_required';
export const STEP_UP_REQUIRED_ERROR =
    "Confirm it's you first: this change decides who owns the community or how it is kept safe. Press Manage in the " +
    "BeanPool app again (it asks for your phone's lock), then make the change there.";

// ===================== TYPES =====================
export interface AdminChallenge {
    challengeId: string;
    challenge: string;
    createdAt: number;
    expiresAt: number;
    status: 'pending' | 'resolved' | 'expired';
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

/**
 * 'key': a member's key sign-in (the app's link, the QR pairing). 'password': the node's admin password (and its 2FA
 * code), exchanged once for this session (createPasswordSession), so the browser keeps no copy of the password.
 */
export type AdminSessionKind = 'key' | 'password';

export interface AdminSession {
    sessionId: string;
    kind: AdminSessionKind;
    /** The signed-in member's key; '' for a password session, which is the node's owner and no member. */
    memberPubkey: string;
    role: MemberNodeRole;
    sessionEpoch: number;
    /** A password session only: the password and second factor it was opened under (passwordCredentialStamp). */
    credentialStamp?: string;
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
            revokeAdminSession(sid);
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
 * The node's 2FA code is not asked for: it is the password's second factor; a key's is the phone's own unlock, which
 * the app asks for before it signs (decision D2, 2026-10-03). A code an older app still sends is not looked at.
 */
export function verifyAndSolveChallenge(params: {
    challengeId: string;
    memberPubkey: string;
    signature: string;
    /** The host the app signed for (request binding): with it, only the format-2 sign-in text is accepted. */
    signedFor?: unknown;
}): {
    ok: boolean;
    error?: string;
    /** 421 wrong_community or 426 app_too_old (engine/member-signature.ts): when that is why it was refused. */
    status?: number;
    code?: string;
    handshakeToken?: string;
    expiresAt?: number;
    memberPubkey?: string;
    role?: MemberNodeRole;
} {
    const { challengeId, memberPubkey, signature } = params;
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

    // Request binding (decision 4a, 2026-09-27): the app builds `0xFF ‖ beanpool-admin-signin/2\n<host>\n<challengeId>`
    // from the challenge id alone and says which host (`signedFor`); it never signs the node's text. Before this the app
    // signed whatever `challenge` text the node sent, so a hostile community could make its Manage button sign a
    // complete request for another. The old forms (the challenge text, or the bare id) are accepted only until the
    // switch (engine/member-signature.ts), and a format-2 sign-in for another community's host never.
    let statement: ReturnType<typeof verifyStatementSignature> | null = null;
    const signer = authorizeKeySigner({
        memberPubkey,
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
        return { ok: false, error: signer.error };
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
    | { ok: false; error: string; notAdmin?: boolean; badSignature?: boolean };

/**
 * Everything a key sign-in checks about the signer, shared by the app's one-time link (verifyAndSolveChallenge)
 * and the browser's sign-in by QR (settings-signin-pairing.ts) so the two cannot drift apart: an active member,
 * holding a role in node_roles (owner, admin or moderator; a moderator's session reaches only MODERATOR_ROUTES in
 * admin-auth.ts), whose signature over the flow's own message verifies.
 *
 * Not the node's 2FA code (decision D2, 2026-10-03). That one code is shared by everyone who signs in, so for a key it is
 * a second shared password, not a second factor. A key's second factor is the phone's own unlock, per person, which the
 * app asks for before every Manage and every QR approval and refuses without (apps/native/utils/node-admin.ts
 * requireDeviceUnlock). The code stays on the password path (admin-auth.ts), and on the owner actions that are about it
 * (requireCurrentSecondFactor). Nothing here can be reached without a signature by the key that holds the role.
 */
export function authorizeKeySigner(params: {
    memberPubkey: string;
    signatureValid: () => boolean;
}): KeySignerCheck {
    const { memberPubkey, signatureValid } = params;

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

/** Whether this session is a phone hand-off whose unlock is older than PHONE_STEP_UP_WINDOW_MS (owner-only changes wait). */
export function phoneStepUpDue(session: AdminSession, now = Date.now()): boolean {
    return session.kind === 'key' && session.idleTtlMs <= PHONE_HANDOFF_IDLE_TTL_MS && now - session.createdAt > PHONE_STEP_UP_WINDOW_MS;
}

/** Tests only: make a session look `ms` older, as if opened that long ago (the step-up window). */
export function backdateAdminSessionForTests(sessionId: string, ms: number): void {
    const s = adminSessions.get(sessionId);
    if (s) s.createdAt -= ms;
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
 *
 * A refusal for a token the node made names the key it was made for (`mintedFor`), so /settings can tell it from an
 * earlier sign-in still live in that browser. Only the holder of the token learns it: a token the node never made, or
 * one long pruned, names nobody.
 */
export function consumeHandshakeToken(token: string, now = Date.now(), opts: { idleTtlMs?: number } = {}): {
    ok: boolean;
    error?: string;
    replay?: boolean;
    expired?: boolean;
    revoked?: boolean;
    mintedFor?: string;
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
        return { ok: false, error: 'Handshake token already used (replay detected)', replay: true, mintedFor: entry.memberPubkey };
    }

    // Expiry check: 60-second window
    if (now > entry.expiresAt) {
        return { ok: false, error: 'Handshake token has expired', expired: true, mintedFor: entry.memberPubkey };
    }

    // Single-use: burn token immediately
    entry.used = true;
    entry.usedAt = now;

    // session_epoch check
    const currentEpoch = getNodeRoleSessionEpoch(entry.memberPubkey);
    if (currentEpoch !== entry.sessionEpoch) {
        return { ok: false, error: 'Session epoch revoked', revoked: true, mintedFor: entry.memberPubkey };
    }

    // Node role check, against the role held NOW rather than the one recorded when the token was minted:
    // an owner demoted to admin in the seconds between must not open an owner-level session.
    const liveRole = nodeRoleOf(entry.memberPubkey);
    if (!liveRole) {
        return { ok: false, error: 'Member no longer holds a node role', mintedFor: entry.memberPubkey };
    }

    // Mint browser session (2h idle, or the phone hand-off's 15 min / 12h hard). Never longer than the default.
    const idleTtlMs = Math.min(opts.idleTtlMs ?? SESSION_IDLE_TTL_MS, SESSION_IDLE_TTL_MS);
    const sessionId = crypto.randomBytes(32).toString('hex');
    const session: AdminSession = {
        sessionId,
        kind: 'key',
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

    const csrfToken = issueCsrfToken(sessionId);

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
        revokeAdminSession(sessionId);
        return { valid: false, error: 'Session expired (12h hard limit reached)', expired: true, hardLimit: true };
    }

    // Idle Limit check (2h, or 15 min for the phone app's hand-off)
    if (now > session.idleExpiresAt) {
        revokeAdminSession(sessionId);
        const idleFor = session.idleTtlMs < 60 * 60 * 1000 ? `${Math.round(session.idleTtlMs / 60_000)} min` : `${Math.round(session.idleTtlMs / 3_600_000)}h`;
        return { valid: false, error: `Session expired (${idleFor} idle timeout)`, idle: true, idleTimeout: true };
    }

    if (session.kind === 'password') {
        // The password is owner level and opens no session in break-glass mode (checkAdminAuth). A changed password,
        // or a second factor turned on, off or replaced, ends every session the old one opened, except the session
        // that made the change (restampPasswordSession).
        const ended = isPasswordRetired()
            ? 'The admin password was retired: it signs nobody in'
            : isBreakGlassMode()
            ? 'Break-glass mode is on: the admin password signs in to key enrolment only'
            : session.credentialStamp !== passwordCredentialStamp()
                ? 'The admin password or its 2FA changed since this sign-in'
                : null;
        if (ended) {
            revokeAdminSession(sessionId);
            return { valid: false, error: ended, revoked: true };
        }
        session.lastActiveAt = now;
        session.idleExpiresAt = now + session.idleTtlMs;
        return { valid: true, session };
    }

    // session_epoch check
    const currentEpoch = getNodeRoleSessionEpoch(session.memberPubkey);
    if (currentEpoch !== session.sessionEpoch) {
        revokeAdminSession(sessionId);
        return { valid: false, error: 'Session revoked via epoch bump', revoked: true };
    }

    // Role check. The session's role follows node_roles on every request: checkAdminAuth hands it to the
    // routes as ctx.state.adminRole, so an owner demoted to admin mid-session would otherwise keep
    // owner-only powers (enrol an owner, toggle break-glass) until the session ran out.
    // A moderator whose role is taken away loses the session on the next request the same way.
    const liveRole = nodeRoleOf(session.memberPubkey);
    if (!liveRole) {
        revokeAdminSession(sessionId);
        return { valid: false, error: 'Member no longer holds a node role' };
    }
    session.role = liveRole;

    // Sliding window for idle timeout
    session.lastActiveAt = now;
    session.idleExpiresAt = now + session.idleTtlMs;

    return { valid: true, session };
}

/**
 * Which session something long-lived was opened under (a /ws/logs ticket, then its socket): the session, its member
 * and that member's session_epoch at the time. A password session's member is '' and its epoch 0. Opened with the
 * password itself and no session (passwordCredentialBinding): sessionId '', and the password and second factor then
 * in force.
 */
export interface AdminSessionBinding {
    sessionId: string;
    memberPubkey: string;
    sessionEpoch: number;
    /** No session only: passwordCredentialStamp() when it was opened. */
    credentialStamp?: string;
}

/**
 * The binding for something opened with the password itself (and, with 2FA on, a code), with no session: it carries on
 * only while that password and second factor are in force and break-glass is off, as a password session does. Null in
 * break-glass mode, where the password opens no admin route but key enrolment.
 */
export function passwordCredentialBinding(): AdminSessionBinding | null {
    if (isBreakGlassMode() || isPasswordRetired()) return null;
    return { sessionId: '', memberPubkey: '', sessionEpoch: 0, credentialStamp: passwordCredentialStamp() };
}

/** The binding for a session that is live now, or null. */
export function adminSessionBinding(sessionId: string, now = Date.now()): AdminSessionBinding | null {
    const session = adminSessions.get(sessionId);
    if (!session || !adminSessionBindingLive({ sessionId, memberPubkey: session.memberPubkey, sessionEpoch: session.sessionEpoch }, now)) return null;
    return { sessionId, memberPubkey: session.memberPubkey, sessionEpoch: session.sessionEpoch };
}

/**
 * Whether what was opened under `b` may carry on: its session would pass validateAdminSession now, for the same member
 * and epoch, and still holds a role above moderator (the admin's log is not a moderator route); with no session, the
 * password and second factor it was opened with are still in force and break-glass is off. Changes nothing: no
 * session is ended and no idle window slides, so an open log socket keeps no session alive.
 */
export function adminSessionBindingLive(b: AdminSessionBinding, now = Date.now()): boolean {
    if (!b.sessionId) return !!b.credentialStamp && !isBreakGlassMode() && !isPasswordRetired() && b.credentialStamp === passwordCredentialStamp();
    const session = adminSessions.get(b.sessionId);
    if (!session || session.memberPubkey !== b.memberPubkey || session.sessionEpoch !== b.sessionEpoch) return false;
    if (now > session.hardExpiresAt || now > session.idleExpiresAt) return false;
    if (session.kind === 'password') return !isBreakGlassMode() && !isPasswordRetired() && session.credentialStamp === passwordCredentialStamp();
    if (getNodeRoleSessionEpoch(session.memberPubkey) !== b.sessionEpoch) return false;
    const liveRole = nodeRoleOf(session.memberPubkey);
    return !!liveRole && liveRole !== 'moderator';
}

// Told whenever a session ends here, or every session of a member does: https-server.ts closes the log sockets those
// sessions opened at once, rather than on its next sweep.
const sessionsEndedListeners = new Set<() => void>();

/** Calls `fn` each time a session or a member's sessions end; returns the call that stops it. */
export function onAdminSessionsEnded(fn: () => void): () => void {
    sessionsEndedListeners.add(fn);
    return () => { sessionsEndedListeners.delete(fn); };
}

function noteSessionsEnded(): void {
    for (const fn of sessionsEndedListeners) {
        try { fn(); } catch (err: any) { logger.warn('AUTH', `A sessions-ended listener failed: ${err?.message || err}`); }
    }
}

/**
 * Revokes all web sessions for a member by bumping their session_epoch in SQLite.
 * Existing sessions are invalidated on their next request via the epoch check, and the log sockets they opened close now.
 */
export function revokeAllMemberSessions(memberPubkey: string): number {
    if (!memberPubkey) return 0;
    const newEpoch = bumpNodeRoleSessionEpoch(memberPubkey);
    logger.info('AUTH', `Revoked all web sessions for ${memberPubkey} (new session_epoch: ${newEpoch})`);
    noteSessionsEnded();
    return newEpoch;
}

/**
 * Revokes a single browser session (e.g. logout), and closes the log sockets it opened.
 */
export function revokeAdminSession(sessionId: string): void {
    if (!sessionId) return;
    const had = adminSessions.delete(sessionId);
    revokeCsrfTokensBoundTo(sessionId);
    if (had) noteSessionsEnded();
}

// ===================== PASSWORD SESSIONS =====================

/** Ends every session opened with the password now (the password was retired), and closes the log sockets they opened. */
export function endPasswordSessions(): number {
    let ended = 0;
    for (const [id, s] of adminSessions) {
        if (s.kind !== 'password') continue;
        adminSessions.delete(id);
        revokeCsrfTokensBoundTo(id);
        ended++;
    }
    noteSessionsEnded();
    return ended;
}

/** At most this many password sessions at once; a new one ends the oldest. Each is a sign-in with the password. */
export const MAX_PASSWORD_SESSIONS = 32;

/**
 * Which password and second factor are in force now: a password session or 2FA session opened under any other ends
 * (validateAdminSession, isValid2faSession). Never leaves the process.
 */
export function passwordCredentialStamp(): string {
    const c = getLocalConfig();
    const second = c.totpEnabled && c.totpSecret ? c.totpSecret : '';
    return crypto.createHash('sha256').update(`${c.adminHash || ''}|${c.salt || ''}|${second}`).digest('hex');
}

/**
 * Opens a session for a caller that has just proved the admin password (and, with 2FA on, a code): checkAdminAuth's
 * password path, in POST /api/local/admin/auth/password. The browser gets it as the httpOnly admin_session cookie
 * (setAdminSessionCookie) and keeps no copy of the password: a script on the node's origin can then use the session
 * while it lives, but has nothing to carry away (Fable's web review, M1). Owner level, as the password is; 2h idle,
 * 12h at most, as a key session.
 */
export function createPasswordSession(now = Date.now()): { sessionId: string; csrfToken: string; hardExpiresAt: number; idleExpiresAt: number } {
    const live = [...adminSessions.values()].filter(s => s.kind === 'password').sort((a, b) => a.createdAt - b.createdAt);
    for (const old of live.slice(0, Math.max(0, live.length - MAX_PASSWORD_SESSIONS + 1))) revokeAdminSession(old.sessionId);
    const sessionId = crypto.randomBytes(32).toString('hex');
    const session: AdminSession = {
        sessionId,
        kind: 'password',
        memberPubkey: '',
        role: 'owner',
        sessionEpoch: 0,
        credentialStamp: passwordCredentialStamp(),
        createdAt: now,
        lastActiveAt: now,
        hardExpiresAt: now + SESSION_HARD_TTL_MS,
        idleExpiresAt: now + SESSION_IDLE_TTL_MS,
        idleTtlMs: SESSION_IDLE_TTL_MS,
    };
    adminSessions.set(sessionId, session);
    logger.info('AUTH', 'Opened an admin session with the node password');
    return { sessionId, csrfToken: issueCsrfToken(sessionId), hardExpiresAt: session.hardExpiresAt, idleExpiresAt: session.idleExpiresAt };
}

/**
 * After a route changed the admin password or the 2FA in force: the caller's own password session (if it is one) and
 * 2FA session (restamp2faSessions) carry on under the new ones, every other password or 2FA session ends on its next
 * request. Call it only once the change is on disk.
 */
export function restampPasswordSession(ctx: any): void {
    const id = ctx?.state?.adminSessionId;
    const session = typeof id === 'string' ? adminSessions.get(id) : undefined;
    if (session?.kind === 'password') session.credentialStamp = passwordCredentialStamp();
    restamp2faSessions(ctx);
}

export const ADMIN_SESSION_COOKIE = 'admin_session';

/**
 * The admin session cookie, the one way a browser holds an admin session: httpOnly (no script reads it), SameSite
 * strict (no other site's page sends it), the whole origin (the API is under /api). Its value never appears in a
 * response body (Fable's web review, L3).
 *
 * No Max-Age: a browser-session cookie. The node ends the session (idle limit, SESSION_HARD_TTL_MS), and the cookie
 * must outlive that, so the browser still sends it and the node answers `sessionExpired` with the reason, which
 * sends the manager back to its sign-in card saying why. A Max-Age equal to the hard limit dropped the cookie a few
 * milliseconds before the node's own limit, and the manager was then answered as if it had sent nothing.
 */
export function setAdminSessionCookie(ctx: any, sessionId: string): void {
    ctx.cookies.set(ADMIN_SESSION_COOKIE, sessionId, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
    });
}

export function clearAdminSessionCookie(ctx: any): void {
    if (ctx?.cookies?.set) ctx.cookies.set(ADMIN_SESSION_COOKIE, '', { httpOnly: true, sameSite: 'strict', maxAge: 0, path: '/' });
}

/**
 * Purges all active in-memory admin sessions for a specific member public key.
 */
export function purgeMemberSessions(memberPubkey: string): void {
    if (!memberPubkey) return;
    for (const [sid, sess] of adminSessions.entries()) {
        if (sess.kind === 'key' && sess.memberPubkey === memberPubkey) {
            revokeAdminSession(sid);
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
 * A new break-glass code for a key that holds the owner role now, shown once by the caller. The stored hash is replaced,
 * so any earlier code of that owner's stops working. Grants nothing: a key without the owner role gets an error, and
 * nothing is stored. `by` names who asked, for the log line, which never carries the code; `madeBy` is the kind of
 * session, kept beside the hash for Settings (engine/node-roles.ts BreakGlassMadeBy).
 */
export function issueBreakGlassCode(ownerPubkey: string, by: string, madeBy: BreakGlassMadeBy): string {
    if (nodeRoleOf(ownerPubkey) !== 'owner') {
        throw Object.assign(new Error('Only a key that holds the owner role has a break-glass code'), { status: 409 });
    }
    const code = generateBreakGlassCode();
    setNodeRoleBreakGlassHash(ownerPubkey, hashBreakGlassCode(code), madeBy);
    logger.security('AUTH', `A new break-glass code was made for owner ${ownerPubkey.slice(0, 12)}… by ${by}; any earlier code of theirs no longer works`);
    return code;
}

/**
 * "Sign out everywhere" by an owner, for their own sessions (#1531): their break-glass code stops working too, so a code
 * a stolen session made does not outlive the session. The owner makes a new one from Settings when they need it.
 * Returns whether there was a code to retire.
 */
export function retireBreakGlassCode(ownerPubkey: string): boolean {
    if (!getNodeRoleBreakGlassHash(ownerPubkey)) return false;
    setNodeRoleBreakGlassHash(ownerPubkey, null);
    logger.security('AUTH', `Owner ${ownerPubkey.slice(0, 12)}… signed out everywhere: their break-glass code no longer works`);
    return true;
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
    /** The kind of session enrolling, kept beside a new owner's code for Settings. */
    madeBy?: BreakGlassMadeBy;
}): {
    success: boolean;
    memberPubkey: string;
    role: MemberNodeRole;
    breakGlassCode?: string;
    alertEmitted?: boolean;
} {
    const { targetPubkey, actorPubkey, isBreakGlass = false, role = 'owner', madeBy = null } = params;

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

    // Generate per-owner break-glass code only for a new owner. An owner who already holds the role keeps theirs, or
    // keeps having none (#1531): re-enrolling them must not let any owner session re-make another owner's code, which
    // "Make a break-glass code" refuses a key session (routes/admin.ts). Their own code is theirs to make, in Settings.
    let breakGlassCode: string | undefined;
    if (role === 'owner') {
        if (currentRole !== 'owner') {
            breakGlassCode = generateBreakGlassCode();
            const hash = hashBreakGlassCode(breakGlassCode);
            setNodeRoleBreakGlassHash(targetPubkey, hash, madeBy);
        }
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
