/**
 * What kind a report is, read from its reason: one of the apps' fixed choices, child safety, or other. Never repeated.
 * The server marks, sorts and alerts on it (apps/server services/report-kind.ts re-exports this file, unchanged). The phone
 * asks the same rule when it leaves a member's words out of a report (#1938 confirmation 10, finding 1, the director's
 * ruling (i)): a reason whose words say child safety is sent as "Child safety", so the server's urgent alert still fires.
 * Pure: imports nothing.
 */

export type ReportKind = 'child safety' | 'spam or scam' | 'offensive content' | 'misleading post' | 'other';

/** The apps' "Child safety" report choice: the reason is it, alone or followed by ": " and the member's own words. */
export const CHILD_SAFETY_REASON = 'Child safety';

/** Whether the member picked "Child safety" from the apps' list: read from where the choice goes, never from their words. */
export function pickedChildSafety(reason: unknown): boolean {
    const r = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
    const c = CHILD_SAFETY_REASON.toLowerCase();
    return r === c || r.startsWith(`${c}:`);
}

/**
 * Child safety written in rather than picked (an app from before the choice, or another choice with words that say it):
 * read to sort the report, never repeated. The fallback for every reason that is not the choice.
 */
const CHILD_SAFETY = /\b(child[- ]safety|csae|csam|child (sexual|abuse|exploitation|porn)\w*|sexual(ly)? (abuse|exploit)\w* (of )?(a )?(child|minor)s?|underage)\b/i;

/** What kind a report is, from its reason: one of the apps' fixed choices, child safety, or other. Never its words. */
export function reportKind(reason: unknown): ReportKind {
    if (pickedChildSafety(reason)) return 'child safety';
    const r = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
    if (CHILD_SAFETY.test(r)) return 'child safety';
    for (const k of ['spam or scam', 'offensive content', 'misleading post'] as const) if (r.startsWith(k)) return k;
    return 'other';
}
