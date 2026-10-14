import { isIPv4 } from 'node:net';

/**
 * Rate limits (key vault design §1.6), in memory only: nothing about who asked is written anywhere, and a restart
 * forgets them. Fixed windows per key.
 */
export class RateLimiter {
    private readonly hits = new Map<string, { start: number; count: number }>();

    constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxKeys = 100_000) {}

    /** Counts one against `key`; refused once `limit` are counted in the current window. */
    take(key: string, now: number): { ok: true } | { ok: false; retryAfterMs: number } {
        let entry = this.hits.get(key);
        if (!entry || now - entry.start >= this.windowMs) {
            if (!entry && this.hits.size >= this.maxKeys) this.prune(now);
            entry = { start: now, count: 0 };
            this.hits.set(key, entry);
        }
        if (entry.count >= this.limit) return { ok: false, retryAfterMs: entry.start + this.windowMs - now };
        entry.count++;
        return { ok: true };
    }

    private prune(now: number): void {
        for (const [k, e] of this.hits) if (now - e.start >= this.windowMs) this.hits.delete(k);
        // Still full: a flood of distinct keys. Forget the oldest half rather than grow without bound.
        if (this.hits.size >= this.maxKeys) {
            let drop = Math.floor(this.hits.size / 2);
            for (const k of this.hits.keys()) {
                if (drop-- <= 0) break;
                this.hits.delete(k);
            }
        }
    }
}

/**
 * The address a limit counts against: an IPv4 address as it is, an IPv6 address by its /64 (one household or one
 * server), and an IPv4-mapped IPv6 address as the IPv4 it is.
 */
export function addressBucket(address: string | undefined): string {
    const a = String(address ?? '').trim().toLowerCase();
    if (!a) return 'unknown';
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return mapped[1];
    if (isIPv4(a)) return a;
    const [head, tail] = a.split('::');
    const left = head ? head.split(':') : [];
    const right = tail !== undefined && tail ? tail.split(':') : [];
    const groups = tail === undefined ? left : [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    return `${groups.slice(0, 4).map(g => g || '0').join(':')}::/64`;
}
