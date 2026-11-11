import crypto from 'node:crypto';
import { validateAdminSession, verifyBreakGlassCode, clearAdminSessionCookie, phoneStepUpDue, isPhoneHandoffSession, FRESH_PROOF_WINDOW_MS, STEP_UP_REQUIRED_CODE, STEP_UP_REQUIRED_ERROR, adminSessionBinding, adminSessionBindingLive, type AdminSessionBinding } from './admin-key-auth.js';
import { acquirePasswordAttempt, settlePasswordAttempt, refuseBraked, resetPasswordBrake, type Admission } from './password-brake.js';
import { clientLimiterKey } from './client-ip.js';
import { isBreakGlassCodeShape } from './break-glass-code.js';
import { logger } from './logger.js';
import { logAddressTag } from './log-address.js';
import { isNodeOwner, nodeRoleOf } from './engine/node-roles.js';
import { looksLikeAutomationToken, verifyAutomationToken, noteAutomationTokenUse, isRefusedToEveryToken, isBackupsScopeRoute } from './automation-tokens.js';

// The node has no admin password (Marty, 11 Nov 2026): an owner signs in with their key ("Sign in with your phone", the
// app's Manage), a script with an owner's automation token. The one secret still checked here is an owner's break-glass
// code, on the enrol routes only, with async scrypt (break-glass-code.ts) and a GLOBAL failure tarpit: a growing delay on
// FAILED attempts that throttles a distributed / rotating-IP guesser (the per-source brake alone doesn't).
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
    // 0. An owner's automation token (automation-tokens.ts), before any session or code: a bearer value that starts bp_
    // is decided here alone, and never falls through to another credential.
    const bearer = getBearerToken(ctx);
    if (looksLikeAutomationToken(bearer)) return checkAutomationToken(ctx, bearer!);

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
            if (!ctx.state) ctx.state = {};
            // Which session this request rides: CSRF tokens and log-socket tickets are bound to it (below).
            ctx.state.adminSessionId = keySessionToken;
            // Attribution: every admin action performed under a key session is attributed to that member
            // (auth_signer = their pubkey).
            ctx.state.actor = sessionRes.session.memberPubkey;
            ctx.state.auth_signer = sessionRes.session.memberPubkey;
            ctx.state.adminRole = sessionRes.session.role;
            ctx.state.isKeySession = true;
            // A phone hand-off whose unlock is older than PHONE_STEP_UP_WINDOW_MS: owner-only changes wait for
            // Manage again (requirePhoneStepUp).
            ctx.state.phoneStepUpDue = phoneStepUpDue(sessionRes.session);
            // What an owner's fresh proof reads (requireFreshProof): a phone hand-off, and when its unlock was.
            ctx.state.phoneHandoff = isPhoneHandoffSession(sessionRes.session);
            ctx.state.keySessionCreatedAt = sessionRes.session.createdAt;

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
            // A token counts only for the session it was issued to (Fable's web review, L4): a moderator's token
            // is no use on an owner's cookie.
            if (hasCookieSession && isMutatingMethod && reqPath !== '/api/local/admin/csrf-token') {
                if (!csrfHeader || !validateCsrfToken(ctx, keySessionToken)) {
                    ctx.status = 403;
                    ctx.body = { error: 'Invalid or missing CSRF token' };
                    return false;
                }
            } else if (csrfHeader && !validateCsrfToken(ctx, keySessionToken)) {
                ctx.status = 403;
                ctx.body = { error: 'Invalid or expired CSRF token' };
                return false;
            }

            return true;
        } else if (isBreakGlassEnrolRoute(ctx) && sentBreakGlassCode(ctx)) {
            // An owner recovering with their break-glass code while the browser still holds an ended session.
            clearAdminSessionCookie(ctx);
        } else {
            ctx.status = 401;
            ctx.body = { error: sessionRes.error || 'Invalid or expired admin session', sessionExpired: true };
            return false;
        }
    }

    return checkBreakGlassCodeAuth(ctx);
}

/** The enrol routes, the only ones a break-glass code opens (docs/admin-surface.md §2.2: "enrol a new admin key"). */
const BREAK_GLASS_ENROL_ROUTES: readonly string[] = ['/api/local/admin/auth/enrol', '/api/local/admin/auth/break-glass/enrol'];

function isBreakGlassEnrolRoute(ctx: any): boolean {
    return BREAK_GLASS_ENROL_ROUTES.includes(String(ctx.path || ctx.request?.path || ''));
}

/** The break-glass code a request carries: the X-Break-Glass-Code header or the body's `breakGlassCode`, never the URL. */
function sentBreakGlassCode(ctx: any): string | null {
    const raw = (typeof ctx.get === 'function' ? ctx.get('x-break-glass-code') : null) ||
        ctx.request?.headers?.['x-break-glass-code'] ||
        ctx.headers?.['x-break-glass-code'] ||
        ctx.requestBody?.breakGlassCode || ctx.request?.body?.breakGlassCode;
    return raw ? String(raw).trim() : null;
}

export const TOKEN_REFUSED_CODE = 'token_not_allowed';
export const AGENT_TOKEN_ELSEWHERE_ERROR = "An AI assistant's token reaches this server's assistant endpoint (/mcp) and nothing else";
export const TOKEN_OWNER_ONLY_ERROR = 'An automation token never makes owner-only changes: sign in to Settings as an owner';

/**
 * An automation token's request (design step 7, D8). The token is a credential on its own, as a key session is: an owner
 * made it with their key (routes/automation-tokens.ts). Its scope is checked here, before any route runs:
 *   read     GET/HEAD, and the POSTs that only read (READ_ONLY_POSTS); admin level.
 *   backups  BACKUPS_SCOPE_ROUTES and nothing else; owner level on those routes alone.
 *   admin    every route an admin may use; admin level, so every owner-only route refuses it.
 *   agent    no route here at all: an AI assistant's token reaches `/mcp` alone, which reads it itself (agent/mcp-route.ts).
 * No scope reaches signing in, sessions or the tokens themselves (isRefusedToEveryToken), nor an owner-only change
 * (requireAdminRole, requirePhoneStepUp). What it does is the issuing owner's (ctx.state.actor), marked with the
 * token's id (ctx.state.viaToken), and every use is logged with the route, never the secret.
 */
/**
 * The automation token behind this request, for a look log (its id and name, never its secret), or null for a person's
 * own session: its actor is its maker, so without this a script's look reads as the maker's own.
 */
export function lookTokenOf(ctx: any): { id: string; name: string } | null {
    const id = ctx?.state?.automationTokenId;
    return typeof id === 'string' && id ? { id, name: typeof ctx.state.tokenName === 'string' ? ctx.state.tokenName : '' } : null;
}

function checkAutomationToken(ctx: any, presented: string): boolean {
    const method = String(ctx.method || ctx.request?.method || 'GET').toUpperCase();
    const reqPath = String(ctx.path || ctx.request?.path || '');
    const record = verifyAutomationToken(presented);
    if (!record) {
        ctx.status = 401;
        ctx.body = { error: 'Invalid, revoked or expired automation token' };
        logger.warn('AUTH', 'Automation token refused', { route: `${method} ${reqPath}`, from: logAddressTag(ctx) });
        return false;
    }
    // A token lives only as long as its maker is an owner: an owner removed or demoted takes their tokens with them. A
    // record whose maker is not a member's key is refused alike.
    // An AI assistant's (agent) token is an owner's or an admin's own (agent/grants-route.ts), so it lives while its maker
    // is either, as /mcp reads it; here it is refused 403 below whatever its maker.
    const makerRole = typeof record.createdBy === 'string' ? nodeRoleOf(record.createdBy) : null;
    const makerLive = record.scope === 'agent' ? makerRole === 'owner' || makerRole === 'admin'
        : typeof record.createdBy === 'string' && isNodeOwner(record.createdBy);
    if (!makerLive) {
        ctx.status = 401;
        ctx.body = { error: 'Invalid, revoked or expired automation token' };
        logger.warn('AUTH', record.scope === 'agent' ? 'Automation token refused: its maker is no longer an owner or admin'
            : 'Automation token refused: its maker is no longer an owner', { tokenId: record.id, route: `${method} ${reqPath}` });
        return false;
    }
    const refuse = (error: string): false => {
        ctx.status = 403;
        ctx.body = { error, code: TOKEN_REFUSED_CODE, scope: record.scope };
        logger.warn('AUTH', 'Automation token outside its scope', { tokenId: record.id, scope: record.scope, route: `${method} ${reqPath}` });
        return false;
    };
    if (record.scope === 'agent') return refuse(AGENT_TOKEN_ELSEWHERE_ERROR);
    if (isRefusedToEveryToken(method, reqPath)) return refuse('An automation token cannot sign in, open a session or manage tokens');
    if (record.scope === 'read' && !isReadRequest(ctx)) return refuse('This token can only read');
    if (record.scope === 'backups' && !isBackupsScopeRoute(method, reqPath)) return refuse('This token can only take and read backups');
    if (!ctx.state) ctx.state = {};
    ctx.state.automationTokenId = record.id;
    ctx.state.viaToken = record.id;
    ctx.state.tokenName = typeof record.name === 'string' ? record.name : '';
    ctx.state.tokenScope = record.scope;
    ctx.state.tokenOwnerRoute = record.scope === 'backups';
    ctx.state.adminRole = record.scope === 'backups' ? 'owner' : 'admin';
    ctx.state.actor = record.createdBy;
    logger.info('AUTH', 'Automation token used', {
        tokenId: record.id, issuedBy: String(record.createdBy).slice(0, 16), scope: record.scope, route: `${method} ${reqPath}`,
    });
    noteAutomationTokenUse(record.id, `${method} ${reqPath}`);
    return true;
}

/**
 * checkAdminAuth's second half, for a request with no session and no token: an owner's break-glass code
 * (break-glass-code.ts), on the enrol routes and nowhere else. Anywhere else, or with nothing sent, the caller is not
 * signed in (401 notSignedIn). The code is checked under the per-source brake (password-brake.ts) and the global tarpit;
 * a held source still has a code checked at most once every BREAK_GLASS_WHILE_BRAKED_MS (64 random bits are not guessed
 * online, and it is how an owner who lost their phone gets back in while others send junk from the same network).
 */
async function checkBreakGlassCodeAuth(ctx: any): Promise<boolean> {
    const reqPath = ctx.path || ctx.request?.path || '';
    const code = isBreakGlassEnrolRoute(ctx) ? sentBreakGlassCode(ctx) : null;
    if (!code) {
        // Nothing this route reads was sent: no session, no token, no code. That is no guess, so it is not tarpitted and
        // the tarpit doesn't count it: most often it is a manager whose browser no longer holds its session cookie,
        // polling on, and counting those would slow the owner's own next sign-in. `sessionExpired` sends that manager
        // back to its sign-in card (App.tsx sessionEndedRef); a client that never signed in ignores it.
        ctx.status = 401;
        ctx.body = { error: 'Not signed in: no admin session was sent', sessionExpired: true, notSignedIn: true };
        return false;
    }

    const brakeKey = clientLimiterKey(ctx);
    const admission = await acquirePasswordAttempt(brakeKey);
    let refusal: Exclude<Admission, { admitted: true }> | null = admission.admitted ? null : admission;
    let owner: string | null = null;
    try {
        if (isBreakGlassCodeShape(code)) {
            const wait = admission.admitted ? 0 : admitBreakGlassWhileBraked(brakeKey);
            if (wait > 0 && refusal) {
                refusal = { ...refusal, retryAfter: wait };
            } else {
                const ownerMatch = await verifyBreakGlassCode(code);
                if (ownerMatch) owner = ownerMatch.member_pubkey;
                logger.security('AUTH', owner
                    ? `Break-glass code of ${owner.slice(0, 12)}… accepted to enrol an admin key (${reqPath}, from ${logAddressTag(brakeKey)})`
                    : `A wrong break-glass code was refused at ${reqPath} (from ${logAddressTag(brakeKey)})`);
            }
        }
    } finally {
        if (admission.admitted) settlePasswordAttempt(brakeKey, !!owner);
    }

    if (!owner && refusal) {
        refuseBraked(ctx, refusal);
        return false;
    }
    if (!owner) {
        const now = Date.now();
        if (now - adminFailWindowStart > ADMIN_FAIL_WINDOW_MS) { adminAuthFailures = 0; adminFailWindowStart = now; }
        adminAuthFailures++;
        // Progressive delay (cap 5s): tarpits a guesser without hard-locking.
        await new Promise(r => setTimeout(r, Math.min(adminAuthFailures * 250, 5000)));
        ctx.status = 401;
        ctx.body = { error: 'Invalid break-glass code' };
        return false;
    }

    if (!ctx.state) ctx.state = {};
    ctx.state.adminRole = 'owner';
    ctx.state.actor = owner;
    ctx.state.auth_signer = owner;
    ctx.state.isBreakGlassAuth = true;
    if (adminAuthFailures > 0) adminAuthFailures = Math.max(0, adminAuthFailures - 1);
    return true;
}

export type AdminRole = 'owner' | 'admin' | 'moderator';

/**
 * Everything a moderator may call: reading and triaging reports, and taking down a reported post or Pulse item
 * (Marty's decision, 2026-09-19: "real, narrow: reports and removing posts only"). Plus the plumbing of their own
 * session: a fresh CSRF token after a reload, and signing themselves out everywhere. Every other route that calls
 * checkAdminAuth answers a moderator 403 there, before the route runs: default deny, in this one list.
 *
 * Two of these routes narrow further for a moderator (routes/admin.ts): reports/:id/action refuses `suspendUser`
 * and removes a post or Pulse item only through a report that is still open, and posts/:id/delete takes only a
 * post with an open report. A break-glass code never yields a moderator (it is an owner's), so none of this touches it.
 */
export const MODERATOR_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
    { method: 'GET', path: '/api/local/admin/reports' },
    // The one group chat message a report names, opened with its reporter's key (engine/group-chat-report.ts).
    { method: 'GET', path: '/api/local/admin/reports/:id/message' },
    { method: 'POST', path: '/api/local/admin/reports/:id/dismiss' },
    { method: 'POST', path: '/api/local/admin/reports/:id/action' },
    { method: 'POST', path: '/api/local/admin/posts/:id/delete' },
    // The global profile's auto-moderation (G3, D3 = a): restoring a post hidden by reports, and lifting a mute.
    { method: 'POST', path: '/api/local/admin/posts/:id/restore' },
    { method: 'GET', path: '/api/local/admin/members/muted' },
    { method: 'POST', path: '/api/local/admin/members/:pubkey/unmute' },
    // Reports clearing a sender's message requests (engine/request-limits.ts): who is limited, and the undo.
    { method: 'GET', path: '/api/local/admin/members/request-limits' },
    { method: 'POST', path: '/api/local/admin/members/:pubkey/request-limit/undo' },
    // Clean-up by burst (engine/burst-cleanup.ts, S9): the digest, one account's burst, hiding its posts and the undo.
    // Removing its accounts is not here: that stays with owners and admins.
    { method: 'GET', path: '/api/local/admin/bursts' },
    { method: 'GET', path: '/api/local/admin/members/:pubkey/burst' },
    { method: 'POST', path: '/api/local/admin/members/:pubkey/burst/hide' },
    { method: 'POST', path: '/api/local/admin/bursts/:id/undo' },
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
 * ctx.state.adminRole: the member's live node_roles role under a key session, 'owner' under an owner's break-glass code
 * (enrol routes only), 'admin' or 'owner' under a token's scope. A moderator only gets this far on MODERATOR_ROUTES.
 * Answers 403 with `error` and returns false when the role is not in `allowed`.
 */
export function requireAdminRole(ctx: any, allowed: readonly AdminRole[], error: string): boolean {
    const role = ctx.state?.adminRole;
    // An owner-only route, for an automation token: refused, except the backups scope's own routes (checkAdminAuth).
    if (ctx.state?.automationTokenId && !allowed.includes('admin') && !ctx.state.tokenOwnerRoute) {
        ctx.status = 403;
        ctx.body = { error: TOKEN_OWNER_ONLY_ERROR, code: TOKEN_REFUSED_CODE };
        return false;
    }
    if (allowed.includes(role)) {
        // An owner-only change from the phone's Manage hand-off asks for the phone's unlock again (requirePhoneStepUp).
        // Reads are not asked: Settings must keep showing what it shows.
        if (!allowed.includes('admin') && !isReadRequest(ctx) && !requirePhoneStepUp(ctx)) return false;
        return true;
    }
    ctx.status = 403;
    ctx.body = { error };
    return false;
}

/**
 * Owner-only reads that Settings sends as POST (the body says which store, or nothing): they change nothing, so the
 * step-up does not ask for them. Named one by one; every other POST is a change.
 */
const READ_ONLY_POSTS: readonly string[] = [
    '/api/local/admin/offbox-backups/status',
    '/api/local/admin/offbox-backups/list',
    '/api/local/admin/standby-health',
    '/api/local/admin/alerts/status',
];

function requestPathOf(ctx: any): string {
    return String(ctx.path || ctx.request?.path || '').toLowerCase().replace(/\/+$/, '');
}

function isReadRequest(ctx: any): boolean {
    const method = String(ctx.method || ctx.request?.method || '').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return true;
    return method === 'POST' && READ_ONLY_POSTS.includes(requestPathOf(ctx));
}

/**
 * The step-up of decision D2 (2026-10-03): a key sign-in asks for no 2FA code, the phone's lock being the factor, so a
 * session the phone's Manage hand-off opened may make owner-only changes only within PHONE_STEP_UP_WINDOW_MS of that
 * unlock (admin-key-auth.ts phoneStepUpDue). After it, 403 `step_up_required` until Manage is pressed again. Every
 * other session (a computer's) passes. Answers 403 and returns false when the step-up is due.
 */
export function requirePhoneStepUp(ctx: any): boolean {
    // Every owner-only change asks this, so an automation token stops here: no token satisfies a step-up, and none makes
    // an owner-only change (the backups scope's routes only are owner level, and are taken before this).
    if (ctx.state?.automationTokenId) {
        if (ctx.state.tokenOwnerRoute) return true;
        ctx.status = 403;
        ctx.body = { error: TOKEN_OWNER_ONLY_ERROR, code: TOKEN_REFUSED_CODE };
        return false;
    }
    if (!ctx.state?.phoneStepUpDue) return true;
    ctx.status = 403;
    ctx.body = { error: STEP_UP_REQUIRED_ERROR, code: STEP_UP_REQUIRED_CODE };
    return false;
}

/**
 * An owner's fresh proof, every time, for the rare actions that can lose the community's data or address, or lock an owner
 * out (design case 18 §5 and amendment 1: replacing the recovery code, taking the address offline, releasing a name or
 * claiming one while the node publishes another address, making a break-glass code, enrolling an owner key, granting or
 * taking owner or admin, making an automation token, the gateway settings, and removing, re-pointing or shortening off-box
 * backups). Called after requireAdminRole(ctx, ['owner'], …). What it asks depends on the credential checkAdminAuth took:
 *   automation token     never: 403 token_not_allowed;
 *   break-glass code     never (it opens enrolment of a key, nothing else);
 *   owner key session    the phone's Manage hand-off, its unlock younger than FRESH_PROOF_WINDOW_MS (403 step_up_required
 *                        after); a computer's session ("Sign in with your phone") is told to do it from the phone
 *                        (403 phone_required): it has no unlock of its own.
 * Anything else fails closed. `code` is no longer read (it was the admin password's authenticator code); the parameter
 * stays so the routes need not change their calls. `action` ends the sentence "… to <action>". Answers and returns
 * false on refusal.
 */
export const FRESH_PROOF_PHONE_REQUIRED_CODE = 'phone_required';
export const FRESH_PROOF_PHONE_REQUIRED_ERROR = 'Do this from your phone: open BeanPool, press Manage, then make this change there.';
export const FRESH_PROOF_STEP_UP_ERROR = 'Press Manage on your phone again, then make this change within 90 seconds.';
export const FRESH_PROOF_BREAK_GLASS_ERROR = 'A break-glass code enrols a key and nothing else: sign in with that key to make this change.';

export async function requireFreshProof(ctx: any, _code: unknown, _action: string, now = Date.now()): Promise<boolean> {
    const state = ctx.state || {};
    if (state.automationTokenId) {
        ctx.status = 403;
        ctx.body = { error: TOKEN_OWNER_ONLY_ERROR, code: TOKEN_REFUSED_CODE };
        return false;
    }
    if (state.adminRole !== 'owner') {
        ctx.status = 403;
        ctx.body = { error: 'Only an owner can make this change' };
        return false;
    }
    if (state.isBreakGlassAuth) {
        ctx.status = 403;
        ctx.body = { error: FRESH_PROOF_BREAK_GLASS_ERROR };
        return false;
    }
    if (state.isKeySession) {
        if (!state.phoneHandoff) {
            ctx.status = 403;
            ctx.body = { error: FRESH_PROOF_PHONE_REQUIRED_ERROR, code: FRESH_PROOF_PHONE_REQUIRED_CODE, phoneRequired: true };
            return false;
        }
        const createdAt = Number(state.keySessionCreatedAt);
        if (!Number.isFinite(createdAt) || now - createdAt > FRESH_PROOF_WINDOW_MS || now < createdAt) {
            ctx.status = 403;
            ctx.body = { error: FRESH_PROOF_STEP_UP_ERROR, code: STEP_UP_REQUIRED_CODE };
            return false;
        }
        return true;
    }
    // No other credential is an owner's (checkAdminAuth): fail closed.
    ctx.status = 403;
    ctx.body = { error: 'Only an owner can make this change' };
    return false;
}

/**
 * A break-glass code from a source the password brake holds (checkAdminAuth, enrol routes only): at most one check per
 * source every BREAK_GLASS_WHILE_BRAKED_MS, and BREAK_GLASS_WHILE_BRAKED_PER_MIN a minute across the node. Each check is
 * an scrypt per owner (break-glass-code.ts), and a held source is otherwise checked for nothing, so without this bound a
 * few addresses sending well-formed junk could keep the node's threadpool busy. An owner recovering sends one or two;
 * a source the brake admits is not held here (its attempt is already counted), so another network always works.
 */
export const BREAK_GLASS_WHILE_BRAKED_MS = 10_000;
export const BREAK_GLASS_WHILE_BRAKED_PER_MIN = 30;
const breakGlassWhileBraked = new Map<string, number>();
let breakGlassWhileBrakedNode: number[] = [];

/** 0 when this held source may have its code checked now; otherwise the seconds to wait. */
function admitBreakGlassWhileBraked(key: string, now = Date.now()): number {
    const last = breakGlassWhileBraked.get(key);
    if (last !== undefined && now - last < BREAK_GLASS_WHILE_BRAKED_MS) return Math.ceil((BREAK_GLASS_WHILE_BRAKED_MS - (now - last)) / 1000);
    breakGlassWhileBrakedNode = breakGlassWhileBrakedNode.filter(t => now - t < 60_000);
    if (breakGlassWhileBrakedNode.length >= BREAK_GLASS_WHILE_BRAKED_PER_MIN) {
        return Math.max(1, Math.ceil((breakGlassWhileBrakedNode[0] + 60_000 - now) / 1000));
    }
    breakGlassWhileBrakedNode.push(now);
    breakGlassWhileBraked.delete(key);
    breakGlassWhileBraked.set(key, now);
    if (breakGlassWhileBraked.size > 10_000) breakGlassWhileBraked.delete(breakGlassWhileBraked.keys().next().value!);
    return 0;
}

export function resetAdminAuthTarpit(): void {
    adminAuthFailures = 0;
    adminFailWindowStart = Date.now();
    resetPasswordBrake();
    breakGlassWhileBraked.clear();
    breakGlassWhileBrakedNode = [];
}

// ===================== CSRF TOKEN STORE =====================
// #133: Short-lived CSRF tokens issued to an admin session. Tokens are 32 random hex bytes, expire after 4 hours, and
// must be echoed back in the X-CSRF-Token header on all admin state-mutation requests made with the session cookie.
// This provides defence-in-depth against XSS-based CSRF attacks.
//
// Each token is bound to the session it was issued to (Fable's web review, L4). It validates only for that: a token one
// session fetched (a moderator's, say) is refused on another's cookie, and every token of a session goes with it
// (revokeCsrfTokensBoundTo, from revokeAdminSession).

const CSRF_TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const csrfTokens = new Map<string, { expiry: number; binding: string }>();

/** Issue a new CSRF token, for the session `binding` names. */
export function issueCsrfToken(binding: string): string {
    const token = crypto.randomBytes(32).toString('hex');
    csrfTokens.set(token, { expiry: Date.now() + CSRF_TOKEN_TTL_MS, binding });
    // Prune expired tokens opportunistically (hoist now to avoid repeated calls)
    const now = Date.now();
    for (const [t, entry] of csrfTokens) {
        if (now > entry.expiry) csrfTokens.delete(t);
    }
    return token;
}

/** Validate a CSRF token from the request's X-CSRF-Token header, for the session `binding` names. */
export function validateCsrfToken(ctx: any, binding: string): boolean {
    const token: string | undefined =
        (typeof ctx.get === 'function' ? ctx.get('x-csrf-token') : null) ||
        ctx.request?.headers?.['x-csrf-token'] ||
        ctx.headers?.['x-csrf-token'];
    if (!token) return false;
    const entry = csrfTokens.get(token);
    if (!entry) return false;
    if (Date.now() > entry.expiry) {
        csrfTokens.delete(token); // eagerly remove expired entries on encounter
        return false;
    }
    if (entry.binding !== binding) return false;
    // Sliding window: refresh TTL on valid use
    entry.expiry = Date.now() + CSRF_TOKEN_TTL_MS;
    return true;
}

/** Revoke a specific CSRF token (on logout). */
export function revokeCsrfToken(token: string): void {
    csrfTokens.delete(token);
}

/** Revoke every CSRF token bound to `binding` (a session that ended). */
export function revokeCsrfTokensBoundTo(binding: string): void {
    for (const [t, entry] of csrfTokens) {
        if (entry.binding === binding) csrfTokens.delete(t);
    }
}

// ===================== WS TICKET STORE =====================
// Ephemeral single-use tickets for WebSocket connection upgrades, so no session id travels in a URL.
// A ticket is bound to the session (the admin_session cookie) that asked for it: redeemed only while that session is
// live at the same session_epoch, and the log socket it opens is closed when the session ends (https-server.ts).
const WS_TICKET_TTL_MS = 30_000; // 30 seconds
const wsTickets = new Map<string, { expiry: number; binding: AdminSessionBinding }>();

// Periodic background cleanup for expired WebSocket tickets
if (typeof setInterval !== 'undefined') {
    const wsCleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [t, entry] of wsTickets) {
            if (now > entry.expiry) wsTickets.delete(t);
        }
    }, 60_000);
    if (wsCleanupTimer.unref) wsCleanupTimer.unref();
}

/** A ticket for the session `sessionId` (ctx.state.adminSessionId); null with no session, or one that has ended. */
export function issueWsTicket(sessionId?: string | null): string | null {
    const binding = sessionId ? adminSessionBinding(sessionId) : null;
    if (!binding) return null;
    const ticket = crypto.randomBytes(32).toString('hex');
    wsTickets.set(ticket, { expiry: Date.now() + WS_TICKET_TTL_MS, binding });
    const now = Date.now();
    for (const [t, entry] of wsTickets) {
        if (now > entry.expiry) wsTickets.delete(t);
    }
    return ticket;
}

/**
 * Spends a ticket: what it is bound to, or null if it is unknown, spent, expired, or its session has ended or been
 * signed out everywhere since it was issued.
 */
export function redeemWsTicket(ticket: string): { binding: AdminSessionBinding } | null {
    const entry = wsTickets.get(ticket);
    if (!entry) return null;
    wsTickets.delete(ticket); // Single-use: consume immediately
    if (Date.now() > entry.expiry) return null;
    if (!adminSessionBindingLive(entry.binding)) return null;
    return { binding: entry.binding };
}
