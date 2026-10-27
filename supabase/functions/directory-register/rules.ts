/**
 * The pure decisions of the `directory-register` Edge Function (v6, front doors S13): which fields a request needs, whether
 * its timestamp is fresh, whether it is an unlist, and whether its address is one of our own test servers. No imports, no
 * Deno and no network, so the same file runs in the Edge Function (index.ts) and under node in the tests
 * (scripts/directory-register-rules.test.mjs, and the node's withdraw suite apps/server/src/test-directory-withdraw.ts,
 * whose fake registry answers with these rules).
 *
 * The order a request is checked in (index.ts): its JSON, then {@link checkBeforeSignature} (the fields, the 5-minute
 * timestamp), then the key and the signature over the raw body as v5 did, then {@link decideAfterSignature} (an unlist
 * deletes the row; a push from one of our test servers is refused; anything else is written as before).
 */

/** The 403's sentence for a push whose address is one of ours: the node logs it (directory-publisher.ts `HTTP 403: …`). */
export const DENIED_HOST_MESSAGE = "This address is one of BeanPool's own test servers and is never listed.";

/**
 * Our own test and review servers, used when the `DIRECTORY_DENY_HOSTS` secret is not set at all. The director sets the
 * secret to the same list at deploy; setting it (even to nothing) replaces this list.
 */
export const DEFAULT_DENY_HOSTS = 'review.beanpool.org,test.beanpool.org,*.test.beanpool.org';

/** How far a request's timestamp may be from the function's clock, either way (replay protection, as v5). */
export const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/** What a push needs (as v5), and what an unlist needs: only who is leaving, and when it was signed. */
export const PUSH_FIELDS = Object.freeze(['nodeId', 'callsign', 'timestamp'] as const);
export const UNLIST_FIELDS = Object.freeze(['nodeId', 'timestamp'] as const);

export interface Refusal {
    status: number;
    error: string;
}

function asRecord(payload: unknown): Record<string, unknown> | null {
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
}

/** The secret as a list: comma separated, each an exact host or `*.suffix`, lower case; blanks dropped. */
export function parseDenyHosts(raw: string | null | undefined): string[] {
    const list = raw === undefined || raw === null ? DEFAULT_DENY_HOSTS : raw;
    return list.split(',').map((h) => h.trim().toLowerCase().replace(/\.$/, '')).filter((h) => h.length > 0);
}

/**
 * The host a push's `publicUrl` names, lower case, without a port or a trailing dot: from `https://host[:port][/…]`, or a
 * bare `host`, as the node sends one. Null when there is none to read.
 */
export function hostOfPublicUrl(publicUrl: unknown): string | null {
    if (typeof publicUrl !== 'string') return null;
    const s = publicUrl.trim();
    if (!s) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    let host: string;
    try {
        host = new URL(withScheme).hostname;
    } catch {
        return null;
    }
    host = host.toLowerCase().replace(/\.$/, '');
    return host || null;
}

/** Whether `host` is on the list: equal to an exact entry, or under a `*.suffix` entry (any depth; not the suffix itself). */
export function hostDenied(host: string | null, denyList: readonly string[]): boolean {
    if (!host) return false;
    const h = host.toLowerCase().replace(/\.$/, '');
    return denyList.some((entry) => {
        if (entry.startsWith('*.')) {
            const suffix = entry.slice(1); // ".test.beanpool.org"
            return suffix.length > 1 && h.endsWith(suffix) && h.length > suffix.length;
        }
        return h === entry;
    });
}

/** An unlist is a payload whose `unlist` is exactly `true`; anything else is a push. */
export function isUnlistPayload(payload: unknown): boolean {
    return asRecord(payload)?.unlist === true;
}

/** The fields this payload must carry: an unlist's, or a push's. */
export function requiredFields(payload: unknown): readonly string[] {
    return isUnlistPayload(payload) ? UNLIST_FIELDS : PUSH_FIELDS;
}

/** A timestamp (ms since 1970, a number) within {@link TIMESTAMP_WINDOW_MS} of `now`. */
export function timestampFresh(timestamp: unknown, now: number): boolean {
    return typeof timestamp === 'number' && Number.isFinite(timestamp) && Math.abs(now - timestamp) <= TIMESTAMP_WINDOW_MS;
}

/** Before the key and signature are looked at, as v5: a field missing is 400, a stale timestamp 401. Null: go on. */
export function checkBeforeSignature(payload: unknown, now: number): Refusal | null {
    const p = asRecord(payload);
    if (!p || requiredFields(p).some((field) => !p[field])) return { status: 400, error: 'Missing required fields' };
    if (!timestampFresh(p.timestamp, now)) return { status: 401, error: 'Timestamp Expired' };
    return null;
}

export type Decision =
    | { action: 'unlist' }
    | { action: 'upsert' }
    | { action: 'refuse'; status: 403; error: string };

/**
 * Once the signature is good: an unlist deletes the row (from any address, a denied one included: leaving is always
 * allowed); a push whose `publicUrl` host is on the deny list is refused with {@link DENIED_HOST_MESSAGE}; anything else
 * is written as v5 wrote it.
 */
export function decideAfterSignature(payload: unknown, denyList: readonly string[]): Decision {
    if (isUnlistPayload(payload)) return { action: 'unlist' };
    if (hostDenied(hostOfPublicUrl(asRecord(payload)?.publicUrl), denyList)) {
        return { action: 'refuse', status: 403, error: DENIED_HOST_MESSAGE };
    }
    return { action: 'upsert' };
}
