/**
 * Sign in to /settings in a browser by scanning a QR code with the BeanPool app (like WhatsApp Web).
 *
 * The browser has no unlock step of its own, so it never holds the member key. Instead:
 *
 *   1. The browser asks for a pairing: a random id, a short code for the two screens to compare, and a
 *      BINDING SECRET that only this browser holds (an httpOnly, SameSite=Strict cookie scoped to the pairing
 *      routes). The QR carries the node URL, the id and the short code — never the secret.
 *   2. The owner scans it in the app, compares the short code, passes the phone's own unlock, and posts an
 *      approval signed with their member key over `0xFF ‖ beanpool-settings-signin/2\n<host>\napprove\n<id>\n<code>`
 *      (@beanpool/core settingsSigninText; <host> the address the phone reached this node at, sent as `signedFor`),
 *      or, from an app before request binding and only until the switch, `beanpool-settings-signin:v1:approve:<id>:<code>`.
 *      The node runs the same signer checks as the app's one-time link (authorizeKeySigner: active member,
 *      owner, admin or moderator in node_roles, signature; since step 5 no server 2FA code) and mints the same 60-second
 *      handshake token — but keeps it here, bound to the pairing. It is never sent to the phone or the page.
 *   3. The browser, long-polling with its binding cookie, redeems that token through consumeHandshakeToken and
 *      gets the same admin_session a key sign-in gets. A photographed QR is useless elsewhere: without the
 *      binding secret a browser can only be told "this sign-in belongs to another browser".
 *
 *   2b. Number matching. An app that can show them (it sends `confirm: true`) gets two digits back from its approval;
 *      the page must type them (confirmPairing) within 30 s before the held token is redeemed. Someone who only
 *      sent the owner a QR never sees the phone, so a fooled "Sign in" still gives them nothing. Three wrong tries
 *      burn the pairing. An older app sends no flag and signs the browser in as before.
 *
 * The phone is also shown where and when the computer asked: the address the node saw the request from, how long
 * ago, the time left, and "same network" when the phone's own address is the computer's (describePairing).
 *
 * Single use and short-lived: two minutes to approve; one approval; one redemption. Five refused approvals
 * burn the pairing. Creation is braked per client and capped overall; approvals go through the auth limiter.
 * Everything lives in memory: a restart simply means "get a new code".
 */

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { getMember, isMemberKeySpelling, isNodeMember } from '@beanpool/engine';
import type { MemberNodeRole } from './engine/node-roles.js';
import {
    authorizeKeySigner,
    mintHandshakeToken,
    consumeHandshakeToken,
} from './admin-key-auth.js';
import { settingsSigninText, verifyStatementSignature } from './engine/member-signature.js';
import { logger } from './logger.js';
import { limiterKeyForIp, standsForMany } from './client-ip.js';

export const PAIRING_TTL_MS = 2 * 60_000;
/** Live pairings across the whole node. A page holds one; this only stops a flood. */
export const PAIRING_MAX_LIVE = 200;
/** New pairings per client per minute. A page auto-refreshes every two minutes, so 10 is generous. */
export const PAIRING_CREATES_PER_MINUTE = 10;
/** Refused approvals (bad signature, not an owner/admin) before the pairing is burned. */
export const PAIRING_MAX_REFUSALS = 5;
/** Long-poll waiters per pairing: one page, plus a reload or two. */
export const PAIRING_MAX_WAITERS = 3;
/** Time the page has to type the phone's two digits after the approval. */
export const PAIRING_CONFIRM_TTL_MS = 30_000;
/** Wrong digits before the pairing is burned. */
export const PAIRING_CONFIRM_TRIES = 3;

/** No 0/O, 1/I/L: read aloud or squinted at across a desk. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SHORT_CODE_LENGTH = 6;

export type PairingStatus = 'waiting' | 'confirming' | 'approved' | 'declined' | 'refused' | 'used';
/** Something the waiting page should say while it keeps waiting. */
export type PairingNotice = 'not-admin';

interface Pairing {
    id: string;
    shortCode: string;
    secretHash: Buffer;
    browser: string;
    /** The address the node saw the request come from (clientIp), shown to the phone. */
    requesterAddress: string;
    createdAt: number;
    expiresAt: number;
    status: PairingStatus;
    refusals: number;
    notice?: PairingNotice;
    handshakeToken?: string;
    handshakeExpiresAt?: number;
    approvedBy?: string;
    role?: MemberNodeRole;
    /** Number matching: the two digits the phone shows, until the page types them. */
    confirmCode?: string;
    confirmExpiresAt?: number;
    confirmTries?: number;
}

const pairings = new Map<string, Pairing>();
const waiters = new Map<string, Set<() => void>>();
const createBuckets = new Map<string, { count: number; resetAt: number }>();

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

export function pairingMessage(action: 'approve' | 'decline', pairingId: string, shortCode: string): string {
    return `beanpool-settings-signin:v1:${action}:${pairingId}:${shortCode}`;
}

export const isPairingId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);

/** The cookie that binds a pairing to the browser that asked for it. One per pairing, so two tabs don't clash. */
export function bindingCookieName(pairingId: string): string {
    return `bp_signin_${pairingId.slice(0, 16)}`;
}

function shortCode(): string {
    let out = '';
    for (let i = 0; i < SHORT_CODE_LENGTH; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    return out;
}

/** "Firefox on Windows" — enough for the phone to notice a computer that isn't the one in front of them. */
export function describeBrowser(userAgent: string | undefined): string {
    const ua = userAgent || '';
    const browser =
        /Edg\//.test(ua) ? 'Edge'
            : /OPR\/|Opera/.test(ua) ? 'Opera'
                : /Firefox\//.test(ua) ? 'Firefox'
                    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
                        : /Safari\//.test(ua) ? 'Safari'
                            : 'A browser';
    const os =
        /Windows/.test(ua) ? 'Windows'
            : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
                : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
                    : /Android/.test(ua) ? 'Android'
                        : /CrOS/.test(ua) ? 'ChromeOS'
                            : /Linux/.test(ua) ? 'Linux'
                                : '';
    return os ? `${browser} on ${os}` : browser;
}

export function prunePairings(now = Date.now()): void {
    for (const [id, p] of pairings) {
        const lastUse = Math.max(p.expiresAt, p.handshakeExpiresAt ?? 0);
        if (now > lastUse + 60_000) {
            pairings.delete(id);
            waiters.delete(id);
        }
    }
    for (const [k, b] of createBuckets) if (now >= b.resetAt) createBuckets.delete(k);
}

if (typeof setInterval !== 'undefined') {
    const t = setInterval(() => prunePairings(), 30_000);
    if (t.unref) t.unref();
}

function notify(id: string): void {
    const set = waiters.get(id);
    if (!set) return;
    waiters.delete(id);
    for (const wake of set) wake();
}

const expired = (p: Pairing, now: number) =>
    (p.status === 'waiting' && now > p.expiresAt) || (p.status === 'confirming' && now > (p.confirmExpiresAt ?? 0));

// ===================== 1. THE BROWSER ASKS =====================

export type CreateResult =
    | { ok: true; pairingId: string; shortCode: string; expiresAt: number; secret: string }
    | { ok: false; status: 429 | 503; error: string };

export function createPairing(opts: { clientKey: string; userAgent?: string; requesterAddress?: string; now?: number }): CreateResult {
    const now = opts.now ?? Date.now();
    const bucket = createBuckets.get(opts.clientKey);
    if (bucket && now < bucket.resetAt) {
        if (bucket.count >= PAIRING_CREATES_PER_MINUTE) {
            return { ok: false, status: 429, error: `Too many new codes. Try again in ${Math.ceil((bucket.resetAt - now) / 1000)}s` };
        }
        bucket.count++;
    } else {
        createBuckets.set(opts.clientKey, { count: 1, resetAt: now + 60_000 });
    }

    let live = 0;
    for (const p of pairings.values()) if (p.status === 'waiting' && now <= p.expiresAt) live++;
    if (live >= PAIRING_MAX_LIVE) {
        prunePairings(now);
        return { ok: false, status: 503, error: 'Too many sign-ins waiting on this node right now. Try again in a minute.' };
    }

    const id = crypto.randomBytes(32).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const pairing: Pairing = {
        id,
        shortCode: shortCode(),
        secretHash: sha256(secret),
        browser: describeBrowser(opts.userAgent),
        requesterAddress: String(opts.requesterAddress || 'unknown'),
        createdAt: now,
        expiresAt: now + PAIRING_TTL_MS,
        status: 'waiting',
        refusals: 0,
    };
    pairings.set(id, pairing);
    return { ok: true, pairingId: id, shortCode: pairing.shortCode, expiresAt: pairing.expiresAt, secret };
}

// ===================== 2. THE PHONE LOOKS, THEN APPROVES OR DECLINES =====================

export interface PairingDescription {
    shortCode: string;
    browser: string;
    expiresAt: number;
    /** Relative times, so a phone whose clock is wrong still counts down right. */
    expiresInSeconds: number;
    askedSecondsAgo: number;
    /** The address the computer asked from, as this node saw it. Learned from the node, never from the QR. */
    fromAddress: string;
    /**
     * The phone looking it up is on the computer's network (same address, or the same IPv6 /64). Never for an address
     * that stands for many people (standsForMany: a proxy the node can't see past, loopback, a private address).
     */
    sameNetwork: boolean;
}

/**
 * What the phone shows before asking for the unlock. Only for a pairing that can still be approved.
 * `viewerAddress` is the phone's own address as this node sees it (clientIp), only compared, never echoed.
 */
export function describePairing(pairingId: string, now = Date.now(), viewerAddress?: string):
    | ({ ok: true } & PairingDescription)
    | { ok: false; status: 404 | 410; error: string } {
    const p = isPairingId(pairingId) ? pairings.get(pairingId) : undefined;
    if (!p) return { ok: false, status: 404, error: 'That code is not known here. Get a new code on the computer.' };
    if (expired(p, now)) return { ok: false, status: 410, error: 'That code has expired. Get a new code on the computer.' };
    if (p.status !== 'waiting') return { ok: false, status: 410, error: 'That code was already used. Get a new code on the computer.' };
    return {
        ok: true,
        shortCode: p.shortCode,
        browser: p.browser,
        expiresAt: p.expiresAt,
        expiresInSeconds: Math.max(0, Math.round((p.expiresAt - now) / 1000)),
        askedSecondsAgo: Math.max(0, Math.round((now - p.createdAt) / 1000)),
        fromAddress: p.requesterAddress,
        sameNetwork: !!viewerAddress && !standsForMany(viewerAddress) && !standsForMany(p.requesterAddress)
            && limiterKeyForIp(viewerAddress) === limiterKeyForIp(p.requesterAddress),
    };
}

export type ApproveResult =
    | { ok: true; role: MemberNodeRole; confirmCode?: string; confirmExpiresAt?: number }
    | { ok: false; status: number; error: string; code?: string; reason: 'unknown' | 'expired' | 'used' | 'bad-signature' | 'not-admin' | 'inactive' | 'refused' | 'wrong-community' | 'app-too-old' };

function refuse(p: Pairing): void {
    p.refusals++;
    if (p.refusals >= PAIRING_MAX_REFUSALS && p.status === 'waiting') {
        p.status = 'refused';
        logger.warn('AUTH', `Settings sign-in by phone: pairing ${p.id.slice(0, 8)} burned after ${p.refusals} refused approvals`);
    }
    notify(p.id);
}

function who(pubkey: string): string {
    const m = getMember(db, pubkey);
    return `${m?.callsign ? `@${m.callsign} ` : ''}(key ${pubkey.slice(0, 12)}…)`;
}

/**
 * The phone's signature over this pairing's approval or decline (request binding, engine/member-signature.ts): the
 * format-2 text naming the host the phone reached this node at (`signedFor`), which must be this community's, or the old
 * v1 text until the switch. A pairing shown by community A and approved there is never an approval at B: a hostile A
 * could otherwise show a QR carrying B's pairing id and its own address, and sign in to B's Settings as the member.
 */
function pairingSignature(p: Pairing, action: 'approve' | 'decline', memberPubkey: string, signature: string, signedFor: unknown) {
    return verifyStatementSignature({
        signature,
        pubKeyHex: memberPubkey,
        boundText: (host) => settingsSigninText(host, action, p.id, p.shortCode),
        signedFor,
        oldTexts: [pairingMessage(action, p.id, p.shortCode)],
    });
}

export function approvePairing(params: {
    pairingId: string;
    memberPubkey: string;
    signature: string;
    /** The host the phone signed for (format 2); absent from an old app. */
    signedFor?: unknown;
    /** The app can show two digits for the page to type (number matching). Absent from an older app. */
    confirm?: boolean;
    now?: number;
}): ApproveResult {
    const now = params.now ?? Date.now();
    const p = isPairingId(params.pairingId) ? pairings.get(params.pairingId) : undefined;
    if (!p) return { ok: false, status: 404, error: 'That code is not known here. Get a new code on the computer.', reason: 'unknown' };
    if (expired(p, now)) return { ok: false, status: 410, error: 'That code has expired. Get a new code on the computer.', reason: 'expired' };
    if (p.status === 'refused') return { ok: false, status: 410, error: 'Too many refused attempts on that code. Get a new code on the computer.', reason: 'refused' };
    if (p.status !== 'waiting') return { ok: false, status: 409, error: 'That code was already used. Get a new code on the computer.', reason: 'used' };

    const memberPubkey = String(params.memberPubkey || '').trim();
    // The signature is checked FIRST here (authorizeKeySigner checks it after the role): only a real key holder
    // may cause a "holds no role here" notice on the waiting page.
    const signed = pairingSignature(p, 'approve', memberPubkey, params.signature, params.signedFor);
    if (!signed.ok) {
        refuse(p);
        if (signed.status === 421) return { ok: false, status: 421, error: signed.error, code: signed.code, reason: 'wrong-community' };
        if (signed.status === 426) return { ok: false, status: 426, error: signed.error, code: signed.code, reason: 'app-too-old' };
        return { ok: false, status: 403, error: 'Invalid cryptographic signature', reason: 'bad-signature' };
    }

    const signer = authorizeKeySigner({
        memberPubkey,
        signatureValid: () => true, // verified just above, over this pairing's message
    });
    if (!signer.ok) {
        if (signer.notAdmin) {
            p.notice = 'not-admin';
            logger.warn('AUTH', `Settings sign-in by phone refused: ${who(memberPubkey)} holds no node role (pairing ${p.id.slice(0, 8)})`);
        }
        refuse(p);
        if (signer.notAdmin) return { ok: false, status: 403, error: 'You are not an owner, admin or moderator of this community.', reason: 'not-admin' };
        return { ok: false, status: 403, error: signer.error, reason: 'inactive' };
    }

    const { handshakeToken, expiresAt } = mintHandshakeToken(memberPubkey, signer.role, now);
    p.handshakeToken = handshakeToken;
    p.handshakeExpiresAt = expiresAt;
    p.approvedBy = memberPubkey;
    p.role = signer.role;
    p.notice = undefined;
    if (params.confirm === true) {
        p.status = 'confirming';
        p.confirmCode = String(crypto.randomInt(100)).padStart(2, '0');
        p.confirmExpiresAt = now + PAIRING_CONFIRM_TTL_MS;
        p.confirmTries = 0;
    } else {
        p.status = 'approved';
    }
    logger.security('AUTH', `Settings sign-in by phone APPROVED by ${who(memberPubkey)} as ${signer.role} for pairing ${p.id.slice(0, 8)} (${p.browser})${p.confirmCode ? ', waiting for the digits on the computer' : ''}`);
    notify(p.id);
    return p.confirmCode
        ? { ok: true, role: signer.role, confirmCode: p.confirmCode, confirmExpiresAt: p.confirmExpiresAt }
        : { ok: true, role: signer.role };
}

/**
 * "No" on the phone: any active member's signature over the decline message ends the pairing. A visitor's row isn't a
 * member's (isNodeMember, the act test) and is refused as a key with no row is. So is a key in another spelling
 * (isMemberKeySpelling): the signature check forgives case, so a row an old door stored under a member's key in capitals
 * would answer as a second member, as a key sign-in would (authorizeKeySigner).
 */
export function declinePairing(params: { pairingId: string; memberPubkey: string; signature: string; signedFor?: unknown; now?: number }):
    | { ok: true }
    | { ok: false; status: number; error: string; code?: string } {
    const now = params.now ?? Date.now();
    const p = isPairingId(params.pairingId) ? pairings.get(params.pairingId) : undefined;
    if (!p) return { ok: false, status: 404, error: 'That code is not known here.' };
    if (expired(p, now) || p.status !== 'waiting') return { ok: false, status: 409, error: 'That code is no longer waiting.' };
    const memberPubkey = String(params.memberPubkey || '').trim();
    const member = isMemberKeySpelling(memberPubkey) ? getMember(db, memberPubkey) : undefined;
    if (!member || member.status !== 'active' || !isNodeMember(db, memberPubkey)) {
        return { ok: false, status: 403, error: 'Invalid cryptographic signature' };
    }
    const signed = pairingSignature(p, 'decline', memberPubkey, params.signature, params.signedFor);
    if (!signed.ok) {
        return signed.status === 421 || signed.status === 426
            ? { ok: false, status: signed.status, error: signed.error, code: signed.code }
            : { ok: false, status: 403, error: 'Invalid cryptographic signature' };
    }
    p.status = 'declined';
    logger.info('AUTH', `Settings sign-in by phone declined by ${who(memberPubkey)} (pairing ${p.id.slice(0, 8)})`);
    notify(p.id);
    return { ok: true };
}

// ===================== 3. THE BROWSER WAITS, THEN REDEEMS =====================

export type RedeemResult =
    | { kind: 'waiting'; expiresAt: number; notice?: PairingNotice }
    | { kind: 'confirm'; confirmExpiresAt: number }
    | { kind: 'signed-in'; sessionId: string; csrfToken?: string; memberPubkey: string; role: MemberNodeRole; hardExpiresAt?: number; idleExpiresAt?: number }
    | { kind: 'expired' | 'declined' | 'refused' | 'used' | 'unknown' }
    | { kind: 'wrong-browser' }
    | { kind: 'failed'; error: string };

/**
 * The page's poll. Only the browser holding the binding secret learns anything at all; when the phone has
 * approved, the held handshake token is redeemed here, once, into an admin session.
 */
export function redeemPairing(pairingId: string, secret: string | undefined, now = Date.now()): RedeemResult {
    const p = boundPairing(pairingId, secret);
    if (!p || p === 'wrong-browser') return p ? { kind: 'wrong-browser' } : { kind: 'unknown' };
    if (expired(p, now)) return { kind: 'expired' };
    switch (p.status) {
        case 'waiting': return { kind: 'waiting', expiresAt: p.expiresAt, ...(p.notice ? { notice: p.notice } : {}) };
        case 'confirming': return { kind: 'confirm', confirmExpiresAt: p.confirmExpiresAt! };
        case 'declined': return { kind: 'declined' };
        case 'refused': return { kind: 'refused' };
        case 'used': return { kind: 'used' };
        case 'approved': break;
    }
    return issue(p, now);
}

/** The pairing, only to the browser holding its binding secret. */
function boundPairing(pairingId: string, secret: string | undefined): Pairing | 'wrong-browser' | undefined {
    const p = isPairingId(pairingId) ? pairings.get(pairingId) : undefined;
    if (!p) return undefined;
    const given = sha256(String(secret || ''));
    if (!secret || !crypto.timingSafeEqual(given, p.secretHash)) {
        if (p.status === 'approved' || p.status === 'confirming') {
            logger.warn('AUTH', `Settings sign-in by phone: pairing ${p.id.slice(0, 8)} was presented by a browser without its binding secret — refused`);
        }
        return 'wrong-browser';
    }
    return p;
}

/**
 * The page types the two digits the phone shows. Right digits within 30 s redeem the held token, once; three wrong
 * tries burn the pairing. Only the browser holding the binding secret may try, so nobody else can use up its tries.
 */
export function confirmPairing(pairingId: string, secret: string | undefined, digits: unknown, now = Date.now()):
    RedeemResult | { kind: 'wrong'; triesLeft: number } {
    const p = boundPairing(pairingId, secret);
    if (!p || p === 'wrong-browser') return p ? { kind: 'wrong-browser' } : { kind: 'unknown' };
    if (expired(p, now)) {
        if (p.status === 'confirming') logger.warn('AUTH', `Settings sign-in by phone: the digits for pairing ${p.id.slice(0, 8)} were not typed in time — no session`);
        return { kind: 'expired' };
    }
    if (p.status !== 'confirming') {
        return p.status === 'waiting' ? { kind: 'waiting', expiresAt: p.expiresAt } : { kind: p.status === 'approved' ? 'used' : p.status as 'declined' | 'refused' | 'used' };
    }
    const given = Buffer.from(String(digits ?? '').trim().padEnd(2, ' ').slice(0, 8));
    const want = Buffer.from(p.confirmCode!.padEnd(2, ' '));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        p.confirmTries = (p.confirmTries ?? 0) + 1;
        if (p.confirmTries >= PAIRING_CONFIRM_TRIES) {
            p.status = 'refused';
            p.handshakeToken = undefined;
            p.confirmCode = undefined;
            logger.security('AUTH', `Settings sign-in by phone: pairing ${p.id.slice(0, 8)} burned after ${p.confirmTries} wrong digits typed on the computer (${p.browser}) — approved by ${who(p.approvedBy || '')}, no session`);
            notify(p.id);
            return { kind: 'refused' };
        }
        return { kind: 'wrong', triesLeft: PAIRING_CONFIRM_TRIES - p.confirmTries };
    }
    p.confirmCode = undefined;
    return issue(p, now);
}

/** Redeem the held handshake token, once, into an admin session. */
function issue(p: Pairing, now: number): RedeemResult {
    const token = p.handshakeToken!;
    p.status = 'used';
    p.handshakeToken = undefined;
    const res = consumeHandshakeToken(token, now);
    if (!res.ok || !res.sessionId || !res.role || !res.memberPubkey) {
        return res.expired ? { kind: 'expired' } : { kind: 'failed', error: res.error || 'The sign-in was not accepted.' };
    }
    logger.security('AUTH', `Settings sign-in by phone: browser signed in as ${who(res.memberPubkey)} (${res.role}) from pairing ${p.id.slice(0, 8)} (${p.browser})`);
    return {
        kind: 'signed-in',
        sessionId: res.sessionId,
        csrfToken: res.csrfToken,
        memberPubkey: res.memberPubkey,
        role: res.role,
        hardExpiresAt: res.hardExpiresAt,
        idleExpiresAt: res.idleExpiresAt,
    };
}

/**
 * Resolve when the pairing changes, or after `timeoutMs`. False (answer now) when the pairing already has
 * PAIRING_MAX_WAITERS waiting on it.
 */
export function waitForPairing(pairingId: string, timeoutMs: number): Promise<boolean> {
    const p = pairings.get(pairingId);
    if (!p || p.status !== 'waiting') return Promise.resolve(true);
    let set = waiters.get(pairingId);
    if (!set) { set = new Set(); waiters.set(pairingId, set); }
    if (set.size >= PAIRING_MAX_WAITERS) return Promise.resolve(false);
    const bucket = set;
    // Never past the pairing's own expiry, so an expired code is reported promptly.
    const wait = Math.max(0, Math.min(timeoutMs, p.expiresAt - Date.now() + 250));
    return new Promise((resolve) => {
        const wake = () => { clearTimeout(timer); bucket.delete(wake); resolve(true); };
        const timer = setTimeout(wake, wait);
        if ((timer as any).unref) (timer as any).unref();
        bucket.add(wake);
    });
}

/** Tests: forget everything (the module is process-wide). */
export function resetPairingsForTests(): void {
    pairings.clear();
    waiters.clear();
    createBuckets.clear();
}
