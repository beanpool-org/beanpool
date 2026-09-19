import type Koa from 'koa';
import { clientLimiterKey } from './client-ip.js';

/**
 * Rate limiter for auth endpoints (15 attempts per minute per IP): verify-password, recovery lookup, pairing,
 * callsign checks. Chat lines do NOT come through here — they have their own per-member bucket
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

/** Drop windows that have closed (the server's periodic cleaner). */
export function pruneAuthAttempts(now = Date.now()): void {
    for (const [ip, entry] of authAttempts) {
        if (now >= entry.resetAt) authAttempts.delete(ip);
    }
}
