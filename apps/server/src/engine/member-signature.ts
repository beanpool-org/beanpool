/**
 * One verifier for every member signature this server checks: signed requests (the signature middleware), the `/ws`
 * connect token, "sign me out everywhere", the redeem routes, the Settings sign-in, phone pairing, offline tickets and
 * the re-enrolment proof. The format is @beanpool/core request-signing.ts.
 *
 * The order (design §4.2, 2026-09-27):
 *   1. the key's spelling (engine/member-key.ts);
 *   2. freshness, then the nonce's length (1 to MAX_NONCE_LENGTH characters, else 400: AUTH-03);
 *   3. the signature, over the format-2 bytes when the request names a host (X-Signed-For, or `for=` with `v=2` on a
 *      socket), over the old bytes when it names none;
 *   4. format 2: the host is one of this community's (engine/own-addresses.ts), or 421 wrong_community;
 *   5. the old format: accepted and counted until the switch, 426 app_too_old after it;
 *   6. THEN the nonce is spent. Before this the signature middleware spent it first, so a forged request could burn a
 *      real one; and a request refused here for naming another community leaves its nonce unspent. A new nonce is
 *      spent from its signer's region: a key that acts here (isNodeMember or isLiveVisitor) from the members', any other
 *      from the strangers', by its address (VerifyOptions.client). Past its owner's share or its region's ceiling
 *      (NonceStore) it is refused as busy, 503 store_full; a spent one is still a replay, never busy.
 *
 * The switch is {@link UNBOUND_SIGNATURES_UNTIL}, overridable per node by env ACCEPT_UNBOUND_SIGNATURES_UNTIL. It is a
 * date, not a version, so a stranger's node that never touches its config closes on its own.
 */

import crypto from 'node:crypto';
import {
    adminSigninText, bytesOfSignedText, inviteTicketText, reEnrollText, settingsSigninText, signedRequestBytes,
    signedRequestText, unboundRequestText,
} from '@beanpool/core';
import { isLiveVisitor, isNodeMember } from '@beanpool/engine';
import { db } from '../db/db.js';
import { logger } from '../logger.js';
import { BAD_KEY_CODE, BAD_SIGNER_KEY_ERROR, provenKeySpelling } from './member-key.js';
import { isNodeAdmin } from './node-roles.js';
import { audienceStanding, isLostAddress } from './own-addresses.js';
import {
    emptyNoncePressure, noteRoomRefusal, requestNoncePressure, type NoncePressure, type NonceScope, type RegionPressure,
} from './nonce-pressure.js';

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
 *
 * Forgetting is driven by a min-heap of (expiry, nonce, owner), kept beside the map. Once the map holds more than
 * {@link NONCE_SWEEP_ABOVE}, each `consume` first pops the heap while its earliest expiry has passed, so it visits only
 * the nonces it frees (plus one look at the top): O(log n) a request, where it used to walk the whole map on every
 * request and, with every nonce still fresh, free nothing (load model 2026-10-05: 7.9% of all CPU at 1000 members).
 * The heap is needed, not just the map's insertion order: a phone whose clock runs ahead stores a later expiry than
 * nonces that arrive after it, so "stop at the first live entry" would leave expired ones behind it.
 *
 * Why no nonce is forgotten early: a nonce is deleted only when the map's own expiry for it is at or before `now`.
 * Why every expired one is found: every `set` pushes its (expiry, nonce, owner), and a nonce spent again after its expiry
 * (a client may reuse a nonce string) is swept out first, so the heap holds exactly one pair per entry (a NaN expiry, from
 * a NaN `now`, is never spent and never freed, as before, and is not on the heap: there it would block every sweep).
 *
 * Every nonce has an owner, in one of two scopes (scratch/fable-design/DESIGN-nonce-store-2-fable.md §3): a member's key
 * (`member`: a key that acts here) or a stranger's address (`stranger`: any other verified key, by its limiter key, IPv6
 * by its /64). The verifier asks {@link room} before spending a new one: under its owner's share and its region's
 * ceiling, else it is refused. A pair's owner is one object per owner, shared by its nonces, so the sweep that pops a pair
 * counts it off its owner and its region, and forgets the owner at zero: the counts are exact, and the map, the heap and
 * the owners hold no more than the two ceilings together.
 */
export class NonceStore {
    private readonly seen = new Map<string, number>();
    /** A binary min-heap in three parallel arrays: `heapExp[i]` is the expiry stored for `heapNonce[i]`, spent by `heapOwner[i]`. */
    private readonly heapExp: number[] = [];
    private readonly heapNonce: string[] = [];
    private readonly heapOwner: NonceOwner[] = [];
    /** Each owner with a nonce on the heap, by its id: `k:<key>` for a member's, `a:<limiter key>` for a stranger's. */
    private readonly owners = new Map<string, NonceOwner>();
    private readonly held: Record<NonceScope, { live: number; owners: number }> = {
        member: { live: 0, owners: 0 }, stranger: { live: 0, owners: 0 },
    };
    private readonly base: NonceLimits;
    private shares: NonceLimits;
    /** A suite's limits: a member key's share is `shares.keyMax` exactly, whatever the gateway's minute allowance. */
    private fixedShares = false;
    /** Heap entries the sweeps have looked at, freed or not: what a test counts the forgetting's work by. */
    sweepVisits = 0;

    /** `refusals`: where the store notes what it turned away for room (requestNonces: the one the alert tick reads). */
    constructor(private readonly windowMs: number, limits: Partial<NonceLimits> = {}, private readonly refusals: NoncePressure = emptyNoncePressure()) {
        this.base = { ...NONCE_LIMITS, ...limits };
        this.shares = this.base;
    }

    /**
     * Spend `nonce` for `spender`, or false when it is already spent. It stays spent for as long as a request carrying it
     * is fresh, which is counted from the request's timestamp (`signedAt`), not from its arrival: a phone whose clock runs
     * ahead sends a timestamp that is still fresh up to the window after it, and a nonce held only for the window from its
     * arrival could be replayed once that had passed. Freshness refuses only beyond the window, so the last fresh
     * millisecond is held too. Room is not checked here: the verifier asks {@link room} first.
     */
    consume(nonce: string, now: number, signedAt = now, spender: NonceSpender = UNKNOWN_SPENDER): boolean {
        if (this.seen.size > NONCE_SWEEP_ABOVE) this.forgetExpired(now);
        const exp = this.seen.get(nonce);
        if (exp !== undefined && exp > now) return false;
        // Spent before and expired, not swept yet (a store this small): its pair leaves the heap before the new one goes in.
        if (exp !== undefined && exp <= now) this.forgetExpired(now);
        const until = (Number.isFinite(signedAt) ? Math.max(now, signedAt) : now) + this.windowMs + 1;
        this.seen.set(nonce, until);
        if (!Number.isNaN(until)) this.push(until, nonce, this.acquire(spender));
        return true;
    }

    /**
     * Whether `spender` may spend a new nonce now: null when it may, `owner` when its own share is full (a member's key, a
     * stranger's address), `region` when its scope's region is. When either is at its line the expired nonces are
     * forgotten first and it is asked again, never a live one forgotten: that would let its request be replayed. A
     * refusal is noted (pressure). `keyMax`: a member key's share for the gateway's minute allowance now (nonceKeyShare),
     * never below the store's own.
     */
    room(spender: NonceSpender, now: number, keyMax?: number): NonceRoom {
        let why = this.noRoom(spender, keyMax);
        if (!why) return null;
        this.forgetExpired(now);
        why = this.noRoom(spender, keyMax);
        if (!why) return null;
        const { live, owners } = this.held[spender.scope];
        noteRoomRefusal(this.refusals, spender.scope, why, spender.owner, now,
            { live, owners, ceiling: this.ceiling(spender.scope), share: this.share(spender.scope, keyMax) });
        return why;
    }

    /** What the store turned away for room, per scope (engine/nonce-pressure.ts). */
    pressure(): NoncePressure {
        return this.refusals;
    }

    /** The nonces on the heap in each scope (expired ones not swept yet included), and their owners. */
    counts(): Record<NonceScope, { live: number; owners: number }> {
        return { member: { ...this.held.member }, stranger: { ...this.held.stranger } };
    }

    /** The shares this store holds nonces to. */
    get limits(): NonceLimits {
        return { ...this.shares };
    }

    /** Tests: these limits over the store's own, a member key's share fixed at `keyMax` (null: the store's own again). */
    setLimitsForTests(limits: Partial<NonceLimits> | null): void {
        this.shares = limits ? { ...this.base, ...limits } : this.base;
        this.fixedShares = !!limits;
    }

    /** Forget every nonce whose window has passed. */
    prune(now: number): void {
        this.forgetExpired(now);
    }

    /** Whether `nonce` is spent and still inside its window. Read only. */
    isSpent(nonce: string, now = Date.now()): boolean {
        const exp = this.seen.get(nonce);
        return exp !== undefined && exp > now;
    }

    /** How many nonces are held, expired or not. */
    get size(): number {
        return this.seen.size;
    }

    private noRoom(spender: NonceSpender, keyMax: number | undefined): NonceRoom {
        if ((this.owners.get(spender.owner)?.live ?? 0) >= this.share(spender.scope, keyMax)) return 'owner';
        return this.held[spender.scope].live >= this.ceiling(spender.scope) ? 'region' : null;
    }

    private share(scope: NonceScope, keyMax: number | undefined): number {
        if (scope === 'stranger') return this.shares.addressMax;
        return this.fixedShares || keyMax === undefined ? this.shares.keyMax : Math.max(this.shares.keyMax, keyMax);
    }

    private ceiling(scope: NonceScope): number {
        return scope === 'member' ? this.shares.membersMax : this.shares.strangersMax;
    }

    /** Count one more nonce for `spender`'s owner, made when it has none on the heap. */
    private acquire(spender: NonceSpender): NonceOwner {
        let owner = this.owners.get(spender.owner);
        if (!owner) {
            owner = { id: spender.owner, scope: spender.scope, live: 0 };
            this.owners.set(owner.id, owner);
            this.held[owner.scope].owners++;
        }
        owner.live++;
        this.held[owner.scope].live++;
        return owner;
    }

    /** Count one of `owner`'s nonces off, and forget the owner at zero. */
    private release(owner: NonceOwner): void {
        this.held[owner.scope].live--;
        if (--owner.live > 0) return;
        this.owners.delete(owner.id);
        this.held[owner.scope].owners--;
    }

    private forgetExpired(now: number): void {
        while (this.heapExp.length > 0) {
            this.sweepVisits++;
            if (!(this.heapExp[0] <= now)) return;
            const nonce = this.heapNonce[0];
            this.release(this.heapOwner[0]);
            this.popTop();
            const exp = this.seen.get(nonce);
            if (exp !== undefined && exp <= now) this.seen.delete(nonce);
        }
    }

    private push(exp: number, nonce: string, owner: NonceOwner): void {
        const e = this.heapExp, n = this.heapNonce, o = this.heapOwner;
        let i = e.length;
        e.push(exp);
        n.push(nonce);
        o.push(owner);
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (e[p] <= exp) break;
            e[i] = e[p];
            n[i] = n[p];
            o[i] = o[p];
            i = p;
        }
        e[i] = exp;
        n[i] = nonce;
        o[i] = owner;
    }

    /** Remove the pair with the earliest expiry. The heap is not empty. */
    private popTop(): void {
        const e = this.heapExp, n = this.heapNonce, o = this.heapOwner;
        const lastExp = e.pop()!;
        const lastNonce = n.pop()!;
        const lastOwner = o.pop()!;
        const len = e.length;
        if (len === 0) return;
        let i = 0;
        for (;;) {
            const l = 2 * i + 1;
            if (l >= len) break;
            const c = l + 1 < len && e[l + 1] < e[l] ? l + 1 : l;
            if (e[c] >= lastExp) break;
            e[i] = e[c];
            n[i] = n[c];
            o[i] = o[c];
            i = c;
        }
        e[i] = lastExp;
        n[i] = lastNonce;
        o[i] = lastOwner;
    }
}

/** Who spends a nonce: its scope, and its owner's id (`k:<key>` for a member's key, `a:<limiter key>` for an address). */
export interface NonceSpender { scope: NonceScope; owner: string }
/** One owner with nonces on the heap, shared by all of its pairs. */
interface NonceOwner { readonly id: string; readonly scope: NonceScope; live: number }
/** Why a new nonce has no room (NonceStore room), or null when it has. */
export type NonceRoom = 'owner' | 'region' | null;
export type { NonceScope, NoncePressure };

/** A spender no caller named: every one of them shares one address's share, so leaving it out only tightens. */
const UNKNOWN_SPENDER: NonceSpender = { scope: 'stranger', owner: 'a:unknown' };

/** A store this small is not swept on `consume`: the minute timer's `prune` (https-server.ts) is enough for it. */
export const NONCE_SWEEP_ABOVE = 10_000;

/**
 * How many nonces the store holds, by whose they are (NB1 of #2038's deciding review; re-decided by Fable 2026-10-22,
 * scratch/fable-design/DESIGN-nonce-store-2-fable.md, after the deciding review of #2359 measured ~15 addresses keeping
 * one shared cap of 250,000 full, and every member refused 503 while it was). Without a bound the store was the one map
 * a stranger with fresh keypairs could grow without end: one address is held to ~18,000 live nonces by the gateway
 * limiter, but a flood rotating IPv6 /64s, one request each, spent ~5,200 a second on a Mac, ~3 M held over the
 * 10-minute hold, past the 512 MB heap.
 *
 *   - A key that acts here (isNodeMember or isLiveVisitor, the gateway's own test): NONCE_KEY_MAX in flight, or
 *     NONCE_KEY_MINUTES × the gateway's minute allowance where that is more (nonceKeyShare; its honest most is the
 *     allowance over the 10-minute hold), and NONCE_MEMBERS_MAX for every member together: 10 × the 1,000-member load
 *     model's honest hold, which only 84 member keys flooding at once fill.
 *   - Any other verified key: NONCE_ADDRESS_MAX an address (IPv6 by its /64), NONCE_STRANGERS_MAX together, which 34
 *     addresses fill. A stranger flood of any size never touches a member: while it fills the strangers' region, new
 *     joins and strangers' gated reads wait, and their public reads are answered as unsigned.
 *
 * Measured with the owners tracked (2026-10-22, Node 26 on a Mac): the members' region full of apps' nonces (32 hex)
 * from 1,000 keys, +30 MB of heap (118 B a nonce); the strangers' full of the longest (MAX_NONCE_LENGTH), each from a
 * different /64, +35 MB; both full of the longest, +92 MB of the 512 MB heap; one address at its share, 0.4 MB.
 *
 * Past a share, a request that needs a new nonce is refused as busy (503 store_full, Retry-After) until entries expire;
 * the member sees the sentence and tries again by hand (no app retries an ordinary request on its own). A nonce still in
 * its window is never forgotten to make room. A shorter freshness window was the other way, and was not taken: no app
 * corrects for its phone's clock, and old phones' clocks are minutes out.
 */
export const NONCE_MEMBERS_MAX = 250_000;
export const NONCE_STRANGERS_MAX = 100_000;
export const NONCE_KEY_MAX = 3_000;
export const NONCE_ADDRESS_MAX = 3_000;
export const NONCE_KEY_MINUTES = 25;

/** A store's shares: each region's ceiling, and an owner's share in each (a member's key, a stranger's address). */
export interface NonceLimits { membersMax: number; strangersMax: number; keyMax: number; addressMax: number }
const NONCE_LIMITS: Readonly<NonceLimits> = Object.freeze({
    membersMax: NONCE_MEMBERS_MAX, strangersMax: NONCE_STRANGERS_MAX, keyMax: NONCE_KEY_MAX, addressMax: NONCE_ADDRESS_MAX,
});

/** A member key's share for the gateway's minute allowance (`maxRequestsPerMinute`): 25 × it, at least NONCE_KEY_MAX. */
export function nonceKeyShare(perMinute: number): number {
    return Number.isFinite(perMinute) ? Math.max(NONCE_KEY_MAX, NONCE_KEY_MINUTES * perMinute) : NONCE_KEY_MAX;
}

export const STORE_FULL_CODE = 'store_full';
/** The members' region is full. */
export const STORE_FULL_ERROR = 'This community is very busy right now. Please try again in a minute.';
/** One member's key is at its own share. */
export const KEY_SHARE_FULL_ERROR = 'Your app has sent more requests than this community holds at once. Please wait a minute and try again.';
/** The strangers' region is full, or one address's share of it. */
export const STRANGERS_FULL_ERROR = 'This community is busy with new visitors right now. Please try again in a minute.';
export const STORE_FULL_RETRY_AFTER_SEC = 60;
/** The security line about a share refused is written at most this often for each scope, never per request (#1807 B1:
 *  under a flood, a write per request is itself the outage). */
const STORE_FULL_LOG_EVERY_MS = 60 * 60_000;
const storeFullLoggedAt: Record<NonceScope, number> = { member: -Infinity, stranger: -Infinity };

/** The refusal for a new nonce `nonces` has no room for, and its scope's security line for the hour if not written yet. */
function roomRefusal(nonces: NonceStore, why: 'owner' | 'region', spender: NonceSpender, signer: string, now: number): SignatureRefusal {
    const scope = spender.scope;
    if (now - storeFullLoggedAt[scope] >= STORE_FULL_LOG_EVERY_MS) {
        storeFullLoggedAt[scope] = now;
        logger.security('AUTH', roomRefusalLine(nonces.pressure()[scope], why, scope, signer));
    }
    const error = scope === 'stranger' ? STRANGERS_FULL_ERROR : why === 'owner' ? KEY_SHARE_FULL_ERROR : STORE_FULL_ERROR;
    return { ok: false, status: 503, error, code: STORE_FULL_CODE, retryAfterSec: STORE_FULL_RETRY_AFTER_SEC, scope, signer };
}

/** The security line: counts, and a member's key by its first 12 characters only (as the gateway's trip line names one). */
function roomRefusalLine(p: RegionPressure, why: 'owner' | 'region', scope: NonceScope, signer: string): string {
    const n = (x: number) => x.toLocaleString('en');
    const store = 'the store of nonces (each signed request\'s single-use number)';
    const busy = `answered busy (503 ${STORE_FULL_CODE}) until older ones expire, within 10 minutes`;
    if (scope === 'stranger') {
        return (why === 'owner'
            ? `Signed requests: one internet address signing with keys that are not members here reached its share of ${store}, ${n(p.share)} in flight, so its new ones are ${busy}.`
            : `Signed requests from keys that are not members here filled their share of ${store}: ${n(p.live)} in flight from ${n(p.owners)} addresses, so their new ones are ${busy}; public reads are answered as unsigned.`)
            + ' Members are not affected. Written at most once an hour for keys that are not members here.';
    }
    return (why === 'owner'
        ? `Signed requests: member ${signer.slice(0, 12)}…'s app reached its share of ${store}, ${n(p.share)} in flight, so its new ones are ${busy}. Other members are not affected.`
        : `Members' signed requests filled their share of ${store}: ${n(p.live)} in flight from ${n(p.owners)} keys, so every member's new one is ${busy}; public reads are answered as unsigned.`)
        + ' A member sees the busy sentence and tries again by hand. Written at most once an hour for members.';
}

/** The nonces of signed requests and `/ws` connect tokens, one store for the process: its refusals are what Alerts reads. */
export const requestNonces = new NonceStore(SIGNATURE_FRESHNESS_MS, {}, requestNoncePressure);

/**
 * The longest nonce a signed request or `/ws` token may carry (AUTH-03, 2026-10-16). Every app sends 32 hex characters
 * (core and native freshNonce) or a 36-character UUID (the old web app). Each spent nonce is held up to ~10 minutes,
 * and one address can spend ~1,800 a minute even with keys that are members of nothing, so a 15 KB nonce let a few
 * addresses hold the whole 512 MB heap. Refused by length, before the signature is checked, never by evicting live
 * nonces (that would re-open replay).
 */
export const MAX_NONCE_LENGTH = 128;
export const BAD_NONCE_CODE = 'bad_nonce';

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

/**
 * `retryAfterSec`: how long to wait before trying again, sent as Retry-After (503 store_full). `scope` and `signer`, on a
 * 503 store_full: whose region it was refused in, and the verified key, so the caller can charge and answer it (a
 * member's to its own gateway bucket, a stranger's /ws token as unsigned).
 */
export type SignatureRefusal = {
    ok: false; status: 400 | 401 | 403 | 421 | 426 | 503; error: string; code?: string; retryAfterSec?: number;
    scope?: NonceScope; signer?: string;
};

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
    /**
     * The client's limiter key (client-ip.ts clientLimiterKey: IPv6 by its /64), whose share a stranger's nonce is spent
     * from. Every caller that spends a nonce passes it; those that don't share one owner, `a:unknown`, so leaving it out
     * can only tighten.
     */
    client?: string;
    /** A member key's share for the gateway's minute allowance now (nonceKeyShare); the store's own when not given. */
    keyMax?: number;
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
 * knows none of its names accepts any host until the switch, and logs and counts it for Settings to offer. A refusal
 * for one of this community's LOST names (engine/own-addresses.ts) is counted too, and asks the watcher to look at the
 * name again: a name that comes back is accepted within seconds of the first refused request.
 */
export function audienceRefusal(host: string, signer: string | null, now = clock()): SignatureRefusal | null {
    const standing = audienceStanding(host);
    if (standing === 'own') return null;
    if (standing === 'unconfigured' && unboundSignaturesAccepted(now)) {
        noteUnconfirmedAudience(host, signer);
        return null;
    }
    noteLostAudience(host, signer);
    return { ok: false, status: 421, error: WRONG_COMMUNITY_ERROR, code: WRONG_COMMUNITY_CODE };
}

let lostRefusedHandler: ((host: string) => void) | null = null;

/**
 * services/registrar-name-watch.ts: told of each refusal for a lost name (it rate-limits its own re-checks). Set on
 * every node; a node that doesn't run the watcher leaves it null.
 */
export function setLostAddressRefusedHandler(h: ((host: string) => void) | null): void {
    lostRefusedHandler = h;
}

/** A refusal for a lost name: counted for Settings ("n apps tried today", members' apps only) and handed to the watcher. */
function noteLostAudience(host: string, signer: string | null): void {
    try {
        if (!isLostAddress(host)) return;
    } catch {
        return; // noting a refusal never changes it
    }
    try {
        if (signer && isNodeMember(db, signer)) countSignature('lost', host, signer);
    } catch { /* a count never changes a refusal */ }
    try {
        lostRefusedHandler?.(host);
    } catch { /* nor does a re-check */ }
}

/** Null while the old format is accepted, the refusal once the switch has passed. */
export function unboundRefusal(now = clock()): SignatureRefusal | null {
    return unboundSignaturesAccepted(now) ? null : { ok: false, status: 426, error: APP_TOO_OLD_ERROR, code: APP_TOO_OLD_CODE };
}

/**
 * Count an accepted signature for Settings: by the host it named, or as an old app's. Only a member's app counts
 * (isNodeMember): a key with no row here costs nothing to make, so strangers' keys could otherwise fill the list of
 * addresses offered to the owner, or raise "N members are on an old app", the number an owner reads to decide whether
 * to move the switch date (4113046943). `member`: isNodeMember already read for this request, when it was.
 */
export function countAcceptedSignature(signer: string, audience: string | null, member?: boolean): void {
    try {
        if (!(member ?? isNodeMember(db, signer))) return;
    } catch {
        return; // a count never refuses a request
    }
    if (audience === null) return void countSignature('old_app', '', signer);
    if (audienceStanding(audience) === 'own') return void countSignature('own', audience, signer);
    countUnconfirmed(audience, signer);
}

/**
 * Whether `signer` acts here, by the gateway's own test (https-server.ts: isNodeMember or isLiveVisitor), and whether it
 * is a member (what countAcceptedSignature counts). A read that fails reads as a stranger: held to its address's share.
 */
function standingHere(signer: string): { member: boolean; acts: boolean } {
    try {
        const member = isNodeMember(db, signer);
        return { member, acts: member || isLiveVisitor(db, signer) };
    } catch {
        return { member: false, acts: false };
    }
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

    if (typeof parts.nonce !== 'string' || parts.nonce.length < 1 || parts.nonce.length > MAX_NONCE_LENGTH) {
        return { ok: false, status: 400, error: `The request nonce must be 1 to ${MAX_NONCE_LENGTH} characters`, code: BAD_NONCE_CODE };
    }

    const fields ={ method: parts.method, path: parts.path, timestamp: parts.timestamp, nonce: parts.nonce, body: parts.body };
    const bound = parts.signedFor !== null;
    const text = bound ? signedRequestText({ host: parts.signedFor as string, ...fields }) : unboundRequestText(fields);
    if (!ed25519Verify(bytesOfSignedText(text), parts.signature, signer, 'base64')) {
        return { ok: false, status: 403, error: 'Invalid cryptographic signature' };
    }

    const audience = bound ? (parts.signedFor as string) : null;
    const refusal = audience !== null ? audienceRefusal(audience, signer) : unboundRefusal();
    if (refusal) return refusal;

    let member: boolean | undefined;
    if (opts.consumeNonce) {
        const nonces = opts.nonces ?? requestNonces;
        // A new nonce needs room in its signer's region: the key's own share when it acts here, else its address's. A
        // spent one is still a replay, never busy.
        let spender: NonceSpender | undefined;
        if (!nonces.isSpent(parts.nonce, now)) {
            const standing = standingHere(signer);
            member = standing.member;
            spender = standing.acts ? { scope: 'member', owner: `k:${signer}` } : { scope: 'stranger', owner: `a:${opts.client ?? 'unknown'}` };
            const why = nonces.room(spender, now, opts.keyMax);
            if (why) return roomRefusal(nonces, why, spender, signer, now);
        }
        if (!nonces.consume(parts.nonce, now, ts, spender)) {
            return { ok: false, status: 403, error: 'Replay detected: nonce already used' };
        }
    }
    countAcceptedSignature(signer, audience, member);
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
 * a node with no configured names was reached at (`unconfirmed`, offered to the owner: engine/address-offers.ts), in
 * the old format (`old_app`, "N members are on an old app"), and for each of this community's LOST names (`lost`: the
 * apps refused there, "n apps tried today"). Members' keys only (countAcceptedSignature), so a
 * stranger's keys move none of them. Counts only, no key is stored: the day's distinct keys are held in memory as
 * salted hashes. A request never writes to the database: the counts are written when Settings reads them and every 15
 * minutes (flushSignatureCounts), each as the most this process has seen that day. After a restart a day's count
 * starts again, so it can read low for that day, never high.
 *
 * For an `unconfirmed` address, two more things, so Settings can show the owner who reached the node at each host
 * before they confirm one (it offers only the host Settings is open at with one tap: engine/address-offers.ts):
 *   - one app puts at most MAX_UNCONFIRMED_HOSTS_PER_KEY addresses on the day's list. A real app reaches a community at
 *     one address (a home-network one is this community's already, never on this list), so one member signing for
 *     many hosts can't fill the day's MAX_ADDRESSES_PER_KIND and crowd out the real one. Held in memory, per day:
 *     after a restart an app may add that many again, and the day's cap still holds. Many members' apps can fill it
 *     between them, so an owner's or admin's app is counted past it (each still at most that many addresses): members
 *     can't crowd out the address the owner's own app reaches the community at;
 *   - whether an owner's or admin's app signed for it (isNodeAdmin: a role that acts; a moderator's app is a member's):
 *     the address and the last day, no key, in node_config row STAFF_SEEN_KEY, written with the counts, so a restart
 *     keeps it. At most MAX_ADDRESSES_PER_KIND addresses; rows older than 8 days are dropped whenever the row is written
 *     or read (staffSeenAddresses), so none older is kept past the next Settings read. The role is the one the signer held
 *     when its app first signed for the address that day: an admin made later counts from the next day it signs for
 *     it, and one removed still counts for the rest of the week.
 */
export type SignatureKind = 'own' | 'unconfirmed' | 'old_app' | 'lost';

/**
 * Bounds on what one day can hold in memory: addresses per kind (past which only an owner's or admin's app adds an
 * `unconfirmed` one, at most MAX_UNCONFIRMED_HOSTS_PER_KEY each), and keys per address.
 */
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

/**
 * Count `signer` for `address` on `day`: whether it is counted there (false when a bound leaves it out). `pastCap`: an
 * owner's or admin's app, counted for a new address even when the day's MAX_ADDRESSES_PER_KIND is reached.
 */
function countSignature(kind: SignatureKind, address: string, signer: string, day = today(Date.now()), pastCap = false): boolean {
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
            if (byAddress.size >= MAX_ADDRESSES_PER_KIND && !pastCap) return false;
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
        // Looked at for this address today already, its role too (counted, or left off a full list): nothing more to do.
        if (mine?.has(address)) return;
        if ((mine?.size ?? 0) >= MAX_UNCONFIRMED_HOSTS_PER_KEY) return;
        if (!mine && byKey.size >= MAX_KEYS_PER_ADDRESS) return;
        if (!mine) {
            mine = new Set();
            byKey.set(h, mine);
        }
        mine.add(address);
        const staff = isNodeAdmin(signer);
        if (!countSignature('unconfirmed', address, signer, day, staff)) return;
        if (staff) {
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

/**
 * How many members' apps signed for any of `addresses`, this community's own names, today and on the busiest day of
 * the last 7 (what memory holds is written first). For Settings' count of apps still on a former name (lost-name L4):
 * each name's own count, summed day by day. An app that used two of them on one day would count twice; a real app
 * reaches a community at one address.
 */
export function ownAddressesUsage(addresses: string[], now = Date.now()): { today: number; busiestDay: number } {
    if (addresses.length === 0) return { today: 0, busiestDay: 0 };
    flushSignatureCounts(now);
    const day = today(now);
    const rows = db.prepare(
        `SELECT day, SUM(people) AS people FROM signature_audiences
         WHERE kind = 'own' AND day >= ? AND address IN (${addresses.map(() => '?').join(', ')}) GROUP BY day`,
    ).all(daysAgo(now, 6), ...addresses) as { day: string; people: number }[];
    let todays = 0, busiest = 0;
    for (const r of rows) {
        const n = Number(r.people) || 0;
        if (r.day === day) todays = n;
        busiest = Math.max(busiest, n);
    }
    return { today: todays, busiestDay: busiest };
}

/** The `unconfirmed` addresses an owner's or admin's app signed for in the last 7 days (what memory holds is written first). */
export function staffSeenAddresses(now = Date.now()): Set<string> {
    flushSignatureCounts(now);
    const from = daysAgo(now, 6);
    const out = new Set<string>();
    try {
        const stored = storedStaffSeen();
        const oldest = daysAgo(now, 8);
        // Nothing new may come for weeks, and only a write prunes: drop what's past 8 days now (writeStaffSeen keeps the
        // rest). A failed prune never hides the sightings: they are read from `stored` either way.
        if ([...stored.values()].some((day) => day < oldest)) {
            try {
                writeStaffSeen(now);
            } catch (e: any) {
                logger.warn('AUTH', `could not prune the addresses owners' and admins' apps used: ${e?.message || e}`);
            }
        }
        for (const [address, day] of stored) if (day >= from) out.add(address);
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
