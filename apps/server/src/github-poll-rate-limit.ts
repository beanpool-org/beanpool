import type Koa from 'koa';
import { clientLimiterKey } from './client-ip.js';

/**
 * Throttle for the three GitHub sign-in POLL routes (engine/github-device.ts): the member's
 * `/api/recovery/sso/github/poll`, the recovering device's `/api/recovery/collect/github/poll` and the door's
 * `/api/join/github/poll`. One bucket per real client address, shared by all three, keyed as the auth limiter is
 * (client-ip.ts; an IPv6 client is counted by its /64).
 *
 * Its own bucket, apart from the auth limiter (auth-rate-limit.ts). A phone waiting for its member to type the
 * code polls at GitHub's interval, 5 seconds, so 12 a minute for up to 15 minutes. On the auth limiter's 15 a
 * minute, two phones on one address (a household, a hall's wifi, a carrier NAT) filled it between them, and every
 * callsign check, recovery lookup, pairing and admin sign-in from that address was answered 429, the recovering
 * device's own release included. The START routes stay on the auth limiter: one call per sign-in.
 *
 * 60 a minute: five phones polling at the interval at once. Past that a poll is answered 429, which the app treats
 * as still pending, so a crowd behind one address signs in more slowly and nobody else there is locked out. It
 * also bounds what one address can make this node ask GitHub: every poll counts, whatever session it names (an
 * unknown one, or somebody else's), and a session reaches GitHub at most once an interval however often it is
 * polled.
 */
export const GITHUB_POLLS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

const githubPolls = new Map<string, { count: number; resetAt: number }>();

export function githubPollRateLimit(ctx: Koa.Context): boolean {
    const key = clientLimiterKey(ctx);
    const now = Date.now();
    if (githubPolls.size > 2000) pruneGithubPolls(now);
    const entry = githubPolls.get(key);
    if (entry && now < entry.resetAt) {
        if (entry.count >= GITHUB_POLLS_PER_MINUTE) {
            const waitSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
            ctx.status = 429;
            ctx.set('Retry-After', String(waitSec)); // RFC 6585
            ctx.body = { error: `Too many GitHub sign-in checks from this address. Try again in ${waitSec}s` };
            return false;
        }
        entry.count++;
    } else {
        githubPolls.set(key, { count: 1, resetAt: now + WINDOW_MS });
    }
    return true;
}

/** Drop windows that have closed (the server's periodic cleaner). */
export function pruneGithubPolls(now = Date.now()): void {
    for (const [k, v] of githubPolls) {
        if (now >= v.resetAt) githubPolls.delete(k);
    }
}
