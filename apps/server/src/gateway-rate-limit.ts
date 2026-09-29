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
 * `day_budget`. It bounds every table a member's signed requests write, the money tables included, without touching
 * money code (the rows the server writes for a member on its own, the Pulse harvester's, have their own daily allowance:
 * WRITER_LIMITS.pulseHarvestedItemsPerDay). The admin surface (`/api/local/admin/*`) has its own limiter and is not
 * counted, nor are the read marks (DAY_BUDGET_READ_MARKS): the apps send those on a timer, and they make no new row. It
 * applies whether or not the operator has the minute throttle on: it is what keeps one key from growing the tables a
 * standby copies past its cap.
 *
 * An enterprise's day budget: a write whose path names an enterprise the signer keeps (https-server.ts passes it, from
 * routes/money-limits-gate.ts enterpriseActingFor) is counted against that enterprise, WRITER_LIMITS
 * .enterpriseSignedWritesPerDay, and not against the keeper's own: a keeper running a busy shop must not spend their own
 * day on it, nor the shop's on their own. It also counts against the keeper's enterprise work, WRITER_LIMITS
 * .enterpriseWorkSignedWritesPerDay, across every enterprise they keep, and both must have room: so a shop's keepers
 * together get its whole budget, and one person can't multiply their day by starting enterprises. A made-up, foreign or
 * wound-up enterprise in a path is no enterprise here, and the write counts against the signer as any other. The money
 * limits proper are engine/money-limits.ts.
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
 * The most keys (members' and enterprises' together) the day budget holds counts for at once. Past it, keys with no write
 * in the last day go first, then the keys that have used the least of their budget: forgetting one can only forgive a
 * small part of a day, never a key near its budget.
 */
export const DAY_BUDGET_MAX_KEYS = 50_000;
/** Per key: the hours it wrote in (oldest first, within the day) and how many writes in each. */
interface DayCount { hours: number[]; counts: number[]; total: number }
/**
 * Keyed by the member's key; `ent:` and the enterprise's for an enterprise's own budget; `work:` and a keeper's for what
 * they write for every enterprise they keep.
 */
const dayCounts = new Map<string, DayCount>();
const ENTERPRISE_KEY = 'ent:';
const WORK_KEY = 'work:';
const budgetOf = (key: string) => key.startsWith(ENTERPRISE_KEY) ? WRITER_LIMITS.enterpriseSignedWritesPerDay
    : key.startsWith(WORK_KEY) ? WRITER_LIMITS.enterpriseWorkSignedWritesPerDay : WRITER_LIMITS.signedWritesPerDay;

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
    if (key.startsWith('dayent:')) {
        try { logger.warn('AUTH', `[gateway] day budget reached for enterprise ${key.slice(7, 19)}…; answering 429 enterprise_day_budget to its writes`); } catch { /* logging never blocks a response */ }
        return;
    }
    if (key.startsWith('daywork:')) {
        try { logger.warn('AUTH', `[gateway] enterprise work budget reached for member ${key.slice(8, 20)}…; answering 429 enterprise_work_day_budget to their enterprises' writes`); } catch { /* logging never blocks a response */ }
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

/** The 429 a full day budget answers, by whose it is. */
function dayBudgetRefusal(key: string, limit: number, resetsAtMs: number, now: number): { error: string; code: string; resetsAt: string } {
    const n = limit.toLocaleString('en');
    const when = inAbout(resetsAtMs, now);
    const resetsAt = new Date(resetsAtMs).toISOString();
    if (key.startsWith(ENTERPRISE_KEY)) {
        return { error: `This enterprise has made ${n} changes today (posts, deals, payments and the like), the most one enterprise can make in 24 hours. Its keepers can carry on ${when}.`, code: 'enterprise_day_budget', resetsAt };
    }
    if (key.startsWith(WORK_KEY)) {
        return { error: `You have made ${n} changes today for the enterprises you keep (posts, deals, payments and the like), the most one person can make for all their enterprises together in 24 hours. You can carry on for them ${when}. Your own changes are counted apart.`, code: 'enterprise_work_day_budget', resetsAt };
    }
    return { error: `You have made ${n} changes today (posts, messages, edits and the like), the most one account can make in 24 hours. You can carry on ${when}.`, code: 'day_budget', resetsAt };
}

/**
 * After signature verification: count a verified key's write against its day or, when the write's path names an
 * enterprise the signer keeps (enterpriseActingFor), against `enterprise`'s and the signer's enterprise work. False (and
 * 429 set) when one of those days already holds its budget: `day_budget` for a member's WRITER_LIMITS.signedWritesPerDay,
 * `enterprise_day_budget` for an enterprise's WRITER_LIMITS.enterpriseSignedWritesPerDay, `enterprise_work_day_budget`
 * for a keeper's WRITER_LIMITS.enterpriseWorkSignedWritesPerDay. A refused write isn't counted in any. Reads, the read
 * marks (DAY_BUDGET_READ_MARKS), unsigned requests and the admin surface pass untouched.
 */
export function gatewayAdmitDayBudget(ctx: Koa.Context, now = Date.now(), enterprise: string | null = null): boolean {
    const actor = ctx.state.actor as string | undefined;
    if (!actor || !WRITE_METHODS.has(ctx.method) || ctx.path.startsWith('/api/local/admin/')) return true;
    if (ctx.method === 'POST' && DAY_BUDGET_READ_MARKS.has(ctx.path)) return true;
    const keys = enterprise ? [`${ENTERPRISE_KEY}${enterprise}`, `${WORK_KEY}${actor}`] : [actor];
    const hour = Math.floor(now / HOUR_MS);
    for (const key of keys) {
        const entry = dayCounts.get(key);
        if (entry) dropPastHours(entry, hour);
        const limit = budgetOf(key);
        if (entry && entry.total >= limit) {
            // The oldest hour counted leaves the day at its end, 24 hours on, and gives back at least one write.
            const resetsAtMs = (entry.hours[0] + DAY_HOURS) * HOUR_MS;
            ctx.status = 429;
            ctx.set('Retry-After', String(Math.max(1, Math.ceil((resetsAtMs - now) / 1000))));
            ctx.body = dayBudgetRefusal(key, limit, resetsAtMs, now);
            logTrip(key.startsWith(ENTERPRISE_KEY) ? `dayent:${enterprise}` : key.startsWith(WORK_KEY) ? `daywork:${actor}` : `day:${actor}`, now);
            return false;
        }
    }
    for (const key of keys) {
        let entry = dayCounts.get(key);
        if (!entry) {
            if (dayCounts.size >= DAY_BUDGET_MAX_KEYS) shrinkDayCounts(hour);
            entry = { hours: [], counts: [], total: 0 };
            dayCounts.set(key, entry);
        }
        const last = entry.hours.length - 1;
        if (last >= 0 && entry.hours[last] === hour) entry.counts[last]++;
        else { entry.hours.push(hour); entry.counts.push(1); }
        entry.total++;
    }
    return true;
}

/**
 * Make room below DAY_BUDGET_MAX_KEYS: keys with nothing in the day first, then those that have used the least of their
 * own budget (a member's 5,000, an enterprise's 50,000 or a keeper's enterprise work's 50,000), down to 90%.
 */
function shrinkDayCounts(hour: number): void {
    pruneDayCounts(hour);
    const target = Math.floor(DAY_BUDGET_MAX_KEYS * 0.9);
    if (dayCounts.size <= target) return;
    const smallest = [...dayCounts].sort((a, b) => a[1].total / budgetOf(a[0]) - b[1].total / budgetOf(b[0]));
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
