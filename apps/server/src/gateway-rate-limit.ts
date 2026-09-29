/**
 * The gateway's request throttle (on by default: GatewayConfig.rateLimiting, 120 a minute).
 *
 * Buckets:
 *   - `ip:<client>`  — unsigned requests, `maxPerMinute` per real client address (client-ip.ts; an IPv6 client
 *     is counted by its /64, see limiterKeyForIp). It used to key
 *     on the raw socket address, which in tunnel mode is the cloudflared container for EVERY member, so a whole
 *     community shared one 120-a-minute bucket and a busy minute answered 429 to everyone.
 *   - `m:<pubkey>`   — requests with a verified member signature, `maxPerMinute` per member. A hall's wifi or a
 *     carrier NAT puts many members behind one address; each of them gets their own allowance.
 *   - `sig:<client>` — every request that CLAIMS a signature, `maxPerMinute × SIGNED_CEILING_FACTOR` per
 *     address. The member bucket can only be charged after the signature is verified, later in the stack; this
 *     ceiling bounds what one address can push through by attaching signature headers, forged or not.
 *
 * A claimed signature that does not verify is charged to the address's unsigned bucket afterwards, so forged
 * headers buy nothing for that address's plain traffic.
 *
 * The day budget (`gatewayAdmitDayBudget`, W-main): beside the minute buckets, every verified key's writes (POST, PUT,
 * PATCH, DELETE) are counted over a rolling day, and past WRITER_LIMITS.signedWritesPerDay they are answered 429
 * `day_budget`. It bounds every table a member can write, the money tables included, without touching money code. The
 * admin surface (`/api/local/admin/*`) has its own limiter and is not counted, nor are the read marks (DAY_BUDGET_READ_MARKS): the apps send those on a timer, and they make no new row. It
 * applies whether or not the operator has the minute throttle on: it is what keeps one key from growing the tables a
 * standby copies past its cap.
 */
import type Koa from 'koa';
import { clientLimiterKey } from './client-ip.js';
import { logger } from './logger.js';
import { logAddressTag } from './log-address.js';
import { WRITER_LIMITS } from './config/writer-limits.js';

export const SIGNED_CEILING_FACTOR = 10;
const WINDOW_MS = 60_000;

const buckets = new Map<string, { count: number; resetAt: number }>();
const loggedTrips = new Map<string, number>();

// ── The day budget ───────────────────────────────────────────────────────────────────────────────────────────────
const HOUR_MS = 60 * 60 * 1000;
/** The rolling day, in whole hours: this hour and the 23 before it. */
const DAY_HOURS = 24;
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * The most keys the day budget holds counts for at once. Past it, keys with no write in the last day go first, then
 * the keys with the fewest writes: forgetting one can only forgive a small count, never a key near its budget.
 */
export const DAY_BUDGET_MAX_KEYS = 50_000;
/** Per key: the hours it wrote in (oldest first, within the day) and how many writes in each. */
interface DayCount { hours: number[]; counts: number[]; total: number }
const dayCounts = new Map<string, DayCount>();

/**
 * The read marks, left out of the day budget (still under the minute bucket). Each only moves a marker on a row the
 * member already has, so it can't grow a table however often it is sent, and both apps send them on a timer while a chat
 * is open (a phone ~300 an hour, the web app on every poll and doorbell), so counting them spent a real member's day
 * without a change made (PR #1312 review). Exact POST paths as the gateway sees them (ctx.path, never decoded, trimmed
 * or lower-cased), so no other spelling, and no write route, can ride the exemption:
 *   - POST /api/messages/mark-read (routes/messaging.ts): moves last_read_at on the member's own participant row
 *     (engine/messaging.ts markConversationRead), or a keeper's thread_read_cursors row (engine/enterprise-thread.ts
 *     markKeeperThreadRead, one per keeper and enterprise, local and never copied). On a group chat it first mirrors
 *     the member's group membership onto the participant row (syncGroupThreadMembership): one row per group they
 *     joined, which the join itself paid for.
 *   - POST /api/notices/seen (routes/notices.ts): stamps seen_at once on the member's own kept notices.
 */
export const DAY_BUDGET_READ_MARKS: ReadonlySet<string> = new Set(['/api/messages/mark-read', '/api/notices/seen']);

/** Count one request against `key`. False (and 429 set) when the bucket is already full. */
function take(ctx: Koa.Context, key: string, max: number, now: number): boolean {
    if (buckets.size > 20_000) pruneGatewayBuckets(now);
    const entry = buckets.get(key);
    if (entry && now < entry.resetAt) {
        if (entry.count >= max) {
            const waitSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
            ctx.status = 429;
            ctx.set('Retry-After', String(waitSec)); // RFC 6585
            ctx.body = { error: `Gateway rate limit exceeded. Please try again in ${waitSec}s.` };
            logTrip(key, now);
            return false;
        }
        entry.count++;
    } else {
        buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    }
    return true;
}

/** One log line per bucket per window, so a node's logs show when (and for whom) the gateway said 429. */
function logTrip(key: string, now: number): void {
    const last = loggedTrips.get(key);
    if (last && now - last < WINDOW_MS) return;
    loggedTrips.set(key, now);
    // Members are named by a key prefix only, an address by its daily keyed hash only (log-address.ts): a log line never
    // carries one.
    if (key.startsWith('day:')) {
        try { logger.warn('AUTH', `[gateway] day budget reached for member ${key.slice(4, 16)}…; answering 429 day_budget to its writes`); } catch { /* logging never blocks a response */ }
        return;
    }
    const label = key.startsWith('m:') ? `member ${key.slice(2, 14)}…`
        : `${key.startsWith('sig:') ? 'signed requests from ' : ''}${logAddressTag(key.slice(key.indexOf(':') + 1))}`;
    try { logger.warn('AUTH', `[gateway] rate limit reached for ${label}; answering 429 until the window resets`); } catch { /* logging never blocks a response */ }
}

/**
 * Early check, before the body is read. `claimsSignature` means the request carries signature headers on a
 * path where the signature middleware will verify them.
 */
export function gatewayAdmit(ctx: Koa.Context, maxPerMinute: number, claimsSignature: boolean, now = Date.now()): boolean {
    const ip = clientLimiterKey(ctx);
    if (claimsSignature) {
        ctx.state.gatewaySignedClaim = true;
        return take(ctx, `sig:${ip}`, maxPerMinute * SIGNED_CEILING_FACTOR, now);
    }
    return take(ctx, `ip:${ip}`, maxPerMinute, now);
}

/** After signature verification: charge the verified member. */
export function gatewayAdmitMember(ctx: Koa.Context, maxPerMinute: number, now = Date.now()): boolean {
    if (!ctx.state.gatewaySignedClaim || !ctx.state.actor) return true;
    ctx.state.gatewayMemberCharged = true;
    return take(ctx, `m:${ctx.state.actor}`, maxPerMinute, now);
}

/** After the request: a claimed signature that never produced a verified member is charged as unsigned. */
export function gatewaySettle(ctx: Koa.Context, now = Date.now()): void {
    if (!ctx.state.gatewaySignedClaim || ctx.state.gatewayMemberCharged) return;
    const key = `ip:${clientLimiterKey(ctx)}`;
    const entry = buckets.get(key);
    if (entry && now < entry.resetAt) entry.count++;
    else buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
}

/** Forget the hours that have left the rolling day. */
function dropPastHours(entry: DayCount, hour: number): void {
    let gone = 0;
    while (gone < entry.hours.length && entry.hours[gone] <= hour - DAY_HOURS) entry.total -= entry.counts[gone++];
    if (gone) { entry.hours.splice(0, gone); entry.counts.splice(0, gone); }
}

/** "in about 3 hours", from now to when the budget lets up. */
function inAbout(atMs: number, now: number): string {
    const mins = Math.max(1, Math.ceil((atMs - now) / 60_000));
    if (mins < 60) return mins === 1 ? 'in about a minute' : `in about ${mins} minutes`;
    const hours = Math.round(mins / 60);
    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
}

/**
 * After signature verification: count a verified key's write against its day. False (and 429 `day_budget` set) when
 * the key has already made WRITER_LIMITS.signedWritesPerDay writes in the rolling day. A refused write isn't counted.
 * Reads, the read marks (DAY_BUDGET_READ_MARKS), unsigned requests and the admin surface pass untouched.
 */
export function gatewayAdmitDayBudget(ctx: Koa.Context, now = Date.now()): boolean {
    const actor = ctx.state.actor as string | undefined;
    if (!actor || !WRITE_METHODS.has(ctx.method) || ctx.path.startsWith('/api/local/admin/')) return true;
    if (ctx.method === 'POST' && DAY_BUDGET_READ_MARKS.has(ctx.path)) return true;
    const hour = Math.floor(now / HOUR_MS);
    let entry = dayCounts.get(actor);
    if (entry) dropPastHours(entry, hour);
    const limit = WRITER_LIMITS.signedWritesPerDay;
    if (entry && entry.total >= limit) {
        // The oldest hour counted leaves the day at its end, 24 hours on, and gives back at least one write.
        const resetsAtMs = (entry.hours[0] + DAY_HOURS) * HOUR_MS;
        ctx.status = 429;
        ctx.set('Retry-After', String(Math.max(1, Math.ceil((resetsAtMs - now) / 1000))));
        ctx.body = {
            error: `You have made ${limit.toLocaleString('en')} changes today (posts, messages, edits and the like), the most one account can make in 24 hours. You can carry on ${inAbout(resetsAtMs, now)}.`,
            code: 'day_budget',
            resetsAt: new Date(resetsAtMs).toISOString(),
        };
        logTrip(`day:${actor}`, now);
        return false;
    }
    if (!entry) {
        if (dayCounts.size >= DAY_BUDGET_MAX_KEYS) shrinkDayCounts(hour);
        entry = { hours: [], counts: [], total: 0 };
        dayCounts.set(actor, entry);
    }
    const last = entry.hours.length - 1;
    if (last >= 0 && entry.hours[last] === hour) entry.counts[last]++;
    else { entry.hours.push(hour); entry.counts.push(1); }
    entry.total++;
    return true;
}

/** Make room below DAY_BUDGET_MAX_KEYS: keys with nothing in the day first, then the smallest counts, down to 90%. */
function shrinkDayCounts(hour: number): void {
    pruneDayCounts(hour);
    const target = Math.floor(DAY_BUDGET_MAX_KEYS * 0.9);
    if (dayCounts.size <= target) return;
    const smallest = [...dayCounts].sort((a, b) => a[1].total - b[1].total);
    for (let i = 0; i < smallest.length && dayCounts.size > target; i++) dayCounts.delete(smallest[i][0]);
}

/** Forget every key with no write left in the rolling day. */
function pruneDayCounts(hour: number): void {
    for (const [k, entry] of dayCounts) {
        dropPastHours(entry, hour);
        if (entry.total <= 0) dayCounts.delete(k);
    }
}

/** How many keys the day budget holds counts for (tests and diagnostics). */
export function dayBudgetKeyCount(): number {
    return dayCounts.size;
}

/** Drop windows that have closed (the server's periodic cleaner), and the day counts of keys quiet for a day. */
export function pruneGatewayBuckets(now = Date.now()): void {
    for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    for (const [k, t] of loggedTrips) if (now - t >= WINDOW_MS) loggedTrips.delete(k);
    pruneDayCounts(Math.floor(now / HOUR_MS));
}

/** Tests only: forget every bucket, the day counts included. */
export function resetGatewayRateLimit(): void {
    buckets.clear();
    loggedTrips.clear();
    dayCounts.clear();
}
