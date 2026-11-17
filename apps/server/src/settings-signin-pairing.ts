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
 *      (@beanpool/core settingsSigninText; <host> the address the phone reached this node at, sent as `signedFor`).
 *      An app from before request binding signed `beanpool-settings-signin:v1:approve:<id>:<code>` and names no host:
 *      answered 426 app_too_old without checking it (CUT4, engine/member-signature.ts oldShapeRefusal).
 *      The node runs the same signer checks as the app's one-time link (authorizeKeySigner: active member,
 *      owner, admin or moderator in node_roles, signature; since step 5 no server 2FA code) and mints the same 60-second
 *      handshake token — but keeps it here, bound to the pairing. It is never sent to the phone or the page.
 *   3. The browser, long-polling with its binding cookie, redeems that token through consumeHandshakeToken and
 *      gets the same admin_session a key sign-in gets. A photographed QR is useless elsewhere: without the
 *      binding secret a browser can only be told "this sign-in belongs to another browser".
 *
 *   2b. Number matching, always. The app sends `confirm: 'six-digits'` and gets six digits back from its approval
 *      (crypto.randomInt, the node's CSPRNG); the page must type them (confirmPairing) within 30 s before the held
 *      token is redeemed. Someone who only sent the owner a QR never sees the phone, so a fooled "Sign in" still gives
 *      them nothing. ONE wrong try burns the pairing, and the page starts a new one: a relayed QR the owner approves
 *      lets its sender guess once in a million (security inventory risk 2, 18 Nov; it was 2 digits and 3 tries, 3%).
 *      An app that does not say it shows six (any app before this, `confirm: true` or nothing) is refused, 426
 *      app_too_old: it could not show the six digits whole, and would tell its member the computer was signed in.
 *   2c. An AI assistant's consent (agent/oauth-route.ts) names what the assistant may do beyond reading, the page's two
 *      ticks, chosen there BEFORE the phone looks (setPairingAsks). The phone shows them, signs them into its approval
 *      (@beanpool/core assistantConsentText), and the node grants only those: ticks the page changed after the phone
 *      looked are refused at the approval, and a tick the page sends with its digits that the phone did not approve
 *      ends the pairing (risk 3).
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
import { assistantConsentText, settingsSigninText, verifyStatementSignature } from './engine/member-signature.js';
import type { AssistantTicks } from '@beanpool/core';
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
/** Time the page has to type the phone's six digits after the approval. */
export const PAIRING_CONFIRM_TTL_MS = 30_000;
/** How many digits the phone shows and the page types (Marty, 18 Nov: six, one try). */
export const PAIRING_CONFIRM_DIGITS = 6;
/** Wrong digits before the pairing is burned: one. A wrong code ends that pairing; the browser starts a new one. */
export const PAIRING_CONFIRM_TRIES = 1;
/** What an app that shows six digits sends with its approval (`confirm`). Anything else is an app too old to show them. */
export const PAIRING_CONFIRM_SIX = 'six-digits';
const SIX_DIGITS = new RegExp(`^\\d{${PAIRING_CONFIRM_DIGITS}}$`);

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
    /** Number matching: the six digits the phone shows, until the page types them. */
    confirmCode?: string;
    confirmExpiresAt?: number;
    confirmTries?: number;
    /** An AI assistant asking to connect (agent/oauth-route.ts): the phone shows this, and the approval is no session. */
    agent?: PairingAgent;
    /** An assistant's consent: the ticks the page asks for now (setPairingAsks), shown to the phone. Off until set. */
    asks?: AssistantTicks;
    /** The ticks the phone showed and signed: the only ones the grant gets. Set at the approval, never after. */
    approvedTicks?: AssistantTicks;
}

/**
 * The assistant a consent pairing is for. The name is the client's own (anyone registers any name), so it is never shown
 * alone: `sendsTo` is the host its answers go to, from the redirect address it registered (design appendix point 4).
 */
export interface PairingAgent { name: string; sendsTo: string }

const NO_TICKS: AssistantTicks = Object.freeze({ canPost: false, canModerate: false });
/** Ticks from a request body: each on only for a JSON true. Null when the value is not an object (an app too old to sign them). */
export function readTicks(v: unknown): AssistantTicks | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const t = v as { canPost?: unknown; canModerate?: unknown };
    return { canPost: t.canPost === true, canModerate: t.canModerate === true };
}
const sameTicks = (a: AssistantTicks, b: AssistantTicks) => a.canPost === b.canPost && a.canModerate === b.canModerate;

const pairings = new Map<string, Pairing>();
const waiters = new Map<string, Set<() => void>>();
const createBuckets = new Map<string, { count: number; resetAt: number }>();

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

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

export function createPairing(opts: { clientKey: string; userAgent?: string; requesterAddress?: string; agent?: PairingAgent; now?: number }): CreateResult {
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
        ...(opts.agent ? { agent: { name: opts.agent.name, sendsTo: opts.agent.sendsTo } } : {}),
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
    /**
     * Both addresses can be compared and they differ: the computer is on another network than the phone. False when they
     * can't be compared (either stands for many), so the phone's loud line never fires on a guess.
     */
    otherNetwork: boolean;
    /** An AI assistant asking to connect for the member who approves: its name, where its answers go, and what it asks to do. */
    agent?: PairingAgent & { asks: AssistantTicks };
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
    const comparable = !!viewerAddress && !standsForMany(viewerAddress) && !standsForMany(p.requesterAddress);
    const same = comparable && limiterKeyForIp(viewerAddress!) === limiterKeyForIp(p.requesterAddress);
    return {
        ok: true,
        shortCode: p.shortCode,
        browser: p.browser,
        expiresAt: p.expiresAt,
        expiresInSeconds: Math.max(0, Math.round((p.expiresAt - now) / 1000)),
        askedSecondsAgo: Math.max(0, Math.round((now - p.createdAt) / 1000)),
        fromAddress: p.requesterAddress,
        sameNetwork: same,
        otherNetwork: comparable && !same,
        ...(p.agent ? { agent: { ...p.agent, asks: { ...(p.asks ?? NO_TICKS) } } } : {}),
    };
}

/**
 * The assistant's consent page sets what it asks for (its two ticks), only while the phone has not approved: the browser
 * holding the binding secret, an assistant's pairing, still waiting. After the approval the ticks are the phone's and
 * nothing here moves them.
 */
export function setPairingAsks(pairingId: string, secret: string | undefined, ticks: AssistantTicks, now = Date.now()):
    { ok: true; asks: AssistantTicks } | { ok: false; kind: 'unknown' | 'wrong-browser' | 'expired' | 'not-waiting' } {
    const p = boundPairing(pairingId, secret);
    if (!p) return { ok: false, kind: 'unknown' };
    if (p === 'wrong-browser') return { ok: false, kind: 'wrong-browser' };
    if (!p.agent) return { ok: false, kind: 'unknown' };
    if (expired(p, now)) return { ok: false, kind: 'expired' };
    if (p.status !== 'waiting') return { ok: false, kind: 'not-waiting' };
    p.asks = { canPost: ticks.canPost === true, canModerate: ticks.canModerate === true };
    return { ok: true, asks: { ...p.asks } };
}

export type ApproveResult =
    | { ok: true; role: MemberNodeRole; confirmCode?: string; confirmExpiresAt?: number }
    | { ok: false; status: number; error: string; code?: string; reason: 'unknown' | 'expired' | 'used' | 'bad-signature' | 'not-admin' | 'inactive' | 'refused' | 'wrong-community' | 'app-too-old' | 'not-owner-or-admin' | 'asks-changed' };

/** An app that does not say it shows six digits cannot show them whole: it cannot approve a sign-in (risk 2). */
export const SIGNIN_APP_TOO_OLD = 'Update the BeanPool app to sign in on a computer: this version cannot show you the six digits to type there.';
/** An app that shows which assistant asks, what it asks to do, and six digits sends all three; an older one cannot approve an assistant. */
export const AGENT_APP_TOO_OLD = 'Update the BeanPool app to connect an AI assistant: this version cannot show you which assistant is asking and what it may do.';
/** The page changed its ticks after the phone looked: the phone signed what it showed, which is no longer what is asked. */
export const ASKS_CHANGED = 'What the assistant asks to do changed on the computer after your phone showed it. Nothing was approved: scan the code again.';

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
 * format-2 text naming the host the phone reached this node at (`signedFor`), which must be this community's; one
 * without it is an app from before request binding, answered 426 app_too_old (CUT4). A pairing shown by community A and
 * approved there is never an approval at B: a hostile A could otherwise show a QR carrying B's pairing id and its own
 * address, and sign in to B's Settings as the member.
 */
function pairingSignature(p: Pairing, action: 'approve' | 'decline', memberPubkey: string, signature: string, signedFor: unknown, ticks?: AssistantTicks) {
    return verifyStatementSignature({
        signature,
        pubKeyHex: memberPubkey,
        // An assistant's approval names the ticks the phone showed (risk 3); a Settings sign-in and any decline do not.
        boundText: (host) => (ticks ? assistantConsentText(host, p.id, p.shortCode, ticks) : settingsSigninText(host, action, p.id, p.shortCode)),
        signedFor,
        oldShapeTooOld: true,
    });
}

export function approvePairing(params: {
    pairingId: string;
    memberPubkey: string;
    signature: string;
    /** The host the phone signed for (format 2); absent from an old app. */
    signedFor?: unknown;
    /** `'six-digits'`: the app shows six digits for the page to type (number matching). Anything else is an older app, refused. */
    confirm?: unknown;
    /** The app showed the assistant's name and where its answers go (describePairing's `agent`). */
    agentShown?: boolean;
    /** An assistant's consent: the ticks the phone showed, which its signature covers (readTicks of the body). */
    ticks?: AssistantTicks | null;
    now?: number;
}): ApproveResult {
    const now = params.now ?? Date.now();
    const p = isPairingId(params.pairingId) ? pairings.get(params.pairingId) : undefined;
    if (!p) return { ok: false, status: 404, error: 'That code is not known here. Get a new code on the computer.', reason: 'unknown' };
    if (expired(p, now)) return { ok: false, status: 410, error: 'That code has expired. Get a new code on the computer.', reason: 'expired' };
    if (p.status === 'refused') return { ok: false, status: 410, error: 'Too many refused attempts on that code. Get a new code on the computer.', reason: 'refused' };
    if (p.status !== 'waiting') return { ok: false, status: 409, error: 'That code was already used. Get a new code on the computer.', reason: 'used' };

    // An assistant's consent needs an app that showed it, what it asks to do (signed), AND the six digits: an app that shows
    // only "a computer wants to sign in" must not hand an assistant the member's role (a phishing link would look like a
    // Settings sign-in), and one that can't show the ticks must not grant them.
    const ticks = p.agent ? params.ticks ?? null : undefined;
    if (p.agent && (params.confirm !== PAIRING_CONFIRM_SIX || params.agentShown !== true || !ticks)) {
        return { ok: false, status: 426, error: AGENT_APP_TOO_OLD, code: 'agent_app_too_old', reason: 'app-too-old' };
    }
    // Every sign-in needs an app that shows the six digits (risk 2): without them, a member fooled into tapping Sign in on
    // a QR someone sent them would sign that someone's browser in, and an app that can show only two would say it had.
    if (params.confirm !== PAIRING_CONFIRM_SIX) {
        return { ok: false, status: 426, error: SIGNIN_APP_TOO_OLD, code: 'app_too_old', reason: 'app-too-old' };
    }
    const memberPubkey = String(params.memberPubkey || '').trim();
    // The signature is checked FIRST here (authorizeKeySigner checks it after the role): only a real key holder
    // may cause a "holds no role here" notice on the waiting page.
    const signed = pairingSignature(p, 'approve', memberPubkey, params.signature, params.signedFor, ticks ?? undefined);
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

    if (p.agent && signer.role !== 'owner' && signer.role !== 'admin') {
        refuse(p);
        return { ok: false, status: 403, error: 'Only an owner or an admin of this community can connect an AI assistant.', reason: 'not-owner-or-admin' };
    }
    // The phone signed the ticks it showed; the page may have changed them since. Only what the phone showed is approved,
    // so a change means nothing is (the member scans again and sees the new ones). Not a refusal: the pairing still waits.
    if (p.agent && ticks && !sameTicks(ticks, p.asks ?? NO_TICKS)) {
        return { ok: false, status: 409, error: ASKS_CHANGED, code: 'asks_changed', reason: 'asks-changed' };
    }
    // An assistant's consent signs no browser in: no session token is minted for it (the page gets a code, agent/oauth.ts).
    if (!p.agent) {
        const { handshakeToken, expiresAt } = mintHandshakeToken(memberPubkey, signer.role, now);
        p.handshakeToken = handshakeToken;
        p.handshakeExpiresAt = expiresAt;
    }
    p.approvedBy = memberPubkey;
    p.role = signer.role;
    if (p.agent && ticks) p.approvedTicks = { ...ticks };
    p.notice = undefined;
    p.status = 'confirming';
    p.confirmCode = sixDigits();
    p.confirmExpiresAt = now + PAIRING_CONFIRM_TTL_MS;
    p.confirmTries = 0;
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

/** Six digits from the node's CSPRNG (crypto.randomInt: uniform, no modulo bias), zero-padded. */
export function sixDigits(): string {
    return String(crypto.randomInt(10 ** PAIRING_CONFIRM_DIGITS)).padStart(PAIRING_CONFIRM_DIGITS, '0');
}

// ===================== 3. THE BROWSER WAITS, THEN REDEEMS =====================

export type RedeemResult =
    | { kind: 'waiting'; expiresAt: number; notice?: PairingNotice }
    | { kind: 'confirm'; confirmExpiresAt: number }
    | { kind: 'agent-approved'; memberPubkey: string; role: MemberNodeRole; ticks: AssistantTicks }
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
 * The page types the six digits the phone shows. Right digits within 30 s redeem the held token, once; one wrong try
 * burns the pairing (PAIRING_CONFIRM_TRIES). Only the browser holding the binding secret may try, so nobody else can use
 * up its try. An assistant's page that sends a tick with its digits the phone did not approve (`pageTicks`) ends the
 * pairing too: a tick added in the browser after approval is never granted.
 */
export function confirmPairing(pairingId: string, secret: string | undefined, digits: unknown, now = Date.now(), pageTicks?: AssistantTicks | null):
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
    const approved = p.approvedTicks ?? NO_TICKS;
    if (p.agent && pageTicks && ((pageTicks.canPost && !approved.canPost) || (pageTicks.canModerate && !approved.canModerate))) {
        p.status = 'refused';
        p.confirmCode = undefined;
        logger.security('AUTH', `AI assistant consent: pairing ${p.id.slice(0, 8)} ended — the page sent a tick the phone did not approve (approved by ${who(p.approvedBy || '')}), nothing granted`);
        notify(p.id);
        return { kind: 'refused' };
    }
    const typed = String(digits ?? '').trim();
    const right = SIX_DIGITS.test(typed) && crypto.timingSafeEqual(Buffer.from(typed), Buffer.from(p.confirmCode!));
    if (!right) {
        p.confirmTries = (p.confirmTries ?? 0) + 1;
        if (p.confirmTries >= PAIRING_CONFIRM_TRIES) {
            p.status = 'refused';
            p.handshakeToken = undefined;
            p.confirmCode = undefined;
            logger.security('AUTH', `Settings sign-in by phone: pairing ${p.id.slice(0, 8)} burned: wrong digits typed on the computer (${p.browser}) — approved by ${who(p.approvedBy || '')}, no session`);
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
    if (p.agent) {
        p.status = 'used';
        logger.security('AUTH', `AI assistant approved by phone: ${who(p.approvedBy || '')} (${p.role}) for an assistant sending to ${p.agent.sendsTo} (pairing ${p.id.slice(0, 8)})`);
        return { kind: 'agent-approved', memberPubkey: p.approvedBy!, role: p.role!, ticks: { ...(p.approvedTicks ?? NO_TICKS) } };
    }
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
