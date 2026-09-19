import crypto from 'node:crypto';
import { getLocalConfig, updateLocalConfig, verifyPasswordAsync, isBreakGlassMode } from './config/local-config.js';
import { verifyTotpCode, verifyAndFindBackupCodeHash } from './totp.js';
import { validateAdminSession, verifyBreakGlassCode } from './admin-key-auth.js';
import { acquirePasswordAttempt, settlePasswordAttempt, notePasswordFailure, notePasswordSuccess, refundNodeCheck, refuseBraked, resetPasswordBrake, type Admission } from './password-brake.js';
import { clientLimiterKey } from './client-ip.js';

// A2-4 / A2-21: admin auth verifies the password with ASYNC scrypt (off the
// event loop — concurrent dashboard admin POSTs no longer serialize on a
// synchronous KDF and stall the loop into a 502) and applies a GLOBAL
// failure tarpit: a growing delay on FAILED attempts that throttles a
// distributed / rotating-IP brute-force (the per-IP 60/min limit alone didn't).
let adminAuthFailures = 0;
let adminFailWindowStart = Date.now();
const ADMIN_FAIL_WINDOW_MS = 60_000;

function getBearerToken(ctx: any): string | null {
    const authHeader = (typeof ctx.get === 'function' ? ctx.get('authorization') : null) ||
        ctx.request?.headers?.['authorization'] || ctx.headers?.['authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim();
    }
    return null;
}

export async function checkAdminAuth(ctx: any): Promise<boolean> {
    // 1. Key-Based Session Authentication (docs/admin-surface.md §2.1, §2.3)
    const keySessionToken =
        (ctx.cookies && typeof ctx.cookies.get === 'function' ? ctx.cookies.get('admin_session') : null) ||
        (typeof ctx.get === 'function' ? ctx.get('x-admin-session') : null) ||
        ctx.request?.headers?.['x-admin-session'] ||
        ctx.headers?.['x-admin-session'] ||
        getBearerToken(ctx);

    if (keySessionToken) {
        const sessionRes = validateAdminSession(keySessionToken);
        if (sessionRes.valid && sessionRes.session) {
            // Attribution: every admin action performed under a key session is attributed
            // to that member (auth_signer = their pubkey), replacing 'owner:password'
            if (!ctx.state) ctx.state = {};
            ctx.state.actor = sessionRes.session.memberPubkey;
            ctx.state.auth_signer = sessionRes.session.memberPubkey;
            ctx.state.adminRole = sessionRes.session.role;
            ctx.state.isKeySession = true;

            // A moderator's session reaches the moderator routes and nothing else (MODERATOR_ROUTES, below).
            // Checked here, before any route runs, so an admin route that never names a role is still closed to them.
            if (sessionRes.session.role === 'moderator' && !isModeratorRoute(ctx)) {
                ctx.status = 403;
                ctx.body = { error: MODERATOR_REFUSAL, moderator: true };
                return false;
            }

            // #133: CSRF validation for mutating requests with cookie session (or if header provided)
            const reqPath = ctx.path || ctx.request?.path || '';
            const isMutatingMethod = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(ctx.method?.toUpperCase());
            const hasCookieSession = Boolean(ctx.cookies && typeof ctx.cookies.get === 'function' && ctx.cookies.get('admin_session'));
            const csrfHeader = (typeof ctx.get === 'function' ? ctx.get('x-csrf-token') : null) ||
                ctx.request?.headers?.['x-csrf-token'] || ctx.headers?.['x-csrf-token'];
            if (hasCookieSession && isMutatingMethod && reqPath !== '/api/local/admin/csrf-token') {
                if (!csrfHeader || !validateCsrfToken(ctx)) {
                    ctx.status = 403;
                    ctx.body = { error: 'Invalid or missing CSRF token' };
                    return false;
                }
            } else if (csrfHeader && !validateCsrfToken(ctx)) {
                ctx.status = 403;
                ctx.body = { error: 'Invalid or expired CSRF token' };
                return false;
            }

            return true;
        } else {
            const hasExplicitCreds =
                (typeof ctx.get === 'function' && (ctx.get('x-admin-password') || ctx.get('x-break-glass-code'))) ||
                ctx.request?.headers?.['x-admin-password'] ||
                ctx.headers?.['x-admin-password'] ||
                ctx.request?.headers?.['x-break-glass-code'] ||
                ctx.headers?.['x-break-glass-code'] ||
                ctx.requestBody?.password ||
                ctx.request?.body?.password ||
                ctx.requestBody?.breakGlassCode ||
                ctx.request?.body?.breakGlassCode;

            if (hasExplicitCreds) {
                if (ctx.cookies?.set) ctx.cookies.set('admin_session', '', { maxAge: 0, path: '/' });
            } else {
                ctx.status = 401;
                ctx.body = { error: sessionRes.error || 'Invalid or expired admin session', sessionExpired: true };
                return false;
            }
        }
    }

    // 2. Break-glass mode enforcement (docs/admin-surface.md §2.2, §2.4)
    // When breakGlassMode is enabled, password and break-glass credentials can ONLY reach key enrolment!
    const isBreakGlass = isBreakGlassMode();
    const reqPath = ctx.path || ctx.request?.path || '';
    const isEnrolment = reqPath === '/api/local/admin/auth/enrol' ||
                        reqPath === '/api/local/admin/auth/break-glass/enrol' ||
                        reqPath === '/api/local/admin/auth/break-glass/status' ||
                        reqPath === '/api/local/admin/auth/break-glass-status';

    if (isBreakGlass && !isEnrolment) {
        ctx.status = 403;
        ctx.body = {
            error: 'Break-glass mode active: password authentication restricted to key enrolment only',
            breakGlassMode: true,
        };
        return false;
    }

    // 3. Password / Break-glass Code Authentication
    const config = getLocalConfig();
    const headerPass = (typeof ctx.get === 'function' ? ctx.get('x-admin-password') : null) ||
        (typeof ctx.get === 'function' ? ctx.get('x-break-glass-code') : null) ||
        ctx.request?.headers?.['x-admin-password'] ||
        ctx.headers?.['x-admin-password'] ||
        ctx.request?.headers?.['x-break-glass-code'] ||
        ctx.headers?.['x-break-glass-code'];
    // #130: Password must travel in headers or request body only, NEVER in URL query params.
    const rawPass = ctx.requestBody?.password || ctx.request?.body?.password ||
                    ctx.requestBody?.breakGlassCode || ctx.request?.body?.breakGlassCode || headerPass;
    const password = rawPass ? String(rawPass).trim() : null;

    let ok = false;
    let breakGlassOwner: string | null = null;
    // The password brake (password-brake.ts), per source. Under 2FA a source's record clears only when the code
    // passes too.
    const totpOn = !!(config.totpEnabled && config.totpSecret);
    const brakeKey = password ? clientLimiterKey(ctx) : '';
    let refusal: Exclude<Admission, { admitted: true }> | null = null;
    let admitted = false;
    let chargedAt: number | undefined;

    if (password) {
        const admission = await acquirePasswordAttempt(brakeKey);
        admitted = admission.admitted;
        if (!admission.admitted) refusal = admission;
        else chargedAt = admission.chargedAt;
        let pwOk = false;
        try {
            // While the source is braked the password is not checked at all; a break-glass code still is (64 random
            // bits: not guessable online, and how an owner enrols a key while the password is under attack).
            if (admitted && config.adminHash && config.salt && await verifyPasswordAsync(password, config.adminHash, config.salt)) {
                pwOk = true;
                // Which password this request proved, so a route that must also be sent the current password (change
                // password) need not run scrypt, and take the brake, a second time for the same string.
                if (!ctx.state) ctx.state = {};
                ctx.state.verifiedAdminPassword = password;
            } else {
                const ownerMatch = verifyBreakGlassCode(password);
                if (ownerMatch) {
                    pwOk = true;
                    breakGlassOwner = ownerMatch.member_pubkey;
                }
            }
        } finally {
            if (admitted) settlePasswordAttempt(brakeKey, pwOk, !totpOn);
        }
        ok = pwOk;
    }

    if (!ok && refusal) {
        refuseBraked(ctx, refusal);
        return false;
    }

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

    if (!ctx.state) ctx.state = {};
    if (!ctx.state.adminRole) ctx.state.adminRole = 'owner';
    // This request has had its one brake admission for this source; requireCurrentSecondFactor counts against it.
    ctx.state.passwordBrakeKey = admitted ? brakeKey : undefined;
    let viaSession = false;
    if (breakGlassOwner) {
        ctx.state.actor = breakGlassOwner;
        ctx.state.auth_signer = breakGlassOwner;
        ctx.state.isBreakGlassAuth = true;
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
            // Session token is valid — 2FA already verified this session. It clears nothing on the password brake:
            // only a code checked now does (below, verify-password, requireCurrentSecondFactor). A session is a
            // bearer token; if it cleared the record, someone holding it could send wrong current codes to 2FA
            // disable or re-enrol, each wiped by their next request, and never be slowed (Fable's review of #953).
            // Nor does it ease the tarpit below, for the same reason.
            viaSession = true;
            // But this request is no guess: the password is right and the session valid. So it hands back the
            // node-wide check it took (password-brake.ts, 3). Otherwise, after one wrong current code, the owner's
            // own dashboard polling spends the whole allowance and is refused (Fable's review of #955, B1). A code
            // this request goes on to check (requireCurrentSecondFactor) is admitted afresh, so it still costs one.
            if (admitted) {
                refundNodeCheck(chargedAt);
                ctx.state.passwordBrakeKey = undefined;
            }
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
            if (admitted) notePasswordFailure(brakeKey);
            ctx.status = 401;
            ctx.body = { error: 'Invalid 2FA code', totpRequired: true };
            return false;
        }

        // TOTP validation succeeded — issue a 2FA session token so the caller can
        // skip TOTP on subsequent requests. This is the same token issued by the
        // /api/admin/login endpoint, but happens inline for headless clients (e.g.
        // fleet manager) that authenticate via X-Admin-Password + X-Admin-TOTP
        // headers directly rather than through the login endpoint.
        const newSessionToken = issue2faSessionToken();
        // Attach to the response so the caller can stash it for future requests.
        // Only set if the body isn't already written (API endpoints may call
        // checkAdminAuth early and write their own body later — we use a flag on
        // ctx.state to hand off the token without fighting the response).
        if (!ctx.state) ctx.state = {};
        ctx.state.tfaSessionToken = newSessionToken;
        // This request carried a code that was right just now (not a session from earlier). Turning 2FA off
        // asks for exactly that (requireCurrentSecondFactor), and a backup code is already spent by here.
        ctx.state.secondFactorJustVerified = true;
        if (admitted) notePasswordSuccess(brakeKey);
        } // end of else block (no valid 2FA session token)
    }

    // #135 CR2: Reset tarpit failure count on successful authentication (a 2FA session alone is not one: above)
    if (!viaSession && adminAuthFailures > 0) adminAuthFailures = Math.max(0, adminAuthFailures - 1);

    return true;
}

export type AdminRole = 'owner' | 'admin' | 'moderator';

/**
 * Everything a moderator may call: reading and triaging reports, and taking down a reported post or Pulse item
 * (Marty's decision, 2026-09-19: "real, narrow: reports and removing posts only"). Plus the plumbing of their own
 * session: a fresh CSRF token after a reload, and signing themselves out everywhere. Every other route that calls
 * checkAdminAuth answers a moderator 403 there, before the route runs: default deny, in this one list.
 *
 * Two of these routes narrow further for a moderator: reports/:id/action refuses `suspendUser`, and
 * posts/:id/delete takes only a post someone has reported (routes/admin.ts). The password path never yields a
 * moderator (it is owner level), so none of this touches it.
 */
export const MODERATOR_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
    { method: 'GET', path: '/api/local/admin/reports' },
    { method: 'POST', path: '/api/local/admin/reports/:id/dismiss' },
    { method: 'POST', path: '/api/local/admin/reports/:id/action' },
    { method: 'POST', path: '/api/local/admin/posts/:id/delete' },
    { method: 'POST', path: '/api/local/admin/csrf-token' },
    { method: 'POST', path: '/api/local/admin/auth/revoke-all' },
];

export const MODERATOR_REFUSAL = 'Moderators can review reports and remove reported posts only';

const MODERATOR_ROUTE_PATTERNS = MODERATOR_ROUTES.map(r => ({
    method: r.method,
    re: new RegExp('^' + r.path.replace(/:[A-Za-z]+/g, '[^/]+') + '/?$'),
}));

/** Whether this request is one a moderator's session may make. */
export function isModeratorRoute(ctx: any): boolean {
    const method = String(ctx.method || '').toUpperCase();
    const reqPath = String(ctx.path || ctx.request?.path || '');
    return MODERATOR_ROUTE_PATTERNS.some(r => r.method === method && r.re.test(reqPath));
}

/**
 * The role gate that follows checkAdminAuth on an admin route. checkAdminAuth has already set
 * ctx.state.adminRole: the member's live node_roles role under a key session, 'owner' under the node password
 * (only owners hold it) or a break-glass code. A moderator only gets this far on MODERATOR_ROUTES.
 * Answers 403 with `error` and returns false when the role is not in `allowed`.
 */
export function requireAdminRole(ctx: any, allowed: readonly AdminRole[], error: string): boolean {
    const role = ctx.state?.adminRole;
    if (allowed.includes(role)) return true;
    ctx.status = 403;
    ctx.body = { error };
    return false;
}

/**
 * Proof, in this request, that the caller holds the node's second factor now: a code from the authenticator, or
 * one unused backup code (spent here). A 2FA session from an earlier sign-in, or a key session, is not enough: this
 * guards turning 2FA off and replacing the authenticator, which is what someone holding a stolen session would want
 * to do. A backup code counts so that an owner who has lost the phone can still do both.
 *
 * When checkAdminAuth took this request's code inline it has already checked it (and spent a backup code), so that
 * counts. Otherwise the code is checked under the password brake (password-brake.ts), for key sessions too: a wrong
 * code is a failure from that source (so wrong codes back off exactly as wrong passwords do, and share the count with
 * them), a right one clears the source's record. A braked source is answered 429 without the code being checked. A
 * wrong code also costs the global tarpit. `action` ends the error's
 * sentence "Enter a current code … ". Answers 401 or 429 and returns false on failure.
 */
export async function requireCurrentSecondFactor(ctx: any, code: unknown, action = 'to turn 2FA off'): Promise<boolean> {
    if (ctx.state?.secondFactorJustVerified) return true;
    if (!getLocalConfig().totpEnabled || !getLocalConfig().totpSecret) return true;
    const clean = code === undefined || code === null ? '' : String(code).trim();
    if (!clean) {
        ctx.status = 401;
        ctx.body = { error: `Enter a current code from your authenticator app (or a backup code) ${action}`, totpRequired: true };
        return false;
    }
    // A password caller was admitted by the brake moment ago in checkAdminAuth (a braked source never gets this far):
    // the code counts against that same admission, so a request costs the node-wide allowance once, not twice.
    // Anyone else (a key session, a break-glass code) is admitted here.
    const admittedKey: string | undefined = ctx.state?.passwordBrakeKey;
    const key = admittedKey ?? clientLimiterKey(ctx);
    if (!admittedKey) {
        const admission = await acquirePasswordAttempt(key);
        if (!admission.admitted) {
            refuseBraked(ctx, admission);
            return false;
        }
    }
    let ok = false;
    try {
        // Read after the wait: another request may have spent a backup code, or changed the secret, meanwhile.
        const config = getLocalConfig();
        if (config.totpEnabled && config.totpSecret) {
            ok = verifyTotpCode(clean, config.totpSecret);
            if (!ok) {
                const hashes = config.totpBackupCodesHashes || [];
                const i = hashes.length > 0 ? verifyAndFindBackupCodeHash(clean, hashes) : -1;
                if (i !== -1) {
                    const updated = [...hashes];
                    updated.splice(i, 1);
                    updateLocalConfig({ totpBackupCodesHashes: updated });
                    ok = true;
                }
            }
        }
    } finally {
        if (admittedKey) {
            if (ok) notePasswordSuccess(key); else notePasswordFailure(key);
        } else {
            settlePasswordAttempt(key, ok);
        }
    }
    if (!ok) {
        adminAuthFailures++;
        await new Promise(r => setTimeout(r, Math.min(adminAuthFailures * 250, 5000)));
        ctx.status = 401;
        ctx.body = { error: 'Invalid 2FA code', totpRequired: true };
        return false;
    }
    return true;
}

export function resetAdminAuthTarpit(): void {
    adminAuthFailures = 0;
    adminFailWindowStart = Date.now();
    resetPasswordBrake();
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
