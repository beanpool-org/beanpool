/**
 * No number from the sample community may ever reach a ledger or any API write (DESIGN-global-showcase-fable.md §6, the
 * safety line). The apps preview a switched-off feature from Example Valley (@beanpool/core sample-community.ts),
 * whose every id starts with `sample-`; a screen's bug that sent one (a vote on the sample Decision, an approve on a
 * sample deal) is refused here, in the body parser, before any gate or handler runs: 400 `sample_id`.
 *
 * One guard for every write route (every method but GET, HEAD and OPTIONS), so a route added later is covered without
 * anyone remembering it. It looks where an id travels:
 * - each segment of the path (`/api/decisions/sample-decision-compost-bay/vote`);
 * - the query's values (`?id=sample-…`);
 * - the JSON body: every string under a key that names an id or a key (`id`, `postId`, `transactionIds`, `to`,
 *   `targetPubkey`…), at any depth, arrays included. Free text (a title, a description, a message) is not read, so a
 *   member may still write the word "sample-".
 * A value is refused only when it is shaped like a sample id (`isSampleId`): `sample-` then lower-case words and hyphens.
 */
import { isSampleId } from '@beanpool/core';

export const SAMPLE_ID_REFUSAL = 'sample_id';
export const SAMPLE_ID_MESSAGE = 'That is from the example community, Example Valley, which only shows what a local community does: nothing in it can be changed, sent or answered.';

/** Keys whose values are ids or keys: ending in id, ids, key, keys or pubkey, or one of a few that name a member. */
function namesAnId(key: string): boolean {
    const k = key.toLowerCase();
    return /(?:id|ids|key|keys)$/.test(k) || k === 'to' || k === 'from' || k === 'target' || k === 'recipient' || k === 'counterparty';
}

/** The first sample id under an id-naming key in a parsed body, with its path, or null. Bounded by depth. */
export function findSampleIdInBody(body: unknown, idKey = false, path = '$', depth = 0): string | null {
    if (depth > 32) return null;
    if (typeof body === 'string') return idKey && isSampleId(body) ? path : null;
    if (Array.isArray(body)) {
        for (let i = 0; i < body.length; i++) {
            const hit = findSampleIdInBody(body[i], idKey, `${path}[${i}]`, depth + 1);
            if (hit) return hit;
        }
        return null;
    }
    if (body && typeof body === 'object') {
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
            const hit = findSampleIdInBody(v, namesAnId(k), `${path}.${k}`, depth + 1);
            if (hit) return hit;
        }
    }
    return null;
}

/** The first sample id in a write's path segments or query values, or null. */
export function findSampleIdInUrl(path: string, query: Record<string, unknown>): string | null {
    for (const raw of path.split('/')) {
        let seg = raw;
        try { seg = decodeURIComponent(raw); } catch { /* an undecodable segment is checked as sent */ }
        if (isSampleId(seg)) return `path ${seg}`;
    }
    for (const [k, v] of Object.entries(query)) {
        for (const one of Array.isArray(v) ? v : [v]) if (isSampleId(one)) return `query ${k}`;
    }
    return null;
}
