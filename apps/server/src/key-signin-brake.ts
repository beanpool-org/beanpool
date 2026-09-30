/**
 * The brake on guessing the node's 2FA code at key sign-in: the app's Manage link (verify-challenge) and the Settings
 * sign-in by QR (settings-signin-pairing.ts), both through admin-key-auth.ts authorizeKeySigner.
 *
 * Key sign-in asks for the code only once the key has signed, so only someone holding an owner's, admin's or moderator's
 * key ever reaches it: exactly the case 2FA is for, a key in the wrong hands. Until 2026-10-01 nothing counted a wrong
 * code there (Fable's security review, MEDIUM 2): 200 wrong codes on one challenge took 401 ms, and the right one then
 * worked. A 6-digit code with a ±1 step window is 3 valid codes in 10^6, so about 333,000 guesses: some 18 hours at the
 * 300-a-minute admin limiter from one address, and never noticed.
 *
 * Counted per key AND per address (client-ip.ts clientLimiterKey), with the password brake's numbers
 * (password-brake.ts): SOURCE_FREE_FAILURES wrong codes free, then each further one closes that key and that address for
 * 2 s, 4 s, 8 s … up to an hour. A closed key or address is answered 429 with Retry-After, and its code is not checked.
 * A right code clears both records; so does a day with no wrong code. Per key, a thief with the key gets about 16 guesses
 * in the first hour and one an hour after, from any number of addresses. The challenge itself is burned after
 * CHALLENGE_MAX_WRONG_CODES wrong codes (admin-key-auth.ts), and a pairing after its own few refusals, as before.
 *
 * Records of its own, not the password brake's. That brake's promise is that key sign-in is the way in while the
 * password is under attack (docs/admin-surface.md §2.6), so wrong passwords must not close it, and a wrong code here must
 * not close the password. Nothing here moves without a key: the code is looked at only after the signature verifies, so
 * a stranger can charge neither an owner's key nor their address. A thief who holds a key does close that key for its
 * owner too; the owner's ways in are then the password, another owner's key, or a new key (and the stolen one revoked).
 */
import { SOURCE_FREE_FAILURES, BASE_DELAY_MS, MAX_DELAY_MS, FORGET_MS, SHARED_SOURCE_MAX_DELAY_MS } from './password-brake.js';
import { isSharedSourceKey } from './client-ip.js';
import { logger } from './logger.js';
import { logAddressTag } from './log-address.js';

/** Wrong codes one challenge takes before it is burned and a new one is needed. */
export const CHALLENGE_MAX_WRONG_CODES = 5;
/** Bound on remembered keys and addresses each; the stalest is dropped first, and a dropped one is just clean again. */
export const MAX_RECORDS = 100_000;

interface BrakeRecord { failures: number; lastFailureAt: number; closedUntil: number }

const byKey = new Map<string, BrakeRecord>();
const byAddress = new Map<string, BrakeRecord>();

function live(map: Map<string, BrakeRecord>, id: string, now: number): BrakeRecord | undefined {
    const r = map.get(id);
    if (r && now - r.lastFailureAt > FORGET_MS && now >= r.closedUntil) {
        map.delete(id);
        return undefined;
    }
    return r;
}

/**
 * Whether a code from `memberPubkey` at `address` may be checked now. When not, how long until it may, in seconds.
 * `address` is absent for a caller with no request (tests); then only the key is counted.
 */
export function keySigninBraked(memberPubkey: string, address: string | undefined, now = Date.now()): { braked: false } | { braked: true; retryAfter: number } {
    const until = Math.max(
        live(byKey, memberPubkey, now)?.closedUntil ?? 0,
        address ? live(byAddress, address, now)?.closedUntil ?? 0 : 0,
    );
    return now < until ? { braked: true, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) } : { braked: false };
}

/**
 * `maxDelay`: an address that is really a proxy for everyone (client-ip.ts isSharedSourceKey) waits at most
 * SHARED_SOURCE_MAX_DELAY_MS, as in the password brake: every admin behind it shares its record.
 */
function charge(map: Map<string, BrakeRecord>, id: string, now: number, maxDelay = MAX_DELAY_MS): BrakeRecord {
    const r = live(map, id, now) ?? { failures: 0, lastFailureAt: 0, closedUntil: 0 };
    r.failures++;
    r.lastFailureAt = now;
    const over = r.failures - SOURCE_FREE_FAILURES;
    if (over > 0) r.closedUntil = Math.min(Math.max(r.closedUntil, now + Math.min(BASE_DELAY_MS * 2 ** Math.min(over - 1, 30), maxDelay)), now + maxDelay);
    // In order of last failure, stalest first, so a full map drops from the front.
    map.delete(id);
    map.set(id, r);
    if (map.size > MAX_RECORDS) map.delete(map.keys().next().value!);
    return r;
}

/** A wrong code (or backup code) from `memberPubkey` at `address`: counted against both, and logged. */
export function noteKeySigninFailure(memberPubkey: string, address: string | undefined, who: string, now = Date.now()): void {
    const k = charge(byKey, memberPubkey, now);
    const a = address ? charge(byAddress, address, now, isSharedSourceKey(address, now) ? SHARED_SOURCE_MAX_DELAY_MS : MAX_DELAY_MS) : undefined;
    const from = address ? ` from ${logAddressTag(address)}` : '';
    try {
        logger.security('AUTH', `Key sign-in: wrong 2FA code for ${who}${from} (${k.failures} for this key in the last day)`);
        if (k.failures === SOURCE_FREE_FAILURES + 1) {
            logger.security('AUTH', `[key-signin-brake] ${k.failures} wrong 2FA codes at key sign-in for ${who}: if that was not its owner, the key is in someone else's hands. It now backs off (up to ${MAX_DELAY_MS / 60_000} min between codes); revoke it and enrol a new one.`);
        }
        if (a && a.failures === SOURCE_FREE_FAILURES + 1) {
            logger.security('AUTH', `[key-signin-brake] ${a.failures} wrong 2FA codes at key sign-in${from} (the address, hashed with a key that changes daily); that address now backs off.`);
        }
    } catch { /* logging never blocks auth */ }
}

/** A right code from `memberPubkey` at `address`: both records are cleared. */
export function noteKeySigninSuccess(memberPubkey: string, address: string | undefined): void {
    byKey.delete(memberPubkey);
    if (address) byAddress.delete(address);
}

/** Tests only. */
export function resetKeySigninBrake(): void {
    byKey.clear();
    byAddress.clear();
}
