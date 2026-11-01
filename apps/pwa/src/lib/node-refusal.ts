/**
 * The node's refusals a member meets while writing (G3, G11-e): a new account's daily limit (429 `probation_limit`), a
 * moderation pause (403 `moderation_muted`) and an account's pause, which opens no new conversation (403 `paused`:
 * removal by vote S1; the member still answers in the ones they are in) and reports having cleared their message requests
 * (403 `dm_requests_limited`: the server's engine/request-limits.ts). Each carries a message the node wrote for the
 * member: which limit, when it lets up, why. The post form and the chat composer show it word for word, in place,
 * never a generic "failed" line; `request` puts the node's `code` and message on the error it throws.
 */
export const PROBATION_LIMIT = 'probation_limit';
export const MODERATION_MUTED = 'moderation_muted';
export const PAUSED = 'paused';
export const DM_REQUESTS_LIMITED = 'dm_requests_limited';

export interface NodeRefusal {
    code: typeof PROBATION_LIMIT | typeof MODERATION_MUTED | typeof PAUSED | typeof DM_REQUESTS_LIMITED;
    /** The node's own words. */
    message: string;
}

/** The refusal behind a failed write, when it is one of these; null for anything else. */
export function nodeRefusal(e: unknown): NodeRefusal | null {
    const err = e as { code?: unknown; message?: unknown } | null | undefined;
    if (!err || typeof err.message !== 'string' || !err.message.trim()) return null;
    if (err.code === PROBATION_LIMIT || err.code === MODERATION_MUTED || err.code === PAUSED || err.code === DM_REQUESTS_LIMITED) return { code: err.code, message: err.message };
    return null;
}
