/**
 * A community copy its server keeps but can't open now (vault rethink VR3; apps/server engine/community-copy.ts
 * `communityCopyStatus`), as the phone reads it from either answer: the copy's own status (`unopenable`, read by
 * utils/community-copy.ts) and the copies' status (`communityCopyUnopenable`, read by utils/vault-move.ts). Pure: no
 * imports, so either reader can take it.
 */

/**
 * Why: the key the server locks copies with is gone (`recovery_seal_key_missing`: only the people who run it can fix
 * that, by putting the key back), or the copy was locked with a key it no longer has (`recovery_seal_unopenable`:
 * turning it on again makes a copy it can open).
 */
export type CommunityCopyUnopenableReason = 'recovery_seal_key_missing' | 'recovery_seal_unopenable';

/** A copy the community keeps but can't open now: since when, and why. Never a way back. */
export interface CommunityCopyUnopenable {
    since: string | null;
    reason: CommunityCopyUnopenableReason;
}

/** The server's answer, read. A reason this phone doesn't know is still "can't open", never "kept". */
export function unopenableOf(v: unknown): CommunityCopyUnopenable | null {
    if (!v || typeof v !== 'object') return null;
    const u = v as { since?: unknown; reason?: unknown };
    return {
        since: typeof u.since === 'string' ? u.since : null,
        reason: u.reason === 'recovery_seal_key_missing' ? 'recovery_seal_key_missing' : 'recovery_seal_unopenable',
    };
}
