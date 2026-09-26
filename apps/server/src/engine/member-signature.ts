/**
 * One verifier for every member signature this server checks: signed requests (the signature middleware), the `/ws`
 * connect token, "sign me out everywhere", the redeem routes, the Settings sign-in, phone pairing, offline tickets and
 * the re-enrolment proof. The format is @beanpool/core request-signing.ts.
 *
 * The order (design §4.2, 2026-09-27):
 *   1. the key's spelling (engine/member-key.ts);
 *   2. freshness;
 *   3. the signature, over the format-2 bytes when the request names a host (X-Signed-For, or `for=` with `v=2` on a
 *      socket), over the old bytes when it names none;
 *   4. format 2: the host is one of this community's (engine/own-addresses.ts), or 421 wrong_community;
 *   5. the old format: accepted and counted until the switch, 426 app_too_old after it;
 *   6. THEN the nonce is spent. Before this the signature middleware spent it first, so a forged request could burn a
 *      real one; and a request refused here for naming another community leaves its nonce unspent.
 *
 * The switch is {@link UNBOUND_SIGNATURES_UNTIL}, overridable per node by env ACCEPT_UNBOUND_SIGNATURES_UNTIL. It is a
 * date, not a version, so a stranger's node that never touches its config closes on its own.
 */

import crypto from 'node:crypto';
import {
    adminSigninText, bytesOfSignedText, inviteTicketText, reEnrollText, settingsSigninText, signedRequestBytes,
    signedRequestText, unboundRequestText,
} from '@beanpool/core';
import { db } from '../db/db.js';
import { logger } from '../logger.js';
import { BAD_KEY_CODE, BAD_SIGNER_KEY_ERROR, provenKeySpelling } from './member-key.js';
import { audienceStanding } from './own-addresses.js';

// ─── The switch ─────────────────────────────────────────────────────────────────────────────

/**
 * The first day (UTC) on which this server refuses a member signature in the old format, bound to no community.
 *
 * PLACEHOLDER: Marty's card replay-old-apps. The director sets the real date before merge. Until then: old apps keep
 * working, and a hostile community's operator can still replay their requests elsewhere, or have an old app's Manage
 * button sign one.
 */
export const UNBOUND_SIGNATURES_UNTIL = '2026-12-15';

let clock: () => number = () => Date.now();

/** Tests: the clock the switch is decided by. Freshness and nonces keep the real clock. */
export function setSignatureSwitchClockForTests(now: (() => number) | null): void {
    clock = now ?? (() => Date.now());
}

let warnedBadEnv = '';

/** When the old format stops being accepted here (ms), or 'never' when this node refuses it already. */
export function unboundSignaturesCutoff(): number | 'refused' {
    const raw = String(process.env.ACCEPT_UNBOUND_SIGNATURES_UNTIL ?? '').trim();
    if (raw.toLowerCase() === 'never') return 'refused';
    if (raw) {
        const t = Date.parse(raw);
        if (Number.isFinite(t)) return t;
        if (warnedBadEnv !== raw) {
            warnedBadEnv = raw;
            logger.warn('AUTH', `ACCEPT_UNBOUND_SIGNATURES_UNTIL=${JSON.stringify(raw)} is neither a date nor "never"; using ${UNBOUND_SIGNATURES_UNTIL}`);
        }
    }
    return Date.parse(`${UNBOUND_SIGNATURES_UNTIL}T00:00:00Z`);
}

/** Whether a signature bound to no community (an old app's) is still accepted here now. */
export function unboundSignaturesAccepted(now = clock()): boolean {
    const cutoff = unboundSignaturesCutoff();
    return cutoff !== 'refused' && now < cutoff;
}

/** The switch as Settings and `/api/community/info` show it: the ISO day, or null when the old format is refused. */
export function unboundSignaturesUntilDay(): string | null {
    const cutoff = unboundSignaturesCutoff();
    return cutoff === 'refused' ? null : new Date(cutoff).toISOString().slice(0, 10);
}

export const APP_TOO_OLD_CODE = 'app_too_old';
export const APP_TOO_OLD_ERROR = 'This version of BeanPool is too old for this community. Please update BeanPool from the app store.';
export const WRONG_COMMUNITY_CODE = 'wrong_community';
export const WRONG_COMMUNITY_ERROR = 'This was signed for another community, so this one does not accept it. If you opened this community from a link, open it in the BeanPool app instead.';

// ─── Nonces ─────────────────────────────────────────────────────────────────────────────────

/** A signed request is valid for this long around its timestamp (X-1). */
export const SIGNATURE_FRESHNESS_MS = 5 * 60 * 1000;

/** Single-use nonces within a freshness window. `consume` is atomic (check-and-set): concurrent duplicates can't both pass. */
export class NonceStore {
    private readonly seen = new Map<string, number>();
    constructor(private readonly windowMs: number) {}

    consume(nonce: string, now: number): boolean {
        if (this.seen.size > 10_000) {
            for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
        }
        const exp = this.seen.get(nonce);
        if (exp !== undefined && exp > now) return false;
        this.seen.set(nonce, now + this.windowMs);
        return true;
    }

    /** Forget every nonce whose window has passed. */
    prune(now: number): void {
        for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
    }

    /** Whether `nonce` is spent and still inside its window. Read only. */
    isSpent(nonce: string, now = Date.now()): boolean {
        const exp = this.seen.get(nonce);
        return exp !== undefined && exp > now;
    }
}

/** The nonces of signed requests and `/ws` connect tokens, one store for the process. */
export const requestNonces = new NonceStore(SIGNATURE_FRESHNESS_MS);

// ─── Verifying ──────────────────────────────────────────────────────────────────────────────

export interface SignedRequestParts {
    pubKeyHex: string;
    signature: string;
    timestamp: string;
    nonce: string;
    method: string;
    path: string;
    body: string;
    /** The host the request says it was signed for (X-Signed-For, or `for=` with `v=2`), or null for the old format. */
    signedFor: string | null;
}

export type SignatureRefusal = { ok: false; status: 400 | 401 | 403 | 421 | 426; error: string; code?: string };

export type MemberSignatureVerdict =
    | {
        ok: true;
        /** The signer in the member table's one spelling. */
        signer: string;
        format: 1 | 2;
        audience: string | null;
        /** The text signed: what a transfer stores as `auth_payload`. */
        text: string;
    }
    | SignatureRefusal;

export interface VerifyOptions {
    /** Spend the nonce once everything else has passed. False where a route re-checks a request it did not spend. */
    consumeNonce: boolean;
    freshnessMs?: number;
    nonces?: NonceStore;
    now?: number;
}

function ed25519Verify(bytes: Uint8Array, signature: string, pubKeyHex: string): boolean {
    try {
        const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubKeyHex, 'hex')]);
        const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
        const clean = String(signature ?? '').trim();
        const sig = Buffer.from(clean, /^[0-9a-fA-F]{128}$/.test(clean) ? 'hex' : 'base64');
        return crypto.verify(undefined, Buffer.from(bytes), key, sig);
    } catch {
        return false;
    }
}

/**
 * Whether a host named in a format-2 signature is this community's: null when it is, the refusal when not. A node that
 * knows none of its names accepts any host until the switch, and logs and counts it for Settings to offer.
 */
export function audienceRefusal(host: string, signer: string | null, now = clock()): SignatureRefusal | null {
    const standing = audienceStanding(host);
    if (standing === 'own') return null;
    if (standing === 'unconfigured' && unboundSignaturesAccepted(now)) {
        noteUnconfirmedAudience(host, signer);
        return null;
    }
    return { ok: false, status: 421, error: WRONG_COMMUNITY_ERROR, code: WRONG_COMMUNITY_CODE };
}

/** Null while the old format is accepted, the refusal once the switch has passed. */
export function unboundRefusal(now = clock()): SignatureRefusal | null {
    return unboundSignaturesAccepted(now) ? null : { ok: false, status: 426, error: APP_TOO_OLD_ERROR, code: APP_TOO_OLD_CODE };
}

/** Count an accepted signature for Settings: by the host it named, or as an old app's. */
export function countAcceptedSignature(signer: string, audience: string | null): void {
    if (audience === null) countSignature('old_app', '', signer);
    else countSignature(audienceStanding(audience) === 'own' ? 'own' : 'unconfirmed', audience, signer);
}

/** Verify a signed request (or `/ws` connect token) in either format, in the order above. */
export function verifyMemberSignature(parts: SignedRequestParts, opts: VerifyOptions): MemberSignatureVerdict {
    const now = opts.now ?? Date.now();
    const signer = provenKeySpelling(parts.pubKeyHex);
    if (!signer) return { ok: false, status: 400, error: BAD_SIGNER_KEY_ERROR, code: BAD_KEY_CODE };

    const ts = Number(parts.timestamp);
    if (!parts.timestamp || !Number.isFinite(ts) || Math.abs(now - ts) > (opts.freshnessMs ?? SIGNATURE_FRESHNESS_MS)) {
        return { ok: false, status: 401, error: 'Request timestamp is stale or invalid' };
    }

    const fields = { method: parts.method, path: parts.path, timestamp: parts.timestamp, nonce: parts.nonce, body: parts.body };
    const bound = parts.signedFor !== null;
    const text = bound ? signedRequestText({ host: parts.signedFor as string, ...fields }) : unboundRequestText(fields);
    if (!ed25519Verify(bytesOfSignedText(text), parts.signature, signer)) {
        return { ok: false, status: 403, error: 'Invalid cryptographic signature' };
    }

    const audience = bound ? (parts.signedFor as string) : null;
    const refusal = audience !== null ? audienceRefusal(audience, signer) : unboundRefusal();
    if (refusal) return refusal;

    if (opts.consumeNonce && !(opts.nonces ?? requestNonces).consume(parts.nonce, now)) {
        return { ok: false, status: 403, error: 'Replay detected: nonce already used' };
    }
    countAcceptedSignature(signer, audience);
    return { ok: true, signer, format: bound ? 2 : 1, audience, text };
}

/**
 * A member-made signature over one of the fixed statements (Settings sign-in, pairing, re-enrolment), in either form:
 * the format-2 text naming one of this community's hosts, or the old text until the switch. The format-2 text is
 * tried against `host` when the caller got one (a `signedFor` field), otherwise against each of this community's
 * names. `oldTexts` are the statement's old forms, tried only while the old format is accepted.
 */
export function verifyStatementSignature(params: {
    signature: string;
    pubKeyHex: string;
    boundText: (host: string) => string;
    /** The host the statement names (the body's `signedFor`), or nothing for the old form. */
    signedFor?: unknown;
    oldTexts: string[];
}): { ok: true; format: 1 | 2; audience: string | null } | SignatureRefusal {
    const { signature, pubKeyHex } = params;
    const signer = provenKeySpelling(pubKeyHex);
    if (!signer) return { ok: false, status: 403, error: 'Invalid cryptographic signature' };
    if (params.signedFor !== undefined && params.signedFor !== null) {
        const host = String(params.signedFor);
        if (!host || !ed25519Verify(signedRequestBytes(params.boundText(host)), signature, signer)) {
            return { ok: false, status: 403, error: 'Invalid cryptographic signature' };
        }
        const refused = audienceRefusal(host, signer);
        if (refused) return refused;
        countAcceptedSignature(signer, host);
        return { ok: true, format: 2, audience: host };
    }
    for (const old of params.oldTexts) {
        if (ed25519Verify(Buffer.from(old, 'utf-8'), signature, signer)) {
            const refused = unboundRefusal();
            if (refused) return refused;
            countAcceptedSignature(signer, null);
            return { ok: true, format: 1, audience: null };
        }
    }
    return { ok: false, status: 403, error: 'Invalid cryptographic signature' };
}

/** The format-2 statements, as the verifiers above build them (the app builds the same in @beanpool/core). */
export { adminSigninText, settingsSigninText, reEnrollText, inviteTicketText };

// ─── Counting (Settings) ────────────────────────────────────────────────────────────────────

/**
 * How many people's apps signed here, per day (UTC): for each of this community's addresses (`own`), for each address
 * a node with no configured names was reached at (`unconfirmed`, offered to the owner), and in the old format
 * (`old_app`, "N members are on an old app"). Counts only, no key is stored: the distinct keys of the day are held in
 * memory as salted hashes, and the stored count is the most this process has seen that day. After a restart a day's
 * count starts again from what was stored, so it can read low for that day, never high.
 */
export type SignatureKind = 'own' | 'unconfirmed' | 'old_app';

const processSalt = crypto.randomBytes(16);
const seenToday = new Map<string, Set<string>>();
let seenDay = '';
let lastPrune = '';

function today(now = clock()): string {
    return new Date(now).toISOString().slice(0, 10);
}

function countSignature(kind: SignatureKind, address: string, signer: string): void {
    try {
        const day = today(Date.now());
        if (day !== seenDay) {
            seenToday.clear();
            seenDay = day;
        }
        const k = `${kind}|${address}`;
        let set = seenToday.get(k);
        if (!set) {
            set = new Set();
            seenToday.set(k, set);
        }
        const h = crypto.createHmac('sha256', processSalt).update(signer).digest('base64').slice(0, 16);
        if (set.has(h)) return;
        set.add(h);
        db.prepare(
            `INSERT INTO signature_audiences (day, kind, address, people) VALUES (?, ?, ?, ?)
             ON CONFLICT(day, kind, address) DO UPDATE SET people = MAX(people, excluded.people)`,
        ).run(day, kind, address, set.size);
        if (lastPrune !== day) {
            lastPrune = day;
            const cutoff = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
            db.prepare('DELETE FROM signature_audiences WHERE day < ?').run(cutoff);
        }
    } catch (e: any) {
        // A count is never allowed to refuse a request.
        logger.warn('AUTH', `could not count a signature: ${e?.message || e}`);
    }
}

const loggedUnconfirmed = new Set<string>();

function noteUnconfirmedAudience(host: string, _signer: string | null): void {
    if (loggedUnconfirmed.has(host) || loggedUnconfirmed.size > 200) return;
    loggedUnconfirmed.add(host);
    logger.warn('AUTH', `A member's app signed for "${host}", and this community has no address configured, so it was accepted. `
        + `Confirm it in Settings (or set BEANPOOL_ADDRESSES) before ${unboundSignaturesUntilDay() ?? 'now'}: after that, a host this community doesn't know is refused.`);
}

export interface AudienceUsage {
    kind: SignatureKind;
    address: string;
    /** Today's count (UTC). */
    today: number;
    /** The busiest day of the last 7, today included. */
    busiestDay: number;
}

/** The last 7 days' counts, per kind and address, for Settings. */
export function signatureUsage(now = Date.now()): AudienceUsage[] {
    const from = new Date(now - 6 * 86_400_000).toISOString().slice(0, 10);
    const day = today(now);
    const rows = db.prepare(
        `SELECT kind, address, MAX(people) AS busiest, MAX(CASE WHEN day = ? THEN people ELSE 0 END) AS today
         FROM signature_audiences WHERE day >= ? GROUP BY kind, address ORDER BY kind, address`,
    ).all(day, from) as { kind: SignatureKind; address: string; busiest: number; today: number }[];
    return rows.map((r) => ({ kind: r.kind, address: r.address, today: Number(r.today) || 0, busiestDay: Number(r.busiest) || 0 }));
}

/** Tests: forget the in-memory distinct keys (as a restart does). */
export function resetSignatureCountsForTests(): void {
    seenToday.clear();
    seenDay = '';
    loggedUnconfirmed.clear();
}

// ─── Offline tickets ────────────────────────────────────────────────────────────────────────

export const TICKET_WRONG_COMMUNITY_ERROR = 'This invite was made for another community, so it can’t be used here. Ask a member of this community for an invite.';
export const TICKET_TOO_OLD_ERROR = 'This invite was made by an old version of BeanPool and no longer works. Ask the member who gave it to you for a new one.';

/**
 * Whether an offline ticket may be used here (the engine's verifyOfflineTicket asks, once the inviter's signature has
 * checked out): one naming another community's host never; one naming none (made by an app from before binding) only
 * until the switch.
 */
export function ticketBinding(t: { format: 1 | 2; audience: string | null; inviter: string }): { reason: 'wrong_community' | 'app_too_old'; error: string } | null {
    const refused = t.format === 2 ? audienceRefusal(String(t.audience ?? ''), t.inviter) : unboundRefusal();
    if (!refused) return null;
    return refused.status === 421
        ? { reason: 'wrong_community', error: TICKET_WRONG_COMMUNITY_ERROR }
        : { reason: 'app_too_old', error: TICKET_TOO_OLD_ERROR };
}
