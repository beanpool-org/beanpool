/**
 * No number from the sample community may ever reach a ledger or any API write (DESIGN-global-showcase-fable.md §6, the
 * safety line). The apps preview a switched-off feature from Example Valley (@beanpool/core sample-community.ts),
 * whose every id starts with `sample-`; a screen's bug that sent one (a vote on the sample Decision, an approve on a
 * sample deal) is refused here, in the body parser, before any gate or handler runs: 400 `sample_id`.
 *
 * One guard for every write route (every method but GET, HEAD and OPTIONS), so a route added later is covered without
 * anyone remembering it. It looks where an id travels:
 * - each segment of the path (`/api/decisions/sample-decision-compost-bay/vote`), decoded until it stops changing;
 * - the query's values (`?id=sample-…`);
 * - the JSON body, at any depth, arrays included:
 *   - under a key that names an id, a key or a member (`id`, `postId`, `transactionIds`, `to`, `targetPubkey`,
 *     `participants`, `createdBy`…), and a bare string or array body: a sample id anywhere in the value, as a token
 *     (`escrow_sample-…`, `sample_…`, `sample-…;x`);
 *   - under any other key: a value that is a sample id, whole, so a route that names its id `decision` is covered too;
 *   - under a free-text key (FREE_TEXT_KEYS: a title, a description, a message, a name…): nothing, so a member may
 *     still write the words "sample-sale".
 *   Deeper than MAX_DEPTH, no route reads, so the body is refused rather than walked further (fails closed).
 * Every value is read as a route might read it: NFKC (a fullwidth `ｓ` is `s`), trimmed, lower-case.
 *
 * The walk runs before the signature is checked, on bodies of up to the route's limit (2 MB by default), on a node that
 * may have one vCPU: it builds no strings and skips every number, boolean and free-text value, so it costs about what the
 * JSON parse did (perf in test-sample-id-guard step 5). test-sample-id-guard also reads every body field the server's
 * routes read and fails on one that names an id the guard skips.
 */
import { isSampleId } from '@beanpool/core';

export const SAMPLE_ID_REFUSAL = 'sample_id';
export const SAMPLE_ID_MESSAGE = 'That is from the example community, Example Valley, which only shows what a local community does: nothing in it can be changed, sent or answered.';

/** No route reads a body this deep; one that goes deeper is refused, not walked. */
export const MAX_DEPTH = 32;

/** Keys whose values name a member or a set of them without saying id or key. */
const MEMBER_KEYS = new Set(['to', 'from', 'target', 'recipient', 'counterparty', 'participants', 'members', 'createdby']);

/** Keys whose values are ids, keys or members: ending in id, ids, key or keys (pubkey too), or one of MEMBER_KEYS. */
export function namesAnId(key: string): boolean {
    const k = key.toLowerCase();
    return /(?:id|ids|key|keys)$/.test(k) || MEMBER_KEYS.has(k);
}

/**
 * Keys whose values are words a member or an operator writes, never an id, so the guard does not read them (nor
 * anything under them). Each is a body field some route reads (test-sample-id-guard step 5 holds that).
 */
export const FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
    'title', 'description', 'message', 'text', 'memo', 'comment', 'reason', 'name', 'bio', 'communityname',
    'community_name', 'callsign', 'slug', 'searchquery', 'contact', 'address', 'unit', 'work',
    'purpose', 'resolution', 'seasonalityhint', 'password', 'currentpassword', 'newpassword',
]);

/** A sample id as a token: `sample` then `-` or `_` and a letter or digit, not inside a longer word. */
const SAMPLE_TOKEN = /(?:^|[^a-z0-9])sample[-_][a-z0-9]/;
const NON_ASCII = /[\u0080-\uffff]/;

/** The value as a route might read it: NFKC (only needed past ASCII), trimmed, lower-case. */
function canonical(v: string): string {
    return (NON_ASCII.test(v) ? v.normalize('NFKC') : v).trim().toLowerCase();
}

/** The shortest sample id, `sample-x`: a shorter string can't carry one. */
const SHORTEST = 8;

/** A sample id anywhere in the value, as a token: for ids, paths and queries. */
export function carriesSampleId(v: unknown): boolean {
    return typeof v === 'string' && v.length >= SHORTEST && SAMPLE_TOKEN.test(canonical(v));
}

/** The whole value is a sample id: for a field the guard doesn't know names an id. */
function isWhollySampleId(v: string): boolean {
    // A sample id is short; a longer value can't be one, and isn't worth normalising.
    return v.length >= SHORTEST && v.length <= 256 && isSampleId(canonical(v));
}

/** True when a parsed body carries a sample id where a route might read one (see above). Bounded by MAX_DEPTH. */
export function bodyCarriesSampleId(body: unknown): boolean {
    // A bare string or array has no key to say it is free text: its strings are read as ids.
    return walk(body, true, 0);
}

function walk(v: unknown, idKey: boolean, depth: number): boolean {
    if (typeof v === 'string') return idKey ? carriesSampleId(v) : isWhollySampleId(v);
    if (v === null || typeof v !== 'object') return false;
    if (depth >= MAX_DEPTH) return true;
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
            const child = v[i];
            if ((typeof child === 'string' || (child !== null && typeof child === 'object')) && walk(child, idKey, depth + 1)) return true;
        }
        return false;
    }
    for (const k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        const child = (v as Record<string, unknown>)[k];
        if (child === null || (typeof child !== 'string' && typeof child !== 'object')) continue;
        const lower = k.toLowerCase();
        if (FREE_TEXT_KEYS.has(lower)) continue;
        if (walk(child, namesAnId(lower), depth + 1)) return true;
    }
    return false;
}

/** A path segment decoded as a router might, until it stops changing (a double-encoded `%2573` is `s`). */
function decodeSegment(raw: string): string {
    let seg = raw;
    for (let i = 0; i < 4 && seg.includes('%'); i++) {
        try {
            const next = decodeURIComponent(seg);
            if (next === seg) break;
            seg = next;
        } catch { break; /* an undecodable segment is checked as far as it decoded */ }
    }
    return seg;
}

/** True when a write's path segments or query values carry a sample id. */
export function urlCarriesSampleId(path: string, query: Record<string, unknown>): boolean {
    for (const raw of path.split('/')) if (raw && carriesSampleId(decodeSegment(raw))) return true;
    for (const k in query) {
        const v = query[k];
        for (const one of Array.isArray(v) ? v : [v]) if (carriesSampleId(one)) return true;
    }
    return false;
}
