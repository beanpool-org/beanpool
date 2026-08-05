import { getLocalConfig, verifyPasswordAsync } from './config/local-config.js';

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
    return true;
}

export function resetAdminAuthTarpit(): void {
    adminAuthFailures = 0;
    adminFailWindowStart = Date.now();
}
