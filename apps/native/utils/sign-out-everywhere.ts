/**
 * "Sign out everywhere" from the app (POST /api/local/admin/auth/revoke-all, signed with the member key: X-Public-Key,
 * X-Signature, X-Timestamp, X-Nonce over the method, path, time, nonce and the raw body, as every signed request is,
 * utils/crypto.ts buildSignedHeaders). The node ends every Settings session of the SIGNER, on every computer and phone,
 * whatever the body names, and for an owner retires the break-glass code too (#1531), so a stolen sign-in leaves
 * nothing working behind. The key itself stays on this phone: Manage signs in again with it.
 *
 * One at a time (signOutEverywhereOnce): a double tap asks the node once.
 */
import { buildSignedHeaders } from './crypto';
import type { BeanPoolIdentity } from './identity';

export type SignOutEverywhereResult =
    | { ok: true; breakGlassCodeRetired: boolean }
    | { ok: false; reason: 'refused' | 'failed' | 'busy'; message: string };

export const REVOKE_ALL_PATH = '/api/local/admin/auth/revoke-all';

export async function signOutEverywhere(nodeUrl: string, identity: BeanPoolIdentity): Promise<SignOutEverywhereResult> {
    try {
        const url = `${nodeUrl.replace(/\/+$/, '')}${REVOKE_ALL_PATH}`;
        const body = '{}';
        const headers = await buildSignedHeaders('POST', url, body, identity.privateKey, identity.publicKey);
        const res = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' }, body });
        const data = await res.json().catch(() => ({})) as { success?: unknown; breakGlassCodeRetired?: unknown; error?: unknown };
        if (res.ok && data.success === true) return { ok: true, breakGlassCodeRetired: data.breakGlassCodeRetired === true };
        return { ok: false, reason: 'refused', message: typeof data.error === 'string' && data.error ? data.error : `The community did not sign you out (${res.status}).` };
    } catch {
        return { ok: false, reason: 'failed', message: 'Could not reach the community, so you may still be signed in elsewhere. Try again when you are online.' };
    }
}

let inFlight: Promise<SignOutEverywhereResult> | null = null;

/** signOutEverywhere, one at a time: a second press while one runs answers 'busy' and asks nothing. */
export async function signOutEverywhereOnce(nodeUrl: string, identity: BeanPoolIdentity): Promise<SignOutEverywhereResult> {
    if (inFlight) return { ok: false, reason: 'busy', message: 'Already signing you out everywhere.' };
    const run = signOutEverywhere(nodeUrl, identity);
    inFlight = run;
    try {
        return await run;
    } finally {
        inFlight = null;
    }
}

/** What the confirm says before anything is sent. */
export function signOutEverywhereWarning(communityName: string, isOwner: boolean): string {
    return `This signs you out of ${communityName}'s Settings on every computer and phone${isOwner ? ', and retires your break-glass code' : ''}. Your key stays on this phone: Manage signs you in again.`;
}

/** What the result says, plainly. */
export function signOutEverywhereDone(r: { breakGlassCodeRetired: boolean }): string {
    return r.breakGlassCodeRetired
        ? 'Every Settings sign-in of yours has ended. Your break-glass code no longer works: make a new one with Break-glass code.'
        : 'Every Settings sign-in of yours has ended.';
}
