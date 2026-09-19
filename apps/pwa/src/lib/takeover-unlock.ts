/**
 * Take over or restore with this browser (sealed-keys.md §5.2 "The PWA can do steps 3–5 with the same core code",
 * §6.2; slice 6), and the silent open check (§7). The phone app's half is apps/native/utils/takeover-unlock.ts; the
 * two do the same checks in the same order with the same core calls.
 *
 * The web app has no camera scanner: the standby's Settings shows the same code as a link to copy, and the owner pastes
 * it here. There is no device-unlock prompt on the web (§8.2): this browser's key is readable whenever the app is open,
 * so the card says the phone app is safer for a community key-holder. Not blocked.
 *
 * The standby is another server than this app's own, so its two calls are cross-origin; they carry no cookie and no
 * credential (the owner's signature is inside the body), and the server allows any origin for them.
 */
import {
    parseOwnerUnlockQr, checkUnlockHeader, approveOwnerUnlock, canOpenAsOwner, validateSealedHeader, verifySealedHeader,
    ed25519KeyOfPeerId, OwnerUnlockError, OWNER_LOCK_OPEN_CHECK_PATH, TAKEOVER_HEADER_PATH,
    type OwnerUnlockQr, type OwnerUnlockCheck, type OwnerUnlockRefusal, type SealedEnvelopeHeader,
} from '@beanpool/core';
import { request } from './api';

type Keys = { publicKey: string; privateKey: string };

// ── What this browser remembers about its community's lock (public things only) ────────────

export interface CommunityLockPin {
    communityId: string;
    nodePeerId: string;
    lastEnvelopeId: string | null;
    owner: boolean;
}

export const lockPinKey = (publicKey: string) => `beanpool:community-lock:${publicKey}`;

export function readLockPin(publicKey: string): CommunityLockPin | null {
    try {
        const raw = localStorage.getItem(lockPinKey(publicKey));
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (typeof p?.communityId !== 'string' || typeof p?.nodePeerId !== 'string') return null;
        return { communityId: p.communityId, nodePeerId: p.nodePeerId, lastEnvelopeId: typeof p.lastEnvelopeId === 'string' ? p.lastEnvelopeId : null, owner: p.owner === true };
    } catch {
        return null;
    }
}

function writeLockPin(publicKey: string, pin: CommunityLockPin): void {
    try { localStorage.setItem(lockPinKey(publicKey), JSON.stringify(pin)); } catch { /* private mode: learnt again next time */ }
}

// ── The pasted code ────────────────────────────────────────────────────────────────────────

export type UnlockPaste = { kind: 'ok'; qr: OwnerUnlockQr } | { kind: 'not-unlock' } | { kind: 'malformed' };

export function readUnlockPaste(text: unknown): UnlockPaste {
    const parsed = parseOwnerUnlockQr(text);
    if (!parsed.ok) return { kind: parsed.reason };
    const { ok: _ok, ...qr } = parsed;
    void _ok;
    return { kind: 'ok', qr };
}

export function pasteProblemMessage(kind: 'not-unlock' | 'malformed'): string {
    return kind === 'malformed'
        ? 'That looks like a take-over code but part of it is missing. Copy it again from the server\'s screen.'
        : "That isn't a take-over code. On the standby's Settings, choose “Take over with an owner's phone” and copy the code it shows.";
}

export function hostOf(url: string): string {
    return url.replace(/^https?:\/\//, '');
}

// ── The session ────────────────────────────────────────────────────────────────────────────

export interface DescribedUnlock {
    purpose: 'takeover' | 'restore';
    expiresAt: number;
    takeover?: { sealedAt: string; mainServerAnswers: boolean | null; lastCopyAt: number | null; missing: string[] };
    restore?: { backup: { createdAt?: string; opensWith?: string }; databaseOnly: boolean };
}

export type UnlockLookup =
    | { kind: 'ok'; check: OwnerUnlockCheck; described: DescribedUnlock; host: string; sameCommunity: boolean }
    | { kind: 'refused'; reason: OwnerUnlockRefusal; message: string }
    | { kind: 'gone'; message: string }
    | { kind: 'error'; message: string };

export function unlockRefusalMessage(reason: OwnerUnlockRefusal, host: string): string {
    switch (reason) {
        case 'not-a-recipient':
            return `These keys are not locked to you, so this browser can't open them. Another owner of your community can, or the printed recovery code on ${host}.`;
        case 'wrong-community':
            return 'These keys belong to another community, not the one this app is in. Nothing was opened.';
        case 'wrong-signer':
            return `These take-over keys were not locked by your community's server, so this browser will not open them for ${host}.`;
        case 'wrong-envelope':
        case 'bad-signature':
            return `${host} sent keys that do not match its screen, or that have been altered. Nothing was opened. Start again on the server.`;
        case 'wrong-kind':
            return 'That code is for a different kind of unlock than the server sent. Start again on the server.';
        case 'expired':
        case 'used':
        case 'closed':
        case 'unknown-session':
            return 'That code has run out or was already used. Start again on the server and copy the new code.';
        default:
            return "The server's answer could not be read. Start again on the server.";
    }
}

/** Ask the server about the session and check its header, before the owner is asked anything. */
export async function lookupUnlock(qr: OwnerUnlockQr, identity: Keys, pin: CommunityLockPin | null): Promise<UnlockLookup> {
    const host = hostOf(qr.serverUrl);
    let res: Response;
    let body: any;
    try {
        res = await fetch(`${qr.serverUrl}/api/local/admin/unlock/${qr.sessionId}`, { headers: { Accept: 'application/json' }, credentials: 'omit' });
        body = await res.json().catch(() => ({}));
    } catch (e: any) {
        return { kind: 'error', message: e?.message || `Could not reach ${host}.` };
    }
    if (!res.ok) {
        const message = typeof body?.error === 'string' ? body.error : `${host} did not answer (${res.status}).`;
        return res.status === 404 || res.status === 410 ? { kind: 'gone', message } : { kind: 'error', message };
    }
    if (body?.purpose !== qr.purpose) return { kind: 'refused', reason: 'wrong-kind', message: unlockRefusalMessage('wrong-kind', host) };
    try {
        const check = checkUnlockHeader(qr, body.header, identity.publicKey, { communityId: pin?.communityId, nodePeerId: pin?.nodePeerId });
        return {
            kind: 'ok', check, host,
            described: { purpose: body.purpose, expiresAt: Number(body.expiresAt) || 0, takeover: body.takeover, restore: body.restore },
            sameCommunity: !!pin && pin.communityId === check.header.communityId,
        };
    } catch (e) {
        const reason: OwnerUnlockRefusal = e instanceof OwnerUnlockError ? e.reason : 'malformed';
        return { kind: 'refused', reason, message: unlockRefusalMessage(reason, host) };
    }
}

/** POST <server>/api/local/admin/unlock/<session> with the signed body core makes. This browser's key is PKCS8. */
export function buildUnlockRequest(qr: OwnerUnlockQr, header: SealedEnvelopeHeader, identity: Keys): { url: string; init: RequestInit } {
    const body = approveOwnerUnlock(qr, header, identity.privateKey);
    return {
        url: `${qr.serverUrl}/api/local/admin/unlock/${qr.sessionId}`,
        init: { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
    };
}

export type UnlockOutcome =
    | { kind: 'unlocked'; purpose: 'takeover' | 'restore' }
    | { kind: 'refused'; message: string }
    | { kind: 'error'; message: string };

export async function approveUnlock(qr: OwnerUnlockQr, check: OwnerUnlockCheck, identity: Keys): Promise<UnlockOutcome> {
    const host = hostOf(qr.serverUrl);
    let req: { url: string; init: RequestInit };
    try {
        req = buildUnlockRequest(qr, check.header, identity);
    } catch (e) {
        const reason: OwnerUnlockRefusal = e instanceof OwnerUnlockError ? e.reason : 'did-not-open';
        return { kind: 'refused', message: reason === 'did-not-open' ? "This browser's key did not open its part of the lock. Try another owner, or the recovery code." : unlockRefusalMessage(reason, host) };
    }
    try {
        const res = await fetch(req.url, req.init);
        const body = await res.json().catch(() => ({})) as { success?: boolean; error?: string; reason?: OwnerUnlockRefusal };
        if (res.ok && body.success) return { kind: 'unlocked', purpose: qr.purpose };
        if (body.reason) return { kind: 'refused', message: unlockRefusalMessage(body.reason, host) };
        return { kind: res.status >= 500 || res.status === 429 ? 'error' : 'refused', message: body.error || `${host} did not answer (${res.status}).` };
    } catch (e: any) {
        return { kind: 'error', message: e?.message || `Could not reach ${host}.` };
    }
}

// ── The silent open check (§7) ─────────────────────────────────────────────────────────────

export type LockOpenCheck = 'reported' | 'unchanged' | 'not-owner' | 'no-lock' | 'offline' | 'skipped';

export const LOCK_CHECK_EVERY_MS = 10 * 60_000;
let lastRun = 0;
export function resetLockOpenCheckForTests(): void {
    lastRun = 0;
}

/**
 * Read the current take-over lock from this app's own server (a signed owner request); on a lock not reported yet,
 * open this owner's stanza, drop the key, report whether it opened. Never throws, never asks anything.
 */
export async function runLockOpenCheck(identity: Keys, now: number = Date.now()): Promise<LockOpenCheck> {
    if (now - lastRun < LOCK_CHECK_EVERY_MS) return 'skipped';
    lastRun = now;
    const pin = readLockPin(identity.publicKey);
    let body: { envelopeId?: unknown; header?: unknown };
    try {
        body = await request('GET', TAKEOVER_HEADER_PATH);
    } catch (e) {
        const msg = String((e as Error)?.message || '');
        if (/owners can read|403/i.test(msg)) {
            if (pin?.owner) writeLockPin(identity.publicKey, { ...pin, owner: false });
            return 'not-owner';
        }
        return /no owner|no recovery|not locked|404/i.test(msg) ? 'no-lock' : 'offline';
    }
    try {
        const header = validateSealedHeader(body.header);
        const nodeKey = ed25519KeyOfPeerId(header.nodePeerId);
        if (!nodeKey || !verifySealedHeader(header, nodeKey)) return 'offline';
        const learnt: CommunityLockPin = { communityId: header.communityId, nodePeerId: header.nodePeerId, lastEnvelopeId: pin?.lastEnvelopeId ?? null, owner: true };
        if (pin?.lastEnvelopeId === header.envelopeId) {
            writeLockPin(identity.publicKey, learnt);
            return 'unchanged';
        }
        const opened = canOpenAsOwner(header, identity.privateKey);
        try {
            await request('POST', OWNER_LOCK_OPEN_CHECK_PATH, { envelopeId: header.envelopeId, opened });
        } catch {
            writeLockPin(identity.publicKey, learnt);
            return 'offline';
        }
        writeLockPin(identity.publicKey, { ...learnt, lastEnvelopeId: header.envelopeId });
        return 'reported';
    } catch {
        return 'offline';
    }
}
