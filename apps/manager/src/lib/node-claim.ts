/**
 * Whether this node has an owner yet (sign-in step 8, the claim): GET /api/local/claim, asked before sign-in.
 *
 * The route is public and answers `{ unclaimed: false }` once an owner exists, or `{ unclaimed: true, codeId,
 * communityName }` while the one-time claim code waits (apps/server/src/routes/node-claim.ts). It never answers the
 * code itself, and this page never shows it: the page is public, the code is read on the server.
 *
 * A failed or unreadable answer is `unknown`, and the sign-in card treats it as "show the sign-in": the check must
 * never stand between an operator and the password.
 */

import { audienceOf } from '@beanpool/core';

export const CLAIM_PATH = '/api/local/claim';
/** How often the unclaimed card asks again, so it turns into the sign-in the moment a phone claims the node. */
export const CLAIM_POLL_MS = 5_000;
/** A check that hangs this long counts as failed. */
export const CLAIM_TIMEOUT_MS = 8_000;
/** What `beanpool claim` is run as on a Docker install; it prints the code and its own QR. */
export const CLAIM_COMMAND = 'docker compose exec beanpool-node beanpool claim';

export type ClaimState =
    | { kind: 'unknown' }
    | { kind: 'claimed' }
    /** `password: false` once the node has no admin password (stage C); any other answer keeps the password's fold. */
    | {
        kind: 'unclaimed';
        codeId: string | null;
        communityName: string | null;
        password: boolean;
        address: string | null;
        addresses: string[];
    };

/** A claim code's public id: 8 lower-case hex digits (apps/server/src/claim-code.ts isClaimCodeId). */
const CODE_ID = /^[0-9a-f]{8}$/;

/**
 * Sanitizes a node address into a valid https origin (e.g. `https://yourtown.beanpool.org`).
 * Only https origins are ever used; any non-https scheme or hostile input returns null.
 */
export function sanitizeNodeAddress(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;
    try {
        if (/^https:\/\//i.test(s)) {
            const u = new URL(s);
            if (u.protocol !== 'https:') return null;
            if (u.username || u.password) return null;
            if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
            if (!audienceOf(u.origin)) return null;
            return u.origin;
        }
        if (/^[a-z][a-z0-9+.-]*:[^0-9]/i.test(s) || s.startsWith('//')) {
            return null;
        }
        const u = new URL(`https://${s}`);
        if (u.protocol !== 'https:') return null;
        if (u.username || u.password) return null;
        if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
        if (!audienceOf(u.origin)) return null;
        return u.origin;
    } catch {
        return null;
    }
}

export async function fetchClaimState(url: string, signal?: AbortSignal): Promise<ClaimState> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), CLAIM_TIMEOUT_MS);
    try {
        // No cookie and no key: the question is the same for everyone.
        const res = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: ctl.signal });
        if (!res.ok) return { kind: 'unknown' };
        const body: unknown = await res.json();
        if (!body || typeof body !== 'object') return { kind: 'unknown' };
        const b = body as Record<string, unknown>;
        if (b.unclaimed === false) return { kind: 'claimed' };
        if (b.unclaimed !== true) return { kind: 'unknown' };

        let rawAddress: unknown = b.address ?? b.primaryAddress ?? null;
        let rawAddresses: unknown = Array.isArray(b.addresses) ? b.addresses : null;

        if (!rawAddress) {
            try {
                const infoUrl = url.replace(/\/api\/local\/claim(\?.*)?$/, '/api/community/info$1');
                if (infoUrl !== url) {
                    const infoRes = await fetch(infoUrl, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: ctl.signal });
                    if (infoRes.ok) {
                        const infoBody = (await infoRes.json().catch(() => null)) as Record<string, unknown> | null;
                        if (infoBody && typeof infoBody === 'object') {
                            rawAddress = infoBody.primaryAddress ?? infoBody.address ?? null;
                            if (!rawAddresses && Array.isArray(infoBody.addresses)) {
                                rawAddresses = infoBody.addresses;
                            }
                        }

                    }
                }
            } catch {
                // Ignore failure on community-info, fallback to null
            }
        }

        const addresses: string[] = [];
        if (Array.isArray(rawAddresses)) {
            for (const item of rawAddresses) {
                if (typeof item === 'string' && item.trim()) {
                    addresses.push(item.trim());
                }
            }
        }

        let address = sanitizeNodeAddress(rawAddress);
        if (!address && addresses.length > 0) {
            address = addresses.map(sanitizeNodeAddress).find((a): a is string => Boolean(a)) ?? null;
        }

        return {
            kind: 'unclaimed',
            // Only something shaped like an id ever reaches the QR.
            codeId: typeof b.codeId === 'string' && CODE_ID.test(b.codeId) ? b.codeId : null,
            communityName: typeof b.communityName === 'string' && b.communityName.trim() ? b.communityName.trim() : null,
            password: b.password !== false,
            address,
            addresses,
        };
    } catch {
        return { kind: 'unknown' };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}


/**
 * The text of the card's QR: `beanpool://claim?node=<origin>&id=<codeId>`, the node URL-encoded as the settings
 * sign-in QR has it (@beanpool/core buildSettingsSigninQr). The phone's "Claim a community" opens from it and asks for
 * the code. There is no parameter for the code here, by design.
 */
export function buildClaimQr(origin: string, codeId: string | null): string {
    const node = `beanpool://claim?node=${encodeURIComponent(origin)}`;
    return codeId && CODE_ID.test(codeId) ? `${node}&id=${codeId}` : node;
}
