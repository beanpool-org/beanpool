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
import { isNodeMember } from '@beanpool/engine';
import { db } from '../db/db.js';
import { logger } from '../logger.js';
import { BAD_KEY_CODE, BAD_SIGNER_KEY_ERROR, provenKeySpelling } from './member-key.js';
import { isNodeAdmin } from './node-roles.js';
import { audienceStanding } from './own-addresses.js';

// ─── The switch ─────────────────────────────────────────────────────────────────────────────

/**
 * The first day (UTC) on which this server refuses a member signature in the old format, bound to no community.
 *
 * Marty's card replay-old-apps (2026-09-27): "On launch day". Launch day has no date yet, so until the launch release
 * this is a day clearly after any launch, and it must never come before the new apps (request binding PRs 2 and 3) are
 * in the stores. On launch day our own communities set ACCEPT_UNBOUND_SIGNATURES_UNTIL to that day, and the launch
 * release sets this constant to it, so every other community closes on its own. Until then old apps keep working, and
 * a hostile community's operator could still replay their requests elsewhere or have an old app's Manage button sign
 * one: harmless while every community is ours.
 */
export const UNBOUND_SIGNATURES_UNTIL = '2027-06-30';

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

/**
 * Single-use nonces within a freshness window (`windowMs`, the one its requests are checked with). `consume` is atomic
 * (check-and-set): concurrent duplicates can't both pass.
 */
export class NonceStore {
    private readonly seen = new Map<string, number>();
    constructor(private readonly windowMs: number) {}

    /**
     * Spend `nonce`, or false when it is already spent. It stays spent for as long as a request carrying it is fresh,
     * which is counted from the request's timestamp (`signedAt`), not from its arrival: a phone whose clock runs ahead
     * sends a timestamp that is still fresh up to the window after it, and a nonce held only for the window from its
     * arrival could be replayed once that had passed. Freshness refuses only beyond the window, so the last fresh
     * millisecond is held too.
     */
    consume(nonce: string, now: number, signedAt = now): boolean {
        if (this.seen.size > 10_000) {
            for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
        }
        const exp = this.seen.get(nonce);
        if (exp !== undefined && exp > now) return false;
        this.seen.set(nonce, (Number.isFinite(signedAt) ? Math.max(now, signedAt) : now) + this.windowMs + 1);
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

/**
 * `spelling`: how the signature is written. A request's and a `/ws` token's are base64 only, as origin/main read them:
 * the middleware stores X-Signature as sent (a transfer's `auth_signature`) and a backup reads it as base64
 * (engine/sync.ts verifyTransactionAuthorship), so a hex one would be a send no backup can check (4113046881). The
 * statements (sign-in, pairing, re-enrolment) take hex as well, as they did (admin-key-auth.ts verifyEd25519Signature).
 */
function ed25519Verify(bytes: Uint8Array, signature: string, pubKeyHex: string, spelling: 'base64' | 'base64-or-hex'): boolean {
    try {
        const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubKeyHex, 'hex')]);
        const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
        const clean = String(signature ?? '').trim();
        const hex = spelling === 'base64-or-hex' && /^[0-9a-fA-F]{128}$/.test(clean);
        const sig = Buffer.from(clean, hex ? 'hex' : 'base64');
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

/**
 * Count an accepted signature for Settings: by the host it named, or as an old app's. Only a member's app counts
 * (isNodeMember): a key with no row here costs nothing to make, so strangers' keys could otherwise fill the list of
 * addresses offered to the owner, or raise "N members are on an old app", the number an owner reads to decide whether
 * to move the switch date (4113046943).
 */
export function countAcceptedSignature(signer: string, audience: string | null): void {
    try {
        if (!isNodeMember(db, signer)) return;
    } catch {
        return; // a count never refuses a request
    }
    if (audience === null) return void countSignature('old_app', '', signer);
    if (audienceStanding(audience) === 'own') return void countSignature('own', audience, signer);
    countUnconfirmed(audience, signer);
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
    if (!ed25519Verify(bytesOfSignedText(text), parts.signature, signer, 'base64')) {
        return { ok: false, status: 403, error: 'Invalid cryptographic signature' };
    }

    const audience = bound ? (parts.signedFor as string) : null;
    const refusal = audience !== null ? audienceRefusal(audience, signer) : unboundRefusal();
    if (refusal) return refusal;

    if (opts.consumeNonce && !(opts.nonces ?? requestNonces).consume(parts.nonce, now, ts)) {
        return { ok: false, status: 403, error: 'Replay detected: nonce already used' };
    }
    countAcceptedSignature(signer, audience);
    return { ok: true, signer, format: bound ? 2 : 1, audience, text };
}

/**
 * A member-made signature over one of the fixed statements (Settings sign-in, pairing, re-enrolment), in either form:
 * the format-2 text naming one of this community's hosts, or the old text until the switch. A format-2 statement MUST
 * carry the host it names (the body's `signedFor`): only that host's text is checked, and it must be one of this
 * community's. With no `signedFor` the signature is read as the old form, so a format-2 signature sent without it is
 * refused (403). `oldTexts` are the statement's old forms, tried only while the old format is accepted.
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
        if (!host || !ed25519Verify(signedRequestBytes(params.boundText(host)), signature, signer, 'base64-or-hex')) {
            return { ok: false, status: 403, error: 'Invalid cryptographic signature' };
        }
        const refused = audienceRefusal(host, signer);
        if (refused) return refused;
        countAcceptedSignature(signer, host);
        return { ok: true, format: 2, audience: host };
    }
    for (const old of params.oldTexts) {
        if (ed25519Verify(Buffer.from(old, 'utf-8'), signature, signer, 'base64-or-hex')) {
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
 * How many members' apps signed here, per day (UTC): for each of this community's addresses (`own`), for each address
 * a node with no configured names was reached at (`unconfirmed`, offered to the owner: engine/address-offers.ts), and
 * in the old format (`old_app`, "N members are on an old app"). Members' keys only (countAcceptedSignature), so a
 * stranger's keys move none of them. Counts only, no key is stored: the day's distinct keys are held in memory as
 * salted hashes. A request never writes to the database: the counts are written when Settings reads them and every 15
 * minutes (flushSignatureCounts), each as the most this process has seen that day. After a restart a day's count
 * starts again, so it can read low for that day, never high.
 *
 * For an `unconfirmed` address, two more things, so Settings can tell a host one member's app planted from this
 * community's real one:
 *   - one app puts at most MAX_UNCONFIRMED_HOSTS_PER_KEY addresses on the day's list. A real app reaches a community at
 *     one address (a home-network one is this community's already, never on this list), so one member signing for
 *     many hosts can't fill the day's MAX_ADDRESSES_PER_KIND and crowd out the real one. Held in memory, per day:
 *     after a restart an app may add that many again, and the day's cap still holds;
 *   - whether an owner's or admin's app signed for it (isNodeAdmin: a role that acts; a moderator's app is a member's):
 *     the address and the last day, no key, in node_config row STAFF_SEEN_KEY, written with the counts, so a restart
 *     keeps it. At most MAX_ADDRESSES_PER_KIND addresses, none older than 8 days. The role is the one the signer held
 *     when its app first signed for the address that day: an admin made later counts from the next day it signs for
 *     it, and one removed still counts for the rest of the week.
 */
export type SignatureKind = 'own' | 'unconfirmed' | 'old_app';

/** Bounds on what one day can hold in memory: addresses per kind, and keys per address. */
const MAX_ADDRESSES_PER_KIND = 50;
const MAX_KEYS_PER_ADDRESS = 100_000;
/** How many addresses one app can put on a day's `unconfirmed` list. */
export const MAX_UNCONFIRMED_HOSTS_PER_KEY = 3;
/** The node_config row of owner/admin sightings: { [address]: the last day (UTC) an owner's or admin's app signed for it }. */
export const STAFF_SEEN_KEY = 'appAddressStaffSeen';

const processSalt = crypto.randomBytes(16);
/** day → kind → address → hashed keys */
const seen = new Map<string, Map<SignatureKind, Map<string, Set<string>>>>();
/** day → hashed key → the `unconfirmed` addresses it is counted for */
const unconfirmedByKey = new Map<string, Map<string, Set<string>>>();
/** day → the `unconfirmed` addresses an owner's or admin's app signed for */
const staffSeen = new Map<string, Set<string>>();
let dirty = false;

function today(now = clock()): string {
    return new Date(now).toISOString().slice(0, 10);
}

const daysAgo = (now: number, n: number) => new Date(now - n * 86_400_000).toISOString().slice(0, 10);

const hashOf = (signer: string) => crypto.createHmac('sha256', processSalt).update(signer).digest('base64').slice(0, 16);

/** Count `signer` for `address` on `day`: whether it is counted there (false when a bound leaves it out). */
function countSignature(kind: SignatureKind, address: string, signer: string, day = today(Date.now())): boolean {
    try {
        let byKind = seen.get(day);
        if (!byKind) {
            byKind = new Map();
            seen.set(day, byKind);
        }
        let byAddress = byKind.get(kind);
        if (!byAddress) {
            byAddress = new Map();
            byKind.set(kind, byAddress);
        }
        let keys = byAddress.get(address);
        if (!keys) {
            if (byAddress.size >= MAX_ADDRESSES_PER_KIND) return false;
            keys = new Set();
            byAddress.set(address, keys);
        }
        const h = hashOf(signer);
        if (!keys.has(h)) {
            if (keys.size >= MAX_KEYS_PER_ADDRESS) return false;
            keys.add(h);
            dirty = true;
        }
        return true;
    } catch (e: any) {
        // A count is never allowed to refuse a request.
        logger.warn('AUTH', `could not count a signature: ${e?.message || e}`);
        return false;
    }
}

/** An accepted signature for a host this node doesn't know as its own: counted within the bounds above. */
function countUnconfirmed(address: string, signer: string): void {
    try {
        const day = today(Date.now());
        let byKey = unconfirmedByKey.get(day);
        if (!byKey) {
            byKey = new Map();
            unconfirmedByKey.set(day, byKey);
        }
        const h = hashOf(signer);
        let mine = byKey.get(h);
        // Counted for this address today already, and its role looked at then: nothing more to do.
        if (mine?.has(address)) return;
        if ((mine?.size ?? 0) >= MAX_UNCONFIRMED_HOSTS_PER_KEY) return;
        if (!mine && byKey.size >= MAX_KEYS_PER_ADDRESS) return;
        if (!countSignature('unconfirmed', address, signer, day)) return;
        if (!mine) {
            mine = new Set();
            byKey.set(h, mine);
        }
        mine.add(address);
        if (isNodeAdmin(signer)) {
            let addresses = staffSeen.get(day);
            if (!addresses) {
                addresses = new Set();
                staffSeen.set(day, addresses);
            }
            if (!addresses.has(address)) {
                addresses.add(address);
                dirty = true;
            }
        }
    } catch (e: any) {
        logger.warn('AUTH', `could not count a signature: ${e?.message || e}`);
    }
}

/** The owner/admin sightings as stored: address → the last day. Anything malformed in the row is left out. */
function storedStaffSeen(): Map<string, string> {
    const out = new Map<string, string>();
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(STAFF_SEEN_KEY) as { value?: string } | undefined;
    if (!row?.value) return out;
    try {
        const v = JSON.parse(row.value);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
        for (const [address, day] of Object.entries(v)) {
            if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && address.length <= 253) out.set(address, day);
        }
    } catch { /* an unreadable row reads as none */ }
    return out;
}

/** Memory's sightings merged into the stored ones: the latest day per address, the last 8 days, the newest kept. */
function writeStaffSeen(now: number): void {
    const merged = storedStaffSeen();
    for (const [day, addresses] of staffSeen) {
        for (const address of addresses) {
            const was = merged.get(address);
            if (!was || was < day) merged.set(address, day);
        }
    }
    const oldest = daysAgo(now, 8);
    const kept = [...merged].filter(([, day]) => day >= oldest)
        .sort((a, b) => (a[1] !== b[1] ? (a[1] < b[1] ? 1 : -1) : a[0] < b[0] ? -1 : 1))
        .slice(0, MAX_ADDRESSES_PER_KIND);
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(STAFF_SEEN_KEY, JSON.stringify(Object.fromEntries(kept)));
}

/** Write the counts held in memory, drop the days before today from memory, and the rows older than 8 days. */
export function flushSignatureCounts(now = Date.now()): void {
    try {
        const day = today(now);
        if (dirty) {
            const put = db.prepare(
                `INSERT INTO signature_audiences (day, kind, address, people) VALUES (?, ?, ?, ?)
                 ON CONFLICT(day, kind, address) DO UPDATE SET people = MAX(people, excluded.people)`,
            );
            db.transaction(() => {
                for (const [d, byKind] of seen) {
                    for (const [kind, byAddress] of byKind) {
                        for (const [address, keys] of byAddress) put.run(d, kind, address, keys.size);
                    }
                }
                db.prepare('DELETE FROM signature_audiences WHERE day < ?').run(daysAgo(now, 8));
                if (staffSeen.size > 0) writeStaffSeen(now);
            })();
            dirty = false;
        }
        for (const d of [...seen.keys()]) if (d < day) seen.delete(d);
        for (const d of [...unconfirmedByKey.keys()]) if (d < day) unconfirmedByKey.delete(d);
        for (const d of [...staffSeen.keys()]) if (d < day) staffSeen.delete(d);
    } catch (e: any) {
        logger.warn('AUTH', `could not write the signature counts: ${e?.message || e}`);
    }
}

if (typeof setInterval !== 'undefined') {
    const t = setInterval(() => flushSignatureCounts(), 15 * 60_000);
    if (t.unref) t.unref();
}

const loggedUnconfirmed = new Set<string>();

function noteUnconfirmedAudience(host: string, _signer: string | null): void {
    if (loggedUnconfirmed.has(host) || loggedUnconfirmed.size > 200) return;
    loggedUnconfirmed.add(host);
    logger.warn('AUTH', `An app signed for "${host}", and this community has no address configured, so it was accepted. `
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

/** The last 7 days' counts, per kind and address, for Settings (what memory holds is written first). */
export function signatureUsage(now = Date.now()): AudienceUsage[] {
    flushSignatureCounts(now);
    const from = new Date(now - 6 * 86_400_000).toISOString().slice(0, 10);
    const day = today(now);
    const rows = db.prepare(
        `SELECT kind, address, MAX(people) AS busiest, MAX(CASE WHEN day = ? THEN people ELSE 0 END) AS today
         FROM signature_audiences WHERE day >= ? GROUP BY kind, address ORDER BY kind, address`,
    ).all(day, from) as { kind: SignatureKind; address: string; busiest: number; today: number }[];
    return rows.map((r) => ({ kind: r.kind, address: r.address, today: Number(r.today) || 0, busiestDay: Number(r.busiest) || 0 }));
}

/** The `unconfirmed` addresses an owner's or admin's app signed for in the last 7 days (what memory holds is written first). */
export function staffSeenAddresses(now = Date.now()): Set<string> {
    flushSignatureCounts(now);
    const from = daysAgo(now, 6);
    const out = new Set<string>();
    try {
        for (const [address, day] of storedStaffSeen()) if (day >= from) out.add(address);
    } catch (e: any) {
        logger.warn('AUTH', `could not read which addresses owners' and admins' apps used: ${e?.message || e}`);
    }
    return out;
}

/** Tests: forget the in-memory distinct keys (as a restart does). */
export function resetSignatureCountsForTests(): void {
    seen.clear();
    unconfirmedByKey.clear();
    staffSeen.clear();
    dirty = false;
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
