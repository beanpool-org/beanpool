import type Koa from 'koa';
import { clientLimiterKey } from './client-ip.js';

/**
 * Rate limiter for auth endpoints (15 attempts per minute per IP): verify-password, recovery lookup, pairing,
 * callsign checks (but not the open door's: `doorRateLimit` below). Chat lines do NOT come through here — they have their own per-member bucket
 * (chat-rate-limit.ts), so members chatting behind one NAT cannot lock each other out of recovery.
 *
 * Keyed on the real client (client-ip.ts), never Koa's ctx.ip: with app.proxy on that is the leftmost
 * X-Forwarded-For, which any client can set to a fresh value per attempt. An IPv6 client is counted by its
 * /64 (limiterKeyForIp), or it could rotate through its own prefix the same way.
 */
const authAttempts = new Map<string, { count: number; resetAt: number }>();
export function authRateLimit(ctx: Koa.Context): boolean {
    const ip = clientLimiterKey(ctx);
    const now = Date.now();
    if (authAttempts.size > 200) {
        for (const [k, v] of authAttempts) {
            if (now >= v.resetAt) authAttempts.delete(k);
        }
    }
    const entry = authAttempts.get(ip);
    if (entry && now < entry.resetAt) {
        if (entry.count >= 15) {
            const waitSec = Math.ceil((entry.resetAt - now) / 1000);
            ctx.status = 429;
            ctx.body = { error: `Too many attempts. Try again in ${waitSec}s` };
            return false;
        }
        entry.count++;
    } else {
        authAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    }
    return true;
}

/** Drop windows that have closed (the server's periodic cleaner), the door limiter's below with them. */
export function pruneAuthAttempts(now = Date.now()): void {
    for (const [ip, entry] of authAttempts) {
        if (now >= entry.resetAt) authAttempts.delete(ip);
    }
    for (const map of [doorByKey, doorByAddress]) {
        for (const [id, entry] of map) if (now >= entry.resetAt) map.delete(id);
    }
}

/**
 * The door's own limiter (global two-doors design §4.4), in place of the auth limiter's 15 a minute per address on the
 * open door's routes (routes/open-join.ts) and on the name check a joining key signs (routes/community.ts): 20 a minute
 * per signing key, and 600 a minute per address as a flood ceiling. The auth limiter is right for what it guards (a
 * password, a recovery lookup, a pairing), but at the door it turned a hall away after a handful of joins: a join takes
 * at least three of these requests. The door guards nothing a key can't already ask, and its real cost is the work.
 *
 * Both are counted before either is charged, so a request one refuses spends nothing of the other. Answered as the auth
 * limiter answers, 429 with the wait, and a `Retry-After`. Keyed on the real client, as above.
 */
export const DOOR_RATE_LIMIT = { perKey: 20, perAddress: 600, windowMs: 60_000 } as const;
const doorByKey = new Map<string, { count: number; resetAt: number }>();
const doorByAddress = new Map<string, { count: number; resetAt: number }>();

function doorWindowFull(map: Map<string, { count: number; resetAt: number }>, id: string, limit: number, now: number): number | null {
    const entry = map.get(id);
    return entry && now < entry.resetAt && entry.count >= limit ? entry.resetAt : null;
}

function chargeDoor(map: Map<string, { count: number; resetAt: number }>, id: string, now: number): void {
    if (map.size > 10_000) for (const [k, v] of map) if (now >= v.resetAt) map.delete(k);
    const entry = map.get(id);
    if (entry && now < entry.resetAt) entry.count++;
    else map.set(id, { count: 1, resetAt: now + DOOR_RATE_LIMIT.windowMs });
}

/** `key`: the signer, in the member table's spelling. False once the 429 is written. */
export function doorRateLimit(ctx: Koa.Context, key: string): boolean {
    const address = clientLimiterKey(ctx);
    const now = Date.now();
    const until = doorWindowFull(doorByKey, key, DOOR_RATE_LIMIT.perKey, now)
        ?? doorWindowFull(doorByAddress, address, DOOR_RATE_LIMIT.perAddress, now);
    if (until !== null) {
        const waitSec = Math.max(1, Math.ceil((until - now) / 1000));
        ctx.status = 429;
        ctx.set('Retry-After', String(waitSec));
        ctx.body = { error: `Too many attempts. Try again in ${waitSec}s` };
        return false;
    }
    chargeDoor(doorByKey, key, now);
    chargeDoor(doorByAddress, address, now);
    return true;
}
