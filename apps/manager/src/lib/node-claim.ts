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
    | { kind: 'unclaimed'; codeId: string | null; communityName: string | null; password: boolean };

/** A claim code's public id: 8 lower-case hex digits (apps/server/src/claim-code.ts isClaimCodeId). */
const CODE_ID = /^[0-9a-f]{8}$/;

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
        return {
            kind: 'unclaimed',
            // Only something shaped like an id ever reaches the QR.
            codeId: typeof b.codeId === 'string' && CODE_ID.test(b.codeId) ? b.codeId : null,
            communityName: typeof b.communityName === 'string' && b.communityName.trim() ? b.communityName.trim() : null,
            password: b.password !== false,
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
