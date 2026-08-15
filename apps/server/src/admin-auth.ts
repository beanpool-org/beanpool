import crypto from 'node:crypto';
import { getLocalConfig, updateLocalConfig, verifyPasswordAsync } from './config/local-config.js';
import { verifyTotpCode, verifyAndFindBackupCodeHash } from './totp.js';

// A2-4 / A2-21: admin auth verifies the password with ASYNC scrypt (off the
// event loop — concurrent dashboard admin POSTs no longer serialize on a
// synchronous KDF and stall the loop into a 502) and applies a GLOBAL
// failure tarpit: a growing delay on FAILED attempts that throttles a
// distributed / rotating-IP brute-force (the per-IP 60/min limit alone didn't).
let adminAuthFailures = 0;
let adminFailWindowStart = Date.now();
const ADMIN_FAIL_WINDOW_MS = 60_000;

export async function checkAdminAuth(ctx: any): Promise<boolean> {
    const config = getLocalConfig();
    const headerPass = (typeof ctx.get === 'function' ? ctx.get('x-admin-password') : null) || ctx.request?.headers?.['x-admin-password'] || ctx.headers?.['x-admin-password'];
    // #130: Password must travel in X-Admin-Password header or request body only, NEVER in URL query params.
    const password = ctx.requestBody?.password || ctx.request?.body?.password || headerPass;
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
    // #133: If a CSRF token is present, validate it as defence-in-depth BEFORE state mutations (like 2FA backup code consumption).
    const csrfHeader: string | undefined =
        (typeof ctx.get === 'function' ? ctx.get('x-csrf-token') : null) ||
        ctx.request?.headers?.['x-csrf-token'] ||
        ctx.headers?.['x-csrf-token'];
    if (csrfHeader && !validateCsrfToken(ctx)) {
        ctx.status = 403;
        ctx.body = { error: 'Invalid or expired CSRF token' };
        return false;
    }

    // #135: TOTP 2FA Verification
    // Re-fetch fresh config to avoid reading a stale snapshot across the async password verify boundary.
    const currentConfig = getLocalConfig();
    if (currentConfig.totpEnabled && currentConfig.totpSecret) {
        // Check for a valid 2FA session token first (issued after successful TOTP login).
        // This allows subsequent API calls to skip TOTP re-entry within the session.
        const sessionToken = (typeof ctx.get === 'function' ? ctx.get('x-admin-2fa-session') : null) ||
            ctx.request?.headers?.['x-admin-2fa-session'] ||
            ctx.headers?.['x-admin-2fa-session'];
        if (sessionToken && isValid2faSession(sessionToken)) {
            // Session token is valid — 2FA already verified this session
        } else {
        const totpHeader = (typeof ctx.get === 'function' ? ctx.get('x-admin-totp') : null) ||
            ctx.request?.headers?.['x-admin-totp'] ||
            ctx.headers?.['x-admin-totp'] ||
            ctx.requestBody?.totpCode ||
            ctx.request?.body?.totpCode;

        if (!totpHeader) {
            ctx.status = 401;
            ctx.body = { error: '2FA code required', totpRequired: true };
            return false;
        }

        const cleanCode = String(totpHeader).trim();
        let totpValid = verifyTotpCode(cleanCode, currentConfig.totpSecret);

        // Check backup code SHA-256 hashes using timingSafeEqual if 6-digit TOTP code check didn't match
        const backupHashes = currentConfig.totpBackupCodesHashes || [];
        if (!totpValid && backupHashes.length > 0) {
            const codeIndex = verifyAndFindBackupCodeHash(cleanCode, backupHashes);
            if (codeIndex !== -1) {
                totpValid = true;
                // Consume used single-use backup code (CSRF has already been validated above)
                const updatedHashes = [...backupHashes];
                updatedHashes.splice(codeIndex, 1);
                updateLocalConfig({ totpBackupCodesHashes: updatedHashes });
                console.log(`[AdminAuth] 🔑 Admin authenticated using 2FA backup code (${updatedHashes.length} remaining)`);
            }
        }

        if (!totpValid) {
            // #135 CR: Increment tarpit counter on 2FA code failure so TOTP codes cannot be brute-forced
            adminAuthFailures++;
            ctx.status = 401;
            ctx.body = { error: 'Invalid 2FA code', totpRequired: true };
            return false;
        }
        } // end of else block (no valid 2FA session token)
    }

    // #135 CR2: Reset tarpit failure count on successful authentication
    if (adminAuthFailures > 0) adminAuthFailures = Math.max(0, adminAuthFailures - 1);

    return true;
}

export function resetAdminAuthTarpit(): void {
    adminAuthFailures = 0;
    adminFailWindowStart = Date.now();
}

// ===================== CSRF TOKEN STORE =====================
// #133: Short-lived CSRF tokens issued after successful password verification.
// Tokens are 32 random hex bytes, expire after 4 hours, and must be echoed
// back in the X-CSRF-Token header on all admin state-mutation requests.
// This provides defence-in-depth against XSS-based CSRF attacks.

const CSRF_TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const csrfTokens = new Map<string, number>(); // token → expiry timestamp

/** Issue a new CSRF token (called after successful password authentication). */
export function issueCsrfToken(): string {
    const token = crypto.randomBytes(32).toString('hex');
    csrfTokens.set(token, Date.now() + CSRF_TOKEN_TTL_MS);
    // Prune expired tokens opportunistically (hoist now to avoid repeated calls)
    const now = Date.now();
    for (const [t, exp] of csrfTokens) {
        if (now > exp) csrfTokens.delete(t);
    }
    return token;
}

/** Validate a CSRF token from the request's X-CSRF-Token header. */
export function validateCsrfToken(ctx: any): boolean {
    const token: string | undefined =
        (typeof ctx.get === 'function' ? ctx.get('x-csrf-token') : null) ||
        ctx.request?.headers?.['x-csrf-token'] ||
        ctx.headers?.['x-csrf-token'];
    if (!token) return false;
    const expiry = csrfTokens.get(token);
    if (!expiry) return false;
    if (Date.now() > expiry) {
        csrfTokens.delete(token); // eagerly remove expired entries on encounter
        return false;
    }
    // Sliding window: refresh TTL on valid use
    csrfTokens.set(token, Date.now() + CSRF_TOKEN_TTL_MS);
    return true;
}

/** Revoke a specific CSRF token (on logout). */
export function revokeCsrfToken(token: string): void {
    csrfTokens.delete(token);
}

// ===================== WS TICKET STORE =====================
// Ephemeral single-use tickets for WebSocket connection upgrades.
// Prevents transmitting raw admin passwords in URL query parameters.
const WS_TICKET_TTL_MS = 30_000; // 30 seconds
const wsTickets = new Map<string, number>(); // ticket -> expiry timestamp

// Periodic background cleanup for expired WebSocket tickets
if (typeof setInterval !== 'undefined') {
    const wsCleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [t, exp] of wsTickets) {
            if (now > exp) wsTickets.delete(t);
        }
    }, 60_000);
    if (wsCleanupTimer.unref) wsCleanupTimer.unref();
}

export function issueWsTicket(): string {
    const ticket = crypto.randomBytes(32).toString('hex');
    wsTickets.set(ticket, Date.now() + WS_TICKET_TTL_MS);
    const now = Date.now();
    for (const [t, exp] of wsTickets) {
        if (now > exp) wsTickets.delete(t);
    }
    return ticket;
}

export function isValidWsTicket(ticket: string): boolean {
    const expiry = wsTickets.get(ticket);
    if (!expiry) return false;
    wsTickets.delete(ticket); // Single-use: consume immediately
    return Date.now() <= expiry;
}

// ===================== 2FA SESSION TOKEN STORE =====================
// After successful password + TOTP login, a session token is issued so the
// frontend doesn't need to re-enter TOTP on every API call. Tokens expire
// after 4 hours (same as CSRF tokens). Multi-use within the session.
const TFA_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const tfaSessionTokens = new Map<string, number>(); // token → expiry

export function issue2faSessionToken(): string {
    const token = crypto.randomBytes(32).toString('hex');
    tfaSessionTokens.set(token, Date.now() + TFA_SESSION_TTL_MS);
    // Prune expired tokens opportunistically
    const now = Date.now();
    for (const [t, exp] of tfaSessionTokens) {
        if (now > exp) tfaSessionTokens.delete(t);
    }
    return token;
}

export function isValid2faSession(token: string): boolean {
    const expiry = tfaSessionTokens.get(token);
    if (!expiry) return false;
    if (Date.now() > expiry) {
        tfaSessionTokens.delete(token);
        return false;
    }
    // Sliding window: refresh TTL on valid use
    tfaSessionTokens.set(token, Date.now() + TFA_SESSION_TTL_MS);
    return true;
}

export function revoke2faSession(token: string): void {
    tfaSessionTokens.delete(token);
}
