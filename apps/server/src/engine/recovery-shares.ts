// Keyholder fragments — storage for the split defined in @beanpool/core `recovery-split`.
//
// The node holds every member's encrypted fragments and hands them back one at a time to
// whoever proves they are entitled to one. It never holds the phrase, and it cannot assemble
// one: member fragments are ECDH-wrapped to their keeper's account key, which the node does not
// have. The two it CAN read are its own hub fragment and the sign-in fragment — two, against a
// threshold of three. The gap is one human keeper, deliberately, and it is why K1 is recorded
// here but never uploaded.
//
// ## Generations are the whole design
//
// A keeper who is removed still physically holds the fragment they were given. Deleting their
// row changes nothing about that; the bytes are on their device. The only way to actually
// revoke a fragment is to make it useless, which is what a re-split does — fragments from
// different splits describe different polynomials, so mixing them yields noise rather than a
// phrase (and `combineRecoveryPhrase` rejects it outright).
//
// So every write here is a whole generation, never a single row, and collection only ever
// serves the current one. That makes the two dangerous states unreachable rather than merely
// unlikely: a member can never be left holding fewer fragments than the threshold, and a
// stale fragment can never be combined with fresh ones.
//
// ## Every row is wrapped with the node's key, here and nowhere else
//
// The insert wraps each copy with the key kept outside the database (services/recovery-seal-key.ts) and every
// read unwraps it, so everything above this file sees the client's bytes exactly as they were sent, every check
// below runs on those bytes, and the database, a copy of it, a snapshot and a standby hold only wrapped rows.


import { db } from '../db/db.js';
import { isSingleBlobSso } from '@beanpool/core';
import {
    NODE_WRAP_ALG,
    RecoverySealKeyMissing,
    RecoverySealUnopenable,
    isNodeWrapped,
    openRecoveryFields,
    sealRecoveryFields,
    shareRowAad,
} from '../services/recovery-seal-key.js';

/** Who holds a fragment. Mirrors the CHECK constraint on `recovery_shares.holder_type`. */
export type KeeperType = 'hub' | 'member' | 'sso';

/** One fragment as the client uploads it, already encrypted to its keeper. */
export interface KeeperShareInput {
    holderType: KeeperType;
    /** member pubkey | provider name | 'self' */
    holderRef: string;
    /**
     * The fragment's Shamir x-coordinate, needed to recombine.
     *
     * Recorded even for `device`, whose bytes the node never sees: the x-coordinate is not secret
     * (a coordinate without its value is nothing) and having it lets the restore screen say which
     * piece is still missing rather than only how many.
     */
    shareIndex: number;
    /**
     * The wrapped fragment.
     *
     * EMPTY for `device` keepers, and required to be — K1's bytes live in the phone's own backup
     * and nowhere else. See the K1 note in putShareGeneration for why the node holding a copy
     * would matter.
     */
    encryptedShare: string;
    shareIv: string;
    shareTag: string;
    /** X25519 ephemeral public key — 'member' holders only. */
    ephemeralPubkey?: string | null;
    /** SHA-256(sub || salt) — 'sso' holders only. The raw provider id is never stored. */
    ssoLookupHash?: string | null;
    ssoLookupSalt?: string | null;
    kdfParams?: string | null;
}

/** A stored fragment, as served back to a keeper during collection. */
export interface StoredKeeperShare extends KeeperShareInput {
    id: number;
    ownerPubkey: string;
    generation: number;
    createdAt: string;
}

/**
 * What the restore screen is allowed to know before anyone has proven anything.
 *
 * Types and a count, never identities: `GET /api/recovery/keepers/:callsign` is public, and
 * answering it with keeper pubkeys would turn a callsign into a map of who trusts whom — a
 * social graph handed out to anyone who asks, on an endpoint that exists so a frightened user
 * can see how to get back in.
 */
export interface KeeperSummary {
    holderType: KeeperType;
    count: number;
}

export class RecoveryShareError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RecoveryShareError';
    }
}

/** The generation currently in force, or 0 if this member has never been split. */
export function getCurrentGeneration(ownerPubkey: string): number {
    const row = db.prepare(
        'SELECT MAX(generation) AS gen FROM recovery_shares WHERE owner_pubkey = ?'
    ).get(ownerPubkey) as { gen: number | null } | undefined;
    return row?.gen ?? 0;
}

/**
 * Replace a member's fragments with a fresh generation, atomically.
 *
 * This is the only writer. An initial split, adding a keeper, removing one, and rotating after
 * a keeper's key changed are all the same operation — upload the full new set — which is what
 * keeps "how many fragments does this member have" answerable at every instant.
 *
 * The old generation is dropped in the same transaction that writes the new one. Doing it in
 * one statement pair rather than two calls matters: a crash between them would otherwise leave
 * a member with two half-generations and no way to tell which was current.
 *
 * @returns the generation number now in force
 * @throws {RecoveryShareError} if the batch could not be recombined by its own owner
 */
export function putShareGeneration(ownerPubkey: string, shares: KeeperShareInput[]): number {
    const isSingleSso = Array.isArray(shares) && shares.length === 1 &&
        shares[0]?.holderType === 'sso' && isSingleBlobSso(shares[0]?.kdfParams);
    if (!Array.isArray(shares) || (!isSingleSso && shares.length < 2)) {
        // Accepting this would store a set that can never be recombined — a silent, total loss
        // that only surfaces when the member actually needs to recover.
        throw new RecoveryShareError(
            `A recovery split needs at least 2 fragments, got ${shares?.length ?? 0}.`
        );
    }

    /**
     * Every keeper type that exists. This is an ERROR-QUALITY guard, not a security one.
     *
     * Review raised that `'Member'` or a stray type could slip past the human-keeper count and
     * reopen R1. It cannot, and it could not before this existed: the route rejects anything
     * outside this list, and `recovery_shares` carries
     * `CHECK (holder_type IN ('hub','member','sso'))`, so the database refuses it too.
     * What this adds is a sentence instead of `SQLITE_CONSTRAINT_CHECK`, raised before the
     * transaction opens rather than inside it.
     *
     * What was NOT taken from the review is normalising with `.toLowerCase().trim()`. The release
     * path, the singleton rule and every query compare `holder_type` exactly, so normalising here
     * alone would let `'Member'` count as a human keeper while matching nothing anywhere else —
     * a predicate that means one thing in one place and another elsewhere, which this codebase
     * has already been bitten by once.
     */
    const KNOWN_TYPES = new Set<KeeperType>(['hub', 'member', 'sso']);

    /** Keeper types there can only be one of. A member has many buddies but one phone and one hub. */
    const SINGLETON_TYPES = new Set<KeeperType>(['hub']);

    const holders = new Set<string>();
    const indices = new Set<number>();
    const singletons = new Map<KeeperType, string>();
    for (const s of shares) {
        if (!KNOWN_TYPES.has(s.holderType)) {
            throw new RecoveryShareError(
                `Unknown keeper type '${String(s.holderType)}'. Expected one of: `
                + `${[...KNOWN_TYPES].join(', ')}.`,
            );
        }
        const holderKey = `${s.holderType}:${s.holderRef}`;
        if (holders.has(holderKey)) {
            throw new RecoveryShareError(`Duplicate keeper in one generation: ${holderKey}.`);
        }
        holders.add(holderKey);

        if (!Number.isInteger(s.shareIndex) || s.shareIndex < 1 || s.shareIndex > 255) {
            throw new RecoveryShareError(
                `Fragment for ${holderKey} has an out-of-range share index ${s.shareIndex}.`
            );
        }
        if (indices.has(s.shareIndex)) {
            // Two fragments at the same x-coordinate are one fragment as far as recombination
            // is concerned, so a set that looks like 3 would really be 2 — below threshold, and
            // undetectable until recovery. The library rejects it too; catching it on the way
            // in means the member never gets stored in that state.
            throw new RecoveryShareError(
                `Two fragments share the x-coordinate ${s.shareIndex}; they could not be recombined.`
            );
        }
        indices.add(s.shareIndex);

        // Machine keepers are SINGLETONS (CR on #224).
        //
        // There is one hub per split, so `hub` may appear at most once
        // in a generation. The UNIQUE constraint does not say this: it is on (owner, generation,
        // holder_type, holder_ref), so two hub fragments under different refs are perfectly legal
        // to it, and the release path — which asks for "the" hub fragment — then cannot resolve
        // which. That is a permanently unreleasable hub keeper for that member: D7 broken for one
        // account, surfacing as a confused support case rather than a test failure.
        //
        // The constraint is on the COUNT, not on the name. `holder_ref` is decorative for a
        // machine keeper (the schema's vocabulary is "member pubkey | provider name | 'self'", and
        // #214's own fixtures use 'self' for both), so pinning a magic string would have broken
        // existing data to enforce a convention that was never agreed. Release looks these up by
        // holder_type for the same reason.
        if (SINGLETON_TYPES.has(s.holderType)) {
            if (singletons.has(s.holderType)) {
                throw new RecoveryShareError(
                    `A split may have only one ${s.holderType} fragment, and this one has two `
                    + `('${singletons.get(s.holderType)}' and '${s.holderRef}'). Which of them is `
                    + `the real ${s.holderType} could not be answered at recovery time.`,
                );
            }
            singletons.set(s.holderType, s.holderRef);
        }
        if (s.holderType === 'sso' && !s.ssoLookupHash) {
            throw new RecoveryShareError('A sign-in fragment needs an sso_lookup_hash to be findable.');
        }
        // The node's own wrap is told from a client's copy by this scheme name alone, so no client copy may carry it:
        // the boot migration would take such a row for one already wrapped, and every read would refuse it.
        if (isNodeWrapped(s.kdfParams)) {
            throw new RecoveryShareError(
                `Fragment for ${holderKey} names the node's own wrap ('${NODE_WRAP_ALG}') as its scheme.`,
            );
        }
        if (s.holderType === 'sso' && isSingleBlobSso(s.kdfParams)) {
            let parsedKdf: Record<string, unknown> | null = null;
            try {
                parsedKdf = JSON.parse(s.kdfParams ?? '');
            } catch {}
            if (!parsedKdf || typeof parsedKdf.salt !== 'string' || !parsedKdf.salt.trim()) {
                throw new RecoveryShareError(
                    `Single-blob sign-in fragment for ${holderKey} must include a valid non-empty salt.`,
                );
            }
            if (!s.shareIv || typeof s.shareIv !== 'string' || Buffer.from(s.shareIv, 'base64').length !== 24) {
                throw new RecoveryShareError(
                    `Single-blob sign-in fragment for ${holderKey} has invalid IV length (must be 24 bytes).`,
                );
            }
            if (!s.shareTag || typeof s.shareTag !== 'string' || Buffer.from(s.shareTag, 'base64').length !== 16) {
                throw new RecoveryShareError(
                    `Single-blob sign-in fragment for ${holderKey} has invalid tag length (must be 16 bytes).`,
                );
            }
            if (!s.encryptedShare || typeof s.encryptedShare !== 'string' || Buffer.from(s.encryptedShare, 'base64').length !== 32) {
                throw new RecoveryShareError(
                    `Single-blob sign-in fragment for ${holderKey} has invalid seed length (must be 32 bytes).`,
                );
            }
        }
        if (s.holderType === 'member' && !s.ephemeralPubkey) {
            throw new RecoveryShareError(
                `Fragment for member ${s.holderRef} has no ephemeral public key; its keeper could never unwrap it.`
            );
        }
    }

    const hasLegacySso = shares.some(s => s.holderType === 'sso' && !isSingleBlobSso(s.kdfParams));
    const hasHub = shares.some(s => s.holderType === 'hub');
    if (hasLegacySso && !hasHub) {
        throw new RecoveryShareError(
            'A recovery generation containing a legacy sign-in fragment must include a hub fragment.',
        );
    }

    // MAX_HUMAN_KEEPERS logic was removed here: retired with the two-layer model; see docs/recovery-model.md.
    // The structural guarantee is now provided by the two-layer A⊕B shape rather than a share-count cap.

    const insert = db.prepare(`
        INSERT INTO recovery_shares (
            owner_pubkey, holder_type, holder_ref, share_index,
            encrypted_share, share_iv, share_tag,
            ephemeral_pubkey, sso_lookup_hash, sso_lookup_salt, kdf_params, generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const dropOlder = db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ? AND generation < ?');

    // Wrapped with the node's key once every check above has passed on the client's own bytes, and before the
    // transaction opens: a server without its key refuses here (RecoverySealKeyMissing), and nothing is stored,
    // wrapped or not.
    const sealed = shares.map(s => sealRecoveryFields(
        { encryptedShare: s.encryptedShare, shareIv: s.shareIv, shareTag: s.shareTag, kdfParams: s.kdfParams ?? null },
        shareRowAad(ownerPubkey, s.holderType),
    ));

    // The generation is read INSIDE the transaction, so the read-modify-write is atomic.
    //
    // Today's driver is synchronous and the server is one process, so nothing can interleave
    // between a read out here and the write below — the hazard is latent rather than live. It is
    // moved in anyway because the cost is nothing and the failure it prevents is unrecoverable:
    // two re-splits landing on the same generation number would mix fragments from two different
    // polynomials into one set, and a member whose fragments are drawn from two splits cannot
    // rebuild their phrase from any combination of them. That is a silent, permanent loss of the
    // account, discovered only at recovery.
    //
    // Keeping it correct under concurrency also means a later async refactor, a second process,
    // or WAL-mode readers cannot quietly reintroduce it.
    const write = db.transaction(() => {
        const row = db.prepare(
            'SELECT MAX(generation) AS gen FROM recovery_shares WHERE owner_pubkey = ?'
        ).get(ownerPubkey) as { gen: number | null } | undefined;
        const nextGeneration = (row?.gen ?? 0) + 1;

        dropOlder.run(ownerPubkey, nextGeneration);
        shares.forEach((s, i) => {
            insert.run(
                ownerPubkey, s.holderType, s.holderRef, s.shareIndex,
                sealed[i].encryptedShare, sealed[i].shareIv, sealed[i].shareTag,
                s.ephemeralPubkey ?? null, s.ssoLookupHash ?? null,
                s.ssoLookupSalt ?? null, sealed[i].kdfParams, nextGeneration,
            );
        });
        return nextGeneration;
    });

    return write();
}

/**
 * A stored row as the client deposited it: unwrapped with the node's key. Throws RecoverySealKeyMissing on a server
 * without its key and RecoverySealUnopenable for a row that key does not open. A row stored before the wrap reads as
 * it is until the boot migration wraps it.
 */
function rowToShare(r: Record<string, unknown>): StoredKeeperShare {
    const copy = openRecoveryFields(
        {
            encryptedShare: r.encrypted_share as string,
            shareIv: r.share_iv as string,
            shareTag: r.share_tag as string,
            kdfParams: (r.kdf_params as string | null) ?? null,
        },
        shareRowAad(r.owner_pubkey as string, r.holder_type as string),
    );
    return {
        id: r.id as number,
        ownerPubkey: r.owner_pubkey as string,
        holderType: r.holder_type as KeeperType,
        holderRef: r.holder_ref as string,
        shareIndex: r.share_index as number,
        encryptedShare: copy.encryptedShare,
        shareIv: copy.shareIv,
        shareTag: copy.shareTag,
        ephemeralPubkey: (r.ephemeral_pubkey as string | null) ?? null,
        ssoLookupHash: (r.sso_lookup_hash as string | null) ?? null,
        ssoLookupSalt: (r.sso_lookup_salt as string | null) ?? null,
        kdfParams: copy.kdfParams ?? null,
        generation: r.generation as number,
        createdAt: r.created_at as string,
    };
}

/** The same reader, for the release path's own queries (engine/recovery-release.ts). */
export const openShareRow = rowToShare;

/** Every fragment of the current generation. Server-internal — this is the whole secret. */
export function getCurrentShares(ownerPubkey: string): StoredKeeperShare[] {
    const generation = getCurrentGeneration(ownerPubkey);
    if (generation === 0) return [];
    const rows = db.prepare(
        'SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND generation = ? ORDER BY id'
    ).all(ownerPubkey, generation) as Record<string, unknown>[];
    return rows.map(rowToShare);
}

/**
 * The current generation as a NEW one is built from it (a deposit's carry-forward): every row this server's key opens.
 *
 * A row locked with a key this server does not have (a server restored from a plain backup, or promoted from a
 * standby before the take-over carries the key) cannot go into a new generation, and refusing the deposit over it
 * would leave the member unable ever to connect a sign-in again. So it is left out, which the new generation then
 * drops, and the log says how many. A server with no key at all still refuses (RecoverySealKeyMissing).
 */
export function getCurrentSharesToCarry(ownerPubkey: string): StoredKeeperShare[] {
    const generation = getCurrentGeneration(ownerPubkey);
    if (generation === 0) return [];
    const rows = db.prepare(
        'SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND generation = ? ORDER BY id'
    ).all(ownerPubkey, generation) as Record<string, unknown>[];
    const carried: StoredKeeperShare[] = [];
    let left = 0;
    for (const r of rows) {
        try {
            carried.push(rowToShare(r));
        } catch (e) {
            if (!(e instanceof RecoverySealUnopenable)) throw e;
            left++;
        }
    }
    if (left) {
        console.warn(`[RecoverySeal] ${left} recovery cop${left === 1 ? 'y' : 'ies'} locked with another key could not be `
            + 'carried into a member\'s new generation and will be dropped with the old one.');
    }
    return carried;
}

/** How many fragments the member currently has out. */
export function countCurrentShares(ownerPubkey: string): number {
    const generation = getCurrentGeneration(ownerPubkey);
    if (generation === 0) return 0;
    const row = db.prepare(
        'SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ? AND generation = ?'
    ).get(ownerPubkey, generation) as { n: number };
    return row.n;
}

/**
 * Keeper types and counts, with no identities — the public restore screen's whole view.
 * See {@link KeeperSummary} for why this is deliberately less than the caller could use.
 */
export function listKeeperTypes(ownerPubkey: string): KeeperSummary[] {
    const generation = getCurrentGeneration(ownerPubkey);
    if (generation === 0) return [];
    return db.prepare(`
        SELECT holder_type AS holderType, COUNT(*) AS count
        FROM recovery_shares
        WHERE owner_pubkey = ? AND generation = ?
        GROUP BY holder_type
        ORDER BY holder_type
    `).all(ownerPubkey, generation) as KeeperSummary[];
}

/**
 * One keeper's fragment, current generation only.
 *
 * Returning nothing for a superseded generation is the point rather than an edge case: a
 * removed keeper's old row is already gone, and a keeper who kept a cached copy from before a
 * re-split gets no fresh partner to combine it with.
 */
export function getShareForHolder(
    ownerPubkey: string,
    holderType: KeeperType,
    holderRef: string,
): StoredKeeperShare | null {
    const generation = getCurrentGeneration(ownerPubkey);
    if (generation === 0) return null;
    const row = db.prepare(`
        SELECT * FROM recovery_shares
        WHERE owner_pubkey = ? AND holder_type = ? AND holder_ref = ? AND generation = ?
    `).get(ownerPubkey, holderType, holderRef, generation) as Record<string, unknown> | undefined;
    return row ? rowToShare(row) : null;
}

/**
 * The sign-in fragment matching a provider subject hash.
 *
 * Looked up by hash because the raw provider id is never stored, so a stolen database cannot
 * even enumerate which accounts are in use. Scoped to the current generation like every other
 * read; a hit from a superseded one is not a hit.
 */
export function findShareBySsoLookup(ssoLookupHash: string): StoredKeeperShare | null {
    const row = db.prepare(`
        SELECT s.* FROM recovery_shares s
        WHERE s.sso_lookup_hash = ?
          AND s.generation = (
              SELECT MAX(generation) FROM recovery_shares WHERE owner_pubkey = s.owner_pubkey
          )
    `).get(ssoLookupHash) as Record<string, unknown> | undefined;
    return row ? rowToShare(row) : null;
}

/**
 * Whether a keeper could be dropped without leaving the member unable to recover.
 *
 * Answering this is all the server can honestly do about removal. It cannot *revoke* anything
 * — the departing keeper still has their bytes — so a bare delete would take a member from
 * "protected by 4" to "protected by 3, one of whom is someone they just removed". Removal is
 * therefore a client-side re-split uploaded through {@link putShareGeneration}, and this exists
 * so the caller can refuse the request before the user believes it worked.
 */
export function canRemoveKeeper(ownerPubkey: string): boolean {
    const shares = getCurrentShares(ownerPubkey);
    if (shares.length === 0) return false;
    const ssoShares = shares.filter(s => s.holderType === 'sso');
    const isSingle = ssoShares.some(s => isSingleBlobSso(s.kdfParams));
    if (isSingle) {
        // A single-blob account with an orphaned hub has shares.length = 2, but only ONE
        // connected provider. The hub cannot recover the account alone, so having 1 provider
        // means 0 can be removed.
        const legacySso = ssoShares.some(s => !isSingleBlobSso(s.kdfParams));
        const hasHub = shares.some(s => s.holderType === 'hub');
        if (legacySso && hasHub) {
            // Mixed account: single-blob provider(s) and legacy provider(s) with hub.
            // Can remove if more than one provider is enrolled.
            return ssoShares.length > 1;
        }
        // Pure single-blob (any hub is orphaned): only count actual single-blob SSO providers.
        const singleSsoCount = ssoShares.filter(s => isSingleBlobSso(s.kdfParams)).length;
        return singleSsoCount > 1;
    }
    // Legacy account: hub + shares against threshold 2
    return shares.length > 2;
}

/**
 * Drop every fragment a member has.
 *
 * For account deletion and pruning. Not a keeper-removal path — see {@link canRemoveKeeper}.
 */
export function deleteAllShares(ownerPubkey: string): number {
    const r = db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ?').run(ownerPubkey);
    return r.changes;
}

/**
 * A member moved to a new key (the re-key wizard, engine/member-wizards.ts): the rows they own belong to the new key,
 * and the rows where they are the keeper name it. The owner is part of what a wrapped row is bound to, so each wrapped
 * row they own is opened under the old key and wrapped again under the new one; a keeper ref is not, so those rows are
 * only renamed. A row this server cannot open (no key, or another key's) moves as it is: it did not open here before
 * the move either, and the move must not wait on it. Runs inside the caller's transaction; stamps nothing, as the two
 * UPDATEs it replaces did not.
 */
export function moveRecoverySharesToNewKey(oldPubkey: string, newPubkey: string): void {
    const rows = db.prepare(`
        SELECT * FROM recovery_shares
        WHERE owner_pubkey = ? OR (holder_type = 'member' AND holder_ref = ?)
    `).all(oldPubkey, oldPubkey) as Record<string, unknown>[];
    const move = db.prepare(`
        UPDATE recovery_shares
        SET owner_pubkey = ?, holder_ref = ?, encrypted_share = ?, share_iv = ?, share_tag = ?, kdf_params = ?
        WHERE id = ?
    `);
    let stranded = 0;
    for (const r of rows) {
        const holderType = r.holder_type as string;
        const owner = r.owner_pubkey === oldPubkey ? newPubkey : r.owner_pubkey as string;
        const ref = holderType === 'member' && r.holder_ref === oldPubkey ? newPubkey : r.holder_ref as string;
        let fields = {
            encryptedShare: r.encrypted_share as string,
            shareIv: r.share_iv as string,
            shareTag: r.share_tag as string,
            kdfParams: (r.kdf_params as string | null) ?? null,
        };
        if (owner !== r.owner_pubkey && isNodeWrapped(fields.kdfParams)) {
            try {
                fields = sealRecoveryFields(
                    openRecoveryFields(fields, shareRowAad(r.owner_pubkey as string, holderType)),
                    shareRowAad(owner, holderType),
                );
            } catch (e) {
                if (!(e instanceof RecoverySealKeyMissing || e instanceof RecoverySealUnopenable)) throw e;
                stranded++;
            }
        }
        move.run(owner, ref, fields.encryptedShare, fields.shareIv, fields.shareTag, fields.kdfParams, r.id);
    }
    if (stranded) {
        console.warn(`[RecoverySeal] ${stranded} recovery cop${stranded === 1 ? 'y' : 'ies'} moved to a new key without `
            + 'being opened (this server has no key that opens them); they stay unopenable.');
    }
}
