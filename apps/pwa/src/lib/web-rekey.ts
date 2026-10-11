/**
 * A member's new device takes over their account with the admin's re-key code, in the web app (#1768; design
 * scratch/global-node/DESIGN-rekey-redeem-fable.md §5). The community is the node serving the page: no address to type.
 *
 * The ask binds nothing: `POST /api/member/re-enroll`, signed by the key it wants bound, answers two digits for the member
 * to show the admin, who binds that key on the dashboard when the number matches; the poll then says `bound`.
 *
 * The key: this browser's own account when it has one (one account per browser: never a second key beside it). With
 * none, a new key, which goes into the pending-join slot marked sent BEFORE the first request (lib/identity.ts
 * markPendingJoinSent), so a closed tab never loses a key the node may bind, and the page settles it on the next visit as
 * any sent join (WebJoin asks the node whether the key is a member). Bound, it becomes this browser's account through the
 * guarded write that takes the pending join away in the same transaction (completePendingJoin), never over another
 * account. Declined or gone: the record is let go (releaseSentPendingJoin, abandoned), the node having said that key is
 * not bound.
 */

import { generateIdentity, type BeanPoolIdentity, type PendingJoin } from './identity';

/** How often the screen asks whether the admin has bound this device. */
export const WEB_REKEY_POLL_MS = 3000;
/** How long the new key's record says it waits: the code's own life. */
export const WEB_REKEY_TTL_MS = 24 * 60 * 60 * 1000;

const CODE = /^RK-[0-9A-F]{4}-[0-9A-F]{4}$/;

/** The code as the admin's screen spells it, whatever case, spaces or missing dashes were typed. */
export function cleanRekeyCode(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const s = raw.trim().toUpperCase().replace(/\s+/g, '');
    const hex = s.replace(/^RK-?/, '').replace(/-/g, '');
    return /^[0-9A-F]{8}$/.test(hex) ? `RK-${hex.slice(0, 4)}-${hex.slice(4)}` : s;
}

export function isRekeyCode(raw: unknown): boolean {
    return CODE.test(cleanRekeyCode(raw));
}

/** The `?rekey=` a dashboard's QR opens this page with, or null. */
export function rekeyCodeFromSearch(search: string): string | null {
    try {
        const code = new URLSearchParams(search).get('rekey');
        return isRekeyCode(code) ? cleanRekeyCode(code) : null;
    } catch {
        return null;
    }
}

export type WebRekeyAnswer =
    | { state: 'waiting'; match: string; expiresAt: string }
    | { state: 'bound'; callsign: string; communityName: string; linkSignInAgain: boolean }
    | { state: 'declined' }
    | { state: 'gone' }
    | { state: 'refused'; message: string; code?: string }
    | { state: 'unreachable' };

export interface WebRekeyKey {
    identity: BeanPoolIdentity;
    /** True: a key this ask made, kept in the pending-join slot until bound. */
    madeHere: boolean;
    /** The slot's sent mark, for letting it go on exactly that record. */
    sentAt?: number;
}

export interface WebRekeyDeps {
    loadIdentity(): Promise<BeanPoolIdentity | null>;
    loadPendingJoin(): Promise<PendingJoin | null>;
    markPendingJoinSent(pending: PendingJoin, at?: number): Promise<PendingJoin>;
    completePendingJoin(identity: BeanPoolIdentity): Promise<void>;
    releaseSentPendingJoin(release: { kind: 'abandoned'; publicKey: string; sentAt: number | undefined }): Promise<unknown>;
    signReEnrollAsk(code: string, privateKeyHex: string): Promise<{ signature: string; signedFor: string }>;
    signedFetchWithKey(method: string, path: string, body: unknown, privateKeyHex: string, publicKeyHex: string): Promise<Response>;
    generateIdentity?: (callsign: string) => Promise<BeanPoolIdentity>;
}

export const WEB_REKEY_TEXT = {
    declined: 'Your admin said this device isn’t yours, so nothing changed. Ask them to try again with you there.',
    gone: 'That code isn’t valid any more. Ask the admin for a new one.',
    wrongCommunity: 'That code is for another community. Open the link your admin gave you, or ask them for a new code.',
    unreachable: 'Couldn’t reach your community. Check your connection: you can try again, and the code still works until it expires.',
} as const;

/**
 * The key this ask goes with, on disk before anything is sent: this browser's account, or the key a pending join here
 * already holds (the same key asks again), or a new one written to that slot, marked sent, now.
 */
export async function webRekeyKey(deps: WebRekeyDeps, now = Date.now()): Promise<WebRekeyKey> {
    const stored = await deps.loadIdentity();
    if (stored?.privateKey) return { identity: stored, madeHere: false };
    const held = await deps.loadPendingJoin();
    const identity = held?.identity?.privateKey ? held.identity : await (deps.generateIdentity ?? generateIdentity)('');
    const sent = await deps.markPendingJoinSent({
        identity, provider: null, nonce: null, startedAt: held?.startedAt ?? now, expiresAt: now + WEB_REKEY_TTL_MS, restored: false,
    }, now);
    return { identity, madeHere: true, sentAt: sent.sentAt };
}

function readAnswer(status: number, body: any): WebRekeyAnswer {
    if (status === 200 && body && typeof body.state === 'string') {
        if (body.state === 'waiting' && typeof body.match === 'string') return { state: 'waiting', match: body.match, expiresAt: String(body.expiresAt ?? '') };
        if (body.state === 'bound') return { state: 'bound', callsign: String(body.callsign ?? ''), communityName: String(body.communityName ?? ''), linkSignInAgain: body.linkSignInAgain === true };
        if (body.state === 'declined') return { state: 'declined' };
        if (body.state === 'gone') return { state: 'gone' };
    }
    // A 421 is re-sent by fetch on a new connection (the fetch spec), and the copy, its nonce spent, reads as a replay.
    if (status === 421 || body?.code === 'wrong_community' || (status === 403 && /nonce already used/i.test(String(body?.error ?? '')))) {
        return { state: 'refused', message: WEB_REKEY_TEXT.wrongCommunity, code: 'wrong_community' };
    }
    if (status >= 400 && status < 500 && typeof body?.error === 'string') return { state: 'refused', message: body.error, code: body.code };
    return { state: 'unreachable' };
}

export async function askWebRekey(code: string, key: WebRekeyKey, deps: WebRekeyDeps): Promise<WebRekeyAnswer> {
    const clean = cleanRekeyCode(code);
    try {
        const { signature, signedFor } = await deps.signReEnrollAsk(clean, key.identity.privateKey);
        const res = await deps.signedFetchWithKey('POST', '/api/member/re-enroll',
            { code: clean, newPublicKey: key.identity.publicKey, signature, signedFor }, key.identity.privateKey, key.identity.publicKey);
        return readAnswer(res.status, await res.json().catch(() => null));
    } catch {
        return { state: 'unreachable' };
    }
}

export async function pollWebRekey(code: string, key: WebRekeyKey, deps: WebRekeyDeps): Promise<WebRekeyAnswer> {
    try {
        const res = await deps.signedFetchWithKey('GET', `/api/member/re-enroll/status?code=${encodeURIComponent(cleanRekeyCode(code))}`,
            undefined, key.identity.privateKey, key.identity.publicKey);
        if (res.status === 429) return { state: 'unreachable' };
        return readAnswer(res.status, await res.json().catch(() => null));
    } catch {
        return { state: 'unreachable' };
    }
}

/** Bound: a key this ask made becomes this browser's account (never over another: IdentityHeldError). Returns the member. */
export async function finishWebRekey(key: WebRekeyKey, answer: { callsign: string }, deps: WebRekeyDeps): Promise<BeanPoolIdentity> {
    const member = { ...key.identity, callsign: answer.callsign || key.identity.callsign };
    if (key.madeHere) await deps.completePendingJoin(member);
    return member;
}

/** An answer that ends the ask for good. */
export function endsWebRekey(answer: WebRekeyAnswer): boolean {
    return answer.state === 'declined' || answer.state === 'gone'
        || (answer.state === 'refused' && (answer.code === 'code_not_valid' || answer.code === 'code_full' || answer.code === 'key_has_account'));
}

/** Declined, gone or a dead code: the node said the key is not bound, so a key this ask made is let go. */
export async function abandonWebRekey(key: WebRekeyKey, deps: WebRekeyDeps): Promise<void> {
    if (key.madeHere) await deps.releaseSentPendingJoin({ kind: 'abandoned', publicKey: key.identity.publicKey, sentAt: key.sentAt });
}
