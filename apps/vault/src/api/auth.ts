import type { IncomingHttpHeaders } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { isVaultKeyHex, signedRequestBytes, signedRequestText } from '@beanpool/core';

/**
 * Signed requests to the vault: BeanPool's request format 2 (@beanpool/core request-signing.ts), so the phone signs a
 * vault request exactly as it signs one to its community, with the vault's own host name inside the signature:
 *
 *   X-Public-Key, X-Signature, X-Timestamp, X-Nonce, X-Signed-For
 *   over 0xFF ‖ "beanpool-request/2\n" HOST "\n" METHOD "\n" PATH "\n" TIMESTAMP "\n" NONCE "\n" BODY
 *
 * HOST must be one of the vault's names, so a request signed for a community is refused here (and one signed for the
 * vault is refused by every community). The old unbound format is never accepted: the vault has no old apps.
 *
 * Checked in this order: the key's spelling, the host, freshness, the signature, and only then the nonce is spent, so
 * a forged request can't burn a real one. Nonces are kept in memory: a vault-api restart forgets them, and a request
 * replayed across one gains nothing, since every answer that matters is sealed to a key the request names.
 */

export const SIGNATURE_FRESHNESS_MS = 5 * 60 * 1000;

/** A store this small is not swept on `consume`: the hourly job's `prune` (server.ts) is enough for it. */
export const NONCE_SWEEP_ABOVE = 50_000;

/**
 * Single-use nonces within the freshness window, counted from the request's own timestamp.
 *
 * Forgetting is driven by a min-heap of (expiry, nonce) beside the map, as in the server's NonceStore
 * (apps/server/src/engine/member-signature.ts, which says why it is safe): once the map holds more than
 * {@link NONCE_SWEEP_ABOVE}, each `consume` pops only the nonces whose expiry has passed, O(log n) a request, where it
 * used to walk the whole map on every request. A nonce is deleted only when the map's own expiry for it has passed.
 */
export class NonceStore {
    private readonly seen = new Map<string, number>();
    /** A binary min-heap in two parallel arrays: `heapExp[i]` is the expiry stored for `heapNonce[i]`. */
    private readonly heapExp: number[] = [];
    private readonly heapNonce: string[] = [];
    /** Heap entries the sweeps have looked at, freed or not: what a test counts the forgetting's work by. */
    sweepVisits = 0;

    consume(nonce: string, now: number, signedAt: number): boolean {
        if (this.seen.size > NONCE_SWEEP_ABOVE) this.prune(now);
        const exp = this.seen.get(nonce);
        if (exp !== undefined && exp > now) return false;
        const until = Math.max(now, signedAt) + SIGNATURE_FRESHNESS_MS + 1;
        this.seen.set(nonce, until);
        // A NaN expiry is never spent and never freed, as before; on the heap it would block every sweep.
        if (!Number.isNaN(until)) this.push(until, nonce);
        return true;
    }

    /** Forget every nonce whose window has passed. */
    prune(now: number): void {
        while (this.heapExp.length > 0) {
            this.sweepVisits++;
            if (!(this.heapExp[0] <= now)) return;
            const nonce = this.pop();
            const exp = this.seen.get(nonce);
            if (exp !== undefined && exp <= now) this.seen.delete(nonce);
        }
    }

    /** Whether `nonce` is spent and still inside its window. Read only. */
    isSpent(nonce: string, now: number): boolean {
        const exp = this.seen.get(nonce);
        return exp !== undefined && exp > now;
    }

    /** How many nonces are held, expired or not. */
    get size(): number {
        return this.seen.size;
    }

    private push(exp: number, nonce: string): void {
        const e = this.heapExp, n = this.heapNonce;
        let i = e.length;
        e.push(exp);
        n.push(nonce);
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (e[p] <= exp) break;
            e[i] = e[p];
            n[i] = n[p];
            i = p;
        }
        e[i] = exp;
        n[i] = nonce;
    }

    /** Remove and return the nonce with the earliest expiry. The heap is not empty. */
    private pop(): string {
        const e = this.heapExp, n = this.heapNonce;
        const top = n[0];
        const lastExp = e.pop()!;
        const lastNonce = n.pop()!;
        const len = e.length;
        if (len === 0) return top;
        let i = 0;
        for (;;) {
            const l = 2 * i + 1;
            if (l >= len) break;
            const c = l + 1 < len && e[l + 1] < e[l] ? l + 1 : l;
            if (e[c] >= lastExp) break;
            e[i] = e[c];
            n[i] = n[c];
            i = c;
        }
        e[i] = lastExp;
        n[i] = lastNonce;
        return top;
    }
}

export type SignedCheck =
    | { ok: true; key: string }
    | { ok: false; status: number; code: string; error: string };

function header(headers: IncomingHttpHeaders, name: string): string {
    const v = headers[name];
    return typeof v === 'string' ? v : '';
}

export function verifySignedRequest(args: {
    headers: IncomingHttpHeaders;
    method: string;
    path: string;
    body: string;
    hosts: readonly string[];
    nonces: NonceStore;
    now: number;
}): SignedCheck {
    const refuse = (status: number, code: string, error: string): SignedCheck => ({ ok: false, status, code, error });
    const key = header(args.headers, 'x-public-key');
    const sig = header(args.headers, 'x-signature');
    const timestamp = header(args.headers, 'x-timestamp');
    const nonce = header(args.headers, 'x-nonce');
    const host = header(args.headers, 'x-signed-for');
    if (!key || !sig || !timestamp || !nonce) return refuse(401, 'unsigned', 'This request must be signed.');
    if (!isVaultKeyHex(key)) return refuse(401, 'bad_key', 'X-Public-Key is not a 64-character lower-case hex key.');
    if (!host) return refuse(426, 'app_too_old', 'Please update BeanPool: this request is not signed for the key vault.');
    if (!args.hosts.includes(host)) return refuse(421, 'wrong_host', 'This was signed for somewhere else, so the key vault does not accept it.');
    if (!/^\d{1,16}$/.test(timestamp) || Math.abs(args.now - Number(timestamp)) > SIGNATURE_FRESHNESS_MS) {
        return refuse(401, 'stale', 'This request is too old or its clock is wrong. Check the phone\'s time and try again.');
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) return refuse(401, 'bad_nonce', 'X-Nonce is not a nonce.');
    const signature = Buffer.from(sig, 'base64');
    if (signature.length !== 64) return refuse(401, 'bad_signature', 'The signature does not check out.');
    const bytes = signedRequestBytes(signedRequestText({ host, method: args.method, path: args.path, timestamp, nonce, body: args.body }));
    const valid = (() => {
        try {
            return ed25519.verify(signature, bytes, Buffer.from(key, 'hex'), { zip215: false });
        } catch {
            return false;
        }
    })();
    if (!valid) return refuse(401, 'bad_signature', 'The signature does not check out.');
    if (!args.nonces.consume(`${key}:${nonce}`, args.now, Number(timestamp))) return refuse(401, 'replayed', 'This request was already used.');
    return { ok: true, key };
}
