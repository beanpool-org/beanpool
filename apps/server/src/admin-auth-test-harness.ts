/**
 * Admin credentials for server suites. The node has no admin password (Marty, 11 Nov 2026), so a suite signs in as a
 * real owner does: with one of these. Nothing here changes the server: each one is a credential a real owner can hold.
 *
 *   - ownerTokenHeaders: an automation token made from an owner's key (a member seeded here, granted owner), the way an
 *     owner makes one from the phone. It reaches every admin route its scope allows; no token reaches the sign-in,
 *     session, 2FA or token routes (isRefusedToEveryToken).
 *   - ownerSessionHeaders: an owner's key session, as a computer's key sign-in opens one. For owner-only routes, which
 *     no token reaches.
 *   - ownerPhoneSessionHeaders: an owner's key session from the phone's Manage hand-off, just unlocked: for the owner
 *     changes that ask a fresh proof (requireFreshProof), which a computer's session is sent to the phone for.
 *
 * Call either after initStateEngine() (the token's owner is a member row) and before the requests that need it.
 */
import crypto from 'node:crypto';
import { db } from './db/db.js';
import { grantNodeRole } from './state-engine.js';
import { issueAutomationToken, type TokenScope } from './automation-tokens.js';
import { mintHandshakeToken, consumeHandshakeToken, PHONE_HANDOFF_IDLE_TTL_MS } from './admin-key-auth.js';

/** Seed a member that holds the owner role, and return its key. */
export function seedOwnerForTests(callsign = 'testOwner'): string {
    const pub = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pub, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    grantNodeRole(pub, 'owner', 'SYSTEM');
    return pub;
}

/** Headers carrying an owner's automation token of `scope` (an owner is seeded unless `ownerPubkey` is given). */
export function ownerTokenHeaders(scope: TokenScope = 'admin', ownerPubkey?: string): Record<string, string> {
    const createdBy = ownerPubkey ?? seedOwnerForTests(`tokOwner${crypto.randomBytes(3).toString('hex')}`);
    const issued = issueAutomationToken({ name: `suite ${scope}`, scope, createdBy });
    if (!issued.ok) throw new Error(`could not make a test automation token: ${issued.error}`);
    return { Authorization: `Bearer ${issued.token}` };
}

/**
 * Headers carrying an owner's key session (an owner is seeded unless `ownerPubkey` is given): the session a computer's
 * key sign-in opens once its signed challenge checks out (mintHandshakeToken, then the exchange). It reaches owner-only
 * routes, which no token does. Sent as X-Admin-Session, not a cookie, so no CSRF token is asked for.
 */
export function ownerSessionHeaders(ownerPubkey?: string): Record<string, string> {
    const pub = ownerPubkey ?? seedOwnerForTests(`sesOwner${crypto.randomBytes(3).toString('hex')}`);
    const { handshakeToken } = mintHandshakeToken(pub, 'owner');
    const s = consumeHandshakeToken(handshakeToken);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
    return { 'X-Admin-Session': s.sessionId };
}

/**
 * Headers carrying an owner's key session opened by the phone's Manage hand-off, just now (an owner is seeded unless
 * `ownerPubkey` is given): the one key session an owner's fresh proof takes (admin-auth.ts requireFreshProof), within 90
 * seconds of this call. A computer's session (ownerSessionHeaders) is sent to the phone for those changes.
 */
export function ownerPhoneSessionHeaders(ownerPubkey?: string): Record<string, string> {
    const pub = ownerPubkey ?? seedOwnerForTests(`phoneOwner${crypto.randomBytes(3).toString('hex')}`);
    const { handshakeToken } = mintHandshakeToken(pub, 'owner');
    const s = consumeHandshakeToken(handshakeToken, Date.now(), { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS });
    if (!s.ok || !s.sessionId) throw new Error(`could not open a test hand-off session: ${s.error}`);
    return { 'X-Admin-Session': s.sessionId };
}
