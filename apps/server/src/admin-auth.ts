import crypto from 'node:crypto';
import { getLocalConfig, updateLocalConfig, verifyPasswordAsync } from './config/local-config.js';
import { verifyTotpCode } from './totp.js';

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
    if (adminAuthFailures > 0) adminAuthFailures = Math.max(0, adminAuthFailures - 1);

    // #135: TOTP 2FA Verification
    // If 2FA is enabled on the node config, require a valid 6-digit TOTP code or backup code.
    if (config.totpEnabled && config.totpSecret) {
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
        let totpValid = verifyTotpCode(cleanCode, config.totpSecret);

        // Check backup codes if 6-digit TOTP code check didn't match
        if (!totpValid && config.totpBackupCodes && config.totpBackupCodes.length > 0) {
            const codeIndex = config.totpBackupCodes.findIndex(c => c.toLowerCase() === cleanCode.toLowerCase());
            if (codeIndex !== -1) {
                totpValid = true;
                // Consume used single-use backup code
                const updatedCodes = [...config.totpBackupCodes];
                updatedCodes.splice(codeIndex, 1);
                updateLocalConfig({ totpBackupCodes: updatedCodes });
                console.log(`[AdminAuth] 🔑 Admin authenticated using 2FA backup code (${updatedCodes.length} remaining)`);
            }
        }

        if (!totpValid) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid 2FA code', totpRequired: true };
            return false;
        }
    }

    // #133: If a CSRF token is present, validate it as defence-in-depth.
    // Clients that have fetched a token via POST /api/local/admin/csrf-token must
    // send it back. Clients that haven't yet adopted CSRF tokens are unaffected
    // (token absent → skip check). This makes enforcement opt-in but strictly
    // validated once opted in, avoiding a lockout during the migration window.
    const csrfHeader: string | undefined =
        (typeof ctx.get === 'function' ? ctx.get('x-csrf-token') : null) ||
        ctx.request?.headers?.['x-csrf-token'] ||
        ctx.headers?.['x-csrf-token'];
    if (csrfHeader && !validateCsrfToken(ctx)) {
        ctx.status = 403;
        ctx.body = { error: 'Invalid or expired CSRF token' };
        return false;
    }

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
