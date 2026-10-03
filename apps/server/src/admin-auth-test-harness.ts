/**
 * Admin credentials for server suites, after sign-in step 7c: with the node's 2FA off, the admin password sent with a
 * request (X-Admin-Password, a body `password`) opens no admin route. A suite that runs the server in its own process
 * uses one of these instead. Nothing here changes the server: each one is a credential a real owner can hold.
 *
 *   - ownerTokenHeaders: an automation token made from an owner's key (a member seeded here, granted owner), the way an
 *     owner makes one from the phone. It reaches every admin route its scope allows; no token reaches the sign-in,
 *     session, 2FA or token routes (isRefusedToEveryToken).
 *   - turnOn2faForTests: for a suite whose purpose is the password itself. It turns the node's 2FA on, and
 *     `headers()` sends the password with a fresh code, as an owner with an authenticator does.
 *
 * Call either after initStateEngine() (the token's owner is a member row) and before the requests that need it.
 */
import crypto from 'node:crypto';
import { db } from './db/db.js';
import { grantNodeRole } from './state-engine.js';
import { issueAutomationToken, type TokenScope } from './automation-tokens.js';
import { updateLocalConfig } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, forgetUsedTotpCodesForTests } from './totp.js';

/** Seed a member that holds the owner role, and return its key. */
export function seedOwnerForTests(callsign = 'testOwner'): string {
    const pub = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pub, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
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
 * Turn the node's 2FA on with a new secret. `headers()` returns the password with a code that is right now; the used-code
 * memory is cleared first, so each request may send the same 30-second code (the server refuses a replayed one).
 */
export function turnOn2faForTests(password: string): { secret: string; code: () => string; headers: () => Record<string, string> } {
    const secret = generateTotpSecret();
    updateLocalConfig({ totpEnabled: true, totpSecret: secret, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] });
    const code = () => { forgetUsedTotpCodesForTests(); return generateTotpCode(secret); };
    return { secret, code, headers: () => ({ 'X-Admin-Password': password, 'X-Admin-TOTP': code() }) };
}
