// Collection and release — the rules that decide when a fragment leaves the node.
//
// ONBOARDING Part 3 "Release rules", decisions D6 and D7. The storage layer
// (engine/recovery-shares.ts) answers "what fragments exist"; this answers "may this one go, to
// this collection, now" — which is the only question in the keyholder model that can lose somebody
// their account.
//
// ## The situation this is written for
//
// A device doing a restore has NO identity. It cannot sign as the owner, because the owner's key
// is exactly what it is trying to rebuild. Every other authenticated path in this codebase starts
// from `ctx.state.actor`, and here there is none — so a collection is a bearer session: an
// unguessable id handed to whoever opened it, with every fragment still gated by its own rule on
// top. Holding the id is not authorisation to recover; it is a place for keepers to put things.
//
// ## The release rules, and what each is defending against
//
//   K1 device   NEVER released by the node. Not a delay, not a rule — the node will not serve it
//               at all. K1 is restored by the platform putting a file back (iCloud / Auto Backup).
//               If the node could serve it as well, then hub + sign-in + device is three pieces
//               the node can assemble on its own behalf, and the threshold would be protecting
//               nobody from the one party holding everything. This is the conservative reading of
//               a spec that does not say it outright, and it is the reading that fails safe.
//   K4/K5 human Released the instant that person approves (D6). No cooldown, no cancellable
//               window — chosen for recovery UX, with the residual risk accepted as R1.
//   K3 sign-in  Released on a verified fresh provider login. Not subject to D7: it is the
//               member's own account proving itself, not a machine acting unattended.
//   K2 hub      Instant IF at least one human has already released. Otherwise 24h (D7).
//
// ## Why D7 is the load-bearing one
//
// K1, K2 and K3 are all machine-released. Without D7 that trio is a silent, fully automated path
// into any account — and a user who signs in with Google on an Android phone backed up to the same
// Google account has one company holding two of the three. The delay plus notification is what
// gives the owner and their keepers a chance to notice. Since this file also refuses K1 outright,
// the automated set is now smaller still, but D7 stays: it is cheap, and it is the difference
// between "the hub can be part of a quiet takeover" and "it cannot".
//
// ## Re-splitting is the stop button
//
// Every release checks the generation the session pinned when it opened. An owner who re-splits
// mid-collection invalidates it. That is not an edge case to be tolerated — it is the remedy R1
// points at, and the reason the check is here rather than left to the caller.

import crypto from 'node:crypto';
import { RECOVERY_THRESHOLD } from '@beanpool/core';
import { db } from '../db/db.js';
import { getCurrentGeneration, type KeeperType } from './recovery-shares.js';
import { ssoLookupHash, type SsoProvider } from '../sso.js';

/** How long a collection stays open. Long enough to text a friend and wait for the hub's 24h. */
export const COLLECTION_TTL_MS = 72 * 60 * 60 * 1000;

/** D7. The hub waits this long when no human has vouched for the attempt. */
export const HUB_DELAY_MS = 24 * 60 * 60 * 1000;

/** Keeper types the node will ever hand over. `device` is absent on purpose — see the header. */
const RELEASABLE: readonly KeeperType[] = ['hub', 'member', 'sso'];

/**
 * Most live sessions one account may have at once.
 *
 * A cap that REFUSED the new session would be worse than the problem it solves: opening one is
 * deliberately unauthenticated (it has to be — see the header), so anyone could park the maximum
 * against a member and lock them out of their own recovery. Evicting the OLDEST instead means a
 * flood pushes out its own earlier attempts, and the person actually driving a recovery — who
 * opens a session and immediately uses it — always has the newest.
 */
const MAX_LIVE_COLLECTIONS_PER_OWNER = 10;

/**
 * Retention, decided rather than defaulted (CR).
 *
 * The two tables are not the same kind of thing, and the difference is the policy:
 *
 *   recovery_releases    a fragment actually left the node. Permanent, like `transactions` — this
 *                        is the log R1 leans on when a takeover is discovered after the fact.
 *   recovery_collections mostly nothing happened. A session with no releases is somebody opening a
 *                        screen; keeping it forever would be keeping a nonce forever, and this is
 *                        an UNAUTHENTICATED insert, so "forever" means "as many as anyone likes".
 *
 * So: a session that is dead AND released nothing is deleted. A session that released anything is
 * kept whatever its state, because that one is evidence — the owner needs to be able to see that
 * an attempt happened, which is the whole point of being able to cancel and re-split.
 *
 * Run opportunistically when a session opens, scoped to that owner. No timer (this codebase keeps
 * having to remove those) and no hourly sweep to forget about: rows appear only here, so this is
 * the only moment growth can happen, and the work is bounded by one member's own sessions.
 */
export function pruneCollectionsFor(ownerPubkey: string): { deleted: number; evicted: number } {
    const now = nowIso();

    // Oldest live sessions beyond the cap stop being live. Done BEFORE the delete so an evicted
    // empty session is cleaned up in the same pass rather than lingering until the next open.
    const evicted = db.prepare(`
        UPDATE recovery_collections SET status = 'expired',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id IN (
            SELECT id FROM recovery_collections
            WHERE owner_pubkey = ? AND status = 'open' AND expires_at > ?
            -- rowid breaks the tie, and it is not optional. created_at is millisecond precision,
            -- so a burst of sessions opened in the same millisecond compares EQUAL and SQLite is
            -- free to order them however it likes — which made "evict the oldest" evict an
            -- arbitrary one, occasionally keeping the very first and dropping the newest. rowid is
            -- insertion-ordered by construction, so newest-survives becomes true rather than
            -- usually-true.
            ORDER BY created_at DESC, rowid DESC
            LIMIT -1 OFFSET ?
        )
    `).run(ownerPubkey, now, MAX_LIVE_COLLECTIONS_PER_OWNER).changes;

    const deleted = db.prepare(`
        DELETE FROM recovery_collections
        WHERE owner_pubkey = ?
          AND (status != 'open' OR expires_at <= ?)
          AND id NOT IN (SELECT collection_id FROM recovery_releases)
    `).run(ownerPubkey, now).changes;

    return { deleted, evicted };
}

export class RecoveryReleaseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RecoveryReleaseError';
    }
}

export interface Collection {
    id: string;
    ownerPubkey: string;
    generation: number;
    requesterEphemeralPubkey: string;
    status: 'open' | 'complete' | 'cancelled' | 'expired';
    createdAt: string;
    expiresAt: string;
}

export interface ReleasedFragment {
    shareId: number;
    holderType: KeeperType;
    shareIndex: number;
    payload: string;
    payloadIv: string;
    payloadTag: string;
    ephemeralPubkey: string | null;
    releasedBy: string | null;
    releasedAt: string;
}

/** What a keeper's fragment looks like once they have re-wrapped it to the recovering device. */
export interface RewrappedFragment {
    payload: string;
    payloadIv: string;
    payloadTag: string;
    /** The keeper's X25519 ephemeral for THIS re-wrap — not the one from the original split. */
    ephemeralPubkey: string;
}

const nowIso = (): string => new Date().toISOString();

function rowToCollection(r: Record<string, unknown>): Collection {
    return {
        id: r.id as string,
        ownerPubkey: r.owner_pubkey as string,
        generation: r.generation as number,
        requesterEphemeralPubkey: r.requester_ephemeral_pubkey as string,
        status: r.status as Collection['status'],
        createdAt: r.created_at as string,
        expiresAt: r.expires_at as string,
    };
}

/**
 * Open a collection against a member's CURRENT generation.
 *
 * Deliberately does not authenticate the opener — it cannot; see the header. What it does do is
 * refuse to open one at all for a member who has no split, so a caller cannot use this to
 * distinguish "no such member" from "member with no fragments" any more precisely than the public
 * keeper summary already allows.
 */
export function openCollection(ownerPubkey: string, requesterEphemeralPubkey: string): Collection {
    if (!ownerPubkey) throw new RecoveryReleaseError('A collection needs an account to recover.');
    if (!requesterEphemeralPubkey) {
        // Without it a keeper has nothing to wrap their fragment to, and the only way to deliver a
        // piece would be in the clear through the node — which is the one thing this design never
        // does.
        throw new RecoveryReleaseError(
            'A collection needs the recovering device\'s ephemeral public key to deliver fragments to.',
        );
    }

    const generation = getCurrentGeneration(ownerPubkey);
    if (generation === 0) {
        throw new RecoveryReleaseError('That account has no recovery fragments to collect.');
    }

    const id = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + COLLECTION_TTL_MS).toISOString();
    db.prepare(`
        INSERT INTO recovery_collections
            (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?)
    `).run(id, ownerPubkey, generation, requesterEphemeralPubkey, nowIso(), expiresAt);

    // AFTER the insert, so the cap is enforced on the state that actually results. Pruning first
    // trimmed the previous set to the limit and then added one more, leaving MAX+1 every time —
    // a cap that is always off by one is a cap nobody can reason about. The new row is the newest
    // by rowid, so it is never the one evicted.
    pruneCollectionsFor(ownerPubkey);

    const opened = getCollection(id);
    if (!opened) {
        // Unreachable while eviction is oldest-first, and checked anyway: silently returning a
        // session that is not in the table would hand the caller an id that answers nothing.
        throw new RecoveryReleaseError('The recovery session could not be opened.');
    }
    return opened;
}

export function getCollection(id: string): Collection | null {
    if (!id) return null;
    const row = db.prepare('SELECT * FROM recovery_collections WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
    return row ? rowToCollection(row) : null;
}

/**
 * The collection as it stands right now, with expiry and stale-generation applied.
 *
 * Computed on read rather than by a sweeper. A node that was switched off for a week must not
 * treat a long-dead session as live merely because nothing ran to close it, and a background timer
 * is the thing this codebase has repeatedly had to remove (see the nonce sweep in sso.ts).
 */
export function collectionState(id: string): {
    collection: Collection;
    live: boolean;
    reason?: 'expired' | 'stale-generation' | 'cancelled' | 'complete';
} | null {
    const collection = getCollection(id);
    if (!collection) return null;

    // ANYTHING that is not 'open' is dead, rather than the three statuses being enumerated (CR).
    //
    // Enumerating missed 'expired', which is what pruneCollectionsFor writes when it evicts a
    // session over the per-owner cap — and eviction leaves `expires_at` in the FUTURE, so the
    // time check below did not catch it either. The result was the worst possible combination:
    // the session stayed live and could still collect fragments, while `openCollectionsFor`
    // (status = 'open') hid it from the owner and `cancelCollection` refused it for not being
    // open. Invisible, uncancellable, and still working, for up to 72 hours.
    //
    // Written as a default-dead check so the next status added to the CHECK constraint fails
    // closed. A liveness test that has to be remembered is one that will eventually be forgotten,
    // and this one was — by the person who added the status three hours earlier.
    if (collection.status !== 'open') {
        return { collection, live: false, reason: collection.status };
    }
    if (Date.parse(collection.expiresAt) <= Date.now()) {
        return { collection, live: false, reason: 'expired' };
    }
    // A re-split since this session opened. The owner has moved the account out from under it,
    // which is the documented way to stop a recovery you did not start.
    if (getCurrentGeneration(collection.ownerPubkey) !== collection.generation) {
        return { collection, live: false, reason: 'stale-generation' };
    }
    return { collection, live: true };
}

function requireLive(id: string): Collection {
    const state = collectionState(id);
    if (!state) throw new RecoveryReleaseError('No such recovery session.');
    if (!state.live) {
        const why = {
            expired: 'That recovery session has expired. Start a new one.',
            'stale-generation': 'The account was re-split since this session started, so the '
                + 'fragments it was collecting no longer fit together. Start a new one.',
            cancelled: 'That recovery session was cancelled.',
            complete: 'That recovery session is already complete.',
        }[state.reason!];
        throw new RecoveryReleaseError(why);
    }
    return state.collection;
}

export function listReleases(collectionId: string): ReleasedFragment[] {
    const rows = db.prepare(`
        SELECT * FROM recovery_releases WHERE collection_id = ? ORDER BY id
    `).all(collectionId) as Record<string, unknown>[];
    return rows.map(r => ({
        shareId: r.share_id as number,
        holderType: r.holder_type as KeeperType,
        shareIndex: r.share_index as number,
        payload: r.payload as string,
        payloadIv: r.payload_iv as string,
        payloadTag: r.payload_tag as string,
        ephemeralPubkey: (r.ephemeral_pubkey as string | null) ?? null,
        releasedBy: (r.released_by as string | null) ?? null,
        releasedAt: r.released_at as string,
    }));
}

/**
 * D7, as a function of what has already happened.
 *
 * "≥1 human piece already released" means a `member` release — a person who tapped Approve. A
 * sign-in release does not count, and neither does another machine piece: the entire purpose is
 * that a human is in the loop, and K3 is the member's own account proving itself unattended.
 */
export function hubReleaseEligibleAt(collectionId: string): { eligibleAt: number; reason: 'human-approved' | 'delay' } {
    const collection = getCollection(collectionId);
    if (!collection) throw new RecoveryReleaseError('No such recovery session.');

    const humanReleases = db.prepare(`
        SELECT MIN(released_at) AS first FROM recovery_releases
        WHERE collection_id = ? AND holder_type = 'member'
    `).get(collectionId) as { first: string | null };

    if (humanReleases.first) {
        // Eligible from the moment the human approved, not from now — so a hub request that
        // arrives a second later is not told to wait.
        return { eligibleAt: Date.parse(humanReleases.first), reason: 'human-approved' };
    }
    return { eligibleAt: Date.parse(collection.createdAt) + HUB_DELAY_MS, reason: 'delay' };
}

/** The share row a release is about, scoped to the session's pinned generation. */
function shareForRelease(
    collection: Collection, holderType: KeeperType, holderRef: string,
): Record<string, unknown> {
    const row = db.prepare(`
        SELECT * FROM recovery_shares
        WHERE owner_pubkey = ? AND generation = ? AND holder_type = ? AND holder_ref = ?
    `).get(collection.ownerPubkey, collection.generation, holderType, holderRef) as
        Record<string, unknown> | undefined;
    if (!row) {
        throw new RecoveryReleaseError(
            `No ${holderType} fragment for this account in the generation this session is collecting.`,
        );
    }
    return row;
}

/**
 * The hub's fragment for this session's generation, found by type rather than by name.
 *
 * Refuses rather than picks if a legacy row set somehow contains two. Choosing one arbitrarily
 * would release a fragment while leaving its twin behind, and the recovering device would collect
 * a piece that does not fit the polynomial the others came from — the silent failure this whole
 * design is arranged to avoid.
 */
function hubShareFor(collection: Collection): Record<string, unknown> {
    const rows = db.prepare(`
        SELECT * FROM recovery_shares
        WHERE owner_pubkey = ? AND generation = ? AND holder_type = 'hub'
    `).all(collection.ownerPubkey, collection.generation) as Record<string, unknown>[];

    if (rows.length === 0) {
        throw new RecoveryReleaseError(
            'No hub fragment for this account in the generation this session is collecting.',
        );
    }
    if (rows.length > 1) {
        throw new RecoveryReleaseError(
            'This account has more than one hub fragment in one generation, which should be '
            + 'impossible. Re-split from the owner\'s device before recovering.',
        );
    }
    return rows[0];
}

function recordRelease(args: {
    collectionId: string;
    shareId: number;
    holderType: KeeperType;
    shareIndex: number;
    payload: string;
    payloadIv: string;
    payloadTag: string;
    ephemeralPubkey: string | null;
    releasedBy: string | null;
}): ReleasedFragment {
    // INSERT OR IGNORE against UNIQUE(collection_id, share_id): a keeper tapping Approve twice, or
    // a client retrying a request that already succeeded, must not read as two of three pieces.
    // The first release wins — re-releasing with a different payload would let a keeper who
    // approved once replace the piece afterwards.
    db.prepare(`
        INSERT OR IGNORE INTO recovery_releases
            (collection_id, share_id, holder_type, share_index,
             payload, payload_iv, payload_tag, ephemeral_pubkey, released_by, released_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        args.collectionId, args.shareId, args.holderType, args.shareIndex,
        args.payload, args.payloadIv, args.payloadTag,
        args.ephemeralPubkey, args.releasedBy, nowIso(),
    );

    const released = listReleases(args.collectionId).find(r => r.shareId === args.shareId);
    if (!released) throw new RecoveryReleaseError('The fragment could not be recorded as released.');
    return released;
}

/**
 * D6 — a human keeper approves, and their fragment goes immediately.
 *
 * The keeper supplies the fragment already re-wrapped to the recovering device: they decrypted
 * their own copy with their own key, and encrypted the result to `requesterEphemeralPubkey`. The
 * node never sees a plaintext piece, which is what keeps it honest that a stolen database plus a
 * compromised hub is still short of the threshold.
 *
 * @param keeperPubkey the VERIFIED signer. Must be the keeper the fragment belongs to.
 */
export function releaseMemberFragment(
    collectionId: string, keeperPubkey: string, rewrapped: RewrappedFragment,
): ReleasedFragment {
    const collection = requireLive(collectionId);
    if (!keeperPubkey) throw new RecoveryReleaseError('A keeper must be signed in to approve.');
    if (keeperPubkey === collection.ownerPubkey) {
        // Not a rule about trust — a rule about arithmetic. If the owner could approve their own
        // fragment they would not be recovering, and allowing it would let anyone who compromised
        // the account approve pieces towards rebuilding the phrase itself.
        throw new RecoveryReleaseError('An account cannot approve its own recovery.');
    }
    if (!rewrapped?.payload || !rewrapped.payloadIv || !rewrapped.payloadTag || !rewrapped.ephemeralPubkey) {
        throw new RecoveryReleaseError(
            'An approved fragment must be re-wrapped to the recovering device (payload, iv, tag, ephemeral key).',
        );
    }

    // holder_ref for a member keeper IS their pubkey, so this both finds the row and proves the
    // signer is entitled to release it. There is no separate authorisation check because there is
    // no separate question.
    const share = shareForRelease(collection, 'member', keeperPubkey);

    return recordRelease({
        collectionId,
        shareId: share.id as number,
        holderType: 'member',
        shareIndex: share.share_index as number,
        payload: rewrapped.payload,
        payloadIv: rewrapped.payloadIv,
        payloadTag: rewrapped.payloadTag,
        ephemeralPubkey: rewrapped.ephemeralPubkey,
        releasedBy: keeperPubkey,
    });
}

/**
 * K3 — released on a verified fresh sign-in.
 *
 * The caller is responsible for having verified the provider token and derived the lookup hash;
 * this takes the resolved share row's identifiers, not a token, so the verification cannot be
 * accidentally skipped by a future caller passing something weaker.
 *
 * The stored ciphertext is handed over as-is. The recovering device just proved it holds the
 * provider account, so it can derive HKDF(sub, salt) itself — which means the node never needs the
 * key and never has it at rest.
 */
/**
 * K3, from a verified identity rather than a pre-computed hash.
 *
 * The salt is per-share and stored, so turning a verified `sub` into the lookup hash requires
 * reading the row first. That derivation lives here rather than in the route for the same reason
 * the hash is derived node-side at deposit (#220): it is the step that decides whose fragment this
 * is, and a route that computed it itself could be given a hash instead of a subject by the next
 * person to touch it.
 *
 * @param sub  the subject claim from a token this node has ALREADY verified
 */
export async function releaseSsoFragmentForIdentity(
    collectionId: string,
    provider: SsoProvider,
    sub: string,
): Promise<ReleasedFragment> {
    const collection = requireLive(collectionId);
    if (!sub) throw new RecoveryReleaseError('That sign-in did not identify an account.');

    const row = db.prepare(`
        SELECT sso_lookup_hash, sso_lookup_salt FROM recovery_shares
        WHERE owner_pubkey = ? AND generation = ? AND holder_type = 'sso'
    `).get(collection.ownerPubkey, collection.generation) as
        { sso_lookup_hash: string | null; sso_lookup_salt: string | null } | undefined;

    if (!row?.sso_lookup_hash || !row.sso_lookup_salt) {
        throw new RecoveryReleaseError(
            'This account has no sign-in keeper in the generation being collected.',
        );
    }

    const derived = await ssoLookupHash(provider, sub, row.sso_lookup_salt);
    // Constant-time, because a timing difference here leaks which accounts a given provider
    // identity is a keeper for — on an endpoint anyone can reach with their own valid token.
    const a = Buffer.from(derived, 'utf-8');
    const b = Buffer.from(row.sso_lookup_hash, 'utf-8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new RecoveryReleaseError(
            'That sign-in account is not the keeper for this recovery.',
        );
    }

    return releaseSsoFragment(collectionId, row.sso_lookup_hash);
}

export function releaseSsoFragment(collectionId: string, ssoLookupHash: string): ReleasedFragment {
    const collection = requireLive(collectionId);
    if (!ssoLookupHash) throw new RecoveryReleaseError('No sign-in fragment was identified.');

    const share = db.prepare(`
        SELECT * FROM recovery_shares
        WHERE owner_pubkey = ? AND generation = ? AND holder_type = 'sso' AND sso_lookup_hash = ?
    `).get(collection.ownerPubkey, collection.generation, ssoLookupHash) as
        Record<string, unknown> | undefined;

    if (!share) {
        // Scoped to THIS session's owner and generation, so a valid sign-in for a different member
        // cannot release anything here. The hash alone is not a claim on an account.
        throw new RecoveryReleaseError(
            'That sign-in account is not a keeper for this recovery, in the generation being collected.',
        );
    }

    return recordRelease({
        collectionId,
        shareId: share.id as number,
        holderType: 'sso',
        shareIndex: share.share_index as number,
        payload: share.encrypted_share as string,
        payloadIv: share.share_iv as string,
        payloadTag: share.share_tag as string,
        ephemeralPubkey: null,
        releasedBy: null,
    });
}

/**
 * K2 — the hub's own fragment, under D7.
 *
 * Returns the fragment exactly as the client deposited it. There is no node-side wrapping key —
 * an env-held `recovery.hubShareKey` was specified through Revision 3.6 and withdrawn on
 * 2026-08-08, because a lost or rotated variable would have made every member's K2 permanently
 * undecryptable, for a gain of one piece against a DB-snapshot attacker who is still under the
 * threshold either way. See ONBOARDING.md § Hub keeper (K2).
 *
 * So this IS the node handing over a piece it can read. That is safe only because it is one piece
 * of three, and the D7 delay plus the owner notification are what actually defend it — not the
 * secrecy of this row.
 */
export function releaseHubFragment(collectionId: string): ReleasedFragment {
    const collection = requireLive(collectionId);
    // By holder_type, not by the literal 'node' (CR). putShareGeneration now pins the ref, but a
    // row written before that check existed would be invisible to a lookup keyed on the string —
    // and the failure would be a permanently unreleasable hub keeper for that one member, which
    // nothing would ever report. Looking it up by type finds it whatever it is called.
    const share = hubShareFor(collection);

    const { eligibleAt } = hubReleaseEligibleAt(collectionId);
    if (Date.now() < eligibleAt) {
        const waitMs = eligibleAt - Date.now();
        const hours = Math.ceil(waitMs / 3_600_000);
        throw new RecoveryReleaseError(
            `The hub's fragment is held for ${hours}h unless a human keeper approves first (D7). `
            + 'Ask any of your keepers to approve and it releases immediately.',
        );
    }

    return recordRelease({
        collectionId,
        shareId: share.id as number,
        holderType: 'hub',
        shareIndex: share.share_index as number,
        payload: share.encrypted_share as string,
        payloadIv: share.share_iv as string,
        payloadTag: share.share_tag as string,
        ephemeralPubkey: null,
        releasedBy: null,
    });
}

/**
 * The session's own view of itself — what the restore screen polls.
 *
 * Never includes the fragments. A caller wanting those asks for them, and the separation means a
 * status poll cannot become a way to accumulate pieces without any release rule running.
 */
export function collectionProgress(collectionId: string): {
    status: Collection['status'];
    live: boolean;
    reason?: string;
    collected: number;
    threshold: number;
    enough: boolean;
    hubEligibleAt: string | null;
    hubReason: 'human-approved' | 'delay' | null;
    releasedTypes: KeeperType[];
} | null {
    const state = collectionState(collectionId);
    if (!state) return null;

    const releases = listReleases(collectionId);
    const hasHub = db.prepare(`
        SELECT 1 AS present FROM recovery_shares
        WHERE owner_pubkey = ? AND generation = ? AND holder_type = 'hub'
    `).get(state.collection.ownerPubkey, state.collection.generation) as { present: number } | undefined;

    let hubEligibleAt: string | null = null;
    let hubReason: 'human-approved' | 'delay' | null = null;
    // Only for a LIVE session (CR). A dead one — expired, cancelled, or killed by a re-split —
    // would otherwise report "the hub releases in 6h" about a session that will never release
    // anything, and a countdown is exactly the sort of thing a user waits on instead of starting
    // over. releaseHubFragment re-checks liveness independently, so this was never a way in; it
    // was a way to be misled.
    if (state.live && hasHub && !releases.some(r => r.holderType === 'hub')) {
        const e = hubReleaseEligibleAt(collectionId);
        hubEligibleAt = new Date(e.eligibleAt).toISOString();
        hubReason = e.reason;
    }

    return {
        status: state.collection.status,
        live: state.live,
        reason: state.reason,
        collected: releases.length,
        threshold: RECOVERY_THRESHOLD,
        enough: releases.length >= RECOVERY_THRESHOLD,
        hubEligibleAt,
        hubReason,
        releasedTypes: releases.map(r => r.holderType),
    };
}

/**
 * Stop a recovery.
 *
 * R1's remedy, and the reason it is reachable by the OWNER rather than only by the session holder:
 * the person who needs to cancel a recovery they did not start is the account owner, who by
 * definition does not hold the attacker's session id. Re-splitting also kills it (see
 * collectionState), but that costs every keeper a new fragment; this is the cheap stop.
 */
export function cancelCollection(collectionId: string, byPubkey: string): boolean {
    const collection = getCollection(collectionId);
    if (!collection) throw new RecoveryReleaseError('No such recovery session.');
    if (collection.ownerPubkey !== byPubkey) {
        throw new RecoveryReleaseError('Only the account being recovered can cancel its recovery.');
    }
    if (collection.status !== 'open') return false;
    db.prepare(`UPDATE recovery_collections SET status = 'cancelled',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(collectionId);
    return true;
}

/** Every live collection against an account — what a "someone is recovering your account" notice reads. */
export function openCollectionsFor(ownerPubkey: string): Collection[] {
    const rows = db.prepare(`
        SELECT * FROM recovery_collections
        WHERE owner_pubkey = ? AND status = 'open' AND expires_at > ?
        ORDER BY created_at DESC
    `).all(ownerPubkey, nowIso()) as Record<string, unknown>[];
    return rows.map(rowToCollection);
}

/** Exported so a route and its tests cannot disagree about what the node will hand over. */
export function isReleasableType(holderType: string): boolean {
    return (RELEASABLE as readonly string[]).includes(holderType);
}

/** A keeper obligation the approver has not discharged yet. */
export interface PendingKeeperAction {
    collectionId: string;
    ownerPubkey: string;
    expiresAt: string;
}

/**
 * Live collections where `keeperPubkey` still holds an unreleased fragment for `ownerPubkey`.
 *
 * This exists because of a seam between two systems that look like one to the person using them.
 * The old guardian vote (`/api/recovery/request` → `/approve`) and the keyholder split are
 * different mechanisms with the same word on the button. A guardian who is ALSO a keeper taps
 * "Approve", is told it worked, and reasonably stops there — while their fragment, the thing
 * recovery actually needs, has not moved. The owner sees an approval and no piece, and nothing
 * says why.
 *
 * The node cannot discharge the obligation on their behalf: releasing a member fragment needs it
 * re-wrapped to the recovering device's ephemeral key, which requires the keeper's private key.
 * That is the whole point of the design and is not a limitation to engineer around. What the node
 * CAN do is stop the approval reading as complete when it is not, which is what this backs.
 *
 * Returns only collections that are open, unexpired, on the current generation, and where this
 * keeper's fragment has not already been released — so a keeper who has done both jobs is not
 * nagged, and a stale session is not resurrected.
 */
export function pendingKeeperActionsFor(keeperPubkey: string, ownerPubkey: string): PendingKeeperAction[] {
    const rows = db.prepare(`
        SELECT c.id, c.owner_pubkey, c.expires_at
        FROM recovery_collections c
        JOIN recovery_shares s
          ON s.owner_pubkey = c.owner_pubkey
         AND s.generation   = c.generation
         AND s.holder_type  = 'member'
         AND s.holder_ref   = ?
        WHERE c.owner_pubkey = ?
          AND c.status = 'open'
          AND c.expires_at > ?
          AND NOT EXISTS (
              SELECT 1 FROM recovery_releases r
              WHERE r.collection_id = c.id AND r.share_id = s.id
          )
        ORDER BY c.created_at DESC
    `).all(keeperPubkey, ownerPubkey, nowIso()) as Record<string, unknown>[];

    return rows.map(r => ({
        collectionId: r.id as string,
        ownerPubkey: r.owner_pubkey as string,
        expiresAt: r.expires_at as string,
    }));
}
