/**
 * Finding a member's account from their sign-in alone, with nothing typed (scratch design
 * DESIGN-recovery-no-callsign-fable.md §3, slice S0; Marty's decisions of 9 Nov 2026).
 *
 * ## Why
 *
 * A sign-in copy's `sso_lookup_hash` is scrypt of `provider:sub` under a salt random PER ROW (sso.ts ssoLookupHash). A
 * verified sign-in can be checked against one known row, which is the release's proof (engine/recovery-release.ts
 * releaseSsoFragmentForIdentity), but it cannot be looked up: finding it would be one scrypt per row. So a restore had to
 * be told whose account it was, by its exact name.
 *
 * ## The find hash
 *
 * `recovery_shares.sso_find_hash`: HMAC-SHA-256 over `provider|sub`, base64url, under a key derived from the recovery seal's
 * file (services/recovery-seal-key.ts recoverySealSubkey, info `beanpool-recovery-find/v1`), the shape of the open door's
 * join hash (engine/open-join.ts). The key is 32 random bytes kept outside the database, so a stolen database, a snapshot,
 * a plain backup or a standby's disk cannot test a known Google id against it, two communities' tables cannot be matched,
 * and a server with no key cannot find (and could not open the copy anyway). It is written at every deposit beside the
 * lookup hash, from the sub the node has just verified, never from the client (engine/keeper-deposit.ts).
 *
 * It is an index, never a proof: a find names accounts, by name and key, to the holder of a verified sign-in, and nothing
 * is released until the release's own per-row scrypt proof holds for that sign-in.
 *
 * ## Copies made before it, and keys a take-over replaced
 *
 * A copy made before this has no find hash, and its sub is seen again only at a sign-in. So when the index finds nothing,
 * the node scans that provider's current copies with no find hash, one scrypt each on the threadpool, and writes the find
 * hash of every one that matches (stamped, so a delta carries it to a standby). One scan at a time per server; a second
 * caller meanwhile is told to try again in a minute. A main server's boot log counts the copies not yet findable, and the
 * scan goes once live servers count 0 (design §8 S4).
 *
 * A find hash made under a key a take-over replaced (recovery-seal-retired-<id>.key) is looked up too, and written again
 * under the live key: the next take-over bundle carries only the live key, and no scan would reach a row whose find hash
 * is set but made with a key that server does not have.
 *
 * ## The hold
 *
 * A find keeps what it verified (provider, sub, the accounts it named) in memory for {@link FIND_HOLD_TTL_MS}, keyed by the
 * restore's throwaway key, so the collect that follows needs no second sign-in. Never persisted, never replicated, swept
 * as nonces are (sso.ts issueNonce), replaced by that key's next find, and spent by one collect.
 */

import crypto from 'node:crypto';
import { word } from '@beanpool/core';
import { db } from '../db/db.js';
import { ssoLookupHash, type SsoProvider } from '../sso.js';
import { RecoverySealKeyMissing, recoverySealSubkey, retiredRecoverySealSubkeys } from '../services/recovery-seal-key.js';

/** The HKDF info of the find key under data/recovery-seal.key: never any other use's. */
export const FIND_KEY_INFO = 'beanpool-recovery-find/v1';
const FIND_KEY_BYTES = 32;

function findHashUnder(key: Uint8Array, provider: SsoProvider, sub: string): string {
    // The provider comes from a fixed table, so `provider|sub` is unambiguous whatever the sub holds.
    return crypto.createHmac('sha256', key).update(`${provider}|${sub}`, 'utf-8').digest('base64url');
}

/** The find hash of a VERIFIED sign-in, under the live key. Throws {@link RecoverySealKeyMissing} on a server without it. */
export function ssoFindHash(provider: SsoProvider, sub: string): string {
    const key = recoverySealSubkey(FIND_KEY_INFO, FIND_KEY_BYTES);
    if (!key) throw new RecoverySealKeyMissing();
    return findHashUnder(key, provider, sub);
}

/**
 * The accounts a restore here may bring back, as the restore by name has them (routes/recovery-collect.ts resolveCallsign):
 * not migrated or pruned, not a visitor's row, not an enterprise's or a project's.
 */
const RESTORABLE = "m.status NOT IN ('migrated', 'pruned') AND m.is_visitor = 0 AND COALESCE(m.is_treasury, 0) = 0";
/** The owner's current generation: a copy from a superseded one is not a copy. */
const CURRENT = 's.generation = (SELECT MAX(generation) FROM recovery_shares WHERE owner_pubkey = s.owner_pubkey)';
/** A current sign-in copy of a restorable member that the scan can still make findable. */
const UNFINDABLE = `s.holder_type = 'sso' AND s.sso_find_hash IS NULL AND s.sso_lookup_hash IS NOT NULL
    AND s.sso_lookup_salt IS NOT NULL AND ${CURRENT} AND ${RESTORABLE}`;

/** Whether a restore here may bring this key's account back now. */
export function isRestorableMember(publicKey: string): boolean {
    return !!db.prepare(`SELECT 1 FROM members m WHERE m.public_key = ? AND ${RESTORABLE}`).get(publicKey);
}

/** One account a find names: what the restore by name named (its key and name), nothing more. */
export interface FoundAccount {
    publicKey: string;
    callsign: string;
}

/** A second scan while one runs: 503, try again in a minute. */
export class FindBusy extends Error {
    readonly code = 'find_busy';
    constructor() {
        super(word('Busy finding another account. Try again in a minute.'));
        this.name = 'FindBusy';
    }
}

const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const stats = { scans: 0, scrypts: 0, healed: 0 };
let scanning = false;

/** What the scan has done since this process started, and whether one runs now. For tests and the operator's eye. */
export function findScanStats(): { scans: number; scrypts: number; healed: number; scanning: boolean } {
    return { ...stats, scanning };
}

interface Hit { id: number; owner_pubkey: string; callsign: string; sso_find_hash: string | null }

/** By the index: the live key's hash and each retired key's, one indexed read. A retired key's match is written again. */
function findByIndex(provider: SsoProvider, sub: string, live: string): Hit[] {
    const hashes = [live, ...retiredRecoverySealSubkeys(FIND_KEY_INFO, FIND_KEY_BYTES).map((k) => findHashUnder(k, provider, sub))];
    const hits = db.prepare(`
        SELECT s.id, s.owner_pubkey, s.sso_find_hash, m.callsign FROM recovery_shares s
        JOIN members m ON m.public_key = s.owner_pubkey
        WHERE s.sso_find_hash IN (${hashes.map(() => '?').join(', ')}) AND s.holder_type = 'sso' AND s.holder_ref = ?
          AND ${CURRENT} AND ${RESTORABLE}
    `).all(...hashes, provider) as Hit[];
    const relock = db.prepare(`UPDATE recovery_shares SET sso_find_hash = ?, updated_at = ${stamp} WHERE id = ? AND sso_find_hash = ?`);
    for (const h of hits) if (h.sso_find_hash !== live) relock.run(live, h.id, h.sso_find_hash);
    return hits;
}

/**
 * Copies made before the find hash: this provider's current copies with none, each checked with its own salt (scrypt, on
 * the threadpool), every match made findable. Throws {@link FindBusy} while another scan runs. Nothing to scan takes no turn.
 */
async function scanUnfindable(provider: SsoProvider, sub: string, live: string): Promise<Hit[]> {
    const rows = db.prepare(`
        SELECT s.id, s.owner_pubkey, s.sso_lookup_hash, s.sso_lookup_salt, m.callsign FROM recovery_shares s
        JOIN members m ON m.public_key = s.owner_pubkey
        WHERE s.holder_ref = ? AND ${UNFINDABLE}
        ORDER BY s.id
    `).all(provider) as { id: number; owner_pubkey: string; sso_lookup_hash: string; sso_lookup_salt: string; callsign: string }[];
    if (rows.length === 0) return [];
    if (scanning) throw new FindBusy();
    scanning = true;
    stats.scans++;
    try {
        const heal = db.prepare(`UPDATE recovery_shares SET sso_find_hash = ?, updated_at = ${stamp}
                                 WHERE id = ? AND sso_find_hash IS NULL AND sso_lookup_hash = ?`);
        const found: Hit[] = [];
        for (const r of rows) {
            const derived = Buffer.from(await ssoLookupHash(provider, sub, r.sso_lookup_salt), 'utf-8');
            stats.scrypts++;
            const stored = Buffer.from(r.sso_lookup_hash, 'utf-8');
            if (derived.length !== stored.length || !crypto.timingSafeEqual(derived, stored)) continue;
            // Only while it is still the copy that was read: one replaced during the scan is found at the next restore.
            if (heal.run(live, r.id, r.sso_lookup_hash).changes === 0) continue;
            stats.healed++;
            found.push({ id: r.id, owner_pubkey: r.owner_pubkey, callsign: r.callsign, sso_find_hash: live });
        }
        return found;
    } finally {
        scanning = false;
    }
}

/**
 * Every account this verified sign-in protects here: by the index, else by the scan of copies made before it. `sub` must be
 * from a sign-in this node verified in the same request (sso.ts verifySignIn). Several accounts are each named, by name
 * and key, in name order. Throws {@link RecoverySealKeyMissing} without the key, and {@link FindBusy}.
 */
export async function findAccountsBySignIn(provider: SsoProvider, sub: string): Promise<FoundAccount[]> {
    if (!sub) return [];
    const live = ssoFindHash(provider, sub);
    let hits = findByIndex(provider, sub, live);
    if (hits.length === 0) hits = await scanUnfindable(provider, sub, live);
    // One copy per provider per owner in a generation (the table's UNIQUE), so one entry per account.
    return hits.map((h) => ({ publicKey: h.owner_pubkey, callsign: h.callsign }))
        .sort((a, b) => a.callsign.localeCompare(b.callsign) || a.publicKey.localeCompare(b.publicKey));
}

/** How many current sign-in copies of restorable members no restore can find by the index yet: the boot log's count. */
export function countUnfindableSignInCopies(): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM recovery_shares s JOIN members m ON m.public_key = s.owner_pubkey WHERE ${UNFINDABLE}`)
        .get() as { n: number }).n;
}

let countedAs: 'main' | 'standby' | null = null;

/**
 * At boot, on a main server: one line with {@link countUnfindableSignInCopies}, 0 included, which says when the scan can
 * go. A standby finds nothing (its routes refuse) and says nothing. Called from initStateEngine and again once the role is
 * final (index.ts, after a take-over); does nothing when the role did not change. Never throws.
 */
export function noteUnfindableSignInCopiesAtBoot(opts: { standby: boolean }): void {
    const as = opts.standby ? 'standby' : 'main';
    if (countedAs === as) return;
    countedAs = as;
    if (opts.standby) return;
    try {
        const n = countUnfindableSignInCopies();
        console.log(`🔐 Recovery find: ${n} sign-in cop${n === 1 ? 'y' : 'ies'} not yet findable by sign-in `
            + '(each is found by a scan, and made findable, at its member\'s first restore).');
    } catch (e) {
        console.warn(`⚠️ Recovery find: could not count the sign-in copies not yet findable: ${(e as Error)?.message || e}`);
    }
}

// ── the hold ──────────────────────────────────────────────────────────────────────────────────────

/** How long a find's verified sign-in is held for the collect that follows it. */
export const FIND_HOLD_TTL_MS = 5 * 60 * 1000;

/** What a find verified, held for its collect. The sub stays in memory, as a verification's does, and is never logged. */
export interface FindHold {
    provider: SsoProvider;
    sub: string;
    accounts: FoundAccount[];
    expiresAt: number;
}

const holds = new Map<string, FindHold>();
let lastHoldSweep = 0;

/**
 * Hold a find for the throwaway key that signed it, in place of any it held before. A find that named nobody holds
 * nothing, and ends the older one too: the hold is always that key's latest sign-in.
 */
export function holdFind(throwawayKey: string, provider: SsoProvider, sub: string, accounts: FoundAccount[]): void {
    const now = Date.now();
    // The nonces' throttled sweep (sso.ts issueNonce): the map holds at most the last few minutes of finds.
    if (holds.size > 1000 && now - lastHoldSweep > 60_000) {
        lastHoldSweep = now;
        for (const [k, h] of holds) if (h.expiresAt <= now) holds.delete(k);
    }
    if (accounts.length === 0) { holds.delete(throwawayKey); return; }
    holds.set(throwawayKey, { provider, sub, accounts, expiresAt: now + FIND_HOLD_TTL_MS });
}

/**
 * The live hold of this throwaway key, when its find named `publicKey`: taken, so one collect spends it, success or not.
 * Null, and nothing taken, for no hold or an account the find did not name; an expired hold is dropped.
 */
export function takeFindHold(throwawayKey: string, publicKey: string): FindHold | null {
    const h = holds.get(throwawayKey);
    if (!h) return null;
    if (h.expiresAt <= Date.now()) { holds.delete(throwawayKey); return null; }
    if (!h.accounts.some((a) => a.publicKey === publicKey)) return null;
    holds.delete(throwawayKey);
    return h;
}

/** Tests: move a hold's clock on by `byMs`, as if its find were that much older. False when the key holds none. */
export function _ageFindHoldForTests(throwawayKey: string, byMs: number): boolean {
    const h = holds.get(throwawayKey);
    if (!h) return false;
    h.expiresAt -= byMs;
    return true;
}
