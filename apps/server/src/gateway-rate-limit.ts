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
 */
import type Koa from 'koa';
import { clientLimiterKey } from './client-ip.js';
import { logger } from './logger.js';

export const SIGNED_CEILING_FACTOR = 10;
const WINDOW_MS = 60_000;

const buckets = new Map<string, { count: number; resetAt: number }>();
const loggedTrips = new Map<string, number>();

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
    // Members are named by a key prefix only; an address is already in any access log.
    const label = key.startsWith('m:') ? `member ${key.slice(2, 14)}…` : key;
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

/** Drop windows that have closed (the server's periodic cleaner). */
export function pruneGatewayBuckets(now = Date.now()): void {
    for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    for (const [k, t] of loggedTrips) if (now - t >= WINDOW_MS) loggedTrips.delete(k);
}

/** Tests only: forget every bucket. */
export function resetGatewayRateLimit(): void {
    buckets.clear();
    loggedTrips.clear();
}
