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

/** Single-use nonces within the freshness window, counted from the request's own timestamp. */
export class NonceStore {
    private readonly seen = new Map<string, number>();

    consume(nonce: string, now: number, signedAt: number): boolean {
        if (this.seen.size > 50_000) this.prune(now);
        const exp = this.seen.get(nonce);
        if (exp !== undefined && exp > now) return false;
        this.seen.set(nonce, Math.max(now, signedAt) + SIGNATURE_FRESHNESS_MS + 1);
        return true;
    }

    prune(now: number): void {
        for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
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
