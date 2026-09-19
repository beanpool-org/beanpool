/**
 * Take over or restore with this phone (sealed-keys.md §5.2, §6.2; slice 6), and the silent open check (§7). The
 * screen is app/unlock-keys.tsx; the crypto is @beanpool/core's owner-unlock.ts, the same bytes the web app and the
 * server run.
 *
 *   1. The QR on a standby's (or a restoring server's) Settings, or the same as a `beanpool://unlock-keys?…` link,
 *      names the server, a session, the session's public key, the envelope and its header's hash.
 *   2. The app asks that server for the header and checks it: the hash the QR names, a valid signature, THIS app's
 *      community (when it knows it), and, for a take-over, signed by this community's own server (the pin, learnt by
 *      the silent open check). It must be locked to this owner. Only then is the owner asked anything.
 *   3. The owner confirms, then the phone's own unlock — the same gate as Manage (requireDeviceUnlock, fails closed).
 *   4. core's approveOwnerUnlock: the data key from THIS owner's stanza, re-wrapped to the session, zeroed; the
 *      request signed with the member key. The phone never sees the keys or the backup; only 48 bytes leave it.
 *
 * The silent open check: when an owner's app sees a new take-over lock on its own server, it opens its own stanza,
 * throws the key away, and reports whether it could (POST /api/node/owner/lock-open-check). It also remembers — never
 * a secret — the community's id, its server's PeerId (the pin), and that this key is an owner, so the take-over entry
 * is still there when the main server is not.
 *
 * Both key formats work: the native raw seed and a PKCS8 key imported from the web app (core normalises).
 */

import {
    parseOwnerUnlockQr, checkUnlockHeader, approveOwnerUnlock, canOpenAsOwner, validateSealedHeader, verifySealedHeader,
    ed25519KeyOfPeerId, OwnerUnlockError, OWNER_LOCK_OPEN_CHECK_PATH, TAKEOVER_HEADER_PATH, OWNER_UNLOCK_QR_PREFIX,
    type OwnerUnlockQr, type OwnerUnlockCheck, type OwnerUnlockRefusal, type SealedEnvelopeHeader,
} from '@beanpool/core';
import { buildSignedHeaders } from './crypto';
import { requireDeviceUnlock } from './node-admin';
import { shouldBlockCleartextNodeUrl } from './node-url';
import type { BeanPoolIdentity } from './identity';

type Keys = Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>;

export interface KeyValueStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

// ── What the app remembers about its community's lock (public things only) ─────────────────

export interface CommunityLockPin {
    communityId: string;
    /** The community server's PeerId: take-over locks must be signed by it. */
    nodePeerId: string;
    /** The last lock this app reported on, so it reports each lock once. */
    lastEnvelopeId: string | null;
    /** This key was an owner when last asked: keeps "Take over with this phone" in Settings while the server is down. */
    owner: boolean;
}

export const lockPinKey = (publicKey: string) => `beanpool:community-lock:${publicKey}`;

export async function readLockPin(store: KeyValueStore, publicKey: string): Promise<CommunityLockPin | null> {
    try {
        const raw = await store.getItem(lockPinKey(publicKey));
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (typeof p?.communityId !== 'string' || typeof p?.nodePeerId !== 'string') return null;
        return { communityId: p.communityId, nodePeerId: p.nodePeerId, lastEnvelopeId: typeof p.lastEnvelopeId === 'string' ? p.lastEnvelopeId : null, owner: p.owner === true };
    } catch {
        return null;
    }
}

async function writeLockPin(store: KeyValueStore, publicKey: string, pin: CommunityLockPin): Promise<void> {
    try { await store.setItem(lockPinKey(publicKey), JSON.stringify(pin)); } catch { /* remembered next time */ }
}

// ── Reading the scan or the link ───────────────────────────────────────────────────────────

export type UnlockScan =
    | { kind: 'ok'; qr: OwnerUnlockQr }
    | { kind: 'not-unlock' }
    | { kind: 'malformed' }
    | { kind: 'cleartext'; host: string };

export function hostOf(url: string): string {
    return url.replace(/^https?:\/\//, '');
}

/** A scanned QR, or a `beanpool://unlock-keys?…` link. A plain-http address on the public internet is refused. */
export function readUnlockScan(text: unknown): UnlockScan {
    const parsed = parseOwnerUnlockQr(text);
    if (!parsed.ok) return { kind: parsed.reason };
    const { ok: _ok, ...qr } = parsed;
    void _ok;
    if (shouldBlockCleartextNodeUrl(qr.serverUrl)) return { kind: 'cleartext', host: hostOf(qr.serverUrl) };
    return { kind: 'ok', qr };
}

/** The deep link arrives as route params (expo-router): put the text back together and read it like a scan. */
export function unlockTextFromParams(params: Record<string, string | string[] | undefined>): string | null {
    const one = (k: string) => {
        const v = params[k];
        return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
    };
    const keys = ['u', 's', 'k', 'e', 'h', 'p'] as const;
    if (keys.some((k) => !one(k))) return null;
    return OWNER_UNLOCK_QR_PREFIX + keys.map((k) => `${k}=${encodeURIComponent(one(k)!)}`).join('&');
}

/** Is this incoming app link one of ours? The app's invite handling must leave it alone (see app/_layout.tsx). */
export function isUnlockLink(url: string): boolean {
    return /^beanpool:\/\/+unlock-keys(?:[/?]|$)/i.test(url.trim());
}

export function scanProblemMessage(r: Exclude<UnlockScan, { kind: 'ok' }>): { title: string; message: string } {
    switch (r.kind) {
        case 'cleartext':
            return { title: 'Not a safe address', message: `That code points at ${r.host} without https. Open the server's Settings at its https address and try again.` };
        case 'malformed':
            return { title: "Can't read that code", message: 'It looks like a take-over code but part of it is missing. Start again on the server and scan the new code.' };
        case 'not-unlock':
        default:
            return { title: 'Not a take-over code', message: "That isn't a BeanPool code for taking over or restoring. On the server's Settings, choose “Take over with an owner's phone” or restore a backup with a phone." };
    }
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

/** What the owner reads when the phone will not unlock, by the reason core gives. */
export function unlockRefusalMessage(reason: OwnerUnlockRefusal, host: string): string {
    switch (reason) {
        case 'not-a-recipient':
            return `These keys are not locked to you, so this phone can't open them. Another owner of your community can, or the printed recovery code on ${host}.`;
        case 'wrong-community':
            return 'These keys belong to another community, not the one this app is in. Nothing was opened.';
        case 'wrong-signer':
            return `These take-over keys were not locked by your community's server, so this phone will not open them for ${host}.`;
        case 'wrong-envelope':
        case 'bad-signature':
            return `${host} sent keys that do not match its screen, or that have been altered. Nothing was opened. Start again on the server.`;
        case 'wrong-kind':
            return 'That code is for a different kind of unlock than the server sent. Start again on the server.';
        case 'expired':
        case 'used':
        case 'closed':
        case 'unknown-session':
            return 'That code has run out or was already used. Start again on the server and scan the new code.';
        default:
            return "The server's answer could not be read. Start again on the server.";
    }
}

/**
 * Ask the server about the session and check its header. Nothing is opened here; a refusal says why in the owner's
 * words. `pin` is what the silent open check remembered, when it has run.
 */
export async function lookupUnlock(qr: OwnerUnlockQr, identity: Keys, pin: CommunityLockPin | null): Promise<UnlockLookup> {
    const host = hostOf(qr.serverUrl);
    let res: Response;
    let body: any;
    try {
        res = await fetch(`${qr.serverUrl}/api/local/admin/unlock/${qr.sessionId}`, { headers: { Accept: 'application/json' } });
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

/** The request the phone sends: POST <server>/api/local/admin/unlock/<session>, the signed body core makes. */
export function buildUnlockRequest(qr: OwnerUnlockQr, header: SealedEnvelopeHeader, identity: Keys): { url: string; init: RequestInit } {
    const body = approveOwnerUnlock(qr, header, identity.privateKey);
    return {
        url: `${qr.serverUrl}/api/local/admin/unlock/${qr.sessionId}`,
        init: { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
    };
}

export type UnlockOutcome =
    | { kind: 'unlocked'; purpose: 'takeover' | 'restore' }
    | { kind: 'no-device-lock' }
    | { kind: 'unlock-failed' }
    | { kind: 'refused'; message: string }
    | { kind: 'error'; message: string };

/** The "Unlock" press: the phone's own unlock first — nothing is opened or sent without it — then the request. */
export async function approveUnlock(opts: { qr: OwnerUnlockQr; check: OwnerUnlockCheck; identity: Keys; communityName: string }): Promise<UnlockOutcome> {
    const unlock = await requireDeviceUnlock(opts.communityName);
    if (unlock === 'no-device-lock') return { kind: 'no-device-lock' };
    if (unlock !== 'ok') return { kind: 'unlock-failed' };
    const host = hostOf(opts.qr.serverUrl);
    let req: { url: string; init: RequestInit };
    try {
        req = buildUnlockRequest(opts.qr, opts.check.header, opts.identity);
    } catch (e) {
        const reason: OwnerUnlockRefusal = e instanceof OwnerUnlockError ? e.reason : 'did-not-open';
        return { kind: 'refused', message: reason === 'did-not-open' ? "This phone's key did not open its part of the lock. Try another owner, or the recovery code." : unlockRefusalMessage(reason, host) };
    }
    try {
        const res = await fetch(req.url, req.init);
        const body = await res.json().catch(() => ({})) as { success?: boolean; purpose?: string; error?: string; reason?: OwnerUnlockRefusal };
        if (res.ok && body.success) return { kind: 'unlocked', purpose: opts.qr.purpose };
        if (body.reason) return { kind: 'refused', message: unlockRefusalMessage(body.reason, host) };
        if (res.status === 429) return { kind: 'error', message: body.error || 'Too many attempts. Wait a minute and try again.' };
        return { kind: res.status >= 500 ? 'error' : 'refused', message: body.error || `${host} did not answer (${res.status}).` };
    } catch (e: any) {
        return { kind: 'error', message: e?.message || `Could not reach ${host}.` };
    }
}

// ── The silent open check (§7) ─────────────────────────────────────────────────────────────

export type LockOpenCheck = 'reported' | 'unchanged' | 'not-owner' | 'no-lock' | 'offline' | 'skipped';

/** Once every ten minutes at most, per app run: it is a background courtesy, not a poll. */
export const LOCK_CHECK_EVERY_MS = 10 * 60_000;
let lastRun = 0;
export function resetLockOpenCheckForTests(): void {
    lastRun = 0;
}

/**
 * Read the current take-over lock from this app's own server; when it is one this app has not reported on, open
 * this owner's stanza, drop the key, and report whether it opened. Never throws, never asks the owner anything.
 */
export async function runLockOpenCheck(nodeUrl: string, identity: Keys, store: KeyValueStore, now: number = Date.now()): Promise<LockOpenCheck> {
    if (now - lastRun < LOCK_CHECK_EVERY_MS) return 'skipped';
    lastRun = now;
    const base = nodeUrl.replace(/\/+$/, '');
    const pin = await readLockPin(store, identity.publicKey);
    try {
        const headers = await buildSignedHeaders('GET', TAKEOVER_HEADER_PATH, '', identity.privateKey, identity.publicKey);
        delete headers['Content-Type'];
        const res = await fetch(`${base}${TAKEOVER_HEADER_PATH}`, { method: 'GET', headers: { Accept: 'application/json', ...headers } });
        if (res.status === 403) {
            if (pin?.owner) await writeLockPin(store, identity.publicKey, { ...pin, owner: false });
            return 'not-owner';
        }
        if (res.status === 404) return 'no-lock';
        if (!res.ok) return 'offline';
        const body = await res.json() as { envelopeId?: unknown; header?: unknown };
        const header = validateSealedHeader(body.header);
        const nodeKey = ed25519KeyOfPeerId(header.nodePeerId);
        if (!nodeKey || !verifySealedHeader(header, nodeKey)) return 'offline'; // not a lock its own server made: pin nothing
        const learnt: CommunityLockPin = { communityId: header.communityId, nodePeerId: header.nodePeerId, lastEnvelopeId: pin?.lastEnvelopeId ?? null, owner: true };
        if (pin?.lastEnvelopeId === header.envelopeId) {
            await writeLockPin(store, identity.publicKey, learnt);
            return 'unchanged';
        }
        const opened = canOpenAsOwner(header, identity.privateKey);
        const report = JSON.stringify({ envelopeId: header.envelopeId, opened });
        const postHeaders = await buildSignedHeaders('POST', OWNER_LOCK_OPEN_CHECK_PATH, report, identity.privateKey, identity.publicKey);
        const sent = await fetch(`${base}${OWNER_LOCK_OPEN_CHECK_PATH}`, { method: 'POST', headers: { Accept: 'application/json', ...postHeaders }, body: report });
        // Only a delivered report counts: otherwise the next run tries again.
        await writeLockPin(store, identity.publicKey, sent.ok ? { ...learnt, lastEnvelopeId: header.envelopeId } : learnt);
        return sent.ok ? 'reported' : 'offline';
    } catch {
        return 'offline';
    }
}
