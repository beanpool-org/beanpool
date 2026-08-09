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

import { RECOVERY_THRESHOLD } from '@beanpool/core';
import { db } from '../db/db.js';

/** Who holds a fragment. Mirrors the CHECK constraint on `recovery_shares.holder_type`. */
export type KeeperType = 'device' | 'hub' | 'member' | 'sso';

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
    if (!Array.isArray(shares) || shares.length < RECOVERY_THRESHOLD) {
        // Accepting this would store a set that can never be recombined — a silent, total loss
        // that only surfaces when the member actually needs to recover.
        throw new RecoveryShareError(
            `A recovery split needs at least ${RECOVERY_THRESHOLD} fragments, got ${shares?.length ?? 0}.`
        );
    }

    /** Keeper types there can only be one of. A member has many buddies but one phone and one hub. */
    const SINGLETON_TYPES = new Set<KeeperType>(['hub', 'device']);

    /**
     * At most two keepers may be people. This is what closes R1.
     *
     * R1 — "three colluding human keepers take an account" — was in the risk register as High and
     * **Accepted**, on the grounds that no server rule could reach it: keepers must decrypt to
     * approve, so the node cannot tell a genuine release from a conspiracy. That reasoning is
     * still correct, and it is also beside the point. Three people cannot collude to reach the
     * threshold if a member can never have three human keepers in the first place. The rule that
     * was unreachable at release time is trivial at deposit time.
     *
     * The cost is real and worth stating: a member cannot hand pieces to four friends. Two is
     * already what the model aims at — the doc's own nudge fires at "<2 human keepers" — so this
     * makes the target a ceiling rather than introducing a new number. What it forbids is the
     * arrangement where every piece is a person, which is also the arrangement where recovery
     * depends entirely on other people answering their phones.
     *
     * What it does NOT close, stated plainly so nobody reads more into it than it does: the node
     * holds K2 in the clear and can derive K4's key from a subject claim it may well know, so a
     * dishonest node plus ONE human keeper is still three pieces. That residual predates this
     * rule and is unchanged by it. The margin is one human keeper either way — this rule stops
     * the humans alone from being enough.
     */
    const MAX_HUMAN_KEEPERS = 2;

    const holders = new Set<string>();
    const indices = new Set<number>();
    const singletons = new Map<KeeperType, string>();
    for (const s of shares) {
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
        // There is one phone and one hub per split, so `hub` and `device` may appear at most once
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

        // K1 NEVER LEAVES THE PHONE. The node records that a device keeper EXISTS — so "4 of 3,
        // you can afford to lose 1" stays honest — and stores none of its bytes.
        //
        // ONBOARDING has always said so: K1's "piece stored" is "an ordinary file in the app's
        // backed-up directory", where K2's is "on the node". Accepting ciphertext for every keeper
        // type let the node quietly become a second holder of K1, and that is not a small
        // difference. The K1 file carries no user secret and no hardware key by design — it has to
        // survive the phone dying, so nothing device-bound can lock it — which means the node's
        // copy would be a piece anyone reading the database could simply use.
        //
        // Count what a fully compromised node (database AND environment) could then assemble:
        // K1 outright, plus K2 which it wraps with its own env key. Two of the three needed, from
        // one break-in, with no human involved. Holding nothing of K1 puts it back to one.
        if (s.holderType === 'device' && (s.encryptedShare || s.shareIv || s.shareTag)) {
            throw new RecoveryShareError(
                'A device fragment is recorded, never uploaded — its bytes live in the phone\'s own '
                + 'backup and nowhere else. Send the keeper with empty ciphertext fields.',
            );
        }

        if (s.holderType === 'sso' && !s.ssoLookupHash) {
            throw new RecoveryShareError('A sign-in fragment needs an sso_lookup_hash to be findable.');
        }
        if (s.holderType === 'member' && !s.ephemeralPubkey) {
            throw new RecoveryShareError(
                `Fragment for member ${s.holderRef} has no ephemeral public key; its keeper could never unwrap it.`
            );
        }
    }

    // Checked after the loop rather than inside it, so the message can report the real number a
    // client tried to store instead of whichever fragment happened to tip it over.
    const humanKeepers = shares.filter(s => s.holderType === 'member').length;
    if (humanKeepers > MAX_HUMAN_KEEPERS) {
        throw new RecoveryShareError(
            `A split may have at most ${MAX_HUMAN_KEEPERS} human keepers, and this one has `
            + `${humanKeepers}. Three people who each hold a piece are three people who could `
            + `agree to take the account, and nothing at release time can tell that apart from a `
            + `genuine recovery. At least one piece must be held by this phone, this node, or a `
            + `sign-in account.`,
        );
    }

    const insert = db.prepare(`
        INSERT INTO recovery_shares (
            owner_pubkey, holder_type, holder_ref, share_index,
            encrypted_share, share_iv, share_tag,
            ephemeral_pubkey, sso_lookup_hash, sso_lookup_salt, kdf_params, generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const dropOlder = db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ? AND generation < ?');

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

        for (const s of shares) {
            insert.run(
                ownerPubkey, s.holderType, s.holderRef, s.shareIndex,
                s.encryptedShare, s.shareIv, s.shareTag,
                s.ephemeralPubkey ?? null, s.ssoLookupHash ?? null,
                s.ssoLookupSalt ?? null, s.kdfParams ?? null, nextGeneration,
            );
        }
        dropOlder.run(ownerPubkey, nextGeneration);
        return nextGeneration;
    });

    return write();
}

function rowToShare(r: Record<string, unknown>): StoredKeeperShare {
    return {
        id: r.id as number,
        ownerPubkey: r.owner_pubkey as string,
        holderType: r.holder_type as KeeperType,
        holderRef: r.holder_ref as string,
        shareIndex: r.share_index as number,
        encryptedShare: r.encrypted_share as string,
        shareIv: r.share_iv as string,
        shareTag: r.share_tag as string,
        ephemeralPubkey: (r.ephemeral_pubkey as string | null) ?? null,
        ssoLookupHash: (r.sso_lookup_hash as string | null) ?? null,
        ssoLookupSalt: (r.sso_lookup_salt as string | null) ?? null,
        kdfParams: (r.kdf_params as string | null) ?? null,
        generation: r.generation as number,
        createdAt: r.created_at as string,
    };
}

/** Every fragment of the current generation. Server-internal — this is the whole secret. */
export function getCurrentShares(ownerPubkey: string): StoredKeeperShare[] {
    const generation = getCurrentGeneration(ownerPubkey);
    if (generation === 0) return [];
    const rows = db.prepare(
        'SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND generation = ? ORDER BY id'
    ).all(ownerPubkey, generation) as Record<string, unknown>[];
    return rows.map(rowToShare);
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
    return countCurrentShares(ownerPubkey) > RECOVERY_THRESHOLD;
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
