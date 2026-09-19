/**
 * "Sign in with your phone" on the node's own /settings — the page's half of the QR sign-in
 * (server: apps/server/src/settings-signin-pairing.ts; QR format: @beanpool/core settings-signin-qr).
 *
 * The page asks the node for a pairing and gets back an id and a short code; the node also sets an httpOnly
 * cookie that binds the pairing to THIS browser (so nothing here can read or leak it). The page shows the QR,
 * then long-polls. When the owner approves on their phone, the poll answers with the same key session
 * lib/key-session.ts ends up with after the app's one-time link: an admin_session cookie and a CSRF token.
 */

import type { KeySession, KeySessionRole } from './key-session';

export interface PhonePairing {
    pairingId: string;
    shortCode: string;
    /** Local clock: when this code stops working. From the node's TTL, not its clock, so skew can't matter. */
    expiresAt: number;
    ttlMs: number;
}

export type PairingStart =
    | { kind: 'ok'; pairing: PhonePairing }
    | { kind: 'error'; message: string };

export type PhonePoll =
    | { kind: 'waiting'; notice: 'not-admin' | null }
    | { kind: 'signed-in'; session: KeySession; csrfToken: string }
    | { kind: 'expired' }
    | { kind: 'ended'; message: string }
    | { kind: 'retry' };

const PAIRING_PATH = '/api/local/admin/auth/pairing';

export async function startPhonePairing(now = Date.now): Promise<PairingStart> {
    try {
        const res = await fetch(PAIRING_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (res.ok && typeof body.pairingId === 'string' && typeof body.shortCode === 'string') {
            const ttlMs = typeof body.ttlMs === 'number' && body.ttlMs > 0 ? body.ttlMs : 120_000;
            return { kind: 'ok', pairing: { pairingId: body.pairingId, shortCode: body.shortCode, ttlMs, expiresAt: now() + ttlMs } };
        }
        if (res.status === 404) {
            return { kind: 'error', message: "This node doesn't offer phone sign-in yet. Use the admin password." };
        }
        return { kind: 'error', message: typeof body.error === 'string' ? body.error : `The node did not answer (${res.status}).` };
    } catch {
        return { kind: 'error', message: 'Could not reach the node.' };
    }
}

export const PHONE_SIGNIN_MESSAGES = {
    declined: 'Refused on the phone. Get a new code to try again.',
    refused: 'Too many refused attempts on that code. Get a new code to try again.',
    used: 'That code was already used. Get a new code.',
    wrongBrowser: 'That code belongs to another browser or tab. Get a new code here.',
    notAdmin: "The phone that scanned isn't an owner, admin or moderator of this community. Scan with the phone of someone who is.",
    failed: 'The sign-in was not accepted. Get a new code to try again.',
} as const;

function asRole(r: unknown): KeySessionRole | null {
    return r === 'owner' || r === 'admin' || r === 'moderator' ? r : null;
}

/** One long-poll (the node holds it up to 25 s). `retry` means the network hiccuped: poll again shortly. */
export async function waitForPhone(pairingId: string, signal?: AbortSignal): Promise<PhonePoll> {
    let res: Response;
    try {
        res = await fetch(`${PAIRING_PATH}/${encodeURIComponent(pairingId)}/wait`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wait: true }),
            signal,
        });
    } catch {
        return { kind: 'retry' };
    }
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.status >= 500 || res.status === 429) return { kind: 'retry' };
    switch (body.status) {
        case 'waiting':
            return { kind: 'waiting', notice: body.notice === 'not-admin' ? 'not-admin' : null };
        case 'signed-in': {
            const role = asRole(body.role);
            if (role && typeof body.memberPubkey === 'string' && typeof body.csrfToken === 'string') {
                return { kind: 'signed-in', session: { memberPubkey: body.memberPubkey, role }, csrfToken: body.csrfToken };
            }
            return { kind: 'ended', message: PHONE_SIGNIN_MESSAGES.failed };
        }
        case 'expired':
        case 'unknown': // a node restart forgets pairings: same remedy
            return { kind: 'expired' };
        case 'declined': return { kind: 'ended', message: PHONE_SIGNIN_MESSAGES.declined };
        case 'refused': return { kind: 'ended', message: PHONE_SIGNIN_MESSAGES.refused };
        case 'used': return { kind: 'ended', message: PHONE_SIGNIN_MESSAGES.used };
        case 'wrong-browser': return { kind: 'ended', message: PHONE_SIGNIN_MESSAGES.wrongBrowser };
        default:
            return { kind: 'ended', message: PHONE_SIGNIN_MESSAGES.failed };
    }
}

/** "1:05" */
export function formatCountdown(ms: number): string {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "K7F 3QX" — two groups of three, easier to compare across two screens. */
export function formatShortCode(code: string): string {
    return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
