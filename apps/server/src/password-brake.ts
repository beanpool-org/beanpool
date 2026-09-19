/**
 * The brake on guessing the admin password.
 *
 * The password is the one secret an outsider can try online, so guessing it must stay slow. But on a node with no
 * key owner yet (every node right after its launch update) the password is also the only way in, so no stranger may
 * be able to use the brake to keep the owner out. #937's node-wide brake failed that: anyone could send eleven wrong
 * passwords and refuse the owner's right one for up to ten minutes, again and again.
 *
 * So the brake is per source, with a node-wide cap that a stranger cannot spend on the owner's behalf. A source is
 * the limiter key from client-ip.ts: the IPv4 address, or the IPv6 /64.
 *
 *   1. Per source, exponential backoff. The first SOURCE_FREE_FAILURES wrong passwords cost nothing extra (an
 *      owner mistyping is not an attack). After that each failure closes that source for BASE_DELAY_MS × 2^k,
 *      capped at MAX_DELAY_MS. Only that source: a flood from one address never closes anyone else's door.
 *      A right password from the source clears its record; so does FORGET_MS (a day) with no failure from it.
 *
 *   2. A source with no failure on record is clean, and a clean source's attempt is always checked: no cap, no
 *      queue. That is the promise to the owner: from any network you have not been guessing from today, the right
 *      password always works, whatever anyone else is doing to the node.
 *
 *   3. Everyone else (sources with a failure on record) shares a node-wide allowance of NODE_CHECKS_PER_MIN checks
 *      per minute, so a botnet cannot get round (1) by spreading its guesses thin. The allowance is shared in
 *      three ranks, so an owner who mistyped is not queued behind an attacker:
 *        - 'typo': at most TYPO_FAILURES failures, and its wider prefix (4) is not dirty. May use the whole
 *          allowance, and when one is refused, a free check is held for it for PENDING_HOLD_MS: the ranks below
 *          may not take it. Only these sources are ever held for, so an attacker rotating fresh /64s in a dirty
 *          /48 cannot take every freed check ahead of an owner who mistyped once (Fable's review of #944: 0 of
 *          1078 of the owner's retries over 6 h got through). The owner is checked on the first retry after the
 *          next check frees, which the 429's Retry-After (at most a minute) names.
 *        - 'few': up to SOURCE_FREE_FAILURES failures, or a fresh source in a dirty prefix. The whole allowance,
 *          less the checks held for waiting 'typo' sources.
 *        - 'backoff': a source already in backoff. Only the first NODE_BACKOFF_CHECKS_PER_MIN, less those held.
 *      An attempt over the allowance is refused with Retry-After (at most a minute), not counted.
 *
 *   4. Being clean must not be free to mint. One IPv6 customer can hold a /48: 65,536 /64s, each a fresh clean
 *      source. So failures are also counted per wider prefix (IPv6 /48, IPv4 /24); once a prefix has had
 *      PREFIX_CLEAN_FAILURES failures in a day, its sources no longer count as clean, only as "few failures"
 *      (the top tier of the shared allowance). An owner's own clean source outside that prefix is unaffected.
 *
 *   5. One source for everyone is an operator's mistake, not an attack. A reverse proxy on another host that is not
 *      in TRUSTED_PROXIES makes every member arrive from the proxy's address (client-ip.ts notices: the proxy sends
 *      forwarding headers the node does not believe). Then a few wrong passwords from anyone brake everyone, so such
 *      a source's wait is capped at SHARED_SOURCE_MAX_DELAY_MS (ten minutes, as before #944) rather than an hour,
 *      and the log names the setting that fixes it. A lone guesser can claim this by sending a forwarding header
 *      itself; all it buys is six checks an hour instead of one.
 *
 * One attempt at a time per source: password checks are async (scrypt on the threadpool), so a burst of parallel
 * guesses could otherwise all pass the gate before the first one failed. A second attempt from a source waits for
 * the first to settle (a few milliseconds), then is judged on the result. An owner's dashboard sending several
 * right passwords at once is served one after another, never refused.
 *
 * What a guesser with N sources gets (docs/admin-surface.md §2.6 has the working):
 *   - clean checks: one per source per day, and at most PREFIX_CLEAN_FAILURES a day per /48 or /24;
 *   - everything else: at most NODE_CHECKS_PER_MIN × 60 = 720 an hour across the whole node, and once every
 *     source is in backoff, NODE_BACKOFF_CHECKS_PER_MIN × 60 = 360 an hour.
 *
 * Key sign-in (admin-key-auth.ts: a signed challenge, and the sessions it issues) never comes through here, and a
 * break-glass code is still checked while a source is braked: it is 64 random bits, not guessable online.
 */
import type Koa from 'koa';
import { getLocalConfig, verifyPasswordAsync } from './config/local-config.js';
import { clientLimiterKey, isSharedSourceKey } from './client-ip.js';
import { logger } from './logger.js';

export const SOURCE_FREE_FAILURES = 5;
export const BASE_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 60 * 60_000;
/** A source's failures are remembered this long after its last one; until then it is not clean. */
export const FORGET_MS = 24 * 60 * 60_000;
export const NODE_CHECKS_PER_MIN = 12;
export const NODE_BACKOFF_CHECKS_PER_MIN = 6;
export const PREFIX_CLEAN_FAILURES = 20;
/** A source with at most this many failures, outside a dirty prefix, has checks held for it (the 'typo' rank). */
export const TYPO_FAILURES = 2;
/** How long a refused 'typo' source's claim on a free check lasts; each refusal renews it. */
export const PENDING_HOLD_MS = 5 * 60_000;
/** The longest wait for a source that is really a proxy for everyone (client-ip.ts, isSharedSourceKey). */
export const SHARED_SOURCE_MAX_DELAY_MS = 10 * 60_000;
/**
 * Bounds on remembered sources and prefixes. Both maps are kept in order of last failure (an entry moves to the
 * end when it fails), so the front is always the stalest, and a full map drops from the front: O(1) per new
 * source on average. A dropped source or prefix is just clean again.
 */
export const MAX_SOURCES = 100_000;
export const MAX_PREFIXES = 100_000;

interface SourceState {
    failures: number;
    lastFailureAt: number;
    closedUntil: number;
    busy: boolean;
    waiters: Array<() => void>;
}
interface PrefixState { failures: number; windowStart: number }

const sources = new Map<string, SourceState>();
const prefixes = new Map<string, PrefixState>();
/**
 * 'typo' sources refused for want of a check, each with when its claim lapses; the soonest to lapse first. At most
 * NODE_CHECKS_PER_MIN: a claim only holds back the lower ranks (never another 'typo' source), and that many
 * already hold back all of them.
 */
const pending = new Map<string, number>();
/** When each check from a non-clean source was admitted, over the last minute. */
let nodeChecks: number[] = [];
let lastNodeCapLog = 0;
let lastSharedLog = 0;

function delayFor(failures: number, shared: boolean): number {
    const over = failures - SOURCE_FREE_FAILURES;
    if (over <= 0) return 0;
    return Math.min(BASE_DELAY_MS * 2 ** Math.min(over - 1, 30), shared ? SHARED_SOURCE_MAX_DELAY_MS : MAX_DELAY_MS);
}

/** Set `key` as the newest entry of `map`. */
function touch<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
}

/** The wider block a source belongs to: IPv6 /48 for a /64 key, IPv4 /24 for an address. */
export function prefixOf(key: string): string {
    const v6 = key.match(/^([0-9a-f]+):([0-9a-f]+):([0-9a-f]+):[0-9a-f]+::\/64$/);
    if (v6) return `${v6[1]}:${v6[2]}:${v6[3]}::/48`;
    const v4 = key.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
    if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
    return key;
}

function sourceFor(key: string, now: number): SourceState {
    let s = sources.get(key);
    if (s && !s.busy && s.waiters.length === 0 && s.failures > 0 && now - s.lastFailureAt > FORGET_MS && now >= s.closedUntil) {
        sources.delete(key);
        s = undefined;
    }
    if (!s) {
        if (sources.size >= MAX_SOURCES) dropStalestSource();
        s = { failures: 0, lastFailureAt: 0, closedUntil: 0, busy: false, waiters: [] };
        sources.set(key, s);
    }
    return s;
}

// The fronts of `sources` and `prefixes` are read through iterators that live between calls. A Map iterator skips
// entries deleted behind it and sees entries added after it, so it never passes the same deleted slot twice; a
// fresh `for…of` each time would walk every slot already dropped from the front, which is O(n) again.
let sourceCursor: Iterator<[string, SourceState]> | null = null;
let prefixCursor: Iterator<[string, PrefixState]> | null = null;
let prefixHead: [string, PrefixState] | null = null;

/**
 * Make room for one source by dropping the one that failed longest ago. A source with an attempt in flight is
 * skipped; there are only ever as many of those as requests in flight.
 */
function dropStalestSource(): void {
    for (let restarts = 0; restarts < 2;) {
        sourceCursor ??= sources.entries();
        const r = sourceCursor.next();
        if (r.done) { sourceCursor = null; restarts++; continue; }
        const [k, s] = r.value;
        if (s.busy || s.waiters.length > 0) continue;
        sources.delete(k);
        pending.delete(k);
        return;
    }
}

/** The prefix whose window started longest ago. */
function oldestPrefix(): [string, PrefixState] | undefined {
    // A new window is a new object, so a head that was replaced (and so moved to the end) no longer matches.
    if (prefixHead && prefixes.get(prefixHead[0]) === prefixHead[1]) return prefixHead;
    prefixHead = null;
    for (let restarts = 0; restarts < 2;) {
        prefixCursor ??= prefixes.entries();
        const r = prefixCursor.next();
        if (r.done) { prefixCursor = null; restarts++; continue; }
        return (prefixHead = r.value);
    }
    return undefined;
}

/** Count one failure against the prefix of `key`. */
function notePrefixFailure(key: string, now: number): void {
    const pk = prefixOf(key);
    const p = prefixes.get(pk);
    if (p && now - p.windowStart <= FORGET_MS) {
        p.failures++;
        return;
    }
    // A new window goes to the end, so the map is in order of window start: expired windows leave from the
    // front, and a full map drops its oldest. Each entry leaves once, so this is O(1) on average.
    prefixes.delete(pk);
    for (let h = oldestPrefix(); h && (prefixes.size >= MAX_PREFIXES || now - h[1].windowStart > FORGET_MS); h = oldestPrefix()) {
        prefixes.delete(h[0]);
    }
    prefixes.set(pk, { failures: 1, windowStart: now });
}

/** How many 'typo' sources still hold a claim, after dropping lapsed claims (always at the front). */
function pendingCount(now: number): number {
    for (const [k, until] of pending) {
        if (until > now) break;
        pending.delete(k);
    }
    return pending.size;
}

function prefixFailures(key: string, now: number): number {
    const p = prefixes.get(prefixOf(key));
    return p && now - p.windowStart <= FORGET_MS ? p.failures : 0;
}

type Tier = 'clean' | 'typo' | 'few' | 'backoff';
function tierOf(key: string, s: SourceState, now: number): Tier {
    const dirty = prefixFailures(key, now) >= PREFIX_CLEAN_FAILURES;
    if (s.failures === 0 && !dirty) return 'clean';
    if (s.failures <= TYPO_FAILURES && !dirty) return 'typo';
    return s.failures <= SOURCE_FREE_FAILURES ? 'few' : 'backoff';
}

export type Admission =
    | { admitted: true }
    | { admitted: false; retryAfter: number; reason: 'source' | 'node' };

/**
 * Decide one attempt from `key` without waiting. 'wait' means another attempt from the same source is in flight.
 * Exported for tests (with an injected clock); callers use acquirePasswordAttempt.
 */
export function tryAdmit(key: string, now = Date.now()): Admission | 'wait' {
    const s = sourceFor(key, now);
    if (now < s.closedUntil) {
        return { admitted: false, retryAfter: Math.max(1, Math.ceil((s.closedUntil - now) / 1000)), reason: 'source' };
    }
    if (s.busy) return 'wait';
    const tier = tierOf(key, s, now);
    if (tier !== 'clean') {
        nodeChecks = nodeChecks.filter(t => now - t < 60_000);
        // The ranks below 'typo' must leave a check free for each 'typo' source still waiting. 'typo' sources are
        // not held back by each other's claims: those are for their rank.
        const held = tier === 'typo' ? 0 : pendingCount(now);
        const allowance = (tier === 'backoff' ? NODE_BACKOFF_CHECKS_PER_MIN : NODE_CHECKS_PER_MIN) - held;
        if (nodeChecks.length >= allowance) {
            if (tier === 'typo') {
                touch(pending, key, now + PENDING_HOLD_MS);
                // More claims than the allowance cannot hold back more checks, so keep only the newest.
                if (pending.size > NODE_CHECKS_PER_MIN) pending.delete(pending.keys().next().value!);
            }
            // The allowance frees when the oldest check that fills it leaves the minute; while held checks alone
            // fill it, try again in a minute (a claim is spent or lapses).
            const i = nodeChecks.length - allowance;
            const freesAt = i < nodeChecks.length ? nodeChecks[i] + 60_000 : now + 60_000;
            if (now - lastNodeCapLog > 10 * 60_000) {
                lastNodeCapLog = now;
                try {
                    logger.security('AUTH', `[password-brake] wrong admin passwords are arriving from many addresses; this node now checks at most ${NODE_CHECKS_PER_MIN} a minute from addresses that failed in the last day. Addresses with no failure, and key sign-in, are unaffected.`);
                } catch { /* logging never blocks auth */ }
            }
            return { admitted: false, retryAfter: Math.min(60, Math.max(1, Math.ceil((freesAt - now) / 1000))), reason: 'node' };
        }
        nodeChecks.push(now);
        pending.delete(key);
    }
    s.busy = true;
    return { admitted: true };
}

/**
 * Admit one password attempt from `key`. When admitted, the caller checks the password and then MUST call
 * settlePasswordAttempt(key, …) exactly once.
 */
export async function acquirePasswordAttempt(key: string): Promise<Admission> {
    for (;;) {
        const a = tryAdmit(key);
        if (a !== 'wait') return a;
        const s = sources.get(key)!;
        await new Promise<void>(resolve => s.waiters.push(resolve));
    }
}

/** Count one failure from `key` (also used for a wrong 2FA code after a right password). */
export function notePasswordFailure(key: string, now = Date.now()): void {
    const s = sourceFor(key, now);
    s.failures++;
    s.lastFailureAt = now;
    touch(sources, key, s); // keeps the map in order of last failure, stalest first
    const shared = isSharedSourceKey(key);
    const delay = delayFor(s.failures, shared);
    if (delay > 0) {
        s.closedUntil = Math.max(s.closedUntil, now + delay);
        if (shared) s.closedUntil = Math.min(s.closedUntil, now + SHARED_SOURCE_MAX_DELAY_MS);
        if (s.failures === SOURCE_FREE_FAILURES + 1) {
            try {
                logger.security('AUTH', `[password-brake] ${s.failures} wrong admin passwords from ${key}; that address now backs off (up to ${(shared ? SHARED_SOURCE_MAX_DELAY_MS : MAX_DELAY_MS) / 60_000} min between attempts). Other addresses and key sign-in are unaffected.`);
            } catch { /* logging never blocks auth */ }
        }
        if (shared && now - lastSharedLog > 10 * 60_000) {
            lastSharedLog = now;
            try {
                logger.warn('AUTH', `[password-brake] ${key} passes on requests for other people, but it is not in TRUSTED_PROXIES, so this node sees everyone behind it as one address: wrong admin passwords from any of them make all of them wait (up to ${SHARED_SOURCE_MAX_DELAY_MS / 60_000} min). Add the proxy's address to TRUSTED_PROXIES in the node's .env and restart the node; the restart also clears the brake.`);
            } catch { /* logging never blocks auth */ }
        }
    }
    notePrefixFailure(key, now);
}

/** A right password (with its 2FA code, where 2FA is on) from `key`: that source's record is cleared. */
export function notePasswordSuccess(key: string): void {
    pending.delete(key);
    const s = sources.get(key);
    if (!s) return;
    s.failures = 0;
    s.lastFailureAt = 0;
    s.closedUntil = 0;
}

/**
 * The outcome of an admitted attempt. `ok` with `reset: false` (a right password still waiting on its 2FA code)
 * counts nothing either way; the caller reports the 2FA outcome with notePasswordSuccess/notePasswordFailure.
 */
export function settlePasswordAttempt(key: string, ok: boolean, reset = true, now = Date.now()): void {
    const s = sources.get(key);
    if (!ok) notePasswordFailure(key, now);
    else if (reset) notePasswordSuccess(key);
    if (!s) return;
    s.busy = false;
    const wake = s.waiters;
    s.waiters = [];
    for (const w of wake) w();
}

/** Answer a request the brake refused. */
export function refuseBraked(ctx: Koa.Context | any, refusal: { retryAfter: number; reason: 'source' | 'node' }): void {
    const wait = refusal.retryAfter;
    ctx.status = 429;
    if (typeof ctx.set === 'function') ctx.set('Retry-After', String(wait));
    ctx.body = {
        error: refusal.reason === 'source'
            ? `Too many wrong admin passwords from your network. Try again in ${wait}s, or from another network (mobile data, another Wi-Fi), or sign in with your key.`
            : `This node is getting a lot of wrong admin passwords from elsewhere, so it is checking fewer right now. Try again in ${wait}s, or from another network, or sign in with your key.`,
        retryAfter: wait,
        passwordBackoff: true,
    };
}

/**
 * Check the node's admin password under the brake.
 *   'ok'     — correct (the source's record is cleared);
 *   'wrong'  — missing or incorrect (counted), the caller answers 401 as before;
 *   'braked' — not checked; 429 is already set on ctx.
 * A missing password is 'wrong' without being counted: nothing was guessed. `opts.reset: false` leaves the
 * record as it is on a right password (see settlePasswordAttempt).
 */
export async function checkAdminPassword(ctx: Koa.Context | any, password: unknown, opts: { reset?: boolean } = {}): Promise<'ok' | 'wrong' | 'braked'> {
    const config = getLocalConfig();
    if (!password || !config.adminHash || !config.salt) return 'wrong';
    const key = clientLimiterKey(ctx);
    const admission = await acquirePasswordAttempt(key);
    if (!admission.admitted) {
        refuseBraked(ctx, admission);
        return 'braked';
    }
    let ok = false;
    try {
        ok = await verifyPasswordAsync(String(password), config.adminHash, config.salt);
    } finally {
        settlePasswordAttempt(key, ok, opts.reset !== false);
    }
    return ok ? 'ok' : 'wrong';
}

/** Tests only. */
export function resetPasswordBrake(): void {
    for (const s of sources.values()) {
        const wake = s.waiters;
        s.waiters = [];
        for (const w of wake) w();
    }
    sources.clear();
    prefixes.clear();
    pending.clear();
    sourceCursor = prefixCursor = prefixHead = null;
    nodeChecks = [];
    lastNodeCapLog = 0;
    lastSharedLog = 0;
}

/** Tests only: how much the brake remembers. */
export function passwordBrakeSizes(): { sources: number; prefixes: number; pending: number } {
    return { sources: sources.size, prefixes: prefixes.size, pending: pending.size };
}
