/**
 * The node-wide brake on guessing the admin password.
 *
 * Every per-address limiter can be spread across addresses: a botnet, a pool of proxies, or one IPv6
 * subscriber's many /64s. The password is the one secret an outsider can try online, so it gets a brake that
 * counts failures for the whole node, whoever sends them:
 *
 *   - the first FREE_FAILURES wrong passwords cost nothing extra (an owner mistyping is not an attack);
 *   - after that, each further failure closes password checking for BASE_DELAY_MS × 2^k, capped at
 *     MAX_DELAY_MS. While it is closed, a password is not checked at all: the caller answers 429 with
 *     Retry-After, even for the right password, because a brake that still tells a guesser "yes" is no brake;
 *   - a correct password (or break-glass code) resets it; so does QUIET_RESET_MS with no failure. Where 2FA
 *     is on, the reset waits for the 2FA code too, so knowing the password does not reopen guessing the code.
 *
 * It never locks anyone out for good: the longest wait is MAX_DELAY_MS. And it only covers the password.
 * Key sign-in (admin-key-auth.ts: a signed challenge, and the sessions it issues) never comes through here, and
 * a break-glass code is still checked while the brake is on: it is 64 random bits, not something a guesser can
 * find online, and it is how an owner enrols a key when the password is under attack.
 *
 * Password checks are async (scrypt on the threadpool), so a burst of parallel guesses could all pass the gate
 * before the first one failed. So attempts in flight count against the free allowance: at most
 * FREE_FAILURES − failures run at once, and once the allowance is spent, one at a time. An attempt over the
 * limit waits for one in flight to settle (a fraction of a second) and is then admitted or refused. It is not
 * refused just for arriving together with others: an owner's dashboard sends several password requests at
 * once, all correct.
 */
import type Koa from 'koa';
import { getLocalConfig, verifyPasswordAsync } from './config/local-config.js';
import { logger } from './logger.js';

export const FREE_FAILURES = 10;
export const BASE_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 10 * 60_000;
export const QUIET_RESET_MS = 30 * 60_000;

let failures = 0;
let lastFailureAt = 0;
let closedUntil = 0;
let backoffLogged = false;

function delayFor(n: number): number {
    const over = n - FREE_FAILURES;
    if (over <= 0) return 0;
    return Math.min(BASE_DELAY_MS * 2 ** Math.min(over - 1, 30), MAX_DELAY_MS);
}

/** Seconds until password checks reopen; 0 when they are open. */
export function passwordBrakeRetryAfter(now = Date.now()): number {
    return now < closedUntil ? Math.max(1, Math.ceil((closedUntil - now) / 1000)) : 0;
}

/** Forget failures after a long quiet spell. */
function decay(now: number): void {
    if (failures > 0 && now - lastFailureAt > QUIET_RESET_MS && now >= closedUntil) {
        failures = 0;
        backoffLogged = false;
    }
}

/** Count one failure (also used for a wrong 2FA code after a right password). */
export function notePasswordFailure(now = Date.now()): void {
    decay(now);
    failures++;
    lastFailureAt = now;
    const delay = delayFor(failures);
    if (delay > 0) {
        closedUntil = Math.max(closedUntil, now + delay);
        if (!backoffLogged) {
            backoffLogged = true;
            try {
                logger.security('AUTH', `[password-brake] ${failures} failed admin password attempts on this node; password checks now back off (up to ${MAX_DELAY_MS / 60_000} min between attempts) until one succeeds. Key sign-in is unaffected.`);
            } catch { /* logging never blocks auth */ }
        }
    }
}

/** A correct password or break-glass code: the brake lets go. */
export function notePasswordSuccess(): void {
    if (backoffLogged) {
        try { logger.security('AUTH', '[password-brake] an admin password check succeeded; the backoff is cleared.'); } catch { /* ignore */ }
    }
    failures = 0;
    lastFailureAt = 0;
    closedUntil = 0;
    backoffLogged = false;
}

let inFlight = 0;
let waiters: Array<() => void> = [];

/**
 * Admit one password attempt. False while the brake is closed. True means the caller checks the password and
 * then MUST call settlePasswordAttempt() exactly once.
 */
export async function acquirePasswordAttempt(): Promise<boolean> {
    for (;;) {
        const now = Date.now();
        if (now < closedUntil) return false;
        decay(now);
        if (failures + inFlight < FREE_FAILURES || inFlight === 0) {
            inFlight++;
            return true;
        }
        await new Promise<void>(resolve => waiters.push(resolve));
    }
}

/**
 * The outcome of an admitted attempt. `ok` with `reset: false` (a right password still waiting on its 2FA code)
 * counts nothing either way; the caller reports the 2FA outcome with notePasswordSuccess/notePasswordFailure.
 */
export function settlePasswordAttempt(ok: boolean, reset = true): void {
    inFlight = Math.max(0, inFlight - 1);
    if (!ok) notePasswordFailure();
    else if (reset) notePasswordSuccess();
    const wake = waiters;
    waiters = [];
    for (const w of wake) w();
}

/** Answer a request refused by the brake. */
export function refuseBraked(ctx: Koa.Context | any): void {
    const wait = passwordBrakeRetryAfter();
    ctx.status = 429;
    if (typeof ctx.set === 'function') ctx.set('Retry-After', String(wait));
    ctx.body = {
        error: `Too many wrong admin passwords on this node. Password sign-in reopens in ${wait}s; signing in with your key still works.`,
        retryAfter: wait,
        passwordBackoff: true,
    };
}

/**
 * Check the node's admin password under the brake.
 *   'ok'     — correct (the brake is reset);
 *   'wrong'  — missing or incorrect (counted), the caller answers 401 as before;
 *   'braked' — not checked; 429 is already set on ctx.
 * A missing password is 'wrong' without being counted: nothing was guessed. `opts.reset: false` leaves the
 * brake as it is on a right password (see settlePasswordAttempt).
 */
export async function checkAdminPassword(ctx: Koa.Context | any, password: unknown, opts: { reset?: boolean } = {}): Promise<'ok' | 'wrong' | 'braked'> {
    const config = getLocalConfig();
    if (!password || !config.adminHash || !config.salt) return 'wrong';
    if (!(await acquirePasswordAttempt())) {
        refuseBraked(ctx);
        return 'braked';
    }
    let ok = false;
    try {
        ok = await verifyPasswordAsync(String(password), config.adminHash, config.salt);
    } finally {
        settlePasswordAttempt(ok, opts.reset !== false);
    }
    return ok ? 'ok' : 'wrong';
}

/** Tests only. */
export function resetPasswordBrake(): void {
    inFlight = 0;
    const wake = waiters;
    waiters = [];
    for (const w of wake) w();
    failures = 0;
    lastFailureAt = 0;
    closedUntil = 0;
    backoffLogged = false;
}
